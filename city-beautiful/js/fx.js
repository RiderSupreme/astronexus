// Effects: smoke and dust, sparks, blood, bullet scars, tracers, spent brass,
// and the small life in the air (pollen in the evening light, fireflies after dark).
//
// Everything is drawn as instanced quads from a few fixed-size pools, so a
// firefight costs four draw calls no matter how busy it gets.
import { THREE } from './lib/three.js';
import { GU, FOG_GLSL } from './shared.js';
import { SURF } from './physics.js';
import { standard } from './materials.js';
import { makeRng, clamp, lerp, TAU } from './util.js';

const QUAD = (() => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
})();
function instanced(attrs, capacity) {
  const g = new THREE.InstancedBufferGeometry();
  g.index = QUAD.index; g.setAttribute('position', QUAD.attributes.position);
  const out = {};
  for (const [name, size] of Object.entries(attrs)) {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size);
    a.setUsage(THREE.DynamicDrawUsage); g.setAttribute(name, a); out[name] = a;
  }
  g.instanceCount = 0;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return { g, a: out };
}

const PART_VERT = /* glsl */`
attribute vec4 aPos; attribute vec4 aCol; attribute float aRot;
varying vec2 vUv; varying vec4 vCol; varying vec3 vW;
void main() {
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]), up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  float c = cos(aRot), s = sin(aRot);
  vec2 r = vec2(c * position.x - s * position.y, s * position.x + c * position.y) * aPos.w;
  vec3 wp = aPos.xyz + right * r.x + up * r.y;
  vW = wp; vUv = position.xy + 0.5; vCol = aCol;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const PART_FRAG = /* glsl */`
