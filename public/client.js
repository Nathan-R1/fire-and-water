(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  const { T } = Physics;

  // ---- Room code: from ?room=, otherwise make one and put it in the URL ----
  // ?level=N starts a new room at level N (handy for testing).
  const params = new URLSearchParams(location.search);
  let code = (params.get('room') || '').toUpperCase();
  if (!/^[A-Z0-9]{4,8}$/.test(code)) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    params.set('room', code);
    history.replaceState(null, '', `${location.pathname}?${params}`);
  }
  const startLevel = parseInt(params.get('level'), 10) || undefined;
  $('code').textContent = code;

  $('share').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}?room=${code}`;
    try {
      if (navigator.share) await navigator.share({ title: 'Fire & Water', url });
      else { await navigator.clipboard.writeText(url); flashStatus('Link copied'); }
    } catch { /* user cancelled */ }
  });

  // Fullscreen + landscape lock where supported (Android; not iPhone Safari).
  if (document.documentElement.requestFullscreen) {
    $('fullscreen').hidden = false;
    $('fullscreen').addEventListener('click', async () => {
      try {
        if (document.fullscreenElement) return document.exitFullscreen();
        await document.documentElement.requestFullscreen();
        await screen.orientation?.lock?.('landscape');
      } catch { /* not allowed */ }
    });
  }

  // ---- State ----
  let level = null;     // parsed level
  let levelIndex = 0;
  let levelTotal = 0;
  let CHAR = Physics.CHAR;
  let TILE = Physics.TILE;
  let myRole = null;
  let target = null;    // latest server snapshot
  let snaps = [];       // recent snapshots with arrival time, for interpolating others
  // Prediction for your own character (see "Prediction" below)
  let me = null;        // predicted body
  let pending = [];     // inputs sent but not yet processed by the server
  let seq = 0;
  let jumpQueued = false;
  let errX = 0, errY = 0; // visual offset left over from corrections, decays to 0
  let meDead = false;     // we predicted a death: hold still until the server answers
  let statusOverride = null;

  function setLevel(info) {
    level = Physics.parseLevel(info.def);
    levelIndex = info.index;
    levelTotal = info.total;
    target = null;
    snaps = [];
    me = null;
    meDead = false;
    pending = [];
    $('levelnum').textContent = `${levelIndex + 1}/${levelTotal}`;
    $('levelname').textContent = level.name;
    resizeCanvas();
    showBanner(`<b>Level ${levelIndex + 1}</b>${escapeHtml(level.name)}`, 1800);
  }

  // ---- Networking ----
  // WebSocket straight away (no slow polling start); polling only if that fails.
  const socket = io({ transports: ['websocket', 'polling'], tryAllTransports: true });
  socket.on('connect', () => socket.emit('join', { code, level: startLevel }));
  socket.on('disconnect', () => { $('status').textContent = 'Reconnecting…'; });
  socket.on('error-msg', (msg) => { $('status').textContent = msg; });

  socket.on('joined', (msg) => {
    CHAR = msg.char;
    TILE = msg.tile;
    levelList = msg.levels || [];
    setLevel(msg.level);
    setRoles(msg.roles || [], msg.role);
  });

  // Which characters this device controls, and which one the buttons drive.
  // One device can hold both (for testing alone); the other one stands still.
  let myRoles = [];

  // ---- Level picker ----
  let levelList = [];
  const WORLDS = { 1: 'Cinder Caves', 2: 'Tide Halls', 3: 'Gale Spire', 4: 'Twin Core', 5: 'Crate Works', 6: 'Pulley Mill', 7: 'Counterweights', 8: 'Grand Machine' };
  function openPicker() {
    if (!myRole || !levelList.length) return flashStatus(myRole ? 'Loading…' : 'Only players can change level');
    const list = $('levellist');
    list.innerHTML = '';
    let grid = null, world = null;
    levelList.forEach((l, i) => {
      if (l.world !== world) {
        world = l.world;
        const h = document.createElement('div');
        h.className = 'world';
        h.textContent = WORLDS[world] ? `World ${world}: ${WORLDS[world]}` : `World ${world}`;
        grid = document.createElement('div');
        grid.className = 'lvls';
        list.append(h, grid);
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lvl' + (i === levelIndex ? ' current' : '');
      b.innerHTML = `<b>${i + 1}</b>${escapeHtml(l.name)}`;
      b.addEventListener('click', () => { socket.emit('goto', i); closePicker(); });
      grid.append(b);
    });
    $('levelpicker').hidden = false;
  }
  function closePicker() { $('levelpicker').hidden = true; }
  $('levelbtn').addEventListener('click', () => ($('levelpicker').hidden ? openPicker() : closePicker()));
  $('pickerclose').addEventListener('click', closePicker);
  function setRoles(roles, active) {
    myRoles = roles;
    if (active !== myRole) { // start predicting the newly active character from scratch
      myRole = active;
      me = null; meDead = false; pending = []; errX = errY = 0;
    }
    $('controls').hidden = !myRole;
    $('restart').hidden = !myRole;
    updateSwap();
    updateStatus();
  }
  socket.on('roles', (msg) => setRoles(msg.roles, msg.active));
  socket.on('notice', (msg) => flashStatus(msg));

  function updateSwap() {
    const next = myRole === 'fire' ? 'water' : 'fire';
    $('swap').textContent = myRole ? `⇄ ${next === 'fire' ? '🔥' : '💧'}` : '⇄ Play';
  }
  $('swap').addEventListener('click', () => socket.emit('swap'));

  socket.on('state', (s) => {
    if (!level || s.level !== levelIndex) return; // level change in flight
    target = s;
    const t = performance.now();
    snaps.push({ t, s });
    while (snaps.length > 2 && snaps[1].t < t - 1000) snaps.shift();
    if (myRole) reconcile(s);
    $('timer').textContent = formatTime(s.timeMs);
    const mine = (el) => level.gems.filter((g, i) => g.el === el && s.gems[i]).length;
    const total = (el) => level.gems.filter((g) => g.el === el).length;
    $('gemcount').textContent = `🔴${mine('fire')}/${total('fire')} 🔵${mine('water')}/${total('water')}`;
    updateStatus();
  });

  const CAUSE = { [T.LAVA]: 'lava', [T.WATER]: 'water', [T.ACID]: 'acid' };
  socket.on('event', (e) => {
    if (e.type === 'level') {
      setLevel(e);
    } else if (e.type === 'death') {
      const who = e.role === 'fire' ? '🔥 Fire' : '💧 Water';
      showBanner(`<b>Oops!</b>${who} fell in the ${CAUSE[e.cause] || 'hazard'}`, 1000);
      if (e.role === myRole) navigator.vibrate?.([40, 40, 80]);
    } else if (e.type === 'restart') {
      me = null; meDead = false; errX = errY = 0;
    } else if (e.type === 'gem') {
      if (e.role === myRole) navigator.vibrate?.(15);
    } else if (e.type === 'complete') {
      const gems = e.totalGems ? ` · 💎 ${e.gems}/${e.totalGems}` : '';
      const deaths = e.deaths ? ` · ${e.deaths} ${e.deaths === 1 ? 'retry' : 'retries'}` : '';
      const next = e.last ? 'That was the last level! Back to level 1…' : 'Next level coming up…';
      showBanner(`<b>Level ${e.index + 1} complete!</b>⏱ ${formatTime(e.timeMs)}${gems}${deaths}<br>${next}`, 3000);
      navigator.vibrate?.([30, 50, 30, 50, 60]);
    }
  });

  $('restart').addEventListener('click', () => socket.emit('restart'));

  function updateStatus() {
    if (statusOverride) return;
    if (!myRole) { $('status').textContent = 'Room full: watching'; return; }
    const other = myRole === 'fire' ? 'water' : 'fire';
    const both = myRoles.length > 1;
    const waiting = !both && target && !target[other].connected;
    $('status').textContent = `${myRole === 'fire' ? '🔥 Fire' : '💧 Water'}${both ? ' · solo (both)' : waiting ? ' · waiting for partner' : ''}`;
  }

  function flashStatus(text) {
    statusOverride = text;
    $('status').textContent = text;
    setTimeout(() => { statusOverride = null; updateStatus(); }, 1500);
  }

  let bannerTimer = null;
  function showBanner(html, ms) {
    const b = $('banner');
    b.innerHTML = html;
    b.hidden = false;
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => { b.hidden = true; }, ms);
  }

  function formatTime(ms) {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---- Input ----
  // D-pad: each touching finger picks a direction by which half it's on, and can
  // slide between ◀ and ▶ without lifting. The most recent finger wins.
  const dpad = $('dpad');
  const dpadKeys = [...dpad.querySelectorAll('.ctl')];
  const touchDirs = new Map(); // pointerId -> -1 | 1
  const keyDirs = new Set();   // keyboard, most recent last

  function dirFromPointer(e) {
    const r = dpad.getBoundingClientRect();
    return e.clientX < r.left + r.width / 2 ? -1 : 1;
  }

  function currentDir() {
    if (touchDirs.size) return [...touchDirs.values()].pop();
    if (keyDirs.size) return [...keyDirs].pop();
    return 0;
  }

  // Only updates the button highlight; the direction is sampled every tick.
  function sendDir() {
    const dir = currentDir();
    for (const k of dpadKeys) k.classList.toggle('active', Number(k.dataset.dir) === dir && touchDirs.size > 0);
  }

  dpad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    dpad.setPointerCapture(e.pointerId);
    touchDirs.set(e.pointerId, dirFromPointer(e));
    sendDir();
  });
  dpad.addEventListener('pointermove', (e) => {
    if (!touchDirs.has(e.pointerId)) return;
    touchDirs.set(e.pointerId, dirFromPointer(e));
    sendDir();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    dpad.addEventListener(type, (e) => { touchDirs.delete(e.pointerId); sendDir(); });
  }

  const jumpBtn = $('jump');
  jumpBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    jumpBtn.classList.add('active');
    jumpQueued = true;
    navigator.vibrate?.(10);
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
    jumpBtn.addEventListener(type, () => jumpBtn.classList.remove('active'));
  }
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  // Keyboard for desktop testing
  const keyDir = { ArrowLeft: -1, KeyA: -1, ArrowRight: 1, KeyD: 1 };
  const jumpKeys = new Set(['ArrowUp', 'KeyW', 'Space']);
  addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const d = keyDir[e.code];
    if (d) { keyDirs.delete(d); keyDirs.add(d); sendDir(); }
    if (jumpKeys.has(e.code)) { e.preventDefault(); jumpQueued = true; }
    if (e.code === 'KeyR' && myRole) socket.emit('restart');
    if (e.code === 'Tab' || e.code === 'KeyQ') { e.preventDefault(); socket.emit('swap'); }
    if (e.code === 'KeyL') $('levelpicker').hidden ? openPicker() : closePicker();
    if (e.code === 'Escape') closePicker();
  });
  addEventListener('keyup', (e) => {
    const d = keyDir[e.code];
    if (d) { keyDirs.delete(d); sendDir(); }
  });
  addEventListener('blur', () => { keyDirs.clear(); touchDirs.clear(); sendDir(); });
  // A hidden tab stops ticking, so tell the server to stop us rather than keep walking.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden || !myRole) return;
    keyDirs.clear(); touchDirs.clear(); sendDir();
    for (const r of myRoles) socket.emit('i', { r, s: ++seq, d: 0, j: false });
    pending = [];
  });

  // ---- Prediction ----
  // Every 1/60 s: sample input, send it, and apply it to your own character right away
  // using the same physics as the server. When a snapshot arrives, start again from the
  // server's position and re-apply the inputs it hasn't processed yet (reconcile).
  const NONE = { left: false, right: false };
  const toInput = (d) => (d < 0 ? { left: true, right: false } : d > 0 ? { left: false, right: true } : NONE);
  const playing = () => target && target.phase === 'playing';

  // Prediction runs on its own copy of the world (switches, boxes, pulleys) and of the
  // partner, rebuilt from every snapshot, so pushing a box or riding a pulley is instant.
  let localState = null;
  let partner = null;

  function resetLocalWorld(s) {
    const other = myRole === 'fire' ? 'water' : 'fire';
    localState = Physics.cloneState(s);
    partner = { x: s[other].x, y: s[other].y, vx: 0, vy: 0, onGround: true };
  }

  // Returns true if this step lands us in a deadly pool (same check as the server).
  function predictStep(inp) {
    if (inp.j) Physics.pressJump(me);
    Physics.stepEnv(level, localState, [me, partner]);
    Physics.stepBody(level, me, toInput(inp.d), [partner], Physics.DT, localState);
    return Physics.hazardUnder(level, me, myRole) !== 0;
  }

  function clientTick() {
    if (!myRole || !level) return;
    // The character you're not driving gets a "stand still" input every tick, so the
    // server keeps simulating it normally instead of waiting for input.
    for (const r of myRoles) if (r !== myRole) socket.emit('i', { r, s: ++seq, d: 0, j: false });
    const inp = { r: myRole, s: ++seq, d: currentDir(), j: jumpQueued };
    jumpQueued = false;
    socket.emit('i', inp);
    if (target && !playing()) return; // the server ignores inputs during pauses
    // Keep it even before the first snapshot: reconcile() replays it on top of the
    // server state once the server has a position for us.
    pending.push(inp);
    if (pending.length > 120) pending.shift(); // ~2 s without an ack: give up on old ones
    if (me && !meDead && predictStep(inp)) meDead = true;
  }

  function reconcile(s) {
    const srv = s[myRole];
    const before = me && { x: me.x, y: me.y };
    me = { x: srv.x, y: srv.y, vx: srv.vx, vy: srv.vy, onGround: srv.onGround, coyoteT: srv.coyoteT, bufferT: srv.bufferT, pushing: srv.pushing };
    resetLocalWorld(s);
    pending = pending.filter((p) => p.s > srv.ack);
    // Replay; if the replay hits a pool, freeze there. If the server disagrees, the
    // next snapshot replays without hitting it and we carry on.
    meDead = false;
    if (s.phase === 'playing') for (const p of pending) if (predictStep(p)) { meDead = true; break; }
    if (before) {
      // Hide small corrections by easing them out; snap on big ones (respawn, teleport).
      const dx = before.x - me.x + errX, dy = before.y - me.y + errY;
      if (Math.hypot(dx, dy) < 2 * TILE) { errX = dx; errY = dy; } else { errX = errY = 0; }
    }
  }

  // Other characters are drawn ~100 ms in the past, blended between two snapshots.
  const INTERP_MS = 100;
  function interpolated(role, now) {
    const t = now - INTERP_MS;
    for (let i = snaps.length - 1; i > 0; i--) {
      const a = snaps[i - 1], b = snaps[i];
      if (a.t <= t && t <= b.t) {
        if (a.s.level !== b.s.level) break;
        const k = (t - a.t) / (b.t - a.t || 1);
        return { x: a.s[role].x + (b.s[role].x - a.s[role].x) * k, y: a.s[role].y + (b.s[role].y - a.s[role].y) * k };
      }
    }
    return { x: target[role].x, y: target[role].y };
  }

  // ---- Ping readout ----
  setInterval(() => {
    if (!socket.connected) return;
    const t0 = performance.now();
    socket.emit('p', () => { $('ping').textContent = `${Math.round(performance.now() - t0)}ms`; });
  }, 2000);

  // ---- Rendering ----
  const COLORS = {
    fire: '#ff6a2b', water: '#2bb0ff',
    bg: '#1e1b2e', rock: '#3a3552', rockTop: '#5b5480',
    [T.LAVA]: '#ff5a1f', [T.WATER]: '#1f8fff', [T.ACID]: '#5fd35a',
  };
  let scale = 1;
  let staticLayer = null; // pre-rendered tiles for the current level

  function resizeCanvas() {
    if (!level) return;
    scale = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = level.pxWidth * scale;
    canvas.height = level.pxHeight * scale;
    staticLayer = renderStatic();
  }
  addEventListener('resize', resizeCanvas);

  // Rock and fan shafts don't change during a level, so draw them once.
  function renderStatic() {
    const c = document.createElement('canvas');
    c.width = canvas.width;
    c.height = canvas.height;
    const g = c.getContext('2d');
    g.setTransform(scale, 0, 0, scale, 0, 0);
    g.fillStyle = COLORS.bg;
    g.fillRect(0, 0, level.pxWidth, level.pxHeight);
    for (let ty = 0; ty < level.height; ty++) {
      for (let tx = 0; tx < level.width; tx++) {
        const t = Physics.tileAt(level, tx, ty);
        const x = tx * TILE, y = ty * TILE;
        if (t === T.SOLID) {
          g.fillStyle = COLORS.rock;
          g.fillRect(x, y, TILE, TILE);
          if (!Physics.isSolid(level, tx, ty - 1)) { g.fillStyle = COLORS.rockTop; g.fillRect(x, y, TILE, 4); }
        } else if (t === T.LAVA || t === T.WATER || t === T.ACID) {
          g.fillStyle = COLORS.rock;
          g.fillRect(x, y, TILE, TILE);
        } else if (t === T.FAN) {
          g.fillStyle = 'rgba(200, 230, 255, 0.07)';
          g.fillRect(x, y, TILE, TILE);
          if (Physics.isSolid(level, tx, ty + 1)) { // fan unit at the base of the shaft
            g.fillStyle = '#8a86a8';
            g.fillRect(x + 1, y + TILE - 6, TILE - 2, 6);
          }
        }
      }
    }
    // Doors
    for (const role of ['fire', 'water']) {
      const e = level.exits[role];
      const x = e.tx * TILE, y = e.ty * TILE - TILE;
      g.fillStyle = '#2a2640';
      g.fillRect(x - 2, y - 2, TILE + 4, TILE * 2 + 2);
      g.fillStyle = role === 'fire' ? '#7a2a12' : '#123f7a';
      g.fillRect(x + 1, y + 1, TILE - 2, TILE * 2 - 1);
      g.fillStyle = COLORS[role];
      g.font = `${TILE * 0.6}px system-ui`;
      g.textAlign = 'center';
      g.fillText(role === 'fire' ? '♨' : '≈', x + TILE / 2, y + TILE * 0.9);
    }
    return c;
  }

  function drawPools(now) {
    for (let ty = 0; ty < level.height; ty++) {
      for (let tx = 0; tx < level.width; tx++) {
        const t = Physics.tileAt(level, tx, ty);
        if (t !== T.LAVA && t !== T.WATER && t !== T.ACID) continue;
        const wave = Math.sin(now / 300 + tx * 1.3) * 1.5;
        ctx.fillStyle = COLORS[t];
        ctx.fillRect(tx * TILE, ty * TILE + 3 + wave, TILE, TILE / 2 - wave);
      }
    }
  }

  function drawFanAir(now) {
    ctx.fillStyle = 'rgba(220, 240, 255, 0.35)';
    for (let ty = 0; ty < level.height; ty++) {
      for (let tx = 0; tx < level.width; tx++) {
        if (Physics.tileAt(level, tx, ty) !== T.FAN) continue;
        const off = (now / 8 + tx * 7) % TILE;
        ctx.fillRect(tx * TILE + 6, ty * TILE + TILE - off, 2, 5);
        ctx.fillRect(tx * TILE + 16, ty * TILE + ((TILE - off + 12) % TILE), 2, 5);
      }
    }
  }

  const CH_COLORS = ['#ffd84a', '#c77dff', '#4af0d8', '#ff7ab8', '#a0e060'];
  const chColor = (ch) => CH_COLORS[(ch - 1) % CH_COLORS.length];

  function drawMechanisms(s) {
    level.gates.forEach((gt, i) => {
      const { x, y, w, h } = gt.rect;
      ctx.strokeStyle = chColor(gt.ch);
      ctx.lineWidth = 2;
      if (s.gates[i]) {
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = '#4b4566';
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = chColor(gt.ch);
        if (w >= h) for (let px = x + 4; px < x + w; px += 8) ctx.fillRect(px, y + h / 2 - 1, 4, 2);
        else for (let py = y + 4; py < y + h; py += 8) ctx.fillRect(x + w / 2 - 1, py, 2, 4);
      }
    });
    level.plates.forEach((p, i) => {
      const { x, y, w } = p.rect;
      const down = s.plates[i];
      ctx.fillStyle = chColor(p.ch);
      ctx.fillRect(x, y + (down ? 4 : 1), w, down ? 2 : 5);
    });
    level.levers.forEach((l, i) => {
      const cx = l.tx * TILE + TILE / 2, base = (l.ty + 1) * TILE;
      const on = s.levers[i];
      ctx.fillStyle = '#8a86a8';
      ctx.fillRect(cx - 6, base - 4, 12, 4);
      ctx.strokeStyle = chColor(l.ch);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx, base - 3);
      const lean = (on ? 1 : -1) * l.dir;
      ctx.lineTo(cx + lean * 9, base - 15);
      ctx.stroke();
      // arrow showing which way to walk through it
      ctx.fillStyle = chColor(l.ch);
      ctx.globalAlpha = on ? 0.3 : 0.8;
      ctx.beginPath();
      const ax = cx + l.dir * 2, ay = base - 22;
      ctx.moveTo(ax + l.dir * 5, ay);
      ctx.lineTo(ax - l.dir * 3, ay - 4);
      ctx.lineTo(ax - l.dir * 3, ay + 4);
      ctx.fill();
      ctx.globalAlpha = 1;
    });
  }

  function drawBoxes(s) {
    for (const b of s.boxes) {
      const x = b.x, y = b.y, n = Physics.BOX.size;
      ctx.fillStyle = '#9a6a3a';
      ctx.fillRect(x, y, n, n);
      ctx.strokeStyle = '#6b4626';
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, n - 2, n - 2);
      ctx.beginPath();
      ctx.moveTo(x + 3, y + 3); ctx.lineTo(x + n - 3, y + n - 3);
      ctx.moveTo(x + n - 3, y + 3); ctx.lineTo(x + 3, y + n - 3);
      ctx.stroke();
    }
  }

  // Platforms hang from ropes over two wheels joined by a beam near the top.
  function drawPulleys(s) {
    const rects = Physics.platformRects(level, s);
    level.pulleys.forEach((p, i) => {
      const [A, B] = rects.slice(i * 2, i * 2 + 2);
      const top = Math.max(TILE * 0.6, Math.min(p.a.y + p.min, p.b.y - p.max) - TILE * 1.2);
      const ax = A.x + A.w / 2, bx = B.x + B.w / 2;
      ctx.strokeStyle = '#c9b98a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(ax, A.y); ctx.lineTo(ax, top);
      ctx.lineTo(bx, top); ctx.lineTo(bx, B.y);
      ctx.stroke();
      ctx.fillStyle = '#8a86a8';
      for (const cx of [ax, bx]) { ctx.beginPath(); ctx.arc(cx, top, 6, 0, Math.PI * 2); ctx.fill(); }
      for (const r of [A, B]) {
        ctx.fillStyle = '#7d7398';
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.fillStyle = '#b3a9d4';
        ctx.fillRect(r.x, r.y, r.w, 3);
      }
    });
  }

  function drawGems(s, now) {
    level.gems.forEach((g, i) => {
      if (s.gems[i]) return;
      const cx = g.tx * TILE + TILE / 2, cy = g.ty * TILE + TILE / 2 + Math.sin(now / 250 + i) * 2;
      ctx.fillStyle = g.el === 'fire' ? '#ff4d4d' : '#4da6ff';
      ctx.beginPath();
      ctx.moveTo(cx, cy - 7);
      ctx.lineTo(cx + 6, cy);
      ctx.lineTo(cx, cy + 7);
      ctx.lineTo(cx - 6, cy);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillRect(cx - 2, cy - 3, 2, 2);
    });
  }

  function drawChar(role, p, t, s) {
    const { width: w, height: h } = CHAR;
    const dead = s.phase === 'dead' || t.dead;
    ctx.globalAlpha = !t.connected ? 0.3 : dead ? 0.5 : 1;
    ctx.fillStyle = COLORS[role];
    ctx.fillRect(p.x, p.y, w, h);
    // Eyes look the way you're moving
    const look = t.vx > 5 ? 3 : t.vx < -5 ? -3 : 0;
    ctx.fillStyle = '#fff';
    ctx.fillRect(p.x + 4 + look, p.y + 8, 4, 5);
    ctx.fillRect(p.x + 12 + look, p.y + 8, 4, 5);
    if (role === myRole) { // marker above your own character
      ctx.beginPath();
      ctx.moveTo(p.x + w / 2 - 6, p.y - 14);
      ctx.lineTo(p.x + w / 2 + 6, p.y - 14);
      ctx.lineTo(p.x + w / 2, p.y - 6);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  let lastFrame = performance.now();
  let tickAcc = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min((now - lastFrame) / 1000, 0.1);
    lastFrame = now;
    tickAcc += dt;
    while (tickAcc >= Physics.DT) { clientTick(); tickAcc -= Physics.DT; }
    const decay = Math.exp(-dt * 12);
    errX *= decay; errY *= decay;
    if (!level || !staticLayer) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(staticLayer, 0, 0);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    drawPools(now);
    drawFanAir(now);
    if (!target) return;
    // Draw the world as you predict it (so a box you push moves with you), or as the
    // server last said when you're not playing.
    const predicting = me && playing() && localState;
    const world = predicting ? localState : Physics.cloneState(target);
    drawMechanisms(world);
    drawPulleys(world);
    drawBoxes(world);
    drawGems(target, now);
    for (const role of ['fire', 'water']) {
      const pos = role === myRole && me && playing()
        ? { x: me.x + errX, y: me.y + errY }
        : role === myRole ? { x: target[role].x, y: target[role].y } : interpolated(role, now);
      drawChar(role, pos, role === myRole && me ? { ...target[role], vx: me.vx, dead: meDead } : target[role], target);
    }
  }
  requestAnimationFrame(frame);
})();
