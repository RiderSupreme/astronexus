// Foliage atlas.
//
// Every leaf in the game is painted here, on a 2D canvas, at load: sixteen
// tiles of leaf clusters, grasses, creepers and water plants that the
// vegetation is then built from as alpha-tested cards. The species are the
// ones that would actually take Chandigarh back: banyan and peepal, neem,
// bougainvillea, kans grass in its September plume, lotus on the pools.
import { THREE } from './lib/three.js';
import { makeRng, TAU, lerp, clamp } from './util.js';

export const TILE = 512, GRID = 4;
// name -> [column, row]; row 0 is the top of the atlas
export const TILES = {
  grass: [0, 0], grassDry: [1, 0], kans: [2, 0], weeds: [3, 0],
  banyan: [0, 1], peepal: [1, 1], neem: [2, 1], bougain: [3, 1],
  creeper: [0, 2], creeperThin: [1, 2], vine: [2, 2], fern: [3, 2],
  lily: [0, 3], litter: [1, 3], bush: [2, 3], reed: [3, 3],
};
// UV rectangle [u0, v0, u1, v1] of a tile, inset a little so mip levels do not bleed between neighbours.
export function tileUV(name) {
  const [c, r] = TILES[name], e = 6 / (TILE * GRID);
  return [c / GRID + e, 1 - (r + 1) / GRID + e, (c + 1) / GRID - e, 1 - r / GRID - e];
}

const css = (c, a = 1) => `rgba(${Math.round(clamp(c[0], 0, 1) * 255)},${Math.round(clamp(c[1], 0, 1) * 255)},${Math.round(clamp(c[2], 0, 1) * 255)},${a})`;
const mul = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const jitter = (rng, c, amt) => { const k = 1 + rng.range(-amt, amt); return [c[0] * k * (1 + rng.range(-amt, amt) * 0.4), c[1] * k, c[2] * k * (1 + rng.range(-amt, amt) * 0.6)]; };

