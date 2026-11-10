// The sky: a single-scattering atmosphere, the Sun and Moon where the almanac
// puts them, a real star field with the Milky Way, drifting cloud, and the
// light all of that throws on the world.
//
// The atmosphere is integrated into a small lookup texture (azimuth x
// elevation) whenever the Sun or Moon has moved; the dome, the fog and the
// image-based ambient light all read from it, so they always agree.
import { THREE } from './lib/three.js';
import { Astro, STARS, GALACTIC } from './astro.js';
import { GU, FOG_GLSL, SKY_LUT_GLSL } from './shared.js';
import { DEG, TAU, clamp, lerp, smoothstep, makeRng } from './util.js';

// ---- atmosphere constants (metres, per metre) ------------------------------
const RP = 6371e3, RA = 6471e3, HR = 8000, HM = 1200, ALT0 = 350;
const BR = [5.802e-6, 13.558e-6, 33.1e-6];     // Rayleigh scattering
const BO = [0.65e-6, 1.881e-6, 0.085e-6];      // ozone absorption
const VSTEPS = 20, LSTEPS = 6;

export const SUN_E0 = 20;         // solar irradiance above the atmosphere, in scene units
export const MOON_E0 = 0.5;       // full-moon irradiance; far brighter than life so nights stay playable
const NIGHT_FLOOR = [0.0085, 0.0112, 0.019];   // starlight and airglow, likewise lifted
// Exposure by solar altitude (degrees): the eye opening up through dusk.
const EXPOSURE_KEYS = [[-14, 2.7], [-9, 2.0], [-5, 1.3], [-2, 0.85], [0, 0.62], [4, 0.5], [10, 0.42], [25, 0.34]];
function exposureAt(altDeg) {
  const K = EXPOSURE_KEYS;
  if (altDeg <= K[0][0]) return K[0][1];
  for (let i = 1; i < K.length; i++) if (altDeg <= K[i][0]) {
    const t = (altDeg - K[i - 1][0]) / (K[i][0] - K[i - 1][0]);
    return Math.exp(lerp(Math.log(K[i - 1][1]), Math.log(K[i][1]), t * t * (3 - 2 * t)));
  }
  return K[K.length - 1][1];
}

const ATMOS_GLSL = /* glsl */`
const float RP = ${RP.toFixed(1)}; const float RA = ${RA.toFixed(1)};
const vec3 BR = vec3(${BR.join(', ')}); const vec3 BO = vec3(${BO.join(', ')});
uniform float uMieB; uniform float uMieG;
vec2 rsi(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd); float c = dot(ro, ro) - r * r; float h = b * b - c;
  if (h < 0.0) return vec2(1e12, -1e12);
  h = sqrt(h); return vec2(-b - h, -b + h);
}
vec3 dens(float h) { h = max(h, 0.0); return vec3(exp(-h / ${HR.toFixed(1)}), exp(-h / ${HM.toFixed(1)}), max(0.0, 1.0 - abs(h - 25000.0) / 15000.0)); }
vec3 odToSpace(vec3 p, vec3 d) {
  float dt = rsi(p, d, RA).y / ${LSTEPS}.0; vec3 od = vec3(0.0);
  for (int j = 0; j < ${LSTEPS}; j++) { vec3 q = p + d * (dt * (float(j) + 0.5)); od += dens(length(q) - RP) * dt; }
  return od;
}
vec3 scatter(vec3 rd, vec3 ld) {
  vec3 ro = vec3(0.0, RP + ${ALT0.toFixed(1)}, 0.0);
  float tMax = rsi(ro, rd, RA).y;
  float mu = dot(rd, ld);
  float pR = 0.0596831 * (1.0 + mu * mu);
  float gg = uMieG * uMieG;
  float pM = 0.1193662 * ((1.0 - gg) * (1.0 + mu * mu)) / ((2.0 + gg) * pow(1.0 + gg - 2.0 * uMieG * mu, 1.5));
  vec3 od = vec3(0.0), sR = vec3(0.0), sM = vec3(0.0);
  float tPrev = 0.0;
  for (int i = 0; i < ${VSTEPS}; i++) {
    float f = (float(i) + 1.0) / ${VSTEPS}.0;
    float t = tMax * f * f; float dt = t - tPrev; vec3 p = ro + rd * (tPrev + 0.5 * dt); tPrev = t;
    vec3 dn = dens(length(p) - RP) * dt;
    od += dn;
    float b = dot(p, ld);
    float lit = b >= 0.0 ? 1.0 : smoothstep(RP - 1500.0, RP + 2500.0, sqrt(max(dot(p, p) - b * b, 0.0)));   // the planet's own shadow
    if (lit > 0.0) {
      vec3 o = od + odToSpace(p, ld);
      vec3 T = exp(-(BR * o.x + vec3(uMieB * 1.11) * o.y + BO * o.z)) * lit;
      sR += dn.x * T; sM += dn.y * T;
    }
  }
  // single scattering, plus a flat lift standing in for the light that scatters more than once
  return (pR * BR * sR + pM * uMieB * sM) + (BR * sR + uMieB * sM) * 0.05;
}
`;

