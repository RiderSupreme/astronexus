// The Capitol Complex, sixty monsoons after the evacuation.
//
// Each function below is a recipe for one landmark, written against the
// geometry builder. Dimensions are in metres and loosely follow the real
// buildings, with the whole ensemble pulled closer together than the real
// esplanade (which is nearly half a kilometre across) so it plays well on foot.
import { THREE } from './lib/three.js';
import { SOLID, SURF } from './physics.js';

// Le Corbusier's colours for the High Court piers, as paint that has had a hard life. Linear RGB.
export const PAINT = {
  green: [0.107, 0.342, 0.147], yellow: [0.85, 0.57, 0.05], red: [0.71, 0.147, 0.089],
  blue: [0.07, 0.2, 0.47], white: [0.78, 0.76, 0.7], black: [0.035, 0.035, 0.035], khaki: [0.33, 0.29, 0.17], olive: [0.16, 0.19, 0.09],
};
const GLASS = [0.035, 0.045, 0.055];
const DARK = [0.012, 0.012, 0.012];
const SHOT_AO = SOLID.SHOT | SOLID.AO;

// A brise-soleil: a deep grid of concrete blades standing off a wall to break the sun.
// face: which way the wall looks ('x+', 'x-', 'z+', 'z-'); at: the wall's plane; a0..a1: the run along it.
function brise(b, { face, at, a0, a1, y0, y1, depth = 1.6, bay = 3, storey = 3.75, fin = 0.16, slab = 0.2, glass = true, skip = null, seg = 1.7, finEvery = 1 }) {
  const ax = face[0], dir = face[1] === '+' ? 1 : -1;
  const out = at + dir * depth, lo = Math.min(at, out), hi = Math.max(at, out);
  const nb = Math.max(1, Math.round((a1 - a0) / bay)), bw = (a1 - a0) / nb;
  const ns = Math.max(1, Math.round((y1 - y0) / storey)), sh = (y1 - y0) / ns;
  const back = ax === 'x' ? (dir > 0 ? 'x' : 'X') : (dir > 0 ? 'z' : 'Z');
  const faces = 'xXyYzZ'.replace(back, '');
  for (let i = 0; i <= nb; i += finEvery) {
    if (skip && skip(i, -1)) continue;
    const a = a0 + i * bw;
    if (ax === 'x') b.box(lo, y0, a - fin / 2, hi, y1, a + fin / 2, { seg, vboards: true, faces });
    else b.box(a - fin / 2, y0, lo, a + fin / 2, y1, hi, { seg, vboards: true, faces });
  }
  const so = at + dir * (depth - 0.06), slo = Math.min(at, so), shi = Math.max(at, so);
  for (let j = 0; j <= ns; j++) {
    if (skip && skip(-1, j)) continue;
    const y = y0 + j * sh;
    const ya = j === 0 ? y : y - slab / 2, yb = j === 0 ? y + slab : y + slab / 2;
    if (ax === 'x') b.box(slo, ya, a0, shi, yb, a1, { seg: seg * 1.4, faces });
    else b.box(a0, ya, slo, a1, yb, shi, { seg: seg * 1.4, faces });
  }
  if (glass) {
    const g = { mat: 'glass', color: GLASS, solid: 0, seg: 3, shadow: false };
    const p = at + dir * 0.04, L = a1 - a0, H = y1 - y0;
    if (face === 'x+') b.face(p, y0, a0, 0, H, 0, 0, 0, L, g);
    else if (face === 'x-') b.face(p, y0, a0, 0, 0, L, 0, H, 0, g);
    else if (face === 'z+') b.face(a0, y0, p, L, 0, 0, 0, H, 0, g);
    else b.face(a0, y0, p, 0, H, 0, L, 0, 0, g);
  }
}

// A run of steps climbing along +axis from y0 to y1. Walked as a ramp, seen as stairs.
function stairs(w, x0, z0, x1, z1, axis, y0, y1, opts = {}) {
  const b = w.b, n = Math.max(1, Math.round(Math.abs(y1 - y0) / 0.17));
  w.ramps.push({ x0, z0, x1, z1, axis, y0, y1 });
  for (let i = 0; i < n; i++) {
    const t0 = i / n, t1 = (i + 1) / n, yt = y0 + (y1 - y0) * t1, yb = Math.min(y0, y1) - 0.02;
    const o = { solid: SHOT_AO, seg: 4, ...opts };
    if (axis === 'x') b.box(x0 + (x1 - x0) * t0, yb, z0, x0 + (x1 - x0) * t1, y1 > y0 ? yt : y0 + (y1 - y0) * t0, z1, o);
    else b.box(x0, yb, z0 + (z1 - z0) * t0, x1, y1 > y0 ? yt : y0 + (y1 - y0) * t0, z0 + (z1 - z0) * t1, o);
  }
}

