// City Beautiful: boot, loading, and the frame loop.
import { THREE } from './lib/three.js';
import { Gfx, QUALITY } from './gfx.js';
import { Baker, bakeNoise, bakeConcrete, bakePaving, bakeSoil, bakeRust, bakeCrackField, bakeBark, bakeWaterNormal } from './textures.js';
import { buildFoliageAtlas } from './foliage.js';
import { Sky } from './sky.js';
import { GU } from './shared.js';
import { jdFromLocal, localHours } from './astro.js';
import { DEG, makeSlicer, nextFrame, store, clamp, damp, makeRng } from './util.js';
import { surface, glazing, distant, water } from './materials.js';
import { World, buildBackdrop, START } from './world.js';
import { Vegetation } from './vegetation.js';
import { Nav } from './nav.js';
import { Input } from './input.js';
import { Player } from './player.js';

const params = new URLSearchParams(location.search);
const DEV = params.has('dev');
const DEFAULTS = { quality: 'auto', sens: 1, fov: 72, volume: 0.8, music: 0.6, invertY: false };

class Game {
  constructor() {
    this.state = 'loading';
    this.settings = { ...DEFAULTS, ...store.get('city-beautiful-settings', {}) };
    this.canvas = document.getElementById('view');
    this.time = 0;                       // seconds of play
    this.frameMs = 16; this.frames = 0;
    this.rng = makeRng(Date.now() & 0xffff);
    this.jd = jdFromLocal(2087, 9, 23, 17.42);        // the autumn equinox, an hour before sunset
    this.clockRate = 0;                  // game hours per real second
    this.hooks = { update: [], render: [] };
  }

  pickQuality() {
    const q = params.get('q') || this.settings.quality;
    if (QUALITY[q]) return q;
    const small = Math.min(screen.width, screen.height) < 700 || matchMedia('(pointer: coarse)').matches;
    return small ? 'low' : 'high';
  }

  async load(progress) {
    const slicer = makeSlicer(30);
    progress(0.01, 'Mixing concrete');
    await nextFrame();
    const gfx = this.gfx = new Gfx(this.canvas, this.pickQuality());
    if (gfx.software && !params.get('q')) gfx.setQuality('low');
    const baker = new Baker(gfx.renderer);
    const noise = this.noise = bakeNoise(baker);
    GU.tNoise.value = noise;
    const tex = this.tex = { concrete: bakeConcrete(baker), paving: bakePaving(baker), soil: bakeSoil(baker), rust: bakeRust(baker), bark: bakeBark(baker) };
    await nextFrame();
    progress(0.06, 'Painting leaves');
    const atlas = this.atlas = buildFoliageAtlas(Math.min(8, gfx.renderer.capabilities.getMaxAnisotropy()));
    await nextFrame();
    const scene = this.scene = new THREE.Scene();
    const camera = this.camera = new THREE.PerspectiveCamera(this.settings.fov, gfx.width / gfx.height, 0.25, 5000);
    camera.rotation.order = 'YXZ';
    this.sky = new Sky(gfx.renderer, scene, noise, { faintStars: gfx.qualityName === 'low' ? 3000 : 6500 });
    this.mats = {
      concrete: surface('wall', tex.concrete, { noise, tile: 3.2 }),
      concreteDS: surface('wall', tex.concrete, { noise, tile: 3.2, side: THREE.DoubleSide }),
      ground: surface('ground', tex.paving, { noise, tile: 4, soil: tex.soil, cracks: bakeCrackField(baker) }),
      metal: surface('metal', tex.rust, { noise, tile: 1.5 }),
      glass: glazing(noise),
    };
    const world = this.world = new World();
    await world.build(this.mats, slicer, (f, label) => progress(0.08 + f * 0.6, label));
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
    this.player = new Player(world, camera);
    this.player.spawn(START.x, START.z, START.yaw);
    this.player.fov = this.settings.fov; this.player.sens = this.settings.sens; this.player.invertY = this.settings.invertY;
    for (const fn of this.hooks.load || []) await fn(this, progress);
    progress(0.95, 'Waiting for the light');
    await nextFrame();
    this.sky.setTime(this.jd);
    this.update(0.016); this.render();
    addEventListener('resize', () => this.resize());
    this.resize();
    progress(1, 'Ready');
  }

