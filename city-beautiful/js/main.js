// TEMPORARY look-dev entry: material + builder test. Replaced by the real game boot later.
import { THREE } from './lib/three.js';
import { Gfx } from './gfx.js';
import { Baker, bakeNoise, bakeConcrete, bakePaving, bakeSoil, bakeRust, bakeCrackField } from './textures.js';
import { Sky } from './sky.js';
import { GU } from './shared.js';
import { jdFromLocal } from './astro.js';
import { DEG, makeSlicer, fbm2 } from './util.js';
import { Solids, SOLID, SURF } from './physics.js';
import { Builder, bakeAO } from './geom.js';
import { surface } from './materials.js';

try {
  const params = new URLSearchParams(location.search);
  const canvas = document.getElementById('view');
  const gfx = new Gfx(canvas, params.get('q') || 'high');
  const baker = new Baker(gfx.renderer);
  const T0 = performance.now();
  const noise = bakeNoise(baker);
  GU.tNoise.value = noise;
  const tex = { concrete: bakeConcrete(baker), paving: bakePaving(baker), soil: bakeSoil(baker), rust: bakeRust(baker) };
  const tTex = performance.now() - T0;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, gfx.width / gfx.height, 0.3, 3000);
  camera.rotation.order = 'YXZ';
  const sky = new Sky(gfx.renderer, scene, noise);

  const mats = {
    concrete: surface('wall', tex.concrete, { noise, tile: 3.2 }),
    ground: surface('ground', tex.paving, { noise, tile: 4, soil: tex.soil, cracks: bakeCrackField(baker) }),
    metal: surface('metal', tex.rust, { noise, tile: 1.5 }),
  };
  const solids = new Solids();
  const b = new Builder(solids);
  // ground
  b.setGroup('ground');
  for (let gz = -100; gz < 100; gz += 20) for (let gx = -100; gx < 100; gx += 20) b.face(gx, 0, gz, 0, 0, 20, 20, 0, 0, { mat: 'ground', seg: 2, solid: 0 });
  { const g = b.batches.get('ground|ground'); const P = g.pos.a, S = g.surf.a;
    for (let i = 0; i < g.pos.n; i++) { const x = P[i * 3], z = P[i * 3 + 2]; S[i * 4 + 2] = Math.max(0, Math.min(1, (fbm2(x * 0.03 + 5, z * 0.03, 4) - 0.42) * 3.2)); } }
  // slab block with brise-soleil
  b.setGroup('block');
  b.box(-15, 0, -40, 15, 12.6, -32);
  for (let f = 0; f <= 4; f++) b.box(-15.3, f * 3 + 0.0, -32, 15.3, f * 3 + 0.3, -30.6, { seg: 1.5 });
  for (let i = 0; i <= 15; i++) b.box(-15 + i * 2 - 0.09, 0, -32, -15 + i * 2 + 0.09, 12.3, -30.75, { seg: 1.2, vboards: true });
  // three painted pylons carrying a roof
  const cols = [[0.16, 0.36, 0.2], [0.78, 0.6, 0.1], [0.72, 0.2, 0.13]];
  for (let i = 0; i < 3; i++) b.box(22 + i * 7, 0, -36, 24.2 + i * 7, 15, -27, { color: cols[i], paint: 0.72, vboards: true, seg: 2 });
  b.box(19, 15, -40, 42, 16.2, -24);
  // vault swept along z
  { const pts = []; for (let i = 0; i <= 16; i++) { const a = Math.PI * i / 16; pts.push([Math.cos(a) * 5, Math.sin(a) * 2.2]); }
    b.sweep(pts, [-32, 6, -40], [1, 0, 0], [0, 1, 0], [0, 0, 16], { mat: 'concrete', solid: 0 }, { smooth: true, flip: true });
    b.box(-37.3, 0, -40, -36.7, 6, -24); b.box(-27.3, 0, -40, -26.7, 6, -24); }
  // hyperboloid
  { const prof = []; for (let i = 0; i <= 20; i++) { const t = i / 20, y = t * 22; const r = 7 * Math.sqrt(1 + Math.pow((y - 13) / 9, 2)) / Math.sqrt(1 + Math.pow(13 / 9, 2)) * 1.25; prof.push([r, y]); }
    b.lathe(0, -70, prof, { solid: 0 }, { sides: 48, warp: (p, a, t) => { if (t > 0.6) p[1] += (t - 0.6) * 9 * Math.cos(a); } });
    solids.addCyl(0, -70, 7, 0, 22); }
  // rusty painted box (car stand-in)
  b.obox(6, 0, -12, 4.2, 1.4, 1.7, 0.4, { mat: 'metal', color: [0.75, 0.75, 0.72], paint: 0.55, surf: SURF.metal, seg: 0.8 });
  b.cylinder(-6, -10, 0, 4, 0.35, { vboards: true });

  solids.build(-160, -160, 160, 160, 4);
  const state = { hours: 17.5, y: 2087, m: 9, d: 23, yaw: 0, pitch: 0, x: 0, yy: 1.7, z: 0, fov: 70 };
  function frame(dt = 0.016) {
    GU.uTime.value += dt;
    sky.setTime(jdFromLocal(state.y, state.m, state.d, state.hours));
    camera.position.set(state.x, state.yy, state.z);
    camera.rotation.set(state.pitch * DEG, -state.yaw * DEG, 0);
    camera.fov = state.fov; camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    sky._envTimer = 0;
    sky.update(dt, camera, 1);
    sky.updateShadow(camera.position, gfx.q.shadowRange, gfx.q.shadow);
    gfx.post.uExposure.value = sky.exposure;
    gfx.render(scene, camera, null, null, { time: GU.uTime.value, sunDir: sky.lightDir, shaftStrength: sky.shaftStrength, shaftColor: sky.shaftColor });
  }
  window.__dbg = {
    set(o) { Object.assign(state, o); frame(); frame(); return { sunAlt: sky.astro.sunAlt / DEG, exposure: sky.exposure, night: sky.night, lightE: sky.lightE.toArray(), zenith: sky.zenith.toArray(), calls: gfx.renderer.info.render.calls, tris: gfx.renderer.info.render.triangles }; },
    sky, gfx, camera, scene, state, frame, solids, b,
  };
  (async () => {
    const t1 = performance.now();
    await bakeAO(b, solids, () => 0, makeSlicer(30));
    const tAO = performance.now() - t1;
    for (const m of b.finish(mats)) scene.add(m);
    window.__info = { tTex: Math.round(tTex), tAO: Math.round(tAO), verts: b.vertexCount, tris: b.triangleCount, solids: solids.n };
    frame(); frame();
    window.__ready = true;
  })().catch(e => { window.__bootError = String(e.stack || e); console.error(e); });
} catch (e) { window.__bootError = String(e.stack || e); console.error(e); }
