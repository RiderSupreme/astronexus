// TEMPORARY look-dev entry: world viewer. Replaced by the real game boot later.
import { THREE } from './lib/three.js';
import { Gfx } from './gfx.js';
import { Baker, bakeNoise, bakeConcrete, bakePaving, bakeSoil, bakeRust, bakeCrackField, bakeBark } from './textures.js';
import { buildFoliageAtlas } from './foliage.js';
import { Vegetation } from './vegetation.js';
import { Sky } from './sky.js';
import { GU } from './shared.js';
import { jdFromLocal } from './astro.js';
import { DEG, makeSlicer } from './util.js';
import { surface, glazing, distant } from './materials.js';
import { World, buildBackdrop } from './world.js';

try {
  const params = new URLSearchParams(location.search);
  const canvas = document.getElementById('view');
  const gfx = new Gfx(canvas, params.get('q') || 'high');
  const baker = new Baker(gfx.renderer);
  const T0 = performance.now();
  const noise = bakeNoise(baker);
  GU.tNoise.value = noise;
  const tex = { concrete: bakeConcrete(baker), paving: bakePaving(baker), soil: bakeSoil(baker), rust: bakeRust(baker), bark: bakeBark(baker) };
  const atlas = buildFoliageAtlas(Math.min(8, gfx.renderer.capabilities.getMaxAnisotropy()));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, gfx.width / gfx.height, 0.3, 5000);
  camera.rotation.order = 'YXZ';
  const sky = new Sky(gfx.renderer, scene, noise);
  const mats = {
    concrete: surface('wall', tex.concrete, { noise, tile: 3.2 }),
    concreteDS: surface('wall', tex.concrete, { noise, tile: 3.2, side: THREE.DoubleSide }),
    ground: surface('ground', tex.paving, { noise, tile: 4, soil: tex.soil, cracks: bakeCrackField(baker) }),
    metal: surface('metal', tex.rust, { noise, tile: 1.5 }),
    glass: glazing(noise),
  };
  const world = new World();
  const state = { hours: 17.5, y: 2087, m: 9, d: 23, yaw: 0, pitch: 0, x: 0, yy: 1.7, z: 120, fov: 70 };
  function frame(dt = 0.016) {
    GU.uTime.value += dt;
    sky.setTime(jdFromLocal(state.y, state.m, state.d, state.hours));
    camera.position.set(state.x, state.yy, state.z);
    camera.rotation.set(state.pitch * DEG, -state.yaw * DEG, 0);
    camera.fov = state.fov; camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    GU.uCamPos.value.copy(camera.position); GU.uCamPos.value.y -= 1.6;
    if (window.__veg) window.__veg.update(camera.position);
    sky._envTimer = 0;
    sky.update(dt, camera, 1);
    sky.updateShadow(camera.position, gfx.q.shadowRange, gfx.q.shadow);
    gfx.post.uExposure.value = sky.exposure;
    gfx.render(scene, camera, null, null, { time: GU.uTime.value, sunDir: sky.lightDir, shaftStrength: sky.shaftStrength, shaftColor: sky.shaftColor });
  }
  window.__dbg = {
    set(o) { Object.assign(state, o); if (o.ground) state.yy = world.heightAt(state.x, state.z) + 1.7; frame(); frame(); return { sunAlt: +(sky.astro.sunAlt / DEG).toFixed(2), exposure: +sky.exposure.toFixed(3), calls: gfx.renderer.info.render.calls, tris: gfx.renderer.info.render.triangles }; },
    sky, gfx, camera, scene, state, frame, world,
  };
  (async () => {
    const t1 = performance.now();
    const marks = [];
    await world.build(mats, makeSlicer(40), (f, label) => { if (!marks.length || marks[marks.length - 1][1] !== label) marks.push([Math.round(performance.now() - t1), label]); });
    for (const m of world.meshes) scene.add(m);
    buildBackdrop(scene, distant);
    const tv = performance.now();
    const veg = window.__veg = new Vegetation({ scene, world, atlas, noise, bark: tex.bark, quality: gfx.q, msaa: Math.min(gfx.q.msaa, gfx.maxSamples) }).build();
    const tVeg = Math.round(performance.now() - tv);
    window.__info = { tTex: Math.round(t1 - T0), tWorld: Math.round(performance.now() - t1), marks, verts: world.b.vertexCount, tris: world.b.triangleCount, solids: world.solids.n, meshes: world.meshes.length, tVeg, veg: veg.stats };
    frame(); frame();
    window.__ready = true;
  })().catch(e => { window.__bootError = String(e.stack || e); console.error(e); });
} catch (e) { window.__bootError = String(e.stack || e); console.error(e); }