  resize() {
    if (this.gfx.resize()) { this.camera.aspect = this.gfx.width / this.gfx.height; this.camera.updateProjectionMatrix(); }
  }

  get hours() { return localHours(this.jd); }
  setHours(h) { this.jd = jdFromLocal(2087, 9, 23, h); }

  update(dt) {
    this.time += dt;
    GU.uTime.value += dt;
    const playing = this.state === 'playing';
    this.jd += (this.clockRate * dt) / 24;
    if (playing || this.state === 'dead' || this.state === 'won') this.player.update(dt, this.input, playing);
    for (const fn of this.hooks.update) fn(dt, this);
    const cam = this.camera;
    GU.uCamPos.value.copy(this.player.pos);
    this.nav.update(this.player.pos.x, this.player.pos.z);
    this.veg.update(cam.position);
    this.sky.setTime(this.jd);
    this.sky.update(dt, cam, this.gfx.height / 1080);
    this.sky.updateShadow(cam.position, this.gfx.q.shadowRange, this.gfx.q.shadow);
    this.input.endFrame();
  }

  render() {
    const sky = this.sky, post = this.gfx.post;
    post.uExposure.value = damp(post.uExposure.value, sky.exposure * (this.exposureBias || 1), 3, 0.016);
    for (const fn of this.hooks.render) fn(this);
    this.gfx.render(this.scene, this.camera, this.overlayScene || null, this.overlayCamera || null,
      { time: GU.uTime.value, sunDir: sky.lightDir, shaftStrength: sky.shaftStrength, shaftColor: sky.shaftColor });
  }

  loop(now) {
    if (this.stopped) return;
    requestAnimationFrame(t => this.loop(t));
    const dt = clamp((now - (this.last || now)) / 1000, 0, 0.05); this.last = now;
    if (document.hidden) return;
    const t0 = performance.now();
    this.update(dt || 0.016);
    this.render();
    this.frameMs = this.frameMs * 0.95 + (performance.now() - t0) * 0.05;
    if (++this.frames % 90 === 0 && this.state === 'playing' && !DEV) this.gfx.adapt(this.frameDt = this.frameDt || 16);
  }
}

const game = window.__game = new Game();
game.dev = {
  // run the simulation without the browser's clock, for tests
  step(n = 1, dt = 1 / 60, render = false) { for (let i = 0; i < n; i++) game.update(dt); if (render) game.render(); },
  view(o) { const p = game.player; if (o.x !== undefined) p.pos.set(o.x, o.y ?? game.world.groundAt(o.x, o.z, game.world.heightAt(o.x, o.z) + 0.2), o.z); if (o.yaw !== undefined) p.yaw = -o.yaw * DEG; if (o.pitch !== undefined) p.pitch = o.pitch * DEG; if (o.hours !== undefined) game.setHours(o.hours); p.viewY = p.pos.y; game.sky._envTimer = 0; game.update(0.016); game.render(); return { pos: p.pos.toArray().map(v => +v.toFixed(2)), calls: game.gfx.renderer.info.render.calls, tris: game.gfx.renderer.info.render.triangles }; },
};

(async () => {
  try {
    const bar = document.getElementById('load-bar'), label = document.getElementById('load-label');
    await game.load((f, text) => { if (bar) bar.style.transform = `scaleX(${f})`; if (label && text) label.textContent = text; });
    game.state = params.has('play') ? 'playing' : 'title';
    if (game.state === 'playing') game.input.enabled = true;
    window.__ready = true;
    if (!params.has('noloop')) requestAnimationFrame(t => game.loop(t));
  } catch (e) {
    console.error(e);
    window.__bootError = String(e && e.stack || e);
    const label = document.getElementById('load-label'); if (label) label.textContent = 'Could not start: ' + (e && e.message || e);
  }
})();
