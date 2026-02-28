'use strict';

const socket = io();

const $ = (id) => document.getElementById(id);

const joinModal = $('joinModal');
const chooseModal = $('chooseModal');
const chooseButtons = $('chooseButtons');

const inpName = $('inpName');
const inpRoom = $('inpRoom');
const btnJoin = $('btnJoin');
const joinErr = $('joinErr');

const btnShare = $('btnShare');
const btnRestart = $('btnRestart');

const hudRound = $('hudRound');
const hudTime = $('hudTime');
const hudWord = $('hudWord');
const hudDrawer = $('hudDrawer');

const btnClear = $('btnClear');
const btnBuyTime = $('btnBuyTime');

const playersList = $('playersList');
const chatLog = $('chatLog');
const chatForm = $('chatForm');
const chatInput = $('chatInput');

const toast = $('toast');

const canvas = $('canvas');
const ctx = canvas.getContext('2d', { alpha: false });

let me = { id: null, roomId: null, name: null };
let state = null;

let isDrawer = false;
let drawing = false;
let lastPt = null;

function showToast(text, ms = 2200) {
  toast.textContent = text;
  toast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add('hidden'), ms);
}

function safeRoomFromUrl() {
  // room via hash: #family1 or query ?room=family1
  const hash = (location.hash || '').replace('#', '').trim();
  const q = new URLSearchParams(location.search);
  const qroom = (q.get('room') || '').trim();
  const rid = (hash || qroom || '').toLowerCase();
  return rid || '';
}

function setRoomToUrl(roomId) {
  const rid = String(roomId || '').trim();
  if (!rid) return;
  if (location.hash.replace('#', '') !== rid) {
    location.hash = rid;
  }
}

function openJoinModal(prefRoom) {
  joinModal.classList.remove('hidden');
  chooseModal.classList.add('hidden');

  const r = prefRoom || safeRoomFromUrl();
  if (r) inpRoom.value = r;
  if (!inpName.value) inpName.focus();
}

function closeJoinModal() {
  joinModal.classList.add('hidden');
}

function openChoose(options) {
  chooseButtons.innerHTML = '';
  for (const w of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chooseBtn';
    b.textContent = w;
    b.addEventListener('click', () => {
      socket.emit('word:choose', { word: w });
      chooseModal.classList.add('hidden');
    });
    chooseButtons.appendChild(b);
  }
  chooseModal.classList.remove('hidden');
}

function closeChoose() {
  chooseModal.classList.add('hidden');
}

function appendChat({ type, name, text }) {
  const wrap = document.createElement('div');
  wrap.className = 'chatMsg' + (type === 'system' ? ' system' : '');
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = name;
  const txt = document.createElement('div');
  txt.className = 'txt';
  txt.textContent = text;

  wrap.appendChild(who);
  wrap.appendChild(txt);
  chatLog.appendChild(wrap);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function renderPlayers(players) {
  playersList.innerHTML = '';
  players.forEach((p, idx) => {
    const row = document.createElement('div');
    row.className = 'playerRow';

    const left = document.createElement('div');
    left.className = 'playerLeft';

    const badge = document.createElement('div');
    badge.className = 'badge';
    badge.textContent = String(idx + 1);

    const info = document.createElement('div');
    info.style.minWidth = '0';

    const name = document.createElement('div');
    name.className = 'playerName';
    name.textContent = p.name;

    const meta = document.createElement('div');
    meta.className = 'playerMeta';
    const tags = [];
    if (p.isHost) tags.push('מארח');
    if (p.isDrawer) tags.push('מצייר/ת');
    meta.textContent = tags.length ? tags.join(' | ') : 'שחקן';

    info.appendChild(name);
    info.appendChild(meta);

    left.appendChild(badge);
    left.appendChild(info);

    const score = document.createElement('div');
    score.className = 'playerScore';
    score.textContent = String(p.score);

    row.appendChild(left);
    row.appendChild(score);
    playersList.appendChild(row);
  });
}

function updateHud() {
  if (!state) return;

  hudRound.textContent = String(state.round || 0);
  hudTime.textContent = String(state.timeLeft ?? 0);

  const drawer = state.players.find(p => p.id === state.drawerId);
  if (state.phase === 'lobby') {
    hudDrawer.textContent = 'ממתין לשחקנים...';
    hudWord.textContent = '-';
  } else if (state.phase === 'choose') {
    hudDrawer.textContent = drawer ? `מצייר/ת: ${drawer.name} | בחירת מילה...` : 'בחירת מילה...';
    hudWord.textContent = '-';
  } else if (state.phase === 'draw') {
    hudDrawer.textContent = drawer ? `מצייר/ת: ${drawer.name}` : 'מצייר/ת: -';
    // hudWord updated by word:set
  } else if (state.phase === 'reveal') {
    hudDrawer.textContent = 'מגלים את המילה...';
  }

  btnRestart.disabled = !(me.id && state.hostId === me.id);
  btnClear.disabled = !(isDrawer && state.phase === 'draw');
  btnBuyTime.disabled = !(isDrawer && state.phase === 'draw');

  // Update buy time label with costs
  const ex = state.extra;
  if (ex) {
    btnBuyTime.textContent = `הוסף זמן (+${ex.addSeconds})`;
  }
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);

  const w = Math.max(1, Math.floor(rect.width * dpr));
  const h = Math.max(1, Math.floor(rect.height * dpr));

  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;

    ctx.fillStyle = '#0a0d14';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, Math.floor(4 * dpr));
    ctx.strokeStyle = '#ffffff';
  }
}

window.addEventListener('resize', () => {
  resizeCanvas();
});

