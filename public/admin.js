/* Wedding Quiz — question editor */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var password = '';
  var questions = [];
  var dirty = false;
  var locked = false;   // server is running with LOCK_QUESTIONS (pre-set mode)

  function show(id) {
    var screens = document.querySelectorAll('.screen');
    for (var i = 0; i < screens.length; i++) screens[i].classList.remove('active');
    $(id).classList.add('active');
  }

  function setState(text, cls) {
    var el = $('save-state');
    el.textContent = text;
    el.className = 'save-state ' + (cls || '');
  }

  function markDirty() {
    dirty = true;
    setState('ยังไม่ได้บันทึก', 'dirty');
    saveDraftSoon();
  }

  // Anything arriving from a file or from a stored draft is untrusted shape-wise.
  function fromFile(q) {
    q = q && typeof q === 'object' ? q : {};
    return {
      text: String(q.text || ''),
      options: (Array.isArray(q.options) ? q.options : ['', '']).slice(0, 4).map(String),
      correct: Number(q.correct) || 0,
      timeLimit: Number(q.timeLimit) || 20,
      points: Number(q.points) === 2 ? 2 : 1,
      image: typeof q.image === 'string' && q.image ? q.image : null,
    };
  }

  /* ---------------- draft ---------------- */

  // The editor has to survive being used on someone else's laptop, on a host that
  // keeps no disk. The draft lives in this browser; the file export is the real
  // backup, and the note below says so when the draft cannot be kept.
  var DRAFT_KEY = 'wq.draft';
  // A recovered draft is moved aside the moment it is offered, so the autosave of
  // the CURRENT edits can never overwrite it while the offer is still on screen.
  var RECOVERED_KEY = 'wq.draft.recovered';
  var draftTimer = null;

  function draftWarn(text) {
    var el = document.getElementById('draft-warn');
    if (el) el.textContent = text || '';
  }

  function saveDraft() {
    draftTimer = null;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ savedAt: Date.now(), questions: questions }));
      draftWarn('');
    } catch (e) {
      draftWarn('เก็บฉบับร่างอัตโนมัติไม่ได้ (ชุดคำถามใหญ่เกินไป) — กด "⬇ สำรองไฟล์" เก็บไว้เองด้วยนะ');
    }
  }

  function saveDraftSoon() {
    if (draftTimer) return;
    draftTimer = setTimeout(saveDraft, 800);
  }

  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* ignore */ }
  }

  // Offered as a banner, never as a confirm(): a dismissed dialog must not destroy
  // a draft. The recovered copy is moved to its own key first, so the 800ms autosave
  // of the currently-loaded questions cannot quietly overwrite it while the host is
  // still deciding - which is exactly what happened before.
  function offerDraft() {
    var raw = null;
    try {
      raw = localStorage.getItem(RECOVERED_KEY) || localStorage.getItem(DRAFT_KEY);
    } catch (e) { return; }
    if (!raw) return;

    var d = null;
    try { d = JSON.parse(raw); } catch (e) { dropRecovered(); return; }
    if (!d || !Array.isArray(d.questions) || !d.questions.length) { dropRecovered(); return; }

    var draft = d.questions.map(fromFile);
    if (JSON.stringify(draft) === JSON.stringify(questions.map(fromFile))) { dropRecovered(); return; }

    // Park it out of the autosave's reach until the host answers the banner.
    try {
      localStorage.setItem(RECOVERED_KEY, raw);
      localStorage.removeItem(DRAFT_KEY);
    } catch (e) { /* offer it from memory instead */ }

    var el = document.getElementById('draft-note');
    if (!el) return;
    el.textContent = '';

    var when = new Date(d.savedAt || Date.now()).toLocaleString('th-TH');
    var msg = document.createElement('span');
    msg.textContent = 'พบฉบับร่างที่ค้างไว้ในเครื่องนี้ (' + when + ' • ' + draft.length + ' ข้อ) ';
    el.appendChild(msg);

    var use = document.createElement('button');
    use.className = 'btn ghost sm';
    use.id = 'b-use-draft';
    use.style.marginLeft = '8px';
    use.textContent = 'ใช้ฉบับร่างนี้';
    use.addEventListener('click', function () {
      questions = draft;
      el.textContent = '';
      dropRecovered();
      render();
      markDirty();
    });
    el.appendChild(use);

    var drop = document.createElement('button');
    drop.className = 'btn ghost sm';
    drop.id = 'b-drop-draft';
    drop.style.marginLeft = '8px';
    drop.textContent = 'ทิ้งฉบับร่าง';
    drop.addEventListener('click', function () {
      if (!confirm('ทิ้งฉบับร่างนี้ถาวรเลยไหม? (กู้คืนไม่ได้)')) return;
      el.textContent = '';
      dropRecovered();
    });
    el.appendChild(drop);
  }

  function dropRecovered() {
    try { localStorage.removeItem(RECOVERED_KEY); } catch (e) { /* ignore */ }
  }

  /* ---------------- auth + load ---------------- */

  function load(pw) {
    return fetch('/api/questions', { headers: { 'x-quiz-password': pw } })
      .then(function (r) {
        if (r.status === 401) throw new Error('auth');
        if (!r.ok) throw new Error('http');
        locked = r.headers.get('x-questions-locked') === '1';
        return r.json();
      });
  }

  function applyLockedUi() {
    if (!locked) return;
    // Only writing to the server is blocked. Editing, importing and exporting all
    // still work, because that is the whole workflow on a host with no disk:
    // build the set here, export the file, commit it as questions.seed.json.
    $('b-save').disabled = true;
    $('b-save').title = 'เซิร์ฟเวอร์นี้ล็อกคำถามไว้ — ใช้ "⬇ สำรองไฟล์" แทน';
    var note = document.createElement('div');
    note.className = 'card';
    note.style.cssText = 'margin-bottom:18px;border-color:rgba(232,192,122,.5)';
    note.innerHTML = '<b>🔒 โหมดคำถามล็อก (pre-set)</b><br>' +
      '<span class="hint">เซิร์ฟเวอร์นี้อ่านคำถามจากไฟล์ <code>questions.seed.json</code> ที่อยู่ในโค้ดเท่านั้น ' +
      'คำถามจึงไม่หายแม้เซิร์ฟเวอร์รีสตาร์ทหรือหลับ<br><br>' +
      '<b>แก้ในหน้านี้ได้ตามปกติ</b> (เพิ่มข้อ ใส่รูป นำเข้าไฟล์) แค่กดบันทึกขึ้นเซิร์ฟเวอร์ไม่ได้ ' +
      'งานที่แก้จะถูกเก็บเป็นฉบับร่างในเครื่องนี้ไว้ให้<br><br>' +
      'พอทำเสร็จ: กด "⬇ สำรองไฟล์" แล้วเอาไฟล์นั้นไปวางทับ <code>questions.seed.json</code> ' +
      'แล้ว <code>git push</code> — เท่านี้คำถามชุดใหม่ก็พร้อมใช้จริง</span>';
    $('list').parentNode.insertBefore(note, $('list'));
  }

  function authenticate(pw) {
    load(pw).then(function (list) {
      password = pw;
      questions = list;
      try { sessionStorage.setItem('wq.host', pw); } catch (e) { /* ignore */ }
      show('s-edit');
      render();
      applyLockedUi();
      setState(locked ? 'แก้ในเครื่องได้ • บันทึกขึ้นเซิร์ฟเวอร์ไม่ได้' : '');
      offerDraft();
    }).catch(function (err) {
      $('auth-err').textContent = err.message === 'auth' ? 'รหัสผ่านไม่ถูกต้อง' : 'โหลดคำถามไม่สำเร็จ';
      try { sessionStorage.removeItem('wq.host'); } catch (e) { /* ignore */ }
    });
  }

  $('btn-auth').addEventListener('click', function () { authenticate($('pw').value); });
  $('pw').addEventListener('keydown', function (e) { if (e.key === 'Enter') authenticate($('pw').value); });

  /* ---------------- pictures ---------------- */

  var MAX_IMAGE_CHARS = 400000;   // must match normaliseImage() in server.js

  // Mirrors safeImageChars() in server.js, so a link cannot look accepted here and
  // then come back as null after saving.
  function safeLinkChars(u) {
    var bad = [' ', String.fromCharCode(9), String.fromCharCode(10), String.fromCharCode(13), '"', "'", '<', '>'];
    for (var i = 0; i < bad.length; i++) { if (u.indexOf(bad[i]) !== -1) return false; }
    return true;
  }

  function encode(img, max, quality) {
    var w = img.naturalWidth, h = img.naturalHeight;
    var scale = Math.min(1, max / Math.max(w, h));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(h * scale));
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';                 // JPEG has no alpha; keep PNGs from going black
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  }

  // Shrink in the browser before the picture ever touches the network: a 4MB phone
  // photo lands around 100KB, which is what keeps a whole set inside the server's
  // request limit and inside localStorage for the draft.
  function downscale(file, cb) {
    var reader = new FileReader();
    reader.onerror = function () { cb(new Error('อ่านไฟล์ไม่สำเร็จ')); };
    reader.onload = function () {
      var img = new Image();
      img.onerror = function () { cb(new Error('ไฟล์นี้ไม่ใช่รูปภาพ')); };
      img.onload = function () {
        var steps = [[1000, 0.72], [800, 0.62], [640, 0.5]];
        for (var i = 0; i < steps.length; i++) {
          var out = encode(img, steps[i][0], steps[i][1]);
          if (out.length <= MAX_IMAGE_CHARS) return cb(null, out);
        }
        cb(new Error('รูปนี้ใหญ่เกินไป ลองใช้รูปอื่น'));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  /* ---------------- render ---------------- */

  function blank() {
    return { text: '', options: ['', '', '', ''], correct: 0, timeLimit: 20, points: 1, image: null };
  }

  function render() {
    var list = $('list');
    list.innerHTML = '';
    $('count').textContent = questions.length;

    questions.forEach(function (q, qi) {
      var card = document.createElement('div');
      card.className = 'q';

      /* header */
      var top = document.createElement('div');
      top.className = 'q-top';
      var num = document.createElement('span');
      num.className = 'q-num';
      num.textContent = (qi + 1) + '.';
      top.appendChild(num);

      var text = document.createElement('textarea');
      text.className = 'field';
      text.rows = 2;
      text.maxLength = 400;
      text.placeholder = 'พิมพ์คำถามที่นี่…';
      text.value = q.text;
      text.addEventListener('input', function () { q.text = text.value; markDirty(); });
      top.appendChild(text);

      [['▲', function () { swap(qi, qi - 1); }],
       ['▼', function () { swap(qi, qi + 1); }]].forEach(function (pair) {
        var b = document.createElement('button');
        b.className = 'icon';
        b.textContent = pair[0];
        b.addEventListener('click', pair[1]);
        top.appendChild(b);
      });

      var del = document.createElement('button');
      del.className = 'icon del';
      del.textContent = '🗑';
      del.title = 'ลบคำถามนี้';
      del.addEventListener('click', function () {
        if (questions.length <= 1) { alert('ต้องมีอย่างน้อย 1 คำถาม'); return; }
        if (!confirm('ลบคำถามข้อ ' + (qi + 1) + '?')) return;
        questions.splice(qi, 1);
        markDirty();
        render();
      });
      top.appendChild(del);
      card.appendChild(top);

      /* options */
      q.options.forEach(function (opt, oi) {
        var row = document.createElement('div');
        row.className = 'opt';

        var radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'correct-' + qi;
        radio.checked = q.correct === oi;
        radio.title = 'คำตอบที่ถูก';
        radio.addEventListener('change', function () { q.correct = oi; markDirty(); });
        row.appendChild(radio);

        var sw = document.createElement('span');
        sw.className = 'shape sw';
        sw.dataset.s = oi;
        sw.style.background = ['#e04b53', '#2b7fd4', '#d9a326', '#2f9e6b'][oi];
        row.appendChild(sw);

        var input = document.createElement('input');
        input.className = 'field';
        input.maxLength = 200;
        input.placeholder = 'ตัวเลือกที่ ' + (oi + 1);
        input.value = opt;
        input.addEventListener('input', function () { q.options[oi] = input.value; markDirty(); });
        row.appendChild(input);

        var rm = document.createElement('button');
        rm.className = 'icon del rm';
        rm.textContent = '−';
        rm.title = 'ลบตัวเลือกนี้';
        rm.disabled = q.options.length <= 2;
        rm.addEventListener('click', function () {
          q.options.splice(oi, 1);
          if (q.correct >= q.options.length) q.correct = 0;
          else if (q.correct > oi) q.correct -= 1;
          markDirty();
          render();
        });
        row.appendChild(rm);

        card.appendChild(row);
      });

      /* footer */
      var row = document.createElement('div');
      row.className = 'row';

      if (q.options.length < 4) {
        var add = document.createElement('button');
        add.className = 'btn ghost sm';
        add.textContent = '+ ตัวเลือก';
        add.addEventListener('click', function () { q.options.push(''); markDirty(); render(); });
        row.appendChild(add);
      }

      var tl = document.createElement('label');
      tl.textContent = 'เวลา (วินาที) ';
      var tin = document.createElement('input');
      tin.type = 'number';
      tin.className = 'field';
      tin.min = 5; tin.max = 120;
      tin.value = q.timeLimit;
      tin.addEventListener('input', function () { q.timeLimit = Number(tin.value); markDirty(); });
      tl.appendChild(tin);
      row.appendChild(tl);

      var pl = document.createElement('label');
      pl.textContent = 'คะแนน ';
      var sel = document.createElement('select');
      [['1', 'ปกติ'], ['2', 'คูณ 2 ✨']].forEach(function (o) {
        var op = document.createElement('option');
        op.value = o[0];
        op.textContent = o[1];
        sel.appendChild(op);
      });
      sel.value = String(q.points || 1);
      sel.addEventListener('change', function () { q.points = Number(sel.value); markDirty(); });
      pl.appendChild(sel);
      row.appendChild(pl);

      card.appendChild(row);

      /* picture - projector only */
      var irow = document.createElement('div');
      irow.className = 'imgrow';

      var thumb = document.createElement('img');
      thumb.className = 'thumb';
      thumb.alt = '';
      if (q.image) thumb.src = q.image; else thumb.style.visibility = 'hidden';
      thumb.addEventListener('error', function () { thumb.style.visibility = 'hidden'; });
      irow.appendChild(thumb);

      var fin = document.createElement('input');
      fin.type = 'file';
      fin.accept = 'image/*';
      fin.hidden = true;
      irow.appendChild(fin);

      var pick = document.createElement('button');
      pick.className = 'btn ghost sm';
      pick.textContent = q.image ? '🖼 เปลี่ยนรูป' : '🖼 ใส่รูป';
      pick.addEventListener('click', function () { fin.click(); });
      irow.appendChild(pick);

      fin.addEventListener('change', function () {
        var file = fin.files[0];
        fin.value = '';
        if (!file) return;
        setState('กำลังย่อรูป…', '');
        downscale(file, function (err, dataUri) {
          if (err) { setState(err.message, 'err'); return; }
          q.image = dataUri;
          markDirty();
          render();
        });
      });

      var urlb = document.createElement('button');
      urlb.className = 'btn ghost sm';
      urlb.textContent = '🔗 ลิงก์รูป';
      urlb.addEventListener('click', function () {
        var current = (typeof q.image === 'string' && q.image.indexOf('https://') === 0) ? q.image : 'https://';
        var u = prompt('วางลิงก์รูป (ต้องขึ้นต้นด้วย https:// เท่านั้น)', current);
        if (u === null) return;
        u = u.trim();
        if (!u) { q.image = null; markDirty(); render(); return; }
        if (u.indexOf('https://') !== 0 || u.length <= 'https://'.length) {
          setState('ลิงก์ต้องขึ้นต้นด้วย https:// และต้องมีที่อยู่ต่อท้าย', 'err'); return;
        }
        if (u.length > MAX_IMAGE_CHARS) { setState('ลิงก์ยาวเกินไป', 'err'); return; }
        // Same characters the server refuses, so a link cannot look accepted here
        // and then come back as null after saving.
        if (!safeLinkChars(u)) { setState('ลิงก์มีช่องว่างหรืออักขระที่ใช้ไม่ได้', 'err'); return; }
        q.image = u;
        markDirty();
        render();
      });
      irow.appendChild(urlb);

      if (q.image) {
        var rmi = document.createElement('button');
        rmi.className = 'btn ghost sm';
        rmi.textContent = 'ลบรูป';
        rmi.addEventListener('click', function () { q.image = null; markDirty(); render(); });
        irow.appendChild(rmi);
      }

      var ihint = document.createElement('span');
      ihint.className = 'imghint';
      ihint.textContent = !q.image
        ? 'ใส่รูปได้ — รูปจะขึ้นเฉพาะบนจอใหญ่ ไม่ขึ้นบนมือถือแขก'
        : (q.image.indexOf('data:') === 0
          ? 'รูปนี้ขึ้นเฉพาะบนจอใหญ่ (' + Math.round(q.image.length * 0.75 / 1024) + ' KB)'
          : 'ใช้ลิงก์ภายนอก — ต้องมีเน็ตตอนงานถึงจะขึ้น');
      irow.appendChild(ihint);

      card.appendChild(irow);
      list.appendChild(card);
    });
  }

  function swap(a, b) {
    if (b < 0 || b >= questions.length) return;
    var tmp = questions[a];
    questions[a] = questions[b];
    questions[b] = tmp;
    markDirty();
    render();
  }

  /* ---------------- save / import / export ---------------- */

  function validate() {
    for (var i = 0; i < questions.length; i++) {
      var q = questions[i];
      if (!q.text.trim()) return 'ข้อ ' + (i + 1) + ': ยังไม่ได้ใส่คำถาม';
      for (var j = 0; j < q.options.length; j++) {
        if (!String(q.options[j]).trim()) return 'ข้อ ' + (i + 1) + ': ตัวเลือกที่ ' + (j + 1) + ' ว่างอยู่';
      }
    }
    return null;
  }

  function save() {
    var problem = validate();
    if (problem) { setState(problem, 'err'); return; }
    setState('กำลังบันทึก…', '');
    fetch('/api/questions', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-quiz-password': password },
      body: JSON.stringify(questions),
    }).then(function (r) {
      if (r.status === 413) throw new Error('ชุดคำถามใหญ่เกินไป (รูปเยอะ) — ลบรูปบางข้อออก แล้วกด "⬇ สำรองไฟล์" เก็บไว้ก่อน');
      if (r.status === 423) throw new Error('คำถามถูกล็อกไว้ (LOCK_QUESTIONS) — แก้ที่ questions.seed.json แล้ว push');
      if (r.status === 409) throw new Error('เกมกำลังเล่นอยู่ — รีเซ็ตหรือจบเกมก่อนถึงจะแก้ได้');
      if (r.status === 401) throw new Error('รหัสผ่านหมดอายุ — โหลดหน้าใหม่');
      if (!r.ok) throw new Error('บันทึกไม่สำเร็จ');
      return r.json();
    }).then(function (res) {
      return fetch('/api/questions', { headers: { 'x-quiz-password': password } })
        .then(function (r) { return r.json(); })
        .then(function (onServer) { return { res: res, onServer: onServer }; });
    }).then(function (both) {
      var mine = JSON.stringify(questions.map(fromFile));
      var theirs = JSON.stringify((both.onServer || []).map(fromFile));
      if (mine !== theirs) {
        // Keep the draft: what is on screen is NOT what the server kept.
        dirty = false;
        setState('บันทึกแล้ว แต่เซิร์ฟเวอร์ปรับบางอย่าง (เก็บได้ ' + (both.res.count || 0) +
          ' ข้อ) — โหลดหน้าใหม่เพื่อดูของจริง และกด "⬇ สำรองไฟล์" ไว้ด้วย', 'err');
        return;
      }
      dirty = false;
      clearDraft();
      setState('บันทึกแล้ว ✓', 'ok');
    }).catch(function (err) {
      setState(err.message, 'err');
    });
  }

  $('b-save').addEventListener('click', save);

  function addQuestion() {
    questions.push(blank());
    markDirty();
    render();
    window.scrollTo(0, document.body.scrollHeight);
  }
  $('b-add').addEventListener('click', addQuestion);
  $('b-add2').addEventListener('click', addQuestion);

  $('b-export').addEventListener('click', function () {
    var blob = new Blob([JSON.stringify(questions, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'wedding-quiz-questions.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  });

  $('b-import').addEventListener('click', function () { $('file').click(); });
  $('file').addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = JSON.parse(reader.result);
        if (!Array.isArray(parsed) || !parsed.length) throw new Error('ไฟล์ไม่ถูกต้อง');
        questions = parsed.map(fromFile);
        markDirty();
        render();
      } catch (err) {
        setState('นำเข้าไม่สำเร็จ: ' + err.message, 'err');
      }
      e.target.value = '';
    };
    reader.readAsText(file);
  });

  window.addEventListener('beforeunload', function (e) {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });

  /* ---------------- boot ---------------- */

  var saved = null;
  try { saved = sessionStorage.getItem('wq.host'); } catch (e) { /* ignore */ }
  if (saved) authenticate(saved); else $('pw').focus();
})();
