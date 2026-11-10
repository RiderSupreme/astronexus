// Geometry builder.
//
// The Capitol is assembled from code: a building is a few hundred calls to
// box(), sweep() and lathe(). Each call does two things at once. It appends
// triangles to a batch (one draw call per material per building), and it
// registers the same shape with the collision world, so what you see is
// exactly what stops you, stops bullets and casts ambient shade.
import { THREE } from './lib/three.js';
import { SOLID, SURF } from './physics.js';

class FBuf {
  constructor(stride, cap = 2048) { this.stride = stride; this.a = new Float32Array(cap * stride); this.n = 0; }
  reserve(count) {
    const need = (this.n + count) * this.stride;
    if (need <= this.a.length) return;
    let cap = this.a.length; while (cap < need) cap *= 2;
    const b = new Float32Array(cap); b.set(this.a.subarray(0, this.n * this.stride)); this.a = b;
  }
}
class IBuf {
  constructor(cap = 4096) { this.a = new Uint32Array(cap); this.n = 0; }
  reserve(count) {
    const need = this.n + count;
    if (need <= this.a.length) return;
    let cap = this.a.length; while (cap < need) cap *= 2;
    const b = new Uint32Array(cap); b.set(this.a.subarray(0, this.n)); this.a = b;
  }
}

const DEFAULTS = {
  mat: 'concrete',        // batch / material key
  color: [1, 1, 1],       // tint, or paint colour when paint > 0 (linear RGB)
  paint: 0,               // 0 bare .. 1 freshly painted
  grow: 0,                // overgrowth bias
  vboards: false,         // shuttering boards run vertically
  seg: 2.4,               // longest edge before a face is subdivided (finer = smoother baked shade)
  solid: SOLID.ALL,       // collision flags, 0 for decoration
  surf: SURF.concrete,    // what a bullet finds
  faces: 'xXyYzZ',        // which faces of a box to emit: lower case = negative side
  ao: true,               // receive baked ambient occlusion
  shadow: true,           // cast a shadow
};

const _m = new THREE.Matrix4(), _v = new THREE.Vector3(), _n = new THREE.Vector3(), _q = new THREE.Quaternion();

export class Builder {
  constructor(solids) {
    this.solids = solids;
    this.batches = new Map();
    this.group = 'world';
    this.def = { ...DEFAULTS };
    this.stack = [];
  }

  // Scoped defaults: b.with({ mat: 'metal', color: RED }, () => { ... })
  with(opts, fn) { this.stack.push(this.def); this.def = { ...this.def, ...opts }; try { fn(); } finally { this.def = this.stack.pop(); } }
  setGroup(name) { this.group = name; }
  _o(opts) { return opts ? { ...this.def, ...opts } : this.def; }

  _batch(o) {
    const key = o.mat + '|' + this.group + (o.shadow ? '' : '|ns');
    let b = this.batches.get(key);
    if (!b) {
      b = { key, mat: o.mat, group: this.group, shadow: o.shadow, pos: new FBuf(3), nrm: new FBuf(3), col: new FBuf(3), surf: new FBuf(4), idx: new IBuf(), aoMask: [] };
      this.batches.set(key, b);
    }
    return b;
  }

  _vert(b, o, x, y, z, nx, ny, nz) {
    const i = b.pos.n;
    let k = i * 3; const P = b.pos.a, N = b.nrm.a, C = b.col.a, S = b.surf.a;
    P[k] = x; P[k + 1] = y; P[k + 2] = z; N[k] = nx; N[k + 1] = ny; N[k + 2] = nz;
    C[k] = o.color[0]; C[k + 1] = o.color[1]; C[k + 2] = o.color[2];
    k = i * 4; S[k] = o.ao ? -1 : 1; S[k + 1] = o.paint; S[k + 2] = o.grow; S[k + 3] = o.vboards ? 1 : 0;
    b.pos.n++; b.nrm.n++; b.col.n++; b.surf.n++;
    return i;
  }
  _reserve(b, verts, indices) { b.pos.reserve(verts); b.nrm.reserve(verts); b.col.reserve(verts); b.surf.reserve(verts); b.idx.reserve(indices); }

