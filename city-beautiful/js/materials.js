// Material system.
//
// Everything lit in the world is a MeshStandardMaterial with extra GLSL spliced
// in at fixed points, so the engine's own lighting, shadows and image-based
// ambient keep working while each surface gains what it needs: fog that
// matches the sky, baked ambient occlusion, world-space texturing that needs
// no UVs, and decades of weather.
import { THREE } from './lib/three.js';
import { GU, FOG_GLSL } from './shared.js';

const WORLD_VERT_PARS = /* glsl */`
varying vec3 vWPos;
varying vec3 vWNrm;
uniform float uTime;
`;

// Splice GLSL into a built-in material. Hooks:
//   vertPars, vertUv (after uvs are set), vertNormal (may set `objectNormal`), vertBegin (may move `transformed`), vertEnd,
//   fragPars, fragColor (after vertex colour; may set diffuseColor), fragRough (roughnessFactor, metalnessFactor),
//   fragNormal (view-space `normal`), fragEmissive (totalEmissiveRadiance), fragLight (reflectedLight), fragOut (gl_FragColor before fog)
export function patch(material, o = {}) {
  const key = o.key || 'std';
  const uniforms = Object.assign({ tSkyLUT: GU.tSkyLUT, uFog: GU.uFog, uTime: GU.uTime }, o.uniforms || {});
  if (o.defines) material.defines = Object.assign(material.defines || {}, o.defines);
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    let vs = shader.vertexShader, fs = shader.fragmentShader;
    vs = vs.replace('#include <common>', '#include <common>\n' + WORLD_VERT_PARS + (o.vertPars || ''));
    if (o.vertUv) vs = vs.replace('#include <uv_vertex>', '#include <uv_vertex>\n' + o.vertUv);
    if (o.vertNormal) vs = vs.replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n' + o.vertNormal);
    if (o.vertBegin) vs = vs.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + o.vertBegin);
    vs = vs.replace('#include <normal_vertex>', '#include <normal_vertex>\n vWNrm = normalize(inverseTransformDirection(transformedNormal, viewMatrix));');
    vs = vs.replace('#include <project_vertex>', /* glsl */`#include <project_vertex>
      { vec4 wp4 = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          wp4 = instanceMatrix * wp4;
        #endif
        vWPos = (modelMatrix * wp4).xyz; }
      ` + (o.vertEnd || ''));
    fs = fs.replace('#include <common>', '#include <common>\n' + WORLD_VERT_PARS + (o.fog === false ? '' : FOG_GLSL) + (o.fragPars || ''));
    if (o.fragColor) fs = fs.replace('#include <color_fragment>', '#include <color_fragment>\n' + o.fragColor);
    if (o.fragRough) fs = fs.replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n' + o.fragRough);
    if (o.fragNormal) fs = fs.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + o.fragNormal);
    if (o.fragEmissive) fs = fs.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + o.fragEmissive);
    if (o.fragLight) fs = fs.replace('#include <aomap_fragment>', '#include <aomap_fragment>\n' + o.fragLight);
    fs = fs.replace('#include <fog_fragment>', (o.fragOut || '') + (o.fog === false ? '' : '\n gl_FragColor.rgb = applyFog(gl_FragColor.rgb, vWPos);'));
    shader.vertexShader = vs; shader.fragmentShader = fs;
    material.userData.shader = shader;
  };
  material.customProgramCacheKey = () => key;
  return material;
}

// A plain lit material that takes part in the fog. For props, glass, anything simple.
export function standard(params = {}, key = 'plain') {
  return patch(new THREE.MeshStandardMaterial(params), { key });
}

// ---------------------------------------------------------------------------
// Weathered surfaces: concrete, paving and painted steel.
//
// Geometry carries two extra attributes besides position and normal:
//   color  rgb tint, or the paint colour where aSurf.y > 0
//   aSurf  x: baked ambient occlusion (1 open sky .. 0 buried)
//          y: how much paint survives (0 = bare)
//          z: overgrowth bias (ground: 0 bare paving .. 1 reclaimed; walls: extra moss, may be negative)
//          w: 1 = shuttering boards run vertically
const SURF_VERT_PARS = /* glsl */`
attribute vec4 aSurf;
varying vec4 vSurf;
`;

