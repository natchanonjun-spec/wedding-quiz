/**
 * Load test / smoke test: drives a real game with N simulated guests.
 *
 *   node loadtest.js [url] [players]
 *   node loadtest.js http://localhost:3000 150
 *
 * Set HOST_PASSWORD to the same value the server is running with.
 */

const { io } = require('socket.io-client');

const URL = process.argv[2] || 'http://localhost:3000';
const N = Number(process.argv[3] || 150);
const PASSWORD = process.env.HOST_PASSWORD || 'changeme';
const ROUNDS = Number(process.env.ROUNDS || 3);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

let fails = 0;
function check(label, ok, detail) {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) fails += 1;
}

async function main() {
  console.log(`\nTarget ${URL} — ${N} simulated guests, ${ROUNDS} rounds\n`);

  /* ---- host ---- */
  const host = io(URL, { transports: ['websocket'] });
  let hostState = null;
  const hostStates = [];
  host.on('state', (s) => { hostState = s; hostStates.push(s); });
  host.on('tally', (t) => {
    if (!hostState) return;
    hostState.answered = t.answered;
    hostState.playerCount = t.playerCount;
  });
  // Joins/leaves arrive as deltas, exactly as the real host screen consumes them.
  let rosterEvents = 0;
  host.on('roster', (r) => {
    rosterEvents += 1;
    if (!hostState || !hostState.players) return;
    const at = hostState.players.findIndex((p) => p.id === r.player.id);
    if (r.op === 'remove') {
      if (at >= 0) hostState.players.splice(at, 1);
    } else if (at >= 0) {
      hostState.players[at] = r.player;
    } else {
      hostState.players.push(r.player);
    }
    hostState.playerCount = r.playerCount;
  });

  await new Promise((res, rej) => {
    host.on('connect', () => {
      host.emit('host:auth', { password: PASSWORD }, (r) => (r && r.ok ? res() : rej(new Error('host auth failed — check HOST_PASSWORD'))));
    });
    host.on('connect_error', rej);
  });
  console.log('Host authenticated.');

  host.emit('host:reset', { keepPlayers: false });
  await sleep(300);
  const pin = hostState.pin;
  console.log(`Game PIN ${pin}\n`);

  /* ---- players join ---- */
  console.log(`Joining ${N} guests…`);
  const joinLatency = [];
  const players = [];
  const t0 = Date.now();

  await Promise.all(Array.from({ length: N }, (_, i) => new Promise((resolve) => {
    const sock = io(URL, { transports: ['websocket'] });
    const p = { i, sock, state: null, joined: false, answered: 0, results: [] };
    players.push(p);
    sock.on('state', (s) => {
      p.state = s;
      if (s.phase === 'reveal' && s.result) p.results.push(s.result);
    });
    sock.on('connect', () => {
      const sent = Date.now();
      sock.emit('player:join', { pin, name: `แขก${i + 1}` }, (r) => {
        joinLatency.push(Date.now() - sent);
        p.joined = !!(r && r.ok);
        resolve();
      });
    });
    sock.on('connect_error', () => resolve());
  })));

  const joinMs = Date.now() - t0;
  await sleep(600);

  console.log(`\n[join]`);
  check(`all ${N} guests joined`, players.filter((p) => p.joined).length === N,
    `${players.filter((p) => p.joined).length}/${N} in ${joinMs}ms`);
  check('server player count matches', hostState.playerCount === N, `server says ${hostState.playerCount}`);
  check('host tracked every guest via roster deltas', (hostState.players || []).length === N,
    `${(hostState.players || []).length}/${N} in the host's list`);
  check('joins did NOT trigger full state broadcasts', hostStates.length <= 3,
    `${rosterEvents} roster deltas vs ${hostStates.length} full states`);
  console.log(`  join latency  p50 ${pct(joinLatency, 50)}ms · p95 ${pct(joinLatency, 95)}ms · max ${Math.max(...joinLatency)}ms`);

  /* ---- play rounds ---- */
  host.emit('host:start');

  for (let round = 0; round < ROUNDS; round += 1) {
    // wait for the question phase
    for (let i = 0; i < 60 && (!hostState || hostState.phase !== 'question'); i += 1) await sleep(100);
    if (hostState.phase !== 'question') { check(`round ${round + 1} reached question phase`, false); break; }

    const q = hostState.question;
    console.log(`\n[round ${round + 1}]  "${q.text}"  (${q.options.length} options, ${q.timeLimit}s)`);

    await sleep(Math.max(0, hostState.startsAt - Date.now()) + 150);

    // Everyone answers within a 2.5s burst — the realistic worst case.
    const answerLatency = [];
    const expectedCorrect = { n: 0 };
    await Promise.all(players.map((p) => new Promise((resolve) => {
      if (!p.joined) return resolve();
      setTimeout(() => {
        const choice = Math.floor(Math.random() * q.options.length);
        const sent = Date.now();
        p.sock.emit('player:answer', { choice }, (r) => {
          answerLatency.push(Date.now() - sent);
          if (r && r.ok) p.answered += 1;
          resolve();
        });
      }, Math.random() * 2500);
    })));

    await sleep(400);
    check('every answer accepted', players.filter((p) => p.answered === round + 1).length === N,
      `${players.filter((p) => p.answered === round + 1).length}/${N} accepted`);
    check('host answer counter matches', hostState.answered === N, `host says ${hostState.answered}`);
    console.log(`  answer latency  p50 ${pct(answerLatency, 50)}ms · p95 ${pct(answerLatency, 95)}ms · max ${Math.max(...answerLatency)}ms`);

    // double-answer must be rejected
    const dupe = await new Promise((res) => players[0].sock.emit('player:answer', { choice: 0 }, res));
    check('second answer rejected', dupe && dupe.ok === false && dupe.error === 'already', JSON.stringify(dupe));

    host.emit('host:skip');
    for (let i = 0; i < 40 && hostState.phase !== 'reveal'; i += 1) await sleep(100);
    check('reveal reached', hostState.phase === 'reveal');

    if (hostState.reveal) {
      const counted = hostState.reveal.counts.reduce((a, b) => a + b, 0);
      check('all answers counted in reveal', counted === N, `counted ${counted}/${N}`);
      const gotResult = players.filter((p) => p.results.length === round + 1).length;
      check('every guest got a personal result', gotResult === N, `${gotResult}/${N}`);
      expectedCorrect.n = hostState.reveal.counts[hostState.reveal.correct];
      const scoredRight = players.filter((p) => p.results[round] && p.results[round].correct).length;
      check('correct-answer count matches scoring', scoredRight === expectedCorrect.n,
        `reveal ${expectedCorrect.n} vs scored ${scoredRight}`);
    }

    host.emit('host:next');            // -> scoreboard
    for (let i = 0; i < 40 && hostState.phase !== 'scoreboard'; i += 1) await sleep(100);
    check('scoreboard reached', hostState.phase === 'scoreboard');
    check('scoreboard ranks all guests', (hostState.scoreboard || []).length === N,
      `${(hostState.scoreboard || []).length}/${N}`);
    if (hostState.scoreboard && hostState.scoreboard.length > 1) {
      const sorted = hostState.scoreboard.every((r, i, a) => i === 0 || a[i - 1].score >= r.score);
      check('scoreboard sorted descending', sorted);
    }

    host.emit('host:next');            // -> next question
  }

  /* ---- reconnect ---- */
  console.log('\n[reconnect]');
  // Pick someone who actually has points, or the check proves nothing.
  const victim = players.find((p) => p.state && p.state.you && p.state.you.score > 0) || players[0];
  const beforeScore = victim.state.you.score;
  const savedId = victim.state.you.id;
  check('reconnect test has a non-zero score to protect', beforeScore > 0, `score ${beforeScore}`);
  victim.sock.disconnect();
  await sleep(400);
  const again = io(URL, { transports: ['websocket'] });
  const rejoined = await new Promise((res) => {
    again.on('connect', () => again.emit('player:join', { pin, name: victim.state.you.name, playerId: savedId }, res));
  });
  await sleep(300);
  check('rejoin with saved id works', !!(rejoined && rejoined.ok));
  check('score survived the reconnect', victim.state && victim.state.you.score === beforeScore,
    `${beforeScore} -> ${victim.state && victim.state.you.score}`);
  check('rejoin did not create a duplicate player', hostState.playerCount === N,
    `${hostState.playerCount} players`);
  again.close();

  /* ---- security ---- */
  console.log('\n[security]');
  const intruder = io(URL, { transports: ['websocket'] });
  await new Promise((res) => intruder.on('connect', res));
  const badAuth = await new Promise((res) => intruder.emit('host:auth', { password: 'wrong' }, res));
  check('wrong host password rejected', badAuth && badAuth.ok === false);
  const phaseBefore = hostState.phase;
  intruder.emit('host:reset', { keepPlayers: false });
  await sleep(400);
  check('unauthenticated host command ignored', hostState.phase === phaseBefore && hostState.playerCount === N,
    `phase ${hostState.phase}, ${hostState.playerCount} players`);
  const badPin = await new Promise((res) => intruder.emit('player:join', { pin: '000000', name: 'x' }, res));
  check('wrong PIN rejected', badPin && badPin.error === 'bad-pin');
  intruder.close();

  /* ---- payload size at 150 ---- */
  const biggest = hostStates.reduce((m, s) => Math.max(m, JSON.stringify(s).length), 0);
  console.log(`\n[payload]  largest host state broadcast: ${(biggest / 1024).toFixed(1)} KB`);

  console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECK(S) FAILED'}\n`);

  players.forEach((p) => p.sock.close());
  host.close();
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nload test crashed:', err.message);
  process.exit(1);
});
