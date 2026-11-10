// The infected.
//
// Sixty years on, what is left of Chandigarh's people belongs to the Bloom: a
// growth that keeps its hosts standing, turns them to face the sun by day like
// so many sunflowers, and walks them at night. Each one here is a skinned
// figure generated in code (no models are downloaded) and moved by procedural
// animation: a gait driven by distance covered, springs for flinches, and a
// handful of target poses the bones ease between.
import { THREE } from './lib/three.js';
import { GU } from './shared.js';
import { patch } from './materials.js';
import { SOLID } from './physics.js';
import { makeRng, clamp, lerp, damp, dampAngle, angleDelta, TAU, smoothstep } from './util.js';

const HIPS = 0, SPINE = 1, CHEST = 2, NECK = 3, HEAD = 4, ARM_L = 5, FORE_L = 6, HAND_L = 7, ARM_R = 8, FORE_R = 9, HAND_R = 10,
  THIGH_L = 11, SHIN_L = 12, FOOT_L = 13, THIGH_R = 14, SHIN_R = 15, FOOT_R = 16, NB = 17;
// rest positions of the joints, figure facing +Z, its left hand on +X
const REST = [[0, 0.95, 0], [0, 1.1, 0], [0, 1.28, 0], [0, 1.48, 0.01], [0, 1.56, 0.02],
  [0.19, 1.43, 0], [0.235, 1.17, 0], [0.28, 0.89, 0.02], [-0.19, 1.43, 0], [-0.235, 1.17, 0], [-0.28, 0.89, 0.02],
  [0.095, 0.93, 0], [0.1, 0.5, 0.01], [0.1, 0.08, 0], [-0.095, 0.93, 0], [-0.1, 0.5, 0.01], [-0.1, 0.08, 0]];
const PARENT = [-1, 0, 1, 2, 3, 2, 5, 6, 2, 8, 9, 0, 11, 12, 0, 14, 15];

export const KINDS = {
  walker: { hp: 90, speed: 1.35, damage: 12, reach: 1.5, turn: 2.8, scale: 1.0, head: 3.6, score: 10 },
  runner: { hp: 55, speed: 4.7, damage: 9, reach: 1.45, turn: 5.0, scale: 0.97, head: 3.6, score: 20 },
  brute: { hp: 440, speed: 2.0, damage: 27, reach: 1.95, turn: 2.2, scale: 1.24, head: 2.2, score: 60 },
};

const SKIN = [[0.2, 0.21, 0.16], [0.25, 0.22, 0.17], [0.16, 0.18, 0.15], [0.22, 0.18, 0.14], [0.19, 0.22, 0.2]];
const SHIRT = [[0.42, 0.4, 0.34], [0.26, 0.22, 0.13], [0.1, 0.17, 0.26], [0.22, 0.06, 0.06], [0.12, 0.15, 0.08], [0.2, 0.2, 0.2], [0.4, 0.17, 0.04], [0.28, 0.33, 0.26], [0.035, 0.035, 0.04], [0.3, 0.12, 0.2]];
const PANTS = [[0.05, 0.05, 0.055], [0.22, 0.19, 0.12], [0.03, 0.03, 0.035], [0.05, 0.07, 0.12], [0.36, 0.34, 0.3], [0.1, 0.1, 0.09]];
const BLOOD = [0.14, 0.012, 0.01], MOSS = [0.045, 0.085, 0.03];