const SURF_FRAG_PARS = /* glsl */`
uniform sampler2D tA; uniform sampler2D tN; uniform sampler2D tNoise;
uniform vec4 uSurf;         // x: tile size in metres, y: ground datum, z: normal strength, w: unused
uniform float uWet;
varying vec4 vSurf;
#ifdef SURF_GROUND
  uniform sampler2D tA2; uniform sampler2D tN2; uniform sampler2D tCrack;
#endif
`;

const SURF_FRAG_COLOR = /* glsl */`
  vec3 sN = normalize(vWNrm) * (gl_FrontFacing ? 1.0 : -1.0);
  vec3 tw = pow(abs(sN), vec3(6.0)); tw /= (tw.x + tw.y + tw.z);
  vec3 tp = vWPos / uSurf.x;
  bool sVert = vSurf.w > 0.5;
  vec2 uvx = sVert ? tp.yz : tp.zy, uvz = sVert ? tp.yx : tp.xy, uvy = tp.xz;
  vec2 gxx = dFdx(uvx), gyx = dFdy(uvx), gxz = dFdx(uvz), gyz = dFdy(uvz), gxy = dFdx(uvy), gyy = dFdy(uvy);
  vec4 sA = vec4(0.0), sNr = vec4(0.0); vec3 sPert = vec3(0.0);
  if (tw.x > 0.01) {
    vec4 a = textureGrad(tA, uvx, gxx, gyx), n = textureGrad(tN, uvx, gxx, gyx); vec2 t = n.xy * 2.0 - 1.0;
    sA += a * tw.x; sNr += n * tw.x; sPert += tw.x * (sVert ? vec3(0.0, t.x, t.y) : vec3(0.0, t.y, t.x));
  }
  if (tw.z > 0.01) {
    vec4 a = textureGrad(tA, uvz, gxz, gyz), n = textureGrad(tN, uvz, gxz, gyz); vec2 t = n.xy * 2.0 - 1.0;
    sA += a * tw.z; sNr += n * tw.z; sPert += tw.z * (sVert ? vec3(t.y, t.x, 0.0) : vec3(t.x, t.y, 0.0));
  }
  if (tw.y > 0.01) {
    vec4 a = textureGrad(tA, uvy, gxy, gyy), n = textureGrad(tN, uvy, gxy, gyy); vec2 t = n.xy * 2.0 - 1.0;
    sA += a * tw.y; sNr += n * tw.y; sPert += tw.y * vec3(t.x, 0.0, t.y);
  }
  vec3 alb = sA.rgb; float rgh = sNr.b; float cav = sNr.a;
  float aoV = vSurf.x;
  float wallF = 1.0 - smoothstep(0.45, 0.8, abs(sN.y));
  float upF = smoothstep(0.6, 0.9, sN.y);
  // coordinates within the plane of the surface, for stains that follow gravity
  float hC = vWPos.x * sN.z - vWPos.z * sN.x;
  vec2 q = mix(vec2(hC, vWPos.y), vWPos.xz, step(0.6, abs(sN.y)));
  vec4 S1 = texture2D(tNoise, q * 0.013 + 0.17);
  vec4 S2 = texture2D(tNoise, q * 0.083 + 0.5);
  vec4 S3 = texture2D(tNoise, q * 0.41);
  vec4 S5 = texture2D(tNoise, q * 1.9 + 0.3);

  // the mix varies from pour to pour
  alb *= 0.70 + 0.22 * S1.r + 0.14 * S2.g;
  #ifndef SURF_GROUND
    #ifndef SURF_METAL
      float liftY = vWPos.y / 1.28;
      float lift = fract(sin(floor(liftY) * 12.9898 + floor(hC / 14.0) * 4.1) * 43758.5453);
      alb *= mix(1.0, 0.925 + 0.15 * lift, wallF);
      alb *= 1.0 - 0.16 * wallF * smoothstep(0.018, 0.004, abs(fract(liftY) - 0.5) * 1.28 * (0.7 + 0.6 * S3.r));
    #endif
  #endif

  float paintKeep = 0.0;
  if (vSurf.y > 0.001) {
    float pn = S2.r * 0.5 + S3.g * 0.32 + S5.r * 0.18;
    paintKeep = smoothstep(1.0 - vSurf.y - 0.05, 1.0 - vSurf.y + 0.05, pn + (cav - 1.0) * 0.35 - (1.0 - aoV) * 0.12);
    vec3 pc = vColor * (0.74 + 0.34 * S2.g);
    pc = mix(pc, vec3(dot(pc, vec3(0.3, 0.5, 0.2))) * 1.08, 0.2);      // sun-bleached
    alb = mix(alb, pc, paintKeep);
    rgh = mix(rgh, 0.66, paintKeep * 0.7);
    sPert *= 1.0 - paintKeep * 0.45;
  } else {
    alb *= vColor;
  }

  // water has been running down these walls for sixty years
  vec4 S4 = texture2D(tNoise, vec2(hC * 0.37, vWPos.y * 0.019 + 0.2));
  float streak = smoothstep(0.46, 0.8, S4.g * 0.62 + S3.r * 0.2 + S4.r * 0.25) * wallF * (0.3 + 0.7 * S1.g);
  alb *= 1.0 - 0.52 * streak;
  alb = mix(alb, alb * vec3(0.6, 0.585, 0.54), (1.0 - aoV) * 0.65);     // grime where rain never reaches
  // monsoon concrete goes black: an algal crust wherever water sits, patchy on the flat and heavy on ledges
  float crust = smoothstep(0.3, 0.74, S1.g * 0.45 + S2.r * 0.4 + S3.g * 0.25) * (upF * 0.85 + wallF * 0.3 * S1.r);
  #ifdef SURF_GROUND
    crust *= 0.75;
  #endif
  alb *= 1.0 - 0.48 * crust * (1.0 - paintKeep * 0.6);
  rgh = mix(rgh, 0.96, crust * 0.6);

  // moss and algae: on anything that faces up, climbing from the ground, and in every damp corner
  float mossN = S2.r * 0.58 + S3.g * 0.3 + (1.0 - cav) * 0.25 + S5.g * 0.12;
  float baseF = wallF * smoothstep(2.1, 0.0, (vWPos.y - uSurf.y) + (S2.g - 0.5) * 2.6);
  float mossAmt = clamp(upF * 0.42 + baseF * 0.8 + wallF * smoothstep(0.2, 0.9, -sN.z) * 0.22 + (1.0 - aoV) * 0.5 + vSurf.z + uWet * 0.08, 0.0, 1.0);
  #ifdef SURF_GROUND
    mossAmt *= 0.55;
  #endif
  #ifdef SURF_METAL
    mossAmt *= 0.45;
  #endif
  float moss = smoothstep(1.0 - mossAmt, 1.0 - mossAmt + 0.2, mossN) * (1.0 - paintKeep * 0.55);
  vec3 mossCol = mix(vec3(0.02, 0.023, 0.018), mix(vec3(0.03, 0.045, 0.017), vec3(0.068, 0.092, 0.03), S5.g), smoothstep(0.3, 0.7, S3.r));
  alb = mix(alb, mossCol, moss * 0.93);
  rgh = mix(rgh, 0.97, moss * 0.8);
  sPert *= 1.0 - moss * 0.4;

  #ifdef SURF_GROUND
    // cracks: contour lines of a slow noise field, measured in metres so they stay hair-thin at any distance
    float crack = 0.0;
    {
      // two families of cracks, each a stretched field so its contours run long and nearly straight, crossing at an angle
      vec2 cpA = vec2(vWPos.x * 0.94 + vWPos.z * 0.34, -vWPos.x * 0.34 + vWPos.z * 0.94) * vec2(0.0075, 0.043);
      vec2 cpB = vec2(vWPos.x * 0.26 - vWPos.z * 0.97, vWPos.x * 0.97 + vWPos.z * 0.26) * vec2(0.0085, 0.051);
      float fa = texture2D(tCrack, cpA).r, fb = texture2D(tCrack, cpB + 0.37).g;
      vec4 ck = texture2D(tCrack, vWPos.xz * 0.019);
      vec2 dpx = dFdx(vWPos.xz), dpy = dFdy(vWPos.xz);
      float det = dpx.x * dpy.y - dpx.y * dpy.x; det = abs(det) < 1e-9 ? 1e-9 : det;
      vec2 d1 = vec2(dFdx(fa), dFdy(fa)), d2 = vec2(dFdx(fb), dFdy(fb));
      vec2 g1 = vec2(dpy.y * d1.x - dpx.y * d1.y, dpx.x * d1.y - dpy.x * d1.x) / det;
      vec2 g2 = vec2(dpy.y * d2.x - dpx.y * d2.y, dpx.x * d2.y - dpy.x * d2.x) / det;
      float m1 = abs(fa - 0.5) / max(length(g1), 1e-4), m2 = abs(fb - 0.47) / max(length(g2), 1e-4);
      float cw = 0.005 + 0.014 * S3.g;
      float k1 = smoothstep(0.42, 0.56, ck.b), k2 = smoothstep(0.5, 0.36, ck.b) * smoothstep(0.3, 0.5, ck.r);
      float c1 = smoothstep(cw, cw * 0.35, m1) * k1;
      float c2 = smoothstep(cw * 0.8, cw * 0.25, m2) * k2;
      crack = max(c1, c2) * smoothstep(75.0, 30.0, length(vWPos - cameraPosition)) * upF;
      // damp, dirt and growth gather along a crack well beyond the gap itself
      float seep = max(smoothstep(0.3, 0.0, m1) * k1, smoothstep(0.22, 0.0, m2) * k2);
      cav = min(cav, 1.0 - 0.75 * max(crack, seep * 0.5));
      alb *= 1.0 - 0.72 * crack; alb *= 1.0 - 0.16 * seep;
    }
    // soil and litter take the paving back, starting from the joints and cracks
    float grow = vSurf.z;
    vec2 uv2 = vWPos.xz / 2.5;
    vec4 a2 = texture2D(tA2, uv2), n2 = texture2D(tN2, uv2);
    float creep = smoothstep(1.0 - grow * 1.3, 1.0 - grow * 1.3 + 0.28, S2.r * 0.55 + (1.0 - cav) * 0.55 + S3.g * 0.25 + S5.r * 0.1);
    alb = mix(alb, a2.rgb * (0.7 + 0.5 * S1.g), creep);
    rgh = mix(rgh, n2.b, creep);
    vec2 t2 = n2.xy * 2.0 - 1.0;
    sPert = mix(sPert, vec3(t2.x, 0.0, t2.y), creep);
    cav = mix(cav, 1.0, creep);
    // standing water after rain
    float puddle = smoothstep(0.56, 0.66, S2.g + S1.r * 0.25) * uWet * upF * (1.0 - creep * 0.6);
    alb *= 1.0 - 0.45 * puddle; rgh = mix(rgh, 0.03, puddle); sPert *= 1.0 - puddle;
  #endif

  alb *= mix(1.0, 0.6, uWet * (0.45 + 0.55 * upF));
  rgh = mix(rgh, rgh * 0.5, uWet * (0.35 + 0.65 * upF));
  vec3 sNW = normalize(sN + sPert * uSurf.z);
  diffuseColor.rgb = alb;
`;

