'use strict';

/**
 * Wedding Quiz - a Kahoot-style live quiz server.
 * One game room at a time (all a wedding needs), joined with a 6-digit PIN.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT || 3000);
const HOST_PASSWORD = process.env.HOST_PASSWORD || 'changeme';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const QUESTIONS_FILE = path.join(DATA_DIR, 'questions.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || 300);
// Pre-set mode: questions come only from questions.seed.json (which ships with the
// repo), the editor becomes read-only, and nothing about the quiz depends on disk
// surviving a restart. Set LOCK_QUESTIONS=1 in production.
const LOCK_QUESTIONS = /^(1|true|yes)$/i.test(process.env.LOCK_QUESTIONS || '');

const READY_MS = 3000;    // "get ready" countdown before the answers appear
const GRACE_MS = 400;     // slack for network latency at the end of a question
const STREAK_BONUS = 100; // extra points per consecutive correct answer
const STREAK_CAP = 500;
const SNAPSHOT_MAX_AGE_MS = 8 * 60 * 60 * 1000;

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ------------------------------------------------------------------ *
 * Questions
 * ------------------------------------------------------------------ */

// A question picture is either an inline data URI (what /admin produces once it has
// downscaled the file in the browser) or a plain https URL. Anything else is dropped
// rather than trusted: this string is handed straight to an <img src> on the projector.
// http:// is rejected on purpose - the browser would block it on an https deploy.
const MAX_IMAGE_CHARS = 400000;

// Rejects whitespace and quote/angle characters. Both consumers assign the DOM
// property (img.src = value), never build an attribute string, so this is a
// sanity filter rather than an HTML escaper - do not treat it as one.
function safeImageChars(s) {
  const bad = [' ', String.fromCharCode(9), String.fromCharCode(10), String.fromCharCode(13), '"', "'", '<', '>'];
  return !bad.some((c) => s.indexOf(c) !== -1);
}

function normaliseImage(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || s.length > MAX_IMAGE_CHARS) return null;
  const kinds = ['png', 'jpeg', 'webp', 'gif'];
  for (const k of kinds) {
    const prefix = 'data:image/' + k + ';base64,';
    if (s.startsWith(prefix)) return s.length > prefix.length && safeImageChars(s) ? s : null;
  }
  const scheme = 'https://';
  if (s.startsWith(scheme)) return s.length > scheme.length && safeImageChars(s) ? s : null;
  return null;
}

function normaliseQuestion(raw, i) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const options = (Array.isArray(src.options) ? src.options : [])
    .map((o) => String(o == null ? '' : o).slice(0, 200))
    .slice(0, 4);
  while (options.length < 2) options.push('');

  let correct = Number(src.correct);
  if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) correct = 0;

  let timeLimit = Number(src.timeLimit);
  if (!Number.isFinite(timeLimit)) timeLimit = 20;
  timeLimit = Math.min(120, Math.max(5, Math.round(timeLimit)));

  return {
    id: String(src.id || 'q' + (i + 1) + '_' + Math.random().toString(36).slice(2, 7)),
    text: String(src.text == null ? '' : src.text).slice(0, 400),
    options,
    correct,
    timeLimit,
    points: Number(src.points) === 2 ? 2 : 1,
    image: normaliseImage(src.image),
  };
}

function saveQuestions(list) {
  fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(list, null, 2), 'utf8');
}

function readSeed() {
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.seed.json'), 'utf8'));
  if (!Array.isArray(seed) || !seed.length) throw new Error('questions.seed.json must be a non-empty array');
  return seed.map(normaliseQuestion);
}

function loadQuestions() {
  // Pre-set mode ignores anything on disk, so what you committed is what runs.
  if (LOCK_QUESTIONS) return readSeed();

  try {
    const parsed = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
    if (Array.isArray(parsed) && parsed.length) return parsed.map(normaliseQuestion);
  } catch (err) { /* no saved set yet - fall through to the seed */ }

  const list = readSeed();
  saveQuestions(list);
  return list;
}

/* ------------------------------------------------------------------ *
 * Game state
 * ------------------------------------------------------------------ */

function newPin() {
  return String(crypto.randomInt(100000, 1000000));
}

const game = {
  pin: newPin(),
  phase: 'lobby',     // lobby | question | reveal | scoreboard | ended
  index: -1,
  startsAt: 0,
  endsAt: 0,
  joinLocked: false,
  questions: loadQuestions(),
  players: new Map(), // playerId -> player
  answers: new Map(), // playerId -> { choice, at, correct, gained }
};

let questionTimer = null;

