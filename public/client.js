(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $('game');
  const ctx = canvas.getContext('2d');

  // ---- Room code: from ?room=, otherwise make one and put it in the URL ----
  const params = new URLSearchParams(location.search);
  let code = (params.get('room') || '').toUpperCase();
  if (!/^[A-Z0-9]{4,8}$/.test(code)) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    params.set('room', code);
    history.replaceState(null, '', `${location.pathname}?${params}`);
  }
  $('code').textContent = code;

  $('share').addEventListener('click', async () => {
    const url = location.href;
    try {
      if (navigator.share) await navigator.share({ title: 'Fire & Water', url });
      else { await navigator.clipboard.writeText(url); $('status').textContent = 'Link copied'; }
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

  // ---- Networking ----
  let level = null;  // parsed level (for drawing tiles)
  let CHAR = Physics.CHAR;
  let TILE = Physics.TILE;
  let myRole = null;
  let target = null; // latest server snapshot
  let shown = null;  // smoothed positions we draw

  const socket = io();
  socket.on('connect', () => socket.emit('join', code));
  socket.on('disconnect', () => { $('status').textContent = 'Reconnecting…'; });
  socket.on('error-msg', (msg) => { $('status').textContent = msg; });

  socket.on('joined', (msg) => {
    level = Physics.parseLevel(msg.level);
    CHAR = msg.char;
    TILE = msg.tile;
    myRole = msg.role;
    resizeCanvas();
    $('controls').hidden = !myRole;
    sentDir = 0;
    updateStatus();
  });

  socket.on('state', (s) => {
    target = s;
    if (!shown) shown = { fire: { x: s.fire.x, y: s.fire.y }, water: { x: s.water.x, y: s.water.y } };
    updateStatus();
  });

  function updateStatus() {
    if (!myRole) { $('status').textContent = 'Room full: watching'; return; }
    const other = myRole === 'fire' ? 'water' : 'fire';
    const waiting = target && !target[other].connected;
    $('status').textContent = `You are ${myRole === 'fire' ? '🔥 Fire' : '💧 Water'}${waiting ? ' · waiting for partner' : ''}`;
  }

  // ---- Input ----
  // D-pad: each touching finger picks a direction by which half it's on, and can
  // slide between ◀ and ▶ without lifting. The most recent finger wins.
  const dpad = $('dpad');
  const dpadKeys = [...dpad.querySelectorAll('.ctl')];
  const touchDirs = new Map(); // pointerId -> -1 | 1
  const keyDirs = new Set();   // keyboard, most recent last
  let sentDir = 0;

  function dirFromPointer(e) {
    const r = dpad.getBoundingClientRect();
    return e.clientX < r.left + r.width / 2 ? -1 : 1;
  }

  function currentDir() {
    if (touchDirs.size) return [...touchDirs.values()].pop();
    if (keyDirs.size) return [...keyDirs].pop();
    return 0;
  }

  function sendDir() {
    const dir = currentDir();
    for (const k of dpadKeys) k.classList.toggle('active', Number(k.dataset.dir) === dir && touchDirs.size > 0);
    if (dir !== sentDir) { sentDir = dir; socket.emit('input', dir); }
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
    socket.emit('jump');
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
    if (jumpKeys.has(e.code)) { e.preventDefault(); if (myRole) socket.emit('jump'); }
  });
  addEventListener('keyup', (e) => {
    const d = keyDir[e.code];
    if (d) { keyDirs.delete(d); sendDir(); }
  });
  addEventListener('blur', () => { keyDirs.clear(); touchDirs.clear(); sendDir(); });

  // ---- Rendering ----
  const COLORS = { fire: '#ff6a2b', water: '#2bb0ff' };
  let scale = 1;

  function resizeCanvas() {
    if (!level) return;
    scale = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = level.pxWidth * scale;
    canvas.height = level.pxHeight * scale;
  }
  addEventListener('resize', resizeCanvas);

  function drawLevel() {
    ctx.fillStyle = '#1e1b2e';
    ctx.fillRect(0, 0, level.pxWidth, level.pxHeight);
    for (let ty = 0; ty < level.height; ty++) {
      for (let tx = 0; tx < level.width; tx++) {
        if (!Physics.isSolid(level, tx, ty)) continue;
        const x = tx * TILE, y = ty * TILE;
        ctx.fillStyle = '#3a3552';
        ctx.fillRect(x, y, TILE, TILE);
        if (!Physics.isSolid(level, tx, ty - 1)) { // exposed top edge
          ctx.fillStyle = '#5b5480';
          ctx.fillRect(x, y, TILE, 4);
        }
      }
    }
  }

  function drawChar(role, p, t) {
    const { width: w, height: h } = CHAR;
    ctx.globalAlpha = t.connected ? 1 : 0.3;
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
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min((now - lastFrame) / 1000, 0.1);
    lastFrame = now;
    if (!level) return;

    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    drawLevel();
    if (!target || !shown) return;

    // Ease toward the server position to hide the 30 Hz steps.
    // (M2 replaces this with prediction for your own character.)
    const k = 1 - Math.exp(-dt * 25);
    for (const role of ['fire', 'water']) {
      shown[role].x += (target[role].x - shown[role].x) * k;
      shown[role].y += (target[role].y - shown[role].y) * k;
      drawChar(role, shown[role], target[role]);
    }
  }
  requestAnimationFrame(frame);
})();
