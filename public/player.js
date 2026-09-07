/* Wedding Quiz — guest (phone) client */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var socket = io({ transports: ['websocket', 'polling'] });

  var ANSWER_TIMEOUT_MS = 4000;
  var JOIN_TIMEOUT_MS = 7000;

  var me = { id: null, name: null };
  var clockOffset = 0;      // serverNow - Date.now()
  var state = null;
  var joined = false;
  var raf = null;
  var answerPending = false;
  var joinPending = false;

  function now() { return Date.now() + clockOffset; }

  function show(id) {
    var el = $(id);
    if (el.classList.contains('active')) return;   // already on screen - no replay, no extra work
    var screens = document.querySelectorAll('.screen');
    for (var i = 0; i < screens.length; i++) screens[i].classList.remove('active');
    el.classList.add('active');
  }

  // Reusable "something changed here" bounce, for the rank badge and the +score line
  // on reveal. Reuses the .pop keyframe already defined in style.css.
  function bounce(el) {
    el.classList.remove('pop');
    void el.offsetWidth;               // force a reflow so the animation restarts
    el.classList.add('pop');
  }

  // Counts a guest's own score up to its new total instead of jumping straight there -
  // this is the "your score is climbing" moment right after an answer is scored.
  var lastShownScore = 0;
  function setScoreText(el, val) {
    el.textContent = val.toLocaleString('th-TH');
    lastShownScore = val;
  }
  function animateScore(el, from, to, ms) {
    if (from === to) { setScoreText(el, to); return; }
    var start = null;
    function step(ts) {
      if (start === null) start = ts;
      var p = Math.min(1, (ts - start) / ms);
      var eased = 1 - Math.pow(1 - p, 3);          // ease-out cubic
      el.textContent = Math.round(from + (to - from) * eased).toLocaleString('th-TH');
      if (p < 1) requestAnimationFrame(step);
      else lastShownScore = to;
    }
    requestAnimationFrame(step);
  }

  function save() {
    try {
      localStorage.setItem('wq.player', JSON.stringify({ id: me.id, name: me.name, pin: $('in-pin').value }));
    } catch (e) { /* private mode */ }
  }

  function restore() {
    try { return JSON.parse(localStorage.getItem('wq.player') || 'null'); } catch (e) { return null; }
  }

  /* ---------------- join ---------------- */

  var ERRORS = {
    'bad-pin': 'PIN ไม่ถูกต้อง ลองดูบนจอใหญ่อีกครั้งนะ',
    'bad-name': 'ใส่ชื่อเล่นด้วยนะ',
    'locked': 'เกมเริ่มไปแล้ว ตอนนี้เข้าร่วมไม่ได้ — ลองบอกเจ้าภาพให้เปิดรับผู้เล่นนะ',
    'full': 'ผู้เล่นเต็มแล้ว',
    'timeout': '⚠️ เซิร์ฟเวอร์ไม่ตอบ ลองกดเข้าร่วมอีกครั้ง',
  };

  // done(null) on success, done(errorCode) on any failure including "never answered".
  function attemptJoin(payload, done) {
    var settled = false;
    var giveUp = setTimeout(function () {
      if (settled) return;
      settled = true;
      joinPending = false;
      if (done) done('timeout');
    }, JOIN_TIMEOUT_MS);

    socket.emit('player:join', payload, function (res) {
      if (settled) return;
      settled = true;
      clearTimeout(giveUp);
      joinPending = false;

      if (res && res.ok) {
        me.id = res.playerId;
        me.name = res.name;
        joined = true;
        save();
        $('join-err').textContent = '';
        if (done) done(null);
      } else if (done) {
        done((res && res.error) || 'error');
      }
    });
  }

  // The join button is only live once the socket is actually up. Before this, a tap
  // during Render's ~50s cold start emitted into nothing: no ack, no error, no
  // feedback, and the button silently re-enabled 800ms later.
  function setConnectionUi(connected) {
    var btn = $('btn-join');
    if (joinPending) return;
    btn.disabled = !connected;
    btn.textContent = connected ? 'เข้าร่วมเกม' : 'กำลังเชื่อมต่อ…';
  }

  $('btn-join').addEventListener('click', function () {
    if (joinPending) return;
    var pin = $('in-pin').value.replace(/\D/g, '');
    var name = $('in-name').value.trim();
    if (!pin) { $('join-err').textContent = 'ใส่ PIN ก่อนนะ'; return; }
    if (!name) { $('join-err').textContent = 'ใส่ชื่อเล่นด้วยนะ'; return; }

    if (!socket.connected) {
      $('join-err').textContent = 'ยังเชื่อมต่อไม่ได้ — รอสักครู่แล้วลองใหม่';
      socket.connect();
      return;
    }

    joinPending = true;
    $('btn-join').disabled = true;
    $('btn-join').textContent = 'กำลังเข้าร่วม…';
    $('join-err').textContent = '';

    // Send the id we already hold (from a previous attempt or a restored session) so
    // a retry resumes that guest instead of minting a second one for the same person.
    var saved = restore();
    var knownId = me.id || (saved && saved.id) || null;

    attemptJoin({ pin: pin, name: name, playerId: knownId }, function (err) {
      $('btn-join').textContent = 'เข้าร่วมเกม';
      $('btn-join').disabled = !socket.connected;
      if (err) $('join-err').textContent = ERRORS[err] || 'เข้าร่วมไม่สำเร็จ ลองใหม่อีกครั้ง';
    });
  });

  $('in-pin').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('in-name').focus(); });
  $('in-name').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('btn-join').click(); });

  // ?pin=123456 from the QR code prefills the PIN.
  var urlPin = new URLSearchParams(location.search).get('pin');
  if (urlPin) $('in-pin').value = urlPin.replace(/\D/g, '').slice(0, 6);

  /* ---------------- answers ---------------- */

  function renderAnswers(q, opts) {
    var box = $('q-answers');
    box.innerHTML = '';
    box.className = 'answers' + (q.options.length <= 2 ? ' two' : '');
    q.options.forEach(function (text, i) {
      var b = document.createElement('button');
      b.className = 'answer';
      b.dataset.a = i;
      b.type = 'button';
      var s = document.createElement('span');
      s.className = 'shape';
      s.dataset.s = i;
      b.appendChild(s);
      var t = document.createElement('span');
      t.textContent = text;
      b.appendChild(t);
      if (opts.locked) b.disabled = true;
      if (opts.chosen === i) b.classList.add('chosen');
      b.addEventListener('click', function () { sendAnswer(i); });
      box.appendChild(b);
    });
  }

  // The answer is never treated as sent until the server says so. Disabling the
  // buttons up front (the old behaviour) left a guest on a flaky connection with four
  // dead buttons, no message, and no way to retry -- they silently lost the question.
  function markChoice(buttons, choice) {
    for (var i = 0; i < buttons.length; i++) {
      if (i === choice) buttons[i].classList.add('chosen'); else buttons[i].classList.add('dim');
    }
  }

  function clearChoice(buttons) {
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.remove('chosen');
      buttons[i].classList.remove('dim');
    }
  }

  function sendAnswer(choice) {
    if (answerPending) return;
    var buttons = document.querySelectorAll('#q-answers .answer');

    if (!socket.connected) {
      $('q-note').textContent = '⚠️ เน็ตหลุดอยู่ — กำลังต่อใหม่ แล้วแตะอีกครั้งนะ';
      return;
    }

    answerPending = true;
    markChoice(buttons, choice);
    $('q-note').textContent = 'กำลังส่ง…';

    var settled = false;
    var giveUp = setTimeout(function () {
      if (settled) return;
      settled = true;
      answerPending = false;
      clearChoice(buttons);
      $('q-note').textContent = '⚠️ ส่งไม่สำเร็จ แตะเลือกใหม่อีกครั้งนะ';
    }, ANSWER_TIMEOUT_MS);

    socket.emit('player:answer', { choice: choice }, function (res) {
      if (settled) return;
      settled = true;
      clearTimeout(giveUp);
      answerPending = false;

      if (res && res.ok) { $('sent-note').textContent = ''; show('s-sent'); return; }

      // "already" means an earlier send DID land and only its ack went missing.
      // Only that first choice counts, so if this tap was for a different option we
      // say so plainly instead of implying the new one was accepted.
      if (res && res.error === 'already') {
        $('q-note').textContent = '';
        var locked = res.choice;
        if (typeof locked === 'number' && locked !== choice) {
          clearChoice(buttons);
          markChoice(buttons, locked);
          var opts = (state && state.question && state.question.options) || [];
          $('sent-note').textContent = 'คำตอบที่บันทึกไว้คือ "' + (opts[locked] || '') +
            '" (คำตอบแรกที่ส่งถึงเท่านั้นที่นับ)';
        } else {
          $('sent-note').textContent = '';
        }
        show('s-sent');
        return;
      }

      clearChoice(buttons);
      if (res && res.error === 'too-late') {
        $('q-note').textContent = 'หมดเวลาพอดี! ไปข้อต่อไปกันเลย';
      } else {
        $('q-note').textContent = '⚠️ ส่งไม่สำเร็จ แตะเลือกใหม่อีกครั้งนะ';
      }
    });
  }

  /* ---------------- timer ---------------- */

  function startTimerLoop() {
    stopTimerLoop();
    var tick = function () {
      if (!state || state.phase !== 'question') return;
      var t = now();
      var q = state.question;
      if (t < state.startsAt) {
        $('q-ready').style.display = '';
        $('q-answers').style.display = 'none';
        $('q-count').textContent = String(Math.max(1, Math.ceil((state.startsAt - t) / 1000)));
        $('q-bar').style.width = '100%';
      } else {
        $('q-ready').style.display = 'none';
        $('q-answers').style.display = '';
        var total = state.endsAt - state.startsAt;
        var left = Math.max(0, state.endsAt - t);
        $('q-bar').style.width = (total > 0 ? (left / total) * 100 : 0) + '%';
        if (left <= 0 && !state.hasAnswered) {
          $('q-note').textContent = 'หมดเวลาแล้ว ⏰';
          var bs = document.querySelectorAll('#q-answers .answer');
          for (var i = 0; i < bs.length; i++) bs[i].disabled = true;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  function stopTimerLoop() {
    if (raf) { cancelAnimationFrame(raf); raf = null; }
  }

  /* ---------------- leaderboards ---------------- */

  function renderBoard(el, rows) {
    el.innerHTML = '';
    (rows || []).forEach(function (r) {
      var li = document.createElement('li');
      if (r.me) li.classList.add('you');
      var rank = document.createElement('span');
      rank.className = 'r';
      rank.textContent = r.rank;
      var name = document.createElement('span');
      name.textContent = r.name;
      var score = document.createElement('span');
      score.className = 's';
      score.textContent = r.score.toLocaleString('th-TH');
      li.appendChild(rank); li.appendChild(name); li.appendChild(score);
      el.appendChild(li);
    });
  }

  /* ---------------- render ---------------- */

  var lastPhaseKey = '';

  function render() {
    if (!state) return;

    if (!joined || !state.you) {
      show('s-join');
      stopTimerLoop();
      return;
    }

    var you = state.you;
    $('q-name').textContent = you.name;
    $('q-score').textContent = you.score.toLocaleString('th-TH');

    // A new question, or an answer the server has accepted, clears any in-flight send.
    if (state.phase !== 'question' || state.hasAnswered) answerPending = false;

    var key = state.phase + ':' + state.index + ':' + (state.hasAnswered ? 'a' : 'n');

    switch (state.phase) {
      case 'lobby':
        stopTimerLoop();
        $('lobby-name').textContent = you.name;
        $('lobby-count').textContent = state.playerCount;
        lastShownScore = you.score;   // keep the baseline correct across a mid-game rejoin
        show('s-lobby');
        break;

      case 'question':
        if (state.hasAnswered) {
          stopTimerLoop();
          show('s-sent');
          break;
        }
        if (key !== lastPhaseKey) {
          $('q-note').textContent = '';
          $('q-meta').textContent = 'ข้อ ' + state.question.number + ' / ' + state.question.total +
            (state.question.points === 2 ? '  •  คะแนนคูณ 2 ✨' : '');
          $('q-text').textContent = state.question.text;
          renderAnswers(state.question, { locked: false, chosen: state.yourChoice });
        }
        show('s-q');
        startTimerLoop();
        break;

      case 'reveal': {
        stopTimerLoop();
        var isNewReveal = key !== lastPhaseKey;
        var r = state.result || { correct: false, gained: 0, bonus: 0 };
        $('rv-icon').textContent = r.correct ? '🎉' : '💔';
        $('rv-title').textContent = r.correct ? 'ถูกต้อง!' : (r.choice == null ? 'ไม่ทันตอบ!' : 'ยังไม่ใช่!');
        $('rv-title').className = 'big ' + (r.correct ? 'result-good' : 'result-bad');
        var sub = '';
        if (r.correct) {
          sub = '+' + r.gained.toLocaleString('th-TH') + ' คะแนน';
          if (r.bonus) sub += '  (โบนัสตอบถูกติดกัน +' + r.bonus + ')';
        } else if (state.reveal) {
          sub = 'คำตอบที่ถูกคือ: ' + state.reveal.options[state.reveal.correct];
        }
        $('rv-sub').textContent = sub;
        $('rv-rank').textContent = 'อันดับ ' + you.rank + ' จาก ' + state.playerCount;
        if (isNewReveal) {
          animateScore($('rv-total'), lastShownScore, you.score, 700);
          bounce($('rv-rank'));
          if (sub) bounce($('rv-sub'));
        } else {
          setScoreText($('rv-total'), you.score);
        }
        show('s-reveal');
        break;
      }

      case 'scoreboard':
        stopTimerLoop();
        renderBoard($('board-list'), state.scoreboard);
        $('board-you').textContent = 'คุณอยู่อันดับ ' + you.rank + ' • ' +
          you.score.toLocaleString('th-TH') + ' คะแนน';
        lastShownScore = you.score;   // the climb already happened on the reveal screen
        show('s-board');
        break;

      case 'ended':
        stopTimerLoop();
        $('end-icon').textContent = you.rank === 1 ? '🏆' : (you.rank <= 3 ? '🥳' : '❤️');
        $('end-title').textContent = you.rank === 1 ? 'คุณคือแชมป์!' : 'จบเกมแล้ว!';
        $('end-score').textContent = you.score.toLocaleString('th-TH');
        $('end-rank').textContent = 'อันดับ ' + you.rank + ' จาก ' + state.playerCount;
        lastShownScore = you.score;
        renderBoard($('end-list'), state.scoreboard);
        show('s-end');
        break;

      default:
        show('s-join');
    }
    lastPhaseKey = key;
  }

  /* ---------------- socket ---------------- */

  socket.on('hello', function (d) {
    clockOffset = d.serverNow - Date.now();
    var saved = restore();
    if (saved && saved.id && saved.pin) {
      $('in-pin').value = saved.pin;
      $('in-name').value = saved.name || '';
      joinPending = true;
      attemptJoin({ pin: saved.pin, name: saved.name, playerId: saved.id }, function (err) {
        if (!err) return;
        joined = false;
        setConnectionUi(socket.connected);
        show('s-join');
      });
    }
  });

  socket.on('state', function (s) {
    // A join can succeed on the server while its ack is lost or arrives after our
    // timeout. The server always pushes our own state right after a successful join,
    // so adopt the identity from it -- otherwise a retry mints a SECOND player for
    // the same guest, who then sits on the roster forever as a ghost.
    if (!joined && s && s.you && s.you.id) {
      me.id = s.you.id;
      me.name = s.you.name;
      joined = true;
      joinPending = false;
      save();
      $('join-err').textContent = '';
      $('btn-join').textContent = 'เข้าร่วมเกม';
    }
    state = s;
    render();
  });

  socket.on('kicked', function () {
    joined = false;
    me.id = null;
    try { localStorage.removeItem('wq.player'); } catch (e) { /* ignore */ }
    $('join-err').textContent = 'เกมถูกรีเซ็ตแล้ว — เข้าร่วมใหม่ด้วย PIN ใหม่นะ';
    show('s-join');
  });

  socket.on('connect', function () {
    $('conn').textContent = '';
    setConnectionUi(true);
  });
  socket.on('disconnect', function () {
    $('conn').textContent = '⚠️ การเชื่อมต่อหลุด — กำลังต่อใหม่…';
    setConnectionUi(false);
  });
  socket.io.on('reconnect', function () {
    $('conn').textContent = '';
    setConnectionUi(true);
  });

  // Until the socket is up there is nothing useful a tap can do.
  setConnectionUi(false);

  // Phones aggressively suspend background tabs; nudge the socket when we come back.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && !socket.connected) socket.connect();
  });
})();
