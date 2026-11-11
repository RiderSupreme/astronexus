// Sound, all of it synthesised in the browser: no samples are downloaded.
//
// Gunfire is shaped noise over a pitched thump, thrown at a generated reverb
// and a slap-back delay so it rings off the concrete. The infected are a
// sawtooth pushed through two wandering formants. Under everything sits a
// tanpura-like drone on Sa and Pa, with a pulse that quickens as they close in.
import { clamp, makeRng, lerp } from './util.js';

const BHAIRAV = [0, 1, 4, 5, 7, 8, 11, 12];      // the raga's steps above Sa, in semitones

export class GameAudio {
  constructor() { this.ctx = null; this.rng = makeRng(99); this.voices = 0; this.vol = 0.8; this.musicVol = 0.6; this.tension = 0; this.t = 0; this.next = {}; }

  // Must be called from a click: browsers will not start audio otherwise.
  start() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const c = this.ctx = new AC();
    this.master = c.createGain(); this.master.gain.value = this.vol;
    const comp = c.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 5; comp.attack.value = 0.003; comp.release.value = 0.2;
    this.master.connect(comp); comp.connect(c.destination);
    this.sfx = c.createGain(); this.sfx.connect(this.master);
    this.amb = c.createGain(); this.amb.gain.value = 1.3; this.amb.connect(this.master);
    this.music = c.createGain(); this.music.gain.value = this.musicVol; this.music.connect(this.master);
    // reverb: decaying noise as the impulse response of a very large, very hard room
    const len = Math.floor(c.sampleRate * 2.6), ir = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); let lp = 0; for (let i = 0; i < len; i++) { const t = i / len; lp += ((Math.random() * 2 - 1) - lp) * (0.5 - 0.42 * t); d[i] = lp * Math.pow(1 - t, 2.6) * (i < 400 ? i / 400 : 1); } }
    this.verb = c.createConvolver(); this.verb.buffer = ir;
    const vg = c.createGain(); vg.gain.value = 0.55; this.verb.connect(vg); vg.connect(this.master);
    // slap-back off the far façade
    this.echo = c.createDelay(1); this.echo.delayTime.value = 0.31; const fb = c.createGain(); fb.gain.value = 0.28; const elp = c.createBiquadFilter(); elp.type = 'lowpass'; elp.frequency.value = 1400;
    this.echo.connect(elp); elp.connect(fb); fb.connect(this.echo); const eg = c.createGain(); eg.gain.value = 0.3; elp.connect(eg); eg.connect(this.master);
    // two seconds of white noise, reused for everything
    const nb = this.noise = c.createBuffer(1, c.sampleRate * 2, c.sampleRate), nd = nb.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    this._ambience();
  }
  setVolume(v, m) { this.vol = v; this.musicVol = m; if (this.ctx) { this.master.gain.value = v; this.music.gain.value = m; } }
  suspend(on) { if (this.ctx) { if (on) this.ctx.suspend(); else this.ctx.resume(); } }

  // ---- building blocks ----
  _noise(dur, type, f0, f1, q, gain, dest, when = 0, attack = 0.002) {
    const c = this.ctx, t = c.currentTime + when, s = c.createBufferSource(); s.buffer = this.noise; s.loop = true;
    const f = c.createBiquadFilter(); f.type = type; f.Q.value = q; f.frequency.setValueAtTime(f0, t); if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(dest); s.start(t, Math.random() * 1.5); s.stop(t + dur + 0.05);
    return g;
  }
  _tone(dur, type, f0, f1, gain, dest, when = 0, attack = 0.003) {
    const c = this.ctx, t = c.currentTime + when, o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, t); if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(10, f1), t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest); o.start(t); o.stop(t + dur + 0.05);
    return o;
  }
  // A place in the world for a sound to come from.
  _at(x, y, z, ref = 4, max = 90, roll = 1.1) {
    const c = this.ctx, p = c.createPanner(); p.panningModel = 'equalpower'; p.distanceModel = 'inverse'; p.refDistance = ref; p.maxDistance = max; p.rolloffFactor = roll;
    if (p.positionX) { p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z; } else p.setPosition(x, y, z);
    p.connect(this.sfx); const send = c.createGain(); send.gain.value = 0.35; p.connect(send); send.connect(this.verb);
    return p;
  }
  _wet(amount = 0.5) { const g = this.ctx.createGain(); g.connect(this.sfx); const s = this.ctx.createGain(); s.gain.value = amount; g.connect(s); s.connect(this.verb); const e = this.ctx.createGain(); e.gain.value = amount * 0.7; g.connect(e); e.connect(this.echo); return g; }

  // ---- weapons ----
  shot(kind) {
    if (!this.ctx) return;
    const d = this._wet(kind === 'shotgun' ? 0.75 : 0.55), r = this.rng;
    if (kind === 'pistol') { this._noise(0.11, 'bandpass', 2100 * r.range(0.92, 1.08), 700, 0.6, 1.0, d); this._tone(0.09, 'sine', 170, 55, 0.9, d); this._noise(0.45, 'lowpass', 1100, 260, 0.4, 0.22, d, 0.01); }
    else if (kind === 'rifle') { this._noise(0.09, 'bandpass', 2900 * r.range(0.94, 1.06), 900, 0.5, 1.15, d); this._noise(0.012, 'highpass', 6000, 6000, 0.5, 0.8, d); this._tone(0.08, 'sine', 210, 60, 1.0, d); this._noise(0.6, 'lowpass', 1500, 240, 0.4, 0.26, d, 0.01); }
    else { this._noise(0.2, 'lowpass', 2600, 420, 0.5, 1.4, d); this._tone(0.16, 'sine', 120, 38, 1.3, d); this._noise(0.9, 'lowpass', 900, 160, 0.4, 0.4, d, 0.02); }
  }
  play(name) {
    if (!this.ctx) return;
    const s = this.sfx, c = this.ctx;
    switch (name) {
      case 'dry': case 'click': this._noise(0.03, 'bandpass', 3200, 3200, 3, 0.4, s); break;
      case 'magout': this._noise(0.05, 'bandpass', 1500, 900, 2, 0.45, s); this._tone(0.05, 'square', 190, 120, 0.1, s, 0.02); break;
      case 'magin': this._noise(0.05, 'bandpass', 1900, 1300, 2, 0.5, s); this._tone(0.06, 'square', 150, 220, 0.12, s, 0.03); break;
      case 'slide': this._noise(0.05, 'bandpass', 2600, 1700, 2.5, 0.5, s); this._noise(0.04, 'bandpass', 3400, 2400, 3, 0.45, s, 0.08); break;
      case 'pump': this._noise(0.07, 'bandpass', 1300, 800, 2, 0.6, s); this._noise(0.06, 'bandpass', 1700, 2300, 2, 0.6, s, 0.14); break;
      case 'shell': this._noise(0.04, 'bandpass', 2300, 1500, 3, 0.4, s); this._tone(0.03, 'triangle', 300, 250, 0.12, s, 0.03); break;
      case 'switch': this._noise(0.12, 'bandpass', 900, 500, 1, 0.22, s); break;
      case 'swing': this._noise(0.22, 'bandpass', 500, 1700, 1.2, 0.3, s, 0, 0.08); break;
      case 'meleehit': this._noise(0.1, 'lowpass', 500, 160, 0.7, 1.0, s); this._tone(0.1, 'sine', 110, 50, 0.7, s); break;
      case 'pickup': this._tone(0.07, 'triangle', 660, 660, 0.16, s); this._tone(0.12, 'triangle', 990, 990, 0.14, s, 0.07); break;
      case 'cell': this._tone(0.5, 'sine', 220, 220, 0.2, s); this._tone(0.5, 'sine', 330, 330, 0.16, s, 0.12); this._tone(0.7, 'sine', 440, 440, 0.14, s, 0.24); break;
      case 'radio': this._noise(0.09, 'bandpass', 2400, 2400, 6, 0.12, s); this._tone(0.06, 'square', 1250, 1250, 0.03, s, 0.02); break;
      case 'nightfall': { const d = this._wet(0.8); this._tone(3.5, 'sawtooth', 55, 41, 0.22, d, 0, 0.8); this._tone(3.5, 'sawtooth', 58.3, 43.6, 0.18, d, 0, 0.8); this._noise(3, 'lowpass', 300, 90, 0.5, 0.25, d, 0, 1.2); break; }
      case 'beacon': { const d = this._wet(0.6); this._tone(1.6, 'sawtooth', 60, 120, 0.2, d, 0, 0.6); this._tone(2.2, 'sine', 240, 480, 0.14, d, 0.3, 0.8); this._noise(0.3, 'bandpass', 3000, 800, 1, 0.3, d, 1.5); break; }
      case 'dawn': { const d = this._wet(0.8); for (const [i, st] of [0, 4, 7, 12].entries()) this._tone(5, 'sine', 138.6 * Math.pow(2, st / 12), 138.6 * Math.pow(2, st / 12), 0.13, d, i * 0.9, 1.2); break; }
      case 'hurt': this._noise(0.14, 'lowpass', 420, 120, 0.7, 0.9, s); this._tone(0.16, 'sine', 90, 45, 0.6, s); break;
      case 'step_c': this._noise(0.05, 'bandpass', 900 * this.rng.range(0.85, 1.15), 400, 1, 0.2, s); this._noise(0.012, 'highpass', 3000, 3000, 0.5, 0.08, s); break;
      case 'step_g': this._noise(0.11, 'highpass', 2200 * this.rng.range(0.8, 1.2), 3600, 0.5, 0.12, s, 0, 0.02); this._noise(0.05, 'lowpass', 260, 140, 0.7, 0.16, s); break;
      case 'step_w': this._noise(0.2, 'bandpass', 700, 280, 0.9, 0.3, s, 0, 0.03); this._noise(0.12, 'highpass', 2600, 1500, 0.5, 0.09, s, 0.05); break;
      case 'land': this._noise(0.1, 'lowpass', 380, 110, 0.7, 0.45, s); break;
    }
  }
  at(name, x, y, z) {
    if (!this.ctx) return;
    const p = this._at(x, y, z);
    switch (name) {
      case 'flesh': this._noise(0.07, 'lowpass', 700, 180, 0.8, 2.0, p); this._noise(0.1, 'bandpass', 1400, 500, 2, 0.8, p, 0.01); break;
      case 'thud': this._noise(0.05, 'bandpass', 1500 * this.rng.range(0.8, 1.2), 600, 1.2, 1.6, p); break;
      case 'ricochet': { const o = this._tone(0.28, 'sine', this.rng.range(2600, 3600), this.rng.range(900, 1500), 0.25, p); this._noise(0.03, 'highpass', 4000, 4000, 0.5, 0.5, p); break; }
      case 'splash': this._noise(0.3, 'bandpass', 1100, 320, 0.8, 0.7, p, 0, 0.02); break;
      case 'clink': this._tone(0.08, 'triangle', 1900, 1500, 0.3, p); break;
      case 'boom': { const d = this._wet(0.9); this._noise(1.6, 'lowpass', 1800, 60, 0.4, 2.2, p); this._tone(1.1, 'sine', 70, 24, 1.6, d); this._noise(2.4, 'lowpass', 500, 80, 0.4, 0.6, d, 0.05); break; }
    }
  }
  casing(k) { if (this.ctx && this.rng() < 0.7) { const p = this._at(k.x, k.y, k.z, 1.5, 20); this._tone(0.06, 'sine', this.rng.range(4200, 6200), 3800, 0.09, p); } }

  // ---- the infected ----
  infected(what, s) {
    if (!this.ctx || this.voices >= 7) return;
    const c = this.ctx, r = this.rng, p = this._at(s.pos.x, s.pos.y + 1.5, s.pos.z, 6, 120, 0.9), t = c.currentTime;
    const big = s.kind === 'brute', base = (big ? 58 : s.kind === 'runner' ? 118 : 86) * r.range(0.85, 1.2);
    const dur = what === 'groan' ? r.range(0.8, 1.7) : what === 'attack' ? 0.42 : what === 'die' ? 1.1 : what === 'rise' ? 0.9 : 0.5;
    const o = c.createOscillator(); o.type = 'sawtooth';
    const f0 = what === 'attack' ? base * 1.7 : what === 'wake' ? base * 1.3 : base;
    o.frequency.setValueAtTime(f0, t); o.frequency.linearRampToValueAtTime(f0 * (what === 'die' ? 0.5 : what === 'attack' ? 0.8 : r.range(0.75, 1.1)), t + dur);
    // roughness: a slow wobble on the pitch and a fast one on the level
    const lfo = c.createOscillator(); lfo.frequency.value = what === 'attack' ? 31 : r.range(17, 27); const lg = c.createGain(); lg.gain.value = f0 * 0.09; lfo.connect(lg); lg.connect(o.frequency);
    const F1 = c.createBiquadFilter(), F2 = c.createBiquadFilter(); F1.type = F2.type = 'bandpass'; F1.Q.value = 5; F2.Q.value = 7;
    const a1 = r.range(480, 760), a2 = r.range(950, 1350);
    F1.frequency.setValueAtTime(a1, t); F1.frequency.linearRampToValueAtTime(a1 * r.range(0.7, 1.3), t + dur); F2.frequency.setValueAtTime(a2, t); F2.frequency.linearRampToValueAtTime(a2 * r.range(0.75, 1.25), t + dur);
    const g = c.createGain(), peak = (what === 'attack' ? 2.0 : what === 'die' ? 1.8 : 1.7) * (big ? 1.35 : 1);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + dur * 0.18); g.gain.setValueAtTime(peak, t + dur * 0.55); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(F1); o.connect(F2); F1.connect(g); F2.connect(g); g.connect(p);
    this._noise(dur, 'bandpass', a2, a1, 1.5, peak * 0.22, p, 0, dur * 0.2);       // breath
    o.start(t); lfo.start(t); o.stop(t + dur + 0.05); lfo.stop(t + dur + 0.05);
    this.voices++; setTimeout(() => { this.voices--; }, dur * 1000 + 80);
  }

  // ---- what the place sounds like when nobody is shooting ----
  _ambience() {
    const c = this.ctx;
    const wind = c.createBufferSource(); wind.buffer = this.noise; wind.loop = true;
    const wf = c.createBiquadFilter(); wf.type = 'bandpass'; wf.frequency.value = 420; wf.Q.value = 0.5; this.windF = wf;
    this.windG = c.createGain(); this.windG.gain.value = 0.1; wind.connect(wf); wf.connect(this.windG); this.windG.connect(this.amb); wind.start();
    // leaves: the same noise, brighter
    const lf = c.createBiquadFilter(); lf.type = 'highpass'; lf.frequency.value = 2800; this.leafG = c.createGain(); this.leafG.gain.value = 0.02; wind.connect(lf); lf.connect(this.leafG); this.leafG.connect(this.amb);
    // crickets: one carrier, chopped
    const cr = c.createOscillator(); cr.type = 'sine'; cr.frequency.value = 4300; const chop = c.createOscillator(); chop.type = 'square'; chop.frequency.value = 58;
    const cg = c.createGain(); cg.gain.value = 0; chop.connect(cg.gain); this.cricketG = c.createGain(); this.cricketG.gain.value = 0;
    const slow = c.createOscillator(); slow.frequency.value = 1.9; const sg = c.createGain(); sg.gain.value = 0.5; const pulse = c.createGain(); pulse.gain.value = 0.5; slow.connect(sg); sg.connect(pulse.gain);
    cr.connect(cg); cg.connect(pulse); pulse.connect(this.cricketG); this.cricketG.connect(this.amb); cr.start(); chop.start(); slow.start();
  }
  _bird(pan) {
    const c = this.ctx, r = this.rng, p = c.createStereoPanner ? c.createStereoPanner() : c.createGain(); if (p.pan) p.pan.value = pan; p.connect(this.amb);
    const kind = r();
    if (kind < 0.4) { const f = r.range(650, 800); for (let i = 0; i < r.int(2, 4); i++) { this._tone(0.22, 'sine', f * (1 + i * 0.06), f * 1.55 * (1 + i * 0.06), 0.05, p, i * 0.42, 0.05); } }       // koel: a rising, repeated whoop
    else if (kind < 0.75) { for (let i = 0; i < r.int(3, 7); i++) this._tone(0.05, 'sine', r.range(2600, 3800), r.range(2000, 4200), 0.03, p, i * r.range(0.07, 0.11), 0.01); }           // something small in the creepers
    else { for (let i = 0; i < r.int(1, 3); i++) { this._tone(0.16, 'sawtooth', r.range(520, 600), 430, 0.022, p, i * 0.3, 0.03); this._noise(0.16, 'bandpass', 1500, 1100, 3, 0.03, p, i * 0.3, 0.03); } }   // a crow
  }
  // ---- the score ----
  _pluck(semi, when, gain) {
    const c = this.ctx, t = c.currentTime + when, f = 69.3 * Math.pow(2, semi / 12);            // Sa is C sharp
    for (const det of [-3, 4]) {
      const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = det;
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 3.5; bp.frequency.setValueAtTime(f * 9, t); bp.frequency.exponentialRampToValueAtTime(f * 2.2, t + 2.6);       // the buzz of the bridge, sliding down the overtones
      const g = c.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + 4.2);
      o.connect(bp); bp.connect(g); g.connect(this.music); const s = c.createGain(); s.gain.value = 0.5; g.connect(s); s.connect(this.verb);
      o.start(t); o.stop(t + 4.4);
    }
  }
  _flute(semi, when, dur) {
    const c = this.ctx, t = c.currentTime + when, f = 277.2 * Math.pow(2, semi / 12);
    const o = c.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(f * 0.985, t); o.frequency.linearRampToValueAtTime(f, t + 0.25);
    const v = c.createOscillator(); v.frequency.value = 5.2; const vg = c.createGain(); vg.gain.setValueAtTime(0, t); vg.gain.linearRampToValueAtTime(f * 0.012, t + dur * 0.6); v.connect(vg); vg.connect(o.frequency);
    const g = c.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.085, t + 0.35); g.gain.setValueAtTime(0.085, t + dur * 0.7); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.music); const s = c.createGain(); s.gain.value = 0.9; g.connect(s); s.connect(this.verb);
    this._noise(dur, 'bandpass', f * 2, f * 2, 2, 0.012, g, when, 0.3);
    o.start(t); v.start(t); o.stop(t + dur + 0.1); v.stop(t + dur + 0.1);
  }

  // Called every frame: follow the listener, and keep the slow layers going.
  update(dt, game) {
    const c = this.ctx; if (!c || c.state !== 'running') return;
    this.t += dt;
    const cam = game.camera, L = c.listener, f = game.player.forward;
    if (L.positionX) { L.positionX.value = cam.position.x; L.positionY.value = cam.position.y; L.positionZ.value = cam.position.z; L.forwardX.value = f.x; L.forwardY.value = f.y; L.forwardZ.value = f.z; L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0; }
    else { L.setPosition(cam.position.x, cam.position.y, cam.position.z); L.setOrientation(f.x, f.y, f.z, 0, 1, 0); }
    const night = game.sky.night, open = game.openSky ?? 1, now = c.currentTime;
    this.windG.gain.setTargetAtTime((0.06 + 0.07 * Math.sin(this.t * 0.23) ** 2) * (0.5 + 0.5 * open), now, 0.5);
    this.windF.frequency.setTargetAtTime(380 + 180 * Math.sin(this.t * 0.11), now, 1);
    this.leafG.gain.setTargetAtTime(0.012 + 0.02 * Math.sin(this.t * 0.31 + 1) ** 2, now, 0.5);
    this.cricketG.gain.setTargetAtTime(0.035 * night * open, now, 1.5);
    const playing = game.state === 'playing';
    // birds thin out as the light goes
    if (this.t > (this.next.bird || 0)) { this.next.bird = this.t + this.rng.range(2.5, 9) / Math.max(0.08, 1 - night * 1.2); if (night < 0.8 && open > 0.5) this._bird(this.rng.range(-0.9, 0.9)); }
    // tension follows how many are awake and how near
    let want = 0;
    if (playing && game.mission) want = clamp((game.mission.awake || 0) / 14, 0, 1);
    this.tension += (want - this.tension) * Math.min(1, dt * 0.6);
    // drone: Pa, Sa, Sa, low Sa, round and round
    if (this.t > (this.next.pluck || 0)) {
      const step = (this.next.step = ((this.next.step ?? -1) + 1) % 4);
      this._pluck([7, 12, 12, 0][step], 0, 0.085 + 0.03 * this.tension);
      this.next.pluck = this.t + lerp(1.45, 1.05, this.tension);
    }
    // a line of flute when things are quiet
    if (this.t > (this.next.flute || 20) && this.tension < 0.3) {
      let i = this.next.note ?? 4; const n = this.rng.int(2, 4);
      let when = 0;
      for (let k = 0; k < n; k++) { i = clamp(i + this.rng.pick([-2, -1, -1, 1, 1, 2]), 0, BHAIRAV.length - 1); const d = this.rng.range(1.6, 3.2); this._flute(BHAIRAV[i], when, d); when += d * 0.82; }
      this.next.note = i; this.next.flute = this.t + when + this.rng.range(9, 22);
    }
    // the pulse: a heartbeat of a drum that tightens
    if (this.tension > 0.12 && this.t > (this.next.beat || 0)) {
      const g = 0.5 * this.tension;
      this._tone(0.22, 'sine', 82, 38, g, this.music); this._tone(0.16, 'sine', 70, 36, g * 0.6, this.music, 0.17);
      if (this.tension > 0.55) this._noise(0.05, 'bandpass', 220, 150, 2, g * 0.5, this.music, lerp(0.75, 0.42, this.tension) * 0.5);
      this.next.beat = this.t + lerp(0.95, 0.46, this.tension);
    }
  }
}
