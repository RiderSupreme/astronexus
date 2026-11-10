// Navigation for the infected.
//
// The ground is rasterised into one-metre cells by flooding outward from the
// player's start: a cell is walkable if a body could step into it from a
// walkable neighbour without climbing more than a pace. Whenever the player
// moves to a new cell, a breadth-first pass relabels every cell with its
// walking distance to the player. An infected then needs no path of its own:
// it steps to whichever neighbouring cell is closer, and a hundred of them cost
// no more than one.
import { BOUNDS } from './world.js';
import { SOLID } from './physics.js';

const INF = 65535;
const STEP = 0.6;

export class Nav {
  constructor(world) {
    this.world = world;
    this.x0 = BOUNDS.x0; this.z0 = BOUNDS.z0; this.w = BOUNDS.x1 - BOUNDS.x0; this.h = BOUNDS.z1 - BOUNDS.z0;
    const n = this.w * this.h;
    this.height = new Float32Array(n);
    this.walk = new Uint8Array(n);
    this.pass = new Uint8Array(n);            // which neighbours can be stepped to: 1 +x, 2 -x, 4 +z, 8 -z
    this.dist = new Uint16Array(n).fill(INF);
    this.queue = new Int32Array(n);
    this.target = -1;
    this.spawnCells = [];
    this.count = 0;
  }
  cell(x, z) { const i = Math.floor(x - this.x0), j = Math.floor(z - this.z0); return (i < 0 || j < 0 || i >= this.w || j >= this.h) ? -1 : j * this.w + i; }
  cx(c) { return this.x0 + (c % this.w) + 0.5; }
  cz(c) { return this.z0 + Math.floor(c / this.w) + 0.5; }

  build(sx, sz) {
    const w = this.w, W = this.world, q = this.queue; let head = 0, tail = 0;
    const s = this.cell(sx, sz);
    this.walk[s] = 1; this.height[s] = W.groundAt(sx, sz, W.heightAt(sx, sz) + 0.1, 0.5); q[tail++] = s;
    const NB = [[1, 0, 1, 2], [-1, 0, 2, 1], [0, 1, 4, 8], [0, -1, 8, 4]];
    while (head < tail) {
      const c = q[head++], ci = c % w, cj = (c - ci) / w, h = this.height[c];
      for (let k = 0; k < 4; k++) {
        const ni = ci + NB[k][0], nj = cj + NB[k][1];
        if (ni < 0 || nj < 0 || ni >= w || nj >= this.h) continue;
        const n = nj * w + ni;
        let nh;
        if (this.walk[n]) nh = this.height[n];
        else {
          const x = this.x0 + ni + 0.5, z = this.z0 + nj + 0.5;
          nh = W.groundAt(x, z, h, 0.55);
          if (Math.abs(nh - h) > STEP) continue;
          if (W.solids.blocksWalker(x, z, 0.32, nh + 0.62, nh + 1.6, SOLID.NAV)) continue;
          this.walk[n] = 1; this.height[n] = nh; q[tail++] = n;
        }
        if (Math.abs(nh - h) <= STEP) { this.pass[c] |= NB[k][2]; this.pass[n] |= NB[k][3]; }
      }
    }
    this.count = tail;
    // places the infected can come out of: tall growth, well spread over the map
    for (let j = 2; j < this.h - 2; j += 3) for (let i = 2; i < w - 2; i += 3) {
      const c = j * w + i;
      if (this.walk[c] && this.pass[c] === 15 && W.growAt(this.x0 + i + 0.5, this.z0 + j + 0.5) > 0.6 && !W.inPool(this.x0 + i + 0.5, this.z0 + j + 0.5)) this.spawnCells.push(c);
    }
    return this;
  }

