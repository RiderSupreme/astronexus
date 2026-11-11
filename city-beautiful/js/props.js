// What people left behind: a queue of cars that never got out, a checkpoint,
// a relief camp, street lamps, and the signs that told everyone where to go.
import { THREE } from './lib/three.js';
import { SOLID, SURF } from './physics.js';
import { standard } from './materials.js';
import { makeRng, TAU } from './util.js';
import { PAINT } from './capitol.js';

const CAR_WHITE = [0.72, 0.71, 0.66], MAROON = [0.3, 0.05, 0.05], BLACK = [0.05, 0.05, 0.055], CREAM = [0.7, 0.62, 0.42], BUS_BLUE = [0.1, 0.22, 0.38], AUTO_GREEN = [0.06, 0.26, 0.12], AUTO_YELLOW = [0.8, 0.6, 0.06];
const TYRE = [0.022, 0.022, 0.022], GLASS = [0.03, 0.04, 0.05], KHAKI = [0.34, 0.3, 0.19], CRATE = [0.27, 0.19, 0.1], STEEL = [0.24, 0.24, 0.23];
const HULL = SOLID.MOVE | SOLID.SHOT | SOLID.NAV;      // stops bodies and bullets, but casts no baked shade on its own skin
let R = makeRng(2087);                                 // the props' own dice, so adding one never reshuffles the rest of the world

const metal = (color, paint = 0.55) => ({ mat: 'metal', color, paint, surf: SURF.metal });
const plain = color => ({ mat: 'flat', color });
const PANE = { mat: 'glass', color: GLASS, shadow: false };
const _t = new THREE.Matrix4(), _l = new THREE.Matrix4(), _p = new THREE.Vector3();