varying vec2 vUv; varying vec4 vCol; varying vec3 vW;
uniform sampler2D tNoise; uniform vec3 uLit; uniform float uAdd;
${FOG_GLSL}
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float n = texture2D(tNoise, vUv * 0.3 + vCol.rg * 3.7).r;
  float a = smoothstep(1.0, 0.2, d + (n - 0.5) * 0.75 * (1.0 - uAdd)) * vCol.a;
  if (a < 0.004) discard;
  vec3 rd = vW - cameraPosition; float dist = length(rd);
  float f = fogAmount(cameraPosition, rd / max(dist, 1e-3), dist);
  if (uAdd > 0.5) gl_FragColor = vec4(vCol.rgb * a * (1.0 - f), 1.0);
  else gl_FragColor = vec4(applyFog(vCol.rgb * uLit, vW), a);
}`;

const DECAL_VERT = /* glsl */`
attribute vec4 aPos; attribute vec4 aNrm; attribute vec3 aInfo;      // xyz + size, normal + rotation, kind / alpha / seed
varying vec2 vUv; varying vec3 vInfo; varying vec3 vW;
void main() {
  vec3 n = aNrm.xyz; vec3 t = normalize(abs(n.y) < 0.9 ? cross(vec3(0.0, 1.0, 0.0), n) : cross(vec3(1.0, 0.0, 0.0), n)); vec3 b = cross(n, t);
  float c = cos(aNrm.w), s = sin(aNrm.w);
  vec2 r = vec2(c * position.x - s * position.y, s * position.x + c * position.y) * aPos.w;
  vec3 wp = aPos.xyz + t * r.x + b * r.y + n * 0.012;
  vW = wp; vUv = position.xy * 2.0; vInfo = aInfo;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const DECAL_FRAG = /* glsl */`
varying vec2 vUv; varying vec3 vInfo; varying vec3 vW;
uniform sampler2D tNoise; uniform vec3 uLit;
${FOG_GLSL}
void main() {
  float d = length(vUv);
  float ang = atan(vUv.y, vUv.x);
  float n = texture2D(tNoise, vec2(ang * 0.16 + vInfo.z, vInfo.z * 3.1)).r, n2 = texture2D(tNoise, vUv * 0.4 + vInfo.z).g;
  vec3 col; float a;
  if (vInfo.x < 0.5) {            // bullet scar: a dark pit in a pale chipped crater
    float pit = smoothstep(0.32, 0.2, d + (n - 0.5) * 0.12);
    float chip = smoothstep(0.95, 0.5, d + (n - 0.5) * 0.7);
    col = mix(vec3(0.42, 0.4, 0.37), vec3(0.03), pit); a = max(pit, chip * 0.55);
  } else if (vInfo.x < 1.5) {     // blood: a ragged pool with spatter round it
    float pool = smoothstep(0.62, 0.45, d + (n - 0.5) * 0.55);
    float spat = smoothstep(0.7, 0.8, n2) * smoothstep(1.0, 0.5, d);
    col = vec3(0.1, 0.006, 0.006); a = max(pool, spat) * 0.92;
  } else {                        // scorch
    a = smoothstep(1.0, 0.15, d + (n - 0.5) * 0.4) * 0.85; col = vec3(0.012);
  }
  a *= vInfo.y;
  if (a < 0.01) discard;
  gl_FragColor = vec4(applyFog(col * uLit, vW), a);
}`;

const TRACE_VERT = /* glsl */`
attribute vec3 aA; attribute vec3 aB; attribute vec2 aW;      // ends, then width and brightness
varying float vAcross; varying float vAlong; varying float vI;
void main() {
  float u = position.x + 0.5;
  vec3 p = mix(aA, aB, u);
  vec3 side = normalize(cross(aB - aA, cameraPosition - p));
  p += side * position.y * aW.x;
  vAcross = position.y * 2.0; vAlong = u; vI = aW.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const TRACE_FRAG = /* glsl */`
varying float vAcross; varying float vAlong; varying float vI;
void main() {
  float a = (1.0 - abs(vAcross)) * smoothstep(0.0, 0.25, vAlong) * vI;
  gl_FragColor = vec4(vec3(1.0, 0.82, 0.5) * a * 3.0, 1.0);
}`;

const P_STRIDE = 16;   // x y z vx vy vz life maxLife size0 size1 r g b a grav drag  (+ rot, spin kept in a side array)

class Pool {
  constructor(capacity, add, noise) {
    this.cap = capacity; this.n = 0;
    this.d = new Float32Array(capacity * P_STRIDE); this.rot = new Float32Array(capacity * 2);
    const { g, a } = instanced({ aPos: 4, aCol: 4, aRot: 1 }, capacity);
    this.geo = g; this.attr = a;
    this.mat = new THREE.ShaderMaterial({ vertexShader: PART_VERT, fragmentShader: PART_FRAG, transparent: true, depthWrite: false, toneMapped: false,
      blending: add ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { tNoise: { value: noise }, tSkyLUT: GU.tSkyLUT, uFog: GU.uFog, uLit: { value: new THREE.Color(1, 1, 1) }, uAdd: { value: add ? 1 : 0 } } });
    this.mesh = new THREE.Mesh(g, this.mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = add ? 21 : 20;
  }
  emit(x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a, grav = 0, drag = 0, rot = 0, spin = 0) {
    let i = this.n;
    if (i >= this.cap) i = Math.floor(Math.random() * this.cap); else this.n++;
    const D = this.d, o = i * P_STRIDE;
    D[o] = x; D[o + 1] = y; D[o + 2] = z; D[o + 3] = vx; D[o + 4] = vy; D[o + 5] = vz; D[o + 6] = life; D[o + 7] = life; D[o + 8] = s0; D[o + 9] = s1;
    D[o + 10] = r; D[o + 11] = g; D[o + 12] = b; D[o + 13] = a; D[o + 14] = grav; D[o + 15] = drag;
    this.rot[i * 2] = rot; this.rot[i * 2 + 1] = spin;
  }
  update(dt, groundAt, extra) {
    const D = this.d, P = this.attr.aPos.array, C = this.attr.aCol.array, R = this.attr.aRot.array;
    let w = 0;
    for (let i = 0; i < this.n; i++) {
      const o = i * P_STRIDE;
      const life = D[o + 6] - dt;
      if (life <= 0) continue;
      const k = Math.exp(-D[o + 15] * dt);
      D[o + 3] *= k; D[o + 5] *= k; D[o + 4] = D[o + 4] * k - D[o + 14] * dt;
      let x = D[o] + D[o + 3] * dt, y = D[o + 1] + D[o + 4] * dt, z = D[o + 2] + D[o + 5] * dt;
      if (D[o + 14] > 3 && groundAt) { const g = groundAt(x, z); if (y < g + 0.02) { y = g + 0.02; D[o + 4] *= -0.25; D[o + 3] *= 0.5; D[o + 5] *= 0.5; } }
      const rot = this.rot[i * 2] + this.rot[i * 2 + 1] * dt;
      // compact as we go
      if (w !== i) { const q = w * P_STRIDE; for (let j = 0; j < P_STRIDE; j++) D[q + j] = D[o + j]; this.rot[w * 2 + 1] = this.rot[i * 2 + 1]; }
      const q = w * P_STRIDE; D[q] = x; D[q + 1] = y; D[q + 2] = z; D[q + 6] = life; this.rot[w * 2] = rot;
      const t = 1 - life / D[q + 7], fade = t < 0.1 ? t / 0.1 : 1 - (t - 0.1) / 0.9;
      P[w * 4] = x; P[w * 4 + 1] = y; P[w * 4 + 2] = z; P[w * 4 + 3] = lerp(D[q + 8], D[q + 9], Math.sqrt(t));
      C[w * 4] = D[q + 10]; C[w * 4 + 1] = D[q + 11]; C[w * 4 + 2] = D[q + 12]; C[w * 4 + 3] = D[q + 13] * fade;
      R[w] = rot; w++;
    }
    this.n = w;
    if (extra) w = extra(P, C, R, w, this.cap);
    this.geo.instanceCount = w;
    this.attr.aPos.needsUpdate = this.attr.aCol.needsUpdate = this.attr.aRot.needsUpdate = true;
  }
}

export class Fx {
  constructor(game) {
    this.game = game; this.world = game.world;
    const scene = game.scene, noise = game.noise;
    this.rng = makeRng(4242);
    this.smoke = new Pool(1100, false, noise); this.glow = new Pool(700, true, noise);
    scene.add(this.smoke.mesh, this.glow.mesh);
    // decals
    { const { g, a } = instanced({ aPos: 4, aNrm: 4, aInfo: 3 }, 180);
      this.decalGeo = g; this.decalAttr = a; this.decalN = 0; this.decalCap = 180;
      this.decalMat = new THREE.ShaderMaterial({ vertexShader: DECAL_VERT, fragmentShader: DECAL_FRAG, transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
        uniforms: { tNoise: { value: noise }, tSkyLUT: GU.tSkyLUT, uFog: GU.uFog, uLit: this.smoke.mat.uniforms.uLit } });
      const m = new THREE.Mesh(g, this.decalMat); m.frustumCulled = false; m.renderOrder = 5; scene.add(m); }
    // tracers
    { const { g, a } = instanced({ aA: 3, aB: 3, aW: 2 }, 40);
      this.traceGeo = g; this.traceAttr = a; this.traces = [];
      const m = new THREE.Mesh(g, new THREE.ShaderMaterial({ vertexShader: TRACE_VERT, fragmentShader: TRACE_FRAG, transparent: true, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
      m.frustumCulled = false; m.renderOrder = 22; scene.add(m); }
    // spent cases
    this.caseMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.006, 0.006, 0.026, 6), standard({ color: 0xb8892f, metalness: 0.9, roughness: 0.35 }, 'brass'), 24);
    this.caseMesh.frustumCulled = false; this.caseMesh.count = 0; scene.add(this.caseMesh);
    this.cases = [];
    // lights: always present so that switching them on never recompiles a shader
    this.flash = new THREE.PointLight(0xffc880, 0, 26, 1.6); this.boom = new THREE.PointLight(0xff9a50, 0, 60, 1.4);
    scene.add(this.flash, this.boom);
    this.flashT = 0; this.boomT = 0;
    // things adrift in the air round the camera
    this.motes = [];
    for (let i = 0; i < 110; i++) this.motes.push({ x: this.rng.range(-14, 14), y: this.rng.range(0.2, 6), z: this.rng.range(-14, 14), ph: this.rng.range(0, TAU), s: this.rng.range(0.5, 1.4), fly: i < 36 });
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler();
  }

  // ---- emitters ----
  // A bullet meets a surface.
  impact(x, y, z, nx, ny, nz, surf) {
    const r = this.rng, S = this.smoke, G = this.glow;
    if (surf === SURF.water) {
      for (let i = 0; i < 9; i++) S.emit(x + r.range(-0.1, 0.1), y + 0.05, z + r.range(-0.1, 0.1), r.range(-0.6, 0.6), r.range(1.5, 4.5), r.range(-0.6, 0.6), r.range(0.3, 0.6), 0.05, 0.22, 0.75, 0.8, 0.78, 0.5, 9.8, 0.5);
      S.emit(x, y + 0.04, z, 0, 0.3, 0, 0.7, 0.2, 1.1, 0.7, 0.75, 0.72, 0.25, 0, 1);
      return;
    }
    const dusty = surf === SURF.concrete ? [0.62, 0.6, 0.56] : surf === SURF.dirt ? [0.34, 0.27, 0.18] : surf === SURF.wood ? [0.36, 0.26, 0.16] : surf === SURF.foliage ? [0.2, 0.3, 0.12] : [0.4, 0.4, 0.4];
    if (surf !== SURF.metal && surf !== SURF.glass) {
      for (let i = 0; i < 3; i++) S.emit(x + nx * 0.05, y + ny * 0.05, z + nz * 0.05, nx * r.range(0.4, 1.6) + r.range(-0.4, 0.4), ny * r.range(0.4, 1.6) + r.range(0, 0.6), nz * r.range(0.4, 1.6) + r.range(-0.4, 0.4), r.range(0.5, 1.1), 0.1, r.range(0.5, 1.0), dusty[0], dusty[1], dusty[2], 0.42, -0.2, 2.2, r.range(0, TAU), r.range(-1, 1));
      for (let i = 0; i < 6; i++) S.emit(x, y, z, nx * r.range(1, 4) + r.range(-1.5, 1.5), ny * r.range(1, 4) + r.range(0, 2.5), nz * r.range(1, 4) + r.range(-1.5, 1.5), r.range(0.4, 0.9), 0.03, 0.02, dusty[0] * 0.6, dusty[1] * 0.6, dusty[2] * 0.6, 1, 9.8, 0.3);
    }
    if (surf === SURF.metal || (surf === SURF.concrete && r() < 0.45)) for (let i = 0; i < (surf === SURF.metal ? 9 : 4); i++)
      G.emit(x, y, z, nx * r.range(2, 7) + r.range(-3, 3), ny * r.range(2, 7) + r.range(-1, 4), nz * r.range(2, 7) + r.range(-3, 3), r.range(0.12, 0.35), 0.035, 0.012, 3.5, 2.2, 0.8, 1, 9.8, 0.5);
    if (surf === SURF.concrete || surf === SURF.metal || surf === SURF.wood) this.decal(x, y, z, nx, ny, nz, r.range(0.09, 0.15), 0);
  }
  // A bullet meets the infected. dir: the way the round was travelling.
  blood(x, y, z, dx, dy, dz, big = false) {
    const r = this.rng, S = this.smoke, n = big ? 22 : 9;
    for (let i = 0; i < n; i++) S.emit(x, y, z, dx * r.range(0.5, 4) + r.range(-1.6, 1.6), r.range(-0.5, 3.2) + (big ? 1.5 : 0), dz * r.range(0.5, 4) + r.range(-1.6, 1.6), r.range(0.35, 0.8), r.range(0.03, 0.07), 0.02, 0.2, 0.012, 0.01, 1, 9.8, 0.4);
    S.emit(x, y, z, dx * 0.8, 0.4, dz * 0.8, r.range(0.35, 0.6), 0.12, big ? 0.9 : 0.5, 0.16, 0.012, 0.012, 0.5, 0.4, 2.5, r.range(0, TAU));
    // what comes out the far side lands on the ground behind
    if (r() < (big ? 1 : 0.5)) { const gx = x + dx * r.range(0.5, 1.8), gz = z + dz * r.range(0.5, 1.8); this.decal(gx, this.world.heightAt(gx, gz), gz, 0, 1, 0, r.range(0.3, big ? 0.9 : 0.6), 1); }
  }
  muzzle(x, y, z, dx, dy, dz, power = 1) {
    const r = this.rng;
    this.flash.position.set(x + dx * 0.4, y + dy * 0.4, z + dz * 0.4); this.flash.intensity = 55 * power; this.flashT = 0.055;
    for (let i = 0; i < 2; i++) this.smoke.emit(x + dx * 0.3, y + dy * 0.3, z + dz * 0.3, dx * r.range(0.6, 2), dy * 2 + r.range(0.1, 0.5), dz * r.range(0.6, 2), r.range(0.5, 1.0), 0.06, r.range(0.35, 0.6) * power, 0.55, 0.55, 0.55, 0.16, -0.25, 2.5, r.range(0, TAU), r.range(-1, 1));
  }
  tracer(ax, ay, az, bx, by, bz) { if (this.traces.length < 40) this.traces.push({ a: [ax, ay, az], b: [bx, by, bz], t: 0.07 }); }
  casing(x, y, z, vx, vy, vz) { if (this.cases.length >= 24) this.cases.shift(); this.cases.push({ x, y, z, vx, vy, vz, rx: 0, rz: 0, sx: this.rng.range(-20, 20), sz: this.rng.range(-20, 20), t: 5 }); }
  decal(x, y, z, nx, ny, nz, size, kind) {
    const i = this.decalN % this.decalCap; this.decalN++;
    const A = this.decalAttr;
    A.aPos.setXYZW(i, x, y, z, size); A.aNrm.setXYZW(i, nx, ny, nz, this.rng.range(0, TAU)); A.aInfo.setXYZ(i, kind, 1, this.rng.range(0, 10));
    A.aPos.needsUpdate = A.aNrm.needsUpdate = A.aInfo.needsUpdate = true;
    this.decalGeo.instanceCount = Math.min(this.decalN, this.decalCap);
  }
  // Earth thrown up where something claws out of the ground.
  dirt(x, y, z) {
    const r = this.rng;
    for (let i = 0; i < 7; i++) this.smoke.emit(x + r.range(-0.3, 0.3), y + 0.1, z + r.range(-0.3, 0.3), r.range(-1.2, 1.2), r.range(1, 3.4), r.range(-1.2, 1.2), r.range(0.5, 0.9), 0.05, 0.03, 0.2, 0.15, 0.09, 1, 9.8, 0.2);
    this.smoke.emit(x, y + 0.2, z, 0, 0.5, 0, 1.2, 0.4, 1.5, 0.3, 0.24, 0.16, 0.3, 0, 1.5, r.range(0, TAU));
  }
  explosion(x, y, z) {
    const r = this.rng, S = this.smoke, G = this.glow;
    this.boom.position.set(x, y + 0.6, z); this.boom.intensity = 900; this.boomT = 0.4;
    for (let i = 0; i < 16; i++) G.emit(x + r.range(-0.5, 0.5), y + r.range(0.1, 0.9), z + r.range(-0.5, 0.5), r.range(-3, 3), r.range(0.5, 5), r.range(-3, 3), r.range(0.25, 0.5), 1.2, 3.2, 3.6, 1.7, 0.45, 0.9, -1, 2.5, r.range(0, TAU));
    for (let i = 0; i < 26; i++) { const a = r.range(0, TAU), v = r.range(3, 9); S.emit(x, y + 0.3, z, Math.cos(a) * v, r.range(0.3, 4), Math.sin(a) * v, r.range(1.4, 3.2), 0.8, r.range(2.5, 5), 0.2, 0.19, 0.17, 0.5, -0.4, 1.6, r.range(0, TAU), r.range(-0.6, 0.6)); }
    for (let i = 0; i < 40; i++) G.emit(x, y + 0.3, z, r.range(-12, 12), r.range(2, 14), r.range(-12, 12), r.range(0.4, 1.1), 0.06, 0.02, 3.2, 1.8, 0.5, 1, 9.8, 0.3);
    for (let i = 0; i < 30; i++) S.emit(x, y + 0.2, z, r.range(-8, 8), r.range(3, 11), r.range(-8, 8), r.range(0.8, 1.6), 0.07, 0.04, 0.12, 0.1, 0.08, 1, 9.8, 0.1);
    this.decal(x, this.world.heightAt(x, z), z, 0, 1, 0, 2.6, 2);
  }

  update(dt, camera, sky) {
    const W = this.world, groundAt = (x, z) => W.heightAt(x, z);
    // particles reflect roughly what the sky and sun are giving
    this.smoke.mat.uniforms.uLit.value.setRGB(sky.zenith.r * 1.6 + sky.horizon.r * 1.6 + sky.lightE.r * 0.13, sky.zenith.g * 1.6 + sky.horizon.g * 1.6 + sky.lightE.g * 0.13, sky.zenith.b * 1.6 + sky.horizon.b * 1.6 + sky.lightE.b * 0.13);
    this.smoke.update(dt, groundAt);
    // motes ride in the additive pool, re-centred on the camera every frame
    const t = GU.uTime.value, cx = camera.position.x, cy = camera.position.y, cz = camera.position.z, night = sky.night;
    const wx = GU.uWind.value.x * GU.uWind.value.z, wz = GU.uWind.value.y * GU.uWind.value.z;
    const sunK = clamp((sky.lightE.r + sky.lightE.g) * 0.04, 0, 1) * (1 - night);
    this.glow.update(dt, groundAt, (P, C, R, w, cap) => {
      for (const m of this.motes) {
        if (w >= cap) break;
        m.x += (wx * 0.35 + Math.sin(t * 0.7 + m.ph) * 0.12) * dt; m.z += (wz * 0.35 + Math.cos(t * 0.6 + m.ph * 1.3) * 0.12) * dt; m.y += Math.sin(t * 0.5 + m.ph * 2.1) * 0.06 * dt;
        // wrap round the camera
        if (m.x < -14) m.x += 28; else if (m.x > 14) m.x -= 28; if (m.z < -14) m.z += 28; else if (m.z > 14) m.z -= 28;
        const gy = W.heightAt(cx + m.x, cz + m.z);
        let a, r, g, b, s;
        if (m.fly) { const blink = Math.pow(Math.max(0, Math.sin(t * (0.6 + m.s * 0.5) + m.ph)), 6); a = night * blink; r = 1.6; g = 2.6; b = 0.5; s = 0.07; if (a < 0.01) continue; }
        else { a = sunK * 0.5 * (0.5 + 0.5 * Math.sin(t * 1.3 + m.ph)); r = 1.0; g = 0.8; b = 0.45; s = 0.022 * m.s; if (a < 0.01) continue; }
        P[w * 4] = cx + m.x; P[w * 4 + 1] = gy + (m.fly ? 0.3 + (m.y % 2.2) : m.y); P[w * 4 + 2] = cz + m.z; P[w * 4 + 3] = s;
        C[w * 4] = r; C[w * 4 + 1] = g; C[w * 4 + 2] = b; C[w * 4 + 3] = a; R[w] = 0; w++;
      }
      return w;
    });
    // tracers
    const TA = this.traceAttr; let n = 0;
    for (let i = this.traces.length - 1; i >= 0; i--) { const tr = this.traces[i]; tr.t -= dt; if (tr.t <= 0) this.traces.splice(i, 1); }
    for (const tr of this.traces) { TA.aA.setXYZ(n, tr.a[0], tr.a[1], tr.a[2]); TA.aB.setXYZ(n, tr.b[0], tr.b[1], tr.b[2]); TA.aW.setXY(n, 0.035, tr.t / 0.07); n++; }
    this.traceGeo.instanceCount = n; TA.aA.needsUpdate = TA.aB.needsUpdate = TA.aW.needsUpdate = true;
    // brass
    let c = 0;
    for (let i = this.cases.length - 1; i >= 0; i--) {
      const k = this.cases[i]; k.t -= dt; if (k.t <= 0) { this.cases.splice(i, 1); continue; }
      k.vy -= 9.8 * dt; k.x += k.vx * dt; k.y += k.vy * dt; k.z += k.vz * dt; k.rx += k.sx * dt; k.rz += k.sz * dt;
      const g = W.groundAt(k.x, k.z, k.y + 0.3, 0.3) + 0.008;
      if (k.y < g) { k.y = g; if (Math.abs(k.vy) > 1) this.game.audio?.casing(k); k.vy *= -0.35; k.vx *= 0.5; k.vz *= 0.5; k.sx *= 0.4; k.sz *= 0.4; if (Math.abs(k.vy) < 0.4) { k.vy = 0; k.sx = k.sz = 0; } }
    }
    for (const k of this.cases) { this._e.set(k.rx, 0, k.rz); this._q.setFromEuler(this._e); this._m.compose(new THREE.Vector3(k.x, k.y, k.z), this._q, new THREE.Vector3(1, 1, 1)); this.caseMesh.setMatrixAt(c++, this._m); }
    this.caseMesh.count = c; this.caseMesh.instanceMatrix.needsUpdate = true;
    // lights die away
    if (this.flashT > 0) { this.flashT -= dt; if (this.flashT <= 0) this.flash.intensity = 0; }
    if (this.boomT > 0) { this.boomT -= dt; this.boom.intensity = Math.max(0, 900 * (this.boomT / 0.4) ** 2); }
  }
}
