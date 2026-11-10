// Procedural textures, baked on the GPU at load.
//
// Nothing is downloaded: every surface in the game is synthesised here by
// rendering a fragment shader into a texture once. Each recipe is tileable.
import { THREE } from './lib/three.js';
import { NOISE_GLSL } from './shared.js';

const VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const HEAD = /* glsl */`
precision highp float;
varying vec2 vUv;
${NOISE_GLSL}
vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }
float sat(float x) { return clamp(x, 0.0, 1.0); }
`;

export class Baker {
  constructor(renderer) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.mesh = new THREE.Mesh(geo, null);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    this.maxAniso = renderer.capabilities.getMaxAnisotropy();
  }

  // body: GLSL for `void main()` contents, writing gl_FragColor. Returns a repeat-wrapped, mipmapped texture.
  bake(body, size, { srgb = false, uniforms = {}, aniso = 8, mip = true, width = size, height = size, pre = '', wrap = THREE.RepeatWrapping, float = false } = {}) {
    const rt = new THREE.WebGLRenderTarget(width, height, {
      type: float ? THREE.HalfFloatType : THREE.UnsignedByteType, format: THREE.RGBAFormat,
      colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace,
      depthBuffer: false, stencilBuffer: false,
      minFilter: mip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter, magFilter: THREE.LinearFilter,
      generateMipmaps: mip, wrapS: wrap, wrapT: wrap,
    });
    rt.texture.anisotropy = Math.min(aniso, this.maxAniso);
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: HEAD + pre + '\nvoid main() {\n' + body + '\n}',
      uniforms, depthTest: false, depthWrite: false, toneMapped: false,
    });
    this.mesh.material = mat;
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(rt);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(prev);
    mat.dispose();
    rt.texture.userData.rt = rt;
    return rt.texture;
  }

  // Derive a tangent-space normal map (rg) from a height texture's given channel; b and a pass through two other channels.
  normalFromHeight(heightTex, size, { strength = 2.0, channel = 'a', b = 'b', a = 'a' } = {}) {
    return this.bake(/* glsl */`
      float e = 1.0 / uSize;
      float hl = texture2D(tH, vUv - vec2(e, 0.0)).${channel}, hr = texture2D(tH, vUv + vec2(e, 0.0)).${channel};
      float hd = texture2D(tH, vUv - vec2(0.0, e)).${channel}, hu = texture2D(tH, vUv + vec2(0.0, e)).${channel};
      vec3 n = normalize(vec3((hl - hr) * uStrength, (hd - hu) * uStrength, 1.0));
      vec4 src = texture2D(tH, vUv);
      gl_FragColor = vec4(n.xy * 0.5 + 0.5, src.${b}, src.${a});
    `, size, { pre: 'uniform sampler2D tH; uniform float uSize; uniform float uStrength;', uniforms: { tH: { value: heightTex }, uSize: { value: size }, uStrength: { value: strength } } });
  }
}

// Shared tileable noise. R: soft billows, G: finer fbm, B: cellular, A: white.
export function bakeNoise(baker, size = 512) {
  return baker.bake(/* glsl */`
    float r = fbm(vUv * 4.0, 4.0, 6);
    float g = fbm(vUv * 8.0 + 3.1, 8.0, 5);
    float b = worley(vUv * 12.0, 12.0).x;
    float a = hash21(vUv * ${size}.0);
    gl_FragColor = vec4(sat((r - 0.5) * 1.9 + 0.5), sat((g - 0.5) * 1.9 + 0.5), b, a);
  `, size, { aniso: 4 });
}

// ---------------------------------------------------------------------------
// Material recipes. Each returns { a, n }: albedo (sRGB) and a packed texture
// holding the tangent-space normal in rg, roughness in b and cavity in a.