function clearQuestionTimer() {
  if (questionTimer) {
    clearTimeout(questionTimer);
    questionTimer = null;
  }
}

function currentQuestion() {
  return game.questions[game.index] || null;
}

function playerList() {
  return [...game.players.values()];
}

function ranked() {
  return playerList()
    .slice()
    .sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt)
    .map((p, i) => ({ id: p.id, name: p.name, score: p.score, rank: i + 1, streak: p.streak }));
}

function rankOf(playerId) {
  const row = ranked().find((r) => r.id === playerId);
  return row ? row.rank : 0;
}

/* ------------------------------------------------------------------ *
 * Crash / restart recovery
 * ------------------------------------------------------------------ */

function snapshot() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      savedAt: Date.now(),
      pin: game.pin,
      phase: game.phase,
      index: game.index,
      joinLocked: game.joinLocked,
      players: playerList().map((p) => ({
        id: p.id, name: p.name, score: p.score, streak: p.streak, joinedAt: p.joinedAt,
      })),
    }), 'utf8');
  } catch (err) {
    console.error('snapshot failed:', err.message);
  }
}

// Joins arrive in bursts; writing the whole snapshot per join is the same O(n)-times-n
// trap as the roster broadcast. Phase changes still snapshot immediately.
let snapshotTimer = null;
function snapshotSoon() {
  if (snapshotTimer) return;
  snapshotTimer = setTimeout(() => { snapshotTimer = null; snapshot(); }, 2000);
}

