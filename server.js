'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, methods: ['GET', 'POST'] } });

const PORT = process.env.PORT || 3000;

// Static
app.use(express.static(path.join(__dirname, 'public')));

// ---- Config ----
const MAX_PLAYERS_PER_ROOM = 10;
const CHOOSE_WORD_SECONDS = 15;
const ROUND_SECONDS = 60;
const WORD_OPTIONS = 3;

// Extra time feature
const EXTRA_SECONDS_PER_PURCHASE = 10;
const EXTRA_TIME_COST_POINTS = 30; // add +10s costs 30 points
const MAX_EXTRA_PURCHASES_PER_ROUND = 3;

// Scoring
const BASE_GUESS_POINTS = 100;
const DRAWER_POINTS_PER_GUESS = 30;

// ---- Words loading ----
function loadWordsHebrew() {
  const p = path.join(__dirname, 'public', 'words-he.json');
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .map(w => String(w || '').trim())
      .filter(w => w.length >= 2 && w.length <= 32);
  } catch (e) {
    return [];
  }
}
let WORDS = loadWordsHebrew();
if (WORDS.length < 50) {
  WORDS = ['חתול', 'כלב', 'בית', 'עץ', 'ים', 'שמש', 'מחשב', 'טלפון', 'אופניים', 'כדור', 'ספר', 'פרח'];
}

function pickRandomWords(n) {
  const out = [];
  const used = new Set();
  while (out.length < n && used.size < WORDS.length) {
    const idx = Math.floor(Math.random() * WORDS.length);
    if (used.has(idx)) continue;
    used.add(idx);
    out.push(WORDS[idx]);
  }
  while (out.length < n) out.push(WORDS[Math.floor(Math.random() * WORDS.length)]);
  return out;
}

function normalizeGuess(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '') // keep letters/numbers/spaces
    .replace(/\s+/g, ' ');
}

function roomIdFromInput(input) {
  const safe = String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
  if (!safe) return null;
  return safe.slice(0, 32);
}

// ---- Room state ----
const rooms = new Map();
/*
room = {
  id,
  createdAt,
  players: Map(socketId -> player),
  hostId,
  phase: 'lobby'|'choose'|'draw'|'reveal',
  drawerId,
  round: number,
  word: string|null,
  wordMasked: string,
  wordOptions: string[],
  guessed: Set(socketId),
  timers: { choose: Timeout|null, tick: Timeout|null },
  timeLeft: number,
  extraPurchases: number
}
player = { id, name, score, connectedAt, isHost }
*/

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      createdAt: Date.now(),
      players: new Map(),
      hostId: null,
      phase: 'lobby',
      drawerId: null,
      round: 0,
      word: null,
      wordMasked: '',
      wordOptions: [],
      guessed: new Set(),
      timers: { choose: null, tick: null },
      timeLeft: 0,
      extraPurchases: 0
    });
  }
  return rooms.get(roomId);
}

function getPublicRoomState(room) {
  const players = Array.from(room.players.values()).map(p => ({
    id: p.id,
    name: p.name,
    score: p.score,
    isHost: p.id === room.hostId,
    isDrawer: p.id === room.drawerId
  }));
  players.sort((a, b) => b.score - a.score);

  return {
    id: room.id,
    phase: room.phase,
    round: room.round,
    hostId: room.hostId,
    drawerId: room.drawerId,
    players,
    timeLeft: room.timeLeft,
    chooseWordSeconds: CHOOSE_WORD_SECONDS,
    roundSeconds: ROUND_SECONDS,
    extra: {
      costPoints: EXTRA_TIME_COST_POINTS,
      addSeconds: EXTRA_SECONDS_PER_PURCHASE,
      maxPerRound: MAX_EXTRA_PURCHASES_PER_ROUND,
      usedThisRound: room.extraPurchases
    }
  };
}

function emitRoom(room) {
  io.to(room.id).emit('room:state', getPublicRoomState(room));
}

function systemMessage(room, text) {
  io.to(room.id).emit('chat:msg', {
    type: 'system',
    name: 'מערכת',
    text,
    ts: Date.now()
  });
}