// A single leaf, drawn along +x from its stalk at the origin.
function leafPath(ctx, len, wid, kind) {
  ctx.beginPath();
  if (kind === 'heart') {            // peepal: a heart drawn out into a long drip tip
    ctx.moveTo(len * 0.06, 0);
    ctx.bezierCurveTo(-len * 0.1, -wid * 0.95, len * 0.42, -wid * 0.9, len * 0.66, -wid * 0.2);
    ctx.quadraticCurveTo(len * 0.8, -wid * 0.03, len, 0);
    ctx.quadraticCurveTo(len * 0.8, wid * 0.03, len * 0.66, wid * 0.2);
    ctx.bezierCurveTo(len * 0.42, wid * 0.9, -len * 0.1, wid * 0.95, len * 0.06, 0);
  } else if (kind === 'lance') {     // narrow, pointed both ends
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(len * 0.4, -wid, len, 0);
    ctx.quadraticCurveTo(len * 0.4, wid, 0, 0);
  } else if (kind === 'round') {     // small ovate
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(len * 0.1, -wid, len * 0.9, -wid, len, 0);
    ctx.bezierCurveTo(len * 0.9, wid, len * 0.1, wid, 0, 0);
  } else {                           // banyan: broad, leathery, blunt
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(len * 0.2, -wid * 0.82, len * 0.78, -wid * 0.7, len, 0);
    ctx.bezierCurveTo(len * 0.78, wid * 0.7, len * 0.2, wid * 0.82, 0, 0);
  }
  ctx.closePath();
}
function leaf(ctx, x, y, ang, len, wid, col, kind = 'oval', veins = true) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
  leafPath(ctx, len, wid, kind);
  const g = ctx.createLinearGradient(0, -wid, 0, wid);
  g.addColorStop(0, css(mul(col, 1.12))); g.addColorStop(0.5, css(col)); g.addColorStop(0.52, css(mul(col, 0.86))); g.addColorStop(1, css(mul(col, 0.78)));
  ctx.fillStyle = g; ctx.fill();
  if (veins) {
    ctx.strokeStyle = css(mix(col, [0.75, 0.85, 0.5], 0.4), 0.8); ctx.lineWidth = Math.max(0.8, wid * 0.07);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(len * 0.94, 0); ctx.stroke();
    if (wid > 9) {
      ctx.lineWidth = Math.max(0.5, wid * 0.03); ctx.globalAlpha = 0.5;
      for (let i = 1; i <= 4; i++) { const t = i / 5.2; ctx.beginPath(); ctx.moveTo(len * t, 0); ctx.lineTo(len * (t + 0.16), -wid * 0.55 * (1 - t * 0.6)); ctx.moveTo(len * t, 0); ctx.lineTo(len * (t + 0.16), wid * 0.55 * (1 - t * 0.6)); ctx.stroke(); }
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();
}

// Twigs radiating from the middle of the tile, leaves set alternately along them, in a dim back layer and a bright front one.
function cluster(ctx, rng, S, { kind, twigs, perTwig, len, wid, palette, reach = 0.44, twigCol = [0.2, 0.15, 0.09], sparse = 0 }) {
  const cx = S / 2, cy = S / 2;
  for (let layer = 0; layer < 2; layer++) {
    const dim = layer === 0 ? 0.58 : 1.0, nT = layer === 0 ? Math.round(twigs * 1.2) : twigs;
    for (let t = 0; t < nT; t++) {
      const a0 = (t / nT) * TAU + rng.range(-0.3, 0.3), L = S * reach * rng.range(0.72, 1.0), bend = rng.range(-0.5, 0.5);
      const P = f => { const a = a0 + bend * f; return [cx + Math.cos(a) * L * f, cy + Math.sin(a) * L * f, a]; };
      ctx.strokeStyle = css(mul(twigCol, dim)); ctx.lineWidth = S * 0.007 * (layer ? 1 : 0.8); ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(cx, cy);
      for (let f = 0.1; f <= 1.001; f += 0.1) { const p = P(f); ctx.lineTo(p[0], p[1]); }
      ctx.stroke();
      const m = perTwig + rng.int(-1, 1);
      for (let i = 0; i < m; i++) {
        if (rng() < sparse) continue;
        const f = 0.18 + 0.82 * (i + 0.5) / m, p = P(f), side = i % 2 ? 1 : -1;
        const col = mul(jitter(rng, rng.pick(palette), 0.14), dim);
        leaf(ctx, p[0], p[1], p[2] + side * rng.range(0.45, 1.15), len * S * rng.range(0.75, 1.1), wid * S * rng.range(0.8, 1.1), col, kind);
      }
      const p = P(1);
      leaf(ctx, p[0], p[1], p[2] + rng.range(-0.3, 0.3), len * S * rng.range(0.8, 1.05), wid * S, mul(jitter(rng, rng.pick(palette), 0.14), dim), kind);
    }
  }
}

// Compound leaves: a stalk with many small leaflets in pairs (neem, gulmohar, ferns).
function frond(ctx, rng, x, y, ang, L, col, { pairs = 12, leafLen = 0.16, leafWid = 0.035, curve = 0.3, taper = 0.6, kind = 'lance' } = {}) {
  const bend = rng.range(-curve, curve);
  const P = f => { const a = ang + bend * f; return [x + Math.cos(a) * L * f, y + Math.sin(a) * L * f, a]; };
  ctx.strokeStyle = css(mul(col, 0.6)); ctx.lineWidth = Math.max(1, L * 0.012); ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x, y); for (let f = 0.1; f <= 1.001; f += 0.1) { const p = P(f); ctx.lineTo(p[0], p[1]); } ctx.stroke();
  for (let i = 0; i < pairs; i++) {
    const f = 0.12 + 0.88 * (i + 0.5) / pairs, p = P(f), s = 1 - taper * Math.abs(f - 0.4) / 0.6;
    for (const side of [-1, 1]) leaf(ctx, p[0], p[1], p[2] + side * rng.range(0.9, 1.25), L * leafLen * s, L * leafWid * s, jitter(rng, col, 0.12), kind, false);
  }
}

// One blade of grass: a tapering ribbon from (x, y) upward, arching to one side.
function blade(ctx, x, y, h, lean, w, c0, c1) {
  const tx = x + lean, ty = y - h, mx = x + lean * 0.35, my = y - h * 0.62;
  const g = ctx.createLinearGradient(0, y, 0, ty);
  g.addColorStop(0, css(mul(c0, 0.6))); g.addColorStop(0.35, css(c0)); g.addColorStop(1, css(c1));
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.moveTo(x - w / 2, y); ctx.quadraticCurveTo(mx - w * 0.4, my, tx, ty); ctx.quadraticCurveTo(mx + w * 0.4, my, x + w / 2, y); ctx.closePath(); ctx.fill();
}

