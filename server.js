// server.js (FULL, ready)
// Doodlit! - Skribbl-like minimal server with Hebrew words from /public/words-he.json
// Run: npm install express socket.io
// Start: node server.js

const express = require("express");
const http = require("http");
const SocketIO = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = SocketIO(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

app.use(express.static("public"));

/* =========================
   Config (edit these)
========================= */
const MAX_PLAYERS = 10;

// Your request: 60 seconds draw time + option to extend time by points.
// We'll implement: base 60, plusTime purchases (drawer can spend points to add time).
const CHOOSE_WORD_TIME = 20; // seconds to pick a word
const DRAW_TIME_BASE = 60; // seconds drawing
const ROUND_BREAK_TIME = 6; // seconds between rounds
const WORD_OPTIONS_COUNT = 3;

const PLUS_TIME_SECONDS = 10; // how much time is added per purchase
const PLUS_TIME_COST_POINTS = 50; // how many points cost per purchase
const PLUS_TIME_MAX_BUYS_PER_ROUND = 6; // prevent abuse

// Scoring (simple but good)
const POINTS_GUESS_BASE = 200;
const POINTS_GUESS_TIME_BONUS_MAX = 200; // earlier guess = more bonus
const POINTS_DRAWER_PER_GUESS = 60;

// Admin (optional)
const CHAT_ADMIN_PASSWORD = "admin";

/* =========================
   Word list loading
========================= */
let WORDS_HE = [];

function loadHebrewWords() {
  try {
    const p = path.join(__dirname, "public", "words-he.json");
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      console.log("words-he.json must be an array of strings");
      WORDS_HE = [];
      return;
    }

    WORDS_HE = parsed
      .filter((w) => typeof w === "string")
      .map((w) => w.trim())
      .filter((w) => w.length > 0);

    console.log(`Loaded ${WORDS_HE.length} Hebrew words`);
  } catch (e) {
    console.log("Failed to load words-he.json:", e.message);
    WORDS_HE = [];
  }
}
loadHebrewWords();

function pickRandomWords(n) {
  const src =
    WORDS_HE && WORDS_HE.length > 0
      ? WORDS_HE
      : ["תפוח", "בית", "חתול", "כלב", "מחשב", "ים", "כדור", "שמש"];

  const out = [];
  const used = new Set();
  while (out.length < n && used.size < src.length) {
    const idx = Math.floor(Math.random() * src.length);
    if (used.has(idx)) continue;
    used.add(idx);
    out.push(src[idx]);
  }
  return out.length > 0 ? out : ["תפוח", "בית", "חתול"];
}

/* =========================
   Game state (single room)
========================= */
const state = {
  hasGameStarted: false,
  round: 0,
  drawerSocketId: null,
  wordToDraw: null,
  wordOptions: [],
  guessersCorrect: new Set(),
  score: new Map(), // socketId -> points
  players: new Map(), // socketId -> {name, isConnected}
  chatMuted: new Set(), // socketIds muted by admin
  timers: {
    chooseWord: null,
    draw: null,
    break: null,
  },
  timeLeft: 0,
  drawTimeTotal: DRAW_TIME_BASE,
  plusBuysThisRound: 0,
};

function listPlayers() {
  const arr = [];
  for (const [id, p] of state.players.entries()) {
    arr.push({
      id,
      name: p.name,
      score: state.score.get(id) || 0,
      connected: !!p.isConnected,
    });
  }
  // keep stable sort: connected first, then score desc, then name
  arr.sort((a, b) => {
    if (a.connected !== b.connected) return a.connected ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    return a.name.localeCompare(b.name);
  });
  return arr;
}

function broadcastState() {
  io.emit("roomState", {
    hasGameStarted: state.hasGameStarted,
    round: state.round,
    drawerSocketId: state.drawerSocketId,
    timeLeft: state.timeLeft,
    drawTimeTotal: state.drawTimeTotal,
    players: listPlayers(),
    wordLength: state.wordToDraw ? state.wordToDraw.length : 0,
    plusTime: {
      secondsPerBuy: PLUS_TIME_SECONDS,
      costPoints: PLUS_TIME_COST_POINTS,
      buysThisRound: state.plusBuysThisRound,
      maxBuysPerRound: PLUS_TIME_MAX_BUYS_PER_ROUND,
    },
  });
}

