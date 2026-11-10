// Renderer and post-processing.
//
// The world is rendered into a floating-point HDR target (multisampled where
// the quality preset allows), the first-person weapon is drawn over it with a
// cleared depth buffer so it never pokes through walls, and a small chain of
// full-screen passes turns that into the final picture: sun shafts, bloom,
// exposure, filmic tone mapping, colour grade, vignette, grain and the
// screen-space feedback for damage.
import { THREE } from './lib/three.js';
import { clamp } from './util.js';

const FS_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const DOWN_FRAG = /* glsl */`
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uPrefilter; uniform float uClamp;
varying vec2 vUv;
vec3 s(vec2 o) { return texture2D(tSrc, vUv + o * uTexel).rgb; }
void main() {
  vec3 a = s(vec2(-2., 2.)), b = s(vec2(0., 2.)), c = s(vec2(2., 2.));
  vec3 d = s(vec2(-2., 0.)), e = s(vec2(0., 0.)), f = s(vec2(2., 0.));
  vec3 g = s(vec2(-2., -2.)), h = s(vec2(0., -2.)), i = s(vec2(2., -2.));
  vec3 j = s(vec2(-1., 1.)), k = s(vec2(1., 1.)), l = s(vec2(-1., -1.)), m = s(vec2(1., -1.));
  vec3 col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  if (uPrefilter > 0.5) {
    col = max(col, vec3(0.0));
    float lum = max(col.r, max(col.g, col.b));
    col *= min(1.0, uClamp / max(lum, 1e-4));   // tame fireflies before they smear
  }
  gl_FragColor = vec4(col, 1.0);
}`;

const UP_FRAG = /* glsl */`
uniform sampler2D tSrc; uniform sampler2D tAdd; uniform vec2 uTexel; uniform float uMix;
varying vec2 vUv;
vec3 s(vec2 o) { return texture2D(tSrc, vUv + o * uTexel).rgb; }
void main() {
  vec3 up = (s(vec2(-1., 1.)) + s(vec2(1., 1.)) + s(vec2(-1., -1.)) + s(vec2(1., -1.))
    + (s(vec2(0., 1.)) + s(vec2(-1., 0.)) + s(vec2(1., 0.)) + s(vec2(0., -1.))) * 2.0 + s(vec2(0.)) * 4.0) / 16.0;
  gl_FragColor = vec4(mix(texture2D(tAdd, vUv).rgb, up, uMix), 1.0);
}`;

// Sun shafts: a radial blur of whatever sky is visible, marched toward the sun's screen position.
const SHAFT_MASK_FRAG = /* glsl */`
uniform sampler2D tSrc; uniform sampler2D tDepth; uniform vec2 uSun; uniform float uAspect;
varying vec2 vUv;
void main() {
  float depth = texture2D(tDepth, vUv).x;
  vec3 col = texture2D(tSrc, vUv).rgb;
  float sky = step(0.999999, depth);
  vec2 d = (vUv - uSun) * vec2(uAspect, 1.0);
  float near = exp(-dot(d, d) * 7.0);
  gl_FragColor = vec4(min(col, vec3(4.0)) * sky * near, 1.0);
}`;
const SHAFT_BLUR_FRAG = /* glsl */`
uniform sampler2D tSrc; uniform vec2 uSun; uniform float uStep;
varying vec2 vUv;
void main() {
  vec2 dir = (uSun - vUv) * uStep;
  vec3 acc = vec3(0.0); vec2 p = vUv; float w = 1.0; float tw = 0.0;
  for (int i = 0; i < 12; i++) { acc += texture2D(tSrc, p).rgb * w; tw += w; p += dir; w *= 0.93; }
  gl_FragColor = vec4(acc / tw, 1.0);
}`;