// The cut a wheel arch makes in a side profile: an arc over the wheel, travelling forward, starting and ending on the sill line.
function arch(cx, cy, r, base = cy, n = 6) {
  const a0 = Math.asin(Math.max(-1, Math.min(1, (base - cy) / r))), pts = [];
  for (let k = 0; k <= n; k++) { const a = Math.PI - a0 - (Math.PI - 2 * a0) * (k / n); pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
  return pts;
}
const WHEELS = new Map();
function wheelGeo(r, wd) {
  const key = r + '|' + wd;
  if (!WHEELS.has(key)) { const g = new THREE.CylinderGeometry(r, r, wd, 14, 1); g.rotateX(Math.PI / 2); WHEELS.set(key, g); }
  return WHEELS.get(key);
}
let BAG = null;

// A prop's own frame: x along its length, y up, z across. Everything is described in that frame and lands in
// the world through one matrix, so a car can sit down on flat tyres and a three-wheeler can lie on its side.
class Frame {
  constructor(w, x, z, yaw, { y = 0, roll = 0, pitch = 0 } = {}) {
    this.w = w; this.b = w.b; this.x = x; this.z = z; this.y = y; this.yaw = yaw;
    this.m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(roll, yaw, pitch, 'YZX')).setPosition(x, y, z);
  }
  P(x, y, z) { _p.set(x, y, z).applyMatrix4(this.m); return [_p.x, _p.y, _p.z]; }
  D(x, y, z) { const e = this.m.elements; return [e[0] * x + e[4] * y + e[8] * z, e[1] * x + e[5] * y + e[9] * z, e[2] * x + e[6] * y + e[10] * z]; }
  box(x0, y0, z0, x1, y1, z1, opts) {
    _t.makeTranslation((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2).premultiply(this.m);
    this.b.tbox(_t, x1 - x0, y1 - y0, z1 - z0, { solid: 0, seg: 1.4, ...opts });
  }
  // a side profile [[x, y], ...], counter-clockwise seen from the right-hand side, pushed across the width
  across(outline, z0, z1, opts) {
    this.b.sweep(outline, this.P(0, 0, z0), this.D(1, 0, 0), this.D(0, 1, 0), this.D(0, 0, z1 - z0), { solid: 0, seg: 1.4, ...opts }, { closed: true, caps: true });
  }
  // a cross-section [[z, y], ...], counter-clockwise seen from behind, pushed along the length
  along(outline, x0, x1, opts) {
    this.b.sweep(outline, this.P(x0, 0, 0), this.D(0, 0, 1), this.D(0, 1, 0), this.D(x1 - x0, 0, 0), { solid: 0, seg: 1.4, ...opts }, { closed: true, caps: true, flip: true });
  }
  poly(pts, opts) { this.b.poly(pts.map(p => this.P(p[0], p[1], p[2])), { solid: 0, ...opts }); }
  add(geometry, local, opts) { _t.copy(this.m).multiply(local); this.b.add(geometry, _t, { solid: 0, ...opts }); }
  wheel(x, z, r, wd) {
    this.add(wheelGeo(r, wd), _l.makeTranslation(x, r, z), plain(TYRE));
    if (z !== 0) this.add(wheelGeo(r * 0.56, 0.05), _l.makeTranslation(x, r, z + Math.sign(z) * (wd / 2 - 0.015)), metal(STEEL, 0.25));
  }
  // panes on both flanks: a convex outline in the side view, mirrored
  flanks(pts, z, opts = PANE) {
    this.poly(pts.map(([x, y]) => [x, y, z]), opts);
    this.poly(pts.map(([x, y]) => [x, y, -z]).reverse(), opts);
  }
  // a pane lying on one stretch of a side profile (p0 to p1, in outline order), lifted just clear of it
  slope(p0, p1, zh, inset = 0.08, lift = 0.008, opts = PANE) {
    const ex = p1[0] - p0[0], ey = p1[1] - p0[1], l = Math.hypot(ex, ey), ux = ex / l, uy = ey / l, nx = uy, ny = -ux;
    const ax = p0[0] + ux * inset + nx * lift, ay = p0[1] + uy * inset + ny * lift, bx = p1[0] - ux * inset + nx * lift, by = p1[1] - uy * inset + ny * lift;
    this.poly([[ax, ay, -zh], [bx, by, -zh], [bx, by, zh], [ax, ay, zh]], opts);
  }
  // what a body or a bullet meets, as a box turned only about the vertical
  hull(x0, y0, z0, x1, y1, z1, surf = SURF.metal, flags = HULL) {
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    return this.w.solids.addOBox(this.x + c * cx + s * cz, this.y + y0, this.z - s * cx + c * cz, (x1 - x0) / 2, this.y + y1, (z1 - z0) / 2, this.yaw, flags, surf);
  }
  // an unseen core that only the ambient bake sees: it darkens the ground beneath without blacking out the skin around it
  shade(x0, y0, z0, x1, y1, z1) { return this.hull(x0, y0, z0, x1, y1, z1, 0, SOLID.AO); }
}

// The government saloon every ministry in the country ran for fifty years: upright, round-shouldered, usually white.
function car(w, x, z, yaw, color, { beacon = false, flat = 0, roll = 0 } = {}) {
  const f = new Frame(w, x, z, yaw, { y: -flat, roll });
  const M = metal(color, 0.42 + R() * 0.33), trim = metal(STEEL, 0.2), hw = 0.83, cw = 0.73;
  f.across([[-2.08, 0.44], [-1.72, 0.3], ...arch(-1.25, 0.3, 0.41), ...arch(1.25, 0.3, 0.41), [1.72, 0.3], [2.06, 0.42], [2.15, 0.62], [2.13, 0.84],
    [1.95, 0.97], [0.9, 1.05], [-1.62, 1.05], [-2.0, 1.0], [-2.14, 0.84], [-2.16, 0.58]], -hw, hw, M);
  f.across([[0.88, 1.03], [0.44, 1.5], [0.12, 1.58], [-0.9, 1.58], [-1.3, 1.47], [-1.64, 1.03]], -cw, cw, M);
  f.flanks([[-0.22, 1.1], [0.72, 1.1], [0.42, 1.46], [-0.22, 1.5]], cw + 0.008);
  f.flanks([[-1.5, 1.1], [-0.32, 1.1], [-0.32, 1.5], [-0.95, 1.5], [-1.26, 1.42]], cw + 0.008);
  f.slope([0.88, 1.03], [0.44, 1.5], 0.62); f.slope([-1.3, 1.47], [-1.64, 1.03], 0.6);                               // windscreen, rear window
  f.box(2.1, 0.4, -0.8, 2.22, 0.54, 0.8, trim); f.box(-2.25, 0.4, -0.8, -2.13, 0.54, 0.8, trim);                     // bumpers
  f.box(2.12, 0.63, -0.36, 2.165, 0.84, 0.36, plain([0.03, 0.03, 0.03]));                                           // grille
  for (const s of [-1, 1]) {
    f.box(2.12, 0.68, s * 0.6 - 0.11, 2.17, 0.86, s * 0.6 + 0.11, plain([0.42, 0.42, 0.38]));                        // headlamps
    f.box(-2.18, 0.7, s * 0.68 - 0.07, -2.13, 0.88, s * 0.68 + 0.07, plain([0.3, 0.02, 0.015]));                     // tail lamps
    for (const wx of [-1.25, 1.25]) f.wheel(wx, s * (hw - 0.115), 0.31, 0.2);
  }
  if (beacon) f.box(-0.12, 1.58, -0.07, 0.04, 1.7, 0.07, plain([0.5, 0.03, 0.02]));
  f.hull(-2.2, 0, -hw, 2.2, 1.05, hw); f.hull(-1.5, 1.05, -cw, 0.8, 1.58, cw);
  f.shade(-1.95, 0.74, -0.7, 1.9, 0.92, 0.7); f.shade(-0.78, 0.36, -0.7, 0.78, 0.92, 0.7);
}

// A city bus: two-tone, flat-fronted, a crowned roof, most of its glass gone.
function bus(w, x, z, yaw) {
  const f = new Frame(w, x, z, yaw, { y: -0.05, roll: 0.02 }), hw = 1.25;
  f.across([[-5.2, 0.62], [-4.05, 0.52], ...arch(-3.4, 0.5, 0.6, 0.52), ...arch(3.3, 0.5, 0.6, 0.52), [3.95, 0.52], [5.18, 0.56], [5.25, 0.8], [5.25, 1.7], [-5.22, 1.7]], -hw, hw, metal(BUS_BLUE, 0.6));
  f.across([[-5.22, 1.7], [5.25, 1.7], [5.2, 2.92], [5.05, 3.1], [-5.05, 3.1], [-5.2, 2.95]], -hw, hw, metal(CREAM, 0.62));
  f.along([[-1.25, 3.08], [1.25, 3.08], [1.14, 3.19], [0.8, 3.26], [-0.8, 3.26], [-1.14, 3.19]], -5.0, 5.0, metal(CREAM, 0.45));
  for (let i = 0; i < 8; i++) { const a = -4.75 + i * 1.16; f.flanks([[a, 1.9], [a + 1.02, 1.9], [a + 1.02, 2.72], [a, 2.72]], hw + 0.008); }
  f.slope([5.25, 1.7], [5.2, 2.92], 1.08, 0.1); f.slope([-5.2, 2.95], [-5.22, 1.7], 0.9, 0.25);
  f.box(5.2, 0.5, -1.22, 5.34, 0.7, 1.22, metal(STEEL, 0.2)); f.box(-5.32, 0.5, -1.22, -5.2, 0.7, 1.22, metal(STEEL, 0.2));
  for (const s of [-1, 1]) {
    f.box(5.24, 0.86, s * 0.86 - 0.14, 5.29, 1.06, s * 0.86 + 0.14, plain([0.42, 0.42, 0.38]));
    for (const wx of [-3.4, 3.3]) f.wheel(wx, s * (hw - 0.17), 0.5, 0.3);
  }
  f.hull(-5.25, 0, -hw, 5.28, 3.2, hw); f.shade(-5.1, 1.2, -1.1, 5.1, 3.0, 1.1); f.shade(-2.7, 0.6, -1.1, 2.6, 1.2, 1.1);
}

// The three-wheeler: a tub with two benches, a canvas hood, a single front wheel under a rounded nose.
function auto(w, x, z, yaw, { tipped = false } = {}) {
  const f = new Frame(w, x, z, yaw, tipped ? { roll: Math.PI / 2 - 0.05, y: 0.6 } : {}), hw = 0.6;
  f.across([[-1.25, 0.3], [0.75, 0.3], [1.3, 0.38], [1.38, 0.7], [1.2, 0.98], [1.05, 1.0], [0.95, 0.5], [0.25, 0.5], [0.25, 0.8], [-0.05, 0.8], [-0.05, 1.15],
    [-0.15, 1.15], [-0.15, 0.5], [-0.55, 0.5], [-0.55, 0.82], [-0.95, 0.82], [-1.0, 1.3], [-1.25, 1.3]], -hw, hw, metal(AUTO_GREEN, 0.6));
  // the hood: one thin skin from the top of the windscreen over to the back panel
  f.across([[1.02, 1.7], [0.2, 1.79], [-0.9, 1.75], [-1.3, 1.5], [-1.34, 1.24], [-1.3, 1.24], [-1.26, 1.47], [-0.88, 1.71], [0.2, 1.75], [1.02, 1.66]], -hw - 0.02, hw + 0.02, plain(AUTO_YELLOW));
  f.slope([1.2, 1.0], [1.02, 1.68], 0.5, 0, 0); f.slope([1.02, 1.68], [1.2, 1.0], 0.5, 0, 0);          // a windscreen is seen from both sides
  for (const s of [-1, 1]) { f.box(1.0, 1.0, s * 0.55 - 0.02, 1.22, 1.68, s * 0.55 + 0.02, metal(BLACK, 0.3)); f.wheel(-0.85, s * (hw - 0.02), 0.2, 0.1); }
  f.wheel(1.05, 0, 0.2, 0.1);
  f.box(1.36, 0.62, -0.08, 1.4, 0.76, 0.08, plain([0.42, 0.42, 0.38]));
  if (tipped) {                 // on its side: the hull is what the yaw-only frame sees of it
    const c = Math.cos(yaw), s = Math.sin(yaw);
    w.solids.addOBox(x + s * 0.9, 0, z + c * 0.9, 1.4, 1.22, 0.92, yaw, HULL, SURF.metal);
  } else { f.hull(-1.3, 0, -hw, 1.4, 1.0, hw); f.hull(-1.3, 1.0, -hw, 1.05, 1.78, hw, SURF.cloth, SOLID.MOVE | SOLID.NAV); f.shade(-1.15, 0.36, -0.5, 0.7, 0.46, 0.5); }
}

// An army lorry sent with the relief column: bonneted cab, drop-side bed, canvas tilt over hoops.
function truck(w, x, z, yaw) {
  const f = new Frame(w, x, z, yaw), O = metal(PAINT.olive, 0.7), hw = 1.14;
  f.across([[1.6, 0.78], ...arch(2.72, 0.52, 0.62, 0.78), [3.86, 0.78], [3.92, 1.0], [3.9, 1.48], [3.34, 1.58], [3.12, 2.38], [2.95, 2.45], [1.6, 2.45]], -hw, hw, O);
  f.flanks([[1.78, 1.6], [3.2, 1.6], [3.02, 2.28], [1.78, 2.28]], hw + 0.008);
  f.slope([3.34, 1.58], [3.12, 2.38], 0.98);
  f.box(-3.35, 0.62, -0.5, 3.8, 0.95, 0.5, metal(BLACK, 0.3));                                  // chassis
  f.box(-3.3, 0.95, -1.2, 1.5, 1.42, 1.2, O);                                                  // bed
  f.along([[-1.2, 1.42], [1.2, 1.42], [1.2, 2.3], [0.95, 2.7], [0.45, 2.9], [-0.45, 2.9], [-0.95, 2.7], [-1.2, 2.3]], -3.3, 1.48, plain(KHAKI));
  f.box(3.86, 0.62, -1.1, 4.0, 0.84, 1.1, metal(BLACK, 0.3));
  for (const s of [-1, 1]) {
    f.box(3.9, 1.1, s * 0.8 - 0.12, 3.95, 1.3, s * 0.8 + 0.12, plain([0.42, 0.42, 0.38]));
    for (const wx of [-2.35, -1.2, 2.72]) f.wheel(wx, s * (hw - 0.14), 0.52, 0.3);
  }
  f.hull(-3.3, 0, -1.2, 1.5, 2.9, 1.2, SURF.cloth); f.hull(1.5, 0, -hw, 3.95, 2.45, hw);
  f.shade(-3.2, 1.0, -1.05, 1.4, 2.4, 1.05); f.shade(1.7, 1.2, -1.0, 3.0, 2.3, 1.0);
}

// Concrete road barrier, the kind a crane sets down in a row.
function barrier(w, x, z, yaw) {
  const f = new Frame(w, x, z, yaw);
  f.along([[-0.3, 0], [0.3, 0], [0.3, 0.09], [0.13, 0.34], [0.085, 0.84], [-0.085, 0.84], [-0.13, 0.34], [-0.3, 0.09]], -1.1, 1.1, { grow: 0.05, seg: 1.2 });
  f.hull(-1.1, 0, -0.26, 1.1, 0.84, 0.26, SURF.concrete); f.shade(-1.0, 0.1, -0.06, 1.0, 0.8, 0.06);
}
// Police barricades: a yellow plate on a tube frame. The lettering is painted on afterwards, in buildSigns.
const BARRICADES = [];
function barricade(w, x, z, yaw, fallen = false) {
  const M = metal(AUTO_YELLOW, 0.55);
  BARRICADES.push({ x, z, yaw, fallen });
  if (fallen) { w.b.obox(x, 0.02, z, 2.2, 0.08, 0.75, yaw, { ...M, solid: 0, seg: 1.2 }); return; }
  const f = new Frame(w, x, z, yaw);
  f.box(-1.1, 0.48, -0.02, 1.1, 1.14, 0.02, M);
  for (const s of [-1, 1]) { f.box(s * 1.07 - 0.025, 0, -0.03, s * 1.07 + 0.025, 1.2, 0.03, M); f.box(s * 1.07 - 0.03, 0, -0.34, s * 1.07 + 0.03, 0.05, 0.34, M); }
  f.hull(-1.1, 0, -0.12, 1.1, 1.15, 0.12);
}
function sandbags(w, x, z, yaw, len = 3, rows = 4) {
  const f = new Frame(w, x, z, yaw), n = Math.round(len / 0.56), S = new THREE.Matrix4();
  if (!BAG) BAG = new THREE.SphereGeometry(1, 8, 5);
  for (let r = 0; r < rows; r++) for (let i = 0; i < n - (r % 2); i++) {
    const k = 0.8 + R() * 0.35, bx = -len / 2 + 0.3 + i * 0.56 + (r % 2) * 0.28 + (R() - 0.5) * 0.05;
    _l.makeRotationY((R() - 0.5) * 0.3).setPosition(bx, 0.1 + r * 0.19, (R() - 0.5) * 0.06);
    _l.multiply(S.makeScale(0.33, 0.125, 0.2 + R() * 0.03));
    f.add(BAG, _l, { mat: 'flat', color: [0.36 * k, 0.32 * k, 0.21 * k] });
  }
  f.hull(-len / 2, 0, -0.22, len / 2, rows * 0.19 + 0.02, 0.22, SURF.dirt); f.shade(-len / 2 + 0.2, 0.06, -0.08, len / 2 - 0.2, rows * 0.19 - 0.08, 0.08);
}
function lamp(w, x, z, yaw, fallen = false) {
  const b = w.b;
  if (fallen) {
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0, yaw, Math.PI / 2 - 0.04)).setPosition(x, 0.16, z);
    b.tbox(m, 0.26, 7.6, 0.26, { seg: 1.6, grow: 0.3, solid: 0 });
    w.solids.addOBox(x, 0, z, 3.8, 0.3, 0.14, yaw, HULL, SURF.concrete);
    return;
  }
  b.cylinder(x, z, 0, 7.6, 0.17, { seg: 2, vboards: true, faces: 'Y' }, 8, 0.1);
  const f = new Frame(w, x, z, yaw);
  f.box(0, 7.45, -0.06, 1.7, 7.58, 0.06, {}); f.box(1.2, 7.3, -0.16, 1.9, 7.45, 0.16, metal(STEEL, 0.5));
}
function crate(w, x, z, yaw, s = 0.8, y = 0) {
  const k = 0.8 + R() * 0.4;
  w.b.obox(x, y, z, s * 1.2, y + s, s, yaw, { mat: 'flat', color: [CRATE[0] * k, CRATE[1] * k, CRATE[2] * (0.8 + R() * 0.4)], seg: 1, surf: SURF.wood });
}
function tent(w, x, z, yaw, sag = 0.2) {
  const f = new Frame(w, x, z, yaw), P = plain([0.2, 0.2, 0.19]);
  for (const [px, pz] of [[-2, -1.5], [2, -1.5], [-2, 1.5], [2, 1.5]]) f.box(px - 0.03, 0, pz - 0.03, px + 0.03, 2.0, pz + 0.03, P);
  f.box(-0.03, 0, -1.53, 0.03, 2.7 - sag, -1.47, P); f.box(-0.03, 0, 1.47, 0.03, 2.7 - sag, 1.53, P);
  // the fly: one sheet over the ridge pole, sagging between the poles
  const r = 2.7 - sag, t = 0.03;
  const mid = 2.33 - sag * 0.7;
  f.across([[-2.1, 1.95], [-1.0, mid], [0, r], [1.0, mid], [2.1, 1.95], [2.1, 1.95 + t], [1.0, mid + t], [0, r + t], [-1.0, mid + t], [-2.1, 1.95 + t]], -1.6, 1.6, { ...plain(KHAKI), seg: 1.1 });
  f.box(-2.03, 0.9, -1.5, -1.97, 2.0, 1.5, plain(KHAKI));        // one wall still hanging
}