const SURF_FRAG_ROUGH = /* glsl */`
  roughnessFactor = clamp(rgh, 0.03, 1.0);
  #ifdef SURF_METAL
    metalnessFactor = 0.0;
  #endif
`;
const SURF_FRAG_NORMAL = /* glsl */` normal = normalize((viewMatrix * vec4(sNW, 0.0)).xyz);`;
const SURF_FRAG_LIGHT = /* glsl */`
  { float occ = aoV * (0.6 + 0.4 * cav);
    reflectedLight.indirectDiffuse *= occ;
    reflectedLight.indirectSpecular *= occ * occ; }
`;

// kind: 'wall' | 'ground' | 'metal'
export function surface(kind, tex, { tile = 3.2, datum = 0, normalStrength = 1.0, noise, soil = null, cracks = null, side = THREE.FrontSide } = {}) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, vertexColors: true, side });
  const uniforms = {
    tA: { value: tex.a }, tN: { value: tex.n }, tNoise: { value: noise }, uWet: GU.uWet,
    uSurf: { value: new THREE.Vector4(tile, datum, normalStrength, 0) },
  };
  const defines = {};
  if (kind === 'ground') { defines.SURF_GROUND = 1; uniforms.tA2 = { value: soil.a }; uniforms.tN2 = { value: soil.n }; uniforms.tCrack = { value: cracks }; }
  if (kind === 'metal') defines.SURF_METAL = 1;
  return patch(mat, {
    key: 'surf-' + kind + (side === THREE.DoubleSide ? '-ds' : ''), uniforms, defines,
    vertPars: SURF_VERT_PARS, vertEnd: 'vSurf = aSurf;',
    fragPars: SURF_FRAG_PARS, fragColor: SURF_FRAG_COLOR, fragRough: SURF_FRAG_ROUGH, fragNormal: SURF_FRAG_NORMAL, fragLight: SURF_FRAG_LIGHT,
  });
}