// A rectangular basin: rim, bed and a record for the water surface.
function pool(w, x0, z0, x1, z1, { rim = 0.5, bed = -0.45, level = -0.12, lip = 0.16 } = {}) {
  const b = w.b;
  w.holes.push({ x0, z0, x1, z1 });
  w.flats.push({ x0, z0, x1, z1, y: bed });
  w.pools.push({ x0, z0, x1, z1, level, bed });
  w.level.push({ x0: x0 - 4, z0: z0 - 4, x1: x1 + 4, z1: z1 + 4 });
  const o = { solid: 0, grow: 0.35, seg: 2.5 };
  b.face(x0, bed, z0, 0, 0, z1 - z0, x1 - x0, 0, 0, { ...o, color: [0.55, 0.6, 0.5] });       // silted bed
  b.face(x0, bed, z0, x1 - x0, 0, 0, 0, -bed, 0, o); b.face(x0, bed, z1, 0, -bed, 0, x1 - x0, 0, 0, o);   // inner walls
  b.face(x0, bed, z0, 0, -bed, 0, 0, 0, z1 - z0, o); b.face(x1, bed, z0, 0, 0, z1 - z0, 0, -bed, 0, o);
  // a low kerb all round: low enough to step over
  const k = { solid: SHOT_AO, grow: 0.3, seg: 3 };       // a kerb, not a wall: anything can wade in and out
  b.box(x0 - rim, 0, z0 - rim, x1 + rim, lip, z0, k); b.box(x0 - rim, 0, z1, x1 + rim, lip, z1 + rim, k);
  b.box(x0 - rim, 0, z0, x0, lip, z1, k); b.box(x1, 0, z0, x1 + rim, lip, z1, k);
}

