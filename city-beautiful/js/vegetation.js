// Sixty years of growth.
//
// Trees are grown branch by branch from a few numbers per species and drawn
// instanced. Everything smaller (meadow grass, kans in plume, lantana, ferns,
// creepers on the concrete, lotus on the pools) is a card cut from the foliage
// atlas, drawn instanced in chunks and bent by the wind in the vertex shader.
import { THREE } from './lib/three.js';
import { GU } from './shared.js';
import { patch } from './materials.js';
import { TILES, GRID } from './foliage.js';
import { BOUNDS } from './world.js';
import { SOLID, SURF } from './physics.js';
import { makeRng, TAU, clamp, lerp, smoothstep, fbm2, noise2 } from './util.js';

const tileIndex = name => TILES[name][0] + TILES[name][1] * GRID;

// ---------------------------------------------------------------------------
// One shader for every leaf. Variants are chosen with defines.
const FOL_VERT_PARS = /* glsl */`
uniform sampler2D tNoise; uniform vec4 uWind; uniform vec3 uPlayer; uniform vec3 uLightDir;
varying vec4 vTint;
#ifdef FOL_CARDS
  attribute vec4 aInst;      // x, y, z, yaw
  attribute vec4 aInst2;     // width, height, atlas tile, ambient
  attribute vec3 aTint;
#endif
#ifdef FOL_TREE
  attribute vec3 aLeaf;      // sway weight, flutter weight, shade
#endif
float gust(vec2 p) { return texture2D(tNoise, p * 0.0055 - uWind.xy * uTime * 0.03).r; }
`;
const FOL_VERT_UV = /* glsl */`
#ifdef FOL_CARDS
  #ifdef USE_MAP
  { float ti = aInst2.z; vec2 tile = vec2(mod(ti, 4.0), floor(ti / 4.0));
    vec2 luv = clamp(uv, 0.0, 1.0) * 0.976 + 0.012;
    vMapUv = vec2((tile.x + luv.x) * 0.25, 1.0 - (tile.y + 1.0 - luv.y) * 0.25); }
  #endif
#endif
`;
const FOL_VERT_NORMAL = /* glsl */`
#ifdef FOL_UPNORMAL
  // grass is lit as the ground is, leaning toward a low sun the way upright blades catch it
  objectNormal = normalize(vec3(0.0, 1.0, 0.0) + vec3(uLightDir.x, 0.0, uLightDir.z) * 0.6);
#else
  #ifdef FOL_CARDS
  { float cy = cos(aInst.w), sn = sin(aInst.w); vec3 n0 = objectNormal;
    objectNormal = normalize(vec3(cy * n0.x + sn * n0.z, n0.y + 0.35, -sn * n0.x + cy * n0.z)); }
  #endif
#endif
`;
const FOL_VERT_BEGIN = /* glsl */`
#ifdef FOL_CARDS
  float fh = uv.y;
  { float cy = cos(aInst.w), sn = sin(aInst.w);
    vec3 lp = transformed * vec3(aInst2.x, aInst2.y, aInst2.x);
    transformed = vec3(cy * lp.x + sn * lp.z, lp.y, -sn * lp.x + cy * lp.z) + aInst.xyz; }
  #ifdef FOL_WIND
  { vec3 fw = transformed;
    float g = gust(fw.xz);
    float sway = (g * 1.5 - 0.35) + 0.22 * sin(uTime * 2.1 + fw.x * 0.83 + fw.z * 0.61);
    float k = fh * fh * aInst2.y * 0.26 * uWind.z;
    transformed.xz += uWind.xy * sway * k;
    transformed.y -= abs(sway) * k * 0.25;
    // whoever wades through, the grass parts
    vec2 d = fw.xz - uPlayer.xz; float dl = length(d);
    float push = smoothstep(1.25, 0.2, dl) * fh * step(abs(aInst.y - uPlayer.y), 2.0);
    transformed.xz += (d / max(dl, 0.05)) * push * 0.55; transformed.y -= push * 0.3 * aInst2.y; }
  #endif
  #ifdef FOL_HANG
  { vec3 fw = transformed; float g = gust(fw.xz);
    float sway = (g * 1.4 - 0.4) + 0.3 * sin(uTime * 1.6 + fw.x * 0.9 + fw.z * 0.7);
    float k = (1.0 - fh) * (1.0 - fh) * aInst2.y * 0.12 * uWind.z;          // fixed at the top, free at the bottom
    transformed.xz += uWind.xy * sway * k; }
  #endif
  vTint = vec4(aTint, aInst2.w);
#endif
#ifdef FOL_TREE
  { vec3 ip = vec3(0.0);
    #ifdef USE_INSTANCING
      ip = instanceMatrix[3].xyz;
    #endif
    float g = gust(ip.xz), ph = ip.x * 0.37 + ip.z * 0.51;
    float sway = (g * 1.4 - 0.4) + 0.3 * sin(uTime * 1.3 + ph);
    transformed.xz += uWind.xy * sway * aLeaf.x * aLeaf.x * 0.55 * uWind.z;
    float fl = sin(uTime * 4.6 + position.x * 2.3 + position.y * 1.7 + position.z * 2.9 + ph);
    transformed += normal * fl * aLeaf.y * 0.045 * uWind.z * (0.4 + g); }
  vTint = vec4(vec3(aLeaf.z), 1.0);
#endif
`;
const FOL_FRAG_PARS = /* glsl */`
varying vec4 vTint; uniform vec3 uLightDir; uniform vec3 uLightColor; uniform float uTrans;
`;
const FOL_FRAG_COLOR = /* glsl */`
#ifdef FOL_CUTOUT
  {
    #ifdef FOL_A2C
      diffuseColor.a = clamp((diffuseColor.a - 0.4) / max(fwidth(diffuseColor.a), 1e-4) + 0.5, 0.0, 1.0);
    #endif
  }
#endif
  diffuseColor.rgb *= vTint.rgb;
`;
const FOL_FRAG_NORMAL = /* glsl */`
#ifdef FOL_NOFLIP
  normal = normalize(vNormal);
#endif
`;
const FOL_FRAG_LIGHT = /* glsl */`
  { vec3 vdir = normalize(vWPos - cameraPosition);
    float back = pow(max(dot(vdir, uLightDir), 0.0), 3.0);    // looking into the light, leaves glow with what passes through them
    reflectedLight.directDiffuse *= 1.0 + back * uTrans;
    #ifdef FOL_TREE
      // sun on the far side of a leaf comes through it; the outer crown glows, the inside stays dark
      float through = max(dot(-normalize(vWNrm), uLightDir), 0.0) * smoothstep(0.55, 1.0, vTint.r);
      reflectedLight.directDiffuse += diffuseColor.rgb * vec3(1.0, 1.05, 0.55) * uLightColor * (through * (0.1 + 0.3 * back));
    #endif
    reflectedLight.indirectDiffuse *= vTint.a; reflectedLight.indirectSpecular *= vTint.a * 0.4; }
`;

