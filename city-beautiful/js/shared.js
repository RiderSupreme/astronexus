// Uniforms and shader snippets shared by every material in the world.
//
// One set of uniform objects is handed to every shader, so updating a value
// here (time of day, wind, wetness) changes the whole scene at once.
import { THREE } from './lib/three.js';

export const GU = {
  uTime: { value: 0 },
  tNoise: { value: null },                                   // tileable RGBA noise (see textures.js)
  tSkyLUT: { value: null },                                  // sky radiance by azimuth and elevation (see sky.js)
  uFog: { value: new THREE.Vector4(0.0035, 0.03, 0, 1) },    // density, height falloff, base height, max opacity
  uLightDir: { value: new THREE.Vector3(0, 1, 0) },          // toward the sun, or the moon after dark
  uLightColor: { value: new THREE.Color(1, 1, 1) },
  uWind: { value: new THREE.Vector4(0.8, 0.6, 0.6, 0) },     // direction x, direction z, strength, gust phase
  uWet: { value: 0 },                                        // 0 dry .. 1 soaked
  uNight: { value: 0 },                                      // 0 day .. 1 full night
  uCamPos: { value: new THREE.Vector3() },
  uFlash: { value: new THREE.Vector4(0, 0, 0, 0) },          // lightning: rgb + intensity
};

export const SKY_LUT_GLSL = /* glsl */`
uniform sampler2D tSkyLUT;
vec3 skyLut(vec3 d) {
  float el = asin(clamp(d.y, 0.0, 1.0));
  return texture2D(tSkyLUT, vec2(atan(d.x, -d.z) * 0.15915494 + 0.5, sqrt(el * 0.63661977))).rgb;
}
`;

// Height fog whose colour is read from the sky behind it, so distance fades
// toward the horizon's real colour in every direction: gold into the sunset,
// blue-grey away from it.
export const FOG_GLSL = SKY_LUT_GLSL + /* glsl */`
uniform vec4 uFog;
float fogAmount(vec3 ro, vec3 rd, float dist) {
  float t = rd.y * uFog.y;
  float k = abs(t) > 1e-5 ? (1.0 - exp(-dist * t)) / t : dist;
  float od = uFog.x * exp(-uFog.y * (ro.y - uFog.z)) * k;
  return uFog.w * (1.0 - exp(-od));
}
vec3 applyFog(vec3 col, vec3 wpos) {
  vec3 rd = wpos - cameraPosition;
  float dist = length(rd);
  rd /= max(dist, 1e-4);
  float f = fogAmount(cameraPosition, rd, dist);
  vec3 fd = normalize(vec3(rd.x, max(rd.y, 0.035), rd.z));
  return mix(col, skyLut(fd), f);
}
`;

// Deterministic integer hashes and tileable noise for GLSL ES 3.
export const NOISE_GLSL = /* glsl */`
uint pcg(uint v) { uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
float hash21(vec2 p) { uvec2 q = uvec2(ivec2(floor(p)) + 32768); return float(pcg(q.x + pcg(q.y))) * (1.0 / 4294967295.0); }
vec2 hash22(vec2 p) { uvec2 q = uvec2(ivec2(floor(p)) + 32768); uint a = pcg(q.x + pcg(q.y)); return vec2(float(a), float(pcg(a))) * (1.0 / 4294967295.0); }
float vnoise(vec2 p, float per) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(mod(i, per)), b = hash21(mod(i + vec2(1.0, 0.0), per));
  float c = hash21(mod(i + vec2(0.0, 1.0), per)), d = hash21(mod(i + vec2(1.0, 1.0), per));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float gnoise(vec2 p, float per) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  #define GRD(o) (hash22(mod(i + o, per)) * 2.0 - 1.0)
  float a = dot(GRD(vec2(0.0, 0.0)), f), b = dot(GRD(vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
  float c = dot(GRD(vec2(0.0, 1.0)), f - vec2(0.0, 1.0)), d = dot(GRD(vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
  #undef GRD
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 0.7071 + 0.5;
}
float fbm(vec2 p, float per, int oct) {
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < oct; i++) { s += a * gnoise(p, per); n += a; p = p * 2.0 + 13.7; per *= 2.0; a *= 0.5; }
  return s / n;
}
float vfbm(vec2 p, float per, int oct) {
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < oct; i++) { s += a * vnoise(p, per); n += a; p = p * 2.0 + 7.3; per *= 2.0; a *= 0.5; }
  return s / n;
}
// Tileable Worley noise: x = distance to nearest feature, y = second nearest, z = cell id.
vec3 worley(vec2 p, float per) {
  vec2 i = floor(p), f = fract(p); float d1 = 9.0, d2 = 9.0, id = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(float(x), float(y)); vec2 c = mod(i + o, per); vec2 r = o + hash22(c) - f; float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; id = hash21(c + 17.0); } else if (d < d2) d2 = d;
  }
  return vec3(sqrt(d1), sqrt(d2), id);
}
`;