// ---------------------------------------------------------------------------
// PALACE OF ASSEMBLY. West side of the esplanade, portico facing east across its pool.
function assembly(w) {
  const b = w.b; b.setGroup('assembly');
  const X0 = -152, X1 = -92, Z0 = -32, Z1 = 32, H = 15, T = 0.7, F = 0.45;       // F: floor level of plinth and hall
  w.level.push({ x0: X0 - 10, z0: Z0 - 10, x1: -56, z1: Z1 + 10 });
  w.paved.push({ x0: -96, z0: -42, x1: -56, z1: 42, soft: 8 });

  // plinth under the hall and the portico; three steps down to the plaza along its east edge
  b.box(X0, 0, Z0, -77.6, F, Z1, { seg: 3 });
  stairs(w, -77.6, Z0, -76.4, Z1, 'x', F, 0, { seg: 6 });

  // --- shell
  b.box(X0, F, Z0, X1, H, Z0 + T);                                  // north wall
  b.box(X0, F, Z1 - T, -121, H, Z1); b.box(-111, F, Z1 - T, X1, H, Z1);   // south wall, breached
  b.box(-121, 7.2, Z1 - T, -117.5, H, Z1); b.box(-117.5, 8.4, Z1 - T, -113, H, Z1); b.box(-113, 6.4, Z1 - T, -111, H, Z1);
  b.box(X1 - T, F, Z0, X1, H, -3.7); b.box(X1 - T, F, 3.7, X1, H, Z1); b.box(X1 - T, 7.9, -3.7, X1, H, 3.7);   // portico wall with the great doorway
  b.box(X0, F, Z0, X0 + T, 3.4, Z1);                                 // west wall: a low spandrel, open above between piers
  for (let z = Z0; z <= Z1 - 4; z += 8) b.box(X0, 3.4, z, X0 + T, H, z + 1.2);
  b.box(X0, 13.6, Z0, X0 + T, H, Z1);
  b.box(X0 - 0.3, H, Z0 - 0.3, X1 + 0.3, H + 0.55, Z1 + 0.3, { seg: 4 });   // roof
  // parapet
  b.box(X0 - 0.3, H + 0.55, Z0 - 0.3, X1 + 0.3, H + 1.5, Z0 + 0.1); b.box(X0 - 0.3, H + 0.55, Z1 - 0.1, X1 + 0.3, H + 1.5, Z1 + 0.3);
  b.box(X0 - 0.3, H + 0.55, Z0, X0 + 0.1, H + 1.5, Z1); b.box(X1 - 0.1, H + 0.55, Z0, X1 + 0.3, H + 1.5, Z1);

  // --- sun-breakers on three sides
  brise(b, { face: 'z-', at: Z0, a0: X0, a1: X1, y0: F, y1: H, depth: 1.9, bay: 3, storey: 3.64 });
  brise(b, { face: 'z+', at: Z1, a0: X0, a1: -121.5, y0: F, y1: H, depth: 1.9, bay: 3, storey: 3.64 });
  brise(b, { face: 'z+', at: Z1, a0: -110.5, a1: X1, y0: F, y1: H, depth: 1.9, bay: 3, storey: 3.64 });
  brise(b, { face: 'x-', at: X0, a0: Z0, a1: Z1, y0: F, y1: H, depth: 2.2, bay: 2.667, storey: 3.64, glass: false });
  // the breach: a bay of the south front lies where it fell
  for (const [x, z, sx, sz, yaw, h] of [[-118, 35.5, 5.5, 2.2, 0.3, 1.1], [-113.5, 37.2, 3.4, 2.6, -0.5, 0.8], [-116, 39.5, 2.6, 1.8, 1.1, 0.6], [-120.5, 33.6, 2.2, 3, 0.1, 1.6], [-112, 33.4, 1.6, 2.2, 0.7, 1.9]])
    b.obox(x, 0, z, sx, h, sz, yaw, { seg: 1.5, grow: 0.25 });
  b.tbox(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.5, 0.25, 0.12)).setPosition(-115.5, 1.6, 34.4), 7, 0.5, 4.5, { seg: 1.5 });

  // --- the forum: a dark hall of mushroom columns round the drum of the chamber
  const CX = -128, CZ = -2, CR = 10.5;
  b.cylinder(CX, CZ, F, H, CR, { seg: 2.2, faces: '' }, 44);
  for (let x = -146; x <= -98; x += 8) for (let z = -26; z <= 26; z += 8.667) {
    if (Math.hypot(x - CX, z - CZ) < CR + 2.2) continue;
    b.cylinder(x, z, F, H - 1.1, 0.42, { seg: 2.4, faces: '' }, 12);
    b.cylinder(x, z, H - 1.1, H - 0.05, 0.42, { seg: 2, faces: '', solid: 0 }, 12, 1.45);
  }
  // a gallery along the north wall, long since stripped
  b.box(X0 + T, 4.6, Z0 + T, X1 - T, 4.9, Z0 + 6, { seg: 2.5 });
  for (let x = -144; x <= -100; x += 8) b.box(x - 0.2, F, Z0 + 5.6, x + 0.2, 4.6, Z0 + 6, { seg: 2.5 });

  // --- portico: eight pierced blades carrying a trough of a roof
  for (let z = -28; z <= 28; z += 8) {
    const z0 = z - 0.45, z1 = z + 0.45, o = { vboards: true, seg: 2 };
    b.box(-90.6, F, z0, -78.8, 3.3, z1, o); b.box(-90.6, 8.3, z0, -78.8, 11.6, z1, o);
    b.box(-90.6, 3.3, z0, -87.6, 8.3, z1, o); b.box(-81.8, 3.3, z0, -78.8, 8.3, z1, o);
  }
  {
    // the trough in section: a hull, deepest over the blades, sweeping up to a lip front and back
    const outer = [], inner = [], N = 22, th = 0.55;
    for (let i = 0; i <= N; i++) {
      const s = i / N * 2 - 1;                                   // -1 at the back lip, +1 at the front
      const W = s < 0 ? 9.6 : 11.4, Hh = s < 0 ? 5.0 : 6.2;
      const x = -84.7 + s * W, y = 11.6 + Hh * (1 - Math.sqrt(Math.max(0, 1 - s * s * 0.985)));
      outer.push([x, y]);
    }
    for (let i = 0; i <= N; i++) {
      const p = outer[i], q0 = outer[Math.max(0, i - 1)], q1 = outer[Math.min(N, i + 1)];
      let tx = q1[0] - q0[0], ty = q1[1] - q0[1]; const l = Math.hypot(tx, ty); tx /= l; ty /= l;
      inner.push([p[0] - ty * th, p[1] + tx * th]);
    }
    const outline = [...outer, ...inner.reverse()];
    b.sweep(outline, [0, 0, -35.5], [1, 0, 0], [0, 1, 0], [0, 0, 71], { solid: 0, seg: 2.4 }, { closed: true, smooth: true, caps: true });
    // what the trough is to a bullet or a ray of skylight: a staircase of slabs
    for (let i = 0; i < N; i += 2) {
      const p = outer[i], q = outer[Math.min(N, i + 2)];
      w.solids.addBox(Math.min(p[0], q[0]), Math.min(p[1], q[1]), -35.5, Math.max(p[0], q[0]), Math.max(p[1], q[1]) + th, 35.5, SHOT_AO, SURF.concrete);
    }
  }
  // the great door stands ajar; its two leaves are separate meshes so the mural can be painted on them
  w.landmarks.assemblyDoor = { x: X1 - T / 2, y: F, z: 0, w: 7.2, h: 7.3 };
  w.landmarks.forum = { x: -112, y: F, z: 12 };

  // --- on the roof: the hyperboloid over the chamber, the tilted pyramid, the lift tower
  {
    const prof = [], R0 = 10.6, top = 44, waistY = 32;
    for (let i = 0; i <= 26; i++) {
      const y = H + 0.5 + (top - H - 0.5) * (i / 26);
      const k = (y - waistY) / 13.5;
      prof.push([7.1 * Math.sqrt(1 + k * k) * (R0 / (7.1 * Math.sqrt(1 + Math.pow((H + 0.5 - waistY) / 13.5, 2)))), y]);
    }
    // the crown is cut on a slant, high to the north-east
    const warp = (p, a, t) => { if (t > 0.72) p[1] += (t - 0.72) / 0.28 * 4.6 * Math.cos(a + 0.9); };
    b.lathe(CX, CZ, prof, { mat: 'concreteDS', solid: 0, seg: 2 }, { sides: 52, warp });
    for (let i = 0; i < 26; i += 2) w.solids.addCyl(CX, CZ, Math.max(prof[i][0], prof[i + 2][0]), prof[i][1], prof[i + 2][1], SHOT_AO, SURF.concrete);
    // a walkway ringing the crown, and the bridge to the lift tower
    b.box(CX - 1, 32, CZ - 21, CX + 1, 32.3, CZ - 7.2, { seg: 3, solid: SHOT_AO });
  }
  {
    const cx = -108, cz = 17, s = 7.5, ax = cx + 2.2, az = cz - 1.6, ay = H + 13;
    const c = [[cx - s, H + 0.55, cz - s], [cx + s, H + 0.55, cz - s], [cx + s, H + 0.55, cz + s], [cx - s, H + 0.55, cz + s]], a = [ax, ay, az];
    b.poly([c[1], c[0], a], { solid: 0 }); b.poly([c[2], c[1], a], { solid: 0 }); b.poly([c[3], c[2], a], { solid: 0 }); b.poly([c[0], c[3], a], { solid: 0 });
    for (let i = 0; i < 5; i++) { const t = i / 5, hs = s * (1 - t) * 0.92; w.solids.addBox(cx - hs + (ax - cx) * t, H + 0.55 + (ay - H) * t, cz - hs + (az - cz) * t, cx + hs + (ax - cx) * t, H + 0.55 + (ay - H) * (t + 0.2), cz + hs + (az - cz) * t, SHOT_AO, SURF.concrete); }
  }
  b.box(-131.5, H + 0.55, -27.5, -124.5, H + 17.4, -21.5, { vboards: true });

  // --- reflecting pool before the portico
  pool(w, -74, -30, -60, 30);
}