// Build one body as a skinned mesh geometry. kind sets the build; seed sets everything else.
function buildBody(kind, seed) {
  const rng = makeRng(seed);
  const P = [], C = [], SI = [], SW = [], G = [], I = [];
  const big = kind === 'brute' ? 1.28 : kind === 'runner' ? 0.9 : rng.range(0.94, 1.1);
  const belly = kind === 'brute' ? 1.3 : kind === 'runner' ? 0.9 : rng.range(0.92, 1.22);
  const limb = kind === 'brute' ? 1.3 : kind === 'runner' ? 0.88 : rng.range(0.95, 1.08);
  const skin = rng.pick(SKIN), shirt = rng.pick(SHIRT), pants = rng.pick(PANTS);
  const longSleeve = rng() < 0.35, kurta = kind !== 'brute' && rng() < 0.3, barefoot = rng() < 0.4, bareChest = kind === 'brute' && rng() < 0.5;
  const shoe = barefoot ? skin : [0.03, 0.028, 0.025];
  const bloodAmt = rng.range(0.15, 0.7), mossAmt = rng.range(0.1, 0.55), mossSide = rng.range(0, TAU);
  const vary = (c, k = 0.12) => { const f = 1 + rng.range(-k, k); return [c[0] * f, c[1] * f, c[2] * f]; };

  const push = (x, y, z, col, bones, glow = 0) => {
    P.push(x, y, z); C.push(col[0], col[1], col[2]);
    SI.push(bones[0][0], bones.length > 1 ? bones[1][0] : 0, 0, 0); SW.push(bones[0][1], bones.length > 1 ? bones[1][1] : 0, 0, 0);
    G.push(glow); return P.length / 3 - 1;
  };
  // growth: patches of moss on whatever faces up or lies on the favoured side, some of it faintly luminous
  const weather = (col, a, y, cloth) => {
    let c = vary(col);
    const m = (0.5 + 0.5 * Math.cos(a - mossSide)) * mossAmt + (y > 1.38 ? 0.18 : 0);
    let glow = 0;
    if (rng() < m * 0.75) { c = vary(MOSS, 0.25); if (rng() < 0.3) glow = 0.5; }
    else if (!cloth && rng() < 0.08) c = vary(BLOOD, 0.2);
    return [c, glow];
  };
  // a ring of n points in the plane of U and V about centre c; rings are later joined along V x U
  const ring = (c, U, V, ru, rv, n, col, bones, cloth = false, fn = null) => {
    const base = P.length / 3;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU; let u = Math.cos(a) * ru, v = Math.sin(a) * rv;
      const x = c[0] + U[0] * u + V[0] * v, y = c[1] + U[1] * u + V[1] * v, z = c[2] + U[2] * u + V[2] * v;
      let [cc, glow] = weather(col, a, y, cloth);
      const out = fn ? fn(a, cc, x, y, z) : null;
      if (out) { cc = out.col || cc; push(x + (out.dx || 0), y, z + (out.dz || 0), cc, bones, out.glow ?? glow); }
      else push(x, y, z, cc, bones, glow);
    }
    return base;
  };
  const join = (r0, r1, n) => { for (let k = 0; k < n; k++) { const a = r0 + k, b = r0 + (k + 1) % n, c = r1 + k, d = r1 + (k + 1) % n; I.push(a, c, b, b, c, d); } };
  const cap = (r, n, c, col, bones, up) => { const ci = push(c[0], c[1], c[2], col, bones); for (let k = 0; k < n; k++) { const a = r + k, b = r + (k + 1) % n; if (up) I.push(a, ci, b); else I.push(a, b, ci); } };
  const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];
  const tube = (rings, n, capTop = null, capBottom = null) => {
    let prev = -1, first = -1;
    for (const r of rings) { const cur = ring(r.c, r.U || X, r.V || Z, r.ru, r.rv, n, r.col, r.bones, r.cloth, r.fn); if (prev >= 0 && !r.gap) join(prev, cur, n); if (first < 0) first = cur; prev = cur; }
    if (capBottom) cap(first, n, capBottom.c, capBottom.col, rings[0].bones, false);
    if (capTop) cap(prev, n, capTop.c, capTop.col, rings[rings.length - 1].bones, true);
  };

  // --- torso
  const top = bareChest ? skin : shirt, w = big;
  const bloodFront = (a, cc, x, y) => (Math.abs(a - Math.PI / 2) < 0.9 && rng() < bloodAmt * (y > 1.2 ? 0.8 : 0.3) ? { col: vary(BLOOD, 0.25) } : null);
  const T = [
    { c: [0, 0.86, 0], ru: 0.13 * w, rv: 0.1 * w, col: pants, bones: [[HIPS, 1]], cloth: true },
    { c: [0, 0.93, 0], ru: 0.165 * w * belly ** 0.3, rv: 0.11 * w * belly ** 0.5, col: pants, bones: [[HIPS, 1]], cloth: true },
    { c: [0, 0.925, 0], ru: 0.178 * w * belly ** 0.4, rv: 0.123 * w * belly ** 0.6, col: top, bones: [[HIPS, 1]], cloth: !bareChest },        // the hem hangs over the belt
    { c: [0, 1.0, 0.01 * belly], ru: 0.165 * w * belly ** 0.5, rv: 0.115 * w * belly, col: top, bones: [[HIPS, 0.65], [SPINE, 0.35]], cloth: !bareChest, fn: bloodFront },
    { c: [0, 1.08, 0.012 * belly], ru: 0.148 * w * belly ** 0.6, rv: 0.105 * w * belly, col: top, bones: [[SPINE, 0.8], [HIPS, 0.2]], cloth: !bareChest, fn: bloodFront },
    { c: [0, 1.18, 0.005], ru: 0.155 * w, rv: 0.105 * w, col: top, bones: [[SPINE, 0.5], [CHEST, 0.5]], cloth: !bareChest, fn: bloodFront },
    { c: [0, 1.3, 0], ru: 0.178 * w, rv: 0.118 * w, col: top, bones: [[CHEST, 1]], cloth: !bareChest, fn: bloodFront },
    { c: [0, 1.4, -0.005], ru: 0.19 * w, rv: 0.108 * w, col: top, bones: [[CHEST, 1]], cloth: !bareChest, fn: bloodFront },
    { c: [0, 1.455, 0], ru: 0.125 * w, rv: 0.088 * w, col: top, bones: [[CHEST, 0.7], [NECK, 0.3]], cloth: !bareChest },
    { c: [0, 1.49, 0.005], ru: 0.06, rv: 0.06, col: skin, bones: [[NECK, 1]] },
    { c: [0, 1.555, 0.012], ru: 0.054, rv: 0.056, col: skin, bones: [[NECK, 0.6], [HEAD, 0.4]] },
  ];
  // what is left when the head is gone
  tube(T, 14, { c: [0, 1.56, 0.012], col: BLOOD }, { c: [0, 0.84, 0], col: pants });
  if (kurta) tube([
    { c: [0, 0.93, 0], ru: 0.182 * w, rv: 0.128 * w * belly ** 0.5, col: shirt, bones: [[HIPS, 1]], cloth: true },
    { c: [0, 0.78, 0], ru: 0.2 * w, rv: 0.14 * w, col: shirt, bones: [[HIPS, 0.8], [THIGH_L, 0.2]], cloth: true },
    { c: [0, 0.62, 0], ru: 0.215 * w, rv: 0.15 * w, col: shirt, bones: [[HIPS, 0.7], [THIGH_R, 0.3]], cloth: true },
  ].reverse(), 14);

  // --- head: sockets, a slack mouth, the nose pushed out a little
  const hs = kind === 'brute' ? 1.06 : 1;
  const face = (a, cc, x, y) => {
    const f = a - Math.PI / 2;
    if (y > 1.66 && y < 1.69 && (Math.abs(f - 0.45) < 0.24 || Math.abs(f + 0.45) < 0.24)) return { col: [0.012, 0.01, 0.01] };
    if (y > 1.59 && y < 1.615 && Math.abs(f) < 0.5) return { col: [0.05, 0.008, 0.008] };
    if (y > 1.62 && y < 1.66 && Math.abs(f) < 0.3) return { dz: 0.014 };
    if (y < 1.6 && Math.abs(f) < 1.0 && rng() < bloodAmt) return { col: vary(BLOOD, 0.25) };
    return null;
  };
  const hb = [[HEAD, 1]];
  tube([
    { c: [0, 1.553, 0.03], ru: 0.046 * hs, rv: 0.056 * hs, col: skin, bones: hb, fn: face },
    { c: [0, 1.6, 0.022], ru: 0.067 * hs, rv: 0.08 * hs, col: skin, bones: hb, fn: face },
    { c: [0, 1.64, 0.016], ru: 0.074 * hs, rv: 0.093 * hs, col: skin, bones: hb, fn: face },
    { c: [0, 1.675, 0.014], ru: 0.076 * hs, rv: 0.096 * hs, col: skin, bones: hb, fn: face },
    { c: [0, 1.71, 0.01], ru: 0.075 * hs, rv: 0.097 * hs, col: skin, bones: hb },
    { c: [0, 1.75, 0.005], ru: 0.066 * hs, rv: 0.088 * hs, col: rng() < 0.6 ? [0.03, 0.028, 0.025] : skin, bones: hb },
    { c: [0, 1.782, 0], ru: 0.044 * hs, rv: 0.06 * hs, col: [0.03, 0.028, 0.025], bones: hb },
  ], 14, { c: [0, 1.8, 0], col: [0.03, 0.028, 0.025] }, { c: [0, 1.548, 0.03], col: skin });
  // eyes: two pale points that pick up the light after dark
  for (const s of [-1, 1]) {
    const ex = s * 0.032 * hs, ey = 1.676, ez = 0.107 * hs, e = 0.011, col = [0.75, 0.72, 0.5];
    const a = push(ex - e, ey - e, ez, col, hb, 1), b = push(ex + e, ey - e, ez, col, hb, 1), c = push(ex + e, ey + e, ez, col, hb, 1), d = push(ex - e, ey + e, ez, col, hb, 1);
    I.push(a, b, c, a, c, d);
  }

  // --- arms and hands, built wrist to shoulder
  for (const s of [1, -1]) {
    const A = s > 0 ? ARM_L : ARM_R, F = s > 0 ? FORE_L : FORE_R, H = s > 0 ? HAND_L : HAND_R, r = limb;
    const sleeve = longSleeve ? 0.95 : 1.26, cl = y => (y >= sleeve && !bareChest ? shirt : skin);
    const handBlood = (a, cc) => (rng() < bloodAmt * 0.8 ? { col: vary(BLOOD, 0.25) } : null);
    tube([
      { c: [0.292 * s, 0.725, 0.035], ru: 0.012, rv: 0.02, col: skin, bones: [[H, 1]], fn: handBlood },
      { c: [0.29 * s, 0.78, 0.03], ru: 0.017, rv: 0.04 * r, col: skin, bones: [[H, 1]], fn: handBlood },
      { c: [0.288 * s, 0.84, 0.024], ru: 0.02, rv: 0.044 * r, col: skin, bones: [[H, 1]], fn: handBlood },
      { c: [0.282 * s, 0.888, 0.02], ru: 0.027 * r, rv: 0.031 * r, col: skin, bones: [[H, 0.6], [F, 0.4]] },
      { c: [0.272 * s, 0.94, 0.015], ru: 0.033 * r, rv: 0.035 * r, col: cl(0.94), bones: [[F, 1]], cloth: longSleeve },
      { c: [0.252 * s, 1.08, 0.005], ru: 0.044 * r, rv: 0.045 * r, col: cl(1.08), bones: [[F, 1]], cloth: longSleeve },
      { c: [0.236 * s, 1.17, 0], ru: 0.045 * r, rv: 0.046 * r, col: cl(1.17), bones: [[F, 0.5], [A, 0.5]], cloth: longSleeve },
      { c: [0.218 * s, 1.262, 0], ru: 0.05 * r, rv: 0.052 * r, col: cl(1.262), bones: [[A, 1]], cloth: true },
      { c: [0.216 * s, 1.26, 0], ru: 0.058 * r, rv: 0.06 * r, col: top, bones: [[A, 1]], cloth: !bareChest },                     // sleeve edge
      { c: [0.2 * s, 1.39, 0], ru: 0.062 * r, rv: 0.064 * r, col: top, bones: [[A, 1]], cloth: !bareChest },
      { c: [0.185 * s, 1.455, 0], ru: 0.05 * r, rv: 0.058 * r, col: top, bones: [[A, 0.55], [CHEST, 0.45]], cloth: !bareChest },
    ], 8, { c: [0.17 * s, 1.47, 0], col: top }, { c: [0.293 * s, 0.715, 0.036], col: skin });
  }

  // --- legs, ankle to hip, and feet
  for (const s of [1, -1]) {
    const TH = s > 0 ? THIGH_L : THIGH_R, SH = s > 0 ? SHIN_L : SHIN_R, FT = s > 0 ? FOOT_L : FOOT_R, r = limb;
    const torn = rng() < 0.3, cuff = torn ? rng.range(0.3, 0.52) : 0.13, pc = y => (y >= cuff ? pants : skin);
    tube([
      { c: [0.1 * s, 0.085, 0], ru: 0.036 * r, rv: 0.04 * r, col: pc(0.085), bones: [[SH, 0.5], [FT, 0.5]] },
      { c: [0.1 * s, 0.2, -0.004], ru: 0.041 * r, rv: 0.043 * r, col: pc(0.2), bones: [[SH, 1]], cloth: true },
      { c: [0.1 * s, 0.38, -0.012], ru: 0.056 * r, rv: 0.06 * r, col: pc(0.38), bones: [[SH, 1]], cloth: true },
      { c: [0.1 * s, 0.5, 0.008], ru: 0.057 * r, rv: 0.06 * r, col: pc(0.5), bones: [[SH, 0.5], [TH, 0.5]], cloth: true },
      { c: [0.1 * s, 0.62, 0.004], ru: 0.068 * r, rv: 0.072 * r, col: pants, bones: [[TH, 1]], cloth: true },
      { c: [0.098 * s, 0.8, 0], ru: 0.083 * r, rv: 0.088 * r, col: pants, bones: [[TH, 1]], cloth: true },
      { c: [0.094 * s, 0.9, 0], ru: 0.084 * r, rv: 0.092 * r, col: pants, bones: [[TH, 0.55], [HIPS, 0.45]], cloth: true },
    ], 10, { c: [0.09 * s, 0.94, 0], col: pants }, { c: [0.1 * s, 0.07, 0], col: pc(0.07) });
    const fb = [[FT, 1]];
    tube([
      { c: [0.1 * s, 0.045, -0.075], U: Y, V: X, ru: 0.034, rv: 0.036 * r, col: shoe, bones: fb },
      { c: [0.1 * s, 0.052, 0], U: Y, V: X, ru: 0.05, rv: 0.046 * r, col: shoe, bones: fb },
      { c: [0.1 * s, 0.04, 0.1], U: Y, V: X, ru: 0.038, rv: 0.05 * r, col: shoe, bones: fb },
      { c: [0.1 * s, 0.026, 0.19], U: Y, V: X, ru: 0.022, rv: 0.038 * r, col: shoe, bones: fb },
    ], 8, { c: [0.1 * s, 0.024, 0.205], col: shoe }, { c: [0.1 * s, 0.045, -0.09], col: shoe });
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(SI, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(SW, 4));
  g.setAttribute('aGlow', new THREE.Float32BufferAttribute(G, 1));
  g.setIndex(I); g.computeVertexNormals();
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 1.9);
  return g;
}