// Old glazing behind the sun-breakers: dusty panes in steel frames, a good third of them gone.
export function glazing(noise) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2, metalness: 0, vertexColors: true });
  return patch(mat, {
    key: 'glazing', uniforms: { tNoise: { value: noise } },
    vertPars: SURF_VERT_PARS, vertEnd: 'vSurf = aSurf;',
    fragPars: 'varying vec4 vSurf; uniform sampler2D tNoise;',
    fragColor: /* glsl */`
      vec3 gN = normalize(vWNrm);
      vec2 gq = vec2(vWPos.x * gN.z - vWPos.z * gN.x, vWPos.y);
      vec2 gp = gq / vec2(1.3, 1.82);
      vec2 pane = floor(gp), pf = fract(gp);
      float ph = fract(sin(dot(pane, vec2(12.9898, 78.233))) * 43758.5453);
      vec4 gn = texture2D(tNoise, gq * 0.19);
      float frame = clamp(step(pf.x, 0.04) + step(0.96, pf.x) + step(pf.y, 0.03) + step(0.97, pf.y), 0.0, 1.0);
      // a broken pane keeps a jagged fringe of glass round its edge
      float hole = step(ph, 0.36) * step(0.42 - 0.3 * ph, min(min(pf.x, 1.0 - pf.x), min(pf.y, 1.0 - pf.y)) + (gn.g - 0.5) * 0.5);
      float dust = 0.3 + 0.7 * gn.r;
      vec3 gcol = vColor * (0.5 + 2.2 * dust * dust);
      gcol = mix(gcol, vec3(0.0035), hole);
      gcol = mix(gcol, vec3(0.045, 0.04, 0.035), frame);
      float gRough = mix(0.08 + 0.5 * dust * gn.g, 1.0, max(hole, frame));
      diffuseColor.rgb = gcol;
    `,
    fragRough: 'roughnessFactor = gRough;',
    fragLight: '{ float occ = vSurf.x; reflectedLight.indirectDiffuse *= occ; reflectedLight.indirectSpecular *= occ * (1.0 - hole); }',
  });
}