// ---------------------------------------------------------------------------
// HIGH COURT. East side: three painted piers under a parasol of eleven vaults.
function highCourt(w) {
  const b = w.b; b.setGroup('highcourt');
  const X0 = 106, X1 = 150, Z0 = -52, Z1 = 52, H = 15.5, F = 0.45, PN = -38, PS = -14;      // PN..PS: the open portico
  w.level.push({ x0: 66, z0: Z0 - 10, x1: X1 + 10, z1: Z1 + 10 });
  w.paved.push({ x0: 66, z0: -62, x1: 110, z1: 62, soft: 8 });

  b.box(92.6, 0, Z0 - 2, X1, F, Z1 + 2, { seg: 3 });                                   // plinth
  stairs(w, 91.4, Z0 - 2, 92.6, Z1 + 2, 'x', 0, F, { seg: 6 });

  // --- the two blocks either side of the portico
  b.box(X0, F, Z0, X1, H, PN, { seg: 2.6 });
  b.box(X0, F, PS, X1, H, Z1, { seg: 2.6 });
  // courtroom fronts: a deep egg-crate, taller cells to the north for the high bench
  brise(b, { face: 'x-', at: X0, a0: PS, a1: Z1, y0: F, y1: H, depth: 2.4, bay: 3.67, storey: 3.76, fin: 0.2, slab: 0.24 });
  brise(b, { face: 'x-', at: X0, a0: Z0, a1: PN, y0: F, y1: H, depth: 2.4, bay: 2.33, storey: 7.5, fin: 0.2, slab: 0.24 });
  brise(b, { face: 'x+', at: X1, a0: Z0, a1: Z1, y0: F, y1: H, depth: 1.2, bay: 4, storey: 3.76 });
  brise(b, { face: 'z-', at: Z0, a0: X0, a1: X1, y0: F, y1: H, depth: 1.2, bay: 4, storey: 3.76, glass: false });
  brise(b, { face: 'z+', at: Z1, a0: X0, a1: X1, y0: F, y1: H, depth: 1.2, bay: 4, storey: 3.76, glass: false });

  // --- the three piers
  const piers = [[-32.6, PAINT.green], [-26, PAINT.yellow], [-19.4, PAINT.red]];
  for (const [z, color] of piers) b.box(97.6, F, z - 1.15, 112, 18.7, z + 1.15, { color, paint: 0.7, vboards: true, seg: 2.2 });
  // behind them the ramps climb back and forth, open to the air
  const ramp = (x0, x1, y0, y1, z0, z1) => {
    const len = Math.hypot(x1 - x0, y1 - y0), ang = Math.atan2(y1 - y0, x1 - x0);
    b.tbox(new THREE.Matrix4().makeRotationZ(ang).setPosition((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), len, 0.35, z1 - z0, { seg: 2.5, solid: SHOT_AO });
  };
  ramp(118, 144, F, 5.4, PN + 0.6, PN + 5); ramp(144, 118, 5.4, 10.4, PN + 5.4, PN + 9.8); ramp(118, 144, 10.4, 15.2, PN + 10.2, PN + 14.6);
  b.box(144, F, PN + 0.6, 148, 15.5, PN + 14.6, { seg: 3 }); b.box(114, 5.2, PN + 0.6, 118, 5.6, PN + 9.8, { seg: 3 }); b.box(114, 10.2, PN + 5.4, 118, 10.6, PN + 14.6, { seg: 3 });
  b.box(148, F, PN, X1, H, PS, { seg: 3 });                                             // back wall of the portico
  // the foot of the ramp is blocked by what the last court clerks piled there
  for (const [x, z, sx, sz, yaw, h] of [[119.5, PN + 2.6, 2.6, 3.6, 0.2, 1.5], [121, PN + 4.2, 1.6, 1.4, 0.9, 2.3], [117.6, PN + 3.4, 1.2, 2.2, -0.3, 1.0]])
    b.obox(x, F, z, sx, F + h, sz, yaw, { mat: 'metal', color: PAINT.khaki, paint: 0.5, surf: SURF.metal, seg: 1.2 });

  // --- the parasol: one roof over everything, its underside a row of vaults
  {
    const top = 22.2, spring = 18.7, rise = 2.3, n = 11, zA = Z0 - 3, zB = Z1 + 3, span = (zB - zA) / n;
    const outline = [[zA, top], [zA, spring]];
    for (let i = 0; i < n; i++) for (let k = 1; k <= 10; k++) {
      const t = k / 10, z = zA + (i + t) * span;
      outline.push([z, spring + rise * Math.sin(Math.PI * t)]);
    }
    outline.push([zB, top]);
    b.sweep(outline, [93, 0, 0], [0, 0, 1], [0, 1, 0], [61, 0, 0], { solid: 0, seg: 3 }, { closed: true, smooth: false, caps: true, flip: true });
    w.solids.addBox(93, spring + rise * 0.6, zA, 154, top, zB, SHOT_AO, SURF.concrete);
    // the roof stands on blade walls rising from the blocks at every springing
    for (let i = 0; i <= n; i++) {
      const z = zA + i * span;
      if (z > PN - 1 && z < PS + 1) continue;
      b.box(X0 + 0.4, H, z - 0.4, X1 - 0.4, spring + 0.25, z + 0.4, { seg: 3 });
    }
  }
  w.landmarks.courtDepot = { x: 104, y: F, z: -26 };

  // --- pools either side of the approach
  pool(w, 72, -56, 88, -42);
  pool(w, 72, -10, 88, 54);
}

// ---------------------------------------------------------------------------
// TOWER OF SHADOWS. A pavilion with no purpose but to study the sun: three fronts of sun-breakers, the north left open.
function towerOfShadows(w) {
  const b = w.b; b.setGroup('tower');
  const X0 = -22, X1 = -6, Z0 = -14, Z1 = 2, H = 12.6, F = 0.3;
  w.level.push({ x0: X0 - 6, z0: Z0 - 6, x1: X1 + 6, z1: Z1 + 6 });
  b.box(X0 - 1, 0, Z0 - 1, X1 + 1, F, Z1 + 1, { seg: 3 });
  // corner piers and intermediate posts
  for (const x of [X0, X1 - 0.6]) for (const z of [Z0, Z1 - 0.6]) b.box(x, F, z, x + 0.6, H, z + 0.6, { vboards: true });
  for (const x of [X0 + 5.1, X0 + 10.3]) b.box(x, F, Z0, x + 0.45, H, Z0 + 0.45, { vboards: true });
  // floors: two open decks and a roof pierced by lights
  for (const y of [4.2, 8.4]) { b.box(X0, y, Z0, X1, y + 0.28, Z0 + 2.2, { seg: 2.2, solid: SHOT_AO }); b.box(X0, y, Z1 - 2.2, X1, y + 0.28, Z1, { seg: 2.2, solid: SHOT_AO }); b.box(X0, y, Z0 + 2.2, X0 + 2.2, y + 0.28, Z1 - 2.2, { seg: 2.2, solid: SHOT_AO }); b.box(X1 - 2.2, y, Z0 + 2.2, X1, y + 0.28, Z1 - 2.2, { seg: 2.2, solid: SHOT_AO }); }
  for (let i = 0; i < 4; i++) b.box(X0 + i * 4.4, H, Z0, X0 + i * 4.4 + 2.8, H + 0.35, Z1, { seg: 2.2, solid: SHOT_AO });
  b.box(X0, H, Z0, X1, H + 0.35, Z0 + 1.2, { seg: 2.2, solid: SHOT_AO }); b.box(X0, H, Z1 - 1.2, X1, H + 0.35, Z1, { seg: 2.2, solid: SHOT_AO });
  // south: square cells. east: tall narrow slots. west: wide low shelves.
  brise(b, { face: 'z+', at: Z1, a0: X0, a1: X1, y0: F + 2.6, y1: H, depth: 1.7, bay: 2.0, storey: 2.0, glass: false, seg: 1.4 });
  brise(b, { face: 'x+', at: X1, a0: Z0, a1: Z1, y0: F + 2.6, y1: H, depth: 1.5, bay: 1.33, storey: 5.0, glass: false, seg: 1.4 });
  brise(b, { face: 'x-', at: X0, a0: Z0, a1: Z1, y0: F + 2.6, y1: H, depth: 1.9, bay: 4.0, storey: 1.25, glass: false, seg: 1.4 });
  // a long low bench inside, the kind of thing a relief team would stack crates on
  b.box(-17.6, F, -8.2, -10.4, F + 0.75, -5.8, { seg: 2 });
  w.landmarks.towerCache = { x: -14, y: F + 0.75, z: -7 };
}

// ---------------------------------------------------------------------------
// OPEN HAND. "Open to give, open to receive." A sheet-metal hand that turns with the wind over a sunken court.
function openHand(w) {
  const b = w.b; b.setGroup('openhand');
  const X0 = 12, X1 = 48, Z0 = -98, Z1 = -62, D = -3.6;
  w.holes.push({ x0: X0, z0: Z0, x1: X1, z1: Z1 });
  w.flats.push({ x0: X0, z0: Z0, x1: X1, z1: Z1, y: D });
  w.level.push({ x0: X0 - 10, z0: Z0 - 10, x1: X1 + 10, z1: Z1 + 10 });
  w.paved.push({ x0: X0 - 8, z0: Z0 - 8, x1: X1 + 8, z1: Z1 + 8, soft: 9 });
  w.paved.push({ x0: 6, z0: -64, x1: 30, z1: -50, soft: 5 });
  const o = { seg: 2.4, solid: 0, grow: 0.2 };
  b.face(X0, D, Z0, 0, 0, Z1 - Z0, X1 - X0, 0, 0, { ...o, mat: 'ground', grow: 0.3 });         // floor of the court
  b.face(X0, D, Z0, X1 - X0, 0, 0, 0, -D, 0, o); b.face(X0, D, Z1, 0, -D, 0, X1 - X0, 0, 0, o);
  b.face(X0, D, Z0, 0, -D, 0, 0, 0, Z1 - Z0, o); b.face(X1, D, Z0, 0, 0, Z1 - Z0, 0, -D, 0, o);
  // the retaining walls stand up as a parapet, broken where the ramp and the steps come down
  const P = { seg: 3, grow: 0.15 }, t = 0.5, ph = 1.0;
  b.box(X0 - t, 0, Z0 - t, X1 + t, ph, Z0, P);                                   // north
  b.box(X0 + 6.4, 0, Z1, X1 + t, ph, Z1 + t, P); b.box(X0 - t, 0, Z1, X0, ph, Z1 + t, P);       // south, open over the ramp
  b.box(X0 - t, 0, Z0, X0, ph, Z1, P);                                           // west
  b.box(X1, 0, Z0, X1 + t, ph, -84.4, P); b.box(X1, 0, -75.6, X1 + t, ph, Z1, P);            // east, open over the steps
  // ramp down the west side, and a wall dividing it from the court
  w.ramps.push({ x0: X0, z0: -92, x1: X0 + 6, z1: Z1, axis: 'z', y0: D, y1: 0 });
  b.poly([[X0, D, -92], [X0, 0, Z1], [X0 + 6, 0, Z1], [X0 + 6, D, -92]], { solid: 0, grow: 0.3 });
  b.poly([[X0 + 6, D, -92], [X0 + 6, 0, Z1], [X0 + 6, D, Z1]], { solid: 0 });
  for (let i = 0; i < 10; i++) { const z0 = -92 + i * 3, y = D + (i + 1) * 0.36; w.solids.addBox(X0, D - 1, z0, X0 + 6, y - 0.36, z0 + 3, SHOT_AO); }
  b.box(X0 + 6, D, -92, X0 + 6.4, 1.0, Z1, { seg: 3 });
  // steps down the east side
  stairs(w, 41, -84, X1, -76, 'x', D, 0, { seg: 8 });
  b.box(41, D, -84.4, X1, 0.9, -84, { seg: 3 }); b.box(41, D, -76, X1, 0.9, -75.6, { seg: 3 });

  // the mast: a square shaft on a broad foot, rising clear of the court
  const MX = 30, MZ = -86;
  b.box(MX - 3.4, D, MZ - 3.4, MX + 3.4, D + 1.1, MZ + 3.4, { seg: 2.2 });
  b.box(MX - 1.3, D + 1.1, MZ - 1.3, MX + 1.3, 12.2, MZ + 1.3, { vboards: true, seg: 2 });
  b.cylinder(MX, MZ, 12.2, 13.4, 0.5, { mat: 'metal', color: PAINT.black, paint: 0.35, surf: SURF.metal }, 12);
  {
    // the hand in outline: thumb out to one side like a bird's head, four fingers raised, the palm drawn in to a wrist
    const pts = [[-1.1, 0], [-2.3, 1.7], [-3.7, 3.5], [-4.8, 5.5], [-5.9, 7.3], [-6.7, 8.5], [-6.5, 9.4], [-5.6, 9.6], [-4.4, 8.7], [-2.9, 6.8], [-2.1, 7.6],
      [-1.8, 11.6], [-1.5, 13.0], [-0.8, 13.4], [-0.2, 12.7], [0.0, 8.6], [0.5, 12.9], [0.8, 13.9], [1.5, 14.1], [2.1, 13.4], [2.2, 8.4], [2.7, 12.0], [3.1, 12.7], [3.8, 12.7], [4.2, 11.8],
      [4.3, 7.7], [4.9, 9.6], [5.4, 10.2], [6.1, 10.1], [6.3, 9.2], [6.0, 6.5], [5.3, 4.8], [3.6, 3.0], [1.7, 1.4], [1.1, 0]];
    const shape = new THREE.Shape(); shape.moveTo(pts[0][0], pts[0][1]);
    shape.splineThru(pts.slice(1).map(p => new THREE.Vector2(p[0], p[1])));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.8, bevelEnabled: true, bevelThickness: 0.22, bevelSize: 0.2, bevelSegments: 2, curveSegments: 6, steps: 1 });
    // a vane: it stands edge-on to the wind, which here comes steadily out of the north-west
    const yaw = Math.atan2(-0.6, 0.8);
    const m = new THREE.Matrix4().makeRotationY(yaw).multiply(new THREE.Matrix4().makeTranslation(0, 0, -0.4)).setPosition(MX, 13.4, MZ);
    m.elements[12] = MX - Math.sin(yaw) * 0.4 * 0; m.elements[13] = 13.4; m.elements[14] = MZ;
    b.add(geo, m, { mat: 'metal', color: [0.2, 0.21, 0.2], paint: 0.6, surf: SURF.metal });
    geo.dispose();
    w.solids.addOBox(MX, 13.4, MZ, 6.6, 27.6, 0.6, yaw, SHOT_AO, SURF.metal);
    w.landmarks.handYaw = yaw;
  }
  w.landmarks.openHand = { x: MX, y: 13.4, z: MZ, base: D };
  w.landmarks.beacon = { x: MX, y: D, z: MZ + 5.6 };
  // a speaker's rostrum faces the hand across the court
  b.box(24, D, -70, 36, D + 0.5, -66, { seg: 2.4 }); b.box(28.5, D + 0.5, -68.6, 31.5, D + 1.5, -67.4, { seg: 1.5 });
}

