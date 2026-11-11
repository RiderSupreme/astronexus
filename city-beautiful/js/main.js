// City Beautiful: boot, loading, game flow and the frame loop.
import { THREE } from './lib/three.js';
import { Gfx, QUALITY } from './gfx.js';
import { Baker, bakeNoise, bakeConcrete, bakePaving, bakeSoil, bakeRust, bakeCrackField, bakeBark, bakeWaterNormal } from './textures.js';
import { buildFoliageAtlas } from './foliage.js';
import { Sky } from './sky.js';
import { GU } from './shared.js';
import { jdFromLocal, localHours } from './astro.js';
import { DEG, makeSlicer, nextFrame, store, clamp, damp, makeRng, mod } from './util.js';
import { surface, glazing, distant, water, matte } from './materials.js';
import { World, buildBackdrop, START } from './world.js';
import { SURF } from './physics.js';
import { Vegetation } from './vegetation.js';
import { Nav } from './nav.js';
import { Input } from './input.js';
import { Player } from './player.js';
import { Horde } from './zombies.js';
import { Fx } from './fx.js';
import { Weapons } from './weapons.js';
import { Mission } from './mission.js';
import { Hud } from './hud.js';
import { GameAudio } from './audio.js';
import { buildSigns } from './props.js';

const params = new URLSearchParams(location.search);
const DEV = params.has('dev');
const DEFAULTS = { quality: 'auto', sens: 1, fov: 72, volume: 0.8, music: 0.6, invertY: false };
const hhmm = h => { h = mod(h, 24); return String(Math.floor(h)).padStart(2, '0') + ':' + String(Math.floor((h % 1) * 60 + 1e-6)).padStart(2, '0'); };

class Game {
  constructor() {
    this.state = 'loading';
    this.settings = { ...DEFAULTS, ...store.get('city-beautiful-settings', {}) };
    this.canvas = document.getElementById('view');
    this.time = 0; this.frames = 0; this.avgDt = 16; this.endT = 0;
    this.jd = jdFromLocal(2087, 9, 23, 17 + 25 / 60);       // the autumn equinox, an hour before sunset
    this.clockRate = 0;                                    // game hours per real second
    this.audio = new GameAudio();
    // someone for the infected to ignore while the title is up
    this.nobody = { pos: new THREE.Vector3(0, 0, 1e5), alive: false, noise: 0, crouching: false };
  }

  pickQuality() {
    const q = params.get('q') || this.settings.quality;
    if (QUALITY[q]) return q;
    const small = Math.min(screen.width, screen.height) < 700 || matchMedia('(pointer: coarse)').matches;
    return small ? 'low' : 'high';
  }
  applyQuality() { this.gfx.setQuality(this.pickQuality()); this.resize(); }

