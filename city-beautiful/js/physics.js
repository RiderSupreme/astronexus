// Collision world.
//
// Every solid thing in the Capitol is registered here once, as an axis-aligned
// box, a box turned about the vertical, or an upright cylinder. The same set
// answers four different questions: where a body can walk, what stops a
// bullet, what the infected can path around, and what shades a surface when
// ambient occlusion is baked. A uniform grid over the XZ plane keeps each
// query to the handful of solids actually nearby.

export const SOLID = { MOVE: 1, SHOT: 2, AO: 4, NAV: 8, ALL: 15 };
export const SURF = { concrete: 0, metal: 1, wood: 2, dirt: 3, foliage: 4, glass: 5, water: 6, flesh: 7, cloth: 8 };

const AABB = 0, OBB = 1, CYL = 2;
const STRIDE = 8;

export class Solids {
  constructor(capacity = 8192) {
    this.n = 0;
    this.cap = capacity;
    this.kind = new Uint8Array(capacity);
    this.flags = new Uint8Array(capacity);
    this.surf = new Uint8Array(capacity);
    this.d = new Float32Array(capacity * STRIDE);
    this.bb = new Float32Array(capacity * 4);          // footprint: minX, minZ, maxX, maxZ
    this.stamp = new Int32Array(capacity);
    this.query = 0;
    this.cell = 4; this.gx = 0; this.gz = 0; this.ox = 0; this.oz = 0; this.cells = null;
    this.hit = { t: 0, nx: 0, ny: 1, nz: 0, id: -1, surf: 0 };
  }

