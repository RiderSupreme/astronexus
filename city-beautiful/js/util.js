// Small shared helpers: math, seeded randomness, value noise, frame pacing.

export const PI = Math.PI;
export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const saturate = x => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, x) => (x - a) / (b - a);
export const remap = (x, a, b, c, d) => c + (d - c) * saturate((x - a) / (b - a));
export const smoothstep = (a, b, x) => { const t = saturate((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const smootherstep = (a, b, x) => { const t = saturate((x - a) / (b - a)); return t * t * t * (t * (t * 6 - 15) + 10); };
export const sign = x => (x < 0 ? -1 : 1);
export const fract = x => x - Math.floor(x);
export const mod = (x, n) => ((x % n) + n) % n;

// Frame-rate independent exponential approach: after 1/rate seconds ~63% of the gap is closed.
export const damp = (current, target, rate, dt) => current + (target - current) * (1 - Math.exp(-rate * dt));

export const wrapAngle = a => { a = (a + PI) % TAU; if (a < 0) a += TAU; return a - PI; };
export const angleDelta = (from, to) => wrapAngle(to - from);
export const dampAngle = (current, target, rate, dt) => current + angleDelta(current, target) * (1 - Math.exp(-rate * dt));

// Critically damped spring, integrated semi-implicitly. state = {x, v}.
export function spring(state, target, stiffness, damping, dt) {
  const a = (target - state.x) * stiffness - state.v * damping;
  state.v += a * dt;
  state.x += state.v * dt;
  return state.x;
}

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32). Everything procedural in the world draws from one of
// these so the Capitol is identical on every visit.
export function makeRng(seed) {
  let s = seed >>> 0;
  const rng = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.range = (a, b) => a + (b - a) * rng();
  rng.int = (a, b) => Math.floor(a + (b - a + 1) * rng());
  rng.pick = arr => arr[Math.floor(rng() * arr.length)];
  rng.chance = p => rng() < p;
  rng.sign = () => (rng() < 0.5 ? -1 : 1);
  rng.gauss = () => {
    // Box-Muller; good enough for scatter.
    const u = Math.max(1e-9, rng()), v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
  };
  rng.fork = () => makeRng(Math.floor(rng() * 4294967296));
  return rng;
}

export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Value noise (hash-based, no tables). Used for placement masks and terrain,
// never per-pixel at runtime.
function hash2i(x, y) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function hash3i(x, y, z) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export const hash2 = (x, y) => hash2i(Math.floor(x), Math.floor(y));

export function noise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2i(xi, yi), b = hash2i(xi + 1, yi), c = hash2i(xi, yi + 1), d = hash2i(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function noise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const n = (i, j, k) => hash3i(xi + i, yi + j, zi + k);
  const x00 = lerp(n(0, 0, 0), n(1, 0, 0), u), x10 = lerp(n(0, 1, 0), n(1, 1, 0), u);
  const x01 = lerp(n(0, 0, 1), n(1, 0, 1), u), x11 = lerp(n(0, 1, 1), n(1, 1, 1), u);
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
}

export function fbm2(x, y, octaves = 4, lacunarity = 2, gain = 0.5) {
  let amp = 0.5, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(x, y);
    norm += amp;
    x = x * lacunarity + 17.13; y = y * lacunarity + 9.71;
    amp *= gain;
  }
  return sum / norm;
}

// ---------------------------------------------------------------------------
export const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Cooperative time-slicing for the loader: call `await slicer.tick()` inside a
// long loop and it yields to the browser whenever the frame budget is spent.
export function makeSlicer(budgetMs = 12) {
  let t0 = performance.now();
  return {
    async tick() {
      if (performance.now() - t0 > budgetMs) { await nextFrame(); t0 = performance.now(); }
    },
  };
}

// Tiny fixed-size pool. `make` builds an item, `reset` prepares it for reuse.
export class Pool {
  constructor(make, size = 0) {
    this.make = make; this.free = [];
    for (let i = 0; i < size; i++) this.free.push(make());
  }
  get() { return this.free.length ? this.free.pop() : this.make(); }
  put(item) { this.free.push(item); }
}

export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// localStorage that never throws (private windows, blocked storage, previews).
export const store = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable: carry on without it */ }
  },
};