function foliageMaterial({ map = null, noise, defines = {}, key, a2c = false, trans = 2.2, roughness = 0.72, side = THREE.DoubleSide, color = 0xffffff, cutout = true }) {
  const mat = new THREE.MeshStandardMaterial({ color, map, roughness, metalness: 0, side, alphaTest: cutout ? (a2c ? 0.03 : 0.4) : 0 });
  if (a2c && cutout) { mat.alphaToCoverage = true; defines.FOL_A2C = 1; }
  if (cutout) defines.FOL_CUTOUT = 1;
  const uniforms = { tNoise: { value: noise }, uWind: GU.uWind, uPlayer: GU.uCamPos, uLightDir: GU.uLightDir, uLightColor: GU.uLightColor, uTrans: { value: trans } };
  patch(mat, { key: 'fol-' + key + (a2c ? '-a2c' : ''), defines, uniforms, vertPars: FOL_VERT_PARS, vertUv: FOL_VERT_UV, vertNormal: FOL_VERT_NORMAL, vertBegin: FOL_VERT_BEGIN,
    fragPars: FOL_FRAG_PARS, fragColor: FOL_FRAG_COLOR, fragNormal: FOL_FRAG_NORMAL, fragLight: FOL_FRAG_LIGHT });
  // the same motion in the shadow pass, or shadows would stand still while the leaves move
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: cutout ? map : null, alphaTest: cutout ? 0.4 : 0, side });
  const dd = { ...defines }; delete dd.FOL_A2C; delete dd.FOL_UPNORMAL;
  patch(depth, { key: 'fold-' + key, defines: dd, uniforms, fog: false, vertPars: FOL_VERT_PARS, vertUv: FOL_VERT_UV, vertBegin: FOL_VERT_BEGIN });
  mat.userData.depth = depth;
  return mat;
}

// ---------------------------------------------------------------------------
// Instanced cards, bucketed into square chunks so the renderer can cull them.
class CardSet {
  constructor(base, material, { chunk = 26, castShadow = false, maxDist = 130 } = {}) {
    this.base = base; this.material = material; this.chunk = chunk; this.castShadow = castShadow; this.maxDist = maxDist;
    this.buckets = new Map(); this.meshes = []; this.count = 0;
  }
  add(x, y, z, yaw, w, h, tile, tint, ambient = 1) {
    const k = Math.floor(x / this.chunk) + ',' + Math.floor(z / this.chunk);
    let b = this.buckets.get(k);
    if (!b) { b = []; this.buckets.set(k, b); }
    b.push(x, y, z, yaw, w, h, tile, ambient, tint[0], tint[1], tint[2]);
    this.count++;
  }
  build(parent) {
    for (const b of this.buckets.values()) {
      const n = b.length / 11;
      const g = new THREE.InstancedBufferGeometry();
      g.index = this.base.index; g.setAttribute('position', this.base.attributes.position); g.setAttribute('normal', this.base.attributes.normal); g.setAttribute('uv', this.base.attributes.uv);
      const i1 = new Float32Array(n * 4), i2 = new Float32Array(n * 4), t = new Float32Array(n * 3);
      let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let i = 0; i < n; i++) {
        const o = i * 11;
        i1.set([b[o], b[o + 1], b[o + 2], b[o + 3]], i * 4); i2.set([b[o + 4], b[o + 5], b[o + 6], b[o + 7]], i * 4); t.set([b[o + 8], b[o + 9], b[o + 10]], i * 3);
        const r = b[o + 4];
        minX = Math.min(minX, b[o] - r); maxX = Math.max(maxX, b[o] + r); minZ = Math.min(minZ, b[o + 2] - r); maxZ = Math.max(maxZ, b[o + 2] + r);
        minY = Math.min(minY, b[o + 1] - 0.5); maxY = Math.max(maxY, b[o + 1] + b[o + 5]);
      }
      g.setAttribute('aInst', new THREE.InstancedBufferAttribute(i1, 4));
      g.setAttribute('aInst2', new THREE.InstancedBufferAttribute(i2, 4));
      g.setAttribute('aTint', new THREE.InstancedBufferAttribute(t, 3));
      g.instanceCount = n;
      const c = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
      g.boundingSphere = new THREE.Sphere(c, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 + 0.5);
      const m = new THREE.Mesh(g, this.material);
      m.customDepthMaterial = this.material.userData.depth;
      m.castShadow = this.castShadow; m.receiveShadow = true; m.matrixAutoUpdate = false;
      m.userData.centre = c; m.userData.radius = g.boundingSphere.radius;
      parent.add(m); this.meshes.push(m);
    }
    this.buckets = null;
  }
  // Hide chunks too far away to matter.
  cull(cam) {
    for (const m of this.meshes) { const c = m.userData.centre; m.visible = Math.hypot(c.x - cam.x, c.z - cam.z) - m.userData.radius < this.maxDist; }
  }
}

function quadGeo(kind) {
  const g = new THREE.BufferGeometry();
  if (kind === 'tuft') {       // two upright cards crossed at right angles
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0, 0, 0, -0.5, 0, 0, 0.5, 0, 1, 0.5, 0, 1, -0.5], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  } else if (kind === 'flat') { // lying on the ground or the water
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, -0.5], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
  } else if (kind === 'hang') { // hangs down from its top edge
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -1, 0, 0.5, -1, 0, 0.5, 0, 0, -0.5, 0, 0], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
  } else {                      // one upright card
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
  }
  return g;
}

