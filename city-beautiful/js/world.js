// The level: terrain, the paved esplanade, and the orchestration that turns
// the building recipes in capitol.js into meshes, collision and baked shade.
//
// Axes: +X east, +Y up, +Z south. The Assembly stands to the west, the High
// Court to the east, the Open Hand to the north; the player walks in from the
// south along what used to be Jan Marg.
import { THREE } from './lib/three.js';
import { Solids, SOLID, SURF } from './physics.js';
import { Builder, bakeAO } from './geom.js';
import { clamp, lerp, smoothstep, fbm2, noise2, makeRng } from './util.js';
import { buildCapitol } from './capitol.js';
import { buildProps } from './props.js';

export const BOUNDS = { x0: -168, z0: -128, x1: 168, z1: 136 };          // where a body may go
export const FINE = { x0: -200, z0: -160, x1: 200, z1: 168, cell: 2 };   // finely tessellated ground
export const START = { x: 0, z: 124, yaw: 0 };
const BERM = 2.6;                                                         // height the ground settles to outside the complex

const rectDist = (r, x, z) => Math.hypot(Math.max(r.x0 - x, 0, x - r.x1), Math.max(r.z0 - z, 0, z - r.z1));
const inRect = (r, x, z) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;

export class World {
  constructor() {
    this.solids = new Solids(16384);
    this.b = new Builder(this.solids);
    this.rng = makeRng(1953);          // the year the city was founded
    this.holes = [];      // rectangles cut out of the ground mesh (pools, the sunken court)
    this.ramps = [];      // { x0, z0, x1, z1, axis, y0, y1 }: walkable inclines
    this.flats = [];      // { x0, z0, x1, z1, y }: floors below or above the plaza
    this.pools = [];      // { x0, z0, x1, z1, level, bed }
    this.level = [];      // rectangles the terrain must leave perfectly flat
    this.paved = [];      // { x0, z0, x1, z1, soft }: where concrete still holds out
    this.mounds = [];     // { x, z, half, h }: grassed pyramids
    this.landmarks = {};  // named points of interest, filled by the building recipes
    this.dynamic = [];    // meshes that move (the Open Hand), added to the scene as they are
    this.lights = [];
    this.meshes = [];
    this.hgrid = null; this.hw = 0; this.hh = 0;
  }