// Béton brut: concrete cast against rough timber shuttering. One tile is 3.2 m
// and carries twenty boards with their joints, grain, tie-rod holes and voids.
export function bakeConcrete(baker, size = 1024) {
  const pre = /* glsl */`
    const float BOARDS = 20.0;
    // x: height, y: tone, z: roughness, w: cavity
    vec4 concrete(vec2 uv) {
      float row = floor(uv.y * BOARDS);
      float fy = fract(uv.y * BOARDS);
      float rh = hash21(vec2(row, 3.0)), rh2 = hash21(vec2(row, 11.0)), rh3 = hash21(vec2(row, 29.0));
      // each board sits a little proud or shy of its neighbours
      float h = 0.5 + (rh - 0.5) * 0.22;
      float tone = 1.0 + (rh2 - 0.5) * 0.13;
      // timber grain pressed into the face, running along the board
      float grain = fbm(vec2(uv.x * 6.0 + rh * 5.0, uv.y * 320.0), 320.0, 3) * 0.6 + gnoise(vec2(uv.x * 3.0, uv.y * BOARDS * 9.0 + rh3 * 3.0), 180.0) * 0.4;
      h += (grain - 0.5) * 0.16;
      tone += (grain - 0.5) * 0.09;
      // fins of paste that leaked between boards
      float seam = smoothstep(0.075, 0.0, min(fy, 1.0 - fy));
      h += seam * 0.3 * (0.55 + 0.45 * vnoise(vec2(uv.x * 60.0, row), 60.0));
      tone -= seam * 0.10;
      // butt joints where one board ends and the next begins
      float bx = fract(uv.x * 2.0 + rh);
      float butt = smoothstep(0.004, 0.0, abs(bx - 0.5)) * step(0.12, fy) * step(fy, 0.88);
      h -= butt * 0.25; tone -= butt * 0.2;
      // knots
      vec2 kc = vec2(fract(uv.x * 2.0 + rh2 * 7.0) - 0.5, (fy - 0.5) * 0.11);
      float knot = smoothstep(0.03, 0.012, length(kc * vec2(1.0, 6.0))) * step(0.72, rh3);
      h -= knot * 0.12; tone -= knot * 0.12;
      // air voids left by the pour
      vec3 wv = worley(uv * 70.0, 70.0);
      float voids = smoothstep(0.11, 0.03, wv.x) * step(0.74, wv.z);
      h -= voids * 0.55; tone -= voids * 0.38;
      // tie-rod holes on an 0.8 m grid
      vec2 tc = fract(uv * 4.0 + vec2(0.5, 0.26)) - 0.5;
      float tr = length(tc) * 0.8;      // metres
      float tie = smoothstep(0.019, 0.013, tr);
      float ring = smoothstep(0.034, 0.026, tr) * (1.0 - tie);
      h -= tie * 0.9; h += ring * 0.08; tone -= tie * 0.62; tone += ring * 0.05;
      // mottling of the mix, and fine aggregate
      float mott = fbm(uv * 3.0 + 9.2, 3.0, 5);
      tone *= 0.9 + 0.22 * mott;
      float fine = hash21(uv * 1024.0) - 0.5;
      tone += fine * 0.055; h += fine * 0.05;
      float rough = 0.9 - seam * 0.08 + (mott - 0.5) * 0.1 + voids * 0.05;
      float cav = 1.0 - sat(tie + voids * 0.8 + butt * 0.6) * 0.75;
      return vec4(h, tone, rough, cav);
    }`;
  const h = baker.bake(/* glsl */`gl_FragColor = concrete(vUv);`, size, { pre, mip: false });
  const a = baker.bake(/* glsl */`
    vec4 c = texture2D(tH, vUv);
    float warm = fbm(vUv * 2.0 + 4.7, 2.0, 4);
    vec3 base = mix(vec3(0.565, 0.552, 0.525), vec3(0.615, 0.585, 0.535), warm);
    gl_FragColor = vec4(srgb(base * c.y), 1.0);
  `, size, { srgb: true, pre: 'uniform sampler2D tH;', uniforms: { tH: { value: h } } });
  const n = baker.normalFromHeight(h, size, { strength: 5.5, channel: 'x', b: 'z', a: 'w' });
  h.userData.rt.dispose();
  return { a, n };
}

// Cast paving: one 4 m slab per tile with a joint at its edge, broom finish, hairline cracks, stains.
export function bakePaving(baker, size = 1024) {
  const pre = /* glsl */`
    vec4 paving(vec2 uv) {
      vec2 e = min(uv, 1.0 - uv);
      float jd = min(e.x, e.y);
      float joint = smoothstep(0.0055, 0.0015, jd);
      float lip = smoothstep(0.022, 0.006, jd) * (1.0 - joint);
      float h = 0.6, tone = 1.0;
      // broom finish drawn across the slab
      float broom = fbm(vec2(uv.x * 420.0, uv.y * 10.0), 420.0, 2);
      h += (broom - 0.5) * 0.07; tone += (broom - 0.5) * 0.05;
      // worn patches where the aggregate shows through
      float wear = smoothstep(0.5, 0.78, fbm(uv * 5.0 + 2.3, 5.0, 5));
      vec3 ag = worley(uv * 210.0, 210.0);
      float stone = smoothstep(0.42, 0.2, ag.x) * wear * step(0.35, ag.z);
      h += stone * 0.09 - wear * 0.04; tone += stone * (ag.z - 0.6) * 0.22 - wear * 0.04;
      float crack = 0.0;
      // stains
      float stain = fbm(uv * 4.0 + 1.3, 4.0, 5);
      tone *= 0.86 + 0.26 * stain;
      float blot = smoothstep(0.66, 0.8, fbm(uv * 7.0 + 8.1, 7.0, 4));
      tone *= 1.0 - blot * 0.22;
      float fine = hash21(uv * 1024.0) - 0.5;
      tone += fine * 0.05; h += fine * 0.04;
      h -= joint * 0.7; h -= lip * 0.06; tone *= 1.0 - joint * 0.72; tone -= lip * 0.07;
      float rough = 0.88 - wear * 0.07 + blot * 0.04;
      float cav = 1.0 - sat(joint + crack) * 0.7;
      return vec4(h, tone, rough, cav);
    }`;
  const h = baker.bake(/* glsl */`gl_FragColor = paving(vUv);`, size, { pre, mip: false });
  const a = baker.bake(/* glsl */`
    vec4 c = texture2D(tH, vUv);
    float warm = fbm(vUv * 3.0 + 4.7, 3.0, 4);
    vec3 base = mix(vec3(0.555, 0.545, 0.52), vec3(0.6, 0.575, 0.53), warm);
    gl_FragColor = vec4(srgb(base * c.y), 1.0);
  `, size, { srgb: true, pre: 'uniform sampler2D tH;', uniforms: { tH: { value: h } } });
  const n = baker.normalFromHeight(h, size, { strength: 5.0, channel: 'x', b: 'z', a: 'w' });
  h.userData.rt.dispose();
  return { a, n };
}

