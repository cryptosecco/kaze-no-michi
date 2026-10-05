import * as THREE from 'three';
import { capeMap } from './gen/textures.js';
import { characterShading } from './gen/charShading.js';
import { smoothstep } from '../core/math.js';

// Verlet cloth cape pinned along the upper back (Spine2), tucked under the shoulder guards, colliding with body
// capsules and the scabbard, pushed by the wind field and by the wearer's motion. Rendered in world space.
//   new Cape(actor, opts)   opts (all optional):
//     color        outer cloth, sRGB hex (default '#1d2636', desaturated night blue: dark against a low sun)
//     lining       inner side, lighter (default '#2b303b'); shows wherever the cloth turns over in the wind
//     hem          worn, dusty band along the frayed hem (default '#6d665a')
//     length       m from the shoulders to the hem · topWidth / bottomWidth: m across the shoulders / at the hem
//                  (all before the actor's scale)
//     fray         0..1 ragged hem and side tears · seed: texture, fold pattern and ripple phase
//     windK        response to the wind · ripple: strength of the ripples running down the cloth (default 0.5)
//     skyFill      strength of the open-sky fill on the side turned away from the sun (default 13)
//     cols, rows   cloth resolution (default 13 × 21)
//   cape.windBias = THREE.Vector2 | null      extra world-XZ wind (a shot's cinematic cross-gust), scaled by the
//                                             gust front at the wearer (× 0.9 in a lull .. × 1.3 in a front)
//   cape.update(dt, { wind, groundY, time })  fixed-step; cape.warm(n, ctx) pre-simulates for stills
// Motion: the local wind presses on the cloth normal and drags it along the relative air velocity (the cape is
// carried toward the wind speed, never past it), the cloth's own normal velocity is damped (no single swinging
// mode), the push breathes slowly, and ripple trains run from the shoulders to the hem with zero mean, so the cape
// flutters continuously instead of swinging between two poses.

const G = -9.81;
// wind: pressure gain on the cloth normal, damping of the cloth's normal velocity (kills the single ~1 Hz swing of
// the free corner), drag on the relative air velocity along the cloth (lets a crosswind lift the cape out sideways)
const PRESSURE = 0.9, NORMAL_DAMP = 2.0, DRAG = 0.5;
const TAU = Math.PI * 2;
const _v = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _n = new THREE.Vector3();
const _w2 = new THREE.Vector2();

// ripple trains: [wavelength along the cloth (m), frequency (Hz), phase shift across the width (rad), weight]
const RIPPLES = [
  [0.95, 1.55, 2.4, 0.55],
  [0.52, 2.45, -3.3, 0.3],
  [0.31, 3.7, 5.1, 0.15],
];

