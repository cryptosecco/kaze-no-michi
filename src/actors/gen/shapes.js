import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Geometry builders for procedural characters. All output indexed BufferGeometry with position/normal/uv.
//   loft(rings, opts)            tube through elliptical rings (limbs, torso, trousers, handles)
//   thickSurface(fn, su, sv, t)   parametric surface with thickness (armor plates, hat brims, blades)
//   lathe(profile, seg, opts)     surface of revolution around Y with meter-based UVs
//   ellipsoid(c, r, ws, hs)       scaled sphere

const V = (a) => (a instanceof THREE.Vector3 ? a : new THREE.Vector3(a[0], a[1], a[2]));

// rings: [{ c:[x,y,z], ax:[..], ay:[..], rx, ry, fn?(theta, t) → radius multiplier }]
// opts: { seg=16, tile=0.25 (meters per texture repeat), capStart, capEnd, u0=0 }
// opts.uRange / opts.vRange: map u (around) / v (along) linearly into a fixed range (texture atlases).
export function loft(rings, opts = {}) {
  const seg = opts.seg || 16;
  const tile = opts.tile || 0.25;
  const pos = [], uv = [], index = [];
  const R = rings.map((r) => ({ c: V(r.c), ax: V(r.ax || [1, 0, 0]).normalize(), ay: V(r.ay || [0, 0, 1]).normalize(), rx: r.rx, ry: r.ry ?? r.rx, fn: r.fn }));
  const n = R.length;
  // winding: outward normals need (ax × ay) pointing against the loft direction
  const dir = R[n - 1].c.clone().sub(R[0].c);
  const flip = new THREE.Vector3().crossVectors(R[0].ax, R[0].ay).dot(dir) > 0;
  let total = 0;
  for (let i = 1; i < n; i++) total += R[i - 1].c.distanceTo(R[i].c);
  let vAcc = 0;
  let prevC = null;
  for (let i = 0; i < n; i++) {
    const r = R[i];
    if (prevC) vAcc += prevC.distanceTo(r.c);
    prevC = r.c;
    const circ = Math.PI * (3 * (r.rx + r.ry) - Math.sqrt((3 * r.rx + r.ry) * (r.rx + 3 * r.ry)));
    for (let j = 0; j <= seg; j++) {
      const th = (j / seg) * Math.PI * 2 + (opts.phase || 0);
      const m = r.fn ? r.fn(th, i / Math.max(1, n - 1)) : 1;
      const cx = Math.cos(th) * r.rx * m, cy = Math.sin(th) * r.ry * m;
      pos.push(r.c.x + r.ax.x * cx + r.ay.x * cy, r.c.y + r.ax.y * cx + r.ay.y * cy, r.c.z + r.ax.z * cx + r.ay.z * cy);
      const u = opts.uRange ? opts.uRange[0] + (opts.uRange[1] - opts.uRange[0]) * (j / seg) : (opts.u0 || 0) + ((j / seg) * circ) / tile;
      const v = opts.vRange ? opts.vRange[0] + (opts.vRange[1] - opts.vRange[0]) * (total > 0 ? vAcc / total : 0) : vAcc / tile;
      uv.push(u, v);
    }
  }
  const row = seg + 1;
  for (let i = 0; i < n - 1; i++)
    for (let j = 0; j < seg; j++) {
      const a = i * row + j, b = a + 1, c = a + row, d = c + 1;
      if (flip) index.push(a, b, c, b, d, c);
      else index.push(a, c, b, b, c, d);
    }
  const addCap = (ri, sgn) => {
    const r = R[ri];
    const center = pos.length / 3;
    pos.push(r.c.x, r.c.y, r.c.z);
    uv.push(opts.uRange ? opts.uRange[0] : 0, opts.vRange ? opts.vRange[ri ? 1 : 0] : 0);
    for (let j = 0; j < seg; j++) {
      const a = ri * row + j, b = a + 1;
      if (sgn > 0) index.push(center, b, a);
      else index.push(center, a, b);
    }
  };
  if (opts.capStart) addCap(0, flip ? 1 : -1);
  if (opts.capEnd) addCap(n - 1, flip ? -1 : 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  weldSeamNormals(g, n, row);
  return g;
}

// Average normals across the UV seam of a lofted tube (j = 0 and j = seg share a position).
function weldSeamNormals(g, rows, row) {
  const nor = g.attributes.normal;
  for (let i = 0; i < rows; i++) {
    const a = i * row, b = i * row + row - 1;
    const x = nor.getX(a) + nor.getX(b), y = nor.getY(a) + nor.getY(b), z = nor.getZ(a) + nor.getZ(b);
    const l = Math.hypot(x, y, z) || 1;
    nor.setXYZ(a, x / l, y / l, z / l);
    nor.setXYZ(b, x / l, y / l, z / l);
  }
}

// Parametric surface fn(u, v, outVec3) over [0,1]², thickened along its normal (front + back + rim).
// opts: { thickness, uTile, vTile (meters→uv scale), backColorScale }
export function thickSurface(fn, su, sv, opts = {}) {
  const t = opts.thickness ?? 0.01;
  const P = [];
  const tmp = new THREE.Vector3();
  for (let j = 0; j <= sv; j++)
    for (let i = 0; i <= su; i++) {
      fn(i / su, j / sv, tmp);
      P.push(tmp.clone());
    }
  const idx = (i, j) => j * (su + 1) + i;
  // normals by central differences
  const N = P.map((_, k) => {
    const i = k % (su + 1), j = Math.floor(k / (su + 1));
    const pu = P[idx(Math.min(su, i + 1), j)].clone().sub(P[idx(Math.max(0, i - 1), j)]);
    const pv = P[idx(i, Math.min(sv, j + 1))].clone().sub(P[idx(i, Math.max(0, j - 1))]);
    const nn = new THREE.Vector3().crossVectors(pu, pv);
    return nn.lengthSq() > 0 ? nn.normalize() : new THREE.Vector3(0, 0, 1);
  });
  const pos = [], nor = [], uv = [], index = [];
  const push = (p, n, u, v) => {
    pos.push(p.x, p.y, p.z);
    nor.push(n.x, n.y, n.z);
    uv.push(u, v);
    return pos.length / 3 - 1;
  };
  const uS = opts.uScale ?? 1, vS = opts.vScale ?? 1;
  const front = [], back = [];
  for (let k = 0; k < P.length; k++) {
    const i = k % (su + 1), j = Math.floor(k / (su + 1));
    front.push(push(P[k].clone().addScaledVector(N[k], t / 2), N[k], (i / su) * uS, (j / sv) * vS));
  }
  for (let k = 0; k < P.length; k++) {
    const i = k % (su + 1), j = Math.floor(k / (su + 1));
    back.push(push(P[k].clone().addScaledVector(N[k], -t / 2), N[k].clone().negate(), (i / su) * uS, (j / sv) * vS));
  }
  for (let j = 0; j < sv; j++)
    for (let i = 0; i < su; i++) {
      const a = idx(i, j), b = idx(i + 1, j), c = idx(i, j + 1), d = idx(i + 1, j + 1);
      index.push(front[a], front[b], front[c], front[b], front[d], front[c]);
      index.push(back[a], back[c], back[b], back[b], back[c], back[d]);
    }
  if (t > 0) {
    // rim: four borders
    const border = [];
    for (let i = 0; i <= su; i++) border.push(idx(i, 0));
    for (let j = 1; j <= sv; j++) border.push(idx(su, j));
    for (let i = su - 1; i >= 0; i--) border.push(idx(i, sv));
    for (let j = sv - 1; j >= 1; j--) border.push(idx(0, j));
    for (let k = 0; k < border.length; k++) {
      const a = border[k], b = border[(k + 1) % border.length];
      const e = P[b].clone().sub(P[a]);
      const out = new THREE.Vector3().crossVectors(e, N[a]).normalize();
      const fa = push(P[a].clone().addScaledVector(N[a], t / 2), out, 0, 0);
      const fb = push(P[b].clone().addScaledVector(N[b], t / 2), out, 0.02, 0);
      const ba = push(P[a].clone().addScaledVector(N[a], -t / 2), out, 0, 0.02);
      const bb = push(P[b].clone().addScaledVector(N[b], -t / 2), out, 0.02, 0.02);
      index.push(fa, ba, fb, fb, ba, bb);
    }
  }
  if (opts.flipNormal) {
    // the surface was built with N = ∂u × ∂v; flip normals and winding together so they stay consistent
    for (let i = 0; i < nor.length; i++) nor[i] = -nor[i];
    for (let i = 0; i < index.length; i += 3) {
      const tmpI = index[i + 1];
      index[i + 1] = index[i + 2];
      index[i + 2] = tmpI;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  return g;
}

// Remap a geometry's uv attribute: fn(u, v) → [u', v'].
export function remapUV(g, fn) {
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    const [a, b] = fn(uv.getX(i), uv.getY(i));
    uv.setXY(i, a, b);
  }
  return g;
}

// Set every uv to one point (samples a flat color region of a texture: skin on the face map, etc.).
export function flatUV(g, u, v) {
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u, v);
  return g;
}

// Surface of revolution. profile: [[r, y], ...] from top to bottom (or any order); UV u around, v along.
export function lathe(profile, seg = 24, opts = {}) {
  const pts = profile.map((p) => new THREE.Vector2(p[0], p[1]));
  const g = new THREE.LatheGeometry(pts, seg, opts.phiStart || 0, opts.phiLength || Math.PI * 2);
  if (opts.uRepeat || opts.vRepeat) {
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (opts.uRepeat || 1), uv.getY(i) * (opts.vRepeat || 1));
  }
  return g;
}