// Static dressing. Called before the collision grid and the ambient bake, so all of it is solid and shaded.
export function buildProps(w) {
  const b = w.b, H = Math.PI / 2, rng = R = makeRng(2087);
  BARRICADES.length = 0;
  b.setGroup('props');
  // Jan Marg: the queue that was still waiting when the gates were shut
  car(w, -5.6, 112, H + 0.08, CAR_WHITE, { flat: 0.06 }); car(w, -5.9, 103.6, H - 0.06, MAROON); car(w, 6.2, 108.5, H + 0.34, BLACK, { beacon: true });
  car(w, 6.6, 99.5, H - 0.2, CAR_WHITE, { flat: 0.05, roll: 0.03 }); car(w, -6.8, 83.5, 1.15, CAR_WHITE); car(w, 7.2, 76, H + 0.1, MAROON, { flat: 0.06 });
  auto(w, 4.6, 117.5, 1.95); auto(w, -7.4, 95, H + 0.4, { tipped: true }); bus(w, 3.6, 89.5, H + 0.42); truck(w, -4.6, 67.5, 0.14);
  // the checkpoint where the road meets the esplanade
  for (const [x, z, a] of [[-9, 63.6, 0.05], [-6.6, 63.9, -0.08], [2.6, 61.4, 0.1], [5, 61.2, -0.04], [7.4, 61.5, 0.12]]) barrier(w, x, z, a);
  sandbags(w, 11.5, 64.5, 0.2, 3.2); sandbags(w, 13.2, 66.2, H + 0.2, 2.6); sandbags(w, -11.2, 65.6, -0.25, 3.2);
  barricade(w, -1.6, 62.6, 0.3, true); barricade(w, 0.6, 59.6, -0.5); barricade(w, -3.4, 58.8, 1.2, true); barricade(w, 9.8, 58.6, 0.1);
  for (const z of [72, 96, 120]) { lamp(w, -11.4, z, 0); lamp(w, 11.4, z, Math.PI); }
  lamp(w, 12.5, 104, 0.6, true);

  // official cars drawn up by the Assembly; a few more outside the court
  car(w, -66, 37, 0.04, CAR_WHITE, { beacon: true }); car(w, -66.2, 41.4, -0.03, CAR_WHITE, { beacon: true, flat: 0.06 }); car(w, -65.6, 46, 0.3, CAR_WHITE, { beacon: true });
  car(w, 78, 64, 2.2, BLACK); car(w, 84.5, -63.5, -0.4, CAR_WHITE, { flat: 0.05, roll: -0.03 }); auto(w, 68, 30, 0.9); car(w, -30, -48, 0.6, MAROON, { flat: 0.06 });
  for (const x of [-60, -30, 30, 60]) lamp(w, x, 61.4, H);
  for (const z of [-40, -10, 20]) { lamp(w, -61.4, z, 0); lamp(w, 69.4, z, Math.PI); }
  lamp(w, 0, 50, 0.3, true); lamp(w, -44, -30, 2.0, true);
  // the relief camp east of the road, under the banyan
  tent(w, 34, 80, 0.2, 0.15); tent(w, 41, 86, -0.3, 0.45); tent(w, 33.5, 90, 0.1, 0.3);
  for (const [x, z, a, s] of [[37.5, 81.5, 0.3, 0.8], [38.2, 82.6, 0.9, 0.7], [37.9, 82, 0.5, 0.6], [30, 86, 0.1, 0.9], [44.6, 82.4, 1.1, 0.8]]) crate(w, x, z, a, s);
  crate(w, 37.9, 82, 0.4, 0.5, 0.8);
  barricade(w, 28.6, 76.4, 0.9, true); barricade(w, 46, 90.5, 0.2);
  // the depot in the court's portico, and the cache in the sunken court
  for (const [x, z, a, s] of [[128.6, -19.8, 0.2, 0.9], [129.6, -18.4, 0.7, 0.8], [129.2, -19.2, 0.4, 0.6], [121.8, -16, 0.1, 0.8], [132.5, -16.4, 1.2, 0.9]]) crate(w, x, z, a, s, 0.45);
  crate(w, 24.9, -67.3, 0.1, 0.8, -3.1); crate(w, 37.0, -67.4, 0.5, 0.9, -3.6); crate(w, 37.7, -68.8, 1.0, 0.7, -3.6); crate(w, 37.2, -67.9, 0.2, 0.5, -2.7);
  // rubble at the foot of the long fronts
  for (let i = 0; i < 46; i++) {
    const side = rng();
    let x, z;
    if (side < 0.3) { x = -152 + rng() * 60; z = (rng() < 0.5 ? -1 : 1) * (34.5 + rng() * 3); }
    else if (side < 0.55) { x = 100.5 + rng() * 2.5; z = -52 + rng() * 104; if (z > -40 && z < -12) continue; }
    else if (side < 0.7) { x = -156 - rng() * 3; z = -32 + rng() * 64; }
    else { x = -60 + rng() * 128; z = -50 + rng() * 108; if (Math.hypot(x + 14, z + 6) < 14 || w.inPool(x, z)) continue; }
    const s = 0.3 + rng() * 0.9, h = 0.12 + rng() * 0.35;
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rng() * 0.5 - 0.25, rng() * TAU, rng() * 0.5 - 0.25)).setPosition(x, h * 0.4, z);
    b.tbox(m, s, h, s * (0.6 + rng() * 0.8), { seg: 1.2, solid: 0, grow: 0.25 });
  }
  // what the signs and the great door stand on is solid from the start, so the ground survey walks round them
  for (const s of SIGNS) {
    const c = Math.cos(s.yaw), sn = Math.sin(s.yaw), h0 = w.heightAt(s.x, s.z);
    for (const px of [-s.w / 2 + 0.25, s.w / 2 - 0.25]) w.solids.addCyl(s.x + c * px, s.z - sn * px, 0.1, h0 - 1, h0 + s.y + s.h / 2, HULL, SURF.metal);
  }
  const d = w.landmarks.assemblyDoor;
  if (d) w.solids.addOBox(d.x, d.y, d.z, d.w / 2, d.y + d.h, 0.16, DOOR_YAW, SOLID.ALL, SURF.metal);
  b.setGroup('world');
}