  // ---- terrain ------------------------------------------------------------
  // The shape of the land before any floor or ramp is laid over it.
  rawHeight(x, z) {
    let h = 0;
    for (const m of this.mounds) {
      const d = Math.max(Math.abs(x - m.x), Math.abs(z - m.z)) / m.half;
      if (d < 1) h = Math.max(h, m.h * Math.min(1, (1 - d) / 0.8));      // a pyramid with its point levelled off
    }
    // gentle heave where roots and silt have had their way, never under anything built
    let dl = 1e9;
    for (const r of this.level) { const d = rectDist(r, x, z); if (d < dl) dl = d; }
    const rough = smoothstep(3, 20, dl);
    h += rough * (fbm2(x * 0.045 + 3.1, z * 0.045 + 8.7, 3) - 0.5) * 1.1;
    // the land rises into a wooded bank all round the complex
    const out = Math.hypot(Math.max(BOUNDS.x0 - x, 0, x - BOUNDS.x1), Math.max(BOUNDS.z0 - z, 0, z - BOUNDS.z1));
    const k = smoothstep(0, 30, out);
    h = lerp(h, BERM, k);
    if (out > 0) h += Math.sin(Math.min(out, 30) / 30 * Math.PI) * (noise2(x * 0.06, z * 0.06) - 0.35) * 1.6;
    return h;
  }
  farHeight(x, z) {
    const out = Math.hypot(Math.max(FINE.x0 - x, 0, x - FINE.x1), Math.max(FINE.z0 - z, 0, z - FINE.z1));
    const k = smoothstep(0, 160, out);
    // low rolling ground, climbing toward the hills in the north
    return BERM + k * ((fbm2(x * 0.004 + 2.2, z * 0.004 + 5.5, 4) - 0.45) * 26 + smoothstep(-300, -1400, z) * 34);
  }
  _bakeHeights() {
    const w = this.hw = FINE.x1 - FINE.x0 + 1, h = this.hh = FINE.z1 - FINE.z0 + 1;
    const g = this.hgrid = new Float32Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) g[j * w + i] = this.rawHeight(FINE.x0 + i, FINE.z0 + j);
  }
  baseHeight(x, z) {
    if (x <= FINE.x0 || x >= FINE.x1 || z <= FINE.z0 || z >= FINE.z1) return this.farHeight(x, z);
    const fx = x - FINE.x0, fz = z - FINE.z0, i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, w = this.hw, g = this.hgrid;
    const a = g[j * w + i], b = g[j * w + i + 1], c = g[(j + 1) * w + i], d = g[(j + 1) * w + i + 1];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  // Terrain height including floors and ramps, but not things standing on it.
  heightAt(x, z) {
    for (let i = 0; i < this.ramps.length; i++) {
      const r = this.ramps[i];
      if (x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1) {
        const t = r.axis === 'x' ? (x - r.x0) / (r.x1 - r.x0) : (z - r.z0) / (r.z1 - r.z0);
        return r.y0 + (r.y1 - r.y0) * t;
      }
    }
    for (let i = 0; i < this.flats.length; i++) { const r = this.flats[i]; if (x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1) return r.y; }
    return this.baseHeight(x, z);
  }
  // What a body with its feet at yFeet stands on at (x, z): terrain, or the top of something low enough to step onto.
  groundAt(x, z, yFeet, stepUp = 0.45) {
    const t = this.heightAt(x, z);
    const f = this.solids.floorAt(x, z, yFeet, stepUp);
    return f > t ? f : t;
  }
  // Depth of water at a point (0 on dry land).
  waterDepth(x, z) {
    for (let i = 0; i < this.pools.length; i++) { const p = this.pools[i]; if (x > p.x0 && x < p.x1 && z > p.z0 && z < p.z1) return p.level - p.bed; }
    return 0;
  }
  inPool(x, z) { for (let i = 0; i < this.pools.length; i++) { const p = this.pools[i]; if (x > p.x0 && x < p.x1 && z > p.z0 && z < p.z1) return p; } return null; }

  // 0 = sound paving, 1 = entirely taken back by soil and meadow.
  growAt(x, z) {
    let paved = 0;
    for (const p of this.paved) { const v = 1 - smoothstep(0, p.soft, rectDist(p, x, z)); if (v > paved) paved = v; }
    const n = fbm2(x * 0.03 + 11.3, z * 0.03 + 4.1, 4), n2 = fbm2(x * 0.11, z * 0.11 + 7.7, 3);
    let g = lerp(1.0, 0.04, paved) + (n - 0.5) * 1.15 * (0.3 + 0.7 * paved) + (n2 - 0.5) * 0.3;
    for (const p of this.pools) g += 0.5 * (1 - smoothstep(0, 9, rectDist(p, x, z)));      // damp ground round the pools
    for (const m of this.mounds) if (Math.max(Math.abs(x - m.x), Math.abs(z - m.z)) < m.half + 1) g = Math.max(g, 0.92);   // the hills are turf
    return clamp(g, 0, 1);
  }

  // First thing a ray meets: a solid, or the ground. Returns { t, nx, ny, nz, surf } or null.
  raycast(ox, oy, oz, dx, dy, dz, maxT, mask = SOLID.SHOT) {
    let t = maxT, hit = null;
    if (this.solids.raycast(ox, oy, oz, dx, dy, dz, maxT, mask)) { hit = this._hit; const h = this.solids.hit; hit.t = h.t; hit.nx = h.nx; hit.ny = h.ny; hit.nz = h.nz; hit.surf = h.surf; t = h.t; }
    // march the terrain; steps lengthen with distance, then bisect
    if (dy < 0.35) {
      let s = 0, prev = 0, step = 0.6;
      while (s < t) {
        s = Math.min(t, s + step); step *= 1.06;
        const x = ox + dx * s, z = oz + dz * s, y = oy + dy * s;
        if (y < this.heightAt(x, z)) {
          let a = prev, b = s;
          for (let k = 0; k < 8; k++) { const m = (a + b) / 2; if (oy + dy * m < this.heightAt(ox + dx * m, oz + dz * m)) b = m; else a = m; }
          hit = this._hit; hit.t = b; hit.nx = 0; hit.ny = 1; hit.nz = 0;
          const px = ox + dx * b, pz = oz + dz * b;
          hit.surf = this.inPool(px, pz) ? SURF.water : (this.growAt(px, pz) > 0.5 ? SURF.dirt : SURF.concrete);
          break;
        }
        prev = s;
      }
    }
    return hit;
  }

  // ---- ground mesh ----------------------------------------------------------
  _buildGround() {
    const b = this.b, c = FINE.cell;
    b.setGroup('ground');
    const o = { ...b.def, mat: 'ground', solid: 0, color: [1, 1, 1] };
    const batch = b._batch(o);
    const nx = (FINE.x1 - FINE.x0) / c, nz = (FINE.z1 - FINE.z0) / c;
    b._reserve(batch, (nx + 1) * (nz + 1), nx * nz * 6);
    const base = batch.pos.n;
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
      const x = FINE.x0 + i * c, z = FINE.z0 + j * c;
      const y = this.baseHeight(Math.min(Math.max(x, FINE.x0 + 0.01), FINE.x1 - 0.01), Math.min(Math.max(z, FINE.z0 + 0.01), FINE.z1 - 0.01));
      const e = 1.0;
      const hx = this.baseHeight(clamp(x + e, FINE.x0 + 0.01, FINE.x1 - 0.01), clamp(z, FINE.z0 + 0.01, FINE.z1 - 0.01)) - this.baseHeight(clamp(x - e, FINE.x0 + 0.01, FINE.x1 - 0.01), clamp(z, FINE.z0 + 0.01, FINE.z1 - 0.01));
      const hz = this.baseHeight(clamp(x, FINE.x0 + 0.01, FINE.x1 - 0.01), clamp(z + e, FINE.z0 + 0.01, FINE.z1 - 0.01)) - this.baseHeight(clamp(x, FINE.x0 + 0.01, FINE.x1 - 0.01), clamp(z - e, FINE.z0 + 0.01, FINE.z1 - 0.01));
      const l = Math.hypot(-hx, 2 * e, -hz);
      const v = b._vert(batch, o, x, y, z, -hx / l, 2 * e / l, -hz / l);
      batch.surf.a[v * 4 + 2] = this.growAt(x, z);
    }
    const I = batch.idx.a; let k = batch.idx.n;
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const cx = FINE.x0 + (i + 0.5) * c, cz = FINE.z0 + (j + 0.5) * c;
      let cut = false;
      for (const h of this.holes) if (inRect(h, cx, cz)) { cut = true; break; }
      if (cut) continue;
      const a = base + j * (nx + 1) + i, d = a + nx + 1;
      I[k++] = a; I[k++] = d; I[k++] = d + 1; I[k++] = a; I[k++] = d + 1; I[k++] = a + 1;
    }
    batch.idx.n = k;

    // far ground: a coarse apron out to the horizon, never walked on
    b.setGroup('far');
    const of = { ...b.def, mat: 'ground', solid: 0, ao: false, shadow: false, grow: 1 };
    const fb = b._batch(of);
    const R = 1400, C = 40;
    const xs = [], zs = [];
    for (let x = -R; x <= R; x += C) xs.push(x);
    for (let z = -R; z <= R; z += C) zs.push(z);
    // snap the apron's inner edge onto the fine grid's border so the two meet without a crack
    const snap = (arr, lo, hi) => { const out = arr.filter(v => v <= lo - C * 0.5 || v >= hi + C * 0.5); out.push(lo, hi); return [...new Set(out)].sort((p, q) => p - q); };
    const X = snap(xs, FINE.x0, FINE.x1), Z = snap(zs, FINE.z0, FINE.z1);
    const mid = [];
    for (let v = FINE.x0 + C; v < FINE.x1; v += C) mid.push(v);
    const X2 = [...new Set([...X, ...mid])].sort((p, q) => p - q);
    const midz = [];
    for (let v = FINE.z0 + C; v < FINE.z1; v += C) midz.push(v);
    const Z2 = [...new Set([...Z, ...midz])].sort((p, q) => p - q);
    b._reserve(fb, X2.length * Z2.length, X2.length * Z2.length * 6);
    const fbase = fb.pos.n;
    for (let j = 0; j < Z2.length; j++) for (let i = 0; i < X2.length; i++) {
      const x = X2[i], z = Z2[j];
      const edge = x >= FINE.x0 && x <= FINE.x1 && z >= FINE.z0 && z <= FINE.z1;
      const y = edge ? BERM : this.farHeight(x, z);
      const hx = this.farHeight(x + 20, z) - this.farHeight(x - 20, z), hz = this.farHeight(x, z + 20) - this.farHeight(x, z - 20);
      const l = Math.hypot(hx, 40, hz);
      b._vert(fb, of, x, y, z, edge ? 0 : -hx / l, edge ? 1 : 40 / l, edge ? 0 : -hz / l);
    }
    const FI = fb.idx.a; let fk = fb.idx.n;
    for (let j = 0; j < Z2.length - 1; j++) for (let i = 0; i < X2.length - 1; i++) {
      const cx = (X2[i] + X2[i + 1]) / 2, cz = (Z2[j] + Z2[j + 1]) / 2;
      if (cx > FINE.x0 && cx < FINE.x1 && cz > FINE.z0 && cz < FINE.z1) continue;      // the fine grid covers this
      const a = fbase + j * X2.length + i, d = a + X2.length;
      FI[fk++] = a; FI[fk++] = d; FI[fk++] = d + 1; FI[fk++] = a; FI[fk++] = d + 1; FI[fk++] = a + 1;
    }
    fb.idx.n = fk;
  }

  // ---- assembly ---------------------------------------------------------------
  // materials: { concrete, ground, metal, ... } keyed by batch name.
  async build(materials, slicer, progress = () => {}) {
    const b = this.b;
    progress(0.02, 'Surveying the Capitol');
    buildCapitol(this);                      // registers geometry, solids, holes, ramps, pools, landmarks
    await slicer.tick();
    progress(0.12, 'Laying the esplanade');
    this._bakeHeights();
    this._buildGround();
    buildProps(this);                        // what people left behind
    // the edge of the world: nothing passes, nothing is seen
    const B = BOUNDS, t = 4, wall = SOLID.MOVE | SOLID.NAV;
    this.solids.addBox(B.x0 - t, -20, B.z0 - t, B.x0, 60, B.z1 + t, wall);
    this.solids.addBox(B.x1, -20, B.z0 - t, B.x1 + t, 60, B.z1 + t, wall);
    this.solids.addBox(B.x0 - t, -20, B.z0 - t, B.x1 + t, 60, B.z0, wall);
    this.solids.addBox(B.x0 - t, -20, B.z1, B.x1 + t, 60, B.z1 + t, wall);
    this.solids.build(FINE.x0, FINE.z0, FINE.x1, FINE.z1, 4);
    await slicer.tick();
    progress(0.2, 'Sixty years of weather');
    await bakeAO(b, this.solids, (x, z) => this.heightAt(x, z), slicer, f => progress(0.2 + f * 0.3, 'Sixty years of weather'));
    this.meshes = b.finish(materials);
    progress(0.5, 'Raising the Capitol');
    return this;
  }
}
World.prototype._hit = { t: 0, nx: 0, ny: 1, nz: 0, surf: 0 };