// ---- the same integral on the CPU, for the handful of colours gameplay needs
function rsiFar(px, py, pz, dx, dy, dz, r) {
  const b = px * dx + py * dy + pz * dz, c = px * px + py * py + pz * pz - r * r, h = b * b - c;
  return h < 0 ? -1 : -b + Math.sqrt(h);
}
function densAt(h, out) {
  if (h < 0) h = 0;
  out[0] = Math.exp(-h / HR); out[1] = Math.exp(-h / HM); out[2] = Math.max(0, 1 - Math.abs(h - 25000) / 15000);
}
const _d = [0, 0, 0], _od = [0, 0, 0], _o2 = [0, 0, 0];
function odToSpace(px, py, pz, dx, dy, dz, steps, out) {
  const dt = rsiFar(px, py, pz, dx, dy, dz, RA) / steps;
  out[0] = out[1] = out[2] = 0;
  for (let j = 0; j < steps; j++) {
    const s = dt * (j + 0.5), qx = px + dx * s, qy = py + dy * s, qz = pz + dz * s;
    densAt(Math.hypot(qx, qy, qz) - RP, _d);
    out[0] += _d[0] * dt; out[1] += _d[1] * dt; out[2] += _d[2] * dt;
  }
}
// Fraction of light from direction `dir` that survives the atmosphere, seen from `alt` metres up.
export function transmittance(dir, mieB, out, alt = ALT0) {
  const py = RP + alt;
  const b = py * dir.y, perp2 = py * py - b * b;
  if (b < 0 && perp2 < RP * RP) { out[0] = out[1] = out[2] = 0; return out; }   // behind the planet
  odToSpace(0, py, 0, dir.x, dir.y, dir.z, 24, _od);
  for (let k = 0; k < 3; k++) out[k] = Math.exp(-(BR[k] * _od[0] + mieB * 1.11 * _od[1] + BO[k] * _od[2]));
  return out;
}
export function scatterCPU(rd, ld, mieB, g, out) {
  const py = RP + ALT0;
  const tMax = rsiFar(0, py, 0, rd.x, rd.y, rd.z, RA);
  const mu = rd.x * ld.x + rd.y * ld.y + rd.z * ld.z;
  const pR = 0.0596831 * (1 + mu * mu), gg = g * g;
  const pM = 0.1193662 * ((1 - gg) * (1 + mu * mu)) / ((2 + gg) * Math.pow(1 + gg - 2 * g * mu, 1.5));
  let o0 = 0, o1 = 0, o2 = 0, tPrev = 0;
  const sR = [0, 0, 0], sM = [0, 0, 0];
  for (let i = 0; i < VSTEPS; i++) {
    const f = (i + 1) / VSTEPS, t = tMax * f * f, dt = t - tPrev, s = tPrev + 0.5 * dt; tPrev = t;
    const px = rd.x * s, pyy = py + rd.y * s, pz = rd.z * s;
    densAt(Math.hypot(px, pyy, pz) - RP, _d);
    const d0 = _d[0] * dt, d1 = _d[1] * dt, d2 = _d[2] * dt;
    o0 += d0; o1 += d1; o2 += d2;
    const b = px * ld.x + pyy * ld.y + pz * ld.z;
    const lit = b >= 0 ? 1 : smoothstep(RP - 1500, RP + 2500, Math.sqrt(Math.max(px * px + pyy * pyy + pz * pz - b * b, 0)));
    if (lit > 0) {
      odToSpace(px, pyy, pz, ld.x, ld.y, ld.z, LSTEPS, _o2);
      for (let k = 0; k < 3; k++) {
        const T = Math.exp(-(BR[k] * (o0 + _o2[0]) + mieB * 1.11 * (o1 + _o2[1]) + BO[k] * (o2 + _o2[2]))) * lit;
        sR[k] += d0 * T; sM[k] += d1 * T;
      }
    }
  }
  for (let k = 0; k < 3; k++) out[k] = pR * BR[k] * sR[k] + pM * mieB * sM[k] + (BR[k] * sR[k] + mieB * sM[k]) * 0.05;
  return out;
}

// ---------------------------------------------------------------------------
const FS_VERT = /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const LUT_FRAG = /* glsl */`
varying vec2 vUv;
uniform vec3 uSunDir; uniform vec3 uMoonDir; uniform float uSunE; uniform float uMoonE; uniform vec3 uNightFloor;
${ATMOS_GLSL}
void main() {
  float az = (vUv.x - 0.5) * 6.2831853; float el = vUv.y * vUv.y * 1.5707963;
  vec3 rd = vec3(cos(el) * sin(az), sin(el), -cos(el) * cos(az));
  vec3 L = uNightFloor * (1.0 + 0.9 * pow(1.0 - rd.y, 3.0));
  if (uSunE > 0.0) L += uSunE * scatter(rd, uSunDir);
  if (uMoonE > 0.0) L += uMoonE * scatter(rd, uMoonDir);
  gl_FragColor = vec4(L, 1.0);
}`;

const CLOUD_GLSL = /* glsl */`
uniform sampler2D tNoise; uniform vec4 uCloud;   // coverage, opacity, drift x, drift z
float cloudDensity(vec3 dir) {
  if (dir.y < 0.012 || uCloud.x <= 0.001) return 0.0;
  vec2 p = dir.xz / (dir.y + 0.16);
  vec2 uv = p * 0.075 + uCloud.zw;
  float n = textureLod(tNoise, uv, 0.0).r * 0.60 + textureLod(tNoise, uv * 2.63 + vec2(0.31, 0.17) + uCloud.zw * 0.6, 0.0).g * 0.28 + textureLod(tNoise, uv * 6.7 + uCloud.zw * 1.3, 0.0).g * 0.12;
  float d = smoothstep(1.0 - uCloud.x, 1.0 - uCloud.x + 0.3, n);
  return d * smoothstep(0.012, 0.16, dir.y);
}
`;

