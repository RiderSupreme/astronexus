// Head-up display and menus. All of it is ordinary DOM laid over the canvas.
import { Astro, jdFromLocal, localHours, localCalendar } from './astro.js';
import { ARMS, SLOTS } from './weapons.js';
import { DEG, clamp, mod, store } from './util.js';

const $ = id => document.getElementById(id);
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const hhmm = h => { h = mod(h, 24); const m = Math.floor((h % 1) * 60 + 1e-6); return String(Math.floor(h)).padStart(2, '0') + ':' + String(m).padStart(2, '0'); };

export class Hud {
  constructor(game) {
    this.game = game;
    this.screens = { loading: $('loading'), title: $('title'), pause: $('pause'), dead: $('dead'), won: $('won') };
    this.root = $('hud'); this.touch = $('touch');
    this.compass = $('compass').getContext('2d'); this.dial = $('sun-dial').getContext('2d');
    this.cache = {};
    this.markers = [];                 // { x, z, label, color }
    this.subs = []; this.subT = 0; this.bannerT = 0; this.hitT = 0; this.feedItems = [];
    this.promptText = null;
    // the Sun's altitude through the mission's night, noon to noon, for the dial
    const a = new Astro(), jd0 = jdFromLocal(2087, 9, 23, 12);
    this.curve = []; this.sunset = 18.28; this.sunrise = 30.22;
    let prev = 1;
    // sunrise and sunset are when the upper limb touches the horizon (refraction is already in the altitude)
    const LIMB = -0.27, cross = (i, alt) => 12 + (i - 1 + (LIMB - prev) / (alt - prev)) / 4;
    for (let i = 0; i <= 96; i++) { a.update(jd0 + i / 96); const alt = a.sunAlt / DEG; this.curve.push(alt); if (i && prev > LIMB && alt <= LIMB) this.sunset = cross(i, alt); if (i && prev < LIMB && alt >= LIMB) this.sunrise = cross(i, alt); prev = alt; }
    this._wire();
  }

  _wire() {
    const g = this.game, S = g.settings;
    const set = (id, key, parse, apply) => {
      const el = $(id); if (!el) return;
      if (el.type === 'checkbox') el.checked = !!S[key]; else el.value = S[key];
      el.addEventListener('input', () => { S[key] = el.type === 'checkbox' ? el.checked : parse(el.value); store.set('city-beautiful-settings', S); apply && apply(S[key]); });
    };
    set('set-quality', 'quality', String, v => g.applyQuality());
    set('set-sens', 'sens', parseFloat, v => { g.player.sens = v; });
    set('set-fov', 'fov', parseFloat, v => { g.player.fov = v; });
    set('set-vol', 'volume', parseFloat, v => g.audio?.setVolume(v, S.music));
    set('set-music', 'music', parseFloat, v => g.audio?.setVolume(S.volume, v));
    set('set-invert', 'invertY', Boolean, v => { g.player.invertY = v; });
    const toggle = (btn, panel) => $(btn).addEventListener('click', () => { const p = $(panel), open = p.hidden; $('howto').hidden = true; $('settings').hidden = true; p.hidden = !open; $('btn-howto').setAttribute('aria-expanded', String(!$('howto').hidden)); $('btn-settings').setAttribute('aria-expanded', String(!$('settings').hidden)); });
    toggle('btn-howto', 'howto'); toggle('btn-settings', 'settings');
    $('btn-start').addEventListener('click', () => g.begin());
    $('btn-resume').addEventListener('click', () => g.resume());
    $('btn-restart').addEventListener('click', () => g.begin());
    $('btn-retry').addEventListener('click', () => g.begin());
    $('btn-again').addEventListener('click', () => g.begin());
    for (const id of ['btn-quit', 'btn-dead-quit', 'btn-won-quit']) $(id).addEventListener('click', () => g.toTitle());
  }

  show(name) {
    for (const [k, el] of Object.entries(this.screens)) el.hidden = k !== name;
    const playing = name === null;
    this.root.hidden = !(playing || name === 'pause');
    this.touch.hidden = !(playing && this.game.input.touch);
    // the settings sheet lives wherever it is needed
    const sheet = $('settings');
    if (name === 'pause') { $('pause-settings').replaceWith(sheet); sheet.hidden = false; sheet.dataset.at = 'pause'; }
    else if (sheet.dataset.at === 'pause') { const ph = document.createElement('div'); ph.id = 'pause-settings'; ph.className = 'sheet opts'; sheet.replaceWith(ph); $('title').querySelector('.fine').before(sheet); sheet.hidden = true; sheet.dataset.at = ''; }
    if (name === 'title') {
      const best = store.get('city-beautiful-best', null);
      $('title-best').textContent = best ? (best.won ? `Your best night: sunrise reached, ${best.kills} put down.` : `Your best night: ${best.kills} put down, lost at ${best.when}.`) : '';
    }
  }
  fade(on) { $('fade').style.opacity = on ? 1 : 0; }