// ---------------------------------------------------------------------------
// Painted things: road signs in three scripts, police lettering, and the enamel door of the Assembly.
const DOOR_YAW = Math.PI / 2 + 1.05;       // the great door, turned on its pivot and left that way
const DEVA = '"Teko", "Noto Sans Devanagari", "Nirmala UI", "Kohinoor Devanagari", "Mangal", sans-serif';
const GURM = '"Noto Sans Gurmukhi", "Nirmala UI", "Gurmukhi MN", "Raavi", sans-serif';
const SIGNS = [
  { x: -12.4, z: 78, yaw: 0.25, w: 4.6, h: 2.0, y: 3.2, bg: '#1d5c3c', fg: '#e9e6da', lines: [['कैपिटल कॉम्प्लेक्स', DEVA, 86], ['ਕੈਪੀਟਲ ਕੰਪਲੈਕਸ', GURM, 58], ['CAPITOL COMPLEX', DEVA, 76]] },
  { x: 12.6, z: 69.6, yaw: -0.2, w: 3.4, h: 2.2, y: 2.3, bg: '#d6ad1e', fg: '#141414', stripes: true, lines: [['संक्रमित क्षेत्र', DEVA, 92], ['QUARANTINE ZONE', DEVA, 78], ['प्रवेश निषेध · NO ENTRY', DEVA, 58]] },
  { x: 27.4, z: 74.2, yaw: 0.9, w: 3.0, h: 1.6, y: 2.2, bg: '#e9e6da', fg: '#1a3f7a', lines: [['निकासी केंद्र', DEVA, 88], ['EVACUATION POINT', DEVA, 70], ['← B', DEVA, 70]] },
  { x: 66, z: -6, yaw: -Math.PI / 2, w: 3.6, h: 1.9, y: 2.6, bg: '#1d3f6e', fg: '#e9e6da', lines: [['उच्च न्यायालय', DEVA, 88], ['ਹਾਈ ਕੋਰਟ', GURM, 60], ['HIGH COURT', DEVA, 76]] },
  { x: -56, z: 36.5, yaw: Math.PI / 2, w: 3.6, h: 1.9, y: 2.6, bg: '#1d3f6e', fg: '#e9e6da', lines: [['विधान सभा', DEVA, 92], ['ਵਿਧਾਨ ਸਭਾ', GURM, 60], ['VIDHAN SABHA', DEVA, 76]] },
  { x: 8.6, z: -52, yaw: 0, w: 3.2, h: 1.7, y: 2.4, bg: '#1d5c3c', fg: '#e9e6da', lines: [['खुला हाथ स्मारक', DEVA, 84], ['OPEN HAND', DEVA, 78], ['↑ 40 m', DEVA, 56]] },
];

