/* Wedding Quiz — host / projector screen */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var socket = io({ transports: ['websocket', 'polling'] });

  var state = null;
  var clockOffset = 0;
  var authed = false;
  var raf = null;
  var lastQuestionKey = '';
  var lastPin = '';

  function now() { return Date.now() + clockOffset; }

  // sound.js is optional: if it is missing or the browser has no Web Audio, every
  // cue below quietly does nothing rather than taking the projector down mid-game.
  function snd(cue, a, b) {
    var S = window.WQSound;
    if (S && typeof S[cue] === 'function') { try { S[cue](a, b); } catch (e) { /* never break the screen for audio */ } }
  }

  function soundLabel() {
    var S = window.WQSound;
    var btn = $('c-sound');
    if (!S) { btn.textContent = '🔇 เสียง: ปิด'; return; }
    if (!S.isEnabled()) { btn.textContent = '🔇 เสียง: ปิด'; btn.classList.remove('warn'); return; }
    // A context that is not running means the browser is still blocking audio -
    // say so, rather than showing a speaker icon over silence.
    if (S.state() !== 'running') {
      btn.textContent = '🔇 กดตรงนี้เพื่อเปิดเสียง';
      btn.classList.add('warn');
      return;
    }
    btn.textContent = '🔊 เสียง: เปิด';
    btn.classList.remove('warn');
  }

  function show(id) {
    var screens = document.querySelectorAll('.screen');
    for (var i = 0; i < screens.length; i++) screens[i].classList.remove('active');
    $(id).classList.add('active');
  }

  // Returns whether this call is an actual phase change, not a same-phase re-render
  // (a roster update, a lock toggle) - callers use that to gate one-shot entrance
  // animations (the fade-in itself, the leaderboard cascade, the reveal bar grow)
  // so they play once per arrival instead of replaying on every state broadcast.
  var currentView = '';
  function view(name) {
    var changed = (name !== currentView);
    currentView = name;
    ['lobby', 'q', 'reveal', 'board', 'end'].forEach(function (v) {
      var el = $('v-' + v);
      if (v === name) {
        el.style.display = '';
        if (changed) {
          el.classList.remove('view-in');
          void el.offsetWidth;             // force a reflow so the animation restarts
          el.classList.add('view-in');
        }
      } else {
        el.style.display = 'none';
        el.classList.remove('view-in');
      }
    });
    return changed;
  }

  /* ---------------- auth ---------------- */

  function authenticate(password) {
    socket.emit('host:auth', { password: password }, function (res) {
      if (res && res.ok) {
        authed = true;
        try { sessionStorage.setItem('wq.host', password); } catch (e) { /* ignore */ }
        show('s-main');
        soundLabel();
      } else {
        $('auth-err').textContent = 'รหัสผ่านไม่ถูกต้อง';
        try { sessionStorage.removeItem('wq.host'); } catch (e) { /* ignore */ }
      }
    });
  }

  $('btn-auth').addEventListener('click', function () { snd('unlock'); authenticate($('pw').value); });
  $('pw').addEventListener('keydown', function (e) { if (e.key === 'Enter') authenticate($('pw').value); });

  /* ---------------- controls ---------------- */

  $('c-start').addEventListener('click', function () {
    if (state && state.playerCount === 0 && !confirm('ยังไม่มีผู้เล่นเลย เริ่มเกมเลยไหม?')) return;
    socket.emit('host:start');
  });
  if (window.WQSound && window.WQSound.onUnlockChange) window.WQSound.onUnlockChange(soundLabel);

  $('c-sound').addEventListener('click', function () {
    if (!window.WQSound) return;
    // The click itself is a user gesture, so this doubles as an unlock.
    window.WQSound.unlock();
    if (!window.WQSound.isEnabled() || window.WQSound.state() === 'running') {
      window.WQSound.setEnabled(!window.WQSound.isEnabled());
    }
    soundLabel();
    // Re-open the bed for whatever is on screen right now.
    if (window.WQSound.isEnabled() && state && state.phase === 'lobby') snd('lobby');
  });

  $('c-skip').addEventListener('click', function () { socket.emit('host:skip'); });
  $('c-next').addEventListener('click', function () { socket.emit('host:next'); });
  $('c-lock').addEventListener('click', function () {
    socket.emit('host:lock', { locked: !(state && state.joinLocked) });
  });
  // Two plain buttons, one confirm each. The old version nested two confirm()
  // dialogs whose OK/Cancel wording was easy to get backwards under pressure.
  $('c-back').addEventListener('click', function () {
    if (!confirm('กลับไปห้องรอและล้างคะแนนทั้งหมด?\n\nผู้เล่นเดิมและ PIN เดิมยังอยู่ ไม่ต้องเข้าใหม่')) return;
    socket.emit('host:reset', { keepPlayers: true });
  });

  $('c-reset').addEventListener('click', function () {
    if (!confirm('ล้างทุกอย่าง?\n\nผู้เล่นทั้งหมดจะหลุดออก และได้ PIN ใหม่ — ทุกคนต้องเข้าร่วมใหม่')) return;
    socket.emit('host:reset', { keepPlayers: false });
  });

  /* ---------------- guest manager ---------------- */
  // The in-game scoreboard only shows the top 8, so kicking from there cannot reach
  // most of a 150-guest roster. This panel lists everyone, in any phase.

  function guestsOpen() { return !$('guests-panel').hidden; }

  function renderGuests() {
    if (!guestsOpen()) return;
    var players = (state && state.players) ? state.players.slice() : [];
    var q = $('gp-filter').value.trim().toLowerCase();
    if (q) players = players.filter(function (p) { return p.name.toLowerCase().indexOf(q) >= 0; });
    players.sort(function (a, b) { return a.name.localeCompare(b.name, 'th'); });

    $('gp-count').textContent = (state && state.playerCount) || 0;
    var list = $('gp-list');
    list.innerHTML = '';

    if (!players.length) {
      var empty = document.createElement('div');
      empty.className = 'gp-empty';
      empty.textContent = q ? 'ไม่พบชื่อนี้' : 'ยังไม่มีผู้เล่น';
      list.appendChild(empty);
      return;
    }

    players.forEach(function (p) {
      var row = document.createElement('div');
      row.className = 'gp-row' + (p.connected ? '' : ' off');

      var name = document.createElement('span');
      name.textContent = p.name + (p.connected ? '' : ' (หลุด)');

      var score = document.createElement('span');
      score.className = 'sc';
      score.textContent = (p.score || 0).toLocaleString('th-TH');

      var x = document.createElement('button');
      x.className = 'kick';
      x.textContent = '✕';
      x.title = 'เอาชื่อนี้ออก';
      x.addEventListener('click', function () {
        if (confirm('เอา "' + p.name + '" ออกจากเกม?')) socket.emit('host:kick', { id: p.id });
      });

      row.appendChild(name); row.appendChild(score); row.appendChild(x);
      list.appendChild(row);
    });
  }

  $('c-guests').addEventListener('click', function () {
    $('guests-panel').hidden = false;
    $('gp-filter').value = '';
    renderGuests();
    $('gp-filter').focus();
  });
  $('gp-close').addEventListener('click', function () { $('guests-panel').hidden = true; });
  $('gp-filter').addEventListener('input', renderGuests);
  $('guests-panel').addEventListener('click', function (e) {
    if (e.target === $('guests-panel')) $('guests-panel').hidden = true;
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && guestsOpen()) { $('guests-panel').hidden = true; return; }
    if (!authed || e.target.tagName === 'INPUT') return;
    // Never let a stray Space advance the game while the host is managing guests.
    if (guestsOpen()) return;
    if (e.code === 'Space') {
      e.preventDefault();
      var p = state && state.phase;
      if (p === 'lobby' || p === 'ended') socket.emit('host:start');
      else socket.emit('host:next');
    } else if (e.key === 's' || e.key === 'S') {
      socket.emit('host:skip');
    } else if (e.key === 'f' || e.key === 'F') {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen();
    }
  });

  /* ---------------- lobby ---------------- */

  function joinUrl() {
    return location.origin;
  }

  function renderLobby() {
    $('join-url').textContent = joinUrl().replace(/^https?:\/\//, '');
    $('pin').textContent = state.pin;

    if (state.pin !== lastPin) {
      lastPin = state.pin;
      var target = joinUrl() + '/?pin=' + state.pin;
      fetch('/api/qr?text=' + encodeURIComponent(target))
        .then(function (r) { return r.text(); })
        .then(function (svg) { $('qr').innerHTML = svg; })
        .catch(function () { $('qr').style.display = 'none'; });
    }

    var chips = $('chips');
    chips.innerHTML = '';
    state.players.forEach(function (p) {
      var d = document.createElement('div');
      d.className = 'chip' + (p.connected ? '' : ' off');
      d.textContent = p.name;
      var x = document.createElement('button');
      x.textContent = '✕';
      x.title = 'เตะออก';
      x.addEventListener('click', function () { socket.emit('host:kick', { id: p.id }); });
      d.appendChild(x);
      chips.appendChild(d);
    });

    $('lobby-hint').textContent = state.joinLocked
      ? '🔒 ปิดรับผู้เล่นแล้ว'
      : (state.playerCount ? 'พร้อมแล้ว! กด "เริ่มเกม" ได้เลย' : 'รอผู้เล่นเข้าร่วม…');
  }

  /* ---------------- question ---------------- */

  function renderQuestion() {
    var q = state.question;
    var key = 'q' + state.index;
    if (key !== lastQuestionKey) {
      lastQuestionKey = key;
      $('q-num').textContent = 'ข้อ ' + q.number + ' / ' + q.total +
        (q.points === 2 ? '  •  คะแนนคูณ 2 ✨' : '');
      $('q-text').textContent = q.text;

      var box = $('q-answers');
      box.innerHTML = '';
      box.className = 'answers host' + (q.options.length <= 2 ? ' two' : '');
      q.options.forEach(function (text, i) {
        var d = document.createElement('div');
        d.className = 'answer';
        d.dataset.a = i;
        var s = document.createElement('span');
        s.className = 'shape';
        s.dataset.s = i;
        d.appendChild(s);
        var t = document.createElement('span');
        t.textContent = text;
        d.appendChild(t);
        box.appendChild(d);
      });
    }
    $('q-answered').textContent = state.answered;
    $('q-total').textContent = state.playerCount;
  }

  var answersOpenCued = false;
  var timeUpCued = false;

  function timerLoop() {
    if (raf) cancelAnimationFrame(raf);
    var tick = function () {
      if (!state || state.phase !== 'question') { $('clock').style.display = 'none'; return; }
      var t = now();
      $('clock').style.display = '';
      if (t < state.startsAt) {
        var readyLeft = Math.max(1, Math.ceil((state.startsAt - t) / 1000));
        $('clock').textContent = String(readyLeft);
        $('q-answers').style.visibility = 'hidden';
        $('q-bar').style.width = '100%';
        snd('readyBeep', readyLeft);
      } else {
        $('q-answers').style.visibility = 'visible';
        var total = state.endsAt - state.startsAt;
        var left = Math.max(0, state.endsAt - t);
        $('clock').textContent = String(Math.ceil(left / 1000));
        $('q-bar').style.width = (total > 0 ? (left / total) * 100 : 0) + '%';
        if (!answersOpenCued) { answersOpenCued = true; snd('questionStart'); }
        if (left <= 0) {
          if (!timeUpCued) { timeUpCued = true; snd('timeUp'); }
        } else {
          snd('tick', left, total);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  /* ---------------- reveal ---------------- */

  function renderReveal(animate) {
    var r = state.reveal;
    if (!r) return;
    $('rv-text').textContent = r.text;
    var max = Math.max(1, Math.max.apply(null, r.counts));
    var box = $('rv-bars');
    box.innerHTML = '';
    box.className = 'bars' + (r.options.length <= 2 ? ' two' : '');
    var fills = [];
    r.options.forEach(function (text, i) {
      var bar = document.createElement('div');
      bar.className = 'bar' + (i === r.correct ? '' : ' wrong');
      bar.dataset.a = i;

      var tick = document.createElement('div');
      tick.className = 'tick';
      tick.textContent = i === r.correct ? '✔' : '';

      var n = document.createElement('div');
      n.className = 'n';
      n.textContent = r.counts[i];

      var pct = Math.round((r.counts[i] / max) * 100);
      var fill = document.createElement('div');
      fill.className = 'fill';
      fill.style.height = animate ? '0%' : pct + '%';
      fills.push({ el: fill, pct: pct });

      var lbl = document.createElement('div');
      lbl.className = 'lbl';
      lbl.textContent = text;

      bar.appendChild(tick); bar.appendChild(n); bar.appendChild(fill); bar.appendChild(lbl);
      box.appendChild(bar);
    });
    if (animate) {
      void box.offsetHeight;   // flush the 0% height so the CSS transition below has
                                // something to grow from, instead of jumping straight up
      fills.forEach(function (f) { f.el.style.height = f.pct + '%'; });
    }
    var correctCount = r.counts[r.correct] || 0;
    $('rv-sub').textContent = 'ตอบถูก ' + correctCount + ' คน' +
      (r.noAnswer ? '  •  ไม่ได้ตอบ ' + r.noAnswer + ' คน' : '');
  }

  /* ---------------- boards ---------------- */

  function renderList(el, rows, allowKick, animate) {
    el.innerHTML = '';
    rows.forEach(function (r, i) {
      var li = document.createElement('li');
      if (animate) {
        li.className = 'row-in';
        li.style.animationDelay = Math.min(i * 35, 400) + 'ms';
      }
      var rank = document.createElement('span');
      rank.className = 'r';
      rank.textContent = r.rank;
      var name = document.createElement('span');
      name.textContent = r.name;
      var score = document.createElement('span');
      score.className = 's';
      score.textContent = r.score.toLocaleString('th-TH');
      li.appendChild(rank); li.appendChild(name); li.appendChild(score);
      // Someone will type something rude; before this, the only way to remove a name
      // was in the lobby, so it would sit on the projector for the rest of the night.
      if (allowKick) {
        var x = document.createElement('button');
        x.className = 'kick';
        x.textContent = '✕';
        x.title = 'เอาชื่อนี้ออก';
        x.addEventListener('click', function () {
          if (confirm('เอา "' + r.name + '" ออกจากเกม?')) socket.emit('host:kick', { id: r.id });
        });
        li.appendChild(x);
      }
      el.appendChild(li);
    });
  }

  /* ---------------- the winners moment ---------------- */

  // Confetti, drawn rather than downloaded. It runs for a few seconds, then stops
  // itself and hides the canvas so nothing keeps burning CPU behind the podium.
  var confettiRaf = null;
  var confettiStop = null;

  function confetti(durationMs) {
    var cv = $('confetti');
    if (!cv || !cv.getContext) return;
    if (confettiRaf) { cancelAnimationFrame(confettiRaf); confettiRaf = null; }

    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.floor(window.innerWidth * dpr);
    cv.height = Math.floor(window.innerHeight * dpr);
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cv.style.display = 'block';

    var W = window.innerWidth, H = window.innerHeight;
    var COLOURS = ['#e8c07a', '#f3d698', '#ffffff', '#e04b53', '#2b7fd4', '#2f9e6b', '#d9a326'];
    var bits = [];
    for (var i = 0; i < 160; i++) {
      bits.push({
        x: W * (0.15 + Math.random() * 0.7),
        y: H + Math.random() * 120,
        vx: (Math.random() - 0.5) * 5.5,
        vy: -(9 + Math.random() * 9),
        w: 7 + Math.random() * 9,
        h: 10 + Math.random() * 14,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.3,
        c: COLOURS[(Math.random() * COLOURS.length) | 0]
      });
    }

    var started = null;
    var step = function (ts) {
      if (started === null) started = ts;
      var elapsed = ts - started;
      ctx.clearRect(0, 0, W, H);
      for (var j = 0; j < bits.length; j++) {
        var b = bits[j];
        b.vy += 0.32;                 // gravity
        b.vx *= 0.995;
        b.x += b.vx; b.y += b.vy; b.rot += b.vr;
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.rotate(b.rot);
        ctx.fillStyle = b.c;
        ctx.globalAlpha = Math.max(0, 1 - elapsed / durationMs);
        ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
        ctx.restore();
      }
      if (elapsed < durationMs) { confettiRaf = requestAnimationFrame(step); }
      else { ctx.clearRect(0, 0, W, H); cv.style.display = 'none'; confettiRaf = null; }
    };
    confettiRaf = requestAnimationFrame(step);
    if (confettiStop) clearTimeout(confettiStop);
    confettiStop = setTimeout(stopConfetti, durationMs + 800);
  }

  function stopConfetti() {
    if (confettiRaf) { cancelAnimationFrame(confettiRaf); confettiRaf = null; }
    if (confettiStop) { clearTimeout(confettiStop); confettiStop = null; }
    var cv = $('confetti');
    if (!cv) return;
    if (cv.getContext && cv.width) cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
    cv.style.display = 'none';
  }

  // Sound and vision on the same clock: third at 0, second at 1.1s, the winner at
  // 2.2s with the fanfare and the confetti. The CSS delays match these numbers.
  var celebrationTimers = [];

  function celebrate() {
    cancelCelebration();
    celebrationTimers.push(setTimeout(function () { snd('podiumRise', 3); }, 250));
    celebrationTimers.push(setTimeout(function () { snd('podiumRise', 2); }, 1350));
    celebrationTimers.push(setTimeout(function () {
      snd('podium');
      confetti(5200);
    }, 2450));
  }

  function cancelCelebration() {
    for (var i = 0; i < celebrationTimers.length; i++) clearTimeout(celebrationTimers[i]);
    celebrationTimers = [];
    stopConfetti();
  }

  var MEDAL = ['👑', '🥈', '🥉'];   // crown, silver, bronze

  // animate=true only on the render that actually opens the end screen, so the
  // reveal plays once rather than restarting on any later broadcast.
  function renderPodium(rows, animate) {
    var pod = $('podium');
    pod.innerHTML = '';
    [1, 0, 2].forEach(function (i) {              // 2nd, 1st, 3rd - visual order
      var r = rows[i];
      if (!r) return;
      var d = document.createElement('div');
      d.className = 'pod p' + (i + 1) + (animate ? ' rise' : '');

      var medal = document.createElement('div');
      medal.className = 'medal';
      medal.textContent = MEDAL[i];

      var nm = document.createElement('div');
      nm.className = 'nm';
      nm.textContent = r.name + ' — ' + r.score.toLocaleString('th-TH');

      var blk = document.createElement('div');
      blk.className = 'blk';
      blk.textContent = i + 1;

      d.appendChild(medal); d.appendChild(nm); d.appendChild(blk);
      pod.appendChild(d);
    });
  }

  /* ---------------- render ---------------- */

  var LABELS = {
    lobby: 'ห้องรอ', question: 'กำลังเล่น', reveal: 'เฉลย',
    scoreboard: 'อันดับ', ended: 'จบเกม',
  };

  // The picture reaches the projector only (state.questionImage is absent from every
  // guest payload). A dead https URL must not leave a broken-image icon on a 3m screen,
  // so both slots fail closed.
  // A picture that will not load (a pasted link that 404s is the likely case) must
  // leave no trace: no broken-image icon, and no leftover .hasimg shrinking the
  // question text around a gap. Remembering the failed URL matters because a later
  // state broadcast - a lock toggle, a host reconnect - re-runs paintImage with the
  // same src, which fires no fresh error event to hide it again.
  var failedImages = {};

  ['q-img', 'rv-img'].forEach(function (id) {
    $(id).addEventListener('error', function () {
      var img = $(id);
      failedImages[img.getAttribute('src') || ''] = true;
      img.hidden = true;
      var view = img.closest('.grow');
      if (view) view.classList.remove('hasimg');
    });
  });

  function paintImage(imgId, viewId) {
    var img = $(imgId);
    var src = state.questionImage || '';
    var usable = !!src && !failedImages[src];

    if (!src) {
      img.hidden = true;
      img.removeAttribute('src');
    } else {
      if (img.getAttribute('src') !== src) img.src = src;
      img.hidden = !usable;
    }
    $(viewId).classList.toggle('hasimg', usable);
  }

  function render() {
    if (!state || !state.isHost) return;

    $('phase-label').textContent = LABELS[state.phase] || state.phase;
    $('st-players').textContent = state.playerCount;
    $('st-q').textContent = (state.phase === 'lobby' ? 0 : Math.min(state.index + 1, state.questionCount)) +
      '/' + state.questionCount;
    $('c-lock').textContent = state.joinLocked ? '🔓 เปิดรับผู้เล่น' : '🔒 ปิดรับผู้เล่น';
    soundLabel();

    // Start must be reachable whenever a game is not actually running, otherwise a
    // finished or interrupted game strands the host with no visible way forward.
    var canStart = state.phase === 'lobby' || state.phase === 'ended';
    $('c-start').style.display = canStart ? '' : 'none';
    $('c-start').textContent = state.phase === 'ended' ? '▶ เล่นใหม่อีกรอบ' : '▶ เริ่มเกม';
    $('c-back').style.display = (state.phase === 'lobby') ? 'none' : '';
    $('c-skip').disabled = state.phase !== 'question';
    $('c-next').disabled = !(state.phase === 'reveal' || state.phase === 'scoreboard');
    $('c-next').textContent = (state.phase === 'scoreboard' && state.index + 1 >= state.questionCount)
      ? 'จบเกม 🏁' : 'ถัดไป →';

    if (state.phase !== 'question' && raf) { cancelAnimationFrame(raf); raf = null; $('clock').style.display = 'none'; }

    switch (state.phase) {
      case 'lobby':
        lastQuestionKey = '';
        if (view('lobby')) { cancelCelebration(); snd('lobby'); }
        renderLobby();
        break;
      case 'question': {
        if (view('q')) { cancelCelebration(); answersOpenCued = false; timeUpCued = false; }
        paintImage('q-img', 'v-q');
        renderQuestion();
        timerLoop();
        break;
      }
      case 'reveal': {
        var enteredReveal = view('reveal');
        if (enteredReveal) snd('reveal');
        paintImage('rv-img', 'v-reveal');
        renderReveal(enteredReveal);
        break;
      }
      case 'scoreboard': {
        var enteredBoard = view('board');
        if (enteredBoard) snd('scoreboard');
        renderList($('lb'), state.scoreboard.slice(0, 8), true, enteredBoard);
        break;
      }
      case 'ended': {
        var enteredEnd = view('end');
        renderPodium(state.scoreboard.slice(0, 3), enteredEnd);
        if (enteredEnd) celebrate();
        break;
      }
      default:
        break;
    }
  }

  /* ---------------- socket ---------------- */

  // Free hosting tiers (Render, Koyeb, …) sleep a service after ~15 minutes with no
  // HTTP requests, and an idle WebSocket does not reliably count as one. While the
  // host screen is open we poke /healthz every 4 minutes so the service never idles
  // out from under the party.
  setInterval(function () {
    fetch('/healthz', { cache: 'no-store' }).catch(function () { /* offline; socket handles it */ });
  }, 4 * 60 * 1000);

  socket.on('hello', function (d) {
    clockOffset = d.serverNow - Date.now();
    var saved = null;
    try { saved = sessionStorage.getItem('wq.host'); } catch (e) { /* ignore */ }
    if (saved) authenticate(saved);
  });

  socket.on('state', function (s) { state = s; render(); renderGuests(); });

  // Guests arriving/leaving come through as deltas rather than a full state dump,
  // so a 150-person join rush stays cheap on the server (see server note).
  socket.on('roster', function (r) {
    if (!state || !state.players) return;
    var id = r.player.id;
    var at = -1;
    for (var i = 0; i < state.players.length; i++) {
      if (state.players[i].id === id) { at = i; break; }
    }
    if (r.op === 'remove') {
      if (at >= 0) state.players.splice(at, 1);
    } else if (at >= 0) {
      state.players[at] = r.player;
    } else {
      state.players.push(r.player);
    }
    state.playerCount = r.playerCount;
    $('st-players').textContent = r.playerCount;
    if (state.phase === 'lobby') renderLobby();
    // A guest admitted mid-question changes the denominator on the projector, and
    // `tally` only fires when someone answers -- so update it here too.
    if (state.phase === 'question') $('q-total').textContent = r.playerCount;
    renderGuests();
  });

  // Cheap incremental update while a question is live (see server note).
  socket.on('tally', function (t) {
    if (!state || state.phase !== 'question') return;
    state.answered = t.answered;
    state.playerCount = t.playerCount;
    $('q-answered').textContent = t.answered;
    $('q-total').textContent = t.playerCount;
    $('st-players').textContent = t.playerCount;
  });
})();