const GREENS = [[0.24, 0.38, 0.12], [0.3, 0.44, 0.14], [0.2, 0.33, 0.11], [0.35, 0.47, 0.16]];
const DEEP = [[0.17, 0.31, 0.12], [0.2, 0.36, 0.13], [0.15, 0.27, 0.11], [0.24, 0.4, 0.14]];

const PAINTERS = {
  grass(ctx, rng, S) {
    for (let i = 0; i < 150; i++) {
      const d = i / 150, x = S * rng.range(0.1, 0.9), h = S * rng.range(0.35, 0.93) * (0.55 + 0.45 * (1 - Math.abs(x / S - 0.5) * 1.3));
      const c0 = mul(jitter(rng, rng.pick(GREENS), 0.15), 0.6 + 0.4 * d), c1 = mix(c0, [0.55, 0.6, 0.25], rng.range(0.2, 0.7));
      blade(ctx, x, S - 4, h, rng.range(-0.22, 0.22) * S * (0.4 + h / S), S * rng.range(0.008, 0.018), c0, c1);
    }
    // seed heads
    for (let i = 0; i < 12; i++) { const x = S * rng.range(0.18, 0.82), h = S * rng.range(0.7, 0.93), lean = rng.range(-0.1, 0.1) * S;
      ctx.strokeStyle = css([0.45, 0.42, 0.2]); ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(x, S - 4); ctx.quadraticCurveTo(x + lean * 0.3, S - h * 0.6, x + lean, S - h); ctx.stroke();
      for (let k = 0; k < 9; k++) { ctx.fillStyle = css(jitter(rng, [0.6, 0.52, 0.28], 0.15)); ctx.beginPath(); ctx.ellipse(x + lean + rng.range(-5, 5), S - h + k * 4.5 - 12, 2.4, 4.2, rng.range(-0.5, 0.5), 0, TAU); ctx.fill(); } }
  },
  grassDry(ctx, rng, S) {
    const STRAW = [[0.5, 0.44, 0.22], [0.58, 0.5, 0.27], [0.42, 0.4, 0.18], [0.36, 0.4, 0.15]];
    for (let i = 0; i < 135; i++) {
      const d = i / 135, x = S * rng.range(0.08, 0.92), h = S * rng.range(0.3, 0.9) * (0.55 + 0.45 * (1 - Math.abs(x / S - 0.5) * 1.3));
      const c0 = mul(jitter(rng, rng.pick(STRAW), 0.15), 0.55 + 0.45 * d), c1 = mix(c0, [0.78, 0.7, 0.42], rng.range(0.3, 0.8));
      blade(ctx, x, S - 4, h, rng.range(-0.3, 0.3) * S * (0.4 + h / S), S * rng.range(0.007, 0.015), c0, c1);
    }
  },
  // Saccharum spontaneum: tall cane grass that flowers in silver plumes as the monsoon ends.
  kans(ctx, rng, S) {
    for (let i = 0; i < 46; i++) { const x = S * rng.range(0.2, 0.8); blade(ctx, x, S - 4, S * rng.range(0.3, 0.62), rng.range(-0.34, 0.34) * S, S * rng.range(0.01, 0.018), mul(rng.pick(GREENS), rng.range(0.6, 1)), [0.5, 0.56, 0.24]); }
    const plumes = [];
    for (let i = 0; i < 13; i++) plumes.push({ x: S * rng.range(0.24, 0.76), h: S * rng.range(0.62, 0.95), lean: rng.range(-0.2, 0.2) * S });
    plumes.sort((a, b) => a.h - b.h);
    for (const p of plumes) {
      const tx = p.x + p.lean, ty = S - p.h;
      ctx.strokeStyle = css([0.5, 0.5, 0.28]); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(p.x, S - 4); ctx.quadraticCurveTo(p.x + p.lean * 0.2, S - p.h * 0.55, tx, ty + S * 0.2); ctx.stroke();
      // the plume: hundreds of fine hairs about a drooping axis
      const PL = S * rng.range(0.2, 0.27), droop = Math.sign(p.lean || 1) * rng.range(0.1, 0.4);
      for (let k = 0; k < 190; k++) {
        const f = rng(), ax = tx + droop * PL * f * f * 0.6 * (1 - f * 0.2), ay = ty + S * 0.2 - PL * f;
        const wdt = PL * 0.16 * Math.sin(Math.PI * Math.pow(f, 0.7)) + 1, a = -Math.PI / 2 + rng.range(-1, 1) * 0.9 + droop * 0.5;
        const tone = mix([0.93, 0.9, 0.86], [0.78, 0.66, 0.62], rng() * (1 - f) * 0.9);
        ctx.strokeStyle = css(tone, rng.range(0.35, 0.8)); ctx.lineWidth = rng.range(0.6, 1.5);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax + Math.cos(a) * wdt * rng.range(0.6, 1.6), ay + Math.sin(a) * wdt * rng.range(0.4, 1.1)); ctx.stroke();
      }
    }
  },
  weeds(ctx, rng, S) {
    for (let i = 0; i < 26; i++) {
      const x = S * rng.range(0.12, 0.88), y = S - 6 - rng.range(0, S * 0.1), L = S * rng.range(0.16, 0.36);
      frond(ctx, rng, x, y, -Math.PI / 2 + rng.range(-0.9, 0.9), L, mul(rng.pick(GREENS), rng.range(0.7, 1.05)), { pairs: 6, leafLen: 0.3, leafWid: 0.11, kind: 'round', taper: 0.3 });
    }
    for (let i = 0; i < 14; i++) { ctx.fillStyle = css(jitter(rng, [0.85, 0.75, 0.2], 0.1)); ctx.beginPath(); ctx.arc(S * rng.range(0.15, 0.85), S * rng.range(0.6, 0.86), 3.2, 0, TAU); ctx.fill(); }
  },
  banyan(ctx, rng, S) { cluster(ctx, rng, S, { kind: 'oval', twigs: 7, perTwig: 6, len: 0.2, wid: 0.068, palette: DEEP }); },
  peepal(ctx, rng, S) { cluster(ctx, rng, S, { kind: 'heart', twigs: 8, perTwig: 6, len: 0.19, wid: 0.075, palette: [[0.2, 0.36, 0.11], [0.26, 0.42, 0.13], [0.33, 0.45, 0.14], [0.45, 0.47, 0.14]], sparse: 0.08 }); },
  neem(ctx, rng, S) {
    for (let layer = 0; layer < 2; layer++) for (let i = 0; i < (layer ? 9 : 11); i++) {
      const a = (i / (layer ? 9 : 11)) * TAU + rng.range(-0.25, 0.25);
      frond(ctx, rng, S / 2 + Math.cos(a) * S * 0.03, S / 2 + Math.sin(a) * S * 0.03, a, S * rng.range(0.34, 0.45), mul(jitter(rng, rng.pick(GREENS), 0.12), layer ? 1 : 0.6), { pairs: 11, leafLen: 0.2, leafWid: 0.045 });
    }
  },
  bougain(ctx, rng, S) {
    cluster(ctx, rng, S, { kind: 'round', twigs: 7, perTwig: 5, len: 0.1, wid: 0.045, palette: DEEP, reach: 0.42, sparse: 0.25 });
    const BR = [[0.78, 0.1, 0.42], [0.86, 0.16, 0.5], [0.66, 0.07, 0.36], [0.9, 0.3, 0.55]];
    for (let i = 0; i < 46; i++) {
      const a = rng.range(0, TAU), r = S * 0.42 * Math.sqrt(rng()), x = S / 2 + Math.cos(a) * r, y = S / 2 + Math.sin(a) * r, c = jitter(rng, rng.pick(BR), 0.12), a0 = rng.range(0, TAU);
      for (let k = 0; k < 3; k++) leaf(ctx, x, y, a0 + k * TAU / 3, S * 0.058, S * 0.03, c, 'round', false);
      ctx.fillStyle = css([0.95, 0.9, 0.7]); ctx.beginPath(); ctx.arc(x, y, 1.8, 0, TAU); ctx.fill();
    }
  },
  // A wall creeper: stems wandering upward, the wall behind showing through in places.
  creeper(ctx, rng, S) { creeperTile(ctx, rng, S, 34, 0.0); },
  creeperThin(ctx, rng, S) { creeperTile(ctx, rng, S, 17, 0.35); },
  // Hanging strands. The card this goes on is twice as tall as it is wide, so everything is drawn squashed.
  vine(ctx, rng, S) {
    ctx.save(); ctx.scale(1, 0.5);
    for (let i = 0; i < 7; i++) {
      let x = S * (0.12 + 0.76 * (i + rng.range(0.2, 0.8)) / 7), y = 0; const end = S * 2 * rng.range(0.55, 1.0), ph = rng.range(0, TAU);
      ctx.strokeStyle = css([0.16, 0.15, 0.08]); ctx.lineWidth = 2.2; ctx.beginPath(); ctx.moveTo(x, 0);
      const pts = [];
      while (y < end) { y += 9; x += Math.sin(y * 0.02 + ph) * 1.1; ctx.lineTo(x, y); pts.push([x, y]); }
      ctx.stroke();
      for (let k = 2; k < pts.length; k += 2) { const p = pts[k], side = (k >> 1) % 2 ? 1 : -1;
        leaf(ctx, p[0], p[1], Math.PI / 2 + side * rng.range(0.7, 1.3), S * rng.range(0.035, 0.06), S * 0.02, jitter(rng, rng.pick(DEEP), 0.15), 'heart', false); }
    }
    ctx.restore();
  },
  fern(ctx, rng, S) {
    for (let i = 0; i < 15; i++) frond(ctx, rng, S / 2 + rng.range(-0.05, 0.05) * S, S - 8, -Math.PI / 2 + (i / 14 - 0.5) * 2.5 + rng.range(-0.1, 0.1), S * rng.range(0.5, 0.86), mul(jitter(rng, rng.pick(GREENS), 0.12), i < 6 ? 0.62 : 1), { pairs: 15, leafLen: 0.17, leafWid: 0.04, curve: 0.5, taper: 0.75 });
  },
  // Seen from straight above: lotus pads with their notch, and a few flowers.
  lily(ctx, rng, S) {
    for (let i = 0; i < 15; i++) {
      const x = S * rng.range(0.14, 0.86), y = S * rng.range(0.14, 0.86), r = S * rng.range(0.055, 0.125), a0 = rng.range(0, TAU), c = jitter(rng, [0.16, 0.33, 0.12], 0.18);
      ctx.fillStyle = css(c); ctx.beginPath(); ctx.moveTo(x, y); ctx.arc(x, y, r, a0 + 0.16, a0 + TAU - 0.16); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = css(mul(c, 1.35), 0.7); ctx.lineWidth = 1;
      for (let k = 1; k < 13; k++) { const a = a0 + 0.16 + (TAU - 0.32) * k / 13; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * r * 0.93, y + Math.sin(a) * r * 0.93); ctx.stroke(); }
      ctx.strokeStyle = css(mul(c, 0.6)); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, r, a0 + 0.16, a0 + TAU - 0.16); ctx.stroke();
    }
    for (let i = 0; i < 4; i++) {
      const x = S * rng.range(0.2, 0.8), y = S * rng.range(0.2, 0.8), r = S * rng.range(0.035, 0.05);
      for (let ring = 0; ring < 2; ring++) for (let k = 0; k < 9; k++) { const a = k * TAU / 9 + ring * 0.35; leaf(ctx, x, y, a, r * (ring ? 0.72 : 1.1), r * 0.3, ring ? [0.97, 0.75, 0.82] : [0.9, 0.5, 0.66], 'lance', false); }
      ctx.fillStyle = css([0.93, 0.78, 0.25]); ctx.beginPath(); ctx.arc(x, y, r * 0.24, 0, TAU); ctx.fill();
    }
  },
  litter(ctx, rng, S) {
    const BROWN = [[0.36, 0.24, 0.1], [0.45, 0.3, 0.12], [0.3, 0.2, 0.09], [0.5, 0.4, 0.15], [0.26, 0.28, 0.1]];
    for (let i = 0; i < 70; i++) leaf(ctx, S * rng.range(0.1, 0.9), S * rng.range(0.1, 0.9), rng.range(0, TAU), S * rng.range(0.05, 0.1), S * rng.range(0.018, 0.04), jitter(rng, rng.pick(BROWN), 0.15), rng() < 0.5 ? 'oval' : 'heart');
    for (let i = 0; i < 12; i++) { ctx.strokeStyle = css([0.2, 0.15, 0.1]); ctx.lineWidth = rng.range(1.2, 3); const x = S * rng.range(0.15, 0.85), y = S * rng.range(0.15, 0.85), a = rng.range(0, TAU), L = S * rng.range(0.05, 0.16); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * L, y + Math.sin(a) * L); ctx.stroke(); }
  },
  // Lantana: a dense thorny shrub that swallows waste ground across north India.
  bush(ctx, rng, S) {
    for (let layer = 0; layer < 3; layer++) for (let i = 0; i < 150; i++) {
      const a = rng.range(Math.PI, TAU), r = Math.pow(rng(), 0.45), x = S / 2 + Math.cos(a) * r * S * 0.45, y = S - 12 + Math.sin(a) * r * S * 0.8;
      leaf(ctx, x, y, rng.range(0, TAU), S * rng.range(0.05, 0.085), S * rng.range(0.024, 0.038), mul(jitter(rng, rng.pick(DEEP), 0.16), 0.5 + 0.25 * layer), 'round', layer === 2);
    }
    for (let i = 0; i < 30; i++) { const a = rng.range(Math.PI, TAU), r = Math.pow(rng(), 0.45), x = S / 2 + Math.cos(a) * r * S * 0.42, y = S - 12 + Math.sin(a) * r * S * 0.76;
      for (let k = 0; k < 7; k++) { ctx.fillStyle = css(rng() < 0.5 ? [0.93, 0.5, 0.15] : [0.9, 0.3, 0.45]); ctx.beginPath(); ctx.arc(x + rng.range(-6, 6), y + rng.range(-6, 6), 2.6, 0, TAU); ctx.fill(); } }
  },
  // Bulrush for the pool margins.
  reed(ctx, rng, S) {
    for (let i = 0; i < 60; i++) { const x = S * rng.range(0.14, 0.86), h = S * rng.range(0.5, 0.95); blade(ctx, x, S - 4, h, rng.range(-0.12, 0.12) * S, S * rng.range(0.012, 0.022), mul(jitter(rng, [0.2, 0.32, 0.12], 0.15), 0.55 + 0.45 * i / 60), [0.42, 0.48, 0.2]); }
    for (let i = 0; i < 9; i++) { const x = S * rng.range(0.22, 0.78), h = S * rng.range(0.66, 0.9);
      ctx.strokeStyle = css([0.3, 0.34, 0.14]); ctx.lineWidth = 2.4; ctx.beginPath(); ctx.moveTo(x, S - 4); ctx.lineTo(x, S - h); ctx.stroke();
      ctx.fillStyle = css(jitter(rng, [0.27, 0.16, 0.08], 0.1)); ctx.beginPath(); ctx.roundRect(x - 5, S - h + 10, 10, S * 0.11, 5); ctx.fill(); }
  },
};