function grime(ctx, W, H, rng, amount = 1) {
  // rust weeping down from the top edge and the bolt heads, scratches, sun-bleach
  ctx.globalCompositeOperation = 'multiply';
  for (let i = 0; i < 26 * amount; i++) {
    const x = rng() * W, len = H * (0.15 + rng() * 0.7), wd = 4 + rng() * 26, g = ctx.createLinearGradient(0, 0, 0, len);
    g.addColorStop(0, `rgba(${90 + rng() * 40},${50 + rng() * 25},${25 + rng() * 15},${0.25 + rng() * 0.35})`); g.addColorStop(1, 'rgba(120,80,50,0)');
    ctx.fillStyle = g; ctx.fillRect(x, 0, wd, len);
  }
  ctx.globalCompositeOperation = 'source-over';
  for (let i = 0; i < 70 * amount; i++) { const x = rng() * W, y = rng() * H, r = 2 + rng() * 22; ctx.fillStyle = `rgba(${70 + rng() * 50},${40 + rng() * 25},${20 + rng() * 10},${0.25 + rng() * 0.45})`; ctx.beginPath(); ctx.ellipse(x, y, r, r * (0.4 + rng() * 0.9), rng() * 3, 0, TAU); ctx.fill(); }
  ctx.strokeStyle = 'rgba(230,225,210,0.22)'; ctx.lineWidth = 1.5;
  for (let i = 0; i < 30 * amount; i++) { const x = rng() * W, y = rng() * H; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (rng() - 0.5) * 160, y + (rng() - 0.5) * 50); ctx.stroke(); }
  ctx.fillStyle = 'rgba(190,185,170,0.16)'; ctx.fillRect(0, 0, W, H);
}

