/* Wedding Quiz - projector sound.
 *
 * Everything here is synthesised live with the Web Audio API: no mp3 files, so
 * nothing to license, nothing to download at the venue, and nothing added to the
 * repo. It also means the ticking can follow the server-authoritative clock
 * exactly instead of drifting against a pre-recorded loop.
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
  var loopTimer = null;      // lobby bed
  var lastTickAt = 0;        // guards the per-frame tick scheduler
  var lastReadyBeep = -1;

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
      master.gain.value = 0.30;          // a PA will amplify this - stay polite
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // One note: oscillator through its own envelope, disposed when it finishes.
  function tone(freq, at, dur, type, peak, glideTo) {
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
    g.connect(master);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  // Filtered white noise - the percussive hits.
  function noise(at, dur, peak, freq) {
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

    src.connect(bp); bp.connect(g); g.connect(master);
    src.start(at);
    src.stop(at + dur + 0.02);
  }

  function chord(freqs, at, dur, type, peak) {
    for (var i = 0; i < freqs.length; i++) tone(freqs[i], at, dur, type, peak);
  }

  function clearLoop() {
    if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
  }

  /* ---------------- cues ---------------- */

  var LOBBY = [523.25, 659.25, 783.99, 659.25, 587.33, 783.99, 1046.50, 783.99];

  var API = {
    // Called from the login click, which is the gesture the browser wants.
    unlock: function () { ensure(); },

    isEnabled: function () { return enabled; },

    setEnabled: function (on) {
      enabled = !!on;
      try { localStorage.setItem('wq.sound', enabled ? 'on' : 'off'); } catch (e) { /* ignore */ }
      if (!enabled) {
        API.stopAll();
        if (master) master.gain.value = 0;
      } else if (ensure()) {
        master.gain.value = 0.30;
      }
    },

    stopAll: function () {
      clearLoop();
      lastReadyBeep = -1;
      lastTickAt = 0;
    },

    // Warm, unhurried arpeggio while guests wander in and scan the QR.
    lobby: function () {
      if (!ensure()) return;
      API.stopAll();
      var step = 0;
      var play = function () {
        try {
          var t = ctx.currentTime;
          tone(LOBBY[step % LOBBY.length], t, 0.9, 'triangle', 0.10);
          if (step % 4 === 0) tone(130.81, t, 1.4, 'sine', 0.09);   // soft C3 pad underneath
          step++;
        } catch (e) {
          clearLoop();          // fail silent and stay stopped, never once per tick
        }
      };
      play();
      loopTimer = setInterval(play, 430);
    },

    // 3-2-1 before the answers unlock: one rising beep per second.
    readyBeep: function (secondsLeft) {
      if (!ensure() || secondsLeft === lastReadyBeep) return;
      lastReadyBeep = secondsLeft;
      var t = ctx.currentTime;
      var pitch = secondsLeft >= 3 ? 440 : (secondsLeft === 2 ? 554.37 : 659.25);
      tone(pitch, t, 0.16, 'square', 0.18);
      noise(t, 0.05, 0.10, 2400);
    },

    // The question is live: a hit, then the pulse bed starts ticking.
    questionStart: function () {
      if (!ensure()) return;
      clearLoop();
      lastTickAt = 0;
      var t = ctx.currentTime;
      chord([523.25, 659.25, 783.99], t, 0.35, 'sawtooth', 0.16);
      noise(t, 0.18, 0.22, 1200);
      tone(110, t, 0.5, 'sine', 0.22);
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
      tone(msLeft <= 5000 ? 110 : 82.41, t, 0.16, 'sine', 0.18);   // heartbeat
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
    reveal: function () {
      if (!ensure()) return;
      clearLoop();
      var t = ctx.currentTime;
      chord([523.25, 659.25, 783.99, 1046.50], t, 0.7, 'triangle', 0.15);
      noise(t, 0.25, 0.16, 1600);
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
    }
  };

  window.WQSound = API;
})();