export function ellipsoid(c, r, ws = 16, hs = 12) {
  const g = new THREE.SphereGeometry(1, ws, hs);
  g.scale(r[0], r[1], r[2]);
  g.translate(c[0], c[1], c[2]);
  return g;
}

export function box(c, s, rotY = 0) {
  const g = new THREE.BoxGeometry(s[0], s[1], s[2]);
  if (rotY) g.rotateY(rotY);
  g.translate(c[0], c[1], c[2]);
  return g;
}

// Ensure every geometry has the same attribute set before merging (color, skin attributes).
export function mergeParts(parts) {
  const want = ['position', 'normal', 'uv', 'color', 'skinIndex', 'skinWeight'];
  const clean = parts.map((g) => {
    let q = g.index ? g : g;
    for (const k of Object.keys(q.attributes)) if (!want.includes(k)) q.deleteAttribute(k);
    if (!q.attributes.color) {
      const arr = new Float32Array(q.attributes.position.count * 3).fill(1);
      q.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
    }
    if (!q.index) {
      const n = q.attributes.position.count;
      const idx = [];
      for (let i = 0; i < n; i++) idx.push(i);
      q.setIndex(idx);
    }
    return q;
  });
  return mergeGeometries(clean, false);
}

// Transform helper: apply a matrix built from position / euler(deg) / scale to a geometry.
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
export function place(g, p = [0, 0, 0], rDeg = [0, 0, 0], s = [1, 1, 1]) {
  _e.set((rDeg[0] * Math.PI) / 180, (rDeg[1] * Math.PI) / 180, (rDeg[2] * Math.PI) / 180, 'XYZ');
  _q.setFromEuler(_e);
  _m.compose(new THREE.Vector3(p[0], p[1], p[2]), _q, new THREE.Vector3(s[0], s[1], s[2]));
  g.applyMatrix4(_m);
  return g;
}