// ---------------------------------------------------------------------------
// Trees.
const SPECIES = {
  // Ficus benghalensis: short stout bole, limbs that run out level for a dozen metres and let down roots
  banyan: { tile: 'banyan', trunk: [3.4, 4.6], radius: [0.95, 1.35], depth: 3, kids: [5, 4, 3], spread: [1.15, 0.75, 0.7], len: [1.9, 0.52, 0.5], rad: [0.5, 0.55, 0.55], up: [0.05, 0.1, 0.12], gnarl: [0.1, 0.22, 0.3, 0.35], segs: [5, 7, 5, 4],
    card: [2.0, 3.0], perTip: 7, tipRadius: 2.3, alongLast: 3, roots: 26, bark: [0.78, 0.74, 0.7], shade: 0.5 },
  // Ficus religiosa: taller, paler, an open crown of trembling heart-shaped leaves
  peepal: { tile: 'peepal', trunk: [4.5, 6.5], radius: [0.42, 0.62], depth: 3, kids: [4, 3, 3], spread: [0.75, 0.7, 0.75], len: [1.05, 0.62, 0.55], rad: [0.55, 0.6, 0.55], up: [0.16, 0.14, 0.1], gnarl: [0.08, 0.18, 0.28, 0.3], segs: [5, 5, 4, 4],
    card: [1.7, 2.5], perTip: 6, tipRadius: 1.8, alongLast: 2, roots: 0, bark: [1.0, 0.98, 0.93], shade: 0.56 },
  // Azadirachta indica: a round dense head on a straight bole
  neem: { tile: 'neem', trunk: [3.6, 5.2], radius: [0.3, 0.46], depth: 3, kids: [4, 4, 3], spread: [0.8, 0.8, 0.8], len: [0.95, 0.6, 0.55], rad: [0.58, 0.6, 0.55], up: [0.14, 0.1, 0.06], gnarl: [0.07, 0.16, 0.25, 0.3], segs: [5, 5, 4, 4],
    card: [1.8, 2.6], perTip: 6, tipRadius: 1.7, alongLast: 2, roots: 0, bark: [0.72, 0.62, 0.52], shade: 0.52 },
  // a seedling rooted in a crack: what a peepal looks like in its first ten years
  sapling: { tile: 'peepal', trunk: [1.0, 1.8], radius: [0.05, 0.09], depth: 2, kids: [3, 3], spread: [0.7, 0.8], len: [0.9, 0.6], rad: [0.6, 0.6], up: [0.2, 0.15], gnarl: [0.12, 0.25, 0.3], segs: [4, 4, 3],
    card: [0.8, 1.3], perTip: 4, tipRadius: 0.6, alongLast: 1, roots: 0, bark: [0.9, 0.85, 0.75], shade: 0.7 },
  // what the dry years killed
  snag: { tile: null, trunk: [4, 6], radius: [0.3, 0.45], depth: 3, kids: [3, 3, 2], spread: [0.7, 0.8, 0.8], len: [0.8, 0.6, 0.55], rad: [0.55, 0.55, 0.5], up: [0.1, 0.05, 0.0], gnarl: [0.1, 0.25, 0.35, 0.4], segs: [5, 5, 4, 3],
    card: [0, 0], perTip: 0, tipRadius: 0, alongLast: 0, roots: 0, bark: [0.62, 0.6, 0.58], shade: 1 },
};

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const SKY_DIRS = [[0, 1, 0], [0.5, 0.86, 0], [-0.5, 0.86, 0], [0, 0.86, 0.5], [0, 0.86, -0.5], [0.61, 0.5, 0.61], [-0.61, 0.5, 0.61], [0.61, 0.5, -0.61], [-0.61, 0.5, -0.61]];