// Reclaimed ground: dark soil, leaf litter, pebbles and a felt of moss. 2.5 m tile.
export function bakeSoil(baker, size = 512) {
  const pre = /* glsl */`
    vec4 soilH(vec2 uv) {
      float big = fbm(uv * 4.0, 4.0, 6);
      float mid = fbm(uv * 16.0 + 3.3, 16.0, 4);
      vec3 pb = worley(uv * 34.0, 34.0);
      float pebble = smoothstep(0.3, 0.1, pb.x) * step(0.8, pb.z);
      vec3 lf = worley(uv * 20.0 + 0.5, 20.0);
      float leaf = smoothstep(0.42, 0.3, lf.x) * step(lf.z, 0.42);
      float h = big * 0.55 + mid * 0.3 + pebble * 0.35 + leaf * 0.08;
      return vec4(h, pebble, leaf, lf.z);
    }`;
  const h = baker.bake(/* glsl */`gl_FragColor = soilH(vUv);`, size, { pre, mip: false });
  const a = baker.bake(/* glsl */`
    vec4 s = texture2D(tH, vUv);
    float big = fbm(vUv * 4.0, 4.0, 6), green = smoothstep(0.42, 0.66, fbm(vUv * 6.0 + 5.1, 6.0, 5));
    vec3 col = mix(vec3(0.20, 0.155, 0.11), vec3(0.31, 0.25, 0.17), big);
    col = mix(col, mix(vec3(0.17, 0.22, 0.09), vec3(0.27, 0.33, 0.12), fbm(vUv * 30.0, 30.0, 3)), green * 0.85);
    col = mix(col, vec3(0.42, 0.40, 0.37) * (0.7 + 0.5 * s.w), s.y);
    col = mix(col, mix(vec3(0.36, 0.25, 0.11), vec3(0.47, 0.38, 0.16), s.w * 2.2), s.z * 0.8);
    col *= 0.85 + 0.3 * hash21(vUv * 512.0);
    gl_FragColor = vec4(srgb(col), 1.0);
  `, size, { srgb: true, pre: 'uniform sampler2D tH;', uniforms: { tH: { value: h } } });
  const hh = baker.bake(/* glsl */`vec4 s = texture2D(tH, vUv); gl_FragColor = vec4(s.x, 0.0, 0.96 - s.y * 0.2, 1.0);`, size, { pre: 'uniform sampler2D tH;', uniforms: { tH: { value: h } }, mip: false });
  const n = baker.normalFromHeight(hh, size, { strength: 3.2, channel: 'x', b: 'z', a: 'w' });
  h.userData.rt.dispose(); hh.userData.rt.dispose();
  return { a, n };
}