function restoreSnapshot() {
  let s;
  try {
    s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (err) {
    return; // no snapshot - fresh start
  }
  if (!s || Date.now() - s.savedAt > SNAPSHOT_MAX_AGE_MS) return;

  game.pin = s.pin || game.pin;
  game.joinLocked = !!s.joinLocked;
  game.index = Number.isInteger(s.index) ? s.index : -1;
  // Never resume mid-question: park on the scoreboard so the host can carry on cleanly.
  game.phase = (s.phase === 'lobby' || s.phase === 'ended') ? s.phase : 'scoreboard';

  for (const p of s.players || []) {
    game.players.set(p.id, {
      id: p.id,
      name: p.name,
      score: p.score || 0,
      streak: p.streak || 0,
      joinedAt: p.joinedAt || Date.now(),
      connected: false,
      lastResult: null,
    });
  }
  console.log('Restored ' + game.players.size + ' players from snapshot (phase=' + game.phase + ').');
}

restoreSnapshot();

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function passwordOk(supplied) {
  const a = Buffer.from(String(supplied == null ? '' : supplied));
  const b = Buffer.from(HOST_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requirePassword(req, res, next) {
  if (!passwordOk(req.get('x-quiz-password') || req.query.password)) {
    return res.status(401).json({ error: 'wrong-password' });
  }
  next();
}

app.get('/host', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.get('/api/questions', requirePassword, (_req, res) => {
  res.set('x-questions-locked', LOCK_QUESTIONS ? '1' : '0');
  res.json(game.questions);
});

app.put('/api/questions', requirePassword, (req, res) => {
  if (LOCK_QUESTIONS) return res.status(423).json({ error: 'questions-locked' });
  if (!Array.isArray(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: 'expected-non-empty-array' });
  }
  if (game.phase !== 'lobby' && game.phase !== 'ended') {
    return res.status(409).json({ error: 'game-in-progress' });
  }
  game.questions = req.body.slice(0, 200).map(normaliseQuestion);
  saveQuestions(game.questions);
  broadcastState();
  res.json({ ok: true, count: game.questions.length });
});

app.get('/api/qr', async (req, res) => {
  const text = String(req.query.text || '').slice(0, 512);
  if (!text) return res.status(400).send('missing text');
  try {
    const svg = await QRCode.toString(text, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#241243', light: '#ffffff' },
    });
    res.type('svg').send(svg);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get('/healthz', (_req, res) =>
  res.json({ ok: true, players: game.players.size, phase: game.phase }));

// Without this, body-parser failures render an HTML stack trace carrying absolute
// filesystem paths - to anyone, since express.json() runs before requirePassword.
app.use((err, _req, res, _next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ error: 'payload-too-large', limit: '10mb' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'bad-json' });
  }
  console.error('unhandled request error:', err && err.message);
  res.status(500).json({ error: 'server-error' });
});

const server = http.createServer(app);
const io = new Server(server, { pingInterval: 20000, pingTimeout: 25000 });

/* ------------------------------------------------------------------ *
 * Broadcast helpers
 * ------------------------------------------------------------------ */

function publicQuestion() {
  const q = currentQuestion();
  if (!q) return null;
  return {
    number: game.index + 1,
    total: game.questions.length,
    text: q.text,
    options: q.options,
    timeLimit: q.timeLimit,
    points: q.points,
  };
}

function revealPayload() {
  const q = currentQuestion();
  if (!q) return null;
  const counts = q.options.map(() => 0);
  for (const a of game.answers.values()) {
    if (a.choice != null && counts[a.choice] != null) counts[a.choice] += 1;
  }
  return {
    correct: q.correct,
    counts,
    options: q.options,
    text: q.text,
    number: game.index + 1,
    total: game.questions.length,
    noAnswer: Math.max(0, game.players.size - game.answers.size),
  };
}

function baseState() {
  return {
    phase: game.phase,
    pin: game.pin,
    joinLocked: game.joinLocked,
    playerCount: game.players.size,
    questionCount: game.questions.length,
    index: game.index,
    startsAt: game.startsAt,
    endsAt: game.endsAt,
    serverNow: Date.now(),
    question: game.phase === 'question' ? publicQuestion() : null,
  };
}

function hostState() {
  const state = baseState();
  state.isHost = true;
  state.players = playerList().map((p) => ({
    id: p.id, name: p.name, score: p.score, connected: p.connected,
  }));
  state.answered = game.answers.size;
  // Guests never receive the image: it is the big screen's job, and shipping a
  // ~150KB data URI to 150 phones would undo the join-rush work.
  if (game.phase === 'question' || game.phase === 'reveal') {
    state.questionImage = (currentQuestion() || {}).image || null;
  }
  if (game.phase === 'question') state.correct = (currentQuestion() || {}).correct;
  if (game.phase === 'reveal') state.reveal = revealPayload();
  if (game.phase === 'scoreboard' || game.phase === 'ended') state.scoreboard = ranked();
  return state;
}

function playerState(player) {
  const state = baseState();
  state.you = player
    ? {
      id: player.id,
      name: player.name,
      score: player.score,
      streak: player.streak,
      rank: rankOf(player.id),
    }
    : null;
  state.hasAnswered = player ? game.answers.has(player.id) : false;

  if (player && game.phase === 'question') {
    const a = game.answers.get(player.id);
    state.yourChoice = a ? a.choice : null;
  }
  if (player && game.phase === 'reveal') {
    state.result = player.lastResult;
    state.reveal = revealPayload();
  }
  if (game.phase === 'scoreboard' || game.phase === 'ended') {
    // Never ship player ids to guests: `player:join` accepts an id to resume a
    // session, so leaking the leader's id would let anyone rejoin as them.
    const myId = player ? player.id : null;
    state.scoreboard = ranked().slice(0, 5).map((r) => ({
      name: r.name,
      score: r.score,
      rank: r.rank,
      me: r.id === myId,
    }));
  }
  return state;
}

function broadcastState() {
  io.to('hosts').emit('state', hostState());
  for (const socket of io.of('/').sockets.values()) {
    if (!socket.data.playerId) continue;
    socket.emit('state', playerState(game.players.get(socket.data.playerId)));
  }
}

// One guest arriving must not cost a full host-state broadcast. hostState()
// serializes every player, so doing it per join is O(n) work n times over -- about
// 2 MB of JSON across a 150-guest arrival rush, on a 0.1-CPU instance, at the worst
// possible moment. The host only needs the delta.
function emitRoster(op, player) {
  io.to('hosts').emit('roster', {
    op,                       // 'upsert' | 'remove'
    player: {
      id: player.id,
      name: player.name,
      score: player.score || 0,
      connected: !!player.connected,
    },
    playerCount: game.players.size,
  });
}

/* ------------------------------------------------------------------ *
 * Game flow
 * ------------------------------------------------------------------ */

function scoreFor(elapsedMs, limitMs, points) {
  const base = 1000 * points;
  if (elapsedMs <= 0) return base;
  if (elapsedMs >= limitMs) return Math.round(base * 0.5);
  return Math.round(base * (1 - (elapsedMs / limitMs) / 2));
}

function startQuestion(i) {
  if (i < 0 || i >= game.questions.length) return endGame();
  clearQuestionTimer();
  game.index = i;
  game.phase = 'question';
  game.answers = new Map();
  for (const p of game.players.values()) p.lastResult = null;

  const q = currentQuestion();
  const now = Date.now();
  game.startsAt = now + READY_MS;
  game.endsAt = game.startsAt + q.timeLimit * 1000;
  questionTimer = setTimeout(revealQuestion, (game.endsAt - now) + GRACE_MS);

  broadcastState();
  snapshot();
}

function revealQuestion() {
  clearQuestionTimer();
  if (game.phase !== 'question') return;
  const q = currentQuestion();

  for (const player of game.players.values()) {
    const a = game.answers.get(player.id);
    if (a && a.correct) {
      player.streak += 1;
      const bonus = Math.min(STREAK_CAP, Math.max(0, player.streak - 1) * STREAK_BONUS);
      const gained = a.gained + bonus;
      player.score += gained;
      player.lastResult = { correct: true, gained, bonus, choice: a.choice };
    } else {
      player.streak = 0;
      player.lastResult = { correct: false, gained: 0, bonus: 0, choice: a ? a.choice : null };
    }
  }

  game.phase = 'reveal';
  // Ranks are only meaningful once every score for this question is in.
  for (const player of game.players.values()) {
    player.lastResult.total = player.score;
    player.lastResult.rank = rankOf(player.id);
    player.lastResult.correctIndex = q ? q.correct : null;
  }

  broadcastState();
  snapshot();
}

function showScoreboard() {
  clearQuestionTimer();
  game.phase = 'scoreboard';
  broadcastState();
  snapshot();
}

function endGame() {
  clearQuestionTimer();
  game.phase = 'ended';
  game.index = game.questions.length;
  broadcastState();
  snapshot();
}

function resetGame(keepPlayers) {
  clearQuestionTimer();
  game.phase = 'lobby';
  game.index = -1;
  game.answers = new Map();
  game.joinLocked = false;

  if (keepPlayers) {
    for (const p of game.players.values()) {
      p.score = 0;
      p.streak = 0;
      p.lastResult = null;
    }
  } else {
    game.players.clear();
    game.pin = newPin();
    for (const socket of io.of('/').sockets.values()) {
      if (socket.data.playerId) {
        socket.data.playerId = null;
        socket.leave('players');
        socket.emit('kicked');
      }
    }
  }
  broadcastState();
  snapshot();
}

function maybeEarlyReveal() {
  if (game.phase !== 'question') return;
  const active = playerList().filter((p) => p.connected).length;
  if (active > 0 && game.answers.size >= active) {
    clearQuestionTimer();
    questionTimer = setTimeout(revealQuestion, 900);
  }
}

/* ------------------------------------------------------------------ *
 * Sockets
 * ------------------------------------------------------------------ */

function cleanName(raw) {
  return String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().slice(0, 18);
}

function uniqueName(name, ownId) {
  const taken = new Set(
    playerList().filter((p) => p.id !== ownId).map((p) => p.name.toLowerCase()),
  );
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; n < 500; n += 1) {
    const candidate = name + ' ' + n;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return name + ' ' + Math.random().toString(36).slice(2, 5);
}

io.on('connection', (socket) => {
  socket.data.playerId = null;
  socket.data.isHost = false;
  socket.emit('hello', { serverNow: Date.now() });

  /* ---- host ---- */

  const acker = (ack) => (r) => { if (typeof ack === 'function') ack(r); };

  socket.on('host:auth', (payload, ack) => {
    const reply = acker(ack);
    if (!passwordOk(payload && payload.password)) {
      reply({ ok: false, error: 'wrong-password' });
      return;
    }
    socket.data.isHost = true;
    socket.join('hosts');
    reply({ ok: true });
    socket.emit('state', hostState());
  });

  const hostOnly = (fn) => (...args) => { if (socket.data.isHost) fn(...args); };

  socket.on('host:start', hostOnly(() => {
    if (!game.questions.length) return;
    for (const p of game.players.values()) {
      p.score = 0;
      p.streak = 0;
      p.lastResult = null;
    }
    game.joinLocked = true;
    startQuestion(0);
  }));

  socket.on('host:skip', hostOnly(() => {
    if (game.phase === 'question') revealQuestion();
  }));

  socket.on('host:next', hostOnly(() => {
    if (game.phase === 'reveal') return showScoreboard();
    if (game.phase === 'scoreboard') {
      if (game.index + 1 >= game.questions.length) return endGame();
      return startQuestion(game.index + 1);
    }
  }));

  socket.on('host:lock', hostOnly((payload) => {
    game.joinLocked = !!(payload && payload.locked);
    broadcastState();
  }));

  socket.on('host:kick', hostOnly((payload) => {
    const id = payload && payload.id;
    if (!game.players.delete(id)) return;
    for (const s of io.of('/').sockets.values()) {
      if (s.data.playerId === id) {
        s.data.playerId = null;
        s.leave('players');
        s.emit('kicked');
      }
    }
    broadcastState();
  }));

  socket.on('host:reset', hostOnly((payload) => {
    resetGame(!!(payload && payload.keepPlayers));
  }));

  /* ---- player ---- */

  socket.on('player:join', (payload, ack) => {
    const reply = acker(ack);
    const pin = String((payload && payload.pin) || '').trim();
    if (pin !== game.pin) return reply({ ok: false, error: 'bad-pin' });

    const existingId = payload && payload.playerId;
    let player = existingId ? game.players.get(existingId) : null;

    if (!player) {
      if (game.joinLocked) return reply({ ok: false, error: 'locked' });
      if (game.players.size >= MAX_PLAYERS) return reply({ ok: false, error: 'full' });
      const name = cleanName(payload && payload.name);
      if (!name) return reply({ ok: false, error: 'bad-name' });
      const id = crypto.randomUUID();
      player = {
        id,
        name: uniqueName(name, id),
        score: 0,
        streak: 0,
        joinedAt: Date.now(),
        connected: true,
        lastResult: null,
      };
      game.players.set(id, player);
    }

    player.connected = true;
    socket.data.playerId = player.id;
    socket.join('players');
    reply({ ok: true, playerId: player.id, name: player.name });
    socket.emit('state', playerState(player));
    emitRoster('upsert', player);
    snapshotSoon();
  });

  socket.on('player:answer', (payload, ack) => {
    const reply = acker(ack);
    const player = game.players.get(socket.data.playerId);
    if (!player || game.phase !== 'question') return reply({ ok: false, error: 'not-open' });
    // Say WHICH answer is locked in. Only the first submission counts, so a guest
    // whose ack was lost and who then taps something different must be told that,
    // rather than being shown a bare "sent" for a choice the server discarded.
    if (game.answers.has(player.id)) {
      return reply({ ok: false, error: 'already', choice: game.answers.get(player.id).choice });
    }

    const now = Date.now();
    if (now < game.startsAt - 200) return reply({ ok: false, error: 'too-early' });
    if (now > game.endsAt + GRACE_MS) return reply({ ok: false, error: 'too-late' });

    const q = currentQuestion();
    const choice = Number(payload && payload.choice);
    if (!Number.isInteger(choice) || choice < 0 || choice >= q.options.length) {
      return reply({ ok: false, error: 'bad-choice' });
    }

    const elapsed = Math.max(0, now - game.startsAt);
    const correct = choice === q.correct;
    game.answers.set(player.id, {
      choice,
      at: now,
      correct,
      gained: correct ? scoreFor(elapsed, q.timeLimit * 1000, q.points) : 0,
    });

    reply({ ok: true });
    socket.emit('state', playerState(player));
    // A full host state is ~180 bytes per player; at 150 guests that is 27 KB, and
    // resending it on every single answer would push megabytes at the host laptop
    // during one question. The host only needs the counter to move.
    io.to('hosts').emit('tally', { answered: game.answers.size, playerCount: game.players.size });
    maybeEarlyReveal();
  });

  socket.on('disconnect', () => {
    const player = game.players.get(socket.data.playerId);
    if (!player) return;
    const stillHere = [...io.of('/').sockets.values()]
      .some((s) => s.id !== socket.id && s.data.playerId === player.id);
    if (!stillHere) {
      player.connected = false;
      emitRoster('upsert', player);
    }
  });
});

server.listen(PORT, () => {
  console.log('----------------------------------------------------');
  console.log('  Wedding Quiz  ->  http://localhost:' + PORT);
  console.log('  Guests : /        (PIN ' + game.pin + ')');
  console.log('  Host   : /host');
  console.log('  Editor : /admin' + (LOCK_QUESTIONS ? '  (read-only: LOCK_QUESTIONS is on)' : ''));
  console.log('  ' + game.questions.length + ' questions from ' +
    (LOCK_QUESTIONS ? 'questions.seed.json (pre-set)' : 'data/questions.json'));
  if (HOST_PASSWORD === 'changeme') {
    console.log('  !! HOST_PASSWORD is still "changeme" - set it before the wedding.');
  }
  console.log('----------------------------------------------------');
});

// Last resort. Normally letting a process die on an unexpected error is right, but
// this one runs a party for one evening: a live game with 150 guests on it is worth
// more than a clean exit, and a restart cannot resume a question anyway (see
// restoreSnapshot). Anything landing here is a bug - it gets logged loudly.
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION (staying up so the game survives):', err && err.stack);
});
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION (staying up so the game survives):', err);
});