  stats(elId, rows) { $(elId).innerHTML = rows.map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join(''); }

  banner(title, sub = '', seconds = 4) { const b = $('banner'); b.children[0].textContent = title; b.children[1].textContent = sub; b.classList.add('on'); this.bannerT = seconds; }
  say(speaker, text, seconds = 6.5) { this.subs.push({ speaker, text, seconds }); }
  feed(text) { this.feedItems.push({ text, t: 3.2 }); this._feed(); }
  _feed() { $('pickups').innerHTML = this.feedItems.slice(-4).map(f => `<span>${f.text}</span>`).join(''); }
  hitmark(kind) { const h = $('hitmark'); h.style.color = kind === 'hit' ? 'var(--beton)' : kind === 'head' ? 'var(--pier-yellow)' : 'var(--pier-red)'; h.style.opacity = 1; h.style.transform = `scale(${kind === 'hit' ? 1 : 1.5})`; this.hitT = kind === 'hit' ? 0.12 : 0.3; }
  prompt(text, hold = -1) {
    if (text !== this.promptText) {
      this.promptText = text; const p = $('prompt');
      p.hidden = !text; if (text) p.innerHTML = (this.game.input.touch ? '' : '<kbd>E</kbd>') + text;
      const u = this.touch.querySelector('.use'); if (u) u.hidden = !text;
    }
    const h = $('hold'); h.hidden = hold < 0; if (hold >= 0) h.firstElementChild.style.transform = `scaleX(${clamp(hold, 0, 1)})`;
  }
  _set(id, value, prop = 'textContent') { if (this.cache[id] !== value) { this.cache[id] = value; $(id)[prop] = value; } }

  update(dt) {
    const g = this.game, p = g.player, W = g.weapons, M = g.mission;
    // subtitles, banner, hit marker, feed
    if (this.subT > 0) { this.subT -= dt; if (this.subT <= 0) $('subtitle').hidden = true; }
    if (this.subT <= 0 && this.subs.length) { const s = this.subs.shift(); const el = $('subtitle'); el.innerHTML = `<b>${s.speaker}</b>${s.text}`; el.hidden = false; this.subT = s.seconds; g.audio?.play('radio'); }
    if (this.bannerT > 0) { this.bannerT -= dt; if (this.bannerT <= 0) $('banner').classList.remove('on'); }
    if (this.hitT > 0) { this.hitT -= dt; if (this.hitT <= 0) $('hitmark').style.opacity = 0; }
    if (this.feedItems.length) { let ch = false; for (const f of this.feedItems) f.t -= dt; while (this.feedItems.length && this.feedItems[0].t <= 0) { this.feedItems.shift(); ch = true; } if (ch) this._feed(); }
    for (const e of W.events) { if (e !== 'empty') this.hitmark(e); }
    W.events.length = 0;

    // vitals
    const hp = Math.ceil(p.health);
    this._set('health-num', String(hp));
    $('health-fill').style.transform = `scaleX(${clamp(p.health / p.maxHealth, 0, 1)})`;
    $('stamina-fill').style.transform = `scaleX(${p.stamina})`;
    $('health').classList.toggle('low', hp <= 30);
    // weapon
    const D = W.def, a = W.clip;
    this._set('weapon-name', D.name); this._set('ammo-mag', String(a.mag)); this._set('ammo-res', '/ ' + a.reserve);
    $('ammo-mag').classList.toggle('dry', a.mag <= Math.ceil(D.mag * 0.2));
    const key = SLOTS.map(k => (W.owned[k] ? 1 : 0) + (W.current === k ? 2 : 0)).join('') + W.grenadeCount;
    if (this.cache.slots !== key) { this.cache.slots = key; for (const el of $('slots').children) { const k = el.dataset.slot; if (k) { el.classList.toggle('own', !!W.owned[k]); el.classList.toggle('on', W.current === k); } } $('nades').textContent = 'G ' + W.grenadeCount; }
    this._set('kills', String(g.horde.killed));
    // crosshair opens with the cone of fire
    const px = Math.tan(W.spreadNow * DEG) * (innerHeight / 2) / Math.tan(g.camera.fov * DEG / 2) + 5;
    const C = $('cross').children, vis = p.alive ? clamp(1 - W.ads * 1.4, 0, 1) : 0;
    C[0].style.top = (-px - 9) + 'px'; C[1].style.top = px + 'px'; C[2].style.left = (-px - 9) + 'px'; C[3].style.left = px + 'px';
    $('cross').style.opacity = vis;
    // where the last blow came from
    const hurt = $('hurt');
    if (p.hurtFlash > 0.01) { const brg = Math.atan2(p.hurtDir.x, -p.hurtDir.z), head = -p.yaw; hurt.style.opacity = clamp(p.hurtFlash * 1.2, 0, 0.9); hurt.style.transform = `rotate(${brg - head}rad)`; } else if (hurt.style.opacity !== '0') hurt.style.opacity = 0;
    g.gfx.post.uDamage.value = clamp(p.hurtFlash * 0.8, 0, 1);
    g.gfx.post.uLowHealth.value = p.alive ? clamp((35 - p.health) / 35, 0, 1) : 1;

    // clock
    const h = localHours(g.jd), cal = localCalendar(g.jd);
    this._set('clock-time', hhmm(h));
    this._set('clock-date', `${cal.day} ${MONTHS[cal.month - 1]} ${cal.year}`);
    if (M) { this._set('clock-note', M.clockNote()); this._set('objective', M.objectiveHTML(), 'innerHTML'); const c = $('cells').children; for (let i = 0; i < 3; i++) c[i].classList.toggle('on', i < M.cells); }
    if ((g.frames & 3) === 0) { this._dial(h); }
    this._compass(p);
  }