// Rubber, canvas, timber, sandbags: no texture of their own, only colour, dirt and the damp.
export function matte(noise) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, vertexColors: true });
  return patch(mat, {
    key: 'matte', uniforms: { tNoise: { value: noise }, uWet: GU.uWet },
    vertPars: SURF_VERT_PARS, vertEnd: 'vSurf = aSurf;',
    fragPars: 'varying vec4 vSurf; uniform sampler2D tNoise; uniform float uWet;',
    fragColor: /* glsl */`
      vec3 mN = normalize(vWNrm);
      vec2 mq = mix(vec2(vWPos.x * mN.z - vWPos.z * mN.x, vWPos.y), vWPos.xz, step(0.6, abs(mN.y)));
      vec4 m1 = texture2D(tNoise, mq * 0.11 + 0.3), m2 = texture2D(tNoise, mq * 0.9);
      vec3 mc = diffuseColor.rgb * (0.62 + 0.5 * m1.r + 0.22 * m2.g);
      float mUp = smoothstep(0.5, 0.9, mN.y);
      float mDirt = smoothstep(0.45, 0.8, m1.g * 0.6 + m2.r * 0.4 + mUp * 0.25 + (1.0 - vSurf.x) * 0.4);
      mc = mix(mc, vec3(0.035, 0.04, 0.022) + 0.03 * m2.b, mDirt * 0.7);
      mc *= mix(1.0, 0.6, uWet * (0.4 + 0.6 * mUp));
      diffuseColor.rgb = mc;
    `,
    fragRough: 'roughnessFactor = mix(0.92, 0.5, uWet * 0.6);',
    fragLight: '{ float occ = vSurf.x; reflectedLight.indirectDiffuse *= occ; reflectedLight.indirectSpecular *= occ * occ; }',
  });
}