// Lines of lettering, centred and fitted to a panel.
function letter(x, lines, W, top, usable, fg) {
  x.fillStyle = fg; x.textAlign = 'center'; x.textBaseline = 'middle';
  const total = lines.reduce((a, l) => a + l[2] * 1.18, 0), k = Math.min(1, usable / total);
  let y = top + (usable - total * k) / 2;
  for (const [text, font, size] of lines) {
    const px = size * k; x.font = `600 ${px}px ${font}`;
    const tw = x.measureText(text).width, sc = Math.min(1, (W - 110) / tw);
    x.save(); x.translate(W / 2, y + px * 0.59); x.scale(sc, 1); x.fillText(text, 0, 0); x.restore();
    y += px * 1.18;
  }
}
function signCanvas(s, rng) {
  const W = 1024, H = Math.round(1024 * s.h / s.w), c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = s.bg; x.fillRect(0, 0, W, H);
  if (s.stripes) { x.fillStyle = '#141414'; for (let i = -H; i < W; i += 90) { x.beginPath(); x.moveTo(i, H); x.lineTo(i + 45, H); x.lineTo(i + 45 + 70, H - 70); x.lineTo(i + 70, H - 70); x.closePath(); x.fill(); } }
  x.strokeStyle = s.fg; x.lineWidth = 12; x.strokeRect(22, 22, W - 44, H - 44 - (s.stripes ? 70 : 0));
  letter(x, s.lines, W, 30, H - 60 - (s.stripes ? 70 : 0), s.fg);
  grime(x, W, H, rng);
  return c;
}
function plateCanvas(rng) {
  const W = 1024, H = 318, c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#d9ad1c'; x.fillRect(0, 0, W, H);
  x.fillStyle = '#b3261c'; for (let i = 0; i < W; i += 128) { x.fillRect(i, 0, 64, 26); x.fillRect(i + 64, H - 26, 64, 26); }
  letter(x, [['चंडीगढ़ पुलिस', DEVA, 118], ['CHANDIGARH POLICE', DEVA, 96]], W, 34, H - 68, '#16306b');
  grime(x, W, H, rng, 0.8);
  return c;
}