export class Cape {
  constructor(actor, opts = {}) {
    this.actor = actor;
    const cols = (this.cols = opts.cols || 13);
    const rows = (this.rows = opts.rows || 21);
    const N = cols * rows;
    this.pos = new Float32Array(N * 3);
    this.prev = new Float32Array(N * 3);
    this.pinned = new Uint8Array(N);
    this.normals = new Float32Array(N * 3);
    this.length = opts.length || 1.12;
    this.windK = opts.windK ?? 1.0;
    this.ripple = opts.ripple ?? 0.5;
    this.seed = opts.seed || 3;
    this.windBias = null;
    this.extraCapsules = null; // [[A, B, r], …] world space, set by the riding module (src/actors/horse/Riding.js)
    const s = actor.rig.scale;
    // anchor arc behind the neck/upper back (model rest space), converted to Spine2-local offsets
    const sp2 = actor.rig.rest.Spine2;
    this.anchors = [];
    const tw = (opts.topWidth || 0.4) * s;
    for (let i = 0; i < cols; i++) {
      const u = i / (cols - 1) - 0.5;
      const x = u * tw;
      const z = (-0.13 + 0.09 * Math.pow(Math.abs(u) * 2, 2)) * s;
      const y = (1.455 - 0.03 * Math.pow(Math.abs(u) * 2, 2)) * s;
      this.anchors.push(new THREE.Vector3(x - sp2.x, y - sp2.y, z - sp2.z));
    }
    // rest shape (used for the initial state and bottom flare)
    this.bw = (opts.bottomWidth || 0.86) * s;
    this.tw = tw;
    this.dy = (this.length * s) / (rows - 1);
    // per-particle ripple terms: distance down the cloth (m), phase across it, amplitude (grows toward the free
    // hem and the free side edges)
    this.rD = new Float32Array(N);
    this.rU = new Float32Array(N);
    this.rAmp = new Float32Array(N);
    this.rLift = new Float32Array(N);
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const p = j * cols + i;
        const t = j / (rows - 1);
        const u = i / (cols - 1) - 0.5;
        this.rD[p] = t * this.length;
        this.rU[p] = u;
        this.rAmp[p] = Math.pow(t, 1.3) * (1 + 0.7 * Math.pow(Math.abs(u) * 2, 3));
        this.rLift[p] = t;
      }
    // constraints
    const C = [];
    const id = (i, j) => j * cols + i;
    // the cloth is cut wider than the shoulder span (top ×1.35): pinned at the anchors it gathers into pleats
    const tw0 = tw * 1.35;
    const restPos = (i, j) => {
      const u = i / (cols - 1) - 0.5;
      const t = j / (rows - 1);
      const w = tw0 + (this.bw - tw0) * Math.pow(t, 0.8);
      return new THREE.Vector3(u * w, -j * this.dy, -0.02 * j);
    };
    const add = (a, b, k) => C.push([a, b, restPos(a % cols, Math.floor(a / cols)).distanceTo(restPos(b % cols, Math.floor(b / cols))), k]);
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        if (i < cols - 1) add(id(i, j), id(i + 1, j), 1);
        if (j < rows - 1) add(id(i, j), id(i, j + 1), 1);
        if (i < cols - 1 && j < rows - 1) {
          add(id(i, j), id(i + 1, j + 1), 0.45);
          add(id(i + 1, j), id(i, j + 1), 0.45);
        }
        if (i < cols - 2) add(id(i, j), id(i + 2, j), 0.05);
        if (j < rows - 2) add(id(i, j), id(i, j + 2), 0.09);
      }
    this.C = C;
    this._restPos = restPos;
    for (let i = 0; i < cols; i++) this.pinned[id(i, 0)] = 1;

    // mesh
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    const uv = new Float32Array(N * 2);
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        uv[id(i, j) * 2] = i / (cols - 1);
        uv[id(i, j) * 2 + 1] = 1 - j / (rows - 1);
      }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const index = [];
    for (let j = 0; j < rows - 1; j++)
      for (let i = 0; i < cols - 1; i++) {
        const a = id(i, j), b = id(i + 1, j), c = id(i, j + 1), d = id(i + 1, j + 1);
        index.push(a, c, b, b, c, d);
      }
    geo.setIndex(index);
    const color = opts.color || '#1d2636';
    const tex = capeMap(color, this.seed, opts.fray ?? 1, opts.hem || '#6d665a');
    const outer = new THREE.Color(color);
    const inner = new THREE.Color(opts.lining || '#2b303b');
    this.material = characterShading(
      new THREE.MeshPhysicalMaterial({
        map: tex.map, normalMap: tex.normalMap, normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.9,
        sheen: 0.3, sheenRoughness: 0.5, sheenColor: inner.clone().lerp(new THREE.Color(0x8a8f9a), 0.35), side: THREE.DoubleSide, alphaTest: 0.5,
      }),
      // only a trace of the contre-jour rim: on a single sheet the fresnel rim lights the whole band where the cloth
      // wraps edge-on to the lens, so at the body's strength the side edge read as a pale stripe from the shoulder to
      // the hem (S2; in S5 it crossed the cape like a white scabbard) and the folds as stiff lit plates (S3)
      { rim: 0.06, fill: 0.38, rimTint: 0.35, trans: 0.05 }
    );
    // lining: the winding makes the front faces the inner side (their normals point at the wearer's back), so
    // front-facing fragments are re-tinted from the outer cloth to the lining (texture detail kept)
    this.liningTint = { value: new THREE.Vector3(inner.r / Math.max(outer.r, 1e-4), inner.g / Math.max(outer.g, 1e-4), inner.b / Math.max(outer.b, 1e-4)) };
    // open-sky fill: the side turned away from the low sun sees the cool sky opposite it, so the dark cloth reads
    // night blue in contre-jour instead of sinking into the warm grade's blacks. Its brightness follows the
    // sky zenith (shared uniform), its hue is fixed (see the shader).
    const sky = actor.game && actor.game.sky && actor.game.sky.uniforms;
    this.skyFill = sky && sky.uSkyZenith ? sky.uSkyZenith : { value: new THREE.Color(0.04, 0.16, 0.26) };
    this.skyFillK = { value: opts.skyFill ?? 13 };
    const shade = this.material.userData.onBeforeCompile;
    this.material.userData.shaderKey += '-cape';
    this.material.userData.onBeforeCompile = (shader) => {
      shade(shader);
      shader.uniforms.uCapeLining = this.liningTint;
      shader.uniforms.uCapeSky = this.skyFill;
      shader.uniforms.uCapeSkyK = this.skyFillK;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uCapeLining;\nuniform vec3 uCapeSky;\nuniform float uCapeSkyK;')
        .replace('#include <map_fragment>', '#include <map_fragment>\n\tif ( gl_FrontFacing ) diffuseColor.rgb *= uCapeLining;')
        .replace(
          '#include <opaque_fragment>',
          `#ifdef USE_FOG
{
  // smooth (unperturbed) normal: the folds show through the albedo, not as stripes of sky light
  vec3 cSunV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
  float cAway = saturate(0.4 - 0.6 * dot(nonPerturbedNormal, cSunV));
  float cUp = 0.55 + 0.45 * (vec4(nonPerturbedNormal, 0.0) * viewMatrix).y;
  // strongest looking into the sun; from the side the cloth stays dark
  float cBack = saturate(-dot(geometryViewDir, cSunV));
  // a golden-hour effect: gone once the sun is above ~25° (afternoon shade reads dark)
  float cLow = 1.0 - smoothstep(0.2, 0.42, uSunDir.y);
  // the sky's brightness in a fixed teal-blue (the ratios of the S1 zenith): the warm grade pulls dark tones toward
  // red, so a bluer sky (late afternoon) would turn the navy purple
  vec3 cSky = vec3(0.24, 1.19, 1.36) * dot(uCapeSky, vec3(0.2126, 0.7152, 0.0722));
  outgoingLight += diffuseColor.rgb * cSky * (uCapeSkyK * cLow * cAway * cUp * (0.1 + 0.9 * cBack * cBack * cBack));
}
#endif
#include <opaque_fragment>`
        );
    };
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'cape';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.reset();
  }

  _anchorWorld(i, out) {
    const sp2 = this.actor.rig.bones.Spine2;
    return out.copy(this.anchors[i]).applyMatrix4(sp2.matrixWorld);
  }

  reset() {
    const { cols, rows } = this;
    this.actor.root.updateMatrixWorld(true);
    const q = this.actor.root.getWorldQuaternion(new THREE.Quaternion());
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const k = (j * cols + i) * 3;
        this._anchorWorld(i, _a);
        const r = this._restPos(i, j);
        const top = this._restPos(i, 0);
        // alternating depth seeds the pleats deterministically
        const pleat = (i % 2 ? 1 : -1) * 0.035 * Math.min(1, j / 3);
        _v.set((r.x - top.x) * 0.8, r.y, r.z - pleat).applyQuaternion(q).add(_a);
        this.pos[k] = this.prev[k] = _v.x;
        this.pos[k + 1] = this.prev[k + 1] = _v.y;
        this.pos[k + 2] = this.prev[k + 2] = _v.z;
      }
    this._writeMesh();
  }

  // Collision capsules [A, B, r] in world space: torso, legs, upper arms and the scabbard. The shoulder guards
  // are left out on purpose: the cape is tied under them, so they read over it.
  _capsules() {
    const b = this.actor.rig.bones;
    const s = this.actor.rig.scale;
    const P = (name) => b[name].getWorldPosition(new THREE.Vector3());
    const list = [
      [P('Hips'), P('Spine2'), 0.2 * s],
      [P('Spine2'), P('Neck'), 0.19 * s],
      [P('LeftUpLeg'), P('LeftLeg'), 0.2 * s],
      [P('RightUpLeg'), P('RightLeg'), 0.2 * s],
      [P('LeftLeg'), P('LeftFoot'), 0.19 * s],
      [P('RightLeg'), P('RightFoot'), 0.19 * s],
      [P('LeftArm'), P('LeftForeArm'), 0.1 * s],
      [P('RightArm'), P('RightForeArm'), 0.1 * s],
    ];
    const saya = this.actor.saya;
    if (saya) {
      // scabbard frame: body along +Y from the mouth (0.13) to the chape (~0.86), see gen/weapons.js
      saya.updateMatrixWorld(true);
      list.push([new THREE.Vector3(0, 0.2, 0).applyMatrix4(saya.matrixWorld), new THREE.Vector3(0, 0.86, -0.02).applyMatrix4(saya.matrixWorld), 0.04]);
    }
    // world-space capsules of something the wearer sits on (the horse's back while riding)
    if (this.extraCapsules) for (const c of this.extraCapsules) list.push(c);
    return list;
  }

  update(dt, ctx) {
    // a paused game steps with dt = 0: hold still (the air-velocity terms below divide by the step, and Verlet
    // would otherwise keep drifting on the stored velocity)
    if (!(dt > 0)) return;
    const sub = 2;
    const h = dt / sub;
    const { cols, rows, pos, prev, normals } = this;
    const N = cols * rows;
    const t0 = ctx.time || 0;
    const caps = this._capsules();
    const groundY = ctx.groundY ?? -1e9;
    const damp = 0.986;
    const K = 11 * this.windK;
    const seed = this.seed;
    // a shot's cinematic cross-gust rises and falls with the gust front at the wearer (the local wind.sample at
    // the actor): the cape flies out as the front reaches him, together with the grass and plumes around him,
    // and eases a little in the lull behind it (about the bias itself on average)
    let bx = 0, bz = 0;
    if (this.windBias && ctx.wind) {
      const ap = this.actor.root.position;
      const gn = smoothstep(0.26, 0.95, ctx.wind.sample(ap.x, ap.z, _w2).length());
      const k = 0.9 + 0.4 * gn;
      bx = this.windBias.x * k;
      bz = this.windBias.y * k;
    }
    for (let s = 0; s < sub; s++) {
      const t = t0 + s * h;
      // the push breathes slowly (the travelling gust fronts already come with wind.sample)
      const breathe = 1 + 0.12 * Math.sin(t * 0.83 + seed) + 0.07 * Math.sin(t * 2.07 + 1.3 * seed);
      // pinned anchors follow the body
      for (let i = 0; i < cols; i++) {
        this._anchorWorld(i, _a);
        const k = i * 3;
        prev[k] = pos[k];
        prev[k + 1] = pos[k + 1];
        prev[k + 2] = pos[k + 2];
        pos[k] = _a.x;
        pos[k + 1] = _a.y;
        pos[k + 2] = _a.z;
      }
      // integrate
      for (let p = cols; p < N; p++) {
        const k = p * 3;
        const x = pos[k], y = pos[k + 1], z = pos[k + 2];
        const dx = x - prev[k], dy = y - prev[k + 1], dz = z - prev[k + 2];
        let ax = 0, ay = G, az = 0;
        if (ctx.wind) {
          ctx.wind.sample(x, z, _w2);
          _w2.x += bx;
          _w2.y += bz;
          const wx = _w2.x * K * breathe, wz = _w2.y * K * breathe;
          const wm = Math.hypot(wx, wz);
          // wind pressure on the cloth normal (it sails), damped by the cloth's own normal velocity, plus drag on
          // the relative air velocity (still air vertically)
          const vx = dx / h, vy = dy / h, vz = dz / h;
          const rx = wx - vx, ry = -vy, rz = wz - vz;
          const nx = normals[k], ny = normals[k + 1], nz = normals[k + 2];
          const dn = PRESSURE * (wx * nx + wz * nz) - NORMAL_DAMP * (vx * nx + vy * ny + vz * nz);
          ax += nx * dn + rx * DRAG;
          ay += ny * dn + ry * DRAG + wm * 0.12 * this.rLift[p];
          az += nz * dn + rz * DRAG;
          // ripples: zero-mean pressure waves running down the cloth toward the hem
          const d = this.rD[p], u = this.rU[p];
          let r = 0;
          for (let q = 0; q < RIPPLES.length; q++) {
            const R = RIPPLES[q];
            r += R[3] * Math.sin(TAU * (d / R[0] - R[1] * t) + R[2] * u + seed);
          }
          const f = wm * this.ripple * this.rAmp[p] * r;
          ax += nx * f;
          ay += ny * f;
          az += nz * f;
        }
        prev[k] = x;
        prev[k + 1] = y;
        prev[k + 2] = z;
        pos[k] = x + dx * damp + ax * h * h;
        pos[k + 1] = y + dy * damp + ay * h * h;
        pos[k + 2] = z + dz * damp + az * h * h;
      }
      // constraints
      for (let it = 0; it < 6; it++) {
        for (const [a, b, rest, stiff] of this.C) {
          const ka = a * 3, kb = b * 3;
          const dx = pos[kb] - pos[ka], dy = pos[kb + 1] - pos[ka + 1], dz = pos[kb + 2] - pos[ka + 2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
          const diff = ((d - rest) / d) * stiff;
          const pa = this.pinned[a], pb = this.pinned[b];
          if (pa && pb) continue;
          const wa = pa ? 0 : pb ? 1 : 0.5, wb = pb ? 0 : pa ? 1 : 0.5;
          pos[ka] += dx * diff * wa;
          pos[ka + 1] += dy * diff * wa;
          pos[ka + 2] += dz * diff * wa;
          pos[kb] -= dx * diff * wb;
          pos[kb + 1] -= dy * diff * wb;
          pos[kb + 2] -= dz * diff * wb;
        }
        // collisions (every other iteration is enough)
        if (it % 2 === 1)
          for (let p = cols; p < N; p++) {
            const k = p * 3;
            for (const [A, B, r] of caps) {
              _v.set(pos[k], pos[k + 1], pos[k + 2]);
              _a.subVectors(B, A);
              const l2 = _a.lengthSq();
              let tt = l2 > 0 ? _b.subVectors(_v, A).dot(_a) / l2 : 0;
              tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
              _b.copy(A).addScaledVector(_a, tt);
              _n.subVectors(_v, _b);
              const d = _n.length();
              if (d < r && d > 1e-6) {
                _n.multiplyScalar((r - d) / d);
                pos[k] += _n.x;
                pos[k + 1] += _n.y;
                pos[k + 2] += _n.z;
              }
            }
            if (pos[k + 1] < groundY + 0.03) pos[k + 1] = groundY + 0.03;
          }
      }
    }
    this._writeMesh();
  }

  warm(steps, ctx) {
    for (let i = 0; i < steps; i++) this.update(1 / 60, { ...ctx, time: (ctx.time || 0) - (steps - i) / 60 });
  }

  _writeMesh() {
    const geo = this.mesh.geometry;
    geo.attributes.position.array.set(this.pos);
    geo.attributes.position.needsUpdate = true;
    geo.computeVertexNormals();
    this.normals.set(geo.attributes.normal.array);
  }
}
