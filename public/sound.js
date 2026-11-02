/* Wedding Quiz - projector sound.
 *
 * Everything here is synthesised live with the Web Audio API - no mp3 files,
 * so the ticking can follow the server-authoritative clock exactly instead of
 * drifting against a pre-recorded loop - EXCEPT the question-phase bed, which
 * is one AI-generated (Suno) drum track at public/audio/tension.mp3, chosen
 * because a synthesised drone/pulse couldn't get the "epic" weight this cue
 * needed. It only needs to play once per question, not loop or stay in sync
 * with anything, so a real recording is fine there.
 *
 * Sound belongs to the BIG SCREEN only - the projector is what is plugged into
 * the venue speakers. 150 phones playing the same loop slightly out of sync
 * would be noise, not atmosphere, so player.js never loads this file.
 */
(function () {
  'use strict';

  var ctx = null;
  var master = null;
  var enabled = true;
  var loopTimer = null;      // lobby bed scheduler
  var bed = null;            // gain node the whole loop hangs off
  var bedStep = 0;
  var bedNextTime = 0;
  var lastTickAt = 0;        // guards the per-frame tick scheduler
  var lastReadyBeep = -1;
  var lastJoinAt = -1;       // spaces out guestJoin plings during the join rush
  var lastBellAt = -1;       // same idea for bellRing when many guests ring at once
  var unlockWatchers = [];
  var tensionBuffer = null;      // decoded public/audio/tension.mp3, once loaded
  var tensionBufferPromise = null;
  var bedSource = null;          // the AudioBufferSourceNode currently playing it, if any

  var MASTER = 0.85;         // measured: podium peaks near -7dBFS, still no clipping
  var TENSION_GAIN = 0.35;   // source file peaks ~0.71 raw - this keeps it under other cues

  try {
    enabled = localStorage.getItem('wq.sound') !== 'off';
  } catch (e) { /* private mode - default to on */ }

  /* ---------------- engine ---------------- */

  // Browsers refuse to start audio without a user gesture. The host clicks a
  // button to log in, so that click is what wakes this up.
  function ensure() {
    if (!enabled) return null;
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = MASTER;
      master.connect(ctx.destination);
      loadTensionBuffer();   // kick this off now so it's ready well before question 1
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // Fetches and decodes the question-phase drum track once, in the background.
  // Never blocks a cue: questionStart() falls back to the synthesised pulse
  // below until this resolves.
  function loadTensionBuffer() {
    if (tensionBuffer || tensionBufferPromise || !ctx) return tensionBufferPromise;
    tensionBufferPromise = fetch('audio/tension.mp3')
      .then(function (r) { return r.arrayBuffer(); })
      .then(function (data) { return ctx.decodeAudioData(data); })
      .then(function (decoded) { tensionBuffer = decoded; })
      .catch(function () { tensionBufferPromise = null; });  // offline/blocked - fallback stays in use
    return tensionBufferPromise;
  }

  // Starts the real drum track once, routed through dest so it fades with the
  // rest of the question's bed. It runs ~19.5s, longer than any question's
  // 10s answer window, so unlike the synthesised pulse it never needs to loop.
  function startTensionTrack(dest) {
    if (!ctx || !tensionBuffer) return;
    bedSource = ctx.createBufferSource();
    bedSource.buffer = tensionBuffer;
    var g = ctx.createGain();
    g.gain.value = TENSION_GAIN;
    bedSource.connect(g);
    g.connect(dest);
    bedSource.start(ctx.currentTime + 0.05);
  }

  // One note: oscillator through its own envelope, disposed when it finishes.
  function tone(freq, at, dur, type, peak, glideTo, dest) {
    if (!ctx) return;
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, at);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, at + dur);

    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + Math.min(0.02, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);

    osc.connect(g);
    g.connect(dest || master);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  // Filtered white noise - the percussive hits. dest lets the lobby loop's claps
  // and hats route through the bed bus so they fade out with everything else.
  function noise(at, dur, peak, freq, dest) {
    if (!ctx) return;
    var frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
    var buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

    var src = ctx.createBufferSource();
    src.buffer = buf;
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq || 1800;
    var g = ctx.createGain();
    g.gain.setValueAtTime(peak, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);

    src.connect(bp); bp.connect(g); g.connect(dest || master);
    src.start(at);
    src.stop(at + dur + 0.02);
  }

  function chord(freqs, at, dur, type, peak) {
    for (var i = 0; i < freqs.length; i++) tone(freqs[i], at, dur, type, peak);
  }

  // A low, rhythmic bass-and-drum pulse - the "epic, suspenseful" atmosphere
  // under a question. No high tone, no dissonant buzz: just a sustained sub
  // note for body and a slow heartbeat-style pair of kick thumps ("dum-dum
  // ... dum-dum ...") like a thriller score, so it reads as tension rather
  // than as a siren. dest lets it hang off the question's own bed so it
  // fades with everything else when the phase changes.
  function tensionPulse(at, dur, dest) {
    if (!ctx) return;
    var sub = ctx.createOscillator();
    var subG = ctx.createGain();
    sub.type = 'sine';
    sub.frequency.value = 41.20;                  // E1 - felt more than heard
    subG.gain.setValueAtTime(0.0001, at);
    subG.gain.exponentialRampToValueAtTime(0.10, at + 0.6);
    subG.gain.setValueAtTime(0.10, Math.max(at + 0.6, at + dur - 0.6));
    subG.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    sub.connect(subG);
    subG.connect(dest || master);
    sub.start(at); sub.stop(at + dur + 0.05);

    var beatGap = 0.42;    // spacing between the two thumps of one heartbeat
    var pairGap = 1.15;    // silence between heartbeats
    var end = at + dur;
    for (var tt = at; tt < end; tt += beatGap + pairGap) {
      tone(70, tt, 0.22, 'sine', 0.30, 32, dest);            // first thump, deep
      tone(60, tt + beatGap, 0.20, 'sine', 0.24, 26, dest);  // second thump, softer
    }
  }

  function clearLoop() {
    if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
    if (bedSource) {
      try { bedSource.stop(); } catch (e) { /* already ended on its own */ }
      bedSource = null;
    }
    if (bed && ctx) {
      // Pads ring for a whole bar, so cutting the node dead would chop a chord in
      // half. Fade the bus out instead and drop it once the tail has gone.
      var dying = bed;
      bed = null;
      try {
        var t = ctx.currentTime;
        dying.gain.cancelScheduledValues(t);
        dying.gain.setValueAtTime(dying.gain.value, t);
        dying.gain.linearRampToValueAtTime(0.0001, t + 0.25);
        setTimeout(function () { try { dying.disconnect(); } catch (e) { /* already gone */ } }, 500);
      } catch (e) { /* nothing left to fade */ }
    }
  }

  function notifyUnlockWatchers() {
    for (var i = 0; i < unlockWatchers.length; i++) {
      try { unlockWatchers[i](); } catch (e) { /* a listener must not break audio */ }
    }
  }

  // Note the capture phase and the deliberate lack of "once": resume() can be
  // rejected, so this keeps trying until the context is genuinely running.
  function armUnlock() {
    var fire = function () {
      if (!enabled) return;
      if (!ctx) ensure(); else if (ctx.state === 'suspended') ctx.resume().then(notifyUnlockWatchers, function () {});
      if (ctx && ctx.state === 'running') {
        document.removeEventListener('pointerdown', fire, true);
        document.removeEventListener('keydown', fire, true);
        document.removeEventListener('touchstart', fire, true);
      }
      notifyUnlockWatchers();
    };
    document.addEventListener('pointerdown', fire, true);
    document.addEventListener('keydown', fire, true);
    document.addEventListener('touchstart', fire, true);
  }
  armUnlock();

  /* ---------------- cues ---------------- */

  /* The lobby loop.
   *
   * A four bar C - G - Am - F progression at 132bpm with a four-on-the-floor kick,
   * an off-beat clap, a running eighth-note hat, and a sawtooth/square arp on top -
   * built to feel like a countdown-to-the-party rather than hold music. It is
   * written as data so the scheduler below stays dumb, and it wraps at the end of
   * bar four so it keeps running with no gap for as long as guests take to arrive.
   */
  var BED_BPM = 132;
  var BED_STEP = (60 / BED_BPM) / 2;      // one eighth note, in seconds
  var BED_STEPS_PER_BAR = 8;

  var BED_BARS = [
    { bass: 65.41,  pad: [261.63, 329.63, 392.00],            // C  : C2  / C4 E4 G4
      arp: [523.25, 659.25, 783.99, 659.25, 523.25, 659.25, 783.99, 1046.50] },
    { bass: 98.00,  pad: [246.94, 293.66, 392.00],            // G  : G2  / B3 D4 G4
      arp: [493.88, 587.33, 783.99, 587.33, 493.88, 587.33, 783.99, 987.77] },
    { bass: 110.00, pad: [220.00, 261.63, 329.63],            // Am : A2  / A3 C4 E4
      arp: [440.00, 523.25, 659.25, 523.25, 440.00, 523.25, 659.25, 880.00] },
    { bass: 87.31,  pad: [174.61, 220.00, 261.63],            // F  : F2  / F3 A3 C4
      arp: [349.23, 440.00, 523.25, 440.00, 349.23, 440.00, 523.25, 698.46] }
  ];

  // Schedules one eighth note of the loop at an exact time on the audio clock.
  function bedStepAt(step, at) {
    var barIndex = Math.floor(step / BED_STEPS_PER_BAR) % BED_BARS.length;
    var bar = BED_BARS[barIndex];
    var beat = step % BED_STEPS_PER_BAR;

    // Four-on-the-floor kick (a sine pitched down fast) on every quarter note -
    // this is what makes the loop drive instead of just float.
    if (beat % 2 === 0) tone(118, at, 0.15, 'sine', 0.30, 44, bed);
    // Clap on the backbeat.
    if (beat === 2 || beat === 6) noise(at, 0.09, 0.20, 2100, bed);
    // A light running hat keeps the pulse going even between the big hits, so
    // the loop never has a dead moment.
    noise(at, 0.03, 0.04, 8500, bed);

    if (beat === 0) {
      // Chord change: pad for the whole bar, bass on the downbeat.
      for (var i = 0; i < bar.pad.length; i++) {
        tone(bar.pad[i], at, BED_STEP * BED_STEPS_PER_BAR * 0.95, 'sawtooth', 0.075, null, bed);
      }
      tone(bar.bass, at, BED_STEP * 3.2, 'sawtooth', 0.20, null, bed);
    }
    if (beat === 4) tone(bar.bass, at, BED_STEP * 2.4, 'sawtooth', 0.15, null, bed);

    // The lead hook: a square wave doubled with a slightly detuned sawtooth a
    // few cents above it (a cheap "supersaw" trick) gives it the wide, bright
    // edge of an opening-theme hook instead of a thin single oscillator.
    var hookHz = bar.arp[beat];
    var hookPeak = beat % 2 === 0 ? 0.11 : 0.08;
    tone(hookHz, at, BED_STEP * 1.7, 'square', hookPeak, null, bed);
    tone(hookHz * 1.008, at, BED_STEP * 1.7, 'sawtooth', hookPeak * 0.5, null, bed);

    // A riser sweeping up into the last half-beat of the final bar - the small
    // "here it comes again" lift right before the loop turns over.
    if (barIndex === BED_BARS.length - 1 && beat === 6) {
      tone(220, at, BED_STEP * 2, 'sawtooth', 0.09, 1400, bed);
    }
  }

  /* More lobby music, picked on the projector (the 🎵 button) and remembered.
   * Each style is data plus one function that plays a single eighth-note step;
   * the same look-ahead scheduler runs whichever is chosen, so all of them loop
   * forever with no gap and no files to load. Notes are MIDI numbers. */
  function hz(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  var _ = null;   // a rest

  // 8-bit town: a warm pixel-RPG theme in F that matches the projector's art.
  var CHIP = {
    bpm: 104, steps: 8,
    chords: [[65, 69, 72], [62, 65, 69], [58, 62, 65], [60, 64, 67], [65, 69, 72], [62, 65, 69], [58, 62, 65], [65, 69, 72]],
    bass: [41, 38, 34, 36, 41, 38, 34, 41],
    lead: [[69, _, 72, _, 77, _, 76, 74], [72, _, 69, _, 65, _, 69, _], [70, _, 74, _, 77, _, 74, 70], [72, _, _, _, 67, _, 64, _],
           [69, _, 72, _, 77, _, 79, 81], [79, _, 77, _, 74, _, 77, _], [74, _, 70, _, 72, _, 76, _], [77, _, _, _, _, _, _, _]]
  };
  CHIP.bars = CHIP.lead.length;
  CHIP.play = function (step, at, len) {
    var b = Math.floor(step / 8), s = step % 8;
    var root = CHIP.bass[b] + (b === 6 && s >= 4 ? 2 : 0);          // Bb -> C for the turnaround
    var note = CHIP.lead[b][s];
    if (note) {
      tone(hz(note), at, len * 1.6, 'square', 0.045, null, bed);
      tone(hz(note + 12), at + len * 0.5, len * 0.9, 'triangle', 0.012, null, bed);   // a little echo above
    }
    if (s % 2 === 1) tone(hz(CHIP.chords[b][(s >> 1) % 3] + 12), at, len * 0.8, 'triangle', 0.03, null, bed);   // off-beat arp
    if (s === 0 || s === 4) tone(hz(root + (s === 4 ? 12 : 0)), at, len * 1.8, 'triangle', 0.16, null, bed);
    if (s === 2 || s === 6) tone(hz(root + 7), at, len * 1.2, 'triangle', 0.10, null, bed);
    if (s === 0 || s === 4) tone(110, at, 0.09, 'sine', 0.14, 50, bed);   // soft chip kick
    if (s === 2 || s === 6) noise(at, 0.06, 0.07, 3000, bed);            // soft snare
    noise(at, 0.02, s % 2 ? 0.025 : 0.015, 9000, bed);                   // hat
  };

  // Music box waltz: celesta bells over a gentle one-two-three, no drums.
  var WALTZ = {
    bpm: 92, steps: 6,
    chords: [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62], [60, 64, 67], [52, 55, 59], [53, 57, 60], [60, 64, 67]],
    bass: [36, 33, 29, 31, 36, 28, 29, 36],
    lead: [[76, _, _, _, 79, _], [81, _, 79, _, 76, _], [77, _, _, _, 81, _], [79, _, _, _, 74, _],
           [76, _, 79, _, 84, _], [83, _, 81, _, 79, _], [81, _, 77, _, 74, _], [72, _, _, _, _, _]]
  };
  WALTZ.bars = WALTZ.lead.length;
  WALTZ.play = function (step, at, len) {
    var b = Math.floor(step / 6), s = step % 6;
    var note = WALTZ.lead[b][s];
    if (note) {                                    // a bell: the note plus its quieter overtones
      tone(hz(note), at, 1.8, 'sine', 0.09, null, bed);
      tone(hz(note) * 2, at, 0.9, 'sine', 0.025, null, bed);
      tone(hz(note) * 3.01, at, 0.35, 'sine', 0.01, null, bed);
    }
    var chord = WALTZ.chords[b];
    if (b === 6 && s >= 3) chord = [55, 59, 62];   // F -> G on the last beat before home
    if (s === 0) tone(hz(WALTZ.bass[b]), at, len * 2.6, 'triangle', 0.18, null, bed);
    if (s === 2 || s === 4) {
      for (var i = 0; i < 3; i++) tone(hz(chord[i]), at, len * 1.4, 'triangle', 0.028, null, bed);
    }
    if (s === 0) for (var j = 0; j < 3; j++) tone(hz(chord[j] + 12), at, len * 6, 'sine', 0.008, null, bed);   // faint pad
  };

  // Bossa lounge: electric-piano comping, a walking two-feel bass, rim and shaker.
  var BOSSA = {
    bpm: 116, steps: 8,
    chords: [[60, 64, 67, 71], [57, 60, 64, 67], [62, 65, 69, 72], [59, 62, 65, 67],
             [59, 62, 64, 67], [61, 64, 67, 69], [62, 65, 69, 72], [59, 62, 65, 67]],
    bass: [36, 33, 38, 31, 40, 33, 38, 31],
    lead: [[76, _, _, 79, _, _, 83, _], [81, _, _, _, 79, _, 76, _], [77, _, _, 81, _, _, 84, _], [83, _, 81, _, 79, _, 77, _],
           [79, _, _, 83, _, _, 86, _], [85, _, _, _, 81, _, 79, _], [77, _, _, _, 81, _, _, _], [79, _, _, 77, _, 74, _, 71]]
  };
  BOSSA.bars = BOSSA.lead.length;
  var BOSSA_COMP = [[0, 3, 6], [2, 4, 7]];        // the bossa push, alternating bars
  BOSSA.play = function (step, at, len) {
    var b = Math.floor(step / 8), s = step % 8;
    var note = BOSSA.lead[b][s];
    if (note) {                                    // vibraphone-ish: sine with a slow wobble
      tone(hz(note), at, len * 3, 'sine', 0.07, null, bed);
      tone(hz(note) * 1.004, at + 0.02, len * 2.5, 'sine', 0.03, null, bed);
    }
    if (BOSSA_COMP[b % 2].indexOf(s) >= 0) {
      for (var i = 0; i < 4; i++) {
        tone(hz(BOSSA.chords[b][i]), at, len * 1.5, 'sine', 0.035, null, bed);
        tone(hz(BOSSA.chords[b][i] + 12), at, len * 0.6, 'triangle', 0.008, null, bed);   // the tine "bark"
      }
    }
    var root = BOSSA.bass[b];
    if (s === 0 || s === 4) tone(hz(root), at, len * 2.2, 'sine', 0.22, null, bed);
    if (s === 3 || s === 7) tone(hz(root + 7), at, len * 1.2, 'sine', 0.16, null, bed);
    if (s === 3 || s === 6) noise(at, 0.025, 0.06, 1900, bed);        // rim click
    noise(at, 0.04, s % 2 ? 0.03 : 0.018, 7000, bed);                 // shaker
  };

  // The original countdown-to-the-party loop, kept as one of the choices.
  var PARTY = { bpm: BED_BPM, steps: BED_STEPS_PER_BAR, bars: BED_BARS.length,
                play: function (step, at) { bedStepAt(step, at); } };

  var LOBBY_STYLES = {
    chip:  { name: '8-bit เมืองพิกเซล', style: CHIP },
    waltz: { name: 'กล่องดนตรีวอลทซ์', style: WALTZ },
    bossa: { name: 'บอสซาโนวาเลานจ์', style: BOSSA },
    party: { name: 'ปาร์ตี้ (เพลงเดิม)', style: PARTY }
  };
  var LOBBY_ORDER = ['chip', 'waltz', 'bossa', 'party'];
  var lobbyStyle = 'chip';
  try {
    var savedStyle = localStorage.getItem('wq.lobbyMusic');
    if (LOBBY_STYLES[savedStyle]) lobbyStyle = savedStyle;
  } catch (e) { /* private mode - default */ }

  var API = {
    // Called from the login click, which is the gesture the browser wants.
    unlock: function () { ensure(); },

    isEnabled: function () { return enabled; },

    // 'running' | 'suspended' | 'none' - anything but running means silence.
    state: function () { return ctx ? ctx.state : 'none'; },

    onUnlockChange: function (fn) { unlockWatchers.push(fn); },

    setEnabled: function (on) {
      enabled = !!on;
      try { localStorage.setItem('wq.sound', enabled ? 'on' : 'off'); } catch (e) { /* ignore */ }
      if (!enabled) {
        API.stopAll();
        if (master) master.gain.value = 0;
      } else if (ensure()) {
        master.gain.value = MASTER;
      }
    },

    stopAll: function () {
      clearLoop();
      lastReadyBeep = -1;
      lastTickAt = 0;
    },

    // Continuous background music while guests wander in and scan the QR.
    //
    // Notes are scheduled ahead on the audio clock rather than played the moment a
    // timer happens to fire: setInterval jitters by tens of milliseconds, which is
    // fine for the odd twinkle but audible as sloppy timing once there is a beat.
    lobby: function () {
      if (!ensure()) return;
      API.stopAll();
      var style = LOBBY_STYLES[lobbyStyle].style;
      var stepLen = (60 / style.bpm) / 2;
      var loopSteps = style.bars * style.steps;

      bed = ctx.createGain();
      bed.gain.value = 0.0001;
      bed.connect(master);
      bed.gain.linearRampToValueAtTime(1, ctx.currentTime + 1.2);   // fade in, no thud

      bedStep = 0;
      bedNextTime = ctx.currentTime + 0.12;

      var schedule = function () {
        try {
          if (!bed) { clearLoop(); return; }
          // Stay about a fifth of a second ahead of the playhead.
          while (bedNextTime < ctx.currentTime + 0.2) {
            style.play(bedStep, bedNextTime, stepLen);
            bedNextTime += stepLen;
            bedStep = (bedStep + 1) % loopSteps;
          }
        } catch (e) {
          clearLoop();          // fail silent and stay stopped, never once per tick
        }
      };
      schedule();
      loopTimer = setInterval(schedule, 25);
    },

    // Which lobby music plays: the projector's 🎵 button walks through these.
    lobbyStyles: function () {
      return LOBBY_ORDER.map(function (k) { return { id: k, name: LOBBY_STYLES[k].name }; });
    },
    lobbyStyle: function () { return lobbyStyle; },
    setLobbyStyle: function (id) {
      if (!LOBBY_STYLES[id]) return;
      lobbyStyle = id;
      try { localStorage.setItem('wq.lobbyMusic', id); } catch (e) { /* ignore */ }
    },

    // 3-2-1 before the answers unlock: a big drum hit per second, tightening
    // and hitting harder as it counts down to "1" - the drop the question's
    // reveal-of-answers moment deserves, instead of a thin beep.
    readyBeep: function (secondsLeft) {
      if (!ensure() || secondsLeft === lastReadyBeep) return;
      lastReadyBeep = secondsLeft;
      var t = ctx.currentTime;
      var step = secondsLeft >= 3 ? 0 : (secondsLeft === 2 ? 1 : 2);   // 0 -> 3, 2 -> 1
      var peak = (0.30 + step * 0.05) * 0.7;   // -30% from the original hit
      // A low tom (with a sub layer under it for weight) - pitched up slightly
      // each beat, like the hit is winding tighter toward the drop.
      tone(150 + step * 20, t, 0.28, 'sine', peak, 55 + step * 8);
      tone(75 + step * 10, t, 0.34, 'sine', peak * 0.7, 27 + step * 4);
      noise(t, 0.12, peak * 0.6, 1600);                                // crack on top of the hit
      var pitch = secondsLeft >= 3 ? 440 : (secondsLeft === 2 ? 554.37 : 659.25);
      tone(pitch, t + 0.02, 0.12, 'square', 0.07);                     // faint pitched cue, for "which count" clarity
    },

    // The question is live: a hit, then the epic drum track (or, until it has
    // loaded, the synthesised bass/drum pulse) sits underneath the whole
    // answer window while the accelerating tick() cue drives on top of it.
    questionStart: function () {
      if (!ensure()) return;
      clearLoop();
      lastTickAt = 0;
      var t = ctx.currentTime;
      chord([523.25, 659.25, 783.99], t, 0.35, 'sawtooth', 0.16);
      noise(t, 0.18, 0.22, 1200);
      tone(110, t, 0.5, 'sine', 0.22);

      bed = ctx.createGain();
      bed.gain.value = 1;
      bed.connect(master);
      var liveBed = bed;

      if (tensionBuffer) {
        // ~19.5s, comfortably longer than any question's 10s answer window,
        // so - unlike the fallback pulse - it never needs to loop.
        startTensionTrack(liveBed);
      } else {
        loadTensionBuffer();
        // The pulse re-triggers itself every 9s so it keeps covering the
        // question no matter how long the host set the time limit to, until
        // clearLoop() (a phase change) fades it out - the same bus-and-fade
        // mechanic the lobby loop uses, just holding one long note instead of
        // a sequenced pattern. Only used while the real track is still loading.
        var retrigger = function () {
          if (bed !== liveBed) return;   // a later clearLoop() already replaced/cleared it
          tensionPulse(ctx.currentTime + 0.05, 9.5, liveBed);
        };
        retrigger();
        loopTimer = setInterval(retrigger, 9000);
      }
    },

    // Driven from the existing requestAnimationFrame timer so the ticks stay
    // locked to the server clock. The interval tightens and the pitch climbs as
    // the clock runs down - that acceleration is what builds the tension.
    tick: function (msLeft, msTotal) {
      if (!ensure() || msLeft <= 0) return;
      var frac = msTotal > 0 ? msLeft / msTotal : 1;
      var interval, pitch, vol;

      if (msLeft <= 3000)      { interval = 200; pitch = 1244.51; vol = 0.20; }
      else if (msLeft <= 5000) { interval = 300; pitch = 987.77;  vol = 0.17; }
      else if (frac <= 0.35)   { interval = 450; pitch = 830.61;  vol = 0.14; }
      else if (frac <= 0.65)   { interval = 600; pitch = 659.25;  vol = 0.12; }
      else                     { interval = 800; pitch = 523.25;  vol = 0.10; }

      var nowMs = ctx.currentTime * 1000;
      if (nowMs - lastTickAt < interval) return;
      lastTickAt = nowMs;

      var t = ctx.currentTime;
      tone(pitch, t, 0.07, 'square', vol);
      // A low war-drum thump under every tick, pitched down fast like the lobby
      // kick - this is what turns "a beep" into "something heavy is closing in".
      tone(msLeft <= 5000 ? 92 : 68, t, 0.17, 'sine', msLeft <= 3000 ? 0.30 : 0.20,
        msLeft <= 5000 ? 40 : 30);
      if (msLeft <= 3000) noise(t, 0.04, 0.09, 3000);
    },

    // Time is up, or the host hit skip.
    timeUp: function () {
      if (!ensure()) return;
      clearLoop();
      var t = ctx.currentTime;
      tone(440, t, 0.5, 'sawtooth', 0.20, 110);
      noise(t, 0.3, 0.20, 900);
    },

    // The answer goes up on the big screen.
    // The answer goes up on the big screen: a short rising pickup, then one
    // resolute, anthemic chord hit - bigger and brighter than a plain chord,
    // meant to feel like a decision landing rather than a chime.
    reveal: function () {
      if (!ensure()) return;
      clearLoop();
      var t = ctx.currentTime;
      var pickup = [523.25, 659.25, 783.99];
      for (var i = 0; i < pickup.length; i++) {
        tone(pickup[i], t + i * 0.075, 0.16, 'sawtooth', 0.13);
      }
      var hitAt = t + pickup.length * 0.075 + 0.03;
      chord([523.25, 659.25, 783.99, 1046.50, 1318.51], hitAt, 0.85, 'sawtooth', 0.11);
      tone(130.81, hitAt, 0.7, 'sine', 0.22, 65.41);        // low punch under the chord
      noise(hitAt, 0.35, 0.18, 2000);
      noise(hitAt, 0.05, 0.16, 3200);                       // a sharp crack for impact
    },

    // Leaderboard: a short rising shimmer, then quiet so the MC can talk.
    scoreboard: function () {
      if (!ensure()) return;
      clearLoop();
      var t = ctx.currentTime;
      var notes = [523.25, 659.25, 783.99, 1046.50, 1318.51];
      for (var i = 0; i < notes.length; i++) {
        tone(notes[i], t + i * 0.09, 0.45, 'triangle', 0.13);
      }
      tone(130.81, t, 1.2, 'sine', 0.10);
    },

    // One place arriving on the podium: a swell that rises, pitched by placing so
    // third and second do not sound identical and neither steals the fanfare.
    podiumRise: function (place) {
      if (!ensure()) return;
      var t = ctx.currentTime;
      var root = place === 3 ? 261.63 : 329.63;      // C4 for third, E4 for second
      tone(root, t, 0.55, 'triangle', 0.16, root * 2);
      tone(root / 2, t, 0.6, 'sine', 0.20);
      chord([root * 2, root * 2.5], t + 0.28, 0.4, 'triangle', 0.11);
      noise(t, 0.22, 0.16, 1400);
    },

    // Podium. This one is allowed to be loud.
    podium: function () {
      if (!ensure()) return;
      clearLoop();
      var t = ctx.currentTime;
      var fanfare = [
        [523.25, 0.00, 0.18], [659.25, 0.18, 0.18], [783.99, 0.36, 0.18],
        [1046.50, 0.54, 0.55], [783.99, 1.15, 0.16], [1046.50, 1.31, 0.16],
        [1318.51, 1.47, 0.90]
      ];
      for (var i = 0; i < fanfare.length; i++) {
        tone(fanfare[i][0], t + fanfare[i][1], fanfare[i][2], 'sawtooth', 0.20);
        tone(fanfare[i][0] / 2, t + fanfare[i][1], fanfare[i][2], 'triangle', 0.12);
      }
      noise(t, 0.4, 0.20, 1000);
      noise(t + 0.54, 0.5, 0.18, 1400);
      chord([261.63, 329.63, 392.00], t + 1.47, 1.4, 'triangle', 0.14);
    },

    // A guest just walked into the lobby: a soft two-note "pling" over the
    // lobby loop. During the join rush many land at once, so they are spaced
    // out instead of piling into one loud smear.
    guestJoin: function () {
      if (!ensure()) return;
      var t = ctx.currentTime;
      if (t - lastJoinAt < 0.16) return;
      lastJoinAt = t;
      var up = [1318.51, 1567.98, 1760.00][Math.floor(Math.random() * 3)];   // a little variety
      tone(up * 0.75, t, 0.12, 'triangle', 0.07);
      tone(up, t + 0.07, 0.22, 'triangle', 0.08);
    },

    // A guest rang the bell for the next question: a bright little "ding-ding",
    // spaced out like guestJoin so a rush of rings stays a ring, not a smear.
    // Two strikes of a small brass bell: a real bell's off-key partials (hum,
    // strike, minor third, fifth, octave...) each ringing out at its own length,
    // so it sounds struck rather than beeped. The pitch wanders a little per ring.
    bellRing: function () {
      if (!ensure()) return;
      var t = ctx.currentTime;
      if (t - lastBellAt < 0.25) return;
      lastBellAt = t;
      var f = 1046.5 * (0.97 + Math.random() * 0.06);
      [0, 0.16].forEach(function (at, k) {
        var v = k ? 0.8 : 1;
        tone(f * 0.5, t + at, 1.6, 'sine', 0.035 * v);
        tone(f, t + at, 1.3, 'sine', 0.09 * v);
        tone(f * 1.19, t + at, 0.9, 'sine', 0.045 * v);
        tone(f * 1.5, t + at, 0.7, 'sine', 0.035 * v);
        tone(f * 2.0, t + at, 0.55, 'sine', 0.03 * v);
        tone(f * 2.74, t + at, 0.3, 'sine', 0.02 * v);
        tone(f * 4.1, t + at, 0.12, 'triangle', 0.02 * v);   // the clapper's tick
      });
    },

    // The scene changes for a new question: a rising airy sweep that ends on a
    // small sparkle, the moment the new background has the screen to itself.
    sceneWhoosh: function () {
      if (!ensure()) return;
      var t = ctx.currentTime;
      var dur = 1.1;
      var frames = Math.floor(ctx.sampleRate * dur);
      var buf = ctx.createBuffer(1, frames, ctx.sampleRate);
      var data = buf.getChannelData(0);
      for (var i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
      var src = ctx.createBufferSource();
      src.buffer = buf;
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 1.4;
      bp.frequency.setValueAtTime(260, t);
      bp.frequency.exponentialRampToValueAtTime(3200, t + dur);
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16, t + dur * 0.7);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(bp); bp.connect(g); g.connect(master);
      src.start(t); src.stop(t + dur + 0.02);
      [1567.98, 2093.00, 2637.02].forEach(function (f, k) {
        tone(f, t + dur - 0.15 + k * 0.06, 0.25, 'triangle', 0.06);
      });
    },

    // "Bonus round, points x2": a snare roll that speeds up into two brass
    // stabs and a big held chord, with a sub hit under each stab.
    bonusRound: function () {
      if (!ensure()) return;
      clearLoop();
      var t = ctx.currentTime;
      var at = t, gap = 0.11;
      while (at < t + 1.3) {                        // the roll, tightening
        noise(at, 0.06, 0.10 + (at - t) * 0.12, 2400);
        at += gap;
        gap = Math.max(0.035, gap * 0.9);
      }
      var stab1 = t + 1.35, stab2 = t + 1.65, hold = t + 1.95;
      chord([392.00, 493.88, 587.33], stab1, 0.22, 'sawtooth', 0.12);
      tone(98.00, stab1, 0.3, 'sine', 0.26, 60);
      chord([392.00, 493.88, 587.33], stab2, 0.22, 'sawtooth', 0.12);
      tone(98.00, stab2, 0.3, 'sine', 0.26, 60);
      chord([523.25, 659.25, 783.99, 1046.50], hold, 1.4, 'sawtooth', 0.11);
      chord([261.63, 392.00], hold, 1.4, 'triangle', 0.12);
      tone(130.81, hold, 0.9, 'sine', 0.28, 65.41);
      noise(hold, 0.6, 0.20, 1200);
      noise(hold, 0.06, 0.18, 3600);                // crack on the downbeat
    },

    // The finale dash to the altar: footsteps that speed up with the camera,
    // wind rising behind them, then a crash and a chord on "GOAL!" (at
    // goalAt seconds, matching the banner in playGoalRun()).
    goalRun: function (goalAt) {
      if (!ensure()) return;
      clearLoop();
      var t = ctx.currentTime;
      var hit = t + (goalAt || 1.2);
      var at = t, gap = 0.26;
      while (at < hit - 0.05) {
        tone(90, at, 0.12, 'sine', 0.22, 45);
        noise(at, 0.05, 0.08, 700);
        at += gap;
        gap = Math.max(0.12, gap * 0.86);
      }
      tone(220, t, hit - t, 'sawtooth', 0.03, 880);   // the wind/rush rising under the steps
      noise(hit, 0.9, 0.24, 1600);                    // the crash
      noise(hit, 0.08, 0.20, 4200);
      chord([523.25, 659.25, 783.99, 1046.50, 1318.51], hit, 1.1, 'sawtooth', 0.10);
      tone(130.81, hit, 0.9, 'sine', 0.30, 55);
    }
  };

  window.WQSound = API;
})();