// ---------------------------------------------------------------------------
// Distant scenery: the Shivalik foothills to the north, layered into the haze.
export function buildBackdrop(scene, makeMaterial) {
  const rng = makeRng(77);
  const group = new THREE.Group();
  const layers = [
    { dist: 1500, h0: 30, h1: 95, col: [0.045, 0.07, 0.04], seed: 3.1 },
    { dist: 2400, h0: 70, h1: 190, col: [0.04, 0.06, 0.045], seed: 9.7 },
    { dist: 3600, h0: 120, h1: 330, col: [0.035, 0.05, 0.05], seed: 17.3 },
  ];
  for (const L of layers) {
    const seg = 220, pos = [], col = [], idx = [];
    for (let i = 0; i <= seg; i++) {
      const t = i / seg, az = (-112 + 224 * t) * Math.PI / 180;       // an arc across the northern sky
      const x = Math.sin(az) * L.dist, z = -Math.cos(az) * L.dist;
      const ridge = fbm2(t * 9 + L.seed, L.seed * 1.7, 5), fold = fbm2(t * 31 + L.seed * 2, 4.4, 3);
      const fade = smoothstep(0, 0.16, t) * smoothstep(1, 0.84, t);
      const h = (L.h0 + (L.h1 - L.h0) * ridge + (fold - 0.5) * L.h0 * 0.7) * (0.25 + 0.75 * fade);
      pos.push(x, -30, z, x, h, z);
      const c = 0.8 + 0.4 * fold;
      col.push(L.col[0] * c, L.col[1] * c, L.col[2] * c, L.col[0] * c * 1.15, L.col[1] * c * 1.15, L.col[2] * c * 1.1);
      if (i < seg) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx); g.computeVertexNormals();
    const m = new THREE.Mesh(g, makeMaterial());
    m.frustumCulled = false; m.matrixAutoUpdate = false;
    group.add(m);
  }
  scene.add(group);
  return group;
}