const DOME_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const DOME_FRAG = /* glsl */`
varying vec3 vDir;
uniform vec3 uSunDir; uniform vec3 uSunDisc; uniform vec3 uMoonDir; uniform vec3 uMoonUp; uniform vec3 uMoonLight;
uniform float uMoonRadius; uniform float uEarthshine;
uniform mat3 uGal; uniform float uStarFade; uniform float uMilky;
uniform vec3 uCloudLight; uniform vec3 uCloudAmbient; uniform vec3 uCloudDir; uniform float uTime;
${FOG_GLSL}
${CLOUD_GLSL}

vec3 milkyWay(vec3 d) {
  vec3 g = uGal * d;
  float b = asin(clamp(g.z, -1.0, 1.0)); float l = atan(g.y, g.x);
  float cb = max(sqrt(1.0 - g.z * g.z), 1e-3);
  float core = 0.5 + 0.5 * g.x / cb;                 // 1 toward the galactic centre, 0 away from it
  core *= core;
  vec2 uv = vec2(l, b) * 0.15915494;                 // same scale both ways, and whole turns in longitude so it wraps
  float w1 = textureLod(tNoise, uv * 3.0, 1.0).r, w2 = textureLod(tNoise, uv * 7.0 + 0.4, 0.0).g;
  // the band wanders about the plane and swells and thins along its length
  float bb = b + (w1 - 0.5) * 0.11;
  float w = mix(0.085, 0.17, core) * (0.75 + 0.6 * w2);
  float band = exp(-bb * bb / (2.0 * w * w));
  float wide = exp(-bb * bb / (2.0 * 0.3 * 0.3)) * 0.2;
  float bulge = exp(-(l * l * 0.5 + b * b * 2.0) / 0.045) * 0.9;
  float m1 = textureLod(tNoise, uv * 11.0, 0.0).g, m2 = textureLod(tNoise, uv * 29.0 + 0.37, 0.0).g, m3 = textureLod(tNoise, uv * 71.0 + 0.2, 0.0).r;
  float mott = 1.0 + 0.55 * (m1 - 0.5) + 0.4 * (m2 - 0.5) + 0.25 * (m3 - 0.5);
  // the Great Rift: dust lying along the plane from Cygnus down to the centre, in ragged clouds
  float dn = textureLod(tNoise, uv * 9.0 + 0.11, 0.0).r, dn2 = textureLod(tNoise, uv * 23.0 + 0.53, 0.0).g, dn3 = textureLod(tNoise, uv * 5.0 + 0.71, 0.0).g;
  float rift = exp(-pow((b - 0.02 - 0.16 * (dn3 - 0.5)) / (0.03 + 0.07 * dn), 2.0));
  float along = smoothstep(-0.8, 0.0, l) * smoothstep(1.9, 0.9, l);
  float clouds = smoothstep(0.42, 0.75, dn * 0.55 + dn2 * 0.45);
  float dust = clamp(rift * along * (0.25 + 0.75 * clouds) + clouds * 0.35 * band, 0.0, 0.72);
  float I = (band * (0.3 + 0.95 * core) + wide * (0.4 + core) + bulge) * mott * (1.0 - dust);
  vec3 tint = mix(vec3(0.68, 0.78, 1.0), vec3(1.0, 0.87, 0.7), clamp(core * 0.7 + bulge * 0.5, 0.0, 1.0));
  return tint * I;
}

float mare(vec2 m, vec2 c, vec2 r) { vec2 q = (m - c) / r; return smoothstep(1.15, 0.55, dot(q, q)); }
vec3 moonSurface(vec2 m, vec3 n) {
  // maria placed where they are on the near side (north up, Crisium on the right)
  float dark = 0.0;
  dark = max(dark, mare(m, vec2(0.74, 0.30), vec2(0.11, 0.12)));     // Crisium
  dark = max(dark, mare(m, vec2(0.67, -0.07), vec2(0.13, 0.17)));    // Fecunditatis
  dark = max(dark, mare(m, vec2(0.47, -0.28), vec2(0.09, 0.09)));    // Nectaris
  dark = max(dark, mare(m, vec2(0.42, 0.13), vec2(0.21, 0.17)));     // Tranquillitatis
  dark = max(dark, mare(m, vec2(0.27, 0.45), vec2(0.17, 0.16)));     // Serenitatis
  dark = max(dark, mare(m, vec2(-0.24, 0.55), vec2(0.28, 0.25)));    // Imbrium
  dark = max(dark, mare(m, vec2(-0.02, 0.83), vec2(0.42, 0.06)));    // Frigoris
  dark = max(dark, mare(m, vec2(-0.60, 0.20), vec2(0.30, 0.36)));    // Procellarum
  dark = max(dark, mare(m, vec2(-0.36, 0.02), vec2(0.17, 0.14)));    // Insularum
  dark = max(dark, mare(m, vec2(-0.20, -0.36), vec2(0.18, 0.16)));   // Nubium
  dark = max(dark, mare(m, vec2(-0.57, -0.40), vec2(0.10, 0.10)));   // Humorum
  float tex = texture2D(tNoise, m * 0.9 + 0.2).g;
  float alb = mix(1.0, 0.52, dark * (0.75 + 0.5 * tex)) * (0.86 + 0.28 * tex);
  alb += 0.35 * smoothstep(0.07, 0.0, length(m - vec2(-0.10, -0.68)));     // Tycho
  alb += 0.25 * smoothstep(0.05, 0.0, length(m - vec2(-0.33, 0.17)));      // Copernicus
  return vec3(alb, alb * 0.985, alb * 0.95);
}

void main() {
  vec3 dir = normalize(vDir);
  vec3 up = normalize(vec3(dir.x, max(dir.y, 0.0), dir.z));
  vec3 col = skyLut(up);

  // airmass dims and reddens whatever lies beyond the atmosphere
  float am = 1.0 / (max(dir.y, 0.0) + 0.025 * exp(-11.0 * max(dir.y, 0.0)));
  vec3 ext = exp(-vec3(0.10, 0.14, 0.22) * (am - 1.0));
  float aboveHorizon = smoothstep(-0.004, 0.02, dir.y);

  if (uStarFade > 0.001) col += milkyWay(dir) * uMilky * uStarFade * ext * aboveHorizon;

  // Moon: a lit sphere, so the phase and the tilt of the terminator come out of the geometry
  float md = dot(dir, uMoonDir);
  float sr = sin(uMoonRadius);
  if (md > cos(uMoonRadius * 1.6)) {
    vec3 mx = normalize(cross(uMoonUp, uMoonDir)); vec3 my = cross(uMoonDir, mx);
    vec2 q = vec2(dot(dir, mx), dot(dir, my)) / sr;
    float r2 = dot(q, q);
    float edge = smoothstep(1.0, 0.94, r2);
    if (r2 < 1.0) {
      vec3 n = q.x * mx + q.y * my - sqrt(1.0 - r2) * uMoonDir;
      float lit = smoothstep(-0.02, 0.12, dot(n, uSunDir));
      lit *= pow(max(dot(n, uSunDir), 0.0), 0.45);
      vec3 alb = moonSurface(vec2(-q.x, q.y), n);
      vec3 moon = alb * (uMoonLight * lit + vec3(0.7, 0.8, 1.0) * uEarthshine);
      col += moon * ext * edge * aboveHorizon;      // the air in front of the Moon still glows, so its light adds to the sky
    }
  }

  // Sun: limb-darkened disc on top of the scattered glow
  float sd = dot(dir, uSunDir);
  float sunR = 0.00465 * 1.05;
  float ang = acos(clamp(sd, -1.0, 1.0));
  float disc = smoothstep(sunR, sunR * 0.82, ang);
  float limb = pow(max(1.0 - (ang * ang) / (sunR * sunR), 0.0), 0.28);
  col += uSunDisc * disc * (0.35 + 0.65 * limb) * aboveHorizon;
  col += uSunDisc * 0.0016 * pow(max(sd, 0.0), 900.0) * aboveHorizon;

  // cloud
  float cd = cloudDensity(dir);
  if (cd > 0.002) {
    float cd2 = cloudDensity(normalize(dir + uCloudDir * 0.07));
    float lit = clamp((cd - cd2) * 2.4 + 0.55, 0.12, 1.25);
    float silver = pow(max(dot(dir, uCloudDir), 0.0), 10.0) * (1.0 - cd) * 2.2;
    vec3 cc = uCloudAmbient * (0.5 + 0.5 * (1.0 - cd)) + uCloudLight * (lit + silver);
    col = mix(col, cc, cd * uCloud.y);
  }

  // haze at the horizon, the same fog the world uses, taken to infinity
  vec3 hz = skyLut(normalize(vec3(dir.x, 0.035, dir.z)));
  float f = dir.y > 0.0 ? fogAmount(cameraPosition, up, 60000.0) : 1.0;
  col = mix(col, hz, f);
  gl_FragColor = vec4(col, 1.0);
}`;