  // A flat parallelogram: origin o, edges u and v, with u x v pointing out of the surface.
  face(ox, oy, oz, ux, uy, uz, vx, vy, vz, opts) {
    const o = this._o(opts), b = this._batch(o);
    const lu = Math.hypot(ux, uy, uz), lv = Math.hypot(vx, vy, vz);
    if (lu < 1e-6 || lv < 1e-6) return;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
    const nu = Math.max(1, Math.ceil(lu / o.seg)), nv = Math.max(1, Math.ceil(lv / o.seg));
    this._reserve(b, (nu + 1) * (nv + 1), nu * nv * 6);
    const base = b.pos.n;
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
      const s = i / nu, t = j / nv;
      this._vert(b, o, ox + ux * s + vx * t, oy + uy * s + vy * t, oz + uz * s + vz * t, nx, ny, nz);
    }
    const I = b.idx.a; let k = b.idx.n;
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const a = base + j * (nu + 1) + i, c = a + nu + 1;
      I[k++] = a; I[k++] = a + 1; I[k++] = c + 1; I[k++] = a; I[k++] = c + 1; I[k++] = c;
    }
    b.idx.n = k;
  }

  // Axis-aligned box from one corner to the opposite corner.
  box(x0, y0, z0, x1, y1, z1, opts) {
    const o = this._o(opts);
    if (x0 > x1) [x0, x1] = [x1, x0]; if (y0 > y1) [y0, y1] = [y1, y0]; if (z0 > z1) [z0, z1] = [z1, z0];
    const W = x1 - x0, H = y1 - y0, D = z1 - z0, f = o.faces;
    if (f.includes('X')) this.face(x1, y0, z0, 0, H, 0, 0, 0, D, o);
    if (f.includes('x')) this.face(x0, y0, z0, 0, 0, D, 0, H, 0, o);
    if (f.includes('Y')) this.face(x0, y1, z0, 0, 0, D, W, 0, 0, o);
    if (f.includes('y')) this.face(x0, y0, z0, W, 0, 0, 0, 0, D, o);
    if (f.includes('Z')) this.face(x0, y0, z1, W, 0, 0, 0, H, 0, o);
    if (f.includes('z')) this.face(x0, y0, z0, 0, H, 0, W, 0, 0, o);
    if (o.solid) return this.solids.addBox(x0, y0, z0, x1, y1, z1, o.solid, o.surf);
    return -1;
  }
  // Same, given a centre and a size.
  cbox(cx, cy, cz, sx, sy, sz, opts) { return this.box(cx - sx / 2, cy - sy / 2, cz - sz / 2, cx + sx / 2, cy + sy / 2, cz + sz / 2, opts); }

  // Box turned about the vertical axis. (cx, cz) is its centre, y0..y1 its height span.
  obox(cx, y0, cz, sx, y1, sz, yaw, opts) {
    const o = this._o(opts);
    const c = Math.cos(yaw), s = Math.sin(yaw), hx = sx / 2, hz = sz / 2, H = y1 - y0, f = o.faces;
    // local axes in world space
    const ax = c, az = -s, bx = s, bz = c;      // local +X and local +Z
    const P = (lx, lz) => [cx + ax * lx + bx * lz, cz + az * lx + bz * lz];
    const [p00x, p00z] = P(-hx, -hz), [p10x, p10z] = P(hx, -hz), [p01x, p01z] = P(-hx, hz);
    const ux = ax * sx, uz = az * sx, wx = bx * sz, wz = bz * sz;
    if (f.includes('X')) this.face(p10x, y0, p10z, 0, H, 0, wx, 0, wz, o);
    if (f.includes('x')) this.face(p00x, y0, p00z, wx, 0, wz, 0, H, 0, o);
    if (f.includes('Y')) this.face(p00x, y1, p00z, wx, 0, wz, ux, 0, uz, o);
    if (f.includes('y')) this.face(p00x, y0, p00z, ux, 0, uz, wx, 0, wz, o);
    if (f.includes('Z')) this.face(p01x, y0, p01z, ux, 0, uz, 0, H, 0, o);
    if (f.includes('z')) this.face(p00x, y0, p00z, 0, H, 0, ux, 0, uz, o);
    if (o.solid) return this.solids.addOBox(cx, y0, cz, hx, y1, hz, yaw, o.solid, o.surf);
    return -1;
  }

  // Box under an arbitrary transform (fallen slabs, tilted wrecks). Collides as its world-aligned bounds.
  tbox(matrix, sx, sy, sz, opts) {
    const o = this._o(opts);
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const e = matrix.elements;
    const X = [e[0], e[1], e[2]], Y = [e[4], e[5], e[6]], Z = [e[8], e[9], e[10]], T = [e[12], e[13], e[14]];
    const C = (a, b, c) => [T[0] + X[0] * a + Y[0] * b + Z[0] * c, T[1] + X[1] * a + Y[1] * b + Z[1] * c, T[2] + X[2] * a + Y[2] * b + Z[2] * c];
    const F = (p, u, v, su, sv) => this.face(p[0], p[1], p[2], u[0] * su, u[1] * su, u[2] * su, v[0] * sv, v[1] * sv, v[2] * sv, o);
    F(C(hx, -hy, -hz), Y, Z, sy, sz); F(C(-hx, -hy, -hz), Z, Y, sz, sy);
    F(C(-hx, hy, -hz), Z, X, sz, sx); F(C(-hx, -hy, -hz), X, Z, sx, sz);
    F(C(-hx, -hy, hz), X, Y, sx, sy); F(C(-hx, -hy, -hz), Y, X, sy, sx);
    if (o.solid) {
      let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const a of [-hx, hx]) for (const b of [-hy, hy]) for (const c of [-hz, hz]) {
        const p = C(a, b, c);
        minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]);
      }
      // shrink a little: the bounds of a tilted box overstate it
      const sh = 0.12;
      return this.solids.addBox(minX + (maxX - minX) * sh, minY, minZ + (maxZ - minZ) * sh, maxX - (maxX - minX) * sh, maxY - (maxY - minY) * sh * 0.5, maxZ - (maxZ - minZ) * sh, o.solid, o.surf);
    }
    return -1;
  }

  // Upright prism with a regular n-gon section: columns, posts, drums. Smooth-shaded sides.
  cylinder(cx, cz, y0, y1, r, opts, sides = 14, r1 = r) {
    const o = this._o(opts), b = this._batch(o);
    const nv = Math.max(1, Math.ceil((y1 - y0) / o.seg));
    this._reserve(b, (sides + 1) * (nv + 1) + 2 * (sides + 1), sides * nv * 6 + sides * 6);
    const base = b.pos.n;
    const slope = (r - r1) / Math.max(1e-6, y1 - y0);
    for (let j = 0; j <= nv; j++) {
      const t = j / nv, y = y0 + (y1 - y0) * t, rr = r + (r1 - r) * t;
      for (let i = 0; i <= sides; i++) {
        const a = (i / sides) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
        const nl = Math.hypot(1, slope);
        this._vert(b, o, cx + ca * rr, y, cz + sa * rr, ca / nl, slope / nl, sa / nl);
      }
    }
    const I = b.idx.a; let k = b.idx.n;
    for (let j = 0; j < nv; j++) for (let i = 0; i < sides; i++) {
      const a = base + j * (sides + 1) + i, c = a + sides + 1;
      I[k++] = a; I[k++] = c; I[k++] = c + 1; I[k++] = a; I[k++] = c + 1; I[k++] = a + 1;
    }
    // caps
    for (const [y, ny, rr] of [[y1, 1, r1], [y0, -1, r]]) {
      if (!o.faces.includes(ny > 0 ? 'Y' : 'y')) continue;
      const c0 = this._vert(b, o, cx, y, cz, 0, ny, 0);
      for (let i = 0; i <= sides; i++) { const a = (i / sides) * Math.PI * 2; this._vert(b, o, cx + Math.cos(a) * rr, y, cz + Math.sin(a) * rr, 0, ny, 0); }
      for (let i = 0; i < sides; i++) { if (ny > 0) { I[k++] = c0; I[k++] = c0 + i + 2; I[k++] = c0 + i + 1; } else { I[k++] = c0; I[k++] = c0 + i + 1; I[k++] = c0 + i + 2; } }
    }
    b.idx.n = k;
    if (o.solid) return this.solids.addCyl(cx, cz, Math.max(r, r1), y0, y1, o.solid, o.surf);
    return -1;
  }

  // Sweep a 2D outline through space. Each outline point (a, b) lands at origin + U*a + V*b,
  // and the whole outline is extruded along W. Used for the curved canopies and vaults.
  // closed: join the last point to the first. smooth: average normals along the outline. caps: fill both ends.
  sweep(outline, origin, U, V, W, opts, { closed = false, smooth = true, caps = false, flip = false } = {}) {
    const o = this._o(opts), b = this._batch(o);
    const n = outline.length, wl = Math.hypot(W[0], W[1], W[2]);
    const nw = Math.max(1, Math.ceil(wl / o.seg));
    const P = outline.map(([a, c]) => [origin[0] + U[0] * a + V[0] * c, origin[1] + U[1] * a + V[1] * c, origin[2] + U[2] * a + V[2] * c]);
    // per-segment normals: perpendicular to both the segment and the sweep direction
    const segN = [];
    const count = closed ? n : n - 1;
    for (let i = 0; i < count; i++) {
      const p = P[i], q = P[(i + 1) % n];
      const ex = q[0] - p[0], ey = q[1] - p[1], ez = q[2] - p[2];
      let nx = ey * W[2] - ez * W[1], ny = ez * W[0] - ex * W[2], nz = ex * W[1] - ey * W[0];
      const l = Math.hypot(nx, ny, nz) || 1; const s = flip ? -1 : 1;
      segN.push([nx / l * s, ny / l * s, nz / l * s]);
    }
    const vertN = i => {
      if (!smooth) return null;
      const a = segN[(i - 1 + count) % count], c = segN[i % count];
      const pa = (closed || i > 0) ? a : c, pc = (closed || i < n - 1) ? c : a;
      const x = pa[0] + pc[0], y = pa[1] + pc[1], z = pa[2] + pc[2], l = Math.hypot(x, y, z) || 1;
      return [x / l, y / l, z / l];
    };
    this._reserve(b, count * 2 * (nw + 1) + 2 * n, count * nw * 6 + 2 * n * 3);
    const I = b.idx.a;
    for (let i = 0; i < count; i++) {
      const p = P[i], q = P[(i + 1) % n];
      const n0 = vertN(i) || segN[i], n1 = vertN((i + 1) % (closed ? n : n + 1)) || segN[i];
      const base = b.pos.n;
      for (let j = 0; j <= nw; j++) {
        const t = j / nw;
        this._vert(b, o, p[0] + W[0] * t, p[1] + W[1] * t, p[2] + W[2] * t, n0[0], n0[1], n0[2]);
        this._vert(b, o, q[0] + W[0] * t, q[1] + W[1] * t, q[2] + W[2] * t, n1[0], n1[1], n1[2]);
      }
      let k = b.idx.n;
      for (let j = 0; j < nw; j++) {
        const a = base + j * 2, c = a + 2;
        if (flip) { I[k++] = a; I[k++] = c + 1; I[k++] = a + 1; I[k++] = a; I[k++] = c; I[k++] = c + 1; }
        else { I[k++] = a; I[k++] = a + 1; I[k++] = c + 1; I[k++] = a; I[k++] = c + 1; I[k++] = c; }
      }
      b.idx.n = k;
    }
    if (caps && closed) {
      const tris = THREE.ShapeUtils.triangulateShape(outline.map(([a, c]) => new THREE.Vector2(a, c)), []);
      let cx = U[1] * V[2] - U[2] * V[1], cy = U[2] * V[0] - U[0] * V[2], cz = U[0] * V[1] - U[1] * V[0];
      const cl = Math.hypot(cx, cy, cz) || 1; cx /= cl; cy /= cl; cz /= cl;
      const dir = (cx * W[0] + cy * W[1] + cz * W[2]) > 0 ? 1 : -1;       // does U x V point along the sweep?
      for (const end of [0, 1]) {
        const base = b.pos.n, s = end ? dir : -dir;
        for (const p of P) this._vert(b, o, p[0] + W[0] * end, p[1] + W[1] * end, p[2] + W[2] * end, cx * s, cy * s, cz * s);
        let k = b.idx.n; b.idx.reserve(tris.length * 3);
        const II = b.idx.a;
        for (const t of tris) { if (s > 0) { II[k++] = base + t[0]; II[k++] = base + t[1]; II[k++] = base + t[2]; } else { II[k++] = base + t[0]; II[k++] = base + t[2]; II[k++] = base + t[1]; } }
        b.idx.n = k;
      }
    }
  }

  // Surface of revolution about a vertical axis. profile: [[radius, y], ...] bottom to top.
  // warp(p, theta): optional, may move each vertex (the Assembly tower's slanted crown).
  lathe(cx, cz, profile, opts, { sides = 40, warp = null, inside = false } = {}) {
    const o = this._o(opts), b = this._batch(o);
    const rows = profile.length;
    this._reserve(b, rows * (sides + 1), (rows - 1) * sides * 6);
    const base = b.pos.n, tmp = [0, 0, 0];
    for (let j = 0; j < rows; j++) {
      const [r, y] = profile[j];
      const p0 = profile[Math.max(0, j - 1)], p1 = profile[Math.min(rows - 1, j + 1)];
      let tr = p1[0] - p0[0], ty = p1[1] - p0[1]; const tl = Math.hypot(tr, ty) || 1; tr /= tl; ty /= tl;
      const nr = ty * (inside ? -1 : 1), nyv = -tr * (inside ? -1 : 1);
      for (let i = 0; i <= sides; i++) {
        const a = (i / sides) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
        tmp[0] = cx + ca * r; tmp[1] = y; tmp[2] = cz + sa * r;
        if (warp) warp(tmp, a, j / (rows - 1));
        this._vert(b, o, tmp[0], tmp[1], tmp[2], ca * nr, nyv, sa * nr);
      }
    }
    const I = b.idx.a; let k = b.idx.n;
    for (let j = 0; j < rows - 1; j++) for (let i = 0; i < sides; i++) {
      const a = base + j * (sides + 1) + i, c = a + sides + 1;
      if (inside) { I[k++] = a; I[k++] = a + 1; I[k++] = c + 1; I[k++] = a; I[k++] = c + 1; I[k++] = c; }
      else { I[k++] = a; I[k++] = c; I[k++] = c + 1; I[k++] = a; I[k++] = c + 1; I[k++] = a + 1; }
    }
    b.idx.n = k;
  }

  // Append any three.js geometry under a transform.
  add(geometry, matrix, opts) {
    const o = this._o(opts), b = this._batch(o);
    const g = geometry.index ? geometry : geometry.clone();
    const pos = g.attributes.position, nrm = g.attributes.normal, n = pos.count;
    const idx = g.index;
    this._reserve(b, n, idx ? idx.count : n);
    const base = b.pos.n;
    const nm = new THREE.Matrix3().getNormalMatrix(matrix || _m.identity());
    for (let i = 0; i < n; i++) {
      _v.fromBufferAttribute(pos, i); if (matrix) _v.applyMatrix4(matrix);
      _n.fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize();
      this._vert(b, o, _v.x, _v.y, _v.z, _n.x, _n.y, _n.z);
    }
    const I = b.idx.a; let k = b.idx.n;
    if (idx) for (let i = 0; i < idx.count; i++) I[k++] = base + idx.getX(i);
    else for (let i = 0; i < n; i++) I[k++] = base + i;
    b.idx.n = k;
  }

  get vertexCount() { let n = 0; for (const b of this.batches.values()) n += b.pos.n; return n; }
  get triangleCount() { let n = 0; for (const b of this.batches.values()) n += b.idx.n / 3; return n; }

  // Turn every batch into a mesh. materials: { key: THREE.Material }.
  finish(materials) {
    const meshes = [];
    for (const b of this.batches.values()) {
      const material = materials[b.mat];
      if (!material) { console.warn('No material for batch', b.mat); continue; }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(b.pos.a.slice(0, b.pos.n * 3), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(b.nrm.a.slice(0, b.nrm.n * 3), 3));
      g.setAttribute('color', new THREE.BufferAttribute(b.col.a.slice(0, b.col.n * 3), 3));
      g.setAttribute('aSurf', new THREE.BufferAttribute(b.surf.a.slice(0, b.surf.n * 4), 4));
      const I = b.idx.a.subarray(0, b.idx.n);
      g.setIndex(new THREE.BufferAttribute(b.pos.n > 65535 ? new Uint32Array(I) : new Uint16Array(I), 1));
      g.computeBoundingSphere(); g.computeBoundingBox();
      const mesh = new THREE.Mesh(g, material);
      mesh.name = b.key; mesh.castShadow = b.shadow; mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      meshes.push(mesh);
    }
    return meshes;
  }
}