// ---------------------------------------------------------------------------
// GEOMETRIC HILL, with a gnomon. The blade's edge is raised by the latitude, 30.73 degrees, so it points at the pole.
function geometricHill(w) {
  const b = w.b; b.setGroup('hill');
  const cx = 16, cz = 40, top = 5.6;
  w.mounds.push({ x: cx, z: cz, half: 16, h: top });
  const lat = 30.7333 * Math.PI / 180, L = 5.2, th = 0.32;
  const zs = cz + 2.4, zn = zs - L, yn = top + L * Math.tan(lat);
  // a right triangle standing north-south: foot to the south, tip high in the north
  b.poly([[cx + th / 2, top - 0.3, zs], [cx + th / 2, top - 0.3, zn], [cx + th / 2, yn, zn]], { solid: 0, vboards: true });
  b.poly([[cx - th / 2, top - 0.3, zn], [cx - th / 2, top - 0.3, zs], [cx - th / 2, yn, zn]], { solid: 0, vboards: true });
  b.poly([[cx - th / 2, top - 0.3, zs], [cx + th / 2, top - 0.3, zs], [cx + th / 2, yn, zn], [cx - th / 2, yn, zn]], { solid: 0 });   // the style: the edge that points at Polaris
  b.poly([[cx + th / 2, top - 0.3, zn], [cx - th / 2, top - 0.3, zn], [cx - th / 2, yn, zn], [cx + th / 2, yn, zn]], { solid: 0 });
  for (let i = 0; i < 4; i++) w.solids.addBox(cx - th / 2, top - 0.3, zs - (i + 1) * L / 4, cx + th / 2, top + (i + 1) * (yn - top) / 4, zs - i * L / 4, SOLID.ALL);
  // the dial: a ring of hour stones
  for (let hr = -5; hr <= 5; hr++) {
    const a = hr * 15 * Math.PI / 180, r = 4.2;
    b.obox(cx + Math.sin(a) * r, top - 0.25, zs - 2.4 - Math.cos(a) * r, 0.5, top + 0.12, 0.9, -a, { seg: 1, solid: 0 });
  }
  w.landmarks.gnomon = { x: cx, y: yn, z: zn };
  // a concrete retaining face on the east flank carries the hill's name
  b.box(cx + 15.2, 0, cz - 9, cx + 16, 1.9, cz + 9, { seg: 2.2 });
}