// Far hills and anything else that is only a silhouette in the haze.
export function distant() {
  return patch(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, vertexColors: true, side: THREE.DoubleSide }), { key: 'distant' });
}

// Standing water: sixty monsoons of silt, a skin of duckweed, and the sky in whatever is left clear.
export function water(noise, ripple) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.05, metalness: 0 });
  return patch(mat, {
    key: 'water', uniforms: { tNoise: { value: noise }, tRipple: { value: ripple }, uWind: GU.uWind, uWet: GU.uWet },
    fragPars: 'uniform sampler2D tNoise; uniform sampler2D tRipple; uniform vec4 uWind; uniform float uWet;',
    fragColor: /* glsl */`
      vec2 wp = vWPos.xz;
      float scumN = texture2D(tNoise, wp * 0.045 + 0.3 + uWind.xy * uTime * 0.0008).r * 0.6 + texture2D(tNoise, wp * 0.17).g * 0.4;
      float scum = smoothstep(0.5, 0.58, scumN);
      vec3 scumCol = mix(vec3(0.05, 0.085, 0.018), vec3(0.11, 0.15, 0.035), texture2D(tNoise, wp * 0.9).g);
      diffuseColor.rgb = mix(vec3(0.01, 0.018, 0.011), scumCol, scum);
    `,
    fragRough: 'roughnessFactor = mix(0.04, 0.88, scum);',
    fragNormal: /* glsl */`
      { vec2 r1 = texture2D(tRipple, wp * 0.21 + uWind.xy * uTime * 0.02).xy * 2.0 - 1.0;
        vec2 r2 = texture2D(tRipple, wp * 0.47 - uWind.yx * uTime * 0.013 + 0.4).xy * 2.0 - 1.0;
        // rain pocks the surface with rings
        vec2 rc = fract(wp * 0.7 + vec2(floor(uTime * 2.3) * 0.37, floor(uTime * 2.3) * 0.61)) - 0.5;
        float ring = sin(length(rc) * 40.0 - fract(uTime * 2.3) * 14.0) * smoothstep(0.5, 0.1, length(rc)) * uWet;
        float k = (0.16 + 0.3 * uWet) * (1.0 - scum);
        vec3 wn = normalize(vec3((r1.x + r2.x) * k + rc.x * ring * 0.6, 1.0, (r1.y + r2.y) * k + rc.y * ring * 0.6));
        normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz); }
    `,
  });
}