  _grow() {
    const cap = this.cap * 2;
    const g = (A, k) => { const a = new A.constructor(cap * k); a.set(A); return a; };
    this.kind = g(this.kind, 1); this.flags = g(this.flags, 1); this.surf = g(this.surf, 1);
    this.d = g(this.d, STRIDE); this.bb = g(this.bb, 4); this.stamp = g(this.stamp, 1);
    this.cap = cap;
  }
  _add(kind, flags, surf, a, b, c, d, e, f, g, h, minX, minZ, maxX, maxZ) {
    if (this.n >= this.cap) this._grow();
    const i = this.n++, o = i * STRIDE;
    this.kind[i] = kind; this.flags[i] = flags; this.surf[i] = surf;
    const D = this.d; D[o] = a; D[o + 1] = b; D[o + 2] = c; D[o + 3] = d; D[o + 4] = e; D[o + 5] = f; D[o + 6] = g; D[o + 7] = h;
    const B = this.bb; B[i * 4] = minX; B[i * 4 + 1] = minZ; B[i * 4 + 2] = maxX; B[i * 4 + 3] = maxZ;
    return i;
  }
  addBox(x0, y0, z0, x1, y1, z1, flags = SOLID.ALL, surf = 0) {
    if (x0 > x1) [x0, x1] = [x1, x0]; if (y0 > y1) [y0, y1] = [y1, y0]; if (z0 > z1) [z0, z1] = [z1, z0];
    return this._add(AABB, flags, surf, x0, y0, z0, x1, y1, z1, 0, 0, x0, z0, x1, z1);
  }
  // hx, hz are half extents along the box's own axes; yaw turns it about +Y.
  addOBox(cx, y0, cz, hx, y1, hz, yaw, flags = SOLID.ALL, surf = 0) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const ex = Math.abs(c) * hx + Math.abs(s) * hz, ez = Math.abs(s) * hx + Math.abs(c) * hz;
    return this._add(OBB, flags, surf, cx, y0, cz, hx, y1, hz, c, s, cx - ex, cz - ez, cx + ex, cz + ez);
  }
  addCyl(x, z, r, y0, y1, flags = SOLID.ALL, surf = 0) {
    return this._add(CYL, flags, surf, x, y0, z, r, y1, 0, 0, 0, x - r, z - r, x + r, z + r);
  }

  // Bucket every solid into the grid. Call once, after the world is built.
  build(minX, minZ, maxX, maxZ, cell = 4) {
    this.cell = cell; this.ox = minX; this.oz = minZ;
    this.gx = Math.ceil((maxX - minX) / cell); this.gz = Math.ceil((maxZ - minZ) / cell);
    const cells = this.cells = new Array(this.gx * this.gz);
    for (let i = 0; i < cells.length; i++) cells[i] = null;
    for (let i = 0; i < this.n; i++) this._insert(i);
  }
  _insert(i) {
    const B = this.bb, c = this.cell;
    const x0 = Math.max(0, Math.floor((B[i * 4] - this.ox) / c)), x1 = Math.min(this.gx - 1, Math.floor((B[i * 4 + 2] - this.ox) / c));
    const z0 = Math.max(0, Math.floor((B[i * 4 + 1] - this.oz) / c)), z1 = Math.min(this.gz - 1, Math.floor((B[i * 4 + 3] - this.oz) / c));
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      const k = z * this.gx + x;
      (this.cells[k] || (this.cells[k] = [])).push(i);
    }
  }
  // Add a solid after build() (doors that close, barricades that fall).
  addLate(id) { if (this.cells) this._insert(id); }
  disable(id) { this.flags[id] = 0; }

  // --- ray against one solid; returns entry distance or -1. Writes the entry normal to this.hit.
  _raySolid(i, ox, oy, oz, dx, dy, dz, maxT) {
    const D = this.d, o = i * STRIDE, kind = this.kind[i];
    if (kind === AABB) {
      let t0 = 0, t1 = maxT, ax = -1, sg = 0;
      if (dx > 1e-9 || dx < -1e-9) {
        const inv = 1 / dx; let a = (D[o] - ox) * inv, b = (D[o + 3] - ox) * inv; if (a > b) { const t = a; a = b; b = t; }
        if (a > t0) { t0 = a; ax = 0; sg = dx > 0 ? -1 : 1; } if (b < t1) t1 = b; if (t0 > t1) return -1;
      } else if (ox < D[o] || ox > D[o + 3]) return -1;
      if (dy > 1e-9 || dy < -1e-9) {
        const inv = 1 / dy; let a = (D[o + 1] - oy) * inv, b = (D[o + 4] - oy) * inv; if (a > b) { const t = a; a = b; b = t; }
        if (a > t0) { t0 = a; ax = 1; sg = dy > 0 ? -1 : 1; } if (b < t1) t1 = b; if (t0 > t1) return -1;
      } else if (oy < D[o + 1] || oy > D[o + 4]) return -1;
      if (dz > 1e-9 || dz < -1e-9) {
        const inv = 1 / dz; let a = (D[o + 2] - oz) * inv, b = (D[o + 5] - oz) * inv; if (a > b) { const t = a; a = b; b = t; }
        if (a > t0) { t0 = a; ax = 2; sg = dz > 0 ? -1 : 1; } if (b < t1) t1 = b; if (t0 > t1) return -1;
      } else if (oz < D[o + 2] || oz > D[o + 5]) return -1;
      this._nx = ax === 0 ? sg : 0; this._ny = ax === 1 ? sg : 0; this._nz = ax === 2 ? sg : 0;
      return t0;
    }
    if (kind === OBB) {
      const c = D[o + 6], s = D[o + 7];
      const px = ox - D[o], pz = oz - D[o + 2];
      const lx = c * px - s * pz, lz = s * px + c * pz, ldx = c * dx - s * dz, ldz = s * dx + c * dz;
      const hx = D[o + 3], hz = D[o + 5];
      let t0 = 0, t1 = maxT, ax = -1, sg = 0;
      if (ldx > 1e-9 || ldx < -1e-9) {
        const inv = 1 / ldx; let a = (-hx - lx) * inv, b = (hx - lx) * inv; if (a > b) { const t = a; a = b; b = t; }
        if (a > t0) { t0 = a; ax = 0; sg = ldx > 0 ? -1 : 1; } if (b < t1) t1 = b; if (t0 > t1) return -1;
      } else if (lx < -hx || lx > hx) return -1;
      if (dy > 1e-9 || dy < -1e-9) {
        const inv = 1 / dy; let a = (D[o + 1] - oy) * inv, b = (D[o + 4] - oy) * inv; if (a > b) { const t = a; a = b; b = t; }
        if (a > t0) { t0 = a; ax = 1; sg = dy > 0 ? -1 : 1; } if (b < t1) t1 = b; if (t0 > t1) return -1;
      } else if (oy < D[o + 1] || oy > D[o + 4]) return -1;
      if (ldz > 1e-9 || ldz < -1e-9) {
        const inv = 1 / ldz; let a = (-hz - lz) * inv, b = (hz - lz) * inv; if (a > b) { const t = a; a = b; b = t; }
        if (a > t0) { t0 = a; ax = 2; sg = ldz > 0 ? -1 : 1; } if (b < t1) t1 = b; if (t0 > t1) return -1;
      } else if (lz < -hz || lz > hz) return -1;
      // rotate the local normal back to world
      const nlx = ax === 0 ? sg : 0, nlz = ax === 2 ? sg : 0;
      this._nx = c * nlx + s * nlz; this._ny = ax === 1 ? sg : 0; this._nz = -s * nlx + c * nlz;
      return t0;
    }
    // cylinder: circle in XZ, slab in Y
    const cx = D[o], cz = D[o + 2], r = D[o + 3], y0 = D[o + 1], y1 = D[o + 4];
    const px = ox - cx, pz = oz - cz;
    const a = dx * dx + dz * dz;
    let t0 = 0, t1 = maxT, side = true;
    if (a > 1e-12) {
      const b = px * dx + pz * dz, c = px * px + pz * pz - r * r, h = b * b - a * c;
      if (h < 0) return -1;
      const sq = Math.sqrt(h); const ta = (-b - sq) / a, tb = (-b + sq) / a;
      if (ta > t0) t0 = ta; if (tb < t1) t1 = tb; if (t0 > t1) return -1;
    } else if (px * px + pz * pz > r * r) return -1;
    if (dy > 1e-9 || dy < -1e-9) {
      const inv = 1 / dy; let ya = (y0 - oy) * inv, yb = (y1 - oy) * inv; if (ya > yb) { const t = ya; ya = yb; yb = t; }
      if (ya > t0) { t0 = ya; side = false; } if (yb < t1) t1 = yb; if (t0 > t1) return -1;
    } else if (oy < y0 || oy > y1) return -1;
    if (side) { const hxp = px + dx * t0, hzp = pz + dz * t0, l = Math.hypot(hxp, hzp) || 1; this._nx = hxp / l; this._ny = 0; this._nz = hzp / l; }
    else { this._nx = 0; this._ny = dy > 0 ? -1 : 1; this._nz = 0; }
    return t0;
  }

  // Nearest hit along a ray. Returns true and fills this.hit, or false.
  raycast(ox, oy, oz, dx, dy, dz, maxT, mask = SOLID.SHOT) {
    return this._trace(ox, oy, oz, dx, dy, dz, maxT, mask, false);
  }
  // Is anything in the way at all? Cheaper: stops at the first hit.
  occluded(ox, oy, oz, dx, dy, dz, maxT, mask = SOLID.SHOT) {
    return this._trace(ox, oy, oz, dx, dy, dz, maxT, mask, true);
  }

  _trace(ox, oy, oz, dx, dy, dz, maxT, mask, any) {
    const cells = this.cells, c = this.cell, gx = this.gx, gz = this.gz;
    const q = ++this.query, stamp = this.stamp, flags = this.flags;
    let best = maxT, bestId = -1, bnx = 0, bny = 1, bnz = 0;
    // walk the grid along the ray's footprint (Amanatides & Woo)
    let fx = (ox - this.ox) / c, fz = (oz - this.oz) / c;
    let ix = Math.floor(fx), iz = Math.floor(fz);
    const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    const tdx = Math.abs(dx) > 1e-9 ? c / Math.abs(dx) : Infinity, tdz = Math.abs(dz) > 1e-9 ? c / Math.abs(dz) : Infinity;
    let tmx = Math.abs(dx) > 1e-9 ? ((dx > 0 ? ix + 1 - fx : fx - ix) * tdx) : Infinity;
    let tmz = Math.abs(dz) > 1e-9 ? ((dz > 0 ? iz + 1 - fz : fz - iz) * tdz) : Infinity;
    let tCell = 0;
    for (let guard = 0; guard < 512; guard++) {
      if (ix >= 0 && iz >= 0 && ix < gx && iz < gz) {
        const list = cells[iz * gx + ix];
        if (list) {
          for (let k = 0; k < list.length; k++) {
            const id = list[k];
            if (stamp[id] === q) continue;
            stamp[id] = q;
            if (!(flags[id] & mask)) continue;
            const t = this._raySolid(id, ox, oy, oz, dx, dy, dz, best);
            if (t >= 0 && t < best) {
              if (any) return true;
              best = t; bestId = id; bnx = this._nx; bny = this._ny; bnz = this._nz;
            }
          }
        }
      } else if ((ix < 0 && sx < 0) || (ix >= gx && sx > 0) || (iz < 0 && sz < 0) || (iz >= gz && sz > 0)) break;
      const tNext = tmx < tmz ? tmx : tmz;
      if (tNext > best || tNext > maxT) break;        // the nearest hit lies before the next cell
      if (tmx < tmz) { ix += sx; tCell = tmx; tmx += tdx; } else { iz += sz; tCell = tmz; tmz += tdz; }
      if (tCell === Infinity) break;
    }
    if (bestId < 0) return false;
    const h = this.hit; h.t = best; h.nx = bnx; h.ny = bny; h.nz = bnz; h.id = bestId; h.surf = this.surf[bestId];
    return true;
  }

  // Push a vertical capsule (circle of radius r, feet at y0, head at y1) out of whatever it overlaps.
  // pos is {x, z}; returns a bitmask: 1 if it touched anything.
  collide(pos, r, y0, y1, mask = SOLID.MOVE) {
    const c = this.cell;
    let touched = 0;
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      const cx0 = Math.max(0, Math.floor((pos.x - r - this.ox) / c)), cx1 = Math.min(this.gx - 1, Math.floor((pos.x + r - this.ox) / c));
      const cz0 = Math.max(0, Math.floor((pos.z - r - this.oz) / c)), cz1 = Math.min(this.gz - 1, Math.floor((pos.z + r - this.oz) / c));
      const q = ++this.query;
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
        const list = this.cells[cz * this.gx + cx];
        if (!list) continue;
        for (let k = 0; k < list.length; k++) {
          const id = list[k];
          if (this.stamp[id] === q) continue;
          this.stamp[id] = q;
          if (!(this.flags[id] & mask)) continue;
          const D = this.d, o = id * STRIDE, kind = this.kind[id];
          if (kind === AABB) {
            if (D[o + 4] <= y0 || D[o + 1] >= y1) continue;
            const qx = pos.x < D[o] ? D[o] : pos.x > D[o + 3] ? D[o + 3] : pos.x;
            const qz = pos.z < D[o + 2] ? D[o + 2] : pos.z > D[o + 5] ? D[o + 5] : pos.z;
            const ex = pos.x - qx, ez = pos.z - qz, d2 = ex * ex + ez * ez;
            if (d2 >= r * r) continue;
            if (d2 > 1e-10) { const d = Math.sqrt(d2), p = (r - d) / d; pos.x += ex * p; pos.z += ez * p; }
            else {
              // centre is inside: leave by the nearest face
              const l = pos.x - D[o], rr = D[o + 3] - pos.x, n = pos.z - D[o + 2], f = D[o + 5] - pos.z, m = Math.min(l, rr, n, f);
              if (m === l) pos.x = D[o] - r; else if (m === rr) pos.x = D[o + 3] + r; else if (m === n) pos.z = D[o + 2] - r; else pos.z = D[o + 5] + r;
            }
            moved = true; touched = 1;
          } else if (kind === OBB) {
            if (D[o + 4] <= y0 || D[o + 1] >= y1) continue;
            const cs = D[o + 6], sn = D[o + 7], hx = D[o + 3], hz = D[o + 5];
            const px = pos.x - D[o], pz = pos.z - D[o + 2];
            let lx = cs * px - sn * pz, lz = sn * px + cs * pz;
            const qx = lx < -hx ? -hx : lx > hx ? hx : lx, qz = lz < -hz ? -hz : lz > hz ? hz : lz;
            const ex = lx - qx, ez = lz - qz, d2 = ex * ex + ez * ez;
            if (d2 >= r * r) continue;
            if (d2 > 1e-10) { const d = Math.sqrt(d2), p = (r - d) / d; lx += ex * p; lz += ez * p; }
            else {
              const l = lx + hx, rr = hx - lx, n = lz + hz, f = hz - lz, m = Math.min(l, rr, n, f);
              if (m === l) lx = -hx - r; else if (m === rr) lx = hx + r; else if (m === n) lz = -hz - r; else lz = hz + r;
            }
            pos.x = D[o] + cs * lx + sn * lz; pos.z = D[o + 2] - sn * lx + cs * lz;
            moved = true; touched = 1;
          } else {
            if (D[o + 4] <= y0 || D[o + 1] >= y1) continue;
            const ex = pos.x - D[o], ez = pos.z - D[o + 2], rr = r + D[o + 3], d2 = ex * ex + ez * ez;
            if (d2 >= rr * rr) continue;
            const d = Math.sqrt(d2) || 1e-4, p = (rr - d) / d;
            pos.x += (d2 > 1e-10 ? ex : 1e-4) * p; pos.z += ez * p;
            moved = true; touched = 1;
          }
        }
      }
      if (!moved) break;
    }
    return touched;
  }

  // Highest top surface under (x, z) that a body with feet at yFeet could step onto. -Infinity if none.
  floorAt(x, z, yFeet, stepUp, mask = SOLID.MOVE) {
    const cx = Math.floor((x - this.ox) / this.cell), cz = Math.floor((z - this.oz) / this.cell);
    if (cx < 0 || cz < 0 || cx >= this.gx || cz >= this.gz) return -Infinity;
    const list = this.cells[cz * this.gx + cx];
    if (!list) return -Infinity;
    let best = -Infinity; const lim = yFeet + stepUp, D = this.d;
    for (let k = 0; k < list.length; k++) {
      const id = list[k];
      if (!(this.flags[id] & mask)) continue;
      const o = id * STRIDE, top = D[o + 4];
      if (top > lim || top <= best) continue;
      const kind = this.kind[id];
      if (kind === AABB) { if (x < D[o] || x > D[o + 3] || z < D[o + 2] || z > D[o + 5]) continue; }
      else if (kind === OBB) {
        const px = x - D[o], pz = z - D[o + 2], lx = D[o + 6] * px - D[o + 7] * pz, lz = D[o + 7] * px + D[o + 6] * pz;
        if (lx < -D[o + 3] || lx > D[o + 3] || lz < -D[o + 5] || lz > D[o + 5]) continue;
      } else { const ex = x - D[o], ez = z - D[o + 2]; if (ex * ex + ez * ez > D[o + 3] * D[o + 3]) continue; }
      best = top;
    }
    return best;
  }

  // Lowest underside above (x, z) between yFrom and yTo, for bumping heads. Infinity if clear.
  ceilingAt(x, z, yFrom, yTo, mask = SOLID.MOVE) {
    const cx = Math.floor((x - this.ox) / this.cell), cz = Math.floor((z - this.oz) / this.cell);
    if (cx < 0 || cz < 0 || cx >= this.gx || cz >= this.gz) return Infinity;
    const list = this.cells[cz * this.gx + cx];
    if (!list) return Infinity;
    let best = Infinity; const D = this.d;
    for (let k = 0; k < list.length; k++) {
      const id = list[k];
      if (!(this.flags[id] & mask)) continue;
      const o = id * STRIDE, bot = D[o + 1];
      if (bot < yFrom || bot > yTo || bot >= best) continue;
      const kind = this.kind[id];
      if (kind === AABB) { if (x < D[o] || x > D[o + 3] || z < D[o + 2] || z > D[o + 5]) continue; }
      else if (kind === OBB) {
        const px = x - D[o], pz = z - D[o + 2], lx = D[o + 6] * px - D[o + 7] * pz, lz = D[o + 7] * px + D[o + 6] * pz;
        if (lx < -D[o + 3] || lx > D[o + 3] || lz < -D[o + 5] || lz > D[o + 5]) continue;
      } else { const ex = x - D[o], ez = z - D[o + 2]; if (ex * ex + ez * ez > D[o + 3] * D[o + 3]) continue; }
      best = bot;
    }
    return best;
  }

  // Does a solid block a walker's body anywhere in the square cell centred on (x, z)?
  blocksWalker(x, z, half, y0, y1, mask = SOLID.NAV) {
    const c = this.cell;
    const cx0 = Math.max(0, Math.floor((x - half - this.ox) / c)), cx1 = Math.min(this.gx - 1, Math.floor((x + half - this.ox) / c));
    const cz0 = Math.max(0, Math.floor((z - half - this.oz) / c)), cz1 = Math.min(this.gz - 1, Math.floor((z + half - this.oz) / c));
    const D = this.d;
    for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
      const list = this.cells[cz * this.gx + cx];
      if (!list) continue;
      for (let k = 0; k < list.length; k++) {
        const id = list[k];
        if (!(this.flags[id] & mask)) continue;
        const o = id * STRIDE;
        if (D[o + 4] <= y0 || D[o + 1] >= y1) continue;
        const kind = this.kind[id];
        if (kind === AABB) { if (x + half <= D[o] || x - half >= D[o + 3] || z + half <= D[o + 2] || z - half >= D[o + 5]) continue; return true; }
        if (kind === OBB) {
          const px = x - D[o], pz = z - D[o + 2], lx = D[o + 6] * px - D[o + 7] * pz, lz = D[o + 7] * px + D[o + 6] * pz;
          const h = half * 1.2;
          if (lx < -D[o + 3] - h || lx > D[o + 3] + h || lz < -D[o + 5] - h || lz > D[o + 5] + h) continue; return true;
        }
        const ex = x - D[o], ez = z - D[o + 2], rr = D[o + 3] + half; if (ex * ex + ez * ez > rr * rr) continue; return true;
      }
    }
    return false;
  }
}