// ---------------------------------------------------------------------------
// Baked ambient occlusion.
//
// For each vertex a fan of cosine-weighted rays is cast into the hemisphere
// above its surface; the fraction that escapes (near hits counting more than
// far ones) is how much sky that point can see. Stored per vertex, it dims
// only the ambient light, which is what makes a brise-soleil cell or the
// underside of a canopy read as deep.
const RAYS = 12;
const HEMI = (() => {
  const d = [];
  for (let k = 0; k < RAYS; k++) {
    const u = (k + 0.5) / RAYS, r = Math.sqrt(u), phi = k * 2.399963229728653;
    d.push([r * Math.cos(phi), r * Math.sin(phi), Math.sqrt(1 - u)]);
  }
  return d;
})();

// groundAt(x, z): terrain height. Yields to the browser through `slicer` so the loading bar keeps moving.
export async function bakeAO(builder, solids, groundAt, slicer, onProgress, maxDist = 22) {
  const total = builder.vertexCount; let done = 0;
  const cache = new Map();
  for (const b of builder.batches.values()) {
    const P = b.pos.a, N = b.nrm.a, S = b.surf.a, n = b.pos.n;
    for (let i = 0; i < n; i++) {
      if (S[i * 4] >= 0) continue;                 // this vertex opted out
      const px = P[i * 3], py = P[i * 3 + 1], pz = P[i * 3 + 2];
      const nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2];
      const key = Math.round(px * 20) + ',' + Math.round(py * 20) + ',' + Math.round(pz * 20) + ',' + Math.round(nx * 4) + ',' + Math.round(ny * 4) + ',' + Math.round(nz * 4);
      let ao = cache.get(key);
      if (ao === undefined) {
        // tangent frame
        let tx, ty, tz;
        if (Math.abs(ny) < 0.9) { tx = nz; ty = 0; tz = -nx; } else { tx = 1; ty = 0; tz = 0; }
        const d = tx * nx + ty * ny + tz * nz; tx -= nx * d; ty -= ny * d; tz -= nz * d;
        const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
        const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
        const ox = px + nx * 0.03, oy = py + ny * 0.03, oz = pz + nz * 0.03;
        const ground = groundAt(px, pz);
        let occ = 0;
        for (let k = 0; k < RAYS; k++) {
          const h = HEMI[k];
          const dx = tx * h[0] + bx * h[1] + nx * h[2], dy = ty * h[0] + by * h[1] + ny * h[2], dz = tz * h[0] + bz * h[1] + nz * h[2];
          let t = maxDist, hit = false;
          if (dy < -1e-3 && oy >= ground - 0.02) { const tg = (oy - ground) / -dy; if (tg < t) { t = tg; hit = true; } }
          if (solids.raycast(ox, oy, oz, dx, dy, dz, t, SOLID.AO)) { t = solids.hit.t; hit = true; }
          if (hit) { const f = t / maxDist; occ += 1 - f * f; }
        }
        ao = Math.max(0.06, 1 - occ / RAYS);
        cache.set(key, ao);
      }
      S[i * 4] = ao;
      if ((++done & 1023) === 0) { await slicer.tick(); if (onProgress) onProgress(done / total); }
    }
  }
}