// detail: 0 full, 1 for the tree line just outside the complex, 2 for silhouettes beyond it
function growTree(name, seed, detail = 0) {
  const S0 = SPECIES[name], rng = makeRng(seed), lowDetail = detail > 0;
  // the farthest trees lose their twigs altogether: boughs and a few big cards
  const S = detail === 2 ? { ...S0, depth: Math.min(S0.depth, 2), roots: 0 } : S0;
  const wood = { p: [], n: [], uv: [], l: [], i: [] }, leaf = { p: [], n: [], uv: [], l: [], i: [] };
  const tips = [], colliders = [];
  const trunkLen = rng.range(...S.trunk), trunkRad = rng.range(...S.radius);
  let height = 0;

  // a tapering tube along a path of points with radii; returns nothing, appends to wood
  const tube = (pts, sides, swayAt, lumpy = 0) => {
    let u = null; const base = wood.p.length / 3; let vLen = 0;
    for (let s = 0; s < pts.length; s++) {
      const P = pts[s], d = _a.copy(pts[Math.min(s + 1, pts.length - 1)].p).sub(pts[Math.max(s - 1, 0)].p).normalize();
      if (!u) { u = new THREE.Vector3().crossVectors(d, Math.abs(d.y) < 0.95 ? UP : _b.set(1, 0, 0)).normalize(); }
      else u.addScaledVector(d, -u.dot(d)).normalize();
      const v = _b.crossVectors(d, u);
      if (s > 0) vLen += P.p.distanceTo(pts[s - 1].p);
      const circ = Math.max(1, Math.round(TAU * P.r / 1.3));
      for (let k = 0; k <= sides; k++) {
        const a = (k / sides) * TAU, ca = Math.cos(a), sa = Math.sin(a);
        const lump = 1 + lumpy * P.flare * (0.5 + 0.5 * Math.sin(a * 4 + 1.3)) + P.flare * 0.55;
        const nx = u.x * ca + v.x * sa, ny = u.y * ca + v.y * sa, nz = u.z * ca + v.z * sa, r = P.r * lump;
        wood.p.push(P.p.x + nx * r, P.p.y + ny * r, P.p.z + nz * r); wood.n.push(nx, ny, nz);
        wood.uv.push(k / sides * circ, vLen / 1.3); wood.l.push(swayAt(P.p.y), 0, 1);
      }
    }
    for (let s = 0; s < pts.length - 1; s++) for (let k = 0; k < sides; k++) {
      const a = base + s * (sides + 1) + k, c = a + sides + 1;
      wood.i.push(a, a + 1, c + 1, a, c + 1, c);
    }
  };

  const limbs = [];        // level-one limbs, for the banyan to let roots down from
  const grow = (pos, dir, len, r0, depth) => {
    const segs = lowDetail ? Math.max(2, S.segs[depth] - 2) : S.segs[depth];
    const pts = []; const p = pos.clone(), d = dir.clone();
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const flare = depth === 0 ? Math.max(0, 1 - p.y / 1.4) : 0;
      pts.push({ p: p.clone(), r: r0 * (1 - t * (depth === S.depth ? 0.92 : 0.45)), flare, d: d.clone() });
      if (s < segs) {
        p.addScaledVector(d, len / segs);
        d.x += rng.range(-1, 1) * S.gnarl[depth]; d.z += rng.range(-1, 1) * S.gnarl[depth]; d.y += rng.range(-0.6, 1) * S.gnarl[depth] * 0.6 + S.up[Math.min(depth, S.up.length - 1)];
        if (depth > 0 && p.y < 2.2) d.y += 0.25;       // limbs do not dive into the ground
        d.normalize();
      }
    }
    if (p.y > height) height = p.y;
    const sides = lowDetail ? (depth === 0 ? 6 : 3) : (depth === 0 ? 10 : depth === 1 ? 7 : depth === 2 ? 5 : 3);
    // seen from outside the complex a tree is a trunk, its boughs and a crown: the twigs are behind the leaves
    if (!(lowDetail && depth === S.depth && depth > 1)) tube(pts, sides, y => clamp(y / 14, 0, 1), depth === 0 ? (name === 'banyan' ? 0.5 : 0.22) : 0);
    if (depth === 1) limbs.push(pts);
    if (depth < S.depth) {
      const n = S.kids[depth] + (depth > 0 && rng() < 0.3 ? -1 : 0), phi0 = rng.range(0, TAU);
      for (let k = 0; k < n; k++) {
        const f = depth === 0 ? rng.range(0.72, 1.0) : rng.range(0.35, 1.0), idx = Math.min(segs, Math.round(f * segs)), P = pts[idx];
        const u = _a.crossVectors(P.d, Math.abs(P.d.y) < 0.95 ? UP : _b.set(1, 0, 0)).normalize(), v = _b.crossVectors(P.d, u);
        const phi = phi0 + k * 2.39996 + rng.range(-0.3, 0.3), sp = S.spread[depth] * rng.range(0.8, 1.15);
        const cd = new THREE.Vector3().copy(P.d).multiplyScalar(Math.cos(sp)).addScaledVector(u, Math.cos(phi) * Math.sin(sp)).addScaledVector(v, Math.sin(phi) * Math.sin(sp)).normalize();
        const cl = (depth === 0 ? trunkLen : len) * S.len[depth] * rng.range(0.75, 1.15);
        grow(P.p, cd, cl, P.r * S.rad[depth] * rng.range(0.85, 1.05), depth + 1);
      }
    } else {
      tips.push(pts[pts.length - 1].p.clone());
      if (detail < 2) for (let k = 1; k <= (lowDetail ? 1 : S.alongLast); k++) tips.push(pts[Math.max(1, Math.round((segs * k) / (S.alongLast + 1.5)))].p.clone());
    }
  };
  grow(new THREE.Vector3(0, -0.4, 0), new THREE.Vector3(rng.range(-0.06, 0.06), 1, rng.range(-0.06, 0.06)).normalize(), trunkLen + 0.4, trunkRad, 0);
  colliders.push({ x: 0, z: 0, r: trunkRad * 1.15, h: trunkLen });

  // aerial roots: thin ones swing free, a few reach the ground and thicken into props
  if (S.roots && limbs.length) {
    const count = lowDetail ? Math.round(S.roots * 0.35) : S.roots;
    for (let k = 0; k < count; k++) {
      const L = rng.pick(limbs), P = L[rng.int(1, L.length - 1)];
      if (P.p.y < 3 || Math.hypot(P.p.x, P.p.z) < 2.2) continue;
      const prop = rng() < 0.2, r = prop ? rng.range(0.12, 0.3) : rng.range(0.025, 0.06);
      const end = prop ? -0.3 : rng.range(0.4, P.p.y * 0.7), n = prop ? 4 : 3, pts = [];
      const wob = rng.range(0, TAU);
      for (let s = 0; s <= n; s++) {
        const t = s / n, y = lerp(P.p.y - 0.1, end, t);
        pts.push({ p: new THREE.Vector3(P.p.x + Math.sin(wob + t * 3) * 0.12, y, P.p.z + Math.cos(wob + t * 2.3) * 0.12), r: r * (prop ? 1 + 0.5 * t : 1 - 0.4 * t), flare: prop && s === n ? 0.6 : 0 });
      }
      tube(pts, prop ? 6 : 3, y => clamp(y / 14, 0, 1) * (prop ? 0.2 : 1));
      if (prop) colliders.push({ x: P.p.x, z: P.p.z, r: r * 1.5, h: P.p.y });
    }
  }

  // crown: cards clustered round every twig tip, lit as though they lay on a ball
  const centre = new THREE.Vector3(); for (const t of tips) centre.add(t); if (tips.length) centre.multiplyScalar(1 / tips.length);
  let crownR = 1; for (const t of tips) crownR = Math.max(crownR, t.distanceTo(centre));
  if (S.tile) {
    const [c0, r0] = TILES[S.tile], e = 6 / 2048, u0 = c0 / GRID + e, u1 = (c0 + 1) / GRID - e, v0 = 1 - (r0 + 1) / GRID + e, v1 = 1 - r0 / GRID - e;
    const per = detail === 2 ? 2 : lowDetail ? Math.max(2, Math.round(S.perTip * 0.4)) : S.perTip, scale = detail === 2 ? 2.3 : lowDetail ? 1.55 : 1;
    for (const t of tips) for (let k = 0; k < per; k++) {
      const c = _a.set(rng.gauss(), rng.gauss() * 0.75, rng.gauss()).multiplyScalar(S.tipRadius * 0.5 * scale).add(t);
      const s = rng.range(...S.card) * scale;
      // a random plane, biased to face up and out
      const nrm = _b.set(rng.range(-1, 1), rng.range(-0.2, 1), rng.range(-1, 1)).addScaledVector(_c.copy(c).sub(centre).normalize(), 0.8).normalize();
      const ax = _c.crossVectors(nrm, Math.abs(nrm.y) < 0.9 ? UP : new THREE.Vector3(1, 0, 0)).normalize(); const ay = new THREE.Vector3().crossVectors(nrm, ax);
      const rot = rng.range(0, TAU), cr = Math.cos(rot), sr = Math.sin(rot);
      const rx = ax.clone().multiplyScalar(cr).addScaledVector(ay, sr), ry = ay.clone().multiplyScalar(cr).addScaledVector(ax, -sr);
      const out = new THREE.Vector3().copy(c).sub(centre); const dist = out.length() / crownR; out.normalize(); out.y += 0.55; out.normalize();
      const shade = lerp(S.shade, 1.05, smoothstep(0.25, 0.95, dist)) * rng.range(0.88, 1.08) * (0.8 + 0.2 * clamp((c.y - centre.y) / crownR + 0.5, 0, 1));
      const base = leaf.p.length / 3, flip = rng() < 0.5;
      for (const [sx, sy, uu, vv] of [[-1, -1, 0, 0], [1, -1, 1, 0], [1, 1, 1, 1], [-1, 1, 0, 1]]) {
        leaf.p.push(c.x + (rx.x * sx + ry.x * sy) * s / 2, c.y + (rx.y * sx + ry.y * sy) * s / 2, c.z + (rx.z * sx + ry.z * sy) * s / 2);
        leaf.n.push(out.x, out.y, out.z);
        leaf.uv.push(lerp(u0, u1, flip ? 1 - uu : uu), lerp(v0, v1, vv));
        leaf.l.push(clamp(c.y / 14, 0, 1), 1, shade);
      }
      leaf.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
      if (c.y + s / 2 > height) height = c.y + s / 2;
    }
  }
  const mk = d => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(d.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(d.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(d.uv, 2)); g.setAttribute('aLeaf', new THREE.Float32BufferAttribute(d.l, 3));
    g.setIndex(d.i); g.computeBoundingSphere();
    return g;
  };
  return { name, wood: mk(wood), leaves: S.tile ? mk(leaf) : null, colliders, crownR: crownR + S.tipRadius, crownY: centre.y, height, tint: S.bark };
}