const STAR_VERT = /* glsl */`
attribute vec4 aStar;       // rgb colour, w = magnitude
attribute float aSeed;
uniform mat3 uStarMat; uniform float uTime; uniform float uStarFade; uniform float uPx;
varying vec4 vCol;
${CLOUD_GLSL}
void main() {
  vec3 dir = uStarMat * position;
  vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(dir, 1.0);
  gl_Position = p.xyww;
  float mag = aStar.w;
  float flux = pow(10.0, -0.4 * mag);
  float am = 1.0 / (max(dir.y, 0.0) + 0.025 * exp(-11.0 * max(dir.y, 0.0)));
  vec3 ext = exp(-vec3(0.12, 0.17, 0.26) * (am - 1.0));
  // scintillation: stronger near the horizon, and for bright stars
  float tw = sin(uTime * (5.0 + aSeed * 9.0) + aSeed * 51.0) * sin(uTime * (3.1 + aSeed * 4.0) + aSeed * 17.0);
  float scint = 1.0 + tw * clamp(0.12 + 0.05 * am, 0.0, 0.6);
  float vis = uStarFade * smoothstep(-0.002, 0.03, dir.y) * (1.0 - cloudDensity(dir) * uCloud.y);
  float I = pow(flux, 0.62) * scint * vis;
  float size = clamp(1.7 + (3.4 - mag) * 0.7, 1.5, 6.0) * uPx;
  gl_PointSize = size;
  vCol = vec4(aStar.rgb * ext * I * (1.9 / max(size / uPx, 1.0)) * 3.0, 1.0);
}`;
const STAR_FRAG = /* glsl */`
varying vec4 vCol;
void main() {
  vec2 c = gl_PointCoord - 0.5; float r2 = dot(c, c);
  float a = exp(-r2 * 16.0) - 0.018;
  if (a <= 0.0) discard;
  gl_FragColor = vec4(vCol.rgb * a, 1.0);
}`;

