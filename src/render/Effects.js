import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { atmosphere } from './Atmosphere.js';
import { GLOBAL_UNIFORMS } from './globals.js';
import { drawnSunDir } from './drawnSun.js';

// HDR post passes plugged into PostFX.addHDRPass():
//   GodRays — screen-space light shafts: the sky seen around the sun (through trees, torii, grass plumes) is
//             radially smeared from the sun's screen position and added back (half resolution). They radiate from
//             the sun as drawn in the sky (a shot may lift its giant disc, Sky `sunLift`: render/drawnSun.js).
//   DepthOfField — thin-lens circle of confusion from the depth buffer + golden-angle gather blur (half res).
// Both read the scene depth, which is reversed-Z when EXT_clip_control is available (1 = near, 0 = far/sky).
// Params live in post.params: godRays (0..), dofAperture (0 = off), dofFocus (m), dofMaxBlur (px @1080p).

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const DEPTH_FN = /* glsl */ `
uniform float uReversed;
uniform float uNear;
uniform float uFar;
float kzLinearDepth(float d) {
  if (uReversed > 0.5) return uNear * uFar / (d * (uFar - uNear) + uNear);
  float z = d * 2.0 - 1.0;
  return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
}
bool kzIsSky(float d) { return uReversed > 0.5 ? d <= 1e-7 : d >= 0.9999999; }
`;

function halfRT(w, h, shift = 1) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w >> shift), Math.max(1, h >> shift), {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });
  rt.texture.colorSpace = THREE.NoColorSpace;
  return rt;
}

function mat(fragmentShader, uniforms) {
  return new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false });
}

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _sunD = new THREE.Vector3();
const _sunUv = new THREE.Vector2();

export class GodRays {
  constructor(post) {
    this.post = post;
    this.enabled = true;
    this.quad = new FullScreenQuad(null);
    const depthU = () => ({ uReversed: { value: post.r.reversedDepth ? 1 : 0 }, uNear: { value: 0.3 }, uFar: { value: 20000 } });
    this.maskMat = mat(
      /* glsl */ `
      ${DEPTH_FN}
      uniform sampler2D tColor;
      uniform sampler2D tDepth;
      uniform vec2 uSun;
      uniform float uAspect;
      varying vec2 vUv;
      void main() {
        float d = texture2D(tDepth, vUv).r;
        vec3 c = min(texture2D(tColor, vUv).rgb, vec3(8.0));
        vec2 dv = vUv - uSun;
        dv.x *= uAspect;
        // only sky near the sun emits (the rest of the sky is the ambient dome, not a light source)
        float fall = exp(-dot(dv, dv) * 12.0);
        gl_FragColor = vec4(kzIsSky(d) ? c * fall : vec3(0.0), 1.0);
      }`,
      { tColor: { value: null }, tDepth: { value: null }, uSun: { value: new THREE.Vector2() }, uAspect: { value: 1 }, ...depthU() }
    );
    this.blurMat = mat(
      /* glsl */ `
      uniform sampler2D tSrc;
      uniform vec2 uSun;
      uniform float uLength;
      varying vec2 vUv;
      const int N = 40;
      void main() {
        vec2 delta = (vUv - uSun) * uLength / float(N);
        vec2 uv = vUv;
        vec3 sum = vec3(0.0);
        float w = 1.0, wsum = 0.0;
        for (int i = 0; i < N; i++) {
          sum += texture2D(tSrc, uv).rgb * w;
          wsum += w;
          w *= 0.965;
          uv -= delta;
        }
        gl_FragColor = vec4(sum / wsum, 1.0);
      }`,
      { tSrc: { value: null }, uSun: { value: new THREE.Vector2() }, uLength: { value: 0.9 } }
    );
    this.compMat = mat(
      /* glsl */ `
      uniform sampler2D tColor;
      uniform sampler2D tRays;
      uniform vec3 uTint;
      uniform float uStrength;
      varying vec2 vUv;
      void main() {
        vec3 c = texture2D(tColor, vUv).rgb;
        vec3 r = texture2D(tRays, vUv).rgb;
        gl_FragColor = vec4(c + r * uTint * uStrength, 1.0);
      }`,
      { tColor: { value: null }, tRays: { value: null }, uTint: { value: new THREE.Color(1, 0.85, 0.62) }, uStrength: { value: 0 } }
    );
    this.rtA = null;
    this.rtB = null;
  }

