import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// HDR pipeline:
//   scene → sceneRT (HalfFloat, MSAA, depth texture)
//   [hdrPasses]   optional HDR passes (god rays, AO, DOF …) ping-ponging through hdrA/hdrB
//   bloom         13-tap downsample chain + tent upsample (energy-preserving, firefly-safe)
//   final         exposure → bloom → ACES filmic → grade (lift/gamma/gain, saturation, split tone)
//                 → B&W cinema mode → vignette → ground shade → letterbox → grain → dither → sRGB

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const DOWNSAMPLE = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uFirst;
uniform float uThreshold;
uniform float uKnee;
varying vec2 vUv;
vec3 S(vec2 o) {
  vec3 c = texture2D(tSrc, vUv + o * uTexel).rgb;
  // a single NaN/Inf pixel would smear across the whole frame through the bloom chain
  if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
  return c;
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 karis(vec3 a, vec3 b, vec3 c, vec3 d) {
  float wa = 1.0 / (1.0 + luma(a)), wb = 1.0 / (1.0 + luma(b)), wc = 1.0 / (1.0 + luma(c)), wd = 1.0 / (1.0 + luma(d));
  return (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd);
}
void main() {
  vec3 a = S(vec2(-2.0, 2.0)), b = S(vec2(0.0, 2.0)), c = S(vec2(2.0, 2.0));
  vec3 d = S(vec2(-2.0, 0.0)), e = S(vec2(0.0, 0.0)), f = S(vec2(2.0, 0.0));
  vec3 g = S(vec2(-2.0, -2.0)), h = S(vec2(0.0, -2.0)), i = S(vec2(2.0, -2.0));
  vec3 j = S(vec2(-1.0, 1.0)), k = S(vec2(1.0, 1.0)), l = S(vec2(-1.0, -1.0)), m = S(vec2(1.0, -1.0));
  vec3 col;
  if (uFirst > 0.5) {
    col = karis(j, k, l, m) * 0.5
        + karis(a, b, d, e) * 0.125 + karis(b, c, e, f) * 0.125
        + karis(d, e, g, h) * 0.125 + karis(e, f, h, i) * 0.125;
    // soft-knee threshold keeps bloom to genuinely bright light
    float br = max(col.r, max(col.g, col.b));
    float rq = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
    rq = rq * rq / (4.0 * uKnee + 1e-4);
    col *= max(rq, br - uThreshold) / max(br, 1e-4);
    col = min(col, vec3(250.0));
  } else {
    col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

const UPSAMPLE = /* glsl */ `
uniform sampler2D tLow;
uniform sampler2D tHigh;
uniform vec2 uTexel;
uniform float uRadius;
varying vec2 vUv;
void main() {
  vec2 o = uTexel * uRadius;
  vec3 s = texture2D(tLow, vUv + vec2(-o.x, o.y)).rgb + texture2D(tLow, vUv + vec2(0.0, o.y)).rgb * 2.0
         + texture2D(tLow, vUv + vec2(o.x, o.y)).rgb + texture2D(tLow, vUv + vec2(-o.x, 0.0)).rgb * 2.0
         + texture2D(tLow, vUv).rgb * 4.0 + texture2D(tLow, vUv + vec2(o.x, 0.0)).rgb * 2.0
         + texture2D(tLow, vUv + vec2(-o.x, -o.y)).rgb + texture2D(tLow, vUv + vec2(0.0, -o.y)).rgb * 2.0
         + texture2D(tLow, vUv + vec2(o.x, -o.y)).rgb;
  gl_FragColor = vec4(texture2D(tHigh, vUv).rgb + s / 16.0, 1.0);
}
`;

// The film letterbox: bars that crop the frame to this ratio (2.39:1). filmBars(aspect) is the height of each bar, as a
// fraction of the frame (0.5 = closed), for a frame `aspect` wide (width / height); 0 on a frame already that wide.
// The final shader below draws exactly this at uLetterbox = 1, and the opening cinematic (actors/intro.js) opens its
// bars onto it: one ratio, one formula.
export const FILM_ASPECT = 2.39;
export function filmBars(aspect) {
  return Math.max(0, 0.5 - (0.5 * aspect) / FILM_ASPECT);
}

const FINAL = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tBloom;
uniform vec2 uResolution;
uniform float uExposure;
uniform float uBloomStrength;
uniform float uTime;
uniform float uSaturation;
uniform float uContrast;
uniform vec3 uLift;
uniform vec3 uGamma;
uniform vec3 uGain;
uniform vec3 uShadowTint;
uniform vec3 uHighlightTint;
uniform float uSplitStrength;
uniform float uVignette;
uniform float uGroundShade;
uniform float uGrain;
uniform float uLetterbox;
uniform float uBars;
uniform float uBW;
uniform float uCA;
uniform float uFade;
uniform float uWarmth;
varying vec2 vUv;

vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 ACESFilmic(vec3 color) {
  const mat3 ACESInputMat = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 ACESOutputMat = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  color = ACESInputMat * color;
  color = RRTAndODTFit(color);
  color = ACESOutputMat * color;
  return clamp(color, 0.0, 1.0);
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3 linearToSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

void main() {
  vec2 uv = vUv;
  vec3 hdr;
  if (uCA > 0.0) {
    vec2 d = (uv - 0.5) * uCA * 0.004;
    hdr = vec3(texture2D(tColor, uv + d).r, texture2D(tColor, uv).g, texture2D(tColor, uv - d).b);
  } else {
    hdr = texture2D(tColor, uv).rgb;
  }
  vec3 bloom = texture2D(tBloom, uv).rgb;
  vec3 c = (hdr + bloom * uBloomStrength) * uExposure;
  // scene warmth (dusk/cutscene grade): pushes the whole HDR image toward red-orange before tonemapping
  c *= vec3(1.0 + 0.15 * uWarmth, 1.0 - 0.12 * uWarmth, 1.0 - 0.3 * uWarmth);

  c = ACESFilmic(c / 0.6);

  // grade in display-linear space
  c = uGain * (c + uLift * (1.0 - c));
  c = pow(max(c, 0.0), 1.0 / uGamma);
  float l = luma(c);
  c = mix(vec3(l), c, uSaturation);
  // gentle S-curve contrast around mid grey
  c = clamp((c - 0.18) * uContrast + 0.18, 0.0, 1.0);
  l = luma(c);
  c += (uShadowTint - 0.5) * uSplitStrength * (1.0 - l) * (1.0 - l);
  c += (uHighlightTint - 0.5) * uSplitStrength * l * l;
  c = clamp(c, 0.0, 1.0);

  // black & white cinema mode (high contrast, lifted grain)
  if (uBW > 0.0) {
    float bw = luma(c);
    bw = smoothstep(0.02, 0.92, bw);
    bw = pow(bw, 1.12);
    c = mix(c, vec3(bw), uBW);
  }

  // vignette
  vec2 q = uv - 0.5;
  q.x *= uResolution.x / uResolution.y;
  float vig = 1.0 - uVignette * smoothstep(0.35, 1.05, length(q));
  c *= vig;
  // graduated shade over the lower frame (a grad filter): darkens the foreground below the subjects
  c *= 1.0 - uGroundShade * (1.0 - smoothstep(0.1, 0.45, uv.y));

  // film grain (luma-dependent, strongest in mid tones)
  float g = hash(uv * uResolution + fract(uTime * 7.31) * 173.0) - 0.5;
  float gl = luma(c);
  c += g * uGrain * (1.0 + uBW * 1.5) * (0.35 + gl * (1.0 - gl) * 2.2);

  // letterbox (the film ratio, FILM_ASPECT, at uLetterbox = 1: filmBars() above), or bars of an absolute height
  // whatever the aspect (uBars: a fraction of the frame per bar, 0.5 = closed; the opening cinematic) — the taller
  const float FILM_ASPECT = ${FILM_ASPECT.toFixed(2)};
  float barH = max(uLetterbox * max(0.0, 0.5 - 0.5 * (uResolution.x / uResolution.y) / FILM_ASPECT), uBars);
  float bars = step(barH, uv.y) * step(uv.y, 1.0 - barH);
  c *= bars;
  c *= (1.0 - uFade);

  c = linearToSRGB(clamp(c, 0.0, 1.0));
  // triangular dither: kills banding in the sky gradients
  float dn = hash(gl_FragCoord.xy + 0.37) + hash(gl_FragCoord.xy * 1.37 + 11.1) - 1.0;
  c += dn / 255.0;
  gl_FragColor = vec4(c, 1.0);
}
`;

function makeRT(w, h, opts = {}) {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: !!opts.depth,
    stencilBuffer: false,
    samples: opts.samples || 0,
    generateMipmaps: false,
  });
  rt.texture.colorSpace = THREE.NoColorSpace;
  if (opts.depthTexture) {
    rt.depthTexture = new THREE.DepthTexture(w, h, THREE.FloatType);
    rt.depthTexture.format = THREE.DepthFormat;
  }
  return rt;
}

export class PostFX {
  constructor(renderer, quality) {
    this.r = renderer; // core/Renderer
    this.quality = quality;
    this.hdrPasses = []; // { enabled, render(renderer, inputTexture, outputRT, ctx) }
    this.bloomLevels = 6;
    this.enabled = { bloom: quality.bloom };

    this.params = {
      exposure: 1.0,
      bloomStrength: 0.45,
      bloomThreshold: 2.0,
      bloomKnee: 0.8,
      bloomRadius: 1.0,
      saturation: 1.2,
      contrast: 1.1,
      lift: new THREE.Vector3(0.008, 0.003, 0.0),
      gamma: new THREE.Vector3(1.0, 1.0, 1.0),
      gain: new THREE.Vector3(1.03, 0.99, 0.93),
      // warm-brown shadows and golden highlights (golden-hour grade)
      shadowTint: new THREE.Vector3(0.52, 0.47, 0.44),
      highlightTint: new THREE.Vector3(0.62, 0.52, 0.4),
      splitStrength: 0.2,
      vignette: 0.35,
      groundShade: 0, // graduated shade of the lower frame, 0..1 (0 = off)
      grain: 0.028,
      letterbox: 0, // 1 = the film letterbox (FILM_ASPECT); its base is the player's setting (ui/settings.js)
      bars: 0, // bar height as a fraction of the frame, per bar, whatever the aspect (0.5 = black): cutscenes
      bw: 0,
      ca: 0.1,
      fade: 0,
      warmth: 0,
      godRays: 0.2, // light-shaft strength (render/Effects.js)
      dofAperture: 0, // 0 = depth of field off
      dofFocus: 12, // focus distance, meters
      dofMaxBlur: 10, // max blur radius, pixels at 1080p
    };

    // scalar defaults (shots/cutscenes override params temporarily and restore from here). The letterbox one is the
    // player's setting (ui/settings.js writes it): what borrows the letterbox (stand-off, kill cam) gives it back
    this.defaults = Object.fromEntries(Object.entries(this.params).filter(([, v]) => typeof v === 'number'));

    this.downMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: DOWNSAMPLE,
      uniforms: {
        tSrc: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uFirst: { value: 0 },
        uThreshold: { value: 1 },
        uKnee: { value: 0.5 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.upMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: UPSAMPLE,
      uniforms: {
        tLow: { value: null },
        tHigh: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uRadius: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
    });
    const p = this.params;
    this.finalMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FINAL,
      uniforms: {
        tColor: { value: null },
        tBloom: { value: null },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uExposure: { value: p.exposure },
        uBloomStrength: { value: p.bloomStrength },
        uTime: { value: 0 },
        uSaturation: { value: p.saturation },
        uContrast: { value: p.contrast },
        uLift: { value: p.lift },
        uGamma: { value: p.gamma },
        uGain: { value: p.gain },
        uShadowTint: { value: p.shadowTint },
        uHighlightTint: { value: p.highlightTint },
        uSplitStrength: { value: p.splitStrength },
        uVignette: { value: p.vignette },
        uGroundShade: { value: p.groundShade },
        uGrain: { value: p.grain },
        uLetterbox: { value: p.letterbox },
        uBars: { value: p.bars },
        uBW: { value: p.bw },
        uCA: { value: p.ca },
        uFade: { value: p.fade },
        uWarmth: { value: p.warmth },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(null);
    this.black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.black.needsUpdate = true;

    this._alloc();
    renderer.onResize(() => this._alloc());
  }

  _alloc() {
    const w = this.r.renderWidth, h = this.r.renderHeight;
    if (this.sceneRT && this.sceneRT.width === w && this.sceneRT.height === h) return;
    this._dispose();
    this.sceneRT = makeRT(w, h, { depth: true, samples: this.quality.msaa, depthTexture: true });
    this.hdrA = makeRT(w, h);
    this.hdrB = makeRT(w, h);
    this.down = [];
    this.up = [];
    let bw = Math.max(1, w >> 1), bh = Math.max(1, h >> 1);
    for (let i = 0; i < this.bloomLevels; i++) {
      this.down.push(makeRT(bw, bh));
      this.up.push(makeRT(bw, bh));
      bw = Math.max(1, bw >> 1);
      bh = Math.max(1, bh >> 1);
    }
  }

  _dispose() {
    const all = [this.sceneRT, this.hdrA, this.hdrB, ...(this.down || []), ...(this.up || [])];
    for (const rt of all) if (rt) rt.dispose();
  }

  get depthTexture() {
    return this.sceneRT.depthTexture;
  }

  addHDRPass(pass) {
    this.hdrPasses.push(pass);
    return pass;
  }

  _blit(mat, target) {
    this.quad.material = mat;
    this.r.renderer.setRenderTarget(target);
    this.quad.render(this.r.renderer);
  }

  // `time`: the clock that seeds the film grain (Game passes the wind clock, which a shot re-anchors)
  render(scene, camera, time = 0) {
    const renderer = this.r.renderer;
    renderer.setRenderTarget(this.sceneRT);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);

    // optional HDR passes
    let input = this.sceneRT.texture;
    let ping = this.hdrA, pong = this.hdrB;
    const ctx = { camera, depthTexture: this.sceneRT.depthTexture, time, width: this.sceneRT.width, height: this.sceneRT.height };
    for (const pass of this.hdrPasses) {
      if (pass.enabled === false) continue;
      pass.render(renderer, input, ping, ctx);
      input = ping.texture;
      [ping, pong] = [pong, ping];
    }

    // bloom
    let bloomTex = this.black;
    if (this.enabled.bloom) {
      const p = this.params;
      const dm = this.downMat.uniforms;
      let src = input, sw = this.sceneRT.width, sh = this.sceneRT.height;
      for (let i = 0; i < this.bloomLevels; i++) {
        dm.tSrc.value = src;
        dm.uTexel.value.set(1 / sw, 1 / sh);
        dm.uFirst.value = i === 0 ? 1 : 0;
        dm.uThreshold.value = p.bloomThreshold;
        dm.uKnee.value = p.bloomKnee;
        this._blit(this.downMat, this.down[i]);
        src = this.down[i].texture;
        sw = this.down[i].width;
        sh = this.down[i].height;
      }
      const um = this.upMat.uniforms;
      let low = this.down[this.bloomLevels - 1].texture;
      for (let i = this.bloomLevels - 2; i >= 0; i--) {
        um.tLow.value = low;
        um.tHigh.value = this.down[i].texture;
        um.uTexel.value.set(1 / this.down[i + 1].width, 1 / this.down[i + 1].height);
        um.uRadius.value = p.bloomRadius;
        this._blit(this.upMat, this.up[i]);
        low = this.up[i].texture;
      }
      bloomTex = low;
    }

    const fu = this.finalMat.uniforms;
    const p = this.params;
    fu.tColor.value = input;
    fu.tBloom.value = bloomTex;
    fu.uResolution.value.set(this.r.drawingWidth, this.r.drawingHeight);
    fu.uExposure.value = p.exposure;
    fu.uBloomStrength.value = this.enabled.bloom ? p.bloomStrength / this.bloomLevels : 0;
    fu.uTime.value = time;
    fu.uSaturation.value = p.saturation;
    fu.uContrast.value = p.contrast;
    fu.uSplitStrength.value = p.splitStrength;
    fu.uVignette.value = p.vignette;
    fu.uGroundShade.value = p.groundShade;
    fu.uGrain.value = p.grain;
    fu.uLetterbox.value = p.letterbox;
    fu.uBars.value = p.bars;
    fu.uBW.value = p.bw;
    fu.uCA.value = p.ca;
    fu.uFade.value = p.fade;
    fu.uWarmth.value = p.warmth;
    this._blit(this.finalMat, null);
  }
}