function creeperTile(ctx, rng, S, stems, sparse) {
  for (let layer = 0; layer < 2; layer++) {
    for (let i = 0; i < stems; i++) {
      let x = S * rng.range(0.06, 0.94), y = S * rng.range(0.55, 1.0), a = -Math.PI / 2 + rng.range(-0.5, 0.5);
      const steps = rng.int(14, 34);
      ctx.strokeStyle = css([0.15, 0.13, 0.07]); ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(x, y);
      const pts = [];
      for (let k = 0; k < steps; k++) { a += rng.range(-0.35, 0.35); a = lerp(a, -Math.PI / 2, 0.08); x += Math.cos(a) * 11; y += Math.sin(a) * 11; if (x < 10 || x > S - 10 || y < 10) break; ctx.lineTo(x, y); pts.push([x, y, a]); }
      ctx.stroke();
      for (const p of pts) {
        if (rng() < sparse) continue;
        const col = mul(jitter(rng, rng.pick(layer ? GREENS : DEEP), 0.16), layer ? 1 : 0.62);
        leaf(ctx, p[0], p[1], p[2] + rng.sign() * rng.range(0.6, 1.4), S * rng.range(0.045, 0.075), S * rng.range(0.028, 0.042), col, 'heart', layer === 1);
      }
    }
  }
}