  _alloc(w, h) {
    if (this.rtA && this.w === w && this.h === h) return;
    if (this.rtA) {
      this.rtA.dispose();
      this.rtB.dispose();
    }
    this.w = w;
    this.h = h;
    // light shafts are low-frequency: quarter resolution is plenty
    this.rtA = halfRT(w, h, 2);
    this.rtB = halfRT(w, h, 2);
  }

  _blit(material, target, renderer) {
    this.quad.material = material;
    renderer.setRenderTarget(target);
    this.quad.render(renderer);
  }

  // Where the shafts come from: the drawn sun's screen position (uv 0..1) into outUv; returns their visibility
  // (sun in front of the camera and near the frame). The fade with the sun's height is the light's, so it follows
  // the true sun even when a shot lifts the drawn disc.
  sunOnScreen(cam, outUv) {
    const trueSun = atmosphere.uniforms.uSunDir.value;
    const lift = GLOBAL_UNIFORMS.uSunLift ? GLOBAL_UNIFORMS.uSunLift.value : 0;
    const sunDir = drawnSunDir(trueSun, lift, _sunD);
    cam.getWorldDirection(_fwd);
    const facing = _fwd.dot(sunDir);
    _v.copy(sunDir).multiplyScalar(1000).add(cam.position).project(cam);
    outUv.set(_v.x * 0.5 + 0.5, _v.y * 0.5 + 0.5);
    const off = Math.max(Math.abs(_v.x), Math.abs(_v.y));
    return THREE.MathUtils.smoothstep(facing, 0.05, 0.45) * (1 - THREE.MathUtils.smoothstep(off, 1.3, 2.4)) * Math.min(1, trueSun.y * 12 + 0.2);
  }

  render(renderer, input, out, ctx) {
    const strength = this.post.params.godRays ?? 0.6;
    const cam = ctx.camera;
    const sun = _sunUv;
    const vis = this.sunOnScreen(cam, sun);
    if (strength <= 0 || vis <= 0.001) {
      // pass-through
      this.compMat.uniforms.tColor.value = input;
      this.compMat.uniforms.tRays.value = input;
      this.compMat.uniforms.uStrength.value = 0;
      this._blit(this.compMat, out, renderer);
      return;
    }
    this._alloc(ctx.width, ctx.height);
    const mu = this.maskMat.uniforms;
    mu.tColor.value = input;
    mu.tDepth.value = ctx.depthTexture;
    mu.uSun.value.copy(sun);
    mu.uAspect.value = ctx.width / ctx.height;
    mu.uNear.value = cam.near;
    mu.uFar.value = cam.far;
    this._blit(this.maskMat, this.rtA, renderer);
    // two chained radial blurs: long streaks without banding
    const bu = this.blurMat.uniforms;
    bu.uSun.value.copy(sun);
    bu.tSrc.value = this.rtA.texture;
    bu.uLength.value = 0.85;
    this._blit(this.blurMat, this.rtB, renderer);
    bu.tSrc.value = this.rtB.texture;
    bu.uLength.value = 0.22;
    this._blit(this.blurMat, this.rtA, renderer);
    const cu = this.compMat.uniforms;
    cu.tColor.value = input;
    cu.tRays.value = this.rtA.texture;
    cu.uStrength.value = strength * vis;
    const sc = atmosphere.uniforms.uSunColor.value;
    const m = Math.max(sc.r, sc.g, sc.b, 1e-3);
    cu.uTint.value.setRGB(sc.r / m, sc.g / m, sc.b / m);
    this._blit(this.compMat, out, renderer);
  }
}