  async load(progress) {
    const slicer = makeSlicer(30);
    progress(0.01, 'Mixing concrete');
    await nextFrame();
    const gfx = this.gfx = new Gfx(this.canvas, this.pickQuality());
    if (gfx.software && !params.get('q')) gfx.setQuality('low');
    const baker = new Baker(gfx.renderer);
    const noise = this.noise = bakeNoise(baker);
    GU.tNoise.value = noise;
    const tex = { concrete: bakeConcrete(baker), paving: bakePaving(baker), soil: bakeSoil(baker), rust: bakeRust(baker), bark: bakeBark(baker) };
    await nextFrame();
    progress(0.06, 'Painting leaves');
    const atlas = buildFoliageAtlas(Math.min(8, gfx.renderer.capabilities.getMaxAnisotropy()));
    await nextFrame();
    const scene = this.scene = new THREE.Scene();
    const camera = this.camera = new THREE.PerspectiveCamera(this.settings.fov, gfx.width / gfx.height, 0.25, 5000);
    camera.rotation.order = 'YXZ';
    this.sky = new Sky(gfx.renderer, scene, noise, { faintStars: gfx.qualityName === 'low' ? 3000 : 6500 });
    const mats = {
      concrete: surface('wall', tex.concrete, { noise, tile: 3.2 }),
      concreteDS: surface('wall', tex.concrete, { noise, tile: 3.2, side: THREE.DoubleSide }),
      ground: surface('ground', tex.paving, { noise, tile: 4, soil: tex.soil, cracks: bakeCrackField(baker) }),
      metal: surface('metal', tex.rust, { noise, tile: 1.5 }),
      glass: glazing(noise),
      flat: matte(noise),
    };
    const world = this.world = new World();
    await world.build(mats, slicer, (f, label) => progress(0.08 + f * 0.6, label));
    for (const m of world.meshes) scene.add(m);
    buildBackdrop(scene, distant);
    const wmat = water(noise, bakeWaterNormal(baker));
    for (const p of world.pools) {
      const g = new THREE.PlaneGeometry(p.x1 - p.x0, p.z1 - p.z0); g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, wmat); m.position.set((p.x0 + p.x1) / 2, p.level, (p.z0 + p.z1) / 2); m.receiveShadow = true; scene.add(m);
    }
    progress(0.7, 'Sixty monsoons of growth');
    await nextFrame();
    this.veg = new Vegetation({ scene, world, atlas, noise, bark: tex.bark, quality: gfx.q, msaa: Math.min(gfx.q.msaa, gfx.maxSamples) }).build();
    progress(0.82, 'Walking the ground');
    await nextFrame();
    this.nav = new Nav(world).build(START.x, START.z);
    this.input = new Input(this.canvas, document.getElementById('touch'));
    this.input.onLockChange = locked => { if (!locked && this.state === 'playing' && !this.input.touch) this.pause(); };
    this.player = new Player(world, camera);
    this.player.spawn(START.x, START.z, START.yaw);
    this.player.fov = this.settings.fov; this.player.sens = this.settings.sens; this.player.invertY = this.settings.invertY;
    progress(0.88, 'Counting the sleepers');
    await nextFrame();
    this.fx = new Fx(this);
    this.horde = new Horde(this, gfx.qualityName === 'low' ? 40 : 56);
    this.weapons = new Weapons(this);
    this.hud = new Hud(this);
    this.mission = new Mission(this);
    progress(0.93, 'Painting the signs');
    await buildSigns(this);
    progress(0.96, 'Waiting for the light');
    await nextFrame();
    this.sky.setTime(this.jd);
    this.update(0.016); this.render();
    addEventListener('resize', () => this.resize());
    // P works as a toggle; Esc can only pause, because a browser will not hand the mouse back on Esc
    addEventListener('keydown', e => { if (e.code === 'KeyP' && !e.repeat && this.state === 'paused') this.resume(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.state === 'playing') this.pause(); });
    this.resize();
    progress(1, 'Ready');
  }

  resize() {
    if (this.gfx.resize()) { this.camera.aspect = this.gfx.width / this.gfx.height; this.camera.updateProjectionMatrix(); }
  }

  // ---- flow ----
  begin() {
    this.audio.start(); this.audio.setVolume(this.settings.volume, this.settings.music); this.audio.suspend(false);
    this.weapons.reset(); this.mission.reset();
    this.player.spawn(START.x, START.z, START.yaw);
    this.state = 'playing'; this.input.enabled = true; this.input.endFrame(); this.time = 0; this.endT = 0;
    this.hud.show(null); this.hud.subs.length = 0; this.hud.subT = 0; document.getElementById('subtitle').hidden = true;
    this.input.lock();
    this.mission.start();
    this.gfx.post.uFade.value = 0; this.fadeIn = 0;
  }
  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused'; this.input.enabled = false; this.hud.show('pause'); this.audio.suspend(true); this.input.unlock();
  }
  resume() {
    if (this.state !== 'paused') return;
    this.state = 'playing'; this.input.enabled = true; this.input.endFrame();      // a key pressed on the menu is not a key pressed in the game
    this.hud.show(null); this.audio.suspend(false); this.input.lock(); this.last = 0;
  }
  toTitle() {
    this.state = 'title'; this.input.enabled = false; this.input.unlock(); this.audio.suspend(false);
    this.weapons.reset(); this.mission.reset(); this.clockRate = 0;
    this.gfx.post.uFade.value = 1; this.gfx.post.uLowHealth.value = 0; this.gfx.post.uDamage.value = 0;
    this.hud.show('title');
  }
  _end(won) {
    const s = this.mission.stats(), best = store.get('city-beautiful-best', null);
    if (!best || (won && !best.won) || (won === !!best.won && s.kills > best.kills)) store.set('city-beautiful-best', { won, kills: s.kills, when: s.clock });
    this.hud.stats(won ? 'won-stats' : 'dead-stats', [[s.kills, 'Put down'], [s.headshots, 'To the head'], [s.accuracy + '%', 'Shots that told'], [s.time, 'Time in the Capitol'], [s.hurt, 'Harm taken']]);
    if (!won) {
      document.getElementById('dead-when').textContent = `23 September 2087 · ${s.clock}`;
      const rise = this.hud.sunrise - (this.hours < 12 ? this.hours + 24 : this.hours);
      document.getElementById('dead-line').textContent = this.mission.phase === 'siege'
        ? `The beacon was burning. Sunrise was ${rise >= 1 ? Math.round(rise) + ' hours' : Math.round(rise * 60) + ' minutes'} away.`
        : `You had ${s.cells} of the three batteries.`;
    }
    this.input.enabled = false; this.input.unlock();
    this.hud.show(won ? 'won' : 'dead');
  }
  die() { if (this.state === 'playing') { this.state = 'dead'; this.endT = 2.6; this.audio.play('nightfall'); } }
  win() { if (this.state === 'playing') { this.state = 'won'; this.endT = 1.5; } }

  get hours() { return localHours(this.jd); }
  setHours(h) { this.jd = jdFromLocal(2087, 9, 23, h); }

  update(dt) {
    this.time += dt;
    GU.uTime.value += dt;
    const playing = this.state === 'playing', live = playing || this.state === 'dead' || this.state === 'won';
    const p = this.player, cam = this.camera;
    if (this.state !== 'paused') this.jd += (this.clockRate * dt) / 24;
    const sunUp = this.sky.astro.sunAlt > -0.02;
    if (live) {
      if (playing && this.input.pressed.pause) this.pause();
      p.update(dt, this.input, playing);
      this.weapons.update(dt, p, this.input, playing);
      this.horde.update(dt, p, sunUp);
      if (playing) this.mission.update(dt);
      for (const e of p.events) {
        if (e === 'step') this.audio.play(p.surface === SURF.water ? 'step_w' : p.surface === SURF.dirt ? 'step_g' : 'step_c');
        else if (e === 'land') this.audio.play('land'); else if (e === 'hurt') this.audio.play('hurt'); else if (e === 'die') this.die();
      }
      p.events.length = 0;
      this.hud.update(dt);
      if (this.endT > 0) { this.endT -= dt; if (this.endT <= 0) this._end(this.state === 'won'); }
      GU.uCamPos.value.copy(p.pos);
    } else if (this.state === 'title') {
      // a slow drift along the south edge of the esplanade
      const a = Math.sin(this.time * 0.03);
      cam.position.set(a * 20, 5.2 + Math.sin(this.time * 0.045) * 1.2, 66);
      cam.lookAt(a * -8, 9.5, -40);
      if (cam.fov !== 62) { cam.fov = 62; cam.updateProjectionMatrix(); }
      cam.updateMatrixWorld();
      this.horde.update(dt, this.nobody, sunUp);
      GU.uCamPos.value.set(0, -50, 0);
    }
    if (this.fadeIn !== undefined && this.fadeIn < 1) { this.fadeIn = Math.min(1, this.fadeIn + dt * 0.5); this.gfx.post.uFade.value = this.fadeIn; }
    this.fx.update(dt, cam, this.sky);
    this.nav.update(p.pos.x, p.pos.z);
    this.veg.update(cam.position);
    this.sky.setTime(this.jd);
    this.sky.update(dt, cam, this.gfx.height / 1080);
    this.sky.updateShadow(cam.position, this.gfx.q.shadowRange, this.gfx.q.shadow);
    this.audio.update(dt, this);
    this.input.endFrame();
  }

  render() {
    const sky = this.sky, post = this.gfx.post;
    // eyes open up under a roof and close down again in the open
    const indoor = 1 + 0.9 * (1 - (this.openSky ?? 1)) * (1 - sky.night * 0.5);
    post.uExposure.value = damp(post.uExposure.value, sky.exposure * indoor, 2.5, 0.016);
    const overlay = this.state === 'title' || this.state === 'loading' ? null : this.overlayScene;
    this.gfx.render(this.scene, this.camera, overlay, this.overlayCamera,
      { time: GU.uTime.value, sunDir: sky.lightDir, shaftStrength: sky.shaftStrength, shaftColor: sky.shaftColor });
  }

  loop(now) {
    if (this.stopped) return;
    requestAnimationFrame(t => this.loop(t));
    const raw = this.last ? now - this.last : 16; this.last = now;
    if (document.hidden || this.state === 'paused') return;
    const dt = clamp(raw / 1000, 0.001, 0.05);
    this.update(dt);
    this.render();
    this.frames++;
    this.avgDt = this.avgDt * 0.96 + Math.min(raw, 100) * 0.04;
    if (this.frames % 120 === 0 && this.state === 'playing' && !DEV) this.gfx.adapt(this.avgDt);
  }
}