function maskWord(word) {
  // keep spaces, mask letters
  return word.split('').map(ch => (ch === ' ' ? ' ' : '_')).join('');
}

function clearTimers(room) {
  if (room.timers.choose) clearTimeout(room.timers.choose);
  if (room.timers.tick) clearInterval(room.timers.tick);
  room.timers.choose = null;
  room.timers.tick = null;
}

function nextDrawer(room) {
  const ids = Array.from(room.players.keys());
  if (ids.length === 0) return null;

  // rotate drawer
  if (!room.drawerId) return ids[0];
  const idx = ids.indexOf(room.drawerId);
  return ids[(idx + 1) % ids.length];
}

function startChoosePhase(room) {
  clearTimers(room);

  if (room.players.size < 2) {
    room.phase = 'lobby';
    room.drawerId = null;
    room.word = null;
    room.wordOptions = [];
    room.wordMasked = '';
    room.timeLeft = 0;
    room.extraPurchases = 0;
    systemMessage(room, 'צריך לפחות 2 שחקנים כדי להתחיל.');
    emitRoom(room);
    return;
  }

  room.phase = 'choose';
  room.round += 1;
  room.guessed = new Set();
  room.drawerId = nextDrawer(room);
  room.word = null;
  room.wordMasked = '';
  room.wordOptions = pickRandomWords(WORD_OPTIONS);
  room.timeLeft = CHOOSE_WORD_SECONDS;
  room.extraPurchases = 0;

  systemMessage(room, `סבב ${room.round}: ${getPlayerName(room, room.drawerId)} מצייר/ת. בוחר/ת מילה.`);
  emitRoom(room);

  // Send options only to drawer
  io.to(room.drawerId).emit('word:options', {
    options: room.wordOptions,
    seconds: CHOOSE_WORD_SECONDS
  });

  room.timers.choose = setTimeout(() => {
    // auto-pick if not chosen
    const w = room.wordOptions[Math.floor(Math.random() * room.wordOptions.length)];
    startDrawPhase(room, w);
  }, CHOOSE_WORD_SECONDS * 1000);
}

function startDrawPhase(room, chosenWord) {
  clearTimers(room);

  const w = String(chosenWord || '').trim();
  room.word = w || room.wordOptions[0] || pickRandomWords(1)[0];
  room.wordMasked = maskWord(room.word);
  room.phase = 'draw';
  room.timeLeft = ROUND_SECONDS;
  room.extraPurchases = 0;
  room.guessed = new Set();

  // Tell drawer the word, others masked
  io.to(room.drawerId).emit('word:set', { word: room.word, masked: room.wordMasked, isDrawer: true });
  io.to(room.id).except(room.drawerId).emit('word:set', { word: null, masked: room.wordMasked, isDrawer: false });

  // Clear canvas for everyone
  io.to(room.id).emit('draw:clear');

  systemMessage(room, 'הסבב התחיל. תנסו לנחש בצ׳אט.');
  emitRoom(room);

  room.timers.tick = setInterval(() => {
    room.timeLeft -= 1;
    if (room.timeLeft <= 0) {
      endRound(room);
      return;
    }
    // If everyone guessed (except drawer)
    const guessersNeeded = Math.max(0, room.players.size - 1);
    if (room.guessed.size >= guessersNeeded) {
      endRound(room);
      return;
    }
    emitRoom(room);
  }, 1000);
}

function endRound(room) {
  clearTimers(room);
  room.phase = 'reveal';
  systemMessage(room, `הזמן נגמר. המילה הייתה: ${room.word}`);
  io.to(room.id).emit('word:reveal', { word: room.word });

  emitRoom(room);

  // short reveal then next
  setTimeout(() => {
    startChoosePhase(room);
  }, 3000);
}

function getPlayerName(room, socketId) {
  const p = room.players.get(socketId);
  return p ? p.name : 'שחקן';
}

function tryStartIfAuto(room) {
  // auto-start if host exists and at least 2 players, and still in lobby
  if (room.phase === 'lobby' && room.players.size >= 2) {
    startChoosePhase(room);
  }
}