const FINAL_FRAG = /* glsl */`
uniform sampler2D tScene; uniform sampler2D tBloom; uniform sampler2D tShafts;
uniform vec2 uRes; uniform float uTime;
uniform float uExposure; uniform float uBloom; uniform float uShafts; uniform vec3 uShaftColor;
uniform float uVignette; uniform float uGrain; uniform float uCA;
uniform float uSaturation; uniform float uContrast; uniform vec3 uTintShadow; uniform vec3 uTintHigh;
uniform float uDamage; uniform float uLowHealth; uniform float uFlash; uniform vec3 uFlashColor; uniform float uFade;
varying vec2 vUv;

// Stephen Hill's fit of the ACES reference rendering transform.
vec3 aces(vec3 c) {
  const mat3 inM = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 outM = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  c = inM * c;
  vec3 a = c * (c + 0.0245786) - 0.000090537;
  vec3 b = c * (0.983729 * c + 0.4329510) + 0.238081;
  return clamp(outM * (a / b), 0.0, 1.0);
}
float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

void main() {
  vec2 c = vUv - 0.5;
  float r2 = dot(c, c);
  // lens: a little lateral chromatic aberration, growing toward the corners
  vec2 off = c * r2 * uCA;
  vec3 col;
  col.r = texture2D(tScene, vUv - off).r;
  col.g = texture2D(tScene, vUv).g;
  col.b = texture2D(tScene, vUv + off).b;
  vec3 bloom = texture2D(tBloom, vUv).rgb;
  col = mix(col, bloom, uBloom);
  col += texture2D(tShafts, vUv).rgb * uShaftColor * uShafts;

  col *= uExposure;
  col = aces(col * 1.35);

  // grade in display space: split toning, contrast around mid grey, saturation
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col *= mix(uTintShadow, uTintHigh, smoothstep(0.0, 0.7, luma));
  col = 0.18 * pow(max(col, 0.0) / 0.18, vec3(uContrast));     // contrast pivoting on mid grey, so black stays black
  float sat = uSaturation * (1.0 - 0.75 * uLowHealth);
  col = mix(vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), col, sat);
  col = max(col, 0.0);

  // vignette
  float vig = smoothstep(0.95, 0.25, sqrt(r2) * 1.25);
  col *= mix(1.0, vig, uVignette);

  // hurt: red closes in from the edges and pulses when health is low
  float edge = smoothstep(0.12, 0.62, sqrt(r2));
  float pulse = 0.5 + 0.5 * sin(uTime * 5.5);
  float hurt = clamp(uDamage + uLowHealth * (0.35 + 0.25 * pulse), 0.0, 1.0);
  col = mix(col, vec3(0.42, 0.015, 0.01) * (0.35 + luma), edge * hurt);
  col = mix(col, uFlashColor, uFlash);

  // sRGB transfer, then grain in display space so it stays visible in the dark
  col = mix(col * 12.92, 1.055 * pow(max(col, 0.0), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, col));
  float g = hash(gl_FragCoord.xy + fract(uTime) * 311.7) - 0.5;
  col += g * uGrain * (0.6 + 0.8 * (1.0 - luma));
  col *= uFade;
  gl_FragColor = vec4(col, 1.0);
}`;

export const QUALITY = {
  low:    { label: 'Low',    pixelRatio: 1.0,  scale: 0.75, msaa: 0, shadow: 1024, shadowRange: 55,  bloom: true, bloomMips: 4, shafts: false, grass: 0.35, trees: 0.6, particles: 0.5, far: 520 },
  medium: { label: 'Medium', pixelRatio: 1.25, scale: 1.0,  msaa: 2, shadow: 2048, shadowRange: 80,  bloom: true, bloomMips: 5, shafts: true,  grass: 0.65, trees: 0.85, particles: 0.8, far: 700 },
  high:   { label: 'High',   pixelRatio: 1.5,  scale: 1.0,  msaa: 4, shadow: 2048, shadowRange: 95,  bloom: true, bloomMips: 6, shafts: true,  grass: 1.0,  trees: 1.0, particles: 1.0, far: 900 },
  ultra:  { label: 'Ultra',  pixelRatio: 2.0,  scale: 1.0,  msaa: 4, shadow: 4096, shadowRange: 120, bloom: true, bloomMips: 6, shafts: true,  grass: 1.5,  trees: 1.0, particles: 1.3, far: 1100 },
};