function makeMaterial(noise) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.84, metalness: 0 });
  return patch(mat, {
    key: 'infected', uniforms: { tNoise: { value: noise }, uNight: GU.uNight },
    vertPars: 'attribute float aGlow; varying float vGlow; varying vec3 vRest;',
    vertBegin: 'vGlow = aGlow; vRest = position;',
    fragPars: 'varying float vGlow; varying vec3 vRest; uniform sampler2D tNoise; uniform float uNight;',
    fragColor: /* glsl */`
      vec4 g1 = texture2D(tNoise, vRest.xy * 2.3 + vRest.z * 1.7), g2 = texture2D(tNoise, vRest.zy * 5.1 + 0.3);
      diffuseColor.rgb *= 0.6 + 0.66 * (g1.r * 0.6 + g2.g * 0.4);
      diffuseColor.rgb *= 0.93 + 0.07 * sin(vRest.y * 700.0) * sin((vRest.x - vRest.z) * 700.0);       // weave
      float bloodish = smoothstep(0.03, 0.0, diffuseColor.g) * step(diffuseColor.b * 3.0, diffuseColor.r);
    `,
    fragRough: 'roughnessFactor = mix(0.86, 0.38, bloodish);',
    fragEmissive: /* glsl */`
      totalEmissiveRadiance += vGlow > 0.9 ? vec3(0.9, 0.82, 0.5) * (0.03 + 0.42 * uNight)
        : vec3(0.08, 0.7, 0.4) * vGlow * (0.01 + 0.4 * uNight) * (0.65 + 0.35 * sin(uTime * 1.7 + vRest.y * 9.0 + vRest.x * 5.0));
    `,
  });
}

