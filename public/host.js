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
    if (!S) { btn.textContent = '🔇'; btn.title = 'เสียง: ปิด'; return; }
    if (!S.isEnabled()) { btn.textContent = '🔇'; btn.title = 'เสียง: ปิด (กดเพื่อเปิด)'; btn.classList.remove('warn'); return; }
    // A context that is not running means the browser is still blocking audio -
    // say so, rather than showing a speaker icon over silence.
    if (S.state() !== 'running') {
      btn.textContent = '🔇 กดเปิดเสียง';
      btn.title = 'เบราว์เซอร์ยังบล็อกเสียงอยู่ กดเพื่อเปิด';
      btn.classList.add('warn');
      return;
    }
    btn.textContent = '🔊';
    btn.title = 'เสียง: เปิด (กดเพื่อปิด)';
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
    ['lobby', 'rules', 'q', 'reveal', 'board', 'end'].forEach(function (v) {
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

  // Lobby music: each click moves to the next style and, in the lobby, plays it
  // straight away so the choice can be made by ear.
  var musicLabelTimer = null;
  function musicLabel() {
    var S = window.WQSound;
    if (!S || !S.lobbyStyles) { $('c-music').hidden = true; return; }
    var cur = S.lobbyStyle();
    var name = S.lobbyStyles().filter(function (x) { return x.id === cur; })[0];
    var label = 'เพลงห้องรอ: ' + (name ? name.name : cur);
    $('c-music').title = label + ' (กดเพื่อเปลี่ยน)';
    $('c-music').setAttribute('aria-label', label);
  }
  musicLabel();
  $('c-music').addEventListener('click', function () {
    var S = window.WQSound;
    if (!S || !S.lobbyStyles) return;
    var list = S.lobbyStyles().map(function (x) { return x.id; });
    S.setLobbyStyle(list[(list.indexOf(S.lobbyStyle()) + 1) % list.length]);
    musicLabel();
    // An icon alone can't say which song: spell it out for a moment.
    var cur = S.lobbyStyle();
    var picked = S.lobbyStyles().filter(function (x) { return x.id === cur; })[0];
    $('c-music').textContent = '🎵 ' + (picked ? picked.name : cur);
    $('c-music').classList.add('wide');
    clearTimeout(musicLabelTimer);
    musicLabelTimer = setTimeout(function () { $('c-music').textContent = '🎵'; $('c-music').classList.remove('wide'); }, 2500);
    S.unlock();
    if (S.isEnabled() && state && state.phase === 'lobby') snd('lobby');
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
    if (!confirm('ล้างทุกอย่าง?\n\nผู้เล่นทั้งหมดจะหลุดออก และได้ PIN ใหม่ ทุกคนต้องเข้าร่วมใหม่')) return;
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

  /* ---------------- the world behind the screen ---------------- */

  // The couple's chosen order: the lobby is the wedding arch (a calm backdrop for the group photo),
  // then one scene per question - valley, reception, beach, wine gazebo, Golden
  // Mount, wedding ceremony, sea. Questions are split into equal stretches
  // over this list (with 7 questions, one scene each). The final leaderboard is
  // the city at night, and the podium is the night party.
  var DAY = ['valley', 'noon', 'beach', 'sunset', 'goldenmount', 'morning', 'sea'];
  var SCENE_FX = { lobby: 'petals', morning: 'petals', sea: 'none', noon: 'none', valley: 'none',
                   sunset: 'petals', beach: 'none', goldenmount: 'none', city: 'none', night: 'fireflies' };
  var currentScene = 'lobby';

  function sceneFor(s) {
    if (!s || s.phase === 'lobby' || s.phase === 'rules') return 'lobby';
    if (s.phase === 'ended') return 'night';
    var total = Math.max(1, s.questionCount || 1);
    if (s.phase === 'scoreboard' && (s.index || 0) >= total - 1) return 'city';
    return DAY[Math.min(DAY.length - 1, Math.floor((s.index || 0) * DAY.length / total))];
  }

  function setScene(key) {
    if (key === currentScene) return;
    currentScene = key;
    var scenes = document.querySelectorAll('#world .scene');
    for (var i = 0; i < scenes.length; i++) {
      scenes[i].classList.toggle('on', scenes[i].getAttribute('data-k') === key);
    }
    $('world').setAttribute('data-fx', SCENE_FX[key] || 'none');
  }

  // One fixed handful of particles, restyled per scene by CSS - never rebuilt.
  (function seedParticles() {
    var fx = $('fx');
    for (var i = 0; i < 16; i++) {
      var p = document.createElement('i');
      p.style.left = (Math.random() * 100) + '%';
      p.style.bottom = (8 + Math.random() * 45) + '%';     // only used by floating fireflies
      p.style.setProperty('--dx', (Math.random() * 16 - 4) + 'vw');
      p.style.animationDuration = (9 + Math.random() * 9) + 's';
      p.style.animationDelay = -(Math.random() * 18) + 's';
      fx.appendChild(p);
    }
  })();

  /* ---------------- lobby ---------------- */

  function joinUrl() {
    return location.origin;
  }

  /* The guests as a crowd of little pixel people (pixelfolk.js), facing the
     camera and breathing in place.
       lobby    : a group photo - rows stacked into a triangle, the couple
                  front and centre, each new guest popping into the next spot.
       the game : the same guests stand in two strips down the left and right
                  of the screen (question, reveal, leaderboard).
     One element per guest, kept alive and only moved, so a re-render or a
     reconnect never redraws anyone. A cheap hash of the player's id picks
     their look, so the same guest always looks the same. */
  var crowdNodes = {};         // player id -> element
  var coupleNode = null;
  var fieldPrimed = false;
  var crowdMode = '';          // 'photo' | 'sides' | ''
  var bellImg = '';

  function hashId(id) {
    var h = 0;
    for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  // Sprites scale by whole pixels where they can, so art pixels stay square.
  function pixelScale() { return Math.max(2, Math.floor(window.innerHeight / 320)); }
  function setPixelScale() {
    document.documentElement.style.setProperty('--ps', pixelScale());
  }
  setPixelScale();
  window.addEventListener('resize', function () { setPixelScale(); layoutSoon(); });

  function addParts(el, withKick, id) {
    var bell = document.createElement('i');
    bell.className = 'bell';
    el.appendChild(bell);
    var wave = document.createElement('i');
    wave.className = 'wave';
    el.appendChild(wave);
    var tag = document.createElement('div');
    tag.className = 'tag';
    el.appendChild(tag);
    if (withKick) {
      var kick = document.createElement('button');
      kick.className = 'kick';
      kick.title = 'เตะออก';
      kick.addEventListener('click', function () { socket.emit('host:kick', { id: id }); });
      el.appendChild(kick);
    }
  }

  function makePose(p) {
    var h = hashId(p.id);
    var el = document.createElement('div');
    el.className = 'pose';
    var body = document.createElement('div');
    body.className = 'body';
    var sprite = document.createElement('div');
    sprite.className = 'sprite';
    sprite.style.backgroundImage = 'url(' + window.PixelFolk.makeSheet(h, window.PixelFolk.choiceForce(p.look), 'front').toDataURL() + ')';
    sprite.style.animationDelay = -((h % 17) / 10) + 's';                       // nobody breathes in step
    body.appendChild(sprite);
    el.appendChild(body);
    addParts(el, true, p.id);
    return el;
  }

  // The bride and groom, front and centre of the photo. Not players: no kick.
  function makeCouple() {
    var el = document.createElement('div');
    el.className = 'pose couple';
    var body = document.createElement('div');
    body.className = 'body';
    window.PixelFolk.coupleSheets('front').forEach(function (sheet) {
      var sprite = document.createElement('div');
      sprite.className = 'sprite';
      sprite.style.backgroundImage = 'url(' + sheet.toDataURL() + ')';
      body.appendChild(sprite);
    });
    el.appendChild(body);
    addParts(el, false);
    el.querySelector('.tag').textContent = '💍 เจ้าสาว & เจ้าบ่าว';
    return el;
  }

  function guestOrder() {
    return state.players.slice().sort(function (a, b) {
      return ((a.joinedAt || 0) - (b.joinedAt || 0)) || (a.id < b.id ? -1 : 1);
    });
  }

  // Make sure every guest has an element (and only current guests do).
  function syncCrowd() {
    if (!state || !state.players) return;
    if (!bellImg && window.PixelFolk) {
      bellImg = window.PixelFolk.namedIcon('bell').toDataURL();
      document.documentElement.style.setProperty('--bell-img', 'url(' + bellImg + ')');
    }
    var field = $('field');
    if (!coupleNode) { coupleNode = makeCouple(); field.appendChild(coupleNode); }
    var seen = {};
    state.players.forEach(function (p) {
      seen[p.id] = true;
      var el = crowdNodes[p.id];
      if (!el) {
        el = makePose(p);
        crowdNodes[p.id] = el;
        (crowdMode === 'sides' ? $('crowd-l') : field).appendChild(el);
        if (fieldPrimed && state.phase === 'lobby') {
          snd('guestJoin');
          el.classList.add('new', 'fresh');             // pops into the photo, name up for a few seconds
          setTimeout(function () { el.classList.remove('new'); }, 700);
          setTimeout(function () { el.classList.remove('fresh'); }, 4500);
        }
      }
      el.classList.toggle('off', !p.connected);
      el.classList.toggle('armed', p.bell === 'armed');
      el.querySelector('.tag').textContent = p.name;
    });
    for (var id in crowdNodes) {
      if (!seen[id]) { crowdNodes[id].remove(); delete crowdNodes[id]; }
    }
    fieldPrimed = true;
    layoutSoon();
  }

  var layoutTimer = null;
  function layoutSoon() {
    if (layoutTimer) return;
    layoutTimer = setTimeout(function () { layoutTimer = null; layoutCrowd(); }, 30);
  }

  function modeFor(s) {
    if (!s) return '';
    if (s.phase === 'lobby') return 'photo';
    if (s.phase === 'question' || s.phase === 'reveal' || s.phase === 'scoreboard') return 'sides';
    return '';
  }

  // Move an element without letting it fly across the screen from its old box.
  function placeIn(el, box) {
    if (el.parentNode === box) return;
    el.classList.add('jump');
    el._pos = '';
    box.appendChild(el);
  }
  function moveTo(el, x, y, z) {
    var pos = Math.round(x) + 'px ' + Math.round(y) + 'px';
    if (el._pos !== pos) {
      if (!el._pos) el.classList.add('jump');      // first spot: appear there, don't glide in from the corner
      el._pos = pos; el.style.translate = pos;
    }
    el.style.zIndex = z;
  }

  function layoutCrowd() {
    if (!state || !state.players) return;
    crowdMode = modeFor(state);
    var sides = crowdMode === 'sides' && state.players.length > 0;
    document.body.classList.toggle('crowd-on', sides);
    var guests = guestOrder();
    if (crowdMode === 'photo') layoutPhoto(guests);
    else if (sides) layoutSides(guests);
    setTimeout(function () {
      for (var id in crowdNodes) crowdNodes[id].classList.remove('jump');
    }, 60);
  }

  // Rows from the front: B, B-d, B-2d ... spots (B even, so the couple has the
  // two middle spots of the front row). The smallest triangle that fits everyone.
  function photoRows(n, d) {
    for (var B = 2; ; B += 2) {
      var caps = [], cap = 0;
      for (var c = B; c >= 1; c -= d) { caps.push(c); cap += c; }
      if (cap >= n) return caps;
    }
  }
  // Spots in a row, middle first, then out to both sides.
  function middleOut(c) {
    var ks = [];
    for (var k = 0; k < c; k++) ks.push(k);
    var mid = (c - 1) / 2;
    return ks.sort(function (a, b) { return (Math.abs(a - mid) - Math.abs(b - mid)) || (a - b); });
  }

  function layoutPhoto(guests) {
    var field = $('field');
    guests.forEach(function (p) { placeIn(crowdNodes[p.id], field); });
    var W = field.clientWidth, H = field.clientHeight;
    if (!W || !H) return;
    // Room for a name over the back row, and for the couple's caption under their feet.
    var tagRoom = Math.max(22, window.innerHeight * 0.015 * 1.6 + 8);
    // A steep triangle while the crowd is small; a wider, flatter one when a
    // big crowd would otherwise shrink to fit the height.
    var caps = null, s = 0;
    for (var d = 3; d <= 9; d++) {
      var cs = photoRows(guests.length + 2, d);
      var sc = Math.min(pixelScale() + 1,
        (W - 16) / (18 * (0.8 * (cs[0] - 1) + 1)),
        (H - 2 * tagRoom) / (35 * (1.15 + 0.4 * (cs.length - 1))));
      if (sc > s + 0.2) { s = sc; caps = cs; }
    }
    var B = caps[0], R = caps.length;
    s = Math.max(1, Math.floor(s * 4) / 4);
    field.style.setProperty('--s', s);
    var sw = 18 * s, sh = 35 * s, u = sw * 0.8, v = sh * 0.4;
    var foot = H - sh - tagRoom;

    moveTo(coupleNode, W / 2 - sw, foot, 1000);
    var spots = [];
    caps.forEach(function (c, row) {
      middleOut(c).forEach(function (k) {
        if (row === 0 && (k === c / 2 - 1 || k === c / 2)) return;   // the couple's two spots
        spots.push({ x: W / 2 + (k - (c - 1) / 2) * u - sw / 2, y: foot - row * v, z: (R - row) * 10 });
      });
    });
    guests.forEach(function (p, i) {
      var sp = spots[i];
      moveTo(crowdNodes[p.id], sp.x, sp.y, sp.z);
    });
  }

  function layoutSides(guests) {
    var hdr = document.querySelector('#s-main .hdr').getBoundingClientRect();
    var ctl = document.querySelector('#s-main .controls').getBoundingClientRect();
    var top = hdr.bottom + 8, H = Math.max(120, ctl.top - 8 - top);
    var W = Math.round(Math.max(80, Math.min(230, window.innerWidth * 0.1)));
    var pad = parseFloat(getComputedStyle(document.querySelector('body > .wrap')).paddingLeft) || 0;
    document.body.style.setProperty('--crowd-pad', Math.max(0, W + 14 - pad) + 'px');
    var L = [], Rt = [];
    guests.forEach(function (p, i) { (i % 2 ? Rt : L).push(p); });
    [[$('crowd-l'), L, false], [$('crowd-r'), Rt, true]].forEach(function (side) {
      var box = side[0];
      box.style.top = top + 'px';
      box.style.height = H + 'px';
      box.style.width = W + 'px';
      side[1].forEach(function (p) { placeIn(crowdNodes[p.id], box); });
      placeStrip(box, side[1], W, H, side[2]);
    });
  }

  // A standing crowd in a narrow strip: front row at the bottom, each row
  // behind half a person to the side so faces show between heads.
  function placeStrip(box, list, W, H, mirror) {
    var m = list.length;
    if (!m) return;
    var best = null;
    for (var c = 1; c <= 12; c++) {
      var rows = Math.ceil(m / c);
      var sW = W / (18 * (0.8 * (c - 1) + 1 + (rows > 1 ? 0.4 : 0)));
      var sH = H / (35 * (1 + 0.5 * (rows - 1)));
      var sc = Math.min(pixelScale(), sW, sH);
      if (!best || sc > best.s + 1e-6) best = { s: sc, c: c, rows: rows };
    }
    var s = Math.max(0.75, Math.floor(best.s * 4) / 4);
    box.style.setProperty('--s', s);
    var sw = 18 * s, sh = 35 * s, u = sw * 0.8, v = sh * 0.5, cols = best.c;
    var blockW = (cols - 1) * u + sw + (best.rows > 1 ? u / 2 : 0);
    var x0 = (W - blockW) / 2;
    list.forEach(function (p, j) {
      var r = Math.floor(j / cols), k = j % cols;
      var x = x0 + k * u + (r % 2 ? u / 2 : 0);
      if (mirror) x = W - x - sw;
      moveTo(crowdNodes[p.id], x, H - sh - r * v, 1000 - r);
    });
  }

  /* Ring the bell: the guest's little person jumps, the bell swings over their
     head and a gold ring spreads out, with their name. While the bet stands a
     small bell stays over their head (.armed). If nobody can see them right
     now (the rules screen), a note pops up instead. */
  function ringEffect(id, name) {
    var el = crowdNodes[id];
    var visible = el && (crowdMode === 'photo' || (crowdMode === 'sides' && document.body.classList.contains('crowd-on')));
    if (!visible) { bellToast(name); return; }
    el.classList.remove('ring');
    void el.offsetWidth;
    el.classList.add('ring');
    clearTimeout(el._ringT);
    el._ringT = setTimeout(function () { el.classList.remove('ring'); }, 2400);
  }

  function bellToast(name) {
    var box = $('bell-toasts');
    var t = document.createElement('div');
    t.className = 'bell-toast';
    t.textContent = '🔔 ' + name + ' กดกระดิ่ง!';
    box.appendChild(t);
    while (box.children.length > 4) box.firstChild.remove();
    setTimeout(function () { t.remove(); }, 3000);
  }

  // At the reveal: the guests who bet on this question - gold if they won it, grey if not.
  function bellOutcome() {
    var b = state.bellResults || { won: [], lost: [] };
    if (!b.won.length && !b.lost.length) return;
    var byName = {};
    state.players.forEach(function (p) { (byName[p.name] = byName[p.name] || []).push(p.id); });
    [[b.won, 'bellwin'], [b.lost, 'belllose']].forEach(function (pair) {
      pair[0].forEach(function (name) {
        (byName[name] || []).forEach(function (id) {
          var el = crowdNodes[id];
          if (!el) return;
          el.classList.add(pair[1]);
          setTimeout(function () { el.classList.remove(pair[1]); }, 3200);
        });
      });
    });
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

    syncCrowd();

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
      $('q-num').textContent = 'ข้อ ' + q.number + ' / ' + q.total;
      if (q.points === 2) {
        var x2 = document.createElement('span');
        x2.className = 'x2';
        x2.textContent = 'คะแนน ×2';
        $('q-num').appendChild(x2);
      }
      var pips = $('q-pips');
      pips.innerHTML = '';
      for (var pi = 1; pi <= q.total; pi++) {
        var pip = document.createElement('i');
        if (pi < q.number) pip.className = 'done';
        else if (pi === q.number) pip.className = 'now' + (q.points === 2 ? ' x2' : '');
        pips.appendChild(pip);
      }
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

  // Ring the bell: during a question, the guests betting on it; on the scoreboard
  // (and lobby), how many have already rung for the next one.
  var lastBells = 0;
  function renderBells() {
    var n = (state && state.bellsArmed) || 0;
    $('q-bells').hidden = !(n && state.phase === 'question');
    $('q-bells-n').textContent = n;
    $('b-bells').hidden = !(n && state.phase === 'scoreboard');
    $('b-bells-n').textContent = n;
    lastBells = n;
  }

  // A few names, then "+N", so 40 bells never overflow the projector.
  function nameList(names) {
    var MAX = 6;
    return names.slice(0, MAX).join(', ') + (names.length > MAX ? ' +' + (names.length - MAX) : '');
  }

  var answersOpenCued = false;
  var timeUpCued = false;
  var COUNTDOWN_MS = 3000;   // the 3-2-1 at the end of the server's READY_MS; before it, scene only
  var SCENE_MS = 3000;       // the scene-only moment before that (after the bonus intro, if any)
  var introCued = false;
  var sceneCued = false;

  var lastClockDigit = null;

  // A digit that just swaps text every second reads as static; a small pop on
  // the second it actually changes is what makes a countdown feel like it's
  // counting rather than just displaying a number.
  function bumpClock(digit) {
    if (digit === lastClockDigit) return;
    lastClockDigit = digit;
    var el = $('clock');
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
  }

  function timerLoop() {
    if (raf) cancelAnimationFrame(raf);
    lastClockDigit = null;
    var tick = function () {
      if (!state || state.phase !== 'question') { $('clock').style.display = 'none'; return; }
      var t = now();
      $('clock').style.display = '';
      // The ready window runs: [bonus-round announcement, first x2 question
      // only] -> 3s of only the new background (body.scenic) -> the question
      // with the 3-2-1. From the question's arrival on, the scene is blurred
      // behind it (#world.dim) so the text reads clearly.
      var intro = !!state.bonusIntro && t < state.startsAt - COUNTDOWN_MS - SCENE_MS;
      var scenic = !intro && t < state.startsAt - COUNTDOWN_MS;
      document.body.classList.toggle('bonus-intro', intro);
      document.body.classList.toggle('scenic', scenic || intro);
      $('world').classList.toggle('dim', !scenic && !intro);
      if (intro) {
        if (!introCued) { introCued = true; snd('bonusRound'); }
        $('q-answers').style.visibility = 'hidden';
        $('q-bar').style.transform = 'scaleX(1)';
      } else if (scenic) {
        if (!sceneCued) { sceneCued = true; snd('sceneWhoosh'); }
        $('q-answers').style.visibility = 'hidden';
        $('q-bar').style.transform = 'scaleX(1)';
      } else if (t < state.startsAt) {
        var readyLeft = Math.max(1, Math.ceil((state.startsAt - t) / 1000));
        $('clock').textContent = String(readyLeft);
        bumpClock('r' + readyLeft);
        $('q-answers').style.visibility = 'hidden';
        $('q-bar').style.transform = 'scaleX(1)';
        snd('readyBeep', readyLeft);
      } else {
        $('q-answers').style.visibility = 'visible';
        var total = state.endsAt - state.startsAt;
        var left = Math.max(0, state.endsAt - t);
        var secLeft = Math.ceil(left / 1000);
        $('clock').textContent = String(secLeft);
        bumpClock(secLeft);
        $('q-bar').style.transform = 'scaleX(' + (total > 0 ? left / total : 0) + ')';
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
    var right = [].concat(r.correct);   // one answer, or several on a trick question
    r.options.forEach(function (text, i) {
      var bar = document.createElement('div');
      bar.className = 'bar' + (right.indexOf(i) >= 0 ? '' : ' wrong');
      bar.dataset.a = i;

      var tick = document.createElement('div');
      tick.className = 'tick';
      tick.textContent = right.indexOf(i) >= 0 ? '✔' : '';

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
    var correctCount = right.reduce(function (n, i) { return n + (r.counts[i] || 0); }, 0);
    $('rv-sub').textContent = 'ตอบถูก ' + correctCount + ' คน' +
      (r.noAnswer ? '  •  ไม่ได้ตอบ ' + r.noAnswer + ' คน' : '');

    var b = state.bellResults || { won: [], lost: [] };
    var parts = [];
    if (b.won.length) parts.push('🔔 กระดิ่งรุ่ง ×2: ' + nameList(b.won));
    if (b.lost.length) parts.push('💥 กระดิ่งพัง: ' + nameList(b.lost));
    $('rv-bells').textContent = parts.join('   •   ');
    $('rv-bells').hidden = !parts.length;
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
    // Pixel confetti: petal and gold chunks on the sprites' own pixel grid (P),
    // tumbling by flipping between flat and tall rather than rotating smoothly.
    var P = 2 * (parseInt(getComputedStyle(document.documentElement).getPropertyValue('--ps'), 10) || 3);
    var COLOURS = ['#ffc4d6', '#f28bb0', '#fff6e8', '#f7d154', '#c8912a', '#c7b6e6', '#e0445a'];
    var bits = [];
    for (var i = 0; i < 160; i++) {
      bits.push({
        x: W * (0.15 + Math.random() * 0.7),
        y: H + Math.random() * 120,
        vx: (Math.random() - 0.5) * 5.5,
        vy: -(9 + Math.random() * 9),
        s: 1 + ((Math.random() * 2) | 0),
        rot: Math.random() * 4,
        vr: 0.08 + Math.random() * 0.14,
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
        var flip = Math.floor(b.rot) % 2;           // 0: flat, 1: tall
        var w = P * (b.s + 1 - flip), h = P * (b.s + flip);
        ctx.fillStyle = b.c;
        ctx.globalAlpha = elapsed < durationMs * 0.7 ? 1 : 0.5;   // stepped fade, no smooth alpha
        ctx.fillRect(Math.round(b.x / P) * P, Math.round(b.y / P) * P, w, h);
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

  // A first-person dash to the finish line, played once, full-screen, right
  // before the podium appears - see the 'ended' case below. It owns the whole
  // screen for its duration so celebrate() (the podium reveal) only starts
  // once this is actually done, instead of both fighting for attention.
  var goalRunTimers = [];

  function cancelGoalRun() {
    for (var i = 0; i < goalRunTimers.length; i++) clearTimeout(goalRunTimers[i]);
    goalRunTimers = [];
    var el = $('goalrun');
    if (el) el.classList.remove('show', 'banner', 'flash');
    var posts = $('gr-posts');
    if (posts) posts.innerHTML = '';
  }

  function playGoalRun(onDone) {
    var el = $('goalrun');
    if (!el) { onDone(); return; }
    cancelGoalRun();
    snd('goalRun', 1.2);   // the banner below lands at 1200ms

    // Rose petals burst out of the vanishing point in every direction.
    var posts = $('gr-posts');
    for (var i = 0; i < 22; i++) {
      var p = document.createElement('div');
      p.className = 'grpost';
      var a = (i / 22) * Math.PI * 2 + Math.random() * 0.3;
      var dist = 70 + Math.random() * 40;                // vmax, far enough to leave the screen
      p.style.setProperty('--fx', (Math.cos(a) * dist) + 'vmax');
      p.style.setProperty('--fy', (Math.sin(a) * dist * 0.7) + 'vmax');
      p.style.animationDelay = -(Math.random() * 0.9) + 's';
      posts.appendChild(p);
    }

    el.classList.add('show');
    goalRunTimers.push(setTimeout(function () { el.classList.add('banner'); }, 1200));
    goalRunTimers.push(setTimeout(function () { el.classList.add('flash'); }, 2050));
    goalRunTimers.push(setTimeout(function () {
      el.classList.remove('show');
      goalRunTimers.push(setTimeout(function () {
        el.classList.remove('banner', 'flash');
        posts.innerHTML = '';
      }, 450));
      onDone();
    }, 2350));
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
    cancelGoalRun();
  }

  // Pixel crown and medals, drawn like the guests (pixelfolk.js) instead of
  // emoji, which looked like a phone UI pasted over the pixel world.
  var MEDAL_ICONS = ['crown', 'silver', 'bronze'];   // pixelfolk.js ICONS

  // The podium figures are a size up from the field's walkers, still whole pixels.
  function setPodiumScale() {
    document.documentElement.style.setProperty('--pps', Math.max(3, Math.floor(window.innerHeight / 216)));
  }
  setPodiumScale();
  window.addEventListener('resize', setPodiumScale);

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

      var nm = document.createElement('div');
      nm.className = 'nm';
      var ic = window.PixelFolk.ICONS[MEDAL_ICONS[i]];
      var medal = document.createElement('img');
      medal.className = 'medal';
      medal.alt = '';
      medal.src = window.PixelFolk.namedIcon(MEDAL_ICONS[i]).toDataURL();
      medal.style.width = 'calc(' + (ic.grid[0].length + 2) + 'px * var(--pps))';
      nm.appendChild(medal);
      nm.appendChild(document.createTextNode(r.name));
      // Score on its own line, in the pixel face, instead of "name - score" run together.
      var sc = document.createElement('span');
      sc.className = 'sc';
      sc.textContent = r.score.toLocaleString('th-TH');
      nm.appendChild(sc);

      // The winner's own guest from the field, by the same id hash, now facing
      // the room, standing in an aura: a light beam, turning rays, sparks
      // rising, and a glowing outline, in their medal's colour.
      var stage = document.createElement('div');
      stage.className = 'stage';
      var aura = document.createElement('div');
      aura.className = 'aura';
      aura.innerHTML = '<i class="beam"></i><i class="rays"></i><i class="ring"></i>';
      for (var k = 0; k < (i === 0 ? 14 : 9); k++) {
        var sp = document.createElement('b');
        sp.style.setProperty('--x', (8 + Math.random() * 84) + '%');
        sp.style.setProperty('--d', (Math.random() * 1.6).toFixed(2) + 's');
        sp.style.setProperty('--t', (1.1 + Math.random() * 0.9).toFixed(2) + 's');
        aura.appendChild(sp);
      }
      var who = document.createElement('div');
      who.className = 'who';
      who.style.backgroundImage = 'url(' + window.PixelFolk.makeSheet(hashId(r.id || r.name), window.PixelFolk.choiceForce(r.look), 'front').toDataURL() + ')';
      stage.appendChild(aura);
      stage.appendChild(who);

      var blk = document.createElement('div');
      blk.className = 'blk';
      blk.textContent = i + 1;

      d.appendChild(nm); d.appendChild(stage); d.appendChild(blk);
      pod.appendChild(d);
    });
  }

  /* ---------------- render ---------------- */

  function WQSoundPlaying() {
    var S = window.WQSound;
    return !!(S && S.lobbyPlaying && S.lobbyPlaying());
  }

  // Fills the rules screen from the real game: question count, time range, how
  // many bonus questions, the bell's penalty.
  function renderRules() {
    var r = state.rules;
    if (!r) return;
    var num = function (n) { return n.toLocaleString('th-TH'); };
    $('r-n').textContent = r.questions;
    $('r-time').textContent = r.minTime === r.maxTime ? r.minTime : r.minTime + '-' + r.maxTime;
    $('r-bonus').textContent = r.bonus;
    $('r-bonus-row').hidden = !r.bonus;
    $('r-pen').textContent = num(r.bellPenalty);
    if (window.PixelFolk && !$('r-bell').src) {
      $('r-bell').src = window.PixelFolk.namedIcon('bell').toDataURL();
      $('r-m1').src = window.PixelFolk.namedIcon('crown').toDataURL();
      $('r-m2').src = window.PixelFolk.namedIcon('silver').toDataURL();
      $('r-m3').src = window.PixelFolk.namedIcon('bronze').toDataURL();
    }
  }

  var LABELS = {
    lobby: 'ห้องรอ', rules: 'กติกา', question: 'กำลังเล่น', reveal: 'เฉลย',
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
    renderBells();
    $('st-players').textContent = state.playerCount;
    $('st-q').textContent = (state.phase === 'lobby' ? 0 : Math.min(state.index + 1, state.questionCount)) +
      '/' + state.questionCount;
    $('c-lock').textContent = state.joinLocked ? '🔓 เปิดรับ' : '🔒 ปิดรับ';
    $('c-lock').title = state.joinLocked ? 'เปิดรับผู้เล่นเพิ่ม' : 'ปิดรับผู้เล่นเพิ่ม';
    soundLabel();

    // Start must be reachable whenever a game is not actually running, otherwise a
    // finished or interrupted game strands the host with no visible way forward.
    var canStart = state.phase === 'lobby' || state.phase === 'ended';
    $('c-start').style.display = canStart ? '' : 'none';
    $('c-start').textContent = state.phase === 'ended' ? '▶ เล่นใหม่อีกรอบ' : '▶ เริ่มเกม';
    $('c-back').style.display = (state.phase === 'lobby') ? 'none' : '';
    $('c-skip').disabled = state.phase !== 'question';
    $('c-next').disabled = !(state.phase === 'rules' || state.phase === 'reveal' || state.phase === 'scoreboard');
    $('c-next').textContent = state.phase === 'rules' ? 'เริ่มข้อ 1 →'
      : (state.phase === 'scoreboard' && state.index + 1 >= state.questionCount) ? 'จบเกม 🏁' : 'ถัดไป →';

    if (state.phase !== 'question' && raf) { cancelAnimationFrame(raf); raf = null; $('clock').style.display = 'none'; }
    // The reveal repeats the question over the scene, so it stays blurred too.
    // The bonus round's questions wear a gold frame on the projector.
    document.body.classList.toggle('x2', state.phase === 'question' && !!state.question && state.question.points === 2);
    if (state.phase !== 'question') {
      document.body.classList.remove('scenic');
      document.body.classList.remove('bonus-intro');
      $('world').classList.toggle('dim', state.phase === 'reveal');
    }

    setScene(sceneFor(state));

    switch (state.phase) {
      case 'lobby':
        lastQuestionKey = '';
        if (view('lobby')) { cancelCelebration(); snd('lobby'); }
        renderLobby();
        break;
      case 'rules':
        lastQuestionKey = '';
        // The lobby music keeps playing under the rules (a reload here starts it again).
        if (view('rules')) { cancelCelebration(); if (!WQSoundPlaying()) snd('lobby'); }
        renderRules();
        break;
      case 'question': {
        if (view('q')) {
          cancelCelebration();
          answersOpenCued = false; timeUpCued = false; introCued = false; sceneCued = false;
        }
        paintImage('q-img', 'v-q');
        renderQuestion();
        timerLoop();
        break;
      }
      case 'reveal': {
        var enteredReveal = view('reveal');
        if (enteredReveal) { snd('reveal'); setTimeout(bellOutcome, 600); }
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
        if (enteredEnd) {
          var top3 = state.scoreboard.slice(0, 3);
          playGoalRun(function () {
            renderPodium(top3, true);
            celebrate();
          });
        } else {
          renderPodium(state.scoreboard.slice(0, 3), false);
        }
        break;
      }
      default:
        break;
    }
    syncCrowd();
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

  /* ---- backup: the projector keeps a copy of the game ----
     Render's free plan loses everything when it restarts. This screen already
     holds the PIN, every guest, their scores and where the game is, so it keeps
     that copy (in memory and in this laptop's storage) and, if the server comes
     back EMPTY, hands it back: same PIN, same guests and scores, phones reconnect
     on their own and the host presses Next to carry on. */
  var BACKUP_KEY = 'wq.backup';
  var BACKUP_MAX_AGE = 4 * 60 * 60 * 1000;
  var backupTimer = null, sawDisconnect = false, restoring = false, offeredStored = false;

  function backupFrom(s) {
    return {
      savedAt: Date.now(), pin: s.pin, phase: s.phase, index: s.index, joinLocked: s.joinLocked,
      players: (s.players || []).map(function (p) {
        return { id: p.id, name: p.name, score: p.score, streak: p.streak || 0, bell: p.bell || null,
                 look: p.look || null, joinedAt: p.joinedAt };
      })
    };
  }
  var memBackup = null;
  function saveBackupSoon() {
    if (restoring || backupTimer) return;
    backupTimer = setTimeout(function () {
      backupTimer = null;
      if (!state || !state.isHost || restoring) return;
      memBackup = backupFrom(state);
      try { localStorage.setItem(BACKUP_KEY, JSON.stringify(memBackup)); } catch (e) { /* storage off: memory copy still works */ }
    }, 600);
  }
  function storedBackup() {
    var b = null;
    try { b = JSON.parse(localStorage.getItem(BACKUP_KEY) || 'null'); } catch (e) { /* ignore */ }
    return b && Date.now() - b.savedAt < BACKUP_MAX_AGE ? b : null;
  }
  // A game worth bringing back, and a server that has clearly lost it.
  function isLostGame(b, s) {
    return !!(b && b.players && b.players.length && s && s.isHost && s.phase === 'lobby' &&
              (!s.players || s.players.length === 0) && s.pin !== b.pin);
  }
  function restore(b) {
    restoring = true;
    socket.emit('host:restore', b, function (res) {
      restoring = false;
      if (res && res.ok) {
        showRestoreNote('กู้เกมกลับมาแล้ว: PIN ' + res.pin + ', แขก ' + res.players + ' คน กด "ถัดไป →" เพื่อเล่นต่อ');
      } else {
        saveBackupSoon();
      }
    });
  }
  function showRestoreNote(msg) {
    var n = document.getElementById('restore-note');
    if (!n) {
      n = document.createElement('div');
      n.id = 'restore-note';
      n.className = 'restore-note';
      n.setAttribute('role', 'status');
      document.body.appendChild(n);
    }
    n.textContent = '♻️ ' + msg;
    n.hidden = false;
    clearTimeout(showRestoreNote.t);
    showRestoreNote.t = setTimeout(function () { n.hidden = true; }, 12000);
  }

  socket.on('disconnect', function () { sawDisconnect = true; });

  socket.on('state', function (s) {
    // The server came back without our game: put it back before showing anything.
    if (s && s.isHost && !restoring) {
      var reconnected = sawDisconnect;
      sawDisconnect = false;
      if (reconnected && isLostGame(memBackup, s)) { restore(memBackup); return; }
      // This page was reloaded (or reopened) and finds an empty server while the
      // laptop still has a recent game: ask, because that could be on purpose.
      if (!offeredStored && !memBackup) {
        offeredStored = true;
        var stored = storedBackup();
        if (isLostGame(stored, s) && confirm('พบเกมที่ค้างอยู่ในเครื่องนี้ (แขก ' + stored.players.length +
            ' คน, ข้อ ' + Math.max(0, stored.index + 1) + ')\n\nกู้เกมนี้กลับมาเล่นต่อไหม? PIN และคะแนนเดิมจะกลับมา')) {
          restore(stored);
          return;
        }
      }
    }
    if (restoring) return;
    state = s; render(); renderGuests();
    saveBackupSoon();
  });

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
      var rang = r.player.bell === 'armed' && state.players[at].bell !== 'armed';
      state.players[at] = r.player;
      if (rang) ringEffect(id, r.player.name);
    } else {
      state.players.push(r.player);
    }
    saveBackupSoon();
    state.playerCount = r.playerCount;
    $('st-players').textContent = r.playerCount;
    if (state.phase === 'lobby') renderLobby();
    // A guest admitted mid-question changes the denominator on the projector, and
    // `tally` only fires when someone answers -- so update it here too.
    if (state.phase === 'question') $('q-total').textContent = r.playerCount;
    syncCrowd();
    renderGuests();
  });

  // A guest rang (or un-rang) the bell between questions.
  socket.on('bells', function (b) {
    if (!state) return;
    var before = lastBells;
    state.bellsArmed = b.armed;
    renderBells();
    if (b.armed > before) snd('bellRing');
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