// ---------------------------------------------------------------------------
// MARTYRS' MEMORIAL. A walled square, a ramp and a terrace: good cover, one way in.
function martyrs(w) {
  const b = w.b; b.setGroup('memorial');
  const X0 = 38, X1 = 58, Z0 = -2, Z1 = 18, H = 2.9, t = 0.5;
  w.level.push({ x0: X0 - 5, z0: Z0 - 5, x1: X1 + 5, z1: Z1 + 5 });
  b.box(X0, 0, Z0, X1, H, Z0 + t, { seg: 2.4 }); b.box(X0, 0, Z1 - t, X1, H, Z1, { seg: 2.4 });
  b.box(X1 - t, 0, Z0, X1, H, Z1, { seg: 2.4 });
  b.box(X0, 0, Z0, X0 + t, H, 5.5, { seg: 2.4 }); b.box(X0, 0, 10.5, X0 + t, H, Z1, { seg: 2.4 });    // gate in the west wall
  // terrace along the east, reached by a ramp on the north
  b.box(50, 0, Z0 + t, X1 - t, 1.5, Z1 - t, { seg: 2.4 });
  w.ramps.push({ x0: 41, z0: Z0 + t, x1: 50, z1: Z0 + 3.6, axis: 'x', y0: 0, y1: 1.5 });
  b.poly([[41, 0, Z0 + 3.6], [50, 1.5, Z0 + 3.6], [50, 1.5, Z0 + t], [41, 0, Z0 + t]], { solid: 0 });
  b.poly([[41, 0, Z0 + 3.6], [50, 0, Z0 + 3.6], [50, 1.5, Z0 + 3.6]], { solid: 0 });
  for (let i = 0; i < 5; i++) w.solids.addBox(41 + i * 1.8, -1, Z0 + t, 41 + (i + 1) * 1.8, i * 0.3, Z0 + 3.6, SHOT_AO);
  // three standing slabs
  for (const [x, z, h] of [[53.6, 5, 4.4], [54.4, 9, 5.6], [53.2, 13, 3.8]]) b.box(x, 1.5, z - 0.9, x + 0.5, 1.5 + h, z + 0.9, { vboards: true, seg: 2 });
  w.landmarks.memorial = { x: 46, y: 0, z: 8 };
}