// ---------------------------------------------------------------------------
const DORMANT = 0, RISE = 1, CHASE = 2, ATTACK = 3, DYING = 4, DEAD = 5;
export const STATE = { DORMANT, RISE, CHASE, ATTACK, DYING, DEAD };
const _v = new THREE.Vector3(), _d = { x: 0, z: 0 }, _p2 = { x: 0, z: 0 };

class Infected {
  constructor(mesh, bones, index) {
    this.mesh = mesh; this.bones = bones; this.index = index;
    this.active = false;
    this.pos = new THREE.Vector3(); this.yaw = 0;
    this.pose = new Float32Array(NB * 3);       // eased bone angles
    this.target = new Float32Array(NB * 3);
    this.flinch = [0, 0, 0, 0];                 // pitch, yaw offsets and their velocities
  }
}

export class Horde {
  constructor(game, size = 56) {
    this.game = game; this.world = game.world; this.nav = game.nav;
    this.rng = makeRng(8128);
    this.material = makeMaterial(game.noise);
    this.variants = { walker: [], runner: [], brute: [] };
    for (let i = 0; i < 8; i++) this.variants.walker.push(buildBody('walker', 100 + i * 37));
    for (let i = 0; i < 3; i++) this.variants.runner.push(buildBody('runner', 900 + i * 53));
    for (let i = 0; i < 2; i++) this.variants.brute.push(buildBody('brute', 1700 + i * 71));
    this.group = new THREE.Group(); this.group.name = 'infected'; game.scene.add(this.group);
    this.all = [];
    for (let i = 0; i < size; i++) {
      const mesh = new THREE.SkinnedMesh(this.variants.walker[0], this.material);
      const bones = REST.map(() => new THREE.Bone());
      for (let b = 0; b < NB; b++) {
        const p = PARENT[b], r = REST[b];
        if (p < 0) { bones[b].position.set(r[0], r[1], r[2]); mesh.add(bones[b]); }
        else { bones[b].position.set(r[0] - REST[p][0], r[1] - REST[p][1], r[2] - REST[p][2]); bones[p].add(bones[b]); }
      }
      mesh.bind(new THREE.Skeleton(bones));
      mesh.castShadow = true; mesh.receiveShadow = true; mesh.visible = false; mesh.frustumCulled = true;
      mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 2.0);
      this.group.add(mesh);
      this.all.push(new Infected(mesh, bones, i));
    }
    this.alive = 0; this.killed = 0; this.headshots = 0;
    this.grid = new Map();                    // spatial hash for separation
    this.onKill = null; this.onHitPlayer = null;
    this.awakeAll = false;
    this.frame = 0;
    this.hit = { target: null, t: 0, part: '', px: 0, py: 0, pz: 0 };
  }

  get list() { return this.all; }
  countActive() { let n = 0; for (const z of this.all) if (z.active && z.state !== DYING && z.state !== DEAD) n++; return n; }

  spawn(kind, x, z, { dormant = false, rise = false, yaw = this.rng.range(0, TAU) } = {}) {
    let slot = null;
    for (const s of this.all) if (!s.active) { slot = s; break; }
    if (!slot) { let oldest = null; for (const s of this.all) if (s.state === DEAD && (!oldest || s.deadT > oldest.deadT)) oldest = s; slot = oldest; }   // recycle the longest dead
    if (!slot) return null;
    const K = KINDS[kind], rng = this.rng, s = slot;
    s.active = true; s.kind = kind; s.K = K; s.hp = K.hp;
    s.state = dormant ? DORMANT : rise ? RISE : CHASE; s.stateT = 0;
    s.pos.set(x, this.world.groundAt(x, z, this.world.heightAt(x, z) + 0.3, 0.5), z); s.yaw = yaw;
    s.speedK = rng.range(0.82, 1.18); s.limp = kind === 'walker' ? rng.range(0, 0.6) * (rng() < 0.6 ? 1 : 0) : 0; s.limpSide = rng() < 0.5 ? 1 : -1;
    s.arms = kind === 'runner' ? 2 : rng.int(0, 2);       // 0 reaching, 1 hanging, 2 one of each / flailing
    s.hunch = rng.range(0.18, 0.5); s.headRoll = rng.range(-0.3, 0.3); s.seed = rng.range(0, 100);
    s.phase = rng.range(0, TAU); s.move = 0; s.attackT = 0; s.cooldown = rng.range(0, 0.6); s.stagger = 0; s.slow = 0;
    s.deadT = 0; s.fall = 0; s.fallDir = 1; s.headless = false; s.wakeDelay = -1; s.sinceSeen = 0; s.groanT = rng.range(1, 7);
    s.vx = 0; s.vz = 0; s.stuck = 0; s.sink = 0; s.hipY = 0; s.hipZ = 0; s.direct = false; s.struck = false;
    s.flinch[0] = s.flinch[1] = s.flinch[2] = s.flinch[3] = 0;
    const V = this.variants[kind];
    s.mesh.geometry = V[rng.int(0, V.length - 1)];
    s.mesh.scale.setScalar(K.scale * rng.range(0.96, 1.05)); s.scale = s.mesh.scale.x;
    s.bones[HEAD].scale.setScalar(1);
    s.pose.fill(0); s.target.fill(0);
    s.mesh.visible = true;
    this._place(s, 0);
    return s;
  }

  clear() { for (const s of this.all) { s.active = false; s.mesh.visible = false; s.state = DEAD; } this.alive = 0; }

  // Noise at a point wakes the dormant within radius r (sooner the nearer they are).
  alert(x, z, r) {
    for (const s of this.all) if (s.active && s.state === DORMANT && s.wakeDelay < 0) {
      const d = Math.hypot(s.pos.x - x, s.pos.z - z);
      if (d < r) s.wakeDelay = 0.15 + d / r * 1.2 + this.rng.range(0, 0.5);
    }
  }
  wake(s) { if (s.state === DORMANT) { s.state = CHASE; s.stateT = 0; this.game.audio?.infected('wake', s); } }

  // --- per-frame ---
  update(dt, player, sunUp) {
    this.frame++;
    const W = this.world, nav = this.nav, grid = this.grid, rng = this.rng;
    grid.clear();
    let alive = 0;
    for (const s of this.all) if (s.active && s.state !== DEAD && s.state !== DYING) {
      alive++;
      const k = (Math.floor(s.pos.x / 1.6) * 73856093) ^ (Math.floor(s.pos.z / 1.6) * 19349663);
      const cell = grid.get(k); if (cell) cell.push(s); else grid.set(k, [s]);
    }
    this.alive = alive;
    const px = player.pos.x, pz = player.pos.z, py = player.pos.y;
    const sun = this.game.sky.astro.sunDir, sunYaw = Math.atan2(sun.x, sun.z);
    for (const s of this.all) {
      if (!s.active) continue;
      s.stateT += dt;
      const dx = px - s.pos.x, dz = pz - s.pos.z, dist = Math.hypot(dx, dz), K = s.K;
      const near = dist < 45, lodSkip = dist > 70 ? 3 : dist > 40 ? 2 : 1;
      switch (s.state) {
        case DORMANT: {
          // by day they stand and follow the sun; anything close, loud or painful ends that
          if (sunUp) s.yaw = dampAngle(s.yaw, sunYaw, 0.4, dt);
          s.move = 0;
          const wakeR = (sunUp ? 6.5 : 16) * (player.crouching ? 0.6 : 1) + player.noise * 14;
          if (s.wakeDelay >= 0) { s.wakeDelay -= dt; if (s.wakeDelay <= 0) this.wake(s); }
          else if (player.alive && (dist < wakeR || this.awakeAll)) s.wakeDelay = this.awakeAll ? rng.range(0, 3.5) : rng.range(0.1, 0.5);
          break;
        }
        case RISE: s.move = 0; if (s.stateT > 1.5) { s.state = CHASE; s.stateT = 0; } break;
        case CHASE: case ATTACK: {
          const speed = K.speed * s.speedK * (sunUp ? 0.82 : 1) * (1 - 0.75 * clamp(s.stagger * 3, 0, 1)) * (s.slow > 0 ? 0.45 : 1) * (W.waterDepth(s.pos.x, s.pos.z) > 0.2 ? 0.7 : 1);
          s.stagger = Math.max(0, s.stagger - dt); s.slow = Math.max(0, s.slow - dt); s.cooldown = Math.max(0, s.cooldown - dt);
          let wantYaw = s.yaw, go = 0;
          if (s.state === ATTACK) {
            s.attackT += dt / 0.78;
            wantYaw = Math.atan2(dx, dz);
            if (!s.struck && s.attackT > 0.5) {
              s.struck = true;
              if (player.alive && dist < K.reach + 0.45 && Math.abs(py - s.pos.y) < 2.3) { player.hurt(K.damage, s.pos.x, s.pos.z); if (this.onHitPlayer) this.onHitPlayer(s); }
            }
            if (s.attackT >= 1) { s.state = CHASE; s.cooldown = kindCooldown(s.kind); s.stateT = 0; }
          } else if (player.alive) {
            if (dist < K.reach && Math.abs(py - s.pos.y) < 2.3 && s.cooldown <= 0 && s.stagger <= 0) { s.state = ATTACK; s.attackT = 0; s.struck = false; this.game.audio?.infected('attack', s); }
            else {
              // straight at the player when the way is open, otherwise down the gradient of the flow field
              if ((s.index + this.frame) % 6 === 0) s.direct = dist < 26 && nav.lineClear(s.pos.x, s.pos.z, px, pz);
              if (dist < 2.2 || s.direct) { wantYaw = Math.atan2(dx, dz); go = dist > K.reach * 0.8 ? 1 : 0; }
              else if (nav.dirAt(s.pos.x, s.pos.z, _d)) { wantYaw = Math.atan2(_d.x, _d.z); go = 1; }
              else { wantYaw = Math.atan2(dx, dz); go = dist > 1 ? 0.6 : 0; }
            }
          } else go = 0;
          s.yaw = dampAngle(s.yaw, wantYaw, K.turn, dt);
          const align = Math.max(0, Math.cos(angleDelta(s.yaw, wantYaw)));
          const v = speed * go * (0.25 + 0.75 * align);
          let vx = Math.sin(s.yaw) * v, vz = Math.cos(s.yaw) * v;
          // keep off each other
          if (near) {
            const cx = Math.floor(s.pos.x / 1.6), cz = Math.floor(s.pos.z / 1.6);
            for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
              const cell = grid.get(((cx + i) * 73856093) ^ ((cz + j) * 19349663)); if (!cell) continue;
              for (const o of cell) { if (o === s) continue; const ox = s.pos.x - o.pos.x, oz = s.pos.z - o.pos.z, d2 = ox * ox + oz * oz, rr = 0.42 * (s.scale + o.scale);
                if (d2 < rr * rr && d2 > 1e-5) { const d = Math.sqrt(d2), f = (rr - d) / rr * 2.6; vx += ox / d * f; vz += oz / d * f; } }
            }
          }
          if (dist < 0.62 && dist > 1e-3) { vx -= dx / dist * 2; vz -= dz / dist * 2; }      // and off the player
          s.vx = damp(s.vx, vx, 10, dt); s.vz = damp(s.vz, vz, 10, dt);
          const ox = s.pos.x, oz = s.pos.z;
          _p2.x = ox + s.vx * dt; _p2.z = oz + s.vz * dt;
          if (near || (s.index + this.frame) % 3 === 0) W.solids.collide(_p2, 0.3 * s.scale, s.pos.y + 0.6, s.pos.y + 1.6, SOLID.NAV);
          s.pos.x = _p2.x; s.pos.z = _p2.z;
          const moved = Math.hypot(s.pos.x - ox, s.pos.z - oz);
          s.pos.y = damp(s.pos.y, W.groundAt(s.pos.x, s.pos.z, s.pos.y, 0.6), 14, dt);
          s.phase += moved / (0.5 * s.scale * (s.kind === 'runner' ? 1.25 : 1)) * 1.6;
          s.move = damp(s.move, clamp(moved / dt / (K.speed * 0.8), 0, 1.2), 8, dt);
          // jammed against something with the player out of reach: shuffle sideways
          if (go > 0 && moved < v * dt * 0.2) { s.stuck += dt; if (s.stuck > 1.2) { s.yaw += rng.sign() * 1.2; s.stuck = 0; } } else s.stuck = 0;
          s.groanT -= dt; if (s.groanT <= 0) { s.groanT = rng.range(3, 9); if (dist < 45) this.game.audio?.infected('groan', s); }
          break;
        }
        case DYING: {
          s.fall = Math.min(1, s.fall + dt / 1.05);
          if (s.fall >= 1) { s.state = DEAD; s.deadT = 0; }
          break;
        }
        case DEAD: {
          s.deadT += dt;
          if (s.deadT > 26) { s.sink += dt * 0.3; if (s.sink > 0.6) { s.active = false; s.mesh.visible = false; continue; } }
          break;
        }
      }
      // flinch springs
      const F = s.flinch;
      F[2] += (-F[0] * 120 - F[2] * 13) * dt; F[0] += F[2] * dt; F[3] += (-F[1] * 120 - F[3] * 13) * dt; F[1] += F[3] * dt;
      if ((s.index + this.frame) % lodSkip === 0 || s.state === DYING) this._pose(s, dt * lodSkip);
      this._place(s, dt);
      s.mesh.castShadow = dist < 55 && s.state !== DEAD;
    }
  }

  _place(s, dt) {
    const m = s.mesh;
    let y = s.pos.y - s.sink;
    if (s.state === RISE) y -= 1.75 * s.scale * (1 - smoothstep(0, 1.4, s.stateT));       // up out of the ground
    m.position.set(s.pos.x, y, s.pos.z); m.rotation.y = s.yaw;
    m.updateMatrixWorld(true);
  }

  // Compute target joint angles for the current state and ease the skeleton toward them.
  _pose(s, dt) {
    const T = s.target, t = this.game.time + s.seed;
    T.fill(0);
    let hipY = 0, hipZ = 0;
    const set = (b, x, y = 0, z = 0) => { T[b * 3] = x; T[b * 3 + 1] = y; T[b * 3 + 2] = z; };
    const run = s.kind === 'runner' ? 1 : s.kind === 'brute' ? 0.25 : 0, mv = s.move;
    if (s.state === DYING || s.state === DEAD) {
      const e = s.fall, e2 = e * e, mid = Math.sin(Math.PI * Math.min(1, e * 1.15)), d = s.fallDir;
      // the knees go, the hips drop, the trunk follows them down
      hipY = -0.82 * Math.min(1, e2 * 1.25) + 0.03 * Math.sin(Math.PI * clamp((e - 0.8) / 0.2, 0, 1));
      hipZ = -0.25 * d * e;
      set(HIPS, d * -1.5 * smoothstep(0.1, 0.95, e), s.fallYaw * e, s.fallRoll * e);
      set(SPINE, d * 0.12 * mid, 0, s.fallRoll * 0.3 * e); set(CHEST, d * 0.1 * mid);
      set(HEAD, d * -0.3 * e + 0.2 * mid, s.headRoll * 2 * e, s.headRoll * e);
      set(THIGH_L, -0.75 * mid + d * 0.12 * e, 0, 0.18 * e); set(THIGH_R, -0.55 * mid + d * 0.2 * e, 0, -0.14 * e);
      set(SHIN_L, 1.3 * mid + 0.15 * e); set(SHIN_R, 1.1 * mid + 0.35 * e);
      set(FOOT_L, 0.3 * e); set(FOOT_R, 0.4 * e);
      set(ARM_L, d > 0 ? -0.5 * e - 1.2 * mid : -2.4 * e, 0, 1.0 * e); set(ARM_R, d > 0 ? -0.3 * e - 1.0 * mid : -2.1 * e, 0, -1.15 * e);
      set(FORE_L, -0.5 * e); set(FORE_R, -0.8 * e);
    } else {
      const ph = s.phase, sL = Math.sin(ph), cL = Math.cos(ph);
      const limpL = s.limpSide > 0 ? s.limp : 0, limpR = s.limpSide < 0 ? s.limp : 0;
      const A = (0.38 + 0.34 * run) * mv, lean = 0.06 * mv + 0.22 * run * mv;
      set(THIGH_L, -sL * A * (1 - limpL) - lean, 0, 0.03); set(THIGH_R, sL * A * (1 - limpR) - lean, 0, -0.03);
      const kL = (0.12 + 0.9 * Math.max(0, cL)) * (0.55 + 0.6 * run) * mv * (1 - limpL * 0.75) + 0.1, kR = (0.12 + 0.9 * Math.max(0, -cL)) * (0.55 + 0.6 * run) * mv * (1 - limpR * 0.75) + 0.1;
      set(SHIN_L, kL); set(SHIN_R, kR);
      set(FOOT_L, -T[THIGH_L * 3] * 0.6 - kL * 0.45); set(FOOT_R, -T[THIGH_R * 3] * 0.6 - kR * 0.45);
      const limpDrop = (limpL * Math.max(0, -sL) + limpR * Math.max(0, sL)) * mv;
      hipY = -(0.025 + 0.03 * run) * Math.abs(cL) * mv - 0.07 * limpDrop - 0.02;
      const sway = Math.sin(t * 0.7) * 0.025;
      set(HIPS, 0.04 * mv + 0.12 * run * mv, -sL * 0.15 * mv, sL * 0.05 * mv + sway + 0.14 * limpDrop * s.limpSide);
      const hunch = s.hunch * (s.state === DORMANT ? 0.25 : 1) + 0.25 * run * mv;
      set(SPINE, hunch * 0.5 + s.flinch[0] * 0.5, sL * 0.1 * mv + s.flinch[1] * 0.5, -sL * 0.03 * mv - sway);
      set(CHEST, hunch * 0.5 + s.flinch[0] * 0.5 + Math.sin(t * 1.1) * 0.015, sL * 0.14 * mv + s.flinch[1] * 0.5, 0);
      const jerk = Math.pow(Math.max(0, Math.sin(t * 0.9 + 1.3)), 24) * 0.5;
      if (s.state === DORMANT) set(HEAD, -0.42 + Math.sin(t * 0.4) * 0.04, Math.sin(t * 0.23) * 0.08, s.headRoll * 0.5);       // face lifted to the light
      else set(HEAD, -hunch * 0.75 + 0.1 * Math.sin(t * 1.7) + s.flinch[0] * 0.8, Math.sin(t * 0.6) * 0.2 + jerk * s.limpSide + s.flinch[1], s.headRoll + jerk * 0.4);
      set(NECK, 0.05, 0, s.headRoll * 0.4);
      // arms
      const sw = sL * 0.3 * mv;
      if (s.state === DORMANT) { set(ARM_L, 0.04, 0, 0.05); set(ARM_R, 0.04, 0, -0.05); set(FORE_L, -0.1); set(FORE_R, -0.1); }
      else if (s.state === ATTACK) {
        const a = s.attackT, up = smoothstep(0, 0.38, a) * (1 - smoothstep(0.42, 0.6, a)), down = smoothstep(0.42, 0.58, a) * (1 - smoothstep(0.7, 1, a));
        set(ARM_L, -1.05 - 1.45 * up + 0.2 * down, 0, 0.12 + 0.3 * up); set(ARM_R, -1.15 - 1.3 * up + 0.25 * down, 0, -0.12 - 0.3 * up);
        set(FORE_L, -0.5 - 0.5 * up + 0.3 * down); set(FORE_R, -0.45 - 0.5 * up + 0.3 * down);
        T[SPINE * 3] += -0.25 * up + 0.5 * down; T[CHEST * 3] += -0.2 * up + 0.4 * down; T[HEAD * 3] += 0.25 * down;
        hipZ = 0.12 * down;
      } else if (s.state === RISE) {
        const r = Math.sin(t * 9);
        set(ARM_L, -2.5 + 0.3 * r, 0, 0.3); set(ARM_R, -2.4 - 0.3 * r, 0, -0.3); set(FORE_L, -0.7 + 0.4 * r); set(FORE_R, -0.7 - 0.4 * r);
      } else if (s.arms === 0) {
        set(ARM_L, -1.15 + 0.12 * Math.sin(t * 1.3) + sw * 0.3, 0, 0.1); set(ARM_R, -1.0 + 0.12 * Math.sin(t * 1.1 + 2) - sw * 0.3, 0, -0.1);
        set(FORE_L, -0.45 + 0.1 * Math.sin(t * 2.1)); set(FORE_R, -0.35 + 0.1 * Math.sin(t * 1.9 + 1));
      } else if (s.arms === 1) {
        set(ARM_L, 0.1 + sw, 0, 0.08); set(ARM_R, 0.1 - sw, 0, -0.08); set(FORE_L, -0.2 - 0.2 * Math.max(0, -sw)); set(FORE_R, -0.2 - 0.2 * Math.max(0, sw));
      } else if (run > 0.5) {
        set(ARM_L, -0.6 + sL * 0.9 * mv, 0, 0.25); set(ARM_R, -0.6 - sL * 0.9 * mv, 0, -0.25); set(FORE_L, -1.1); set(FORE_R, -1.1);
      } else {
        set(ARM_L, -1.2 + 0.1 * Math.sin(t * 1.3), 0, 0.1); set(ARM_R, 0.15 - sw, 0, -0.06); set(FORE_L, -0.4); set(FORE_R, -0.15);
      }
      set(HAND_L, -0.35, 0, 0); set(HAND_R, -0.35, 0, 0);
    }
    // ease, then write to the bones
    const P = s.pose, k = 1 - Math.exp(-(s.state === DYING ? 16 : 11) * dt), B = s.bones;
    for (let i = 0; i < NB * 3; i++) P[i] += (T[i] - P[i]) * k;
    for (let b = 0; b < NB; b++) B[b].rotation.set(P[b * 3], P[b * 3 + 1], P[b * 3 + 2]);
    s.hipY = lerp(s.hipY || 0, hipY, k); s.hipZ = lerp(s.hipZ || 0, hipZ, k);
    B[HIPS].position.set(0, REST[HIPS][1] + s.hipY, s.hipZ);
  }

  // --- being shot ---
  // Nearest infected a ray meets. Returns this.hit (z, t, part) or null.
  raycast(ox, oy, oz, dx, dy, dz, maxT) {
    let best = maxT, hz = null, part = '';
    for (const s of this.all) {
      if (!s.active || s.state === DEAD || (s.state === DYING && s.fall > 0.35)) continue;
      // cheap reject: a ball round the whole body
      const cx = s.pos.x - ox, cy = s.pos.y + 0.95 * s.scale - oy, cz = s.pos.z - oz, tc = cx * dx + cy * dy + cz * dz;
      if (tc < -1.5 || tc > best + 1.5) continue;
      const d2 = cx * cx + cy * cy + cz * cz - tc * tc;
      if (d2 > 1.5 * 1.5 * s.scale * s.scale) continue;
      const B = s.bones, sc = s.scale;
      const test = (a, b, r, name) => {
        const A = B[a].matrixWorld.elements, Bm = B[b].matrixWorld.elements;
        const t = raySegment(ox, oy, oz, dx, dy, dz, A[12], A[13], A[14], Bm[12], Bm[13], Bm[14], r * sc);
        if (t >= 0 && t < best) { best = t; hz = s; part = name; }
      };
      if (!s.headless) {
        const H = B[HEAD].matrixWorld.elements;
        // the skull: a ball a little above the head joint
        const ux = H[4], uy = H[5], uz = H[6], hx = H[12] + ux * 0.11, hy = H[13] + uy * 0.11, hzz = H[14] + uz * 0.11;
        const t = raySphere(ox, oy, oz, dx, dy, dz, hx, hy, hzz, 0.125 * sc);
        if (t >= 0 && t < best) { best = t; hz = s; part = 'head'; }
      }
      test(HIPS, NECK, 0.185, 'torso');
      test(ARM_L, FORE_L, 0.07, 'limb'); test(FORE_L, HAND_L, 0.06, 'limb'); test(ARM_R, FORE_R, 0.07, 'limb'); test(FORE_R, HAND_R, 0.06, 'limb');
      test(THIGH_L, SHIN_L, 0.095, 'leg'); test(SHIN_L, FOOT_L, 0.07, 'leg'); test(THIGH_R, SHIN_R, 0.095, 'leg'); test(SHIN_R, FOOT_R, 0.07, 'leg');
    }
    if (!hz) return null;
    const h = this.hit; h.target = hz; h.t = best; h.part = part; h.px = ox + dx * best; h.py = oy + dy * best; h.pz = oz + dz * best;
    return h;
  }

  // Apply damage. dir is the direction the blow travels. Returns true if it killed.
  damage(s, amount, part, dx, dz, force = 1) {
    if (!s.active || s.state === DYING || s.state === DEAD) return false;
    const K = s.K;
    const mult = part === 'head' ? K.head : part === 'torso' ? 1 : 0.6;
    s.hp -= amount * mult;
    if (s.state === DORMANT) { s.state = CHASE; s.stateT = 0; }
    // which way does the blow turn the body
    const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw), along = dx * fx + dz * fz, side = dx * fz - dz * fx;
    s.flinch[2] += -along * 5 * force / K.scale; s.flinch[3] += side * 6 * force / K.scale;
    if (part === 'leg') s.slow = 1.6;
    if (s.kind !== 'brute' || amount > 60) s.stagger = Math.max(s.stagger, 0.22 * force);
    this.alert(s.pos.x, s.pos.z, 9);
    if (s.hp <= 0) {
      s.state = DYING; s.fall = 0; s.stateT = 0;
      s.fallDir = along > 0.15 ? -1 : 1;                        // shot from the front, it goes over backward
      s.fallYaw = this.rng.range(-0.5, 0.5); s.fallRoll = this.rng.range(-0.35, 0.35);
      if (part === 'head') { s.headless = true; s.bones[HEAD].scale.setScalar(0.001); this.headshots++; }
      this.killed++;
      if (this.onKill) this.onKill(s, part);
      return true;
    }
    return false;
  }

  // Everything within a blast radius, with falloff.
  blast(x, y, z, radius, damage) {
    let kills = 0;
    for (const s of this.all) {
      if (!s.active || s.state === DYING || s.state === DEAD) continue;
      const dx = s.pos.x - x, dz = s.pos.z - z, dy = s.pos.y + 0.9 - y, d = Math.hypot(dx, dy, dz);
      if (d > radius) continue;
      const l = Math.hypot(dx, dz) || 1;
      if (this.damage(s, damage * (1 - d / radius) ** 0.8, 'torso', dx / l, dz / l, 3)) kills++;
    }
    return kills;
  }
}

