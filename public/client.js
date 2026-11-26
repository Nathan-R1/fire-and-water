(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $('game');
  const ctx = canvas.getContext('2d');

  // Room code from ?room=, otherwise make one and put it in the URL to share.
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

  let world = { width: 960, height: 540, floorY: 460 };
  let player = { width: 40, height: 60 };
  let myRole = null;
  let target = null;   // latest server snapshot
  let shown = null;    // smoothed positions we draw

  const socket = io();
  socket.on('connect', () => socket.emit('join', code));
  socket.on('disconnect', () => { $('status').textContent = 'Reconnecting…'; });
  socket.on('error-msg', (msg) => { $('status').textContent = msg; });

  socket.on('joined', (msg) => {
    world = msg.world;
    player = msg.player;
    myRole = msg.role;
    canvas.width = world.width;
    canvas.height = world.height;
    $('controls').hidden = !myRole;
    updateStatus();
  });

  socket.on('state', (s) => {
    target = s;
    if (!shown) shown = JSON.parse(JSON.stringify(s));
    updateStatus();
  });

  function updateStatus() {
    if (!myRole) { $('status').textContent = 'Room full: watching'; return; }
    const other = myRole === 'fire' ? 'water' : 'fire';
    const waiting = target && !target[other].connected;
    $('status').textContent = `You are ${myRole === 'fire' ? '🔥 Fire' : '💧 Water'}${waiting ? ' · waiting for partner' : ''}`;
  }

  // ---- Input: hold-to-move buttons (touch + mouse via pointer events) ----
  const held = new Set();
  let sentDir = 0;
  function sendDir() {
    // Most recently pressed direction wins if both are held.
    const dir = held.size ? [...held].pop() : 0;
    if (dir !== sentDir) { sentDir = dir; socket.emit('input', dir); }
  }

  for (const btn of document.querySelectorAll('.ctl')) {
    const dir = Number(btn.dataset.dir);
    const release = () => { held.delete(dir); btn.classList.remove('active'); sendDir(); };
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      btn.setPointerCapture(e.pointerId);
      held.delete(dir); held.add(dir);
      btn.classList.add('active');
      sendDir();
    });
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('lostpointercapture', release);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // Keyboard for desktop testing
  const keyDir = { ArrowLeft: -1, KeyA: -1, ArrowRight: 1, KeyD: 1 };
  addEventListener('keydown', (e) => {
    const d = keyDir[e.code];
    if (d && !e.repeat) { held.delete(d); held.add(d); sendDir(); }
  });
  addEventListener('keyup', (e) => {
    const d = keyDir[e.code];
    if (d) { held.delete(d); sendDir(); }
  });
  addEventListener('blur', () => { held.clear(); sendDir(); });

  // ---- Render loop ----
  const COLORS = { fire: '#ff6a2b', water: '#2bb0ff' };

  function draw() {
    requestAnimationFrame(draw);
    ctx.fillStyle = '#1e1b2e';
    ctx.fillRect(0, 0, world.width, world.height);
    ctx.fillStyle = '#3a3552';
    ctx.fillRect(0, world.floorY, world.width, world.height - world.floorY);

    if (!target || !shown) return;
    for (const role of ['fire', 'water']) {
      // Ease toward the server position to hide 30 Hz steps.
      shown[role].x += (target[role].x - shown[role].x) * 0.35;
      const p = shown[role];
      const t = target[role];
      ctx.globalAlpha = t.connected ? 1 : 0.3;
      ctx.fillStyle = COLORS[role];
      ctx.fillRect(p.x, t.y, player.width, player.height);
      if (role === myRole) {
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.moveTo(p.x + player.width / 2 - 8, t.y - 18);
        ctx.lineTo(p.x + player.width / 2 + 8, t.y - 18);
        ctx.lineTo(p.x + player.width / 2, t.y - 8);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }
  draw();
})();