// Paint all sixteen tiles and return a mip-mapped texture. Fully transparent texels are given the
// tile's average colour so that filtering does not drag black into the leaf edges.
export function buildFoliageAtlas(maxAniso = 4) {
  const N = TILE * GRID;
  const data = new Uint8Array(N * N * 4);
  const cv = document.createElement('canvas'); cv.width = cv.height = TILE;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const debug = typeof window !== 'undefined' && window.__keepAtlas ? document.createElement('canvas') : null;
  if (debug) { debug.width = debug.height = N; }
  for (const [name, [col, row]] of Object.entries(TILES)) {
    ctx.clearRect(0, 0, TILE, TILE);
    ctx.save(); ctx.beginPath(); ctx.rect(5, 5, TILE - 10, TILE - 10); ctx.clip();
    PAINTERS[name](ctx, makeRng(1000 + col * 17 + row * 131), TILE);
    ctx.restore();
    if (debug) debug.getContext('2d').drawImage(cv, col * TILE, row * TILE);
    const px = ctx.getImageData(0, 0, TILE, TILE).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 200) { r += px[i]; g += px[i + 1]; b += px[i + 2]; n++; }
    if (n) { r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n); }
    for (let y = 0; y < TILE; y++) {
      const dstRow = N - 1 - (row * TILE + y);                 // flip: canvas rows run top-down, texture rows bottom-up
      for (let x = 0; x < TILE; x++) {
        const s = (y * TILE + x) * 4, d = (dstRow * N + col * TILE + x) * 4, a = px[s + 3];
        if (a < 10) { data[d] = r; data[d + 1] = g; data[d + 2] = b; data[d + 3] = 0; }
        else { data[d] = px[s]; data[d + 1] = px[s + 1]; data[d + 2] = px[s + 2]; data[d + 3] = a; }
      }
    }
  }
  if (debug) window.__atlasCanvas = debug;
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.mipmaps = buildMips(data, N);
  tex.generateMipmaps = false; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = maxAniso; tex.needsUpdate = true;
  return tex;
}

