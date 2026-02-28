'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// -----------------------
// Config
// -----------------------
const MAX_PLAYERS = 10;

const CHOOSE_WORD_SECONDS_DEFAULT = 15;
const DRAW_SECONDS_DEFAULT = 60;

const WORD_OPTIONS_COUNT = 3;

// Time extension: trade points for extra seconds
const EXTEND_SECONDS = 15;
const EXTEND_COST_POINTS = 80;

// Rounds: how many drawings per game
const TOTAL_TURNS_DEFAULT = 10; // למשל: 10 תורות סך הכל (אפשר לשנות)

// -----------------------
// Words (Hebrew) loader
// -----------------------
function loadWordsHebrew() {
  try {
    const p = path.join(__dirname, 'public', 'words-he.json');
    const raw = fs.readFileSync(p, 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error('words-he.json must be an array');
    const cleaned = arr
      .map(x => (typeof x === 'string' ? x.trim() : ''))
      .filter(Boolean);

    if (cleaned.length < 50) {
      console.log(`[words] loaded ${cleaned.length}, warning: low count`);
    } else {
      console.log(`[words] loaded ${cleaned.length}`);
    }
    return cleaned;
  } catch (e) {
    console.log('[words] failed to load public/words-he.json:', e.message);
    return ['חתול', 'כלב', 'בית', 'עץ', 'כדור', 'טלפון', 'מחשב', 'ים', 'אופניים'];
  }
}

let WORDS_HE = loadWordsHebrew();

// Optional endpoint to verify words loaded
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    wordsCount: WORDS_HE.length,
    players: Object.keys(state.players).length,
    phase: state.phase
  });
});

// -----------------------
// Game State (single room)
// -----------------------
const state = {
  phase: 'lobby', // lobby | choosing | drawing | reveal
  players: {}, // socketId -> {id, name, score, isConnected, lastActive}
  order: [], // socketIds in turn order
  turnIndex: -1, // index in order for current drawer
  turnNumber: 0, // how many turns completed
  totalTurns: TOTAL_TURNS_DEFAULT,

  drawerId: null,
  word: null,
  maskedWord: null,
  wordOptions: [],

  chooseSeconds: CHOOSE_WORD_SECONDS_DEFAULT,
  drawSeconds: DRAW_SECONDS_DEFAULT,

  chooseEndsAt: null,
  drawEndsAt: null,

  timer: null, // setInterval handle
  guessedThisTurn: new Set(), // socketIds
  chatLocked: false
};

function nowMs() { return Date.now(); }