const game = window.__game = new Game();
game.dev = {
  // run the simulation without the browser's clock, for tests
  step(n = 1, dt = 1 / 60, render = false) { for (let i = 0; i < n; i++) game.update(dt); if (render) game.render(); },
  view(o) {
    const p = game.player;
    if (o.x !== undefined) p.pos.set(o.x, o.y ?? game.world.groundAt(o.x, o.z, game.world.heightAt(o.x, o.z) + 0.2), o.z);
    if (o.yaw !== undefined) p.yaw = -o.yaw * DEG; if (o.pitch !== undefined) p.pitch = o.pitch * DEG; if (o.hours !== undefined) game.setHours(o.hours);
    p.viewY = p.pos.y; game.sky._envTimer = 0; game.update(0.016); game.render();
    return { pos: p.pos.toArray().map(v => +v.toFixed(2)), calls: game.gfx.renderer.info.render.calls, tris: game.gfx.renderer.info.render.triangles };
  },
};

(async () => {
  try {
    const bar = document.getElementById('load-bar'), label = document.getElementById('load-label');
    await game.load((f, text) => { if (bar) bar.style.transform = `scaleX(${f})`; if (label && text) label.textContent = text; });
    game.toTitle();
    if (params.has('play')) { game.begin(); }
    window.__ready = true;
    if (!params.has('noloop')) requestAnimationFrame(t => game.loop(t));
  } catch (e) {
    console.error(e);
    window.__bootError = String(e && e.stack || e);
    const label = document.getElementById('load-label'); if (label) label.textContent = 'Could not start: ' + (e && e.message || e);
  }
})();