  nearestWalkable(x, z, maxR = 8) {
    const i0 = Math.floor(x - this.x0), j0 = Math.floor(z - this.z0);
    let best = -1, bd = 1e9;
    for (let r = 0; r <= maxR && best < 0; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
      const i = i0 + di, j = j0 + dj; if (i < 0 || j < 0 || i >= this.w || j >= this.h) continue;
      const c = j * this.w + i; if (!this.walk[c]) continue;
      const d = di * di + dj * dj; if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  // Relabel the field for a new target. Returns true if anything changed.
  update(px, pz) {
    let t = this.cell(px, pz);
    if (t < 0 || !this.walk[t]) t = this.nearestWalkable(px, pz);
    if (t < 0 || t === this.target) return false;
    this.target = t;
    const d = this.dist, q = this.queue, w = this.w, P = this.pass;
    d.fill(INF);
    let head = 0, tail = 0; d[t] = 0; q[tail++] = t;
    while (head < tail) {
      const c = q[head++], nd = d[c] + 1, p = P[c];
      if ((p & 1) && d[c + 1] === INF) { d[c + 1] = nd; q[tail++] = c + 1; }
      if ((p & 2) && d[c - 1] === INF) { d[c - 1] = nd; q[tail++] = c - 1; }
      if ((p & 4) && d[c + w] === INF) { d[c + w] = nd; q[tail++] = c + w; }
      if ((p & 8) && d[c - w] === INF) { d[c - w] = nd; q[tail++] = c - w; }
    }
    return true;
  }

  walkable(x, z) { const c = this.cell(x, z); return c >= 0 && this.walk[c] === 1; }
  distanceAt(x, z) { const c = this.cell(x, z); return c < 0 ? INF : this.dist[c]; }
  heightAtCell(x, z, fallback) { const c = this.cell(x, z); return c >= 0 && this.walk[c] ? this.height[c] : fallback; }

  // Which way to walk from (x, z) to get nearer the target. Writes a unit vector to out.x / out.z.
  dirAt(x, z, out) {
    const w = this.w;
    let c = this.cell(x, z);
    if (c < 0 || !this.walk[c]) {
      const n = this.nearestWalkable(x, z, 5); if (n < 0) return false;
      const dx = this.cx(n) - x, dz = this.cz(n) - z, l = Math.hypot(dx, dz) || 1; out.x = dx / l; out.z = dz / l; return true;
    }
    const d = this.dist, P = this.pass, p = P[c];
    let best = d[c], bi = 0, bj = 0;
    if (best === INF) return false;
    const E = (p & 1) !== 0, Wd = (p & 2) !== 0, S = (p & 4) !== 0, N = (p & 8) !== 0;
    if (E && d[c + 1] < best) { best = d[c + 1]; bi = 1; bj = 0; }
    if (Wd && d[c - 1] < best) { best = d[c - 1]; bi = -1; bj = 0; }
    if (S && d[c + w] < best) { best = d[c + w]; bi = 0; bj = 1; }
    if (N && d[c - w] < best) { best = d[c - w]; bi = 0; bj = -1; }
    // cut corners only where both ways round are open
    if (E && S && (P[c + 1] & 4) && (P[c + w] & 1) && d[c + w + 1] < best) { best = d[c + w + 1]; bi = 1; bj = 1; }
    if (E && N && (P[c + 1] & 8) && (P[c - w] & 1) && d[c - w + 1] < best) { best = d[c - w + 1]; bi = 1; bj = -1; }
    if (Wd && S && (P[c - 1] & 4) && (P[c + w] & 2) && d[c + w - 1] < best) { best = d[c + w - 1]; bi = -1; bj = 1; }
    if (Wd && N && (P[c - 1] & 8) && (P[c - w] & 2) && d[c - w - 1] < best) { best = d[c - w - 1]; bi = -1; bj = -1; }
    if (bi === 0 && bj === 0) return false;
    const tx = this.cx(c) + bi, tz = this.cz(c) + bj, dx = tx - x, dz = tz - z, l = Math.hypot(dx, dz) || 1;
    out.x = dx / l; out.z = dz / l;
    return true;
  }

  // Can a body walk the straight line between two points?
  lineClear(x0, z0, x1, z1) {
    const dx = x1 - x0, dz = z1 - z0, len = Math.hypot(dx, dz), n = Math.ceil(len / 0.45);
    let prev = this.cell(x0, z0);
    if (prev < 0 || !this.walk[prev]) return false;
    for (let k = 1; k <= n; k++) {
      const t = k / n, c = this.cell(x0 + dx * t, z0 + dz * t);
      if (c === prev) continue;
      if (c < 0 || !this.walk[c] || Math.abs(this.height[c] - this.height[prev]) > STEP) return false;
      prev = c;
    }
    return true;
  }

  // A cell for something to emerge from: between minD and maxD metres from (px, pz), reachable, and if possible unseen.
  pickSpawn(rng, px, pz, minD, maxD, fx = 0, fz = 0, tries = 40) {
    let fallback = -1;
    for (let k = 0; k < tries; k++) {
      const c = this.spawnCells[Math.floor(rng() * this.spawnCells.length)];
      if (this.dist[c] === INF) continue;
      const x = this.cx(c), z = this.cz(c), dx = x - px, dz = z - pz, d = Math.hypot(dx, dz);
      if (d < minD || d > maxD) continue;
      if (fallback < 0) fallback = c;
      if ((dx * fx + dz * fz) / d > 0.55) continue;        // in front of the player: look for somewhere less obvious
      return c;
    }
    return fallback;
  }
}