// Mip levels made by hand, for two reasons. Colour is averaged weighted by alpha, so leaf edges do not
// darken. And each tile's alpha is rescaled at every level so the same fraction of it passes the cutout
// test as at full size: without that, sparse cards (grass, vines) thin away with distance while dense
// ones (leaf clusters) fill in to solid squares. The chain stops while a tile is still 4 texels wide,
// so neighbouring tiles never blend.
export const ALPHA_CUT = 0.4;
function buildMips(base, N) {
  const thr = Math.round(ALPHA_CUT * 255), T0 = N / GRID;
  const coverage = (d, w, ts, bx, by) => { let n = 0; for (let y = 0; y < ts; y++) { let o = ((by * ts + y) * w + bx * ts) * 4 + 3; for (let x = 0; x < ts; x++, o += 4) if (d[o] >= thr) n++; } return n / (ts * ts); };
  const want = [];
  for (let by = 0; by < GRID; by++) for (let bx = 0; bx < GRID; bx++) want.push(coverage(base, N, T0, bx, by));
  const mips = [{ data: base, width: N, height: N }];
  let prev = base, pw = N;
  const hist = new Uint32Array(256);
  for (let L = 1; (T0 >> L) >= 4; L++) {
    const w = pw >> 1, d = new Uint8Array(w * w * 4);
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
      const i0 = ((y * 2) * pw + x * 2) * 4, i1 = i0 + 4, i2 = i0 + pw * 4, i3 = i2 + 4;
      const a0 = prev[i0 + 3], a1 = prev[i1 + 3], a2 = prev[i2 + 3], a3 = prev[i3 + 3], sa = a0 + a1 + a2 + a3, o = (y * w + x) * 4;
      if (sa > 0) for (let k = 0; k < 3; k++) d[o + k] = (prev[i0 + k] * a0 + prev[i1 + k] * a1 + prev[i2 + k] * a2 + prev[i3 + k] * a3) / sa;
      else for (let k = 0; k < 3; k++) d[o + k] = (prev[i0 + k] + prev[i1 + k] + prev[i2 + k] + prev[i3 + k]) >> 2;
      d[o + 3] = sa >> 2;
    }
    const ts = T0 >> L;
    for (let by = 0; by < GRID; by++) for (let bx = 0; bx < GRID; bx++) {
      hist.fill(0);
      for (let y = 0; y < ts; y++) { let o = ((by * ts + y) * w + bx * ts) * 4 + 3; for (let x = 0; x < ts; x++, o += 4) hist[d[o]]++; }
      // the alpha value above which exactly the wanted fraction of this tile lies
      const target = want[by * GRID + bx] * ts * ts; let acc = 0, v = 255;
      for (; v > 0; v--) { acc += hist[v]; if (acc >= target) break; }
      const k = Math.min(6, Math.max(0.25, thr / Math.max(v, 1)));
      for (let y = 0; y < ts; y++) { let o = ((by * ts + y) * w + bx * ts) * 4 + 3; for (let x = 0; x < ts; x++, o += 4) d[o] = Math.min(255, Math.round(d[o] * k)); }
    }
    mips.push({ data: d, width: w, height: w });
    prev = d; pw = w;
  }
  return mips;
}