function clearAllTimers() {
  for (const k of Object.keys(state.timers)) {
    if (state.timers[k]) clearInterval(state.timers[k]);
    state.timers[k] = null;
  }
}

function chooseNextDrawer() {
  const connected = listPlayers().filter((p) => p.connected);
  if (connected.length === 0) return null;

  // rotate drawer by order of join (Map iteration) but skip disconnected
  const ids = Array.from(state.players.keys());
  const currentIndex = state.drawerSocketId
    ? ids.indexOf(state.drawerSocketId)
    : -1;

  for (let i = 1; i <= ids.length; i++) {
    const id = ids[(currentIndex + i) % ids.length];
    const p = state.players.get(id);
    if (p && p.isConnected) return id;
  }
  return connected[0].id;
}

function startGame() {
  if (state.hasGameStarted) return;
  state.hasGameStarted = true;
  state.round = 0;
  io.emit("systemMsg", "המשחק התחיל");
  nextRound();
}

function stopGame() {
  state.hasGameStarted = false;
  state.round = 0;
  state.drawerSocketId = null;
  state.wordToDraw = null;
  state.wordOptions = [];
  state.guessersCorrect = new Set();
  state.timeLeft = 0;
  state.drawTimeTotal = DRAW_TIME_BASE;
  state.plusBuysThisRound = 0;
  clearAllTimers();
  io.emit("systemMsg", "המשחק הופסק");
  broadcastState();
}

function nextRound() {
  clearAllTimers();

  const drawer = chooseNextDrawer();
  if (!drawer) {
    stopGame();
    return;
  }

  state.round += 1;
  state.drawerSocketId = drawer;
  state.wordToDraw = null;
  state.wordOptions = pickRandomWords(WORD_OPTIONS_COUNT);
  state.guessersCorrect = new Set();
  state.timeLeft = CHOOSE_WORD_TIME;
  state.drawTimeTotal = DRAW_TIME_BASE;
  state.plusBuysThisRound = 0;

  io.emit("clearCanvas");
  io.emit("systemMsg", `סבב ${state.round} התחיל. בוחרים מילה`);
  // send word options only to drawer
  io.to(drawer).emit("chooseWord", {
    options: state.wordOptions,
    seconds: CHOOSE_WORD_TIME,
  });
  // everyone else sees waiting
  io.emit("waitingForWord", { drawerSocketId: drawer, seconds: CHOOSE_WORD_TIME });

  broadcastState();

  state.timers.chooseWord = setInterval(() => {
    state.timeLeft -= 1;
    if (state.timeLeft < 0) state.timeLeft = 0;
    broadcastState();

    if (state.timeLeft <= 0) {
      clearInterval(state.timers.chooseWord);
      state.timers.chooseWord = null;

      // auto pick first option if no choice
      const autoWord = state.wordOptions[0] || pickRandomWords(1)[0];
      setWordAndStartDrawing(autoWord, true);
    }
  }, 1000);
}

function setWordAndStartDrawing(word, autoPicked) {
  clearAllTimers();

  state.wordToDraw = String(word || "").trim();
  if (!state.wordToDraw) state.wordToDraw = pickRandomWords(1)[0];

  state.wordOptions = [];
  state.timeLeft = state.drawTimeTotal;

  const drawerName = state.players.get(state.drawerSocketId)?.name || "הצייר";
  io.emit(
    "systemMsg",
    autoPicked
      ? `לא נבחרה מילה בזמן. נבחרה מילה אוטומטית. ${drawerName} מצייר`
      : `${drawerName} מצייר`
  );

  // tell drawer the word
  io.to(state.drawerSocketId).emit("wordForDrawer", { word: state.wordToDraw });

  // tell others only length + hint placeholder
  io.emit("wordHint", {
    length: state.wordToDraw.length,
    revealed: "", // optional future: reveal letters
  });

  broadcastState();

  state.timers.draw = setInterval(() => {
    state.timeLeft -= 1;
    if (state.timeLeft < 0) state.timeLeft = 0;

    // if everyone guessed (except drawer), end early
    const connected = listPlayers().filter((p) => p.connected);
    const guessersConnected = connected.filter((p) => p.id !== state.drawerSocketId);
    const everyoneGuessed =
      guessersConnected.length > 0 &&
      guessersConnected.every((p) => state.guessersCorrect.has(p.id));

    broadcastState();

    if (state.timeLeft <= 0 || everyoneGuessed) {
      clearInterval(state.timers.draw);
      state.timers.draw = null;
      endRound();
    }
  }, 1000);
}

