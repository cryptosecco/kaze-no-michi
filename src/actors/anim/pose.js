import * as THREE from 'three';

// Pose authoring. A pose is { bones: { Name: Quaternion }, hips: Vector3 (offset from rest, model units),
// sword?: { p: Vector3, q: Quaternion } (katana frame in model space), ik?: { R, L } }.
// Angles are Euler XYZ in degrees, parent space (see rig/skeleton.js for sign conventions).
// Clips are sampled at a fixed rate into arrays so evaluation is cheap and allocation-free.

const D2R = Math.PI / 180;
const _e = new THREE.Euler();

export function Q(x = 0, y = 0, z = 0) {
  _e.set(x * D2R, y * D2R, z * D2R, 'XYZ');
  return new THREE.Quaternion().setFromEuler(_e);
}

// Build a pose from a spec. `base` supplies bones not listed. spec: { Bone: [x,y,z], hips: [dx,dy,dz], sword, ik }
export function pose(spec, base = null) {
  const out = { bones: {}, hips: new THREE.Vector3(), sword: null, ik: { R: 0, L: 0 } };
  if (base) {
    for (const k in base.bones) out.bones[k] = base.bones[k].clone();
    out.hips.copy(base.hips);
    if (base.sword) out.sword = { p: base.sword.p.clone(), q: base.sword.q.clone() };
    out.ik = { ...base.ik };
  }
  for (const k in spec) {
    const v = spec[k];
    if (k === 'hips') out.hips.set(v[0], v[1], v[2]);
    else if (k === 'sword') out.sword = v ? swordFrame(v) : null;
    else if (k === 'ik') out.ik = { ...out.ik, ...v };
    else out.bones[k] = Q(v[0], v[1], v[2]);
  }
  return out;
}

// Mirror helper: left-side angles → right side (negate Y and Z).
export function sym(name, v) {
  const r = name.replace('Left', 'Right');
  return { [name]: v, [r]: [v[0], -v[1], -v[2]] };
}

// Sword frame from grip point p (model space), blade direction d and edge direction e (orthonormalized).
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _m = new THREE.Matrix4();
export function swordFrame({ p, d, e }) {
  _y.set(d[0], d[1], d[2]).normalize();
  _z.set(e[0], e[1], e[2]);
  _z.addScaledVector(_y, -_z.dot(_y)).normalize();
  _x.crossVectors(_y, _z).normalize();
  _m.makeBasis(_x, _y, _z);
  return { p: new THREE.Vector3(p[0], p[1], p[2]), q: new THREE.Quaternion().setFromRotationMatrix(_m) };
}

const EASE = {
  linear: (t) => t,
  in: (t) => t * t * t,
  out: (t) => 1 - Math.pow(1 - t, 3),
  inout: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  sine: (t) => 0.5 - 0.5 * Math.cos(Math.PI * t),
  snap: (t) => 1 - Math.pow(1 - t, 5),
  hold: () => 0,
};

// A sampled clip: frames of { q: Float32Array(nBones*4), hips: Float32Array(3), sw: Float32Array(7)|null, ik: [R,L] }
export class Clip {
  constructor(name, duration, fps, loop) {
    this.name = name;
    this.duration = duration;
    this.fps = fps;
    this.loop = loop;
    this.frames = [];
    this.events = [];
    this.meta = {};
    this.hasSword = false;
  }
}

// Sample a pose-producing function f(t) → pose into a Clip. `bones` = rig bone names (order = rig.list).
export function sampleClip(name, duration, f, boneNames, { fps = 30, loop = false } = {}) {
  const clip = new Clip(name, duration, fps, loop);
  const n = Math.max(2, Math.round(duration * fps) + 1);
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * duration;
    const p = f(t, i / (n - 1));
    const q = new Float32Array(boneNames.length * 4);
    for (let b = 0; b < boneNames.length; b++) {
      const bq = p.bones[boneNames[b]];
      q[b * 4 + 3] = 1;
      if (bq) {
        q[b * 4] = bq.x;
        q[b * 4 + 1] = bq.y;
        q[b * 4 + 2] = bq.z;
        q[b * 4 + 3] = bq.w;
      }
    }
    let sw = null;
    if (p.sword) {
      clip.hasSword = true;
      sw = new Float32Array([p.sword.p.x, p.sword.p.y, p.sword.p.z, p.sword.q.x, p.sword.q.y, p.sword.q.z, p.sword.q.w]);
    }
    clip.frames.push({ q, hips: new Float32Array([p.hips.x, p.hips.y, p.hips.z]), sw, ik: [p.ik ? p.ik.R || 0 : 0, p.ik ? p.ik.L || 0 : 0] });
  }
  return clip;
}

// Keyframed clip: keys = [{ t, pose, ease }] (ease applies to the segment ending at this key).
// Sword positions use Catmull-Rom through the keys (smooth arcs), rotations slerp.
export function keyClip(name, keys, boneNames, { loop = false, fps = 30, events = [], meta = {} } = {}) {
  const duration = keys[keys.length - 1].t;
  const tmpQ = new THREE.Quaternion();
  const f = (t) => {
    let i = 0;
    while (i < keys.length - 2 && t > keys[i + 1].t) i++;
    const a = keys[i], b = keys[i + 1];
    const span = Math.max(1e-6, b.t - a.t);
    const raw = Math.min(1, Math.max(0, (t - a.t) / span));
    const k = (EASE[b.ease || 'inout'] || EASE.inout)(raw);
    const out = { bones: {}, hips: new THREE.Vector3(), sword: null, ik: { R: 0, L: 0 } };
    const names = new Set([...Object.keys(a.pose.bones), ...Object.keys(b.pose.bones)]);
    for (const nm of names) {
      const qa = a.pose.bones[nm] || tmpQ.identity(), qb = b.pose.bones[nm] || new THREE.Quaternion();
      out.bones[nm] = qa.clone().slerp(qb, k);
    }
    out.hips.lerpVectors(a.pose.hips, b.pose.hips, k);
    out.ik.R = a.pose.ik.R + (b.pose.ik.R - a.pose.ik.R) * k;
    out.ik.L = a.pose.ik.L + (b.pose.ik.L - a.pose.ik.L) * k;
    if (a.pose.sword && b.pose.sword) {
      const p0 = (keys[i - 1] && keys[i - 1].pose.sword ? keys[i - 1].pose.sword : a.pose.sword).p;
      const p3 = (keys[i + 2] && keys[i + 2].pose.sword ? keys[i + 2].pose.sword : b.pose.sword).p;
      out.sword = { p: catmull(p0, a.pose.sword.p, b.pose.sword.p, p3, k), q: a.pose.sword.q.clone().slerp(b.pose.sword.q, k) };
    } else if (a.pose.sword || b.pose.sword) out.sword = (k < 0.5 ? a.pose.sword : b.pose.sword) || null;
    return out;
  };
  const clip = sampleClip(name, duration, f, boneNames, { fps, loop });
  clip.events = events;
  clip.meta = meta;
  return clip;
}

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return new THREE.Vector3(f(p0.x, p1.x, p2.x, p3.x), f(p0.y, p1.y, p2.y, p3.y), f(p0.z, p1.z, p2.z, p3.z));
}

export { EASE };