// An original composition in the manner of the Assembly's enamelled door: the day above, the earth below,
// the sun's path between them. Fifty-six panels, a few of them gone.
function doorTexture(rng) {
  const W = 1024, H = 1024, c = document.createElement('canvas'); c.width = W; c.height = H + 32;       // the strip below the picture colours the door's edges
  const x = c.getContext('2d');
  x.fillStyle = '#2a2622'; x.fillRect(0, H, W, 32);
  x.fillStyle = '#e4dcc4'; x.fillRect(0, 0, W, H);
  x.fillStyle = '#2f5f9a'; x.fillRect(0, 0, W, 300); x.fillStyle = '#c2462d'; x.fillRect(0, 620, W * 0.55, 404); x.fillStyle = '#3f7a48'; x.fillRect(W * 0.55, 620, W * 0.45, 404);
  x.fillStyle = '#e0b02c'; x.beginPath(); x.arc(760, 190, 118, 0, TAU); x.fill(); x.strokeStyle = '#c2462d'; x.lineWidth = 22; x.beginPath(); x.arc(760, 190, 150, 0, TAU); x.stroke();
  x.fillStyle = '#f1ecdc'; x.beginPath(); x.arc(210, 160, 82, 0, TAU); x.fill(); x.fillStyle = '#2f5f9a'; x.beginPath(); x.arc(246, 138, 74, 0, TAU); x.fill();        // crescent
  // the sun's day: a wave crossing the horizon
  x.strokeStyle = '#141414'; x.lineWidth = 16; x.beginPath(); x.moveTo(0, 460); x.lineTo(W, 460); x.stroke();
  x.lineWidth = 12; x.beginPath(); for (let i = 0; i <= W; i += 8) { const y = 460 - Math.sin((i / W) * TAU - 0.4) * 120; if (i) x.lineTo(i, y); else x.moveTo(i, y); } x.stroke();
  // a tree, a river, the hills
  x.fillStyle = '#141414'; x.fillRect(196, 640, 26, 250); x.fillStyle = '#3f7a48'; x.beginPath(); x.arc(209, 640, 110, 0, TAU); x.fill(); x.fillStyle = '#e0b02c'; x.beginPath(); x.arc(250, 600, 30, 0, TAU); x.fill();
  x.strokeStyle = '#2f5f9a'; x.lineWidth = 46; x.lineCap = 'round'; x.beginPath(); x.moveTo(600, 640); x.bezierCurveTo(760, 720, 560, 820, 760, 880); x.bezierCurveTo(900, 920, 820, 980, 960, 1010); x.stroke();
  x.fillStyle = '#141414'; x.beginPath(); x.moveTo(380, 620); x.lineTo(470, 500); x.lineTo(540, 580); x.lineTo(600, 520); x.lineTo(680, 620); x.closePath(); x.fill();
  x.fillStyle = '#f1ecdc'; x.beginPath(); x.moveTo(820, 660); x.lineTo(900, 660); x.lineTo(860, 760); x.closePath(); x.fill();
  // panel joints, and panels that have fallen out
  x.strokeStyle = 'rgba(20,20,18,0.85)'; x.lineWidth = 5;
  for (let i = 1; i < 8; i++) { x.beginPath(); x.moveTo(i * W / 8, 0); x.lineTo(i * W / 8, H); x.stroke(); }
  for (let j = 1; j < 7; j++) { x.beginPath(); x.moveTo(0, j * H / 7); x.lineTo(W, j * H / 7); x.stroke(); }
  for (let i = 0; i < 6; i++) { const px = Math.floor(rng() * 8) * W / 8, py = Math.floor(rng() * 7) * H / 7; x.fillStyle = '#2b2018'; x.fillRect(px + 3, py + 3, W / 8 - 6, H / 7 - 6); }
  grime(x, W, H, rng, 1.6);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

// Many flat panels as one mesh. Each quad: corners bottom-left, bottom-right, top-right, top-left, and its rectangle in the atlas.
function quadGeometry(quads) {
  const n = quads.length, pos = new Float32Array(n * 12), nrm = new Float32Array(n * 12), uv = new Float32Array(n * 8), idx = new Uint16Array(n * 6);
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  quads.forEach((q, i) => {
    const [a, b, c, d] = q.p;
    e1.subVectors(b, a); e2.subVectors(d, a); e1.cross(e2).normalize();
    [a, b, c, d].forEach((p, k) => { pos.set([p.x, p.y, p.z], i * 12 + k * 3); nrm.set([e1.x, e1.y, e1.z], i * 12 + k * 3); });
    const [u0, v0, u1, v1] = q.uv; uv.set([u0, v0, u1, v0, u1, v1, u0, v1], i * 8);
    idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}
function boxesGeometry(boxes) {
  const parts = boxes.map(({ size, matrix }) => new THREE.BoxGeometry(size[0], size[1], size[2]).applyMatrix4(matrix).toNonIndexed());
  const total = parts.reduce((a, g) => a + g.attributes.position.count, 0), pos = new Float32Array(total * 3), nrm = new Float32Array(total * 3);
  let o = 0;
  for (const g of parts) { pos.set(g.attributes.position.array, o); nrm.set(g.attributes.normal.array, o); o += g.attributes.position.count * 3; g.dispose(); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return g;
}

// Built after loading. Every sign and every police plate shares one painted sheet, so the lot is two draw calls;
// the sheet is repainted if the faces for the three scripts arrive late.
export async function buildSigns(game) {
  const scene = game.scene, W = game.world, S = 2048;
  const sheet = document.createElement('canvas'); sheet.width = S; sheet.height = S;
  const cells = SIGNS.map((s, i) => {
    const k = Math.min(1000 / s.w, 488 / s.h), pw = Math.round(s.w * k), ph = Math.round(s.h * k);
    return { px: (i % 2) * 1024 + 12, py: Math.floor(i / 2) * 512 + 12, pw, ph };
  });
  const plate = { px: 12, py: 1548, pw: 1000, ph: 310 };
  const rect = c => [c.px / S, 1 - (c.py + c.ph) / S, (c.px + c.pw) / S, 1 - c.py / S];
  const tex = new THREE.CanvasTexture(sheet); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const paint = () => {
    const rng = makeRng(555), x = sheet.getContext('2d');
    x.fillStyle = '#2a2c2a'; x.fillRect(0, 0, S, S);
    SIGNS.forEach((s, i) => { const c = cells[i]; x.drawImage(signCanvas(s, rng), c.px, c.py, c.pw, c.ph); });
    x.drawImage(plateCanvas(rng), plate.px, plate.py, plate.pw, plate.ph);
    tex.needsUpdate = true;
  };
  try {
    const want = [document.fonts.load('600 64px Teko', 'कैपिटल CAPITOL'), document.fonts.load('600 64px "Noto Sans Gurmukhi"', 'ਕੈਪੀਟਲ')];
    await Promise.race([Promise.all(want), new Promise(r => setTimeout(r, 2500))]);
    document.fonts.addEventListener('loadingdone', e => { if ([...(e.fontfaces || [])].some(f => /Teko|Gurmukhi/.test(f.family))) paint(); });
  } catch { /* whatever the system has will do */ }
  paint();

  const quads = [], boxes = [], rng = makeRng(556), m = new THREE.Matrix4(), V = (x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(m);
  SIGNS.forEach((s, i) => {
    m.makeRotationFromEuler(new THREE.Euler(0, s.yaw, (rng() - 0.5) * 0.08, 'YZX')).setPosition(s.x, W.heightAt(s.x, s.z), s.z);
    const hw = s.w / 2, y0 = s.y - s.h / 2, y1 = s.y + s.h / 2;
    quads.push({ p: [V(-hw, y0, 0.012), V(hw, y0, 0.012), V(hw, y1, 0.012), V(-hw, y1, 0.012)], uv: rect(cells[i]) });
    boxes.push({ size: [s.w, s.h, 0.03], matrix: m.clone().multiply(new THREE.Matrix4().makeTranslation(0, s.y, -0.006)) });
    for (const px of [-hw + 0.25, hw - 0.25]) boxes.push({ size: [0.09, y1 + 0.6, 0.09], matrix: m.clone().multiply(new THREE.Matrix4().makeTranslation(px, (y1 - 0.6) / 2, -0.066)) });
  });
  for (const k of BARRICADES) {
    m.makeRotationY(k.yaw).setPosition(k.x, 0, k.z);
    const r = rect(plate);
    if (k.fallen) quads.push({ p: [V(-1.0, 0.088, 0.31), V(1.0, 0.088, 0.31), V(1.0, 0.088, -0.31), V(-1.0, 0.088, -0.31)], uv: r });
    else {
      quads.push({ p: [V(-1.0, 0.5, 0.026), V(1.0, 0.5, 0.026), V(1.0, 1.12, 0.026), V(-1.0, 1.12, 0.026)], uv: r });
      quads.push({ p: [V(1.0, 0.5, -0.026), V(-1.0, 0.5, -0.026), V(-1.0, 1.12, -0.026), V(1.0, 1.12, -0.026)], uv: r });
    }
  }
  const faces = new THREE.Mesh(quadGeometry(quads), standard({ map: tex, roughness: 0.62, metalness: 0.15 }, 'sign'));
  const backs = new THREE.Mesh(boxesGeometry(boxes), standard({ color: 0x2a2c2a, roughness: 0.7, metalness: 0.55 }, 'signpost'));
  for (const mesh of [faces, backs]) { mesh.castShadow = true; mesh.receiveShadow = true; mesh.matrixAutoUpdate = false; scene.add(mesh); }

  // the great door
  const d = W.landmarks.assemblyDoor;
  if (d) {
    m.makeRotationY(DOOR_YAW).setPosition(d.x, d.y + 0.05, d.z);
    const hw = d.w / 2, h = d.h, t = 0.11, art = [0, 32 / 1056, 1, 1], rim = [0.2, 8 / 1056, 0.8, 24 / 1056];
    const door = new THREE.Mesh(quadGeometry([
      { p: [V(-hw, 0, t), V(hw, 0, t), V(hw, h, t), V(-hw, h, t)], uv: art }, { p: [V(hw, 0, -t), V(-hw, 0, -t), V(-hw, h, -t), V(hw, h, -t)], uv: art },
      { p: [V(hw, 0, t), V(hw, 0, -t), V(hw, h, -t), V(hw, h, t)], uv: rim }, { p: [V(-hw, 0, -t), V(-hw, 0, t), V(-hw, h, t), V(-hw, h, -t)], uv: rim },
      { p: [V(-hw, h, t), V(hw, h, t), V(hw, h, -t), V(-hw, h, -t)], uv: rim }, { p: [V(-hw, 0, -t), V(hw, 0, -t), V(hw, 0, t), V(-hw, 0, t)], uv: rim },
    ]), standard({ map: doorTexture(makeRng(557)), roughness: 0.38, metalness: 0.15 }, 'sign'));
    door.castShadow = true; door.receiveShadow = true; door.matrixAutoUpdate = false;
    scene.add(door);
  }
}