  // Le Corbusier drew the sun's day as a wave crossing a horizon line; this is that drawing, with a dot for now.
  _dial(h) {
    const c = this.dial, W = 304, H = 92, mid = H * 0.5;
    c.clearRect(0, 0, W, H);
    const hh = h < 12 ? h + 24 : h, x = (hh - 12) / 24 * W;
    const Y = alt => mid - alt / 62 * (H * 0.46);
    c.fillStyle = 'rgba(18,19,14,0.55)'; c.fillRect(0, mid, W, H - mid);
    c.strokeStyle = 'rgba(220,214,200,0.4)'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(0, mid); c.lineTo(W, mid); c.stroke();
    c.strokeStyle = '#dcd6c8'; c.lineWidth = 2.5; c.beginPath();
    this.curve.forEach((alt, i) => { const px = i / 96 * W; if (i) c.lineTo(px, Y(alt)); else c.moveTo(px, Y(alt)); });
    c.stroke();
    const i = clamp((hh - 12) * 4, 0, 95.999), a = this.curve[Math.floor(i)] + (this.curve[Math.floor(i) + 1] - this.curve[Math.floor(i)]) * (i % 1);
    c.fillStyle = a > -0.8 ? '#e8b93b' : '#8ab6d1'; c.beginPath(); c.arc(x, Y(a), 7, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#12130e'; c.lineWidth = 2; c.stroke();
  }

  _compass(p) {
    const c = this.compass, W = 1040, H = 74, span = 110;              // degrees shown
    const head = mod(-p.yaw / DEG, 360);
    c.clearRect(0, 0, W, H);
    c.textAlign = 'center'; c.textBaseline = 'top';
    const X = brg => { let d = mod(brg - head + 180, 360) - 180; return Math.abs(d) > span / 2 ? null : W / 2 + d / span * W; };
    c.fillStyle = '#dcd6c8'; c.strokeStyle = '#dcd6c8';
    for (let b = 0; b < 360; b += 5) {
      const x = X(b); if (x === null) continue;
      const big = b % 45 === 0, mid = b % 15 === 0;
      c.globalAlpha = big ? 1 : mid ? 0.75 : 0.4; c.fillRect(x - 1, 0, 2, big ? 16 : mid ? 11 : 6);
      if (big) { c.font = '600 26px "Barlow Condensed", "Arial Narrow", sans-serif'; c.fillText(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][b / 45], x, 22); }
    }
    c.globalAlpha = 1;
    // where the sun is: what the sleepers are facing
    const sun = this.game.sky.astro;
    if (sun.sunAlt > -0.02) { const x = X(sun.sunAz / DEG); if (x !== null) { c.fillStyle = '#e8b93b'; c.beginPath(); c.arc(x, 62, 6, 0, Math.PI * 2); c.fill(); } }
    for (const m of this.markers) {
      const dx = m.x - p.pos.x, dz = m.z - p.pos.z, x = X(Math.atan2(dx, -dz) / DEG);
      const xx = x === null ? ((mod(Math.atan2(dx, -dz) / DEG - head + 180, 360) - 180) < 0 ? 14 : W - 14) : x;
      c.fillStyle = m.color || '#e8b93b';
      c.beginPath(); c.moveTo(xx, 44); c.lineTo(xx + 9, 55); c.lineTo(xx, 66); c.lineTo(xx - 9, 55); c.closePath(); c.fill();
      if (x !== null) { c.font = '500 19px "IBM Plex Mono", monospace'; c.textAlign = xx > W - 120 ? 'right' : xx < 120 ? 'left' : 'center'; c.fillText(`${m.label} ${Math.round(Math.hypot(dx, dz))} m`, xx + (c.textAlign === 'left' ? 14 : c.textAlign === 'right' ? -14 : 0), 47 + (c.textAlign === 'center' ? -100 : 0) * 0); c.textAlign = 'center'; }
    }
    // centre mark
    c.fillStyle = '#dcd6c8'; c.beginPath(); c.moveTo(W / 2 - 7, 0); c.lineTo(W / 2 + 7, 0); c.lineTo(W / 2, 9); c.closePath(); c.fill();
  }
}