// ---------------------------------------------------------------------------
// SECRETARIAT. A quarter-kilometre slab on the western skyline, losing its north end floor by floor.
function secretariat(w) {
  const b = w.b; b.setGroup('secretariat');
  const X0 = -268, X1 = -244, Z0 = -124, Z1 = 124, storeys = 10, sh = 4.1, bay = 4.0, base = -6;
  const nb = Math.round((Z1 - Z0) / bay);
  // how many storeys survive at bay i: the north end has come down in steps
  const alive = i => { const z = Z0 + i * bay; return z < -92 ? 3 : z < -76 ? 5 : z < -64 ? 7 : z < -52 ? 9 : storeys; };
  const far = { ao: false, solid: 0, seg: 12 };
  let i0 = 0;
  for (let i = 1; i <= nb; i++) {
    if (i === nb || alive(i) !== alive(i0)) {
      const h = alive(i0) * sh;
      b.box(X0, base, Z0 + i0 * bay, X1, h, Z0 + i * bay, far);
      // slabs and a glazing plane for this run
      for (let j = 1; j <= alive(i0); j++) b.box(X1, j * sh - 0.25, Z0 + i0 * bay, X1 + 2.2, j * sh, Z0 + i * bay, far);
      b.face(X1 + 0.05, 0, Z0 + i0 * bay, 0, h, 0, 0, 0, (i - i0) * bay, { mat: 'glass', color: GLASS, solid: 0, ao: false, seg: 30, shadow: false });
      i0 = i;
    }
  }
  for (let i = 0; i <= nb; i++) {
    const h = Math.max(alive(Math.max(0, i - 1)), alive(Math.min(nb - 1, i))) * sh;
    b.box(X1, 0, Z0 + i * bay - 0.12, X1 + 2.3, h, Z0 + i * bay + 0.12, far);
  }
  // the ministers' block breaks the rhythm at the centre: double-height loggias
  for (let k = 0; k < 6; k++) b.box(X1, 0, -18 + k * 7.2 - 0.5, X1 + 3.4, storeys * sh, -18 + k * 7.2 + 0.5, far);
  for (let j = 0; j <= 5; j++) b.box(X1, j * sh * 2 - 0.4, -18, X1 + 3.4, j * sh * 2, 18, far);
  // ramp towers stand proud of the front, and the roof carries its odd village of shapes
  b.box(X1, base, 44, X1 + 9, storeys * sh + 5, 54, { ...far, vboards: true }); b.box(X1, base, -46, X1 + 7, 9 * sh - 2, -38, { ...far, vboards: true });
  b.box(X0 + 4, storeys * sh, -10, X1 - 4, storeys * sh + 6, 14, far); b.box(X0 + 6, storeys * sh, 60, X1 - 6, storeys * sh + 3.5, 96, far);
  b.cylinder(-256, 30, storeys * sh, storeys * sh + 8, 5, far, 18);
  w.solids.addBox(X0, base, Z0, X1 + 3, storeys * sh, Z1, SOLID.SHOT);
}

// ---------------------------------------------------------------------------
// The esplanade and the road in.
function esplanade(w) {
  w.paved.push({ x0: -62, z0: -52, x1: 70, z1: 60, soft: 18 });
  w.paved.push({ x0: -10, z0: 60, x1: 10, z1: 150, soft: 6 });
  w.level.push({ x0: -62, z0: -52, x1: 70, z1: 60 });
  w.level.push({ x0: -12, z0: 60, x1: 12, z1: 140 });
}

export function buildCapitol(w) {
  esplanade(w);
  assembly(w);
  highCourt(w);
  towerOfShadows(w);
  openHand(w);
  geometricHill(w);
  martyrs(w);
  secretariat(w);
  w.b.setGroup('world');
}