// ---------------------------------------------------------------------------
export class Vegetation {
  constructor({ scene, world, atlas, noise, bark, quality, msaa }) {
    this.scene = scene; this.world = world; this.q = quality;
    this.group = new THREE.Group(); this.group.name = 'vegetation'; scene.add(this.group);
    const a2c = msaa > 0;
    this.mats = {
      grass: foliageMaterial({ map: atlas, noise, key: 'grass', a2c, defines: { FOL_CARDS: 1, FOL_WIND: 1, FOL_UPNORMAL: 1, FOL_NOFLIP: 1 }, trans: 2.6, roughness: 0.85 }),
      shrub: foliageMaterial({ map: atlas, noise, key: 'shrub', a2c, defines: { FOL_CARDS: 1, FOL_WIND: 1, FOL_UPNORMAL: 1, FOL_NOFLIP: 1 }, trans: 1.6, roughness: 0.8 }),
      wall: foliageMaterial({ map: atlas, noise, key: 'wall', a2c, defines: { FOL_CARDS: 1, FOL_NOFLIP: 1 }, trans: 1.2, roughness: 0.7 }),
      hang: foliageMaterial({ map: atlas, noise, key: 'hang', a2c, defines: { FOL_CARDS: 1, FOL_HANG: 1, FOL_NOFLIP: 1 }, trans: 1.6, roughness: 0.7 }),
      flat: foliageMaterial({ map: atlas, noise, key: 'flat', a2c, defines: { FOL_CARDS: 1, FOL_UPNORMAL: 1, FOL_NOFLIP: 1 }, trans: 0.4, roughness: 0.55 }),
      leaves: foliageMaterial({ map: atlas, noise, key: 'leaves', a2c, defines: { FOL_TREE: 1, FOL_NOFLIP: 1 }, trans: 2.0, roughness: 0.62 }),
      wood: foliageMaterial({ map: bark.a, noise, key: 'wood', defines: { FOL_TREE: 1 }, trans: 0, roughness: 0.95, side: THREE.FrontSide, cutout: false }),
    };
    this.mats.wood.map.wrapS = this.mats.wood.map.wrapT = THREE.RepeatWrapping;
    this.sets = {
      grass: new CardSet(quadGeo('tuft'), this.mats.grass, { chunk: 30, maxDist: 135 }),
      shrub: new CardSet(quadGeo('tuft'), this.mats.shrub, { chunk: 68, maxDist: 220, castShadow: true }),
      wall: new CardSet(quadGeo('card'), this.mats.wall, { chunk: 84, maxDist: 320, castShadow: true }),
      hang: new CardSet(quadGeo('hang'), this.mats.hang, { chunk: 84, maxDist: 260, castShadow: true }),
      flat: new CardSet(quadGeo('flat'), this.mats.flat, { chunk: 84, maxDist: 200 }),
    };
    this.trees = [];           // { x, z, y, r (crown radius), species }
    this.treeMeshes = [];
    this.rng = makeRng(3107);
  }