export class DepthOfField {
  constructor(post) {
    this.post = post;
    this.quad = new FullScreenQuad(null);
    const depthU = () => ({ uReversed: { value: post.r.reversedDepth ? 1 : 0 }, uNear: { value: 0.3 }, uFar: { value: 20000 } });
    const cocFn = /* glsl */ `
      uniform float uFocus;
      uniform float uAperture;
      // signed circle of confusion (negative = foreground), 1 = max blur
      float kzCoc(float dist) {
        float c = (dist - uFocus) / max(dist, 0.01) * uAperture;
        return clamp(c, -1.0, 1.0);
      }`;
    this.prepMat = mat(
      /* glsl */ `
      ${DEPTH_FN}
      ${cocFn}
      uniform sampler2D tColor;
      uniform sampler2D tDepth;
      varying vec2 vUv;
      void main() {
        float d = texture2D(tDepth, vUv).r;
        float dist = kzIsSky(d) ? uFar : kzLinearDepth(d);
        gl_FragColor = vec4(texture2D(tColor, vUv).rgb, kzCoc(dist));
      }`,
      { tColor: { value: null }, tDepth: { value: null }, uFocus: { value: 10 }, uAperture: { value: 0 }, ...depthU() }
    );
    this.blurMat = mat(
      /* glsl */ `
      uniform sampler2D tSrc;
      uniform vec2 uTexel;
      uniform float uMaxBlur;
      varying vec2 vUv;
      const int N = 24;
      void main() {
        vec4 center = texture2D(tSrc, vUv);
        float rC = abs(center.a) * uMaxBlur;
        vec3 sum = center.rgb;
        float wsum = 1.0;
        float ga = 2.39996323;
        for (int i = 1; i < N; i++) {
          float fi = float(i);
          float r = sqrt(fi / float(N)) * uMaxBlur;
          vec2 o = vec2(cos(fi * ga), sin(fi * ga)) * r;
          vec4 s = texture2D(tSrc, vUv + o * uTexel);
          float rS = abs(s.a) * uMaxBlur;
          // a sample contributes if its own blur reaches this pixel; foreground (a<0) may spill over
          float reach = smoothstep(r - 1.0, r + 1.0, s.a < 0.0 ? rS : min(rS, rC + 1.0));
          sum += s.rgb * reach;
          wsum += reach;
        }
        gl_FragColor = vec4(sum / wsum, center.a);
      }`,
      { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uMaxBlur: { value: 8 } }
    );
    this.compMat = mat(
      /* glsl */ `
      ${DEPTH_FN}
      ${cocFn}
      uniform sampler2D tColor;
      uniform sampler2D tBlur;
      uniform sampler2D tDepth;
      varying vec2 vUv;
      void main() {
        float d = texture2D(tDepth, vUv).r;
        float dist = kzIsSky(d) ? uFar : kzLinearDepth(d);
        float coc = abs(kzCoc(dist));
        vec4 b = texture2D(tBlur, vUv);
        // foreground blur also bleeds over sharp background edges
        float amt = max(smoothstep(0.04, 0.28, coc), smoothstep(0.04, 0.28, -b.a));
        gl_FragColor = vec4(mix(texture2D(tColor, vUv).rgb, b.rgb, amt), 1.0);
      }`,
      { tColor: { value: null }, tBlur: { value: null }, tDepth: { value: null }, uFocus: { value: 10 }, uAperture: { value: 0 }, ...depthU() }
    );
    this.rtA = null;
    this.rtB = null;
  }

  // PostFX skips passes whose `enabled` is false: DOF only costs anything while an aperture is set
  get enabled() {
    return (this.post.params.dofAperture || 0) > 0;
  }

  _alloc(w, h) {
    if (this.rtA && this.w === w && this.h === h) return;
    if (this.rtA) {
      this.rtA.dispose();
      this.rtB.dispose();
    }
    this.w = w;
    this.h = h;
    this.rtA = halfRT(w, h);
    this.rtB = halfRT(w, h);
  }

  _blit(material, target, renderer) {
    this.quad.material = material;
    renderer.setRenderTarget(target);
    this.quad.render(renderer);
  }

  render(renderer, input, out, ctx) {
    const p = this.post.params;
    const cam = ctx.camera;
    this._alloc(ctx.width, ctx.height);
    const pu = this.prepMat.uniforms, cu = this.compMat.uniforms, bu = this.blurMat.uniforms;
    for (const u of [pu, cu]) {
      u.uFocus.value = p.dofFocus || 10;
      u.uAperture.value = p.dofAperture || 0;
      u.uNear.value = cam.near;
      u.uFar.value = cam.far;
      u.tDepth.value = ctx.depthTexture;
    }
    pu.tColor.value = input;
    this._blit(this.prepMat, this.rtA, renderer);
    bu.tSrc.value = this.rtA.texture;
    bu.uTexel.value.set(1 / this.rtA.width, 1 / this.rtA.height);
    bu.uMaxBlur.value = ((p.dofMaxBlur || 10) * (ctx.height / 1080)) / 2; // half-res pixels
    this._blit(this.blurMat, this.rtB, renderer);
    cu.tColor.value = input;
    cu.tBlur.value = this.rtB.texture;
    this._blit(this.compMat, out, renderer);
  }
}
