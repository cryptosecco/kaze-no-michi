import * as THREE from 'three';
import { boneSegment } from './skeleton.js';

// Skin weights for procedurally built geometry (model space, rest T-pose).
//   autoSkin(geo, rig, ['Hips','LeftUpLeg','LeftLeg'])      smooth inverse-distance weights to bone segments
//   rigidSkin(geo, rig, 'Head')                              every vertex 100% on one bone
//   gradientSkin(geo, rig, a, b, fn)                         weight of b = fn(vertex) (0..1), rest on a
// Geometries are later merged; each one carries skinIndex/skinWeight attributes.

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _p = new THREE.Vector3(), _ab = new THREE.Vector3();

function segDist(p, a, b) {
  _ab.subVectors(b, a);
  const l2 = _ab.lengthSq();
  let t = l2 > 0 ? _p.subVectors(p, a).dot(_ab) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = a.x + _ab.x * t - p.x, dy = a.y + _ab.y * t - p.y, dz = a.z + _ab.z * t - p.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function writeWeights(geo, idx, wts) {
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wts, 4));
  return geo;
}

export function autoSkin(geo, rig, candidates, { power = 4, bias = {} } = {}) {
  const pos = geo.attributes.position;
  const n = pos.count;
  const idx = new Uint16Array(n * 4), wts = new Float32Array(n * 4);
  const segs = candidates.map((name) => {
    const [a, b] = boneSegment(rig, name, new THREE.Vector3(), new THREE.Vector3());
    return { name, a, b, i: rig.index[name], k: bias[name] ?? 1 };
  });
  const tmp = segs.map(() => ({ i: 0, w: 0 }));
  const v = new THREE.Vector3();
  for (let vi = 0; vi < n; vi++) {
    v.fromBufferAttribute(pos, vi);
    for (let s = 0; s < segs.length; s++) {
      const d = segDist(v, segs[s].a, segs[s].b) + 1e-3;
      tmp[s].i = segs[s].i;
      tmp[s].w = segs[s].k / Math.pow(d, power);
    }
    tmp.sort((x, y) => y.w - x.w);
    let sum = 0;
    for (let k = 0; k < 4 && k < tmp.length; k++) sum += tmp[k].w;
    for (let k = 0; k < 4; k++) {
      const e = tmp[k];
      idx[vi * 4 + k] = e ? e.i : 0;
      wts[vi * 4 + k] = e ? e.w / sum : 0;
    }
  }
  return writeWeights(geo, idx, wts);
}

export function rigidSkin(geo, rig, bone) {
  const n = geo.attributes.position.count;
  const idx = new Uint16Array(n * 4), wts = new Float32Array(n * 4);
  const bi = rig.index[bone];
  for (let i = 0; i < n; i++) {
    idx[i * 4] = bi;
    wts[i * 4] = 1;
  }
  return writeWeights(geo, idx, wts);
}

// Two-bone blend, weight of `b` given per vertex by fn(position) in 0..1.
export function gradientSkin(geo, rig, a, b, fn) {
  const pos = geo.attributes.position;
  const n = pos.count;
  const idx = new Uint16Array(n * 4), wts = new Float32Array(n * 4);
  const ia = rig.index[a], ib = rig.index[b];
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, i);
    const t = Math.min(1, Math.max(0, fn(v)));
    idx[i * 4] = ia;
    idx[i * 4 + 1] = ib;
    wts[i * 4] = 1 - t;
    wts[i * 4 + 1] = t;
  }
  return writeWeights(geo, idx, wts);
}

// Paint a constant vertex color on a geometry (merged meshes use vertex colors to tint shared materials).
export function paint(geo, color) {
  const c = color instanceof THREE.Color ? color : new THREE.Color(color);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  return geo;
}

// Multiply existing vertex colors by fn(position) → scalar (ambient occlusion, dirt at hems…).
export function shadeVerts(geo, fn) {
  const pos = geo.attributes.position, col = geo.attributes.color;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const k = fn(v);
    col.setXYZ(i, col.getX(i) * k, col.getY(i) * k, col.getZ(i) * k);
  }
  return geo;
}