  // How much open sky a spot on the ground has, for dimming the ambient on what grows there.
  skyAt(x, z) {
    const w = this.world, y = w.heightAt(x, z) + 0.4;
    let open = 0;
    for (const d of SKY_DIRS) if (!w.solids.occluded(x, y, z, d[0], d[1], d[2], 26, SOLID.AO)) open++;
    return clamp(0.25 + 0.75 * (open / SKY_DIRS.length) * this.canopyAt(x, z), 0, 1);
  }
  // Shade cast on the ambient light by tree crowns, baked to a coarse grid.
  _bakeCanopy() {
    const c = 2, x0 = BOUNDS.x0 - 40, z0 = BOUNDS.z0 - 40, w = Math.ceil((BOUNDS.x1 - BOUNDS.x0 + 80) / c), h = Math.ceil((BOUNDS.z1 - BOUNDS.z0 + 80) / c);
    const g = new Float32Array(w * h).fill(1);
    for (const t of this.trees) {
      const i0 = Math.max(0, Math.floor((t.x - t.r - x0) / c)), i1 = Math.min(w - 1, Math.ceil((t.x + t.r - x0) / c));
      const j0 = Math.max(0, Math.floor((t.z - t.r - z0) / c)), j1 = Math.min(h - 1, Math.ceil((t.z + t.r - z0) / c));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const d = Math.hypot(x0 + i * c - t.x, z0 + j * c - t.z);
        if (d < t.r) g[j * w + i] *= 1 - 0.55 * smoothstep(t.r, t.r * 0.35, d);
      }
    }
    this.canopy = { g, x0, z0, w, h, c };
  }
  canopyAt(x, z) {
    const C = this.canopy; if (!C) return 1;
    const i = Math.round((x - C.x0) / C.c), j = Math.round((z - C.z0) / C.c);
    return (i < 0 || j < 0 || i >= C.w || j >= C.h) ? 1 : C.g[j * C.w + i];
  }
  // Darken the baked ambient on the ground itself wherever a crown hangs over it.
  shadeGround(mesh) {
    const P = mesh.geometry.attributes.position, S = mesh.geometry.attributes.aSurf;
    for (let i = 0; i < P.count; i++) S.setX(i, S.getX(i) * this.canopyAt(P.getX(i), P.getZ(i)));
    S.needsUpdate = true;
  }

  // ---- trees ----
  _plantTrees() {
    const w = this.world, rng = this.rng, spots = [];
    const free = (x, z, r) => {
      if (w.inPool(x, z)) return false;
      for (const h of w.holes) if (x > h.x0 - r && x < h.x1 + r && z > h.z0 - r && z < h.z1 + r) return false;
      if (w.solids.blocksWalker(x, z, r, -1, 30, SOLID.MOVE)) return false;
      for (const s of spots) if (Math.hypot(s.x - x, s.z - z) < (s.r + r) * 0.75) return false;
      return true;
    };
    const put = (species, x, z, scale = 1, yaw = rng.range(0, TAU), variant = rng.int(0, 1), y = null, detail = 0) => spots.push({ species, x, z, y: y === null ? w.heightAt(x, z) : y, scale, yaw, variant: detail ? 0 : variant, r: species === 'banyan' ? 3.2 * scale : 1.1 * scale, detail });
    // the great banyans, set where they compose with the buildings
    put('banyan', -40, 46, 1.15, 0.4, 0); put('banyan', 60, -60, 1.0, 2.1, 1); put('banyan', -54, -52, 0.95, 4.0, 0);
    put('banyan', 24, 98, 1.1, 1.2, 1); put('banyan', -106, 76, 1.25, 5.1, 0); put('banyan', 124, 84, 1.05, 3.3, 1); put('banyan', -18, -104, 1.0, 0.9, 1);
    put('banyan', 150, -92, 1.1, 2.6, 0);
    // peepal and neem through the meadows, the odd one up through the paving
    let tries = 0;
    while (spots.length < Math.round(8 + 52 * this.q.trees) && tries++ < 4000) {
      const x = rng.range(BOUNDS.x0 + 6, BOUNDS.x1 - 6), z = rng.range(BOUNDS.z0 + 6, BOUNDS.z1 - 6), g = w.growAt(x, z);
      if (g < 0.55 && rng() > 0.035) continue;
      if (Math.abs(x) < 14 && z > 56) continue;                 // keep the road in clear
      if (!free(x, z, 2.5)) continue;
      const r = rng();
      put(r < 0.45 ? 'peepal' : r < 0.9 ? 'neem' : 'snag', x, z, rng.range(0.8, 1.25));
    }
    // the wooded bank that closes the complex in
    const ring = (inset, step, detail) => {
      const per = 2 * ((BOUNDS.x1 - BOUNDS.x0) + (BOUNDS.z1 - BOUNDS.z0) + 8 * inset);
      for (let s = 0; s < per; s += step * rng.range(0.7, 1.3)) {
        const W = BOUNDS.x1 - BOUNDS.x0 + 2 * inset, H = BOUNDS.z1 - BOUNDS.z0 + 2 * inset;
        let x, z; const t = s % (2 * (W + H));
        if (t < W) { x = BOUNDS.x0 - inset + t; z = BOUNDS.z0 - inset; } else if (t < W + H) { x = BOUNDS.x1 + inset; z = BOUNDS.z0 - inset + (t - W); }
        else if (t < 2 * W + H) { x = BOUNDS.x1 + inset - (t - W - H); z = BOUNDS.z1 + inset; } else { x = BOUNDS.x0 - inset; z = BOUNDS.z1 + inset - (t - 2 * W - H); }
        x += rng.range(-4, 4); z += rng.range(-4, 4);
        if (Math.abs(x) < 9 && z > 100) continue;               // the gap the road came through
        const r = rng();
        put(r < 0.1 ? 'banyan' : r < 0.55 ? 'neem' : 'peepal', x, z, rng.range(1.0, 1.5), undefined, undefined, undefined, detail);
      }
    };
    ring(5, 12, 1); ring(17, 16, 2); ring(32, 22, 2);
    // seedlings on ledges and roofs: (x, y, z)
    for (const [x, y, z] of [[-100, 15.55, -20], [-94, 15.55, 24], [-140, 15.55, 30], [-118, 15.55, 0], [108, 22.2, -40], [126, 22.2, 12], [140, 22.2, 44], [100, 22.2, 30], [-10, 12.95, -12], [-20, 12.95, 0],
      [-243, 41, -30], [-243, 41, 40], [-243, 41, 90], [-243, 28.7, -70], [44, 2.9, -1.7], [57.7, 2.9, 12], [-80, 17.6, -20], [-76, 17.2, 14]]) put('sapling', x, z, rng.range(0.9, 2.2), undefined, undefined, y);
    return spots;
  }

  _buildTrees(spots) {
    const variants = new Map();
    const get = (species, v, detail) => {
      const k = species + v + 'd' + detail;
      // on the lightest preset even the near trees are grown the cheap way: boughs and fewer, larger leaf cards
      if (!variants.has(k)) variants.set(k, { tree: growTree(species, 7919 * (v + 1) + species.length * 31, species === 'sapling' ? detail : Math.max(detail, this.q.treeDetail || 0)), spots: [], detail });
      return variants.get(k);
    };
    for (const s of spots) {
      const V = get(s.species, s.variant, s.detail);
      V.spots.push(s);
      const T = V.tree;
      if (s.species !== 'sapling') this.trees.push({ x: s.x, z: s.z, y: s.y, r: T.crownR * s.scale, species: s.species });
      if (s.detail < 2 && s.species !== 'sapling') for (const c of T.colliders) {
        const cs = Math.cos(s.yaw), sn = Math.sin(s.yaw);
        const id = this.world.solids.addCyl(s.x + (cs * c.x + sn * c.z) * s.scale, s.z + (-sn * c.x + cs * c.z) * s.scale, c.r * s.scale, s.y - 1, s.y + c.h * s.scale, SOLID.MOVE | SOLID.SHOT | SOLID.NAV, SURF.wood);
        this.world.solids.addLate(id);
      }
    }
    // group instances regionally so each batch can be culled on its own
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    for (const V of variants.values()) {
      const regions = new Map();
      const cell = V.detail ? 420 : 150;
      for (const s of V.spots) { const k = Math.floor((s.x + 400) / cell) + ',' + Math.floor((s.z + 400) / cell); if (!regions.has(k)) regions.set(k, []); regions.get(k).push(s); }
      for (const list of regions.values()) {
        for (const part of ['wood', 'leaves']) {
          const geo = V.tree[part]; if (!geo) continue;
          const im = new THREE.InstancedMesh(geo, part === 'wood' ? this.mats.wood : this.mats.leaves, list.length);
          list.forEach((s, i) => { q.setFromAxisAngle(UP, s.yaw); sc.setScalar(s.scale); p.set(s.x, s.y, s.z); m4.compose(p, q, sc); im.setMatrixAt(i, m4); });
          im.instanceMatrix.needsUpdate = true;
          im.customDepthMaterial = (part === 'wood' ? this.mats.wood : this.mats.leaves).userData.depth;
          im.castShadow = V.detail === 0 && (part === 'leaves' || this.q.trunkShadows); im.receiveShadow = true; im.matrixAutoUpdate = false;
          im.computeBoundingSphere();
          this.group.add(im); this.treeMeshes.push(im);
        }
      }
    }
  }

  // ---- everything smaller ----
  _sowMeadow() {
    const w = this.world, rng = this.rng, G = this.sets.grass, Sh = this.sets.shrub;
    const T = { grass: tileIndex('grass'), dry: tileIndex('grassDry'), kans: tileIndex('kans'), weeds: tileIndex('weeds'), fern: tileIndex('fern'), bush: tileIndex('bush'), reed: tileIndex('reed'), litter: tileIndex('litter') };
    const step = 1.02 / Math.sqrt(this.q.grass);
    const tint = [0, 0, 0];
    for (let z = BOUNDS.z0 - 20; z < BOUNDS.z1 + 20; z += step) for (let x = BOUNDS.x0 - 20; x < BOUNDS.x1 + 20; x += step) {
      const px = x + rng.range(-0.5, 0.5) * step, pz = z + rng.range(-0.5, 0.5) * step;
      const g = w.growAt(px, pz);
      if (g < 0.1) continue;
      const dens = g < 0.45 ? (g - 0.1) * 0.9 : 0.32 + (g - 0.45) * 1.25;        // thin in the cracks, thick in the open
      if (rng() > dens) continue;
      if (w.inPool(px, pz)) continue;
      let hole = false; for (const h of w.holes) if (px > h.x0 - 0.3 && px < h.x1 + 0.3 && pz > h.z0 - 0.3 && pz < h.z1 + 0.3) { hole = true; break; }
      if (hole) continue;
      const y = w.heightAt(px, pz);
      if (w.solids.blocksWalker(px, pz, 0.25, y + 0.05, y + 0.6, SOLID.MOVE)) continue;
      const sky = this.skyAt(px, pz);
      // patches: the same slow noise decides where the tall cane grass stands and where the turf has dried
      const patch = fbm2(px * 0.02 + 40, pz * 0.02 + 7, 3), dry = fbm2(px * 0.05 + 3, pz * 0.05 + 90, 2);
      const v = 0.78 + 0.34 * noise2(px * 0.15, pz * 0.15);
      tint[0] = v * (0.92 + 0.2 * dry); tint[1] = v; tint[2] = v * (0.86 + 0.1 * patch);
      if (g > 0.6 && patch > 0.6 && rng() < 0.3 && sky > 0.7) {
        const s = rng.range(2.3, 3.5); G.add(px, y - 0.06, pz, rng.range(0, TAU), s, s, T.kans, tint, sky);
      } else if (sky < 0.62 && rng() < 0.45) {
        const s = rng.range(0.8, 1.5); G.add(px, y - 0.04, pz, rng.range(0, TAU), s, s, T.fern, tint, sky);       // ferns keep to the shade
      } else if (g < 0.4) {
        const s = rng.range(0.45, 0.85); G.add(px, y - 0.03, pz, rng.range(0, TAU), s * 1.2, s, rng() < 0.6 ? T.weeds : T.grass, tint, sky);
      } else {
        const s = rng.range(0.75, 1.35) * (0.8 + 0.4 * g);
        G.add(px, y - 0.05, pz, rng.range(0, TAU), s * 1.25, s, dry > 0.56 ? T.dry : T.grass, tint, sky);
      }
    }
    // lantana thickets and leaf litter
    const nb = Math.round(520 * this.q.trees);
    for (let i = 0, tries = 0; i < nb && tries < nb * 12; tries++) {
      const px = rng.range(BOUNDS.x0 - 14, BOUNDS.x1 + 14), pz = rng.range(BOUNDS.z0 - 14, BOUNDS.z1 + 14), g = w.growAt(px, pz);
      if (g < 0.7 || w.inPool(px, pz)) continue;
      const y = w.heightAt(px, pz);
      if (w.solids.blocksWalker(px, pz, 0.6, y + 0.05, y + 1.2, SOLID.MOVE)) continue;
      const s = rng.range(1.5, 3.1), v = rng.range(0.75, 1.0);
      Sh.add(px, y - 0.1, pz, rng.range(0, TAU), s * 1.25, s, T.bush, [v, v, v * 0.95], this.skyAt(px, pz)); i++;
    }
    // reeds and lotus on the pools
    const F = this.sets.flat, lily = tileIndex('lily');
    for (const p of w.pools) {
      const area = (p.x1 - p.x0) * (p.z1 - p.z0);
      for (let i = 0; i < area * 0.055; i++) { const s = rng.range(1.6, 3.4); F.add(rng.range(p.x0 + 1, p.x1 - 1), p.level + 0.015, rng.range(p.z0 + 1, p.z1 - 1), rng.range(0, TAU), s, s, lily, [1, 1, 1], 1); }
      const per = 2 * (p.x1 - p.x0 + p.z1 - p.z0);
      for (let i = 0; i < per * 0.7; i++) {
        const t = rng.range(0, per), W = p.x1 - p.x0, H = p.z1 - p.z0, in_ = rng.range(0.3, 1.6);
        let x, z; if (t < W) { x = p.x0 + t; z = p.z0 + in_; } else if (t < W + H) { x = p.x1 - in_; z = p.z0 + t - W; } else if (t < 2 * W + H) { x = p.x0 + t - W - H; z = p.z1 - in_; } else { x = p.x0 + in_; z = p.z0 + t - 2 * W - H; }
        const s = rng.range(1.3, 2.3); G.add(x, p.level - 0.25, z, rng.range(0, TAU), s, s, T.reed, [0.95, 1, 0.9], 1);
      }
    }
  }

  // Creepers up the walls, bougainvillea over parapets, curtains hanging from the great roofs.
  _drape() {
    const rng = this.rng, W = this.sets.wall, H = this.sets.hang;
    const T = { creeper: tileIndex('creeper'), thin: tileIndex('creeperThin'), boug: tileIndex('bougain'), vine: tileIndex('vine'), peepal: tileIndex('peepal') };
    // a panel of wall: face is the way it looks; cover falls off with height from `dense` at the foot
    const panel = (face, at, a0, a1, y0, y1, dense, { boug = 0, top = false } = {}) => {
      const ax = face[0], dir = face[1] === '+' ? 1 : -1, yaw = ax === 'x' ? (dir > 0 ? Math.PI / 2 : -Math.PI / 2) : (dir > 0 ? 0 : Math.PI);
      const n = Math.round((a1 - a0) * (y1 - y0) * dense * 0.2);
      for (let i = 0; i < n; i++) {
        const a = rng.range(a0, a1), t = top ? 1 - Math.pow(rng(), 1.8) : Math.pow(rng(), 1.8), y = y0 + (y1 - y0) * t;
        const s = rng.range(1.5, 2.7), off = rng.range(0.05, 0.22);
        const isB = rng() < boug, tile = isB ? T.boug : (t > 0.7 !== top ? T.thin : T.creeper), v = rng.range(0.7, 1.0);
        const px = ax === 'x' ? at + dir * off : a, pz = ax === 'x' ? a : at + dir * off;
        W.add(px, y - s / 2, pz, yaw + rng.range(-0.25, 0.25), s, s, tile, isB ? [1, 1, 1] : [v * 0.92, v, v * 0.88], 0.85);
      }
    };
    // hanging strands along an edge
    const curtain = (ax, at, a0, a1, y, dense, len = [2.5, 6]) => {
      for (let a = a0; a < a1; a += rng.range(0.5, 1.6) / dense) {
        const L = rng.range(...len), wdt = L * 0.5, v = rng.range(0.7, 1.0);
        H.add(ax === 'x' ? at + rng.range(-0.15, 0.15) : a, y, ax === 'x' ? a : at + rng.range(-0.15, 0.15), ax === 'x' ? Math.PI / 2 : 0, wdt, L, T.vine, [v * 0.9, v, v * 0.85], 0.9);
      }
    };
    // High Court: the piers, the courtroom fronts, strands from the parasol
    for (const z of [-32.6, -26, -19.4]) { panel('x-', 97.6, z - 1.1, z + 1.1, 0.4, 13, 1.5); panel('z+', z + 1.15, 98, 112, 0.4, 9, 0.9); panel('z-', z - 1.15, 98, 112, 0.4, 9, 0.9); }
    panel('x-', 103.6, -14, 52, 0.4, 15.5, 0.75, { boug: 0.22 }); panel('x-', 103.6, -52, -38, 0.4, 15.5, 0.9);
    panel('x-', 103.6, 20, 52, 6, 15.5, 0.9, { top: true, boug: 0.3 });
    curtain('x', 93, -55, 55, 18.7, 0.8, [2.5, 7.5]); curtain('z', -55, 94, 152, 18.7, 0.5); curtain('z', 55, 94, 152, 18.7, 0.5);
    // Assembly: the portico blades, strands from the trough's lip, the side fronts and the breach
    for (let z = -28; z <= 28; z += 8) { panel('z+', z + 0.45, -90.6, -78.8, 0.45, 9, 0.8); panel('z-', z - 0.45, -90.6, -78.8, 0.45, 9, 0.8); }
    curtain('x', -73.4, -35, 35, 17.6, 0.9, [3, 8]); curtain('x', -94.2, -35, 35, 16.4, 0.4, [1.5, 4]);
    panel('z+', 33.9, -152, -92, 0.45, 15, 0.7, { boug: 0.18 }); panel('z-', -33.9, -152, -92, 0.45, 15, 0.8);
    panel('x-', -154.2, -32, 32, 0.45, 15, 0.6);
    panel('x+', -92, -32, -4, 0.45, 15, 0.45); panel('x+', -92, 4, 32, 0.45, 15, 0.45);
    // Tower of Shadows
    panel('z+', 3.7, -22, -6, 2.9, 12.6, 0.8, { boug: 0.25 }); panel('x+', -4.5, -14, 2, 2.9, 12.6, 0.7); panel('x-', -23.9, -14, 2, 2.9, 12.6, 0.8);
    curtain('z', -14, -22, -6, 12.6, 0.8, [2, 6]); curtain('x', -22, -14, 2, 8.4, 0.5, [1.5, 3.5]);
    // Open Hand court, Memorial, the hill's retaining wall, pool kerbs
    panel('z+', -98, 12, 48, -3.6, 0, 1.2); panel('x+', 12, -98, -62, -3.6, 0, 0.9); panel('x-', 48, -98, -62, -3.6, 0, 0.9); panel('z-', -62, 18.4, 48, -3.6, 0, 1.0);
    panel('z-', -98.5, 11.5, 48.5, 0, 1.0, 1.5, { boug: 0.4 }); panel('z+', -61.5, 18.4, 48.5, 0, 1.0, 1.5, { boug: 0.3 });
    panel('z+', -2 + 0.5, 38, 58, 0, 2.9, 0.9); panel('z-', -2, 38, 58, 0, 2.9, 1.2, { boug: 0.35 }); panel('x+', 58, -2, 18, 0, 2.9, 1.2); panel('x-', 38, -2, 18, 0, 2.9, 1.0, { boug: 0.2 });
    panel('x+', 32, 31, 49, 0, 1.9, 1.3, { boug: 0.3 });
    panel('z+', 30.5, -74, -60, 0, 0.5, 2); panel('z-', -30.5, -74, -60, 0, 0.5, 2);
    // Secretariat: green from the roofline down, as far as the eye can make out
    panel('x+', -241.5, -124, 124, 0, 41, 0.07);
  }

  build() {
    const spots = this._plantTrees();
    this._buildTrees(spots);
    this._bakeCanopy();
    const ground = this.world.meshes.find(m => m.name === 'ground|ground');
    if (ground) this.shadeGround(ground);
    this._sowMeadow();
    this._drape();
    for (const s of Object.values(this.sets)) s.build(this.group);
    return this;
  }

  update(camPos) { for (const s of Object.values(this.sets)) s.cull(camPos); }

  get stats() { const o = { trees: this.trees.length }; for (const [k, s] of Object.entries(this.sets)) o[k] = s.count; return o; }
}