function kindCooldown(kind) { return kind === 'brute' ? 0.9 : kind === 'runner' ? 0.35 : 0.55; }

// Ray against a sphere: entry distance or -1.
function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const lx = cx - ox, ly = cy - oy, lz = cz - oz, tc = lx * dx + ly * dy + lz * dz, d2 = lx * lx + ly * ly + lz * lz - tc * tc;
  if (d2 > r * r) return -1;
  const t = tc - Math.sqrt(r * r - d2);
  return t >= 0 ? t : (tc + Math.sqrt(r * r - d2) >= 0 ? 0 : -1);
}
// Ray against a capsule (segment a-b, radius r): approximate entry distance or -1.
function raySegment(ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz, r) {
  const ux = bx - ax, uy = by - ay, uz = bz - az, wx = ox - ax, wy = oy - ay, wz = oz - az;
  const a = ux * ux + uy * uy + uz * uz, b = ux * dx + uy * dy + uz * dz, c = ux * wx + uy * wy + uz * wz, d = dx * wx + dy * wy + dz * wz;
  const den = a - b * b;
  let s = den > 1e-8 ? clamp((c - b * d) / den, 0, 1) : 0;
  let t = s * b - d;
  if (t < 0) { t = 0; s = clamp(c / a, 0, 1); }
  const px = ox + dx * t - (ax + ux * s), py = oy + dy * t - (ay + uy * s), pz = oz + dz * t - (az + uz * s);
  const d2 = px * px + py * py + pz * pz;
  if (d2 > r * r) return -1;
  return Math.max(0, t - Math.sqrt(r * r - d2));
}