function clampName(name) {
  const s = String(name || '').trim();
  if (!s) return 'שחקן';
  return s.slice(0, 18);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickNWords(n) {
  const out = [];
  const used = new Set();
  const max = Math.min(n, WORDS_HE.length);

  while (out.length < max) {
    const w = WORDS_HE[Math.floor(Math.random() * WORDS_HE.length)];
    if (!w) continue;
    const key = w.toLowerCase();
    if (used.has(key)) continue;
    used.add(key);
    out.push(w);
  }

  // Fallback if word list tiny
  while (out.length < n) {
    out.push('חתול');
  }
  return out;
}

function maskWord(word) {
  // Mask only letters, keep spaces/dashes
  return String(word).split('').map(ch => {
    if (ch === ' ' || ch === '-' || ch === '_' || ch === '/') return ch;
    return '•';
  }).join('');
}

function publicState() {
  const playersArr = Object.values(state.players)
    .filter(p => p.isConnected)
    .map(p => ({
      id: p.id,
      name: p.name,
      score: p.score
    }))
    .sort((a, b) => b.score - a.score);

  return {
    phase: state.phase,
    players: playersArr,
    maxPlayers: MAX_PLAYERS,

    turnNumber: state.turnNumber,
    totalTurns: state.totalTurns,

    drawerId: state.drawerId,
    maskedWord: state.maskedWord,

    chooseSeconds: state.chooseSeconds,
    drawSeconds: state.drawSeconds,

    chooseEndsAt: state.chooseEndsAt,
    drawEndsAt: state.drawEndsAt
  };
}

function broadcastState() {
  io.emit('state:update', publicState());
}

function stopTimer() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

function startTicking() {
  stopTimer();
  state.timer = setInterval(() => {
    if (state.phase === 'choosing' && state.chooseEndsAt) {
      const left = Math.max(0, state.chooseEndsAt - nowMs());
      io.emit('timer:choose', { msLeft: left });
      if (left <= 0) {
        // Auto-pick first word if not chosen
        if (state.wordOptions.length > 0) {
          setChosenWord(state.wordOptions[0]);
        } else {
          setChosenWord(pickNWords(1)[0]);
        }
      }
    }

    if (state.phase === 'drawing' && state.drawEndsAt) {
      const left = Math.max(0, state.drawEndsAt - nowMs());
      io.emit('timer:draw', { msLeft: left });
      if (left <= 0) {
        endTurn('time');
      }
    }
  }, 250);
}

function ensureOrder() {
  // Keep only connected players
  const connectedIds = Object.values(state.players)
    .filter(p => p.isConnected)
    .map(p => p.id);

  // If order empty or missing players, rebuild
  const existing = state.order.filter(id => connectedIds.includes(id));
  const missing = connectedIds.filter(id => !existing.includes(id));
  state.order = existing.concat(missing);

  // Clamp order length
  state.order = state.order.slice(0, MAX_PLAYERS);
}

function getDrawerId() {
  ensureOrder();
  if (state.order.length === 0) return null;
  state.turnIndex = (state.turnIndex + 1) % state.order.length;
  return state.order[state.turnIndex];
}

function resetForNewTurn() {
  state.word = null;
  state.maskedWord = null;
  state.wordOptions = [];
  state.guessedThisTurn = new Set();
  state.chooseEndsAt = null;
  state.drawEndsAt = null;
  state.chatLocked = false;
}

function startGame() {
  ensureOrder();
  if (state.order.length < 2) {
    io.emit('toast', { type: 'error', text: 'צריך לפחות 2 שחקנים כדי להתחיל' });
    return;
  }

  state.phase = 'choosing';
  state.turnNumber = 0;
  state.totalTurns = TOTAL_TURNS_DEFAULT; // אפשר להפוך להגדרה מהלקוח
  state.turnIndex = -1;
  resetForNewTurn();

  state.drawerId = getDrawerId();
  state.wordOptions = pickNWords(WORD_OPTIONS_COUNT);

  // notify drawer to choose
  io.to(state.drawerId).emit('word:options', {
    options: state.wordOptions,
    seconds: state.chooseSeconds
  });

  // lock word for others (only masked)
  state.maskedWord = null;

  state.chooseEndsAt = nowMs() + state.chooseSeconds * 1000;

  io.emit('round:start', {
    drawerId: state.drawerId,
    phase: 'choosing'
  });

  broadcastState();
  startTicking();
}

function setChosenWord(word) {
  if (state.phase !== 'choosing') return;

  const w = String(word || '').trim();
  state.word = w || pickNWords(1)[0];
  state.maskedWord = maskWord(state.word);

  state.phase = 'drawing';
  state.chooseEndsAt = null;

  // Send real word only to drawer
  io.to(state.drawerId).emit('word:set', { word: state.word });

  // Send masked to everyone (including drawer, no harm)
  io.emit('word:masked', { masked: state.maskedWord });

  // Clear canvas for all
  io.emit('canvas:clear');

  // Start drawing timer
  state.drawEndsAt = nowMs() + state.drawSeconds * 1000;

  io.emit('round:start', {
    drawerId: state.drawerId,
    phase: 'drawing',
    drawSeconds: state.drawSeconds
  });

  broadcastState();
  startTicking();
}

function scoreGuess(socketId, msLeft) {
  // Simple scoring: more time left = more points
  // Max 200, min 20
  const secLeft = Math.max(0, Math.floor(msLeft / 1000));
  const base = 20;
  const bonus = Math.min(180, secLeft * 3);
  return base + bonus;
}

function endTurn(reason) {
  if (state.phase !== 'drawing') return;

  state.phase = 'reveal';
  stopTimer();

  // Reveal real word to all
  io.emit('round:reveal', {
    word: state.word,
    reason
  });

  broadcastState();

  // After short delay, next turn or end game
  setTimeout(() => {
    state.turnNumber += 1;

    const connectedCount = Object.values(state.players).filter(p => p.isConnected).length;
    if (connectedCount < 2) {
      state.phase = 'lobby';
      resetForNewTurn();
      state.drawerId = null;
      io.emit('toast', { type: 'info', text: 'חזרנו ללובי (אין מספיק שחקנים)' });
      broadcastState();
      return;
    }

    if (state.turnNumber >= state.totalTurns) {
      state.phase = 'lobby';
      resetForNewTurn();
      state.drawerId = null;
      io.emit('game:over', { leaderboard: publicState().players });
      broadcastState();
      return;
    }

    // Next turn
    state.phase = 'choosing';
    resetForNewTurn();

    state.drawerId = getDrawerId();
    state.wordOptions = pickNWords(WORD_OPTIONS_COUNT);

    io.to(state.drawerId).emit('word:options', {
      options: state.wordOptions,
      seconds: state.chooseSeconds
    });

    state.chooseEndsAt = nowMs() + state.chooseSeconds * 1000;

    io.emit('round:start', {
      drawerId: state.drawerId,
      phase: 'choosing'
    });

    broadcastState();
    startTicking();
  }, 2500);
}

// -----------------------
// Socket events
// -----------------------
io.on('connection', (socket) => {
  // Join
  socket.on('player:join', (payload) => {
    const name = clampName(payload?.name);

    // max players
    const connectedCount = Object.values(state.players).filter(p => p.isConnected).length;
    if (connectedCount >= MAX_PLAYERS) {
      socket.emit('join:denied', { reason: 'החדר מלא' });
      socket.disconnect(true);
      return;
    }

    state.players[socket.id] = {
      id: socket.id,
      name,
      score: 0,
      isConnected: true,
      lastActive: nowMs()
    };

    ensureOrder();

    socket.emit('join:ok', {
      id: socket.id,
      state: publicState()
    });

    io.emit('chat:system', { text: `${name} הצטרף` });
    broadcastState();
  });

  // Request full state
  socket.on('state:get', () => {
    socket.emit('state:update', publicState());
  });

  // Start game (anyone can for now)
  socket.on('game:start', () => {
    if (state.phase !== 'lobby') return;
    startGame();
  });

  // Drawer chooses word
  socket.on('word:choose', (payload) => {
    if (state.phase !== 'choosing') return;
    if (socket.id !== state.drawerId) return;

    const chosen = String(payload?.word || '').trim();
    if (!chosen) return;

    // must be one of options (or allow custom if you want)
    if (!state.wordOptions.includes(chosen)) {
      // ignore
      return;
    }

    setChosenWord(chosen);
  });

  // Drawing data relay (only drawer allowed)
  socket.on('draw:data', (payload) => {
    if (state.phase !== 'drawing') return;
    if (socket.id !== state.drawerId) return;

    // Broadcast to others (including drawer is ok, but usually not needed)
    socket.broadcast.emit('draw:data', payload);
  });

  // Clear canvas (drawer)
  socket.on('canvas:clear', () => {
    if (state.phase !== 'drawing') return;
    if (socket.id !== state.drawerId) return;
    io.emit('canvas:clear');
  });

  // Chat / Guess
  socket.on('chat:send', (payload) => {
    const p = state.players[socket.id];
    if (!p || !p.isConnected) return;

    const text = String(payload?.text || '').trim();
    if (!text) return;

    // Always broadcast chat message
    io.emit('chat:msg', {
      from: p.name,
      id: socket.id,
      text
    });

    // Guess logic in drawing phase (guessers only)
    if (state.phase === 'drawing') {
      // Drawer cannot guess
      if (socket.id === state.drawerId) return;

      // Already guessed
      if (state.guessedThisTurn.has(socket.id)) return;

      // Correct?
      const guess = text.toLowerCase();
      const answer = String(state.word || '').toLowerCase();

      if (guess === answer) {
        const msLeft = Math.max(0, (state.drawEndsAt || nowMs()) - nowMs());
        const points = scoreGuess(socket.id, msLeft);

        p.score += points;
        state.guessedThisTurn.add(socket.id);

        // drawer gets small bonus per correct guess
        const drawer = state.players[state.drawerId];
        if (drawer) drawer.score += 15;

        io.emit('chat:system', { text: `${p.name} ניחש נכון (+${points})` });
        broadcastState();

        // If everyone guessed (all except drawer)
        const connectedGuessers = Object.values(state.players)
          .filter(x => x.isConnected && x.id !== state.drawerId)
          .map(x => x.id);

        const allGuessed = connectedGuessers.length > 0 &&
          connectedGuessers.every(id => state.guessedThisTurn.has(id));

        if (allGuessed) {
          endTurn('כולם ניחשו');
        }
      }
    }
  });

  // Extend time (anyone, but costs points)
  socket.on('time:extend', () => {
    if (state.phase !== 'drawing') return;

    const p = state.players[socket.id];
    if (!p || !p.isConnected) return;

    // allow only drawer or host? כרגע: כל שחקן יכול לקנות זמן
    if (p.score < EXTEND_COST_POINTS) {
      socket.emit('toast', { type: 'error', text: 'אין מספיק נקודות להארכת זמן' });
      return;
    }

    p.score -= EXTEND_COST_POINTS;

    // extend draw end
    if (state.drawEndsAt) {
      state.drawEndsAt += EXTEND_SECONDS * 1000;
    }

    io.emit('toast', { type: 'info', text: `הוספנו ${EXTEND_SECONDS} שניות (עלות ${EXTEND_COST_POINTS})` });
    broadcastState();
  });

  // Disconnect
  socket.on('disconnect', () => {
    const p = state.players[socket.id];
    if (p) {
      p.isConnected = false;
      io.emit('chat:system', { text: `${p.name} יצא` });
    }

    ensureOrder();

    // If drawer disconnected mid-turn, end turn quickly
    if ((state.phase === 'choosing' || state.phase === 'drawing') && socket.id === state.drawerId) {
      if (state.phase === 'choosing') {
        // auto-pick and move on
        setChosenWord(state.wordOptions[0] || pickNWords(1)[0]);
      } else {
        endTurn('המצייר יצא');
      }
    } else {
      broadcastState();
    }
  });

  // First state push (in case client wants it before join)
  socket.emit('state:update', publicState());
});

// -----------------------
// Start
// -----------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Doodlit server listening on ${PORT}`);
});