// Rusted steel, for whatever paint has let go of. 1.5 m tile.
export function bakeRust(baker, size = 512) {
  const pre = /* glsl */`
    vec4 rustH(vec2 uv) {
      float big = fbm(uv * 5.0, 5.0, 6), flake = fbm(uv * 26.0 + 2.2, 26.0, 4);
      vec3 pit = worley(uv * 46.0, 46.0);
      float pits = smoothstep(0.26, 0.08, pit.x) * step(0.55, pit.z);
      float h = big * 0.4 + flake * 0.5 - pits * 0.35;
      return vec4(h, big, flake, pits);
    }`;
  const h = baker.bake(/* glsl */`gl_FragColor = rustH(vUv);`, size, { pre, mip: false });
  const a = baker.bake(/* glsl */`
    vec4 s = texture2D(tH, vUv);
    vec3 col = mix(vec3(0.20, 0.085, 0.04), vec3(0.47, 0.22, 0.085), s.y);
    col = mix(col, vec3(0.60, 0.33, 0.12), smoothstep(0.55, 0.8, s.z) * 0.7);
    col = mix(col, vec3(0.10, 0.05, 0.035), s.w * 0.8);
    col *= 0.88 + 0.24 * hash21(vUv * 512.0);
    gl_FragColor = vec4(srgb(col), 1.0);
  `, size, { srgb: true, pre: 'uniform sampler2D tH;', uniforms: { tH: { value: h } } });
  const hh = baker.bake(/* glsl */`vec4 s = texture2D(tH, vUv); gl_FragColor = vec4(s.x, 0.0, 0.93 - s.z * 0.12, 1.0 - s.w * 0.5);`, size, { pre: 'uniform sampler2D tH;', uniforms: { tH: { value: h } }, mip: false });
  const n = baker.normalFromHeight(hh, size, { strength: 3.0, channel: 'x', b: 'z', a: 'w' });
  h.userData.rt.dispose(); hh.userData.rt.dispose();
  return { a, n };
}

// Smooth fields whose contour lines become cracks in the paving. Sampled in world space with a
// period of about forty metres, so no two slabs break the same way. R, G: two crack families. B: where they show.
export function bakeCrackField(baker, size = 256) {
  return baker.bake(/* glsl */`
    float r = fbm(vUv * 5.0, 5.0, 2);
    float g = fbm(vUv * 9.0 + 4.4, 9.0, 2);
    float b = fbm(vUv * 3.0 + 1.9, 3.0, 4);
    gl_FragColor = vec4(r, g, sat((b - 0.5) * 2.2 + 0.5), 1.0);
  `, size, { mip: false, aniso: 1 });
}

// Bark: deep vertical fissures between corky ridges. u runs round the trunk, v up it.
export function bakeBark(baker, size = 512) {
  const pre = /* glsl */`
    vec4 barkH(vec2 uv) {
      vec2 p = vec2(uv.x * 9.0 + fbm(uv * vec2(3.0, 5.0), 3.0, 3) * 1.6, uv.y * 2.2);
      vec3 w = worley(p, 9.0);
      float ridge = smoothstep(0.02, 0.36, w.y - w.x);
      float plate = fbm(uv * vec2(14.0, 34.0) + 3.3, 14.0, 4);
      float h = ridge * 0.75 + plate * 0.25;
      return vec4(h, ridge, plate, w.z);
    }`;
  const h = baker.bake(/* glsl */`gl_FragColor = barkH(vUv);`, size, { pre, mip: false });
  const a = baker.bake(/* glsl */`
    vec4 s = texture2D(tH, vUv);
    vec3 col = mix(vec3(0.085, 0.07, 0.055), mix(vec3(0.34, 0.3, 0.25), vec3(0.47, 0.44, 0.38), s.w), s.y);
    col *= 0.75 + 0.5 * s.z;
    float lichen = smoothstep(0.62, 0.8, fbm(vUv * 5.0 + 9.1, 5.0, 4)) * s.y;
    col = mix(col, vec3(0.45, 0.5, 0.36), lichen * 0.55);
    gl_FragColor = vec4(srgb(col), 1.0);
  `, size, { srgb: true, pre: 'uniform sampler2D tH;', uniforms: { tH: { value: h } } });
  const hh = baker.bake(/* glsl */`vec4 s = texture2D(tH, vUv); gl_FragColor = vec4(s.x, 0.0, 0.95 - s.y * 0.1, 0.45 + 0.55 * s.y);`, size, { pre: 'uniform sampler2D tH;', uniforms: { tH: { value: h } }, mip: false });
  const n = baker.normalFromHeight(hh, size, { strength: 4.5, channel: 'x', b: 'z', a: 'w' });
  h.userData.rt.dispose(); hh.userData.rt.dispose();
  return { a, n };
}

// Ripples for standing water: a normal map in rg, tileable.
export function bakeWaterNormal(baker, size = 256) {
  const h = baker.bake(/* glsl */`float a = fbm(vUv * 6.0, 6.0, 5); float b = fbm(vUv * 13.0 + 2.7, 13.0, 4); gl_FragColor = vec4(a * 0.65 + b * 0.35, 0.0, 0.0, 1.0);`, size, { mip: false });
  const n = baker.normalFromHeight(h, size, { strength: 2.2, channel: 'x', b: 'z', a: 'w' });
  h.userData.rt.dispose();
  return n;
}
