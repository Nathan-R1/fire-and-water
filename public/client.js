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
    for (const id of ['hud', 'stage', 'controls']) $(id).hidden = true;
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
  // Open below the ⚙ button, right-aligned to it, but always fully on screen: slide
  // sideways to fit, open upwards if there's no room below, and scroll if it's still
  // taller than the space available.
  const MARGIN = 8;
  function placeSettings() {
    const b = $('settingsbtn').getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    settings.style.maxHeight = '';
    settings.style.left = '0px'; settings.style.top = '0px';
    const m = settings.getBoundingClientRect();
    const left = Math.max(MARGIN, Math.min(b.right - m.width, vw - m.width - MARGIN));
    const below = vh - b.bottom - MARGIN - 6, above = b.top - MARGIN - 6;
    let top;
    if (m.height <= below || below >= above) {
      top = b.bottom + 6;
      settings.style.maxHeight = `${Math.max(80, below)}px`;
    } else {
      const h = Math.min(m.height, above);
      top = b.top - 6 - h;
      settings.style.maxHeight = `${Math.max(80, above)}px`;
    }
    settings.style.left = `${left}px`;
    settings.style.top = `${Math.max(MARGIN, top)}px`;
  }
  const setSettings = (open) => {
    settings.hidden = !open;
    $('settingsbtn').setAttribute('aria-expanded', String(open));
    if (open) placeSettings();
  };
  addEventListener('resize', () => { if (!settings.hidden) placeSettings(); });
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
  // Challenge enemies predicted alongside your character (see "Enemies" below)
  let pr = null;                 // predicted copy of the run's enemies, shots, acid and weather
  const enemyErr = new Map();    // enemy id -> visual offset left over from corrections
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
    clockSamples = [];
    clockOff = null;
    me = null;
    meDead = false;
    pending = [];
    pr = null;
    enemyErr.clear();
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
    noteClock(s.st, t);
    if (myRole) reconcile(s);
    $('timer').textContent = formatTime(s.timeMs);
    const mine = (el) => level.gems.filter((g, i) => g.el === el && s.gems[i]).length;
    const total = (el) => level.gems.filter((g) => g.el === el).length;
    $('gemcount').textContent = `🔴${mine('fire')}/${total('fire')} 🔵${mine('water')}/${total('water')}`;
    updateStatus();
    if (s.run) renderRun(s.run, s.phase);
  });

  const CAUSE = { lastchance: "didn't make it back in time", burrower: 'was caught by the burrower', mimic: 'was stabbed by a mimic box', charger: 'was run over by a charger', patrol: 'ran into a walker', bomb: 'was hit by a bomb', [T.LAVA]: 'fell in the lava', [T.WATER]: 'fell in the water', [T.ACID]: 'fell in the acid', sentry: 'touched a sentry', flyer: 'was caught by the flyer', walker: 'was squashed by the walker', shot: 'was shot', 'acid floor': 'was on the ground when it burned', drought: 'dried out in the drought', rain: 'was caught in the rain', flood: 'was caught in the acid flood' };
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
      showBanner(`<b>🛡 Guardian!</b>${e.role === 'fire' ? '🔥 Fire' : '💧 Water'} is shielded for 1s`, 1000);
    } else if (e.type === 'bonus') {
      const b = Bonuses.BY_ID[e.id];
      if (b) flashStatus(`+ ${b.name}${e.role ? ` (${e.role === 'fire' ? '🔥' : '💧'})` : ''}`);
    } else if (e.type === 'stomp') {
      if (e.role === myRole) navigator.vibrate?.(25);
    } else if (e.type === 'lastchance') {
      showBanner(`<b>⏳ Last Chance!</b>${e.role === 'fire' ? '🔥 Fire' : '💧 Water'}: back to your start in 5 seconds`, 1500);
    } else if (e.type === 'lastchance-saved') {
      showBanner('<b>Made it!</b>No heart lost: the room restarts', 1500);
    } else if (e.type === 'ward') {
      if (e.role === myRole) flashStatus(`🛡 Element Ward: ${e.seconds}s`);
    } else if (e.type === 'weather') {
      const W = { drought: '<b>☀ Drought!</b>💧 Water: get into a water pool', rain: '<b>🌧 Storm!</b>🔥 Fire: get under cover', flood: '<b>🫧 Acid flood!</b>Get up high' };
      showBanner(W[e.kind] || '', 2000);
      navigator.vibrate?.([20, 40, 20]);
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

  let flashTimer = null;
  function flashStatus(text) {
    statusOverride = text;
    $('status').textContent = text;
    clearTimeout(flashTimer); // a newer message gets its full time
    flashTimer = setTimeout(() => { statusOverride = null; updateStatus(); }, 1500);
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
    pr = predictedRun(s.run);
  }

  // Returns true if this step lands us in a deadly pool (same check as the server).
  // Steps the predicted enemies too, after the characters, as the server does.
  function predictStep(inp) {
    if (inp.j) Physics.pressJump(me);
    Physics.stepEnv(level, localState, [me, partner]);
    Physics.stepBody(level, me, toInput(inp.d), [partner], Physics.DT, localState);
    if (pr) {
      if (inp.d !== 0 || inp.j) pr.started = true; // moving starts the room, as on the server
      Enemies.predict(pr, Physics.DT, level, localState);
    }
    return Physics.hazardUnder(level, me, myRole, localState) !== 0;
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
    const enemiesBefore = predictedViews(true);
    me = {
      x: srv.x, y: srv.y, vx: srv.vx, vy: srv.vy, onGround: srv.onGround, coyoteT: srv.coyoteT, bufferT: srv.bufferT, pushing: srv.pushing,
      jumpMul: srv.jumpMul, speedMul: srv.speedMul, maxAirJumps: srv.maxAirJumps, airJumps: srv.airJumps, flyT: srv.flyT, acidImmune: srv.acidImmune, magnet: srv.magnet, phase: srv.phase,
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
    // Same for predicted enemies: ease small corrections (a walker that turned at a box
    // your partner pushed), snap big ones (a restart).
    enemyErr.clear();
    for (const [id, v] of predictedViews(false)) {
      const old = enemiesBefore.get(id);
      if (!old) continue;
      const dx = old.x - v.x, dy = old.y - v.y;
      if (Math.hypot(dx, dy) < 2 * TILE && Math.hypot(dx, dy) > 0.01) enemyErr.set(id, { x: dx, y: dy });
    }
  }

  // ---- Server clock ----
  // Snapshots are stamped with the server's step count (st) and sent every 2 steps.
  // Others are drawn by that clock, not by when snapshots happened to arrive, so they
  // move evenly even when the network delivers snapshots in bursts. The offset is the
  // smallest delay seen in the last 3 s (the least-delayed snapshot), eased so the
  // picture never jumps.
  const STEP_MS = Physics.DT * 1000;
  let clockSamples = []; // [arrival time, arrival time - server time]
  let clockOff = null;   // our clock minus the server's, for the least-delayed snapshot
  function noteClock(st, t) {
    const off = t - st * STEP_MS;
    clockSamples.push([t, off]);
    while (clockSamples[0][0] < t - 3000) clockSamples.shift();
    let best = off;
    for (const c of clockSamples) best = Math.min(best, c[1]);
    clockOff = clockOff === null ? best : clockOff + (best - clockOff) * 0.1;
  }

  // Others are drawn ~100 ms behind the server clock, blended between two snapshots.
  // Returns the snapshots either side of that moment and how far between them (0..1).
  const INTERP_MS = 100;
  function snapPair(now) {
    const ms = now - clockOff - INTERP_MS;
    const last = snaps[snaps.length - 1].s;
    if (ms >= last.st * STEP_MS) return { a: last, b: last, k: 0 }; // late snapshot: hold
    for (let i = snaps.length - 1; i > 0; i--) {
      const a = snaps[i - 1].s, b = snaps[i].s;
      const ta = a.st * STEP_MS, tb = b.st * STEP_MS;
      if (ms < ta) continue;
      if (a.level !== b.level) return { a: b, b, k: 0 };
      return { a, b, k: Math.min(1, (ms - ta) / (tb - ta || 1)) };
    }
    return { a: snaps[0].s, b: snaps[0].s, k: 0 };
  }
  function interpolated(role, now) {
    if (!snaps.length) return { x: target[role].x, y: target[role].y };
    const { a, b, k } = snapPair(now);
    return { x: a[role].x + (b[role].x - a[role].x) * k, y: a[role].y + (b[role].y - a[role].y) * k };
  }

  // ---- Enemies ----
  // Enemies that follow fixed rules (shared/enemies.js) are predicted forward alongside
  // your character, from each snapshot through the inputs the server hasn't processed
  // yet, so they line up with you exactly: what touches you on screen is what touches
  // you on the server. The rest (charger, burrower), and everything when you're only
  // watching, are drawn ~100 ms back and blended between snapshots like your partner.
  const copy = (x) => (x == null ? x : JSON.parse(JSON.stringify(x))); // it came as JSON; works on older Safari
  function predictedRun(run) {
    if (!run || !run.enemies) return null;
    return {
      started: run.started, time: run.time, slow: run.slow,
      enemies: copy(run.enemies), shots: copy(run.shots || []), bullets: copy(run.bullets || []),
      acid: copy(run.acid), weather: copy(run.weather),
    };
  }
  // id -> where a predicted enemy is drawn (with its leftover correction if `withErr`).
  function predictedViews(withErr) {
    const out = new Map();
    if (!pr) return out;
    for (const e of pr.enemies) {
      if (e.dead || !Enemies.PREDICTED.has(e.type)) continue;
      const v = Enemies.view(e), er = withErr && enemyErr.get(e.id);
      out.set(e.id, er ? { x: v.x + er.x, y: v.y + er.y } : { x: v.x, y: v.y });
    }
    return out;
  }

  // Blend two lists of things with ids; anything new, gone or teleported isn't blended.
  function blendById(listA, listB, k) {
    const byId = new Map(listA.map((x) => [x.id, x]));
    return listB.map((v) => {
      const o = byId.get(v.id);
      if (!o || Math.hypot(v.x - o.x, v.y - o.y) > 3 * TILE) return v;
      const out = { ...v, x: o.x + (v.x - o.x) * k, y: o.y + (v.y - o.y) * k };
      if (o.w != null) { out.w = o.w + (v.w - o.w) * k; out.h = o.h + (v.h - o.h) * k; }
      return out;
    });
  }

  // What to draw for the run: enemies (as views), shots, bullets, acid and weather.
  function enemyScene(now) {
    const run = target.run;
    if (!run || !run.enemies || !snaps.length) return null;
    const { a, b, k } = snapPair(now);
    const ra = a.run || run, rb = b.run || run;
    const scene = {
      ...rb,
      enemies: blendById(ra.enemies.map(Enemies.view), rb.enemies.map(Enemies.view), k),
      shots: blendById(ra.shots || [], rb.shots || [], k),
      bullets: blendById(ra.bullets || [], rb.bullets || [], k),
    };
    if (!(me && playing() && pr)) return scene;
    const smoothed = new Map(scene.enemies.map((v) => [v.id, v]));
    return {
      ...scene,
      enemies: pr.enemies.filter((e) => !e.dead).map((e) => {
        if (!Enemies.PREDICTED.has(e.type)) return smoothed.get(e.id) || Enemies.view(e);
        const v = Enemies.view(e), er = enemyErr.get(e.id);
        if (er) { v.x += er.x; v.y += er.y; }
        return v;
      }),
      shots: pr.shots, bullets: pr.bullets, acid: pr.acid, weather: pr.weather,
    };
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
    const solid = new Set((target && target.safePools) || []);
    for (let ty = 0; ty < level.height; ty++) {
      for (let tx = 0; tx < level.width; tx++) {
        const t = Physics.tileAt(level, tx, ty);
        if (t !== T.LAVA && t !== T.WATER && t !== T.ACID) continue;
        if (solid.has(`${tx},${ty}`)) { // Solidify: hardened, walkable by both
          ctx.fillStyle = t === T.LAVA ? '#5a3226' : '#2c4a66';
          ctx.fillRect(tx * TILE, ty * TILE, TILE, TILE / 2 + 3);
          ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(tx * TILE + 4, ty * TILE + 3); ctx.lineTo(tx * TILE + 12, ty * TILE + 9); ctx.lineTo(tx * TILE + 20, ty * TILE + 4); ctx.stroke();
          continue;
        }
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
    const ghost = s.run && s.run.ghost && s.run.ghost[role] > 0;
    ctx.globalAlpha = !t.connected ? 0.3 : dead ? 0.5 : blink ? 0.35 : fx && fx.cloakT > 0 ? 0.4 : (t.phase || ghost) ? 0.45 : 1;
    if (t.phase || ghost) {
      ctx.save(); ctx.globalAlpha = 0.9; ctx.strokeStyle = ghost ? '#ffd84a' : '#c9c0ff'; ctx.setLineDash([3, 3]); ctx.lineWidth = 2;
      ctx.strokeRect(p.x - 2, p.y - 2, w + 4, h + 4); ctx.restore();
    }
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
  const showMate = { fire: false, water: false }; // teammate's items: hidden until you tap their icon
  function renderBar(r) {
    const key = JSON.stringify([r.items, r.personal, r.equip, myRoles, showMate]);
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
    const order = ['fire', 'water'].sort((x, y) => myRoles.includes(y) - myRoles.includes(x)); // yours first
    for (const role of order) {
      // Your own items always show; a teammate's are behind their icon (tap to toggle).
      const mine = myRoles.includes(role);
      if (!mine) {
        const sep = document.createElement('span'); sep.className = 'sep'; add(sep);
        const t = document.createElement('button');
        t.type = 'button';
        t.className = `chip mate${showMate[role] ? ' open' : ''}`;
        const n = r.personal[role].length;
        t.innerHTML = `<span>${roleIcon(role)}</span><span class="who">${showMate[role] ? '▾' : '▸'}</span>${n ? `<span class="count">${n}</span>` : ''}`;
        t.setAttribute('aria-label', `${showMate[role] ? 'Hide' : 'Show'} ${role === 'fire' ? 'Fire' : 'Water'}'s items`);
        t.addEventListener('click', (e) => { e.stopPropagation(); showMate[role] = !showMate[role]; lastBar = ''; renderBar(run); });
        add(t);
        if (!showMate[role]) continue;
      }
      if (!r.personal[role].length) continue;
      if (mine) {
        const sep = document.createElement('span'); sep.className = 'sep'; add(sep);
        add(label(roleIcon(role)));
      }
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
        if (run.locked[role]) {
          if (!b.exclusive) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = `${roleIcon(role)} has an item that replaces all other actives.`; tip.querySelector('.actions').append(p); }
          continue;
        }
        for (const slot of run.secondSlot[role] ? [1, 2] : [1]) {
          const btn = document.createElement('button');
          const on = (slot === 2 ? run.equip2 : run.equip)[role] === item.uid;
          const where = slot === 2 ? ' (slot 2)' : run.secondSlot[role] ? ' (slot 1)' : '';
          btn.textContent = on ? `Equipped by ${roleIcon(role)}${where} ✓` : `Equip for ${roleIcon(role)}${where}`;
          btn.disabled = on;
          btn.addEventListener('click', () => { socket.emit('equip', { r: role, uid: item.uid, slot }); tip.hidden = true; });
          tip.querySelector('.actions').append(btn);
        }
      }
    }
    tip.hidden = false;
  }
  document.addEventListener('pointerdown', (e) => { if (!$('tip').hidden && !e.target.closest('#tip, .chip')) $('tip').hidden = true; });

  // ✦ use-item buttons above jump: slot 1, and slot 2 with Dual Wield. Each shows the
  // item equipped in it; tap to use, swipe left/right to switch to another active.
  const slotEquip = (slot) => (slot === 2 ? run.equip2 : run.equip);
  const useBtn = (slot) => $(slot === 2 ? 'use2' : 'use');
  function equippedItem(slot = 1) {
    if (!run || !myRole) return null;
    const uid = slotEquip(slot)[myRole];
    return run.items.concat(run.personal[myRole]).find((i) => i.uid === uid) || null;
  }
  function renderUse() {
    for (const slot of [1, 2]) {
      const btn = useBtn(slot);
      const it = equippedItem(slot);
      btn.hidden = mode !== 'challenge' || !myRole || (slot === 2 && !(run && run.secondSlot[myRole]));
      if (btn.hidden) continue;
      const many = !run.locked[myRole] && activeChoices(slot).length > 1;
      btn.innerHTML = (it ? Bonuses.BY_ID[it.id].icon : '✦') + (many ? '<span class="cyc l">‹</span><span class="cyc r">›</span>' : '');
      btn.classList.toggle('spent', !it || !it.ready || it.cool);
      btn.classList.toggle('on', !!(it && it.id === 'phase' && me && me.phase));
      btn.title = (it ? Bonuses.BY_ID[it.id].name : 'No item equipped: tap an item in the bar') + (many ? ' · swipe to switch' : '');
    }
  }
  function useItem(slot = 1) {
    const it = equippedItem(slot);
    if (!it) return flashStatus('No item equipped: tap a yellow item in the bar');
    if (it.cool) return;
    if (!it.ready) return flashStatus(`${Bonuses.BY_ID[it.id].name} recharges next room`);
    // predict instant effects so they feel immediate
    if (it.id === 'wings' && me) me.flyT = Bonuses.BY_ID.wings.duration;
    if (it.id === 'phase' && me) me.phase = !me.phase;
    socket.emit('use', { r: myRole, slot });
    navigator.vibrate?.(15);
  }
  // The active items this player can switch a slot to, in bar order (team, then their
  // own). Skips whatever is in the partner's slots or this player's other slot.
  function activeChoices(slot = 1) {
    if (!run || !myRole) return [];
    const other = myRole === 'fire' ? 'water' : 'fire';
    const taken = new Set([run.equip[other], run.equip2[other], slotEquip(slot === 2 ? 1 : 2)[myRole]]);
    const ok = (it) => Bonuses.BY_ID[it.id].color === 'yellow' && !it.spent && !Bonuses.BY_ID[it.id].exclusive && !taken.has(it.uid);
    return run.items.filter(ok).concat(run.personal[myRole].filter(ok));
  }
  function cycleItem(step, slot = 1) {
    if (run && run.locked[myRole]) return flashStatus('Phase replaces your other actives');
    const list = activeChoices(slot);
    if (!list.length) return flashStatus('No active items');
    const cur = list.findIndex((it) => it.uid === slotEquip(slot)[myRole]);
    const next = list[cur < 0 ? (step > 0 ? 0 : list.length - 1) : (cur + step + list.length) % list.length];
    if (next.uid === slotEquip(slot)[myRole]) return flashStatus(`${Bonuses.BY_ID[next.id].name} is your only choice`);
    socket.emit('equip', { r: myRole, uid: next.uid, slot });
    flashStatus(`✦${slot === 2 ? '2' : ''} ${Bonuses.BY_ID[next.id].name}`);
    navigator.vibrate?.(8);
  }
  const SWIPE = 28; // px
  for (const slot of [1, 2]) {
    const btn = useBtn(slot);
    let start = null;
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      btn.setPointerCapture?.(e.pointerId);
      start = { x: e.clientX, id: e.pointerId, swiped: false };
    });
    btn.addEventListener('pointermove', (e) => {
      if (!start || e.pointerId !== start.id || start.swiped) return;
      const dx = e.clientX - start.x;
      if (Math.abs(dx) >= SWIPE) { start.swiped = true; cycleItem(dx > 0 ? 1 : -1, slot); }
    });
    btn.addEventListener('pointerup', (e) => {
      if (!start || e.pointerId !== start.id) return;
      if (!start.swiped) useItem(slot);
      start = null;
    });
    btn.addEventListener('pointercancel', () => { start = null; });
  }
  addEventListener('keydown', (e) => {
    if (mode !== 'challenge' || e.repeat) return;
    if (e.code === 'KeyZ') cycleItem(-1);
    if (e.code === 'KeyC') cycleItem(1);
    if (e.code === 'KeyE' || e.code === 'ShiftLeft') useItem(1);
    if (e.code === 'KeyF') useItem(2);
  });

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
    // portrait + one device picking for both players: one column of cards, not 2 rows of 2
    view.classList.toggle('stack', m.step === 'personal' && myRoles.length > 1 && innerHeight > innerWidth);
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
    fitMap();
  }
  const HAND = { rock: '✊', paper: '✋', scissors: '✌️' };

  // Fit the drops screen vertically without scrolling. First widen the cards (their
  // text wraps onto fewer lines); only when every row of cards already fills the width
  // shrink everything, down to 45%.
  const CARD_MIN = 150;
  function fitMap() {
    const view = $('mapview');
    if (view.hidden) return;
    const fits = () => view.scrollHeight <= view.clientHeight + 1;
    const groups = [...view.querySelectorAll('.cards')];
    // widest a card can be in each row while the row stays on one line
    const maxW = (g, s) => {
      const n = view.classList.contains('stack') ? 1 : g.children.length || 1; // stacked: one card per line
      return Math.max(CARD_MIN * s, (g.clientWidth - 10 * s * (n - 1)) / n);
    };
    const setWidth = (w, s) => { for (const g of groups) g.style.setProperty('--cw', `${Math.min(w, maxW(g, s))}px`); };
    let s = 1;
    view.style.setProperty('--s', s);
    let w = CARD_MIN;
    setWidth(w, s);
    const widest = () => Math.max(CARD_MIN, ...groups.map((g) => maxW(g, s)));
    while (!fits() && w < widest()) { w += 20; setWidth(w, s); }
    while (!fits() && s > 0.45) {
      s = Math.round((s - 0.05) * 100) / 100;
      view.style.setProperty('--s', s);
      setWidth(widest(), s); // stay full width while shrinking
    }
  }
  addEventListener('resize', () => { lastMap = ''; if (run) renderMap(run, target && target.phase); });

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
      } else if (e.type === 'burrower') {
        const gx = e.x + e.w / 2, gy = e.y + e.h;
        if (e.phase === 'warning') { // cracks and dust where it will burst out
          ctx.strokeStyle = `rgba(255,200,120,${0.5 + 0.4 * Math.sin(now / 80)})`; ctx.lineWidth = 2;
          ctx.beginPath();
          for (let k = -2; k <= 2; k++) { ctx.moveTo(gx + k * 6, gy); ctx.lineTo(gx + k * 9, gy - 6 - Math.abs(k) * 2); }
          ctx.stroke();
          ctx.strokeStyle = 'rgba(255,120,80,0.35)';
          ctx.beginPath(); ctx.arc(gx, gy, 1.5 * TILE + 12, Math.PI, 0); ctx.stroke();
        } else if (e.phase === 'out') {
          ctx.fillStyle = '#8b5a2b';
          ctx.beginPath(); ctx.arc(gx, gy, e.w / 2 + 2, Math.PI, 0); ctx.fill();
          ctx.fillStyle = '#ffd1a8'; ctx.beginPath(); ctx.moveTo(gx - 4, gy - e.w / 2); ctx.lineTo(gx, gy - e.w / 2 - 7); ctx.lineTo(gx + 4, gy - e.w / 2); ctx.fill();
          ctx.fillStyle = '#fff'; ctx.fillRect(gx - 7, gy - 12, 3, 3); ctx.fillRect(gx + 4, gy - 12, 3, 3);
          ctx.strokeStyle = 'rgba(255,120,80,0.6)'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(gx, gy, 1.5 * TILE + 12, Math.PI, 0); ctx.stroke();
        }
      } else if (e.type === 'mimic') {
        // looks exactly like a box… except when it shakes
        const sx = e.shake ? Math.sin(now / 25) * 2 : 0;
        const x = e.x + sx, y = e.y, n = e.w;
        ctx.fillStyle = '#9a6a3a'; ctx.fillRect(x, y, n, n);
        ctx.strokeStyle = '#6b4626'; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, n - 2, n - 2);
        ctx.beginPath(); ctx.moveTo(x + 3, y + 3); ctx.lineTo(x + n - 3, y + n - 3); ctx.moveTo(x + n - 3, y + 3); ctx.lineTo(x + 3, y + n - 3); ctx.stroke();
        if (e.shake || r.keenEye) { ctx.fillStyle = '#ff3b3b'; ctx.fillRect(x + n / 2 - 5, y + n / 2 - 2, 3, 3); ctx.fillRect(x + n / 2 + 2, y + n / 2 - 2, 3, 3); }
      } else if (e.type === 'charger') {
        const tired = e.mode === 'tired';
        ctx.fillStyle = tired ? '#7a6a6a' : '#c0392b';
        ctx.fillRect(e.x, e.y + 4, e.w, e.h - 4);
        ctx.fillStyle = '#eee';
        const front = (e.dir || 1) > 0 ? e.x + e.w : e.x;
        ctx.beginPath(); ctx.moveTo(front, e.y + 6); ctx.lineTo(front + (e.dir || 1) * 7, e.y); ctx.lineTo(front, e.y + 11); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.fillRect(e.x + e.w / 2 + (e.dir || 1) * 4 - 1, e.y + 9, 3, 3);
        if (tired) { ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.font = '12px system-ui'; ctx.fillText('z z', e.x + e.w / 2, e.y - 4); }
        if (e.mode === 'charging') { ctx.fillStyle = 'rgba(255,255,255,0.4)'; for (let k = 1; k <= 3; k++) ctx.fillRect(e.x - (e.dir || 1) * k * 7 + e.w / 2, e.y + 8 + k * 3, 5, 2); }
      } else if (e.type === 'patrol') {
        const step = Math.sin(now / 90) * 2;
        ctx.fillStyle = '#9b4fd0';
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(e.x, e.y, e.w, e.h - 3, 6) : ctx.rect(e.x, e.y, e.w, e.h - 3);
        ctx.fill();
        ctx.fillRect(e.x + 3, e.y + e.h - 4 + step, 5, 4); ctx.fillRect(e.x + e.w - 8, e.y + e.h - 4 - step, 5, 4);
        ctx.fillStyle = '#fff'; ctx.fillRect(e.x + 5, e.y + 5, 3, 3); ctx.fillRect(e.x + e.w - 8, e.y + 5, 3, 3);
      } else if (e.type === 'bomber') {
        ctx.fillStyle = '#4b4566';
        ctx.beginPath();
        ctx.ellipse(e.x + e.w / 2, e.y + e.h / 2, e.w / 2, e.h / 2.6, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#8a86a8';
        const prop = Math.abs(Math.sin(now / 40)) * 10;
        ctx.fillRect(e.x + e.w / 2 - prop / 2, e.y - 2, prop, 2);
        ctx.fillStyle = '#ffb02e'; ctx.fillRect(e.x + e.w / 2 - 3, e.y + e.h - 4, 6, 4);
      } else if (e.type === 'shooter') {
        ctx.fillStyle = '#8a86a8'; ctx.fillRect(e.x, e.y, e.w, e.h);
        ctx.fillStyle = '#ff6a2b'; ctx.fillRect(e.x + e.w / 2 - 4, e.y + e.h - 4, 8, 8);
      }
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = '#ffb02e';
    for (const s of r.shots) {
      ctx.fillStyle = s.kind === 'bomb' ? '#2a2640' : '#ffb02e';
      ctx.beginPath(); ctx.arc(s.x + 5, s.y + 5, 5, 0, Math.PI * 2); ctx.fill();
      if (s.kind === 'bomb') { ctx.fillStyle = '#ff6a2b'; ctx.fillRect(s.x + 4, s.y - 2, 2, 3); }
    }
    ctx.fillStyle = '#7ff3ff';
    for (const b of r.bullets || []) ctx.fillRect(b.x, b.y, 8, 4);
    if (r.acid) {
      const burning = r.acid.burning > 0; // seconds left (it was a flag before)
      if (burning) { // every walkable surface glows green
        ctx.fillStyle = 'rgba(95, 211, 90, 0.75)';
        for (let ty = 1; ty < level.height; ty++) for (let tx = 0; tx < level.width; tx++) {
          if (Physics.isSolid(level, tx, ty) && !Physics.isSolid(level, tx, ty - 1)) ctx.fillRect(tx * TILE, ty * TILE - 3, TILE, 7);
        }
      }
      const n = Math.ceil(r.acid.countdown);
      // A jump keeps you up ~0.62 s and the burn lasts 0.1 s: be in the air for it.
      const text = burning ? 'ACID!' : r.acid.countdown > 0 && r.acid.countdown < 0.5 ? 'JUMP!' : n > 0 ? String(n) : '';
      if (text) {
        ctx.font = 'bold 72px system-ui';
        ctx.textAlign = 'center';
        ctx.fillStyle = burning ? '#5fd35a' : 'rgba(255,255,255,0.85)';
        ctx.fillText(text, level.pxWidth / 2, level.pxHeight / 2);
        if (n === 1 && !burning) { ctx.font = 'bold 24px system-ui'; ctx.fillText('jump!', level.pxWidth / 2, level.pxHeight / 2 + 34); }
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
    for (const [id, er] of enemyErr) {
      er.x *= decay; er.y *= decay;
      if (Math.abs(er.x) + Math.abs(er.y) < 0.05) enemyErr.delete(id);
    }
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
    const scene = enemyScene(now);
    if (scene) drawEnemies(scene, now);
    if (target.run && target.run.ghost) {
      for (const role of ['fire', 'water']) {
        const left = target.run.ghost[role];
        if (!(left > 0)) continue;
        const sp = level.spawns[role];
        ctx.strokeStyle = '#ffd84a'; ctx.lineWidth = 3; ctx.setLineDash([5, 4]);
        ctx.strokeRect(sp.x - 8, sp.y - 8, CHAR.width + 16, CHAR.height + 16); ctx.setLineDash([]);
        ctx.font = 'bold 30px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = '#ffd84a';
        ctx.fillText(`${role === 'fire' ? '🔥' : '💧'} back to start: ${left.toFixed(1)}`, level.pxWidth / 2, TILE * 2.4);
      }
    }
    if (target.run && !target.run.started && target.phase === 'playing') {
      ctx.font = 'bold 26px system-ui';
      ctx.textAlign = 'center';
      ctx.fillStyle = `rgba(255,255,255,${0.55 + 0.35 * Math.sin(now / 300)})`;
      ctx.fillText('Move to start', level.pxWidth / 2, TILE * 2.2);
      ctx.font = '15px system-ui';
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillText('enemies and the clock wait for you', level.pxWidth / 2, TILE * 3.1);
    }
    for (const role of ['fire', 'water']) {
      const pos = role === myRole && me && playing()
        ? { x: me.x + errX, y: me.y + errY }
        : role === myRole ? { x: target[role].x, y: target[role].y } : interpolated(role, now);
      drawChar(role, pos, role === myRole && me ? { ...target[role], vx: me.vx, dead: meDead, phase: me.phase } : target[role], target);
    }
    if (scene && scene.weather) drawWeather(scene.weather, now);
  }

  // Weather: always shows its sign (sun / clouds / bubbles), builds up over the 5 s
  // lead-in, then strikes.
  function drawWeather(w, now) {
    const W = level.pxWidth, H = level.pxHeight;
    const lead = w.state === 'lead' ? Math.min(1, w.t / w.dur) : 0;
    const strike = w.state === 'strike';
    const left = w.state === 'lead' ? Math.ceil(w.dur - w.t) : 0;
    ctx.save();
    if (w.kind === 'drought') {
      // the sun in the top right, growing fast through the lead-in
      const k = strike ? 1 : lead * lead;
      const rad = 16 + k * 120;
      const cx = W - TILE * 1.8, cy = TILE * 1.8;
      if (k > 0) { ctx.fillStyle = `rgba(255, 150, 40, ${0.28 * k})`; ctx.fillRect(0, 0, W, H); }
      ctx.strokeStyle = '#ffd84a'; ctx.lineWidth = 3;
      for (let i = 0; i < 10; i++) {
        const a = i / 10 * Math.PI * 2 + now / 1500;
        ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * rad * 1.15, cy + Math.sin(a) * rad * 1.15);
        ctx.lineTo(cx + Math.cos(a) * rad * 1.45, cy + Math.sin(a) * rad * 1.45); ctx.stroke();
      }
      ctx.fillStyle = '#ffcf3a'; ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.fill();
      if (strike) { ctx.fillStyle = 'rgba(255, 250, 220, 0.45)'; ctx.fillRect(0, 0, W, H); }
    } else if (w.kind === 'rain') {
      // a few clouds at the top; through the lead-in they spread and darken over the whole top
      const k = strike ? 1 : lead;
      if (k > 0) { ctx.fillStyle = `rgba(20, 24, 40, ${0.35 * k})`; ctx.fillRect(0, 0, W, H); }
      const n = Math.round(3 + k * 11);
      for (let i = 0; i < n; i++) {
        const x = ((i * 0.618) % 1) * W + Math.sin(now / 2000 + i) * 10;
        const y = TILE * (0.9 + (i % 3) * 0.35 + k * 0.4);
        const sz = TILE * (1 + k * 0.9 + (i % 2) * 0.3);
        const g = Math.round(200 - k * 120);
        ctx.fillStyle = `rgb(${g}, ${g}, ${g + 10})`;
        ctx.beginPath();
        ctx.arc(x, y, sz, 0, Math.PI * 2); ctx.arc(x + sz, y + sz * 0.2, sz * 0.8, 0, Math.PI * 2); ctx.arc(x - sz, y + sz * 0.25, sz * 0.7, 0, Math.PI * 2);
        ctx.fill();
      }
      if (strike) {
        ctx.strokeStyle = 'rgba(160, 200, 255, 0.7)'; ctx.lineWidth = 2;
        for (let i = 0; i < 120; i++) {
          const x = ((i * 0.381 + (now / 900) * 0.05) % 1) * W;
          const y = ((i * 0.737 + now / 500) % 1) * H;
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 4, y + 14); ctx.stroke();
        }
      }
    } else if (w.kind === 'flood') {
      // bubbles in the bottom right; through the lead-in they spread along the bottom
      const k = strike ? 1 : lead;
      const n = Math.round(4 + k * 26);
      ctx.fillStyle = 'rgba(95, 211, 90, 0.8)';
      for (let i = 0; i < n; i++) {
        const span = TILE * 3 + k * (W - TILE * 5);
        const x = W - TILE * 1.5 - ((i * 0.618) % 1) * span;
        const rise = ((now / (700 - k * 300) + i * 0.37) % 1);
        const y = H - TILE - rise * TILE * (1 + k);
        ctx.beginPath(); ctx.arc(x, y, 3 + (i % 3), 0, Math.PI * 2); ctx.fill();
      }
      if (strike && w.level < H - TILE) {
        ctx.fillStyle = 'rgba(80, 200, 70, 0.72)';
        ctx.beginPath(); ctx.moveTo(0, H);
        for (let x = 0; x <= W; x += 12) ctx.lineTo(x, w.level + Math.sin(x / 30 + now / 250) * 3);
        ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
      }
    }
    if (left > 0) { // the lead-in countdown and what to do
      const tip = { drought: '💧 Water: into a pool!', rain: '🔥 Fire: take cover!', flood: 'Get up high!' }[w.kind];
      ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = 'bold 22px system-ui'; ctx.fillText(`${tip} ${left}`, W / 2, TILE * 4.2);
    }
    ctx.restore();
  }
  requestAnimationFrame(frame);
})();