export class Gfx {
  constructor(canvas, qualityName = 'high') {
    this.canvas = canvas;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance' });
    this.renderer = renderer;
    renderer.autoClear = false;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = true;
    renderer.info.autoReset = false;

    const gl = renderer.getContext();
    this.isWebGL2 = renderer.capabilities.isWebGL2;
    this.hdr = this.isWebGL2 && (renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float'));
    this.maxSamples = this.isWebGL2 ? gl.getParameter(gl.MAX_SAMPLES) : 0;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.gpuName = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unknown';
    this.software = /swiftshader|llvmpipe|software/i.test(this.gpuName);

    this.fsScene = new THREE.Scene();
    this.fsCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.fsMesh = new THREE.Mesh(geo, null);
    this.fsMesh.frustumCulled = false;
    this.fsScene.add(this.fsMesh);

    const mk = (frag, uniforms) => new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false, toneMapped: false });
    this.matDown = mk(DOWN_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uPrefilter: { value: 0 }, uClamp: { value: 60 } });
    this.matUp = mk(UP_FRAG, { tSrc: { value: null }, tAdd: { value: null }, uTexel: { value: new THREE.Vector2() }, uMix: { value: 0.5 } });
    this.matShaftMask = mk(SHAFT_MASK_FRAG, { tSrc: { value: null }, tDepth: { value: null }, uSun: { value: new THREE.Vector2() }, uAspect: { value: 1 } });
    this.matShaftBlur = mk(SHAFT_BLUR_FRAG, { tSrc: { value: null }, uSun: { value: new THREE.Vector2() }, uStep: { value: 0.03 } });
    this.black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); this.black.needsUpdate = true;
    this.matFinal = mk(FINAL_FRAG, {
      tScene: { value: null }, tBloom: { value: this.black }, tShafts: { value: this.black },
      uRes: { value: new THREE.Vector2() }, uTime: { value: 0 },
      uExposure: { value: 1 }, uBloom: { value: 0.06 }, uShafts: { value: 0 }, uShaftColor: { value: new THREE.Color(1, 1, 1) },
      uVignette: { value: 0.55 }, uGrain: { value: 0.035 }, uCA: { value: 0.012 },
      uSaturation: { value: 1.0 }, uContrast: { value: 1.04 },
      uTintShadow: { value: new THREE.Color(0.96, 1.0, 1.03) }, uTintHigh: { value: new THREE.Color(1.03, 1.0, 0.96) },
      uDamage: { value: 0 }, uLowHealth: { value: 0 }, uFlash: { value: 0 }, uFlashColor: { value: new THREE.Color(1, 1, 1) }, uFade: { value: 1 },
    });
    this.post = this.matFinal.uniforms;

    this.rtScene = null; this.bloomRTs = []; this.shaftRTs = [];
    this.width = 1; this.height = 1; this.renderScale = 1; this.dynScale = 1;
    this.sunScreen = new THREE.Vector3();
    this.setQuality(qualityName);
  }

  setQuality(name) {
    this.qualityName = QUALITY[name] ? name : 'high';
    this.q = QUALITY[this.qualityName];
    this.resize(true);
  }

  resize(force = false) {
    const cssW = Math.max(1, this.canvas.clientWidth || window.innerWidth), cssH = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    const pr = Math.min(window.devicePixelRatio || 1, this.q.pixelRatio);
    const w = Math.max(2, Math.round(cssW * pr)), h = Math.max(2, Math.round(cssH * pr));
    if (!force && w === this.width && h === this.height) return false;
    this.width = w; this.height = h;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    this._alloc();
    return true;
  }

  _alloc() {
    const type = this.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
    const scale = this.q.scale * this.dynScale;
    const sw = Math.max(2, Math.round(this.width * scale)), sh = Math.max(2, Math.round(this.height * scale));
    this.sw = sw; this.sh = sh;
    if (this.rtScene) { this.rtScene.depthTexture?.dispose(); this.rtScene.dispose(); }
    this.bloomRTs.forEach(rt => rt.dispose()); this.shaftRTs.forEach(rt => rt.dispose());
    const samples = Math.min(this.q.msaa, this.maxSamples);
    this.rtScene = new THREE.WebGLRenderTarget(sw, sh, { type, format: THREE.RGBAFormat, colorSpace: THREE.LinearSRGBColorSpace, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true, stencilBuffer: false, samples });
    this.rtScene.depthTexture = new THREE.DepthTexture(sw, sh, THREE.UnsignedIntType);
    this.rtScene.depthTexture.minFilter = this.rtScene.depthTexture.magFilter = THREE.NearestFilter;
    this.rtScene.texture.generateMipmaps = false;
    const mkRT = (w, h) => {
      const rt = new THREE.WebGLRenderTarget(Math.max(2, w), Math.max(2, h), { type, format: THREE.RGBAFormat, colorSpace: THREE.LinearSRGBColorSpace, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false });
      rt.texture.generateMipmaps = false;
      return rt;
    };
    this.bloomRTs = [];
    let bw = sw >> 1, bh = sh >> 1;
    for (let i = 0; i < this.q.bloomMips && bw >= 4 && bh >= 4; i++) { this.bloomRTs.push({ down: mkRT(bw, bh), up: mkRT(bw, bh), dispose() { this.down.dispose(); this.up.dispose(); } }); bw >>= 1; bh >>= 1; }
    this.shaftRTs = this.q.shafts ? [mkRT(sw >> 2, sh >> 2), mkRT(sw >> 2, sh >> 2)] : [];
  }

  // Dynamic resolution: nudge the internal render scale to hold the frame rate.
  adapt(avgFrameMs) {
    let s = this.dynScale;
    if (avgFrameMs > 24 && s > 0.55) s = Math.max(0.55, s - 0.1);
    else if (avgFrameMs < 15 && s < 1) s = Math.min(1, s + 0.05);
    if (s !== this.dynScale) { this.dynScale = s; this._alloc(); }
  }

  _pass(material, target) {
    this.fsMesh.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.fsScene, this.fsCamera);
  }

  // scene/camera: the world. overlayScene/overlayCamera: the first-person weapon (optional).
  // opts: { time, sunDir (world, toward the light), shaftStrength, shaftColor }
  render(scene, camera, overlayScene, overlayCamera, opts = {}) {
    const r = this.renderer;
    r.info.reset();
    r.setRenderTarget(this.rtScene);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, false);
    r.render(scene, camera);
    if (overlayScene) {
      r.clearDepth();
      r.render(overlayScene, overlayCamera);
    }

    const u = this.post;
    u.tScene.value = this.rtScene.texture;
    u.uTime.value = opts.time || 0;
    u.uRes.value.set(this.width, this.height);

    // bloom: progressive downsample then tent-filtered upsample, blending as it climbs
    if (this.q.bloom && this.bloomRTs.length) {
      let src = this.rtScene.texture, sw = this.sw, sh = this.sh;
      for (let i = 0; i < this.bloomRTs.length; i++) {
        const rt = this.bloomRTs[i].down;
        this.matDown.uniforms.tSrc.value = src;
        this.matDown.uniforms.uTexel.value.set(1 / sw, 1 / sh);
        this.matDown.uniforms.uPrefilter.value = i === 0 ? 1 : 0;
        this._pass(this.matDown, rt);
        src = rt.texture; sw = rt.width; sh = rt.height;
      }
      let acc = this.bloomRTs[this.bloomRTs.length - 1].down;
      for (let i = this.bloomRTs.length - 2; i >= 0; i--) {
        const lvl = this.bloomRTs[i];
        this.matUp.uniforms.tSrc.value = acc.texture;
        this.matUp.uniforms.tAdd.value = lvl.down.texture;
        this.matUp.uniforms.uTexel.value.set(1 / acc.width, 1 / acc.height);
        this.matUp.uniforms.uMix.value = 0.62;
        this._pass(this.matUp, lvl.up);
        acc = lvl.up;
      }
      u.tBloom.value = acc.texture;
    } else {
      u.tBloom.value = this.black;
    }

    // sun shafts, only when the light is in front of the camera
    let shaft = 0;
    if (this.shaftRTs.length && opts.sunDir && (opts.shaftStrength || 0) > 0.001) {
      const p = this.sunScreen.copy(opts.sunDir).multiplyScalar(1000).add(camera.position).project(camera);
      const facing = camera.getWorldDirection(_v).dot(opts.sunDir);
      if (facing > 0.05 && Math.abs(p.x) < 1.6 && Math.abs(p.y) < 1.6) {
        const su = (p.x + 1) / 2, sv = (p.y + 1) / 2;
        shaft = opts.shaftStrength * clamp((facing - 0.05) * 3, 0, 1) * clamp(1.7 - Math.max(Math.abs(p.x), Math.abs(p.y)), 0, 1);
        const [a, b] = this.shaftRTs;
        this.matShaftMask.uniforms.tSrc.value = this.rtScene.texture;
        this.matShaftMask.uniforms.tDepth.value = this.rtScene.depthTexture;
        this.matShaftMask.uniforms.uSun.value.set(su, sv);
        this.matShaftMask.uniforms.uAspect.value = this.width / this.height;
        this._pass(this.matShaftMask, a);
        this.matShaftBlur.uniforms.uSun.value.set(su, sv);
        this.matShaftBlur.uniforms.tSrc.value = a.texture; this.matShaftBlur.uniforms.uStep.value = 0.045; this._pass(this.matShaftBlur, b);
        this.matShaftBlur.uniforms.tSrc.value = b.texture; this.matShaftBlur.uniforms.uStep.value = 0.02; this._pass(this.matShaftBlur, a);
        u.tShafts.value = a.texture;
        if (opts.shaftColor) u.uShaftColor.value.copy(opts.shaftColor);
      }
    }
    u.uShafts.value = shaft;
    if (shaft === 0) u.tShafts.value = this.black;

    this._pass(this.matFinal, null);
  }

  dispose() {
    this.rtScene?.dispose(); this.bloomRTs.forEach(rt => rt.dispose()); this.shaftRTs.forEach(rt => rt.dispose());
    this.renderer.dispose();
  }
}

const _v = new THREE.Vector3();