const ENV_VERT = /* glsl */`varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const ENV_FRAG = /* glsl */`
varying vec3 vDir; uniform vec3 uGround; uniform float uDim;
${SKY_LUT_GLSL}
void main() {
  vec3 d = normalize(vDir);
  vec3 sky = min(skyLut(normalize(vec3(d.x, max(d.y, 0.0), d.z))), vec3(40.0)) * uDim;
  gl_FragColor = vec4(mix(uGround, sky, smoothstep(-0.06, 0.03, d.y)), 1.0);
}`;

function bvToRGB(bv, out) {
  // blue-white through white and yellow to orange, a touch more saturated than the eye sees
  const t = clamp((bv + 0.4) / 2.3, 0, 1);
  const stops = [[0.55, 0.68, 1.0], [0.8, 0.88, 1.0], [1.0, 0.97, 0.9], [1.0, 0.84, 0.62], [1.0, 0.66, 0.42]];
  const x = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  for (let k = 0; k < 3; k++) out[k] = lerp(stops[i][k], stops[i + 1][k], f);
  return out;
}

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _c = [0, 0, 0], _c2 = [0, 0, 0];

export class Sky {
  constructor(renderer, scene, noiseTex, { faintStars = 6500 } = {}) {
    this.renderer = renderer;
    this.astro = new Astro();
    this.jd = 2451545;
    this.haze = 0.35;                 // 0 crystal clear .. 1 thick monsoon haze
    this.cloudCover = 0.42;
    this.cloudOpacity = 0.92;
    this.cloudDrift = new THREE.Vector2(0.11, 0.37);
    this.windDir = new THREE.Vector2(0.8, 0.6).normalize();
    this.cloudSpeed = 0.0016;
    this.exposure = 0.16;
    this.night = 0;                   // 0 day .. 1 night
    this.starFade = 0;
    this.lightIsMoon = false;
    this.lightDir = new THREE.Vector3(0, 1, 0);
    this.lightE = new THREE.Color();           // irradiance of the dominant light
    this.sunE = new THREE.Color(); this.moonE = new THREE.Color();
    this.zenith = new THREE.Color(); this.horizon = new THREE.Color(); this.ambientLum = 0;
    this.shaftColor = new THREE.Color(1, 1, 1); this.shaftStrength = 0;
    this.flash = 0;                   // lightning, 0..1
    this.overcast = 0;                // 0 clear .. 1 storm: thickens cloud, dims the sun
    this._lutKey = null; this._envKey = null; this._envTimer = 0;

    // ---- lookup texture
    const type = renderer.capabilities.isWebGL2 ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this.lutRT = new THREE.WebGLRenderTarget(256, 64, { type, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping, generateMipmaps: false });
    GU.tSkyLUT.value = this.lutRT.texture;
    this.fsScene = new THREE.Scene(); this.fsCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    tri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.lutMat = new THREE.ShaderMaterial({
      vertexShader: FS_VERT, fragmentShader: LUT_FRAG, depthTest: false, depthWrite: false, toneMapped: false,
      uniforms: { uSunDir: { value: new THREE.Vector3() }, uMoonDir: { value: new THREE.Vector3() }, uSunE: { value: SUN_E0 }, uMoonE: { value: 0 },
        uNightFloor: { value: new THREE.Vector3(...NIGHT_FLOOR) }, uMieB: { value: 8e-6 }, uMieG: { value: 0.78 } },
    });
    const lutMesh = new THREE.Mesh(tri, this.lutMat); lutMesh.frustumCulled = false; this.fsScene.add(lutMesh);

    // ---- dome
    this.domeMat = new THREE.ShaderMaterial({
      vertexShader: DOME_VERT, fragmentShader: DOME_FRAG, side: THREE.BackSide, depthWrite: false, depthTest: true, toneMapped: false,
      uniforms: {
        tSkyLUT: GU.tSkyLUT, uFog: GU.uFog, tNoise: { value: noiseTex }, uTime: GU.uTime,
        uSunDir: { value: new THREE.Vector3() }, uSunDisc: { value: new THREE.Color() },
        uMoonDir: { value: new THREE.Vector3() }, uMoonUp: { value: new THREE.Vector3(0, 1, 0) }, uMoonLight: { value: new THREE.Color() },
        uMoonRadius: { value: 0.00452 * 1.5 }, uEarthshine: { value: 0 },
        uGal: { value: new THREE.Matrix3() }, uStarFade: { value: 0 }, uMilky: { value: 0.021 },
        uCloud: { value: new THREE.Vector4(0.4, 0.9, 0, 0) }, uCloudLight: { value: new THREE.Color() }, uCloudAmbient: { value: new THREE.Color() }, uCloudDir: { value: new THREE.Vector3(0, 1, 0) },
      },
    });
    this.dome = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 4), this.domeMat);
    this.dome.frustumCulled = false; this.dome.renderOrder = 1000; this.dome.matrixAutoUpdate = false;
    scene.add(this.dome);

    // ---- stars
    this.starMat = new THREE.ShaderMaterial({
      vertexShader: STAR_VERT, fragmentShader: STAR_FRAG, depthWrite: false, depthTest: true, transparent: true, blending: THREE.AdditiveBlending, toneMapped: false,
      uniforms: { uStarMat: { value: new THREE.Matrix3() }, uTime: GU.uTime, uStarFade: { value: 0 }, uPx: { value: 1 }, tNoise: { value: noiseTex }, uCloud: this.domeMat.uniforms.uCloud },
    });
    this.stars = new THREE.Points(this._buildStars(faintStars), this.starMat);
    this.stars.frustumCulled = false; this.stars.renderOrder = -1000; this.stars.matrixAutoUpdate = false;
    scene.add(this.stars);

    // ---- sunlight / moonlight
    this.light = new THREE.DirectionalLight(0xffffff, 1);
    this.light.castShadow = true;
    this.light.shadow.bias = -0.0004; this.light.shadow.normalBias = 0.06;
    scene.add(this.light, this.light.target);

    // Fill: at low sun the sky is far brighter than anything it lights. A hemisphere light keyed to the
    // sky's own colour lifts the ground the way local adaptation does for an eye.
    this.fill = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
    scene.add(this.fill);

    // ---- image-based ambient
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envScene = new THREE.Scene();
    this.envMat = new THREE.ShaderMaterial({ vertexShader: ENV_VERT, fragmentShader: ENV_FRAG, side: THREE.BackSide, depthTest: false, depthWrite: false, toneMapped: false,
      uniforms: { tSkyLUT: GU.tSkyLUT, uGround: { value: new THREE.Color() }, uDim: { value: 1 } } });
    this.envScene.add(new THREE.Mesh(new THREE.IcosahedronGeometry(5, 3), this.envMat));
    this.envRT = null;
    this.scene = scene;
  }

  _buildStars(nFaint) {
    const n = STARS.length + nFaint;
    const pos = new Float32Array(n * 3), star = new Float32Array(n * 4), seed = new Float32Array(n);
    const rng = makeRng(20870923), rgb = [0, 0, 0];
    let i = 0;
    for (const [ra, dec, mag, bv] of STARS) {
      const a = ra * 15 * DEG, d = dec * DEG;
      pos[i * 3] = Math.cos(d) * Math.cos(a); pos[i * 3 + 1] = Math.cos(d) * Math.sin(a); pos[i * 3 + 2] = Math.sin(d);
      bvToRGB(bv, rgb); star.set([rgb[0], rgb[1], rgb[2], mag], i * 4); seed[i] = rng(); i++;
    }
    // Field stars: counts rise about threefold per magnitude and crowd toward the galactic plane.
    const gInv = new THREE.Matrix4().copy(GALACTIC).transpose();
    while (i < n) {
      const z = rng.range(-1, 1), phi = rng.range(0, TAU), r = Math.sqrt(1 - z * z);
      const bDeg = Math.asin(z) / DEG;
      if (rng() > (0.22 + 0.78 * Math.exp(-(bDeg * bDeg) / (2 * 17 * 17)))) continue;
      _v1.set(r * Math.cos(phi), r * Math.sin(phi), z).applyMatrix4(gInv);
      pos[i * 3] = _v1.x; pos[i * 3 + 1] = _v1.y; pos[i * 3 + 2] = _v1.z;
      const mag = 3.7 + 3.0 * Math.pow(rng(), 0.42);
      bvToRGB(clamp(0.45 + rng.gauss() * 0.45, -0.3, 1.7), rgb);
      star.set([rgb[0], rgb[1], rgb[2], mag], i * 4); seed[i] = rng(); i++;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aStar', new THREE.BufferAttribute(star, 4));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    return g;
  }

  setTime(jd) { this.jd = jd; }

  // Recompute everything that depends on where the Sun and Moon are.
  update(dt, camera, pixelScale = 1) {
    const a = this.astro.update(this.jd);
    const mieB = lerp(1.5e-5, 1.5e-4, this.haze) * (1 + this.overcast * 1.5);
    const mieG = 0.8 - 0.06 * this.haze;
    const cover = clamp(this.cloudCover + this.overcast * 0.6, 0, 1);

    // --- direct light from each body
    const sunVis = smoothstep(-0.9 * DEG, 0.35 * DEG, a.sunAlt);
    transmittance(a.sunDir, mieB, _c);
    const sunDim = 1 - 0.8 * smoothstep(0.35, 1.0, cover);
    this.sunE.setRGB(SUN_E0 * _c[0] * sunVis * sunDim, SUN_E0 * _c[1] * sunVis * sunDim, SUN_E0 * _c[2] * sunVis * sunDim);
    // the Moon's light falls off much faster than its lit fraction: a crescent gives almost nothing
    const moonPower = Math.pow(a.moonPhase, 2.4) * smoothstep(-0.8 * DEG, 1.5 * DEG, a.moonAlt);
    transmittance(a.moonDir, mieB, _c2);
    this.moonE.setRGB(MOON_E0 * _c2[0] * moonPower * 0.82, MOON_E0 * _c2[1] * moonPower * 0.92, MOON_E0 * _c2[2] * moonPower * 1.08).multiplyScalar(sunDim);

    const sunLum = (this.sunE.r + this.sunE.g + this.sunE.b) * Math.max(a.sunDir.y, 0.02);
    const moonLum = (this.moonE.r + this.moonE.g + this.moonE.b) * Math.max(a.moonDir.y, 0.02);
    this.lightIsMoon = moonLum > sunLum;
    if (this.lightIsMoon) { this.lightDir.copy(a.moonDir); this.lightE.copy(this.moonE); }
    else { this.lightDir.copy(a.sunDir); this.lightE.copy(this.sunE); }
    if (this.lightDir.y < 0.02) { this.lightDir.y = 0.02; this.lightDir.normalize(); }
    this.light.color.copy(this.lightE); this.light.intensity = 1;
    GU.uLightDir.value.copy(this.lightDir); GU.uLightColor.value.copy(this.lightE);

    this.night = smoothstep(0.5 * DEG, -11 * DEG, a.sunAlt);
    GU.uNight.value = this.night;
    this.starFade = smoothstep(-3.5 * DEG, -12 * DEG, a.sunAlt) * (1 - 0.55 * moonPower);
    // Exposure follows the light, the way an eye or a camera would: wide open after dark.
    this.exposure = exposureAt(a.sunAlt / DEG) * (1 - 0.45 * moonPower * this.night);
    // After sunset the real sky fades by orders of magnitude within minutes. Hold the afterglow up so
    // that, with the exposure opening, dusk passes through a proper blue hour instead of dropping to black.
    const twilightBoost = Math.exp(0.6 * clamp(-a.sunAlt / DEG, 0, 7.5));

    // --- sky lookup, only when something moved
    const lutKey = `${(a.sunAlt / DEG).toFixed(2)}|${(a.sunAz / DEG).toFixed(1)}|${(a.moonAlt / DEG).toFixed(1)}|${(a.moonAz / DEG).toFixed(0)}|${mieB.toExponential(2)}|${moonPower.toFixed(2)}|${this.flash.toFixed(2)}`;
    if (lutKey !== this._lutKey) {
      this._lutKey = lutKey;
      const u = this.lutMat.uniforms;
      u.uSunDir.value.copy(a.sunDir); u.uMoonDir.value.copy(a.moonDir);
      u.uSunE.value = a.sunAlt > -19 * DEG ? SUN_E0 * sunDim * twilightBoost : 0;
      u.uMoonE.value = a.moonAlt > -6 * DEG ? MOON_E0 * Math.pow(a.moonPhase, 2.4) * sunDim : 0;
      u.uMieB.value = mieB; u.uMieG.value = mieG;
      const fl = this.flash * 0.25;
      u.uNightFloor.value.set(NIGHT_FLOOR[0] + fl, NIGHT_FLOOR[1] + fl, NIGHT_FLOOR[2] + fl * 1.2);
      const prev = this.renderer.getRenderTarget();
      this.renderer.setRenderTarget(this.lutRT);
      this.renderer.render(this.fsScene, this.fsCamera);
      this.renderer.setRenderTarget(prev);

      // a few CPU samples of the same sky for gameplay-side colours
      scatterCPU(_v1.set(0, 1, 0), a.sunDir, mieB, mieG, _c);
      this.zenith.setRGB(_c[0] * u.uSunE.value + NIGHT_FLOOR[0], _c[1] * u.uSunE.value + NIGHT_FLOOR[1], _c[2] * u.uSunE.value + NIGHT_FLOOR[2]);
      let hr = 0, hg = 0, hb = 0;
      for (let k = 0; k < 4; k++) {
        const az = a.sunAz + Math.PI / 4 + k * (Math.PI / 2);
        scatterCPU(_v1.set(Math.sin(az) * 0.94, 0.34, -Math.cos(az) * 0.94), a.sunDir, mieB, mieG, _c);
        hr += _c[0]; hg += _c[1]; hb += _c[2];
      }
      this.horizon.setRGB(hr * 0.25 * u.uSunE.value + NIGHT_FLOOR[0] * 1.4, hg * 0.25 * u.uSunE.value + NIGHT_FLOOR[1] * 1.4, hb * 0.25 * u.uSunE.value + NIGHT_FLOOR[2] * 1.4);
      this.ambientLum = (this.zenith.r + this.zenith.g + this.zenith.b + this.horizon.r + this.horizon.g + this.horizon.b) / 6;
    }

    // --- shafts of light through haze, strongest when the sun is low
    { const m = Math.max(this.lightE.r, this.lightE.g, this.lightE.b, 1e-4);
      this.shaftColor.copy(this.lightE).multiplyScalar(1 / m);
      this.shaftStrength = this.lightIsMoon ? 0 : 0.06 * sunVis * smoothstep(42 * DEG, 9 * DEG, a.sunAlt) * (0.5 + this.haze); }

    // --- fill light
    const fillK = (0.35 + 1.4 * smoothstep(16 * DEG, -3 * DEG, a.sunAlt) + 1.1 * this.night) * Math.PI;
    this.fill.color.copy(this.zenith).lerp(this.horizon, 0.5).multiplyScalar(fillK);
    this.fill.groundColor.copy(this.horizon).multiplyScalar(fillK * 0.3);
    this.fill.color.r += this.flash * 0.7; this.fill.color.g += this.flash * 0.75; this.fill.color.b += this.flash * 0.9;

    // --- dome and stars
    const du = this.domeMat.uniforms;
    du.uSunDir.value.copy(a.sunDir); du.uMoonDir.value.copy(a.moonDir);
    transmittance(a.sunDir, mieB, _c);
    const discK = 900 * smoothstep(-1.2 * DEG, -0.2 * DEG, a.sunAlt);
    du.uSunDisc.value.setRGB(_c[0] * discK, _c[1] * discK, _c[2] * discK);
    // "up" on the Moon's disc: toward the celestial pole
    _v2.copy(a.poleDir).addScaledVector(a.moonDir, -a.poleDir.dot(a.moonDir)).normalize();
    du.uMoonUp.value.copy(_v2);
    const mAlb = 0.42;
    du.uMoonLight.value.setRGB(mAlb, mAlb, mAlb);
    du.uEarthshine.value = 0.011 * (1 - a.moonPhase);
    _m4.copy(this.astro.starMatrix).transpose();
    _m4.premultiply(GALACTIC);
    du.uGal.value.setFromMatrix4(_m4);
    du.uStarFade.value = this.starFade;
    this.cloudDrift.addScaledVector(this.windDir, this.cloudSpeed * dt);
    du.uCloud.value.set(cover, this.cloudOpacity, this.cloudDrift.x, this.cloudDrift.y);
    // cloud is lit from three kilometres up, so it holds the sunset after the ground has lost it
    const cloudLightDir = (a.sunAlt > -6 * DEG || moonPower < 0.02) ? a.sunDir : a.moonDir;
    if (cloudLightDir === a.sunDir) {
      transmittance(a.sunDir, mieB * 0.35, _c, 3000);
      const k = SUN_E0 * 0.085 * (1 - 0.6 * this.overcast);
      du.uCloudLight.value.setRGB(_c[0] * k, _c[1] * k, _c[2] * k);
    } else {
      du.uCloudLight.value.copy(this.moonE).multiplyScalar(0.085);
    }
    du.uCloudDir.value.copy(cloudLightDir);
    du.uCloudAmbient.value.copy(this.zenith).multiplyScalar(0.75 * (1 - 0.45 * this.overcast)).addScalar(this.flash * 0.6);

    const su = this.starMat.uniforms;
    su.uStarMat.value.setFromMatrix4(this.astro.starMatrix);
    su.uStarFade.value = this.starFade;
    su.uPx.value = pixelScale;
    this.stars.visible = this.starFade > 0.002;

    // --- ambient environment, re-filtered when the sky has changed enough to see
    this._envTimer -= dt;
    const envKey = `${(a.sunAlt / DEG / 0.6).toFixed(0)}|${(a.sunAz / DEG / 4).toFixed(0)}|${(moonPower * 10).toFixed(0)}|${(a.moonAlt / DEG / 3).toFixed(0)}|${(this.haze * 10).toFixed(0)}|${(cover * 8).toFixed(0)}|${(this.flash * 4).toFixed(0)}`;
    if (envKey !== this._envKey && this._envTimer <= 0) {
      this._envKey = envKey; this._envTimer = 0.35;
      this._renderEnv(cover);
    }
  }

  _renderEnv(cover) {
    const a = this.astro;
    // light bounced off a mossy grey ground fills the lower half of the environment
    const skyIrr = (this.zenith.r + this.horizon.r) * 0.5, skyIrrG = (this.zenith.g + this.horizon.g) * 0.5, skyIrrB = (this.zenith.b + this.horizon.b) * 0.5;
    const sinA = Math.max(this.lightDir.y, 0) / Math.PI;
    this.envMat.uniforms.uGround.value.setRGB(
      0.25 * (this.lightE.r * sinA + skyIrr), 0.25 * (this.lightE.g * sinA + skyIrrG), 0.2 * (this.lightE.b * sinA + skyIrrB));
    this.envMat.uniforms.uDim.value = 1 - 0.3 * smoothstep(0.4, 1, cover);
    const old = this.envRT;
    this.envRT = this.pmrem.fromScene(this.envScene, 0, 0.1, 20);
    this.scene.environment = this.envRT.texture;
    if (old) old.dispose();
  }

  // Keep the shadow map centred on the player, snapped to whole texels so it does not swim.
  updateShadow(focus, range, mapSize) {
    const L = this.light, cam = L.shadow.camera;
    if (L.shadow.mapSize.x !== mapSize) { L.shadow.mapSize.set(mapSize, mapSize); if (L.shadow.map) { L.shadow.map.dispose(); L.shadow.map = null; } }
    if (cam.right !== range) { cam.left = -range; cam.right = range; cam.top = range; cam.bottom = -range; cam.near = 1; cam.far = 700; cam.updateProjectionMatrix(); }
    const d = this.lightDir;
    const right = _v1.set(d.z, 0, -d.x).normalize();
    const up = _v2.crossVectors(d, right).normalize();
    const texel = (range * 2) / mapSize;
    const x = Math.round(focus.dot(right) / texel) * texel, y = Math.round(focus.dot(up) / texel) * texel, z = focus.dot(d);
    _v3.set(0, 0, 0).addScaledVector(right, x).addScaledVector(up, y).addScaledVector(d, z);
    L.target.position.copy(_v3);
    L.position.copy(_v3).addScaledVector(d, 350);
    L.target.updateMatrixWorld(); L.updateMatrixWorld();
    // nothing to draw when neither body is giving light
    const lum = this.lightE.r + this.lightE.g + this.lightE.b;
    this.renderer.shadowMap.autoUpdate = lum > 0.004;
  }
}