// ---- Socket ----
io.on('connection', (socket) => {
  socket.on('room:join', ({ roomId, name }) => {
    const rid = roomIdFromInput(roomId);
    const playerName = String(name || '').trim().slice(0, 18);

    if (!rid) {
      socket.emit('error:msg', { text: 'חסר מזהה חדר.' });
      return;
    }
    if (!playerName) {
      socket.emit('error:msg', { text: 'צריך שם.' });
      return;
    }

    const room = getOrCreateRoom(rid);

    // capacity
    if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
      socket.emit('error:msg', { text: 'החדר מלא (10 שחקנים).' });
      return;
    }

    socket.join(rid);
    socket.data.roomId = rid;

    const player = {
      id: socket.id,
      name: playerName,
      score: 0,
      connectedAt: Date.now(),
      isHost: false
    };
    room.players.set(socket.id, player);

    if (!room.hostId) {
      room.hostId = socket.id;
      player.isHost = true;
    }

    systemMessage(room, `${playerName} הצטרף/ה לחדר.`);
    emitRoom(room);

    // Send current word state to joining player
    if (room.phase === 'draw') {
      if (socket.id === room.drawerId) {
        socket.emit('word:set', { word: room.word, masked: room.wordMasked, isDrawer: true });
      } else {
        socket.emit('word:set', { word: null, masked: room.wordMasked, isDrawer: false });
      }
    } else if (room.phase === 'reveal') {
      socket.emit('word:reveal', { word: room.word });
    } else {
      socket.emit('word:set', { word: null, masked: '', isDrawer: false });
    }

    // Auto-start
    tryStartIfAuto(room);
  });

  socket.on('room:leave', () => {
    leaveRoom(socket);
  });

  socket.on('disconnect', () => {
    leaveRoom(socket, true);
  });

  socket.on('word:choose', ({ word }) => {
    const rid = socket.data.roomId;
    if (!rid) return;
    const room = rooms.get(rid);
    if (!room) return;

    if (room.phase !== 'choose') return;
    if (socket.id !== room.drawerId) return;

    const chosen = String(word || '').trim();
    if (!room.wordOptions.includes(chosen)) return;

    startDrawPhase(room, chosen);
  });

  socket.on('draw:stroke', (payload) => {
    const rid = socket.data.roomId;
    if (!rid) return;
    const room = rooms.get(rid);
    if (!room) return;
    if (room.phase !== 'draw') return;
    if (socket.id !== room.drawerId) return;

    // broadcast to others
    socket.to(rid).emit('draw:stroke', payload);
  });

  socket.on('draw:clear', () => {
    const rid = socket.data.roomId;
    if (!rid) return;
    const room = rooms.get(rid);
    if (!room) return;
    if (room.phase !== 'draw') return;
    if (socket.id !== room.drawerId) return;

    io.to(rid).emit('draw:clear');
  });

  socket.on('chat:msg', ({ text }) => {
    const rid = socket.data.roomId;
    if (!rid) return;
    const room = rooms.get(rid);
    if (!room) return;

    const player = room.players.get(socket.id);
    if (!player) return;

    const msg = String(text || '').trim().slice(0, 140);
    if (!msg) return;

    // Check guess
    if (room.phase === 'draw' && socket.id !== room.drawerId && room.word) {
      const norm = normalizeGuess(msg);
      const target = normalizeGuess(room.word);

      if (norm && target && norm === target) {
        if (!room.guessed.has(socket.id)) {
          room.guessed.add(socket.id);

          // points based on time left
          const timeFactor = Math.max(0.2, room.timeLeft / ROUND_SECONDS); // 0.2..1
          const gained = Math.round(BASE_GUESS_POINTS * timeFactor);

          player.score += gained;

          const drawer = room.players.get(room.drawerId);
          if (drawer) drawer.score += DRAWER_POINTS_PER_GUESS;

          io.to(room.id).emit('chat:msg', {
            type: 'system',
            name: 'מערכת',
            text: `${player.name} ניחש/ה נכון (+${gained})`,
            ts: Date.now()
          });

          emitRoom(room);
          return; // do not show the exact guess text to avoid spoilers
        }
      }
    }

    // Normal chat
    io.to(room.id).emit('chat:msg', {
      type: 'chat',
      name: player.name,
      text: msg,
      ts: Date.now()
    });
  });

  socket.on('time:buy', () => {
    const rid = socket.data.roomId;
    if (!rid) return;
    const room = rooms.get(rid);
    if (!room) return;

    if (room.phase !== 'draw') return;

    const player = room.players.get(socket.id);
    if (!player) return;

    if (room.extraPurchases >= MAX_EXTRA_PURCHASES_PER_ROUND) {
      socket.emit('error:msg', { text: 'כבר הוספתם מקסימום זמן בסבב הזה.' });
      return;
    }

    if (player.score < EXTRA_TIME_COST_POINTS) {
      socket.emit('error:msg', { text: 'אין לך מספיק נקודות כדי להוסיף זמן.' });
      return;
    }

    // allow only drawer to buy time (simple and controlled)
    if (socket.id !== room.drawerId) {
      socket.emit('error:msg', { text: 'רק המצייר/ת יכול/ה להוסיף זמן.' });
      return;
    }

    player.score -= EXTRA_TIME_COST_POINTS;
    room.timeLeft += EXTRA_SECONDS_PER_PURCHASE;
    room.extraPurchases += 1;

    systemMessage(room, `הוספו ${EXTRA_SECONDS_PER_PURCHASE} שניות (עלות: ${EXTRA_TIME_COST_POINTS} נקודות).`);
    emitRoom(room);
  });

  socket.on('game:restart', () => {
    const rid = socket.data.roomId;
    if (!rid) return;
    const room = rooms.get(rid);
    if (!room) return;

    // only host
    if (socket.id !== room.hostId) return;

    // reset
    clearTimers(room);
    room.phase = 'lobby';
    room.drawerId = null;
    room.round = 0;
    room.word = null;
    room.wordMasked = '';
    room.wordOptions = [];
    room.guessed = new Set();
    room.timeLeft = 0;
    room.extraPurchases = 0;

    // scores reset
    for (const p of room.players.values()) p.score = 0;

    io.to(room.id).emit('draw:clear');
    systemMessage(room, 'המשחק אופס.');
    emitRoom(room);

    tryStartIfAuto(room);
  });
});