function toCanvasPoint(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const x = (clientX - rect.left) * dpr;
  const y = (clientY - rect.top) * dpr;
  return { x, y };
}

function drawLine(a, b) {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function clearBoardLocal() {
  ctx.fillStyle = '#0a0d14';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function setDrawingEnabled(enabled) {
  isDrawer = enabled;
  btnClear.disabled = !(enabled && state && state.phase === 'draw');
  btnBuyTime.disabled = !(enabled && state && state.phase === 'draw');
}

function preventScrollWhileDrawing(e) {
  // Critical for iOS/Safari
  if (isDrawer && state && state.phase === 'draw') {
    e.preventDefault();
  }
}

canvas.addEventListener('touchstart', preventScrollWhileDrawing, { passive: false });
canvas.addEventListener('touchmove', preventScrollWhileDrawing, { passive: false });

function onPointerDown(e) {
  if (!isDrawer || !state || state.phase !== 'draw') return;

  drawing = true;
  const p = toCanvasPoint(e.clientX, e.clientY);
  lastPt = p;

  socket.emit('draw:stroke', { t: 'start', p });
}

function onPointerMove(e) {
  if (!drawing || !isDrawer || !state || state.phase !== 'draw') return;

  const p = toCanvasPoint(e.clientX, e.clientY);
  if (lastPt) drawLine(lastPt, p);
  socket.emit('draw:stroke', { t: 'move', p });
  lastPt = p;
}

function onPointerUp() {
  if (!drawing) return;
  drawing = false;
  lastPt = null;
  if (isDrawer) socket.emit('draw:stroke', { t: 'end' });
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  onPointerDown(e);
});

canvas.addEventListener('pointermove', (e) => {
  onPointerMove(e);
});

canvas.addEventListener('pointerup', () => onPointerUp());
canvas.addEventListener('pointercancel', () => onPointerUp());

// Receive drawing from server (drawer broadcasts)
socket.on('draw:stroke', (payload) => {
  if (!payload) return;
  if (payload.t === 'start') {
    lastPt = payload.p || null;
  } else if (payload.t === 'move') {
    const p = payload.p;
    if (lastPt && p) drawLine(lastPt, p);
    lastPt = p;
  } else if (payload.t === 'end') {
    lastPt = null;
  }
});

socket.on('draw:clear', () => {
  clearBoardLocal();
});

btnClear.addEventListener('click', () => {
  if (!isDrawer) return;
  socket.emit('draw:clear');
});

btnBuyTime.addEventListener('click', () => {
  socket.emit('time:buy');
});

btnShare.addEventListener('click', async () => {
  const rid = me.roomId || safeRoomFromUrl();
  if (!rid) {
    showToast('אין קוד חדר לשיתוף.');
    return;
  }
  const url = `${location.origin}${location.pathname}#${rid}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Doodlit!', text: 'לינק למשחק Doodlit!', url });
    } else {
      await navigator.clipboard.writeText(url);
      showToast('הלינק הועתק.');
    }
  } catch {
    try {
      await navigator.clipboard.writeText(url);
      showToast('הלינק הועתק.');
    } catch {
      showToast('לא הצלחתי להעתיק. תעתיק ידנית מהכתובת.');
    }
  }
});

btnRestart.addEventListener('click', () => {
  socket.emit('game:restart');
});

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const t = chatInput.value.trim();
  if (!t) return;
  socket.emit('chat:msg', { text: t });
  chatInput.value = '';
});

// Word flow
socket.on('word:options', ({ options }) => {
  if (!Array.isArray(options)) return;
  openChoose(options);
});

socket.on('word:set', ({ word, masked, isDrawer: drawerFlag }) => {
  setDrawingEnabled(!!drawerFlag);

  if (drawerFlag && word) {
    hudWord.textContent = word; // drawer sees full
  } else {
    hudWord.textContent = masked || '';
  }

  if (!drawerFlag) closeChoose();
});

socket.on('word:reveal', ({ word }) => {
  if (word) hudWord.textContent = word;
  closeChoose();
});

// Room state
socket.on('room:state', (s) => {
  state = s;
  me.id = socket.id;

  // determine if drawer
  isDrawer = !!(state && state.drawerId === me.id);
  renderPlayers(state.players || []);
  updateHud();
});

socket.on('chat:msg', (m) => {
  appendChat(m);
});

socket.on('error:msg', ({ text }) => {
  showToast(text || 'שגיאה');
});

// Join
btnJoin.addEventListener('click', () => {
  joinErr.classList.add('hidden');
  const name = inpName.value.trim();
  const roomId = inpRoom.value.trim().toLowerCase();

  if (!name) {
    joinErr.textContent = 'צריך למלא שם.';
    joinErr.classList.remove('hidden');
    return;
  }
  if (!roomId) {
    joinErr.textContent = 'צריך למלא קוד חדר.';
    joinErr.classList.remove('hidden');
    return;
  }

  me.name = name;
  me.roomId = roomId;
  setRoomToUrl(roomId);

  socket.emit('room:join', { roomId, name });
  closeJoinModal();

  showToast('התחברת לחדר.');
});

// Initial setup
(function init() {
  // prevent double-tap zoom behaviors on iOS in some cases
  let lastTouchEnd = 0;
  document.addEventListener('touchend', function (event) {
    const now = Date.now();
    if (now - lastTouchEnd <= 300) {
      event.preventDefault();
    }
    lastTouchEnd = now;
  }, { passive: false });

  resizeCanvas();

  const rid = safeRoomFromUrl();
  if (rid) inpRoom.value = rid;

  openJoinModal(rid);
})();
