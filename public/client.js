(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  const { T } = Physics;

  // ---- Start menu, or straight into a room from a ?room= link ----
  // ?level=N starts a new room at level N (handy for testing).
  const CODE_RE = /^[A-Z0-9]{4,8}$/;
  const params = new URLSearchParams(location.search);
  const code = (params.get('room') || '').toUpperCase();
  const startLevel = parseInt(params.get('level'), 10) || undefined;
  const startMode = params.get('mode') === 'challenge' ? 'challenge' : undefined; // only used if the room is new

  const goToRoom = (c, mode) => {
    const p = new URLSearchParams({ room: c });
    if (startLevel) p.set('level', startLevel);
    if (mode) p.set('mode', mode);
    location.href = `${location.pathname}?${p}`;
  };
  const newCode = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  };

  if (!CODE_RE.test(code)) {
    // No room yet: show the menu and stop here (no connection until you pick one).
    document.body.classList.add('on-menu');
    $('menu').hidden = false;
    for (const id of ['hud', 'stage', 'rotate', 'controls']) $(id).hidden = true;
    $('create').addEventListener('click', () => goToRoom(newCode()));
    $('challenge').addEventListener('click', () => goToRoom(newCode(), 'challenge'));
    $('joincode').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
    $('joinform').addEventListener('submit', (e) => {
      e.preventDefault();
      const c = $('joincode').value.trim().toUpperCase();
      if (CODE_RE.test(c)) return goToRoom(c);
      $('menuerror').textContent = 'Room codes are 4–8 letters or numbers.';
      $('menuerror').hidden = false;
    });
    return;
  }
  $('code').textContent = code;

  $('back').addEventListener('click', () => { location.href = location.pathname; });

  // Settings dropdown: restart, fullscreen, share.
  const settings = $('settings');
  const setSettings = (open) => {
    settings.hidden = !open;
    $('settingsbtn').setAttribute('aria-expanded', String(open));
  };
  $('settingsbtn').addEventListener('click', (e) => { e.stopPropagation(); setSettings(settings.hidden); });
  document.addEventListener('pointerdown', (e) => {
    if (!settings.hidden && !e.target.closest('.settings-wrap')) setSettings(false);
  });
  settings.addEventListener('click', () => setSettings(false)); // any item closes it

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

  let mode = 'campaign';
  let levelLoad = 0; // server's load counter: snapshots from an older load are ignored
  function setLevel(info) {
    level = Physics.parseLevel(info.def);
    levelIndex = info.index;
    levelTotal = info.total;
    levelLoad = info.load;
    target = null;
    snaps = [];
    me = null;
    meDead = false;
    pending = [];
    const title = info.label || `Level ${levelIndex + 1}`;
    $('levelnum').textContent = info.label || `${levelIndex + 1}/${levelTotal}`;
    $('levelname').textContent = level.name;
    resizeCanvas();
    showBanner(`<b>${escapeHtml(title)}</b>${escapeHtml(level.name)}`, 1800);
  }

  // ---- Networking ----
  // WebSocket straight away (no slow polling start); polling only if that fails.
  const socket = io({ transports: ['websocket', 'polling'], tryAllTransports: true });
  socket.on('connect', () => socket.emit('join', { code, level: startLevel, mode: startMode }));
  socket.on('disconnect', () => { $('status').textContent = 'Reconnecting…'; });
  socket.on('error-msg', (msg) => { $('status').textContent = msg; });

  socket.on('joined', (msg) => {
    CHAR = msg.char;
    TILE = msg.tile;
    mode = msg.mode || 'campaign';
    $('devskip').hidden = !msg.dev;
    document.body.classList.toggle('challenge', mode === 'challenge');
    $('hearts').hidden = mode !== 'challenge';
    $('bar').hidden = mode !== 'challenge';
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
    if (mode === 'challenge') return flashStatus('No level picking in a challenge run');
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
    if (run) { lastBar = ''; renderBar(run); renderUse(); }
  }
  socket.on('roles', (msg) => setRoles(msg.roles, msg.active));
  socket.on('notice', (msg) => flashStatus(msg));

  function updateSwap() {
    const next = myRole === 'fire' ? 'water' : 'fire';
    $('swap').textContent = myRole ? `⇄ ${next === 'fire' ? '🔥' : '💧'}` : '⇄ Play';
  }
  $('swap').addEventListener('click', () => socket.emit('swap'));

  socket.on('state', (s) => {
    if (!level || s.level !== levelLoad) return; // level change in flight
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
    if (s.run) renderRun(s.run, s.phase);
  });

  const CAUSE = { [T.LAVA]: 'fell in the lava', [T.WATER]: 'fell in the water', [T.ACID]: 'fell in the acid', sentry: 'touched a sentry', flyer: 'was caught by the flyer', walker: 'was squashed by the walker', shot: 'was shot', 'acid floor': 'was on the ground when it burned' };
  socket.on('event', (e) => {
    if (e.type === 'level') {
      setLevel(e);
    } else if (e.type === 'death') {
      const who = e.role === 'fire' ? '🔥 Fire' : '💧 Water';
      showBanner(`<b>Oops!</b>${who} ${CAUSE[e.cause] || 'died'}${mode === 'challenge' ? ' · −1 ❤' : ''}`, 1200);
      if (e.role === myRole) navigator.vibrate?.([40, 40, 80]);
    } else if (e.type === 'restart') {
      me = null; meDead = false; errX = errY = 0;
    } else if (e.type === 'gem') {
      if (e.role === myRole) navigator.vibrate?.(15);
    } else if (e.type === 'guardian') {
      showBanner(`<b>🛡 Guardian!</b>${e.role === 'fire' ? '🔥 Fire' : '💧 Water'} was sent back to the start`, 1300);
    } else if (e.type === 'bonus') {
      const b = Bonuses.BY_ID[e.id];
      if (b) flashStatus(`+ ${b.name}${e.role ? ` (${e.role === 'fire' ? '🔥' : '💧'})` : ''}`);
    } else if (e.type === 'countdown') {
      navigator.vibrate?.(20);
    } else if (e.type === 'complete' && mode === 'challenge') {
      showBanner(`<b>${escapeHtml(e.label || 'Room')} cleared!</b>⏱ ${formatTime(e.timeMs)}`, 2500);
      navigator.vibrate?.([30, 50, 30, 50, 60]);
    } else if (e.type === 'complete') {
      const gems = e.totalGems ? ` · 💎 ${e.gems}/${e.totalGems}` : '';
      const deaths = e.deaths ? ` · ${e.deaths} ${e.deaths === 1 ? 'retry' : 'retries'}` : '';
      const next = e.last ? 'That was the last level! Back to level 1…' : 'Next level coming up…';
      showBanner(`<b>Level ${e.index + 1} complete!</b>⏱ ${formatTime(e.timeMs)}${gems}${deaths}<br>${next}`, 3000);
      navigator.vibrate?.([30, 50, 30, 50, 60]);
    }
  });

  $('restart').addEventListener('click', () => socket.emit('restart'));
  $('devskip').addEventListener('click', () => socket.emit('dev-skip'));

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
    if (e.code === 'Escape') { closePicker(); setSettings(false); }
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
    me = {
      x: srv.x, y: srv.y, vx: srv.vx, vy: srv.vy, onGround: srv.onGround, coyoteT: srv.coyoteT, bufferT: srv.bufferT, pushing: srv.pushing,
      jumpMul: srv.jumpMul, speedMul: srv.speedMul, maxAirJumps: srv.maxAirJumps, airJumps: srv.airJumps, flyT: srv.flyT, acidImmune: srv.acidImmune, magnet: srv.magnet,
    };
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
      const d = Physics.doorRect(level, role); // the same rect that counts for reaching the exit
      g.fillStyle = '#2a2640';
      g.fillRect(d.x, d.y, d.w, d.h);
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

  function drawGeysers(s, now) {
    for (const g of s.geysers || []) {
      ctx.fillStyle = 'rgba(160, 230, 255, 0.18)';
      ctx.fillRect(g.x, g.y, g.w, g.h);
      ctx.fillStyle = 'rgba(220, 245, 255, 0.6)';
      for (let k = 0; k < 6; k++) {
        const off = (now / 6 + k * 29) % g.h;
        ctx.fillRect(g.x + 6 + ((k * 13) % (g.w - 12)), g.y + g.h - off, 3, 7);
      }
    }
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
    const blink = s.run && s.run.invuln[role] > 0 && Math.floor(performance.now() / 100) % 2;
    const fx = s.run && s.run.effects ? s.run.effects[role] : null;
    ctx.globalAlpha = !t.connected ? 0.3 : dead ? 0.5 : blink ? 0.35 : fx && fx.cloakT > 0 ? 0.4 : 1;
    if (fx && fx.shieldT > 0) {
      ctx.strokeStyle = '#7ff3ff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x + w / 2, p.y + h / 2, h * 0.75, 0, Math.PI * 2); ctx.stroke();
    }
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

  // ════════ Challenge mode UI ════════
  const roleIcon = (r) => (r === 'fire' ? '🔥' : '💧');
  const USES = { combat: 'once per room', once: 'one use for the team', cooldown: 'unlimited', free: 'unlimited' };
  const kindLabel = (b) => b.type === 'instant' ? 'Instant'
    : `${b.scope === 'team' ? 'Team' : 'Personal'} · ${b.color === 'yellow' ? `active (${USES[b.uses] || 'unlimited'}; equip it, use with ✦)` : 'passive (always on)'} · ${b.rarity}`;
  let run = null;
  let lastBar = '', lastMap = '', lastOver = '';

  function renderRun(r, phase) {
    run = r;
    $('hearts').textContent = '❤'.repeat(Math.max(0, r.hearts)) + '♡'.repeat(Math.max(0, r.maxHearts - r.hearts));
    renderBar(r);
    renderUse(r);
    renderMap(r, phase);
    renderOver(r, phase);
  }

  // Items (team) and powers (per player) under the HUD. Tap one for its description.
  function renderBar(r) {
    const key = JSON.stringify([r.items, r.personal, r.equip, myRoles]);
    if (key === lastBar) return;
    lastBar = key;
    const bar = $('bar');
    bar.innerHTML = '';
    const add = (el) => bar.append(el);
    const chip = (b, cls, badge, onTap) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `chip ${cls}`;
      el.innerHTML = b.icon + (badge ? `<span class="who">${badge}</span>` : '');
      el.setAttribute('aria-label', b.name);
      el.addEventListener('click', (e) => { e.stopPropagation(); onTap(); });
      return el;
    };
    const label = (t) => { const s = document.createElement('span'); s.className = 'label'; s.textContent = t; return s; };
    add(label(r.items.length ? 'Team' : 'Team: no items yet'));
    const itemChip = (it, owner) => {
      const b = Bonuses.BY_ID[it.id];
      const who = ['fire', 'water'].filter((role) => r.equip[role] === it.uid).map(roleIcon).join('');
      const off = it.spent || !it.ready || it.cool;
      return chip(b, `${b.color}${off ? ' spent' : ''}${it.spent ? ' gone' : ''}`, it.spent ? '✕' : who, () => showTip(b, it, owner));
    };
    for (const it of r.items) add(itemChip(it, null));
    for (const role of ['fire', 'water']) {
      if (!r.personal[role].length) continue;
      const sep = document.createElement('span'); sep.className = 'sep'; add(sep);
      add(label(roleIcon(role)));
      // copies of the same passive show once, with ×2, ×3…
      const counts = {};
      for (const it of r.personal[role]) if (Bonuses.BY_ID[it.id].color === 'green') counts[it.id] = (counts[it.id] || 0) + 1;
      const shown = new Set();
      for (const it of r.personal[role]) {
        const green = Bonuses.BY_ID[it.id].color === 'green';
        if (green && shown.has(it.id)) continue;
        shown.add(it.id);
        const el = itemChip(it, role);
        if (green && counts[it.id] > 1) { const x = document.createElement('span'); x.className = 'count'; x.textContent = `×${counts[it.id]}`; el.append(x); }
        add(el);
      }
    }
  }

  function showTip(b, item, owner) {
    const tip = $('tip');
    tip.innerHTML = `<h3><span style="color:${b.color === 'green' ? '#5fd35a' : b.color === 'yellow' ? '#ffd84a' : '#c9c0ff'}">${b.icon}</span>${escapeHtml(b.name)}</h3>
      <div class="kind">${kindLabel(b)}${owner ? ` · ${roleIcon(owner)}'s` : ''}${item && item.spent ? ' · used up' : item && !item.ready ? ' · used, recharges next room' : ''}</div><p>${escapeHtml(b.desc)}</p><div class="actions"></div>`;
    if (item && b.color === 'yellow' && !item.spent) {
      for (const role of myRoles.filter((r2) => !owner || r2 === owner)) {
        const btn = document.createElement('button');
        const on = run.equip[role] === item.uid;
        btn.textContent = on ? `Equipped by ${roleIcon(role)} ✓` : `Equip for ${roleIcon(role)}`;
        btn.disabled = on;
        btn.addEventListener('click', () => { socket.emit('equip', { r: role, uid: item.uid }); tip.hidden = true; });
        tip.querySelector('.actions').append(btn);
      }
    }
    tip.hidden = false;
  }
  document.addEventListener('pointerdown', (e) => { if (!$('tip').hidden && !e.target.closest('#tip, .chip')) $('tip').hidden = true; });

  // ✦ use-item button above jump: shows the item you have equipped.
  function equippedItem() {
    if (!run || !myRole) return null;
    const uid = run.equip[myRole];
    return run.items.concat(run.personal[myRole]).find((i) => i.uid === uid) || null;
  }
  function renderUse() {
    const btn = $('use');
    const it = equippedItem();
    btn.hidden = mode !== 'challenge' || !myRole;
    btn.innerHTML = it ? Bonuses.BY_ID[it.id].icon : '✦';
    btn.classList.toggle('spent', !it || !it.ready || it.cool);
    btn.title = it ? Bonuses.BY_ID[it.id].name : 'No item equipped: tap an item in the bar';
  }
  function useItem() {
    const it = equippedItem();
    if (!it) return flashStatus('No item equipped: tap a yellow item in the bar');
    if (it.cool) return;
    if (!it.ready) return flashStatus(`${Bonuses.BY_ID[it.id].name} recharges next room`);
    if (it.id === 'wings' && me) me.flyT = Bonuses.BY_ID.wings.duration; // predict the flight right away
    socket.emit('use', { r: myRole });
    navigator.vibrate?.(15);
  }
  $('use').addEventListener('pointerdown', (e) => { e.preventDefault(); useItem(); });
  addEventListener('keydown', (e) => { if ((e.code === 'KeyE' || e.code === 'ShiftLeft') && !e.repeat && mode === 'challenge') useItem(); });

  // The map between rooms: team vote (rock paper scissors on a tie), then personal picks.
  function card(id, { chosen, votes, onPick }) {
    const b = Bonuses.BY_ID[id];
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `card ${b.rarity}${chosen ? ' chosen' : ''}`;
    const tag = b.rarity === 'common' ? '' : ` <span class="tier">${b.rarity}</span>`;
    el.innerHTML = `<span class="ic">${b.icon}</span><b>${escapeHtml(b.name)}${tag}</b><small>${b.type === 'instant' ? '' : `<i>${b.scope === 'team' ? 'Team' : 'Personal'} · ${b.color === 'yellow' ? 'active' : 'passive'}</i><br>`}${escapeHtml(b.desc)}</small><div class="votes">${votes || ''}</div>`;
    if (onPick) el.addEventListener('click', onPick);
    return el;
  }
  function renderMap(r, phase) {
    const m = r.map;
    const view = $('mapview');
    const key = JSON.stringify([phase, m, r.stage, myRoles]);
    if (key === lastMap) return;
    lastMap = key;
    view.hidden = !(phase === 'map' && m);
    if (view.hidden) return;
    view.innerHTML = '';
    const h = (tag, html, cls) => { const el = document.createElement(tag); el.innerHTML = html; if (cls) el.className = cls; view.append(el); return el; };
    // progress track
    const track = h('div', '', 'track');
    r.stages.forEach((s, i) => {
      if (i) { const l = document.createElement('span'); l.className = 'link'; track.append(l); }
      const n = document.createElement('span');
      n.className = `node${s !== 'room' ? ' boss' : ''}${i <= r.stage ? ' done' : ''}${i === r.stage + 1 ? ' here' : ''}`;
      n.textContent = s !== 'room' ? '☠' : i <= r.stage ? '✓' : '';
      track.append(n);
    });
    const rare = m.rarity === 'rare';
    if (m.step === 'shared') {
      h('h2', rare ? '★ Boss reward: pick a team bonus' : 'Pick a team bonus');
      if (!rare) h('p', m.uncommonChance > 0 ? `⭐ Stars collected: ${Math.round(m.uncommonChance * 100)}% chance of each offer being uncommon` : '⭐ Collect stars for a chance at uncommon bonuses', 'muted');
      h('p', myRoles.length > 1 ? 'You\'re playing both, so your choice decides.' : 'You both vote. If you disagree: rock, paper, scissors.', 'muted');
      const cards = h('div', '', 'cards');
      for (const id of m.shared.options) {
        const votes = ['fire', 'water'].filter((role) => m.shared.votes[role] === id).map(roleIcon).join(' ');
        const mine = myRole && m.shared.votes[myRole] === id;
        cards.append(card(id, { rare, chosen: mine, votes, onPick: myRole ? () => socket.emit('map', { r: myRole, type: 'vote', pick: id }) : null }));
      }
    } else if (m.step === 'rps') {
      h('h2', 'Tie! Rock, paper, scissors');
      const vote = (role) => Bonuses.BY_ID[m.shared.votes[role]].name;
      h('p', `🔥 wants <b>${escapeHtml(vote('fire'))}</b> · 💧 wants <b>${escapeHtml(vote('water'))}</b>. Winner's pick goes.${m.rps.round > 1 ? ` Round ${m.rps.round}.` : ''}`, 'muted');
      if (m.rps.last) h('p', `Last round: 🔥 ${HAND[m.rps.last.fire]} vs 💧 ${HAND[m.rps.last.water]}: draw!`, 'muted');
      const hands = h('div', '', 'hands');
      for (const hand of ['rock', 'paper', 'scissors']) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = HAND[hand];
        b.setAttribute('aria-label', hand);
        if (myRole && m.rps.picks[myRole] === hand) b.className = 'chosen';
        b.disabled = !myRole || !!m.rps.picks[myRole];
        b.addEventListener('click', () => socket.emit('map', { r: myRole, type: 'rps', hand }));
        hands.append(b);
      }
      if (myRole && m.rps.picks[myRole]) h('p', 'Waiting for your partner…', 'muted');
    } else if (m.step === 'personal') {
      if (m.rps && m.rps.winner) h('p', `${roleIcon(m.rps.winner)} won rock, paper, scissors (${HAND[m.rps.last.fire]} vs ${HAND[m.rps.last.water]}).`, 'muted');
      h('h2', rare ? '★ Pick a rare personal bonus' : 'Pick a personal bonus');
      const mine = myRoles.length ? myRoles : [];
      for (const role of mine) {
        const opts = m.personal.options[role];
        h('p', `${roleIcon(role)} ${role === 'fire' ? 'Fire' : 'Water'}${m.personal.picks[role] ? ': picked ✓' : ''}`, 'muted');
        const cards = h('div', '', 'cards');
        if (!opts.length) {
          const b = document.createElement('button'); b.type = 'button'; b.className = 'card'; b.textContent = 'Nothing new to offer: continue';
          b.addEventListener('click', () => socket.emit('map', { r: role, type: 'pick', pick: 'none' }));
          cards.append(b);
        }
        for (const id of opts) {
          const el = card(id, { rare, chosen: m.personal.picks[role] === id, onPick: m.personal.picks[role] ? null : () => socket.emit('map', { r: role, type: 'pick', pick: id }) });
          if (m.personal.picks[role] && m.personal.picks[role] !== id) el.style.opacity = '0.4';
          cards.append(el);
        }
      }
      const waiting = ['fire', 'water'].filter((role) => !m.personal.picks[role] && !mine.includes(role));
      if (waiting.length) h('p', `Waiting for ${waiting.map(roleIcon).join(' ')}…`, 'muted');
    }
  }
  const HAND = { rock: '✊', paper: '✋', scissors: '✌️' };

  function renderOver(r, phase) {
    const view = $('over');
    const key = JSON.stringify([phase, r.result, r.stage]);
    if (key === lastOver) return;
    lastOver = key;
    view.hidden = phase !== 'over';
    if (view.hidden) return;
    const won = r.result === 'victory';
    view.innerHTML = `<div class="big">${won ? '🏆 Run complete!' : '☠ Out of hearts'}</div>
      <p class="muted">${won ? 'Both bosses beaten.' : `You reached ${r.stages[r.stage] === 'room' ? `room ${r.stage + 1}` : `boss ${r.stage === 4 ? 1 : 2}`} of ${r.stages.length}.`}
      ${r.items.length + r.personal.fire.length + r.personal.water.length} items collected.</p>`;
    const again = document.createElement('button'); again.type = 'button'; again.textContent = 'New run';
    again.addEventListener('click', () => socket.emit('newrun'));
    const menu = document.createElement('button'); menu.type = 'button'; menu.textContent = 'Menu';
    menu.addEventListener('click', () => { location.href = location.pathname; });
    view.append(again, menu);
  }

  // Enemies, shots and the boss-2 acid floor.
  function drawEnemies(r, now) {
    for (const e of r.enemies) {
      ctx.globalAlpha = e.stun ? 0.4 : 1;
      if (e.type === 'sentry') {
        ctx.fillStyle = '#b04cff';
        ctx.beginPath();
        const cx = e.x + e.w / 2, cy = e.y + e.h / 2;
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2 + now / 600, rr = k % 2 ? e.w / 2 + 3 : e.w / 2 - 3;
          ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
        }
        ctx.fill();
        ctx.fillStyle = '#fff'; ctx.fillRect(cx - 4, cy - 2, 3, 3); ctx.fillRect(cx + 1, cy - 2, 3, 3);
      } else if (e.type === 'flyer') {
        const flap = Math.sin(now / 80) * 6;
        ctx.fillStyle = '#e04b6b';
        ctx.beginPath();
        ctx.moveTo(e.x, e.y + e.h / 2 - flap); ctx.lineTo(e.x + e.w / 2, e.y + e.h / 2); ctx.lineTo(e.x + e.w, e.y + e.h / 2 - flap);
        ctx.lineTo(e.x + e.w / 2, e.y + e.h); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.fillRect(e.x + e.w / 2 - 5, e.y + e.h / 2 + 2, 3, 3); ctx.fillRect(e.x + e.w / 2 + 2, e.y + e.h / 2 + 2, 3, 3);
      } else if (e.type === 'walker') {
        ctx.fillStyle = '#6b3fa0';
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(e.x, e.y, e.w, e.h, e.w / 4) : ctx.rect(e.x, e.y, e.w, e.h);
        ctx.fill();
        ctx.fillStyle = '#fff';
        const s = Math.max(3, e.w / 8);
        ctx.fillRect(e.x + e.w * 0.25, e.y + e.h * 0.3, s, s); ctx.fillRect(e.x + e.w * 0.65, e.y + e.h * 0.3, s, s);
      } else if (e.type === 'shooter') {
        ctx.fillStyle = '#8a86a8'; ctx.fillRect(e.x, e.y, e.w, e.h);
        ctx.fillStyle = '#ff6a2b'; ctx.fillRect(e.x + e.w / 2 - 4, e.y + e.h - 4, 8, 8);
      }
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = '#ffb02e';
    for (const s of r.shots) { ctx.beginPath(); ctx.arc(s.x + 5, s.y + 5, 5, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = '#7ff3ff';
    for (const b of r.bullets || []) ctx.fillRect(b.x, b.y, 8, 4);
    if (r.acid) {
      if (r.acid.burning) { // every walkable surface glows green
        ctx.fillStyle = 'rgba(95, 211, 90, 0.75)';
        for (let ty = 1; ty < level.height; ty++) for (let tx = 0; tx < level.width; tx++) {
          if (Physics.isSolid(level, tx, ty) && !Physics.isSolid(level, tx, ty - 1)) ctx.fillRect(tx * TILE, ty * TILE - 3, TILE, 7);
        }
      }
      const n = Math.ceil(r.acid.countdown);
      // A jump keeps you up ~0.62 s and the burn lasts 0.1 s: be in the air for it.
      const text = r.acid.burning ? 'ACID!' : r.acid.countdown > 0 && r.acid.countdown < 0.5 ? 'JUMP!' : n > 0 ? String(n) : '';
      if (text) {
        ctx.font = 'bold 72px system-ui';
        ctx.textAlign = 'center';
        ctx.fillStyle = r.acid.burning ? '#5fd35a' : 'rgba(255,255,255,0.85)';
        ctx.fillText(text, level.pxWidth / 2, level.pxHeight / 2);
        if (n === 1 && !r.acid.burning) { ctx.font = 'bold 24px system-ui'; ctx.fillText('jump!', level.pxWidth / 2, level.pxHeight / 2 + 34); }
      }
    }
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
    drawGeysers(world, now);
    drawPulleys(world);
    drawBoxes(world);
    drawGems(target, now);
    if (target.run) drawEnemies(target.run, now);
    for (const role of ['fire', 'water']) {
      const pos = role === myRole && me && playing()
        ? { x: me.x + errX, y: me.y + errY }
        : role === myRole ? { x: target[role].x, y: target[role].y } : interpolated(role, now);
      drawChar(role, pos, role === myRole && me ? { ...target[role], vx: me.vx, dead: meDead } : target[role], target);
    }
  }
  requestAnimationFrame(frame);
})();