function leaveRoom(socket, disconnected = false) {
  const rid = socket.data.roomId;
  if (!rid) return;
  const room = rooms.get(rid);
  if (!room) return;

  const player = room.players.get(socket.id);
  if (!player) return;

  room.players.delete(socket.id);

  if (!disconnected) socket.leave(rid);

  systemMessage(room, `${player.name} יצא/ה מהחדר.`);

  // host reassignment
  if (room.hostId === socket.id) {
    const next = room.players.keys().next().value || null;
    room.hostId = next;
    if (next) systemMessage(room, `${getPlayerName(room, next)} הוא/היא המארח/ת עכשיו.`);
  }

  // drawer left
  if (room.drawerId === socket.id) {
    if (room.phase === 'choose' || room.phase === 'draw') {
      systemMessage(room, 'המצייר/ת יצא/ה. עוברים למצייר/ת הבא/ה.');
      startChoosePhase(room);
      return;
    }
  }

  // if room empty, delete
  if (room.players.size === 0) {
    clearTimers(room);
    rooms.delete(rid);
    return;
  }

  // if not enough players, go lobby
  if (room.players.size < 2 && room.phase !== 'lobby') {
    clearTimers(room);
    room.phase = 'lobby';
    room.drawerId = null;
    room.word = null;
    room.wordMasked = '';
    room.wordOptions = [];
    room.timeLeft = 0;
    room.extraPurchases = 0;
    io.to(room.id).emit('draw:clear');
    systemMessage(room, 'אין מספיק שחקנים, חזרנו ללובי.');
  }

  emitRoom(room);
}

server.listen(PORT, () => {
  console.log(`Doodlit listening on :${PORT}`);
});