function endRound() {
  clearAllTimers();

  if (state.wordToDraw) {
    io.emit("systemMsg", `הסבב נגמר. המילה הייתה: ${state.wordToDraw}`);
  } else {
    io.emit("systemMsg", "הסבב נגמר");
  }

  state.wordToDraw = null;
  state.timeLeft = ROUND_BREAK_TIME;
  io.emit("roundBreak", { seconds: ROUND_BREAK_TIME });
  broadcastState();

  state.timers.break = setInterval(() => {
    state.timeLeft -= 1;
    if (state.timeLeft < 0) state.timeLeft = 0;
    broadcastState();

    if (state.timeLeft <= 0) {
      clearInterval(state.timers.break);
      state.timers.break = null;

      // keep game running if at least 2 connected players
      const connected = listPlayers().filter((p) => p.connected);
      if (connected.length < 2) {
        io.emit("systemMsg", "אין מספיק שחקנים מחוברים כדי להמשיך");
        stopGame();
        return;
      }

      nextRound();
    }
  }, 1000);
}

function normalizeGuess(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeWord(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/* =========================
   Socket events
========================= */
io.on("connection", (socket) => {
  // reject if room full (connected players)
  const connectedCount = listPlayers().filter((p) => p.connected).length;
  if (connectedCount >= MAX_PLAYERS) {
    socket.emit("systemMsg", "החדר מלא (10 שחקנים)");
    socket.disconnect(true);
    return;
  }

  socket.on("join", ({ name }) => {
    const safeName = String(name || "שחקן")
      .trim()
      .slice(0, 20);

    state.players.set(socket.id, { name: safeName, isConnected: true });
    if (!state.score.has(socket.id)) state.score.set(socket.id, 0);

    socket.emit("systemMsg", "התחברת לחדר");
    io.emit("systemMsg", `${safeName} הצטרף`);
    broadcastState();

    // auto-start if not started and enough players (optional)
    // if (!state.hasGameStarted && listPlayers().filter(p=>p.connected).length >= 2) startGame();
  });

  socket.on("disconnect", () => {
    const p = state.players.get(socket.id);
    if (p) p.isConnected = false;

    io.emit("systemMsg", `${p?.name || "שחקן"} התנתק`);
    broadcastState();

    // if drawer disconnected during choose/draw, move on quickly
    if (state.hasGameStarted && socket.id === state.drawerSocketId) {
      io.emit("systemMsg", "הצייר התנתק. עוברים לסבב הבא");
      endRound();
    }
  });

  // Chat
  socket.on("chat", ({ message }) => {
    const p = state.players.get(socket.id);
    if (!p || !p.isConnected) return;

    if (state.chatMuted.has(socket.id)) {
      socket.emit("systemMsg", "אתה מושתק");
      return;
    }

    const msg = String(message || "").trim();
    if (!msg) return;

    // admin commands (optional)
    if (msg.startsWith("/admin ")) {
      const parts = msg.split(" ");
      const pwd = parts[1] || "";
      const cmd = parts[2] || "";
      const arg = parts.slice(3).join(" ");

      if (pwd !== CHAT_ADMIN_PASSWORD) {
        socket.emit("systemMsg", "סיסמת אדמין שגויה");
        return;
      }

      if (cmd === "mute") {
        // arg can be name part
        const target = listPlayers().find((x) => x.name === arg || x.id === arg);
        if (target) {
          state.chatMuted.add(target.id);
          io.emit("systemMsg", `${target.name} הושתק`);
        } else {
          socket.emit("systemMsg", "לא נמצא משתמש להשתקה");
        }
        return;
      }

      if (cmd === "unmute") {
        const target = listPlayers().find((x) => x.name === arg || x.id === arg);
        if (target) {
          state.chatMuted.delete(target.id);
          io.emit("systemMsg", `${target.name} הוסר מהשתקה`);
        } else {
          socket.emit("systemMsg", "לא נמצא משתמש");
        }
        return;
      }

      if (cmd === "start") {
        startGame();
        return;
      }

      if (cmd === "stop") {
        stopGame();
        return;
      }

      socket.emit("systemMsg", "פקודה לא מוכרת");
      return;
    }

    // Guess check (only if game running, word exists, and not drawer)
    if (state.hasGameStarted && state.wordToDraw && socket.id !== state.drawerSocketId) {
      const guess = normalizeGuess(msg);
      const target = normalizeWord(state.wordToDraw);

      if (guess === target && !state.guessersCorrect.has(socket.id)) {
        state.guessersCorrect.add(socket.id);

        const timeRatio = state.timeLeft / Math.max(1, state.drawTimeTotal);
        const timeBonus = Math.floor(POINTS_GUESS_TIME_BONUS_MAX * timeRatio);
        const gained = POINTS_GUESS_BASE + timeBonus;

        state.score.set(socket.id, (state.score.get(socket.id) || 0) + gained);
        state.score.set(
          state.drawerSocketId,
          (state.score.get(state.drawerSocketId) || 0) + POINTS_DRAWER_PER_GUESS
        );

        io.emit("systemMsg", `${p.name} ניחש נכון (+${gained})`);
        socket.emit("guessedCorrect", { word: state.wordToDraw, gained });
        broadcastState();
        return; // do not show the correct guess in chat
      }
    }

    // normal chat broadcast
    io.emit("chat", { from: p.name, message: msg });
  });

  // Drawing events: only drawer can draw
  socket.on("draw", (payload) => {
    if (!state.hasGameStarted) return;
    if (socket.id !== state.drawerSocketId) return;
    if (!state.wordToDraw) return;

    // payload: {type:'stroke'|'clear'|'undo'? ... } depends on your front
    socket.broadcast.emit("draw", payload);
  });

  socket.on("clearCanvas", () => {
    if (!state.hasGameStarted) return;
    if (socket.id !== state.drawerSocketId) return;
    socket.broadcast.emit("clearCanvas");
  });

  // Drawer chooses word
  socket.on("pickWord", ({ word }) => {
    if (!state.hasGameStarted) return;
    if (socket.id !== state.drawerSocketId) return;
    if (!state.wordOptions || state.wordOptions.length === 0) return;

    const chosen = String(word || "").trim();
    if (!state.wordOptions.includes(chosen)) return;

    setWordAndStartDrawing(chosen, false);
  });

  // Start/Stop (hostless, anyone can start, but you can lock this later)
  socket.on("startGame", () => {
    const connected = listPlayers().filter((p) => p.connected);
    if (connected.length < 2) {
      socket.emit("systemMsg", "צריך לפחות 2 שחקנים כדי להתחיל");
      return;
    }
    startGame();
  });

  socket.on("stopGame", () => stopGame());

  // Plus time purchase (drawer spends points to add time)
  socket.on("buyPlusTime", () => {
    if (!state.hasGameStarted) return;
    if (socket.id !== state.drawerSocketId) return;
    if (!state.wordToDraw) return; // only while drawing
    if (state.plusBuysThisRound >= PLUS_TIME_MAX_BUYS_PER_ROUND) {
      socket.emit("systemMsg", "הגעת למקסימום הארכות בסבב");
      return;
    }

    const current = state.score.get(socket.id) || 0;
    if (current < PLUS_TIME_COST_POINTS) {
      socket.emit("systemMsg", "אין מספיק נקודות להאריך זמן");
      return;
    }

    state.score.set(socket.id, current - PLUS_TIME_COST_POINTS);
    state.timeLeft += PLUS_TIME_SECONDS;
    state.drawTimeTotal += PLUS_TIME_SECONDS;
    state.plusBuysThisRound += 1;

    io.emit(
      "systemMsg",
      `הצייר האריך זמן ב-${PLUS_TIME_SECONDS} שניות (עלות ${PLUS_TIME_COST_POINTS} נקודות)`
    );
    broadcastState();
  });

  // Send initial state
  socket.emit("systemMsg", "ברוך הבא. שלח join עם שם כדי להיכנס");
  broadcastState();
});

/* =========================
   Start server
========================= */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server listening on port", PORT);
});
