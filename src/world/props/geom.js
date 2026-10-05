import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// Geometry toolkit for the props: primitives with metric UVs (grain-aware), vertex-colour weathering,
// and a Builder that merges everything per material into a handful of static meshes (few draw calls).

const KEEP = new Set(['position', 'normal', 'uv', 'color', 'aFlag']);
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();

export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// deterministic UV offsets (captures must be reproducible run to run)
const UVR = rng(90210);

// Normalise a geometry so every piece in a bucket merges: indexed, same attribute set.
export function finalize(geo, { flag = false } = {}) {
  const n = geo.getAttribute('position').count;
  if (!geo.index) {
    const idx = new (n > 65535 ? Uint32Array : Uint16Array)(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  for (const k of Object.keys(geo.attributes)) if (!KEEP.has(k)) geo.deleteAttribute(k);
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  if (!geo.getAttribute('uv')) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  if (!geo.getAttribute('color')) geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  if (flag && !geo.getAttribute('aFlag')) geo.setAttribute('aFlag', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  if (!flag && geo.getAttribute('aFlag')) geo.deleteAttribute('aFlag');
  geo.morphAttributes = {};
  geo.clearGroups();
  return geo;
}

// Metric planar UVs chosen per vertex from the dominant normal axis; `grain` names the local axis that
// maps to u wherever possible (so wood grain / tile rows follow the member).
export function planarUV(geo, grain = 'x', scale = 1, offset = [0, 0]) {
  const p = geo.getAttribute('position'), nm = geo.getAttribute('normal');
  const uv = new Float32Array(p.count * 2);
  const ax = { x: 0, y: 1, z: 2 };
  const g = ax[grain];
  for (let i = 0; i < p.count; i++) {
    const c = [p.getX(i), p.getY(i), p.getZ(i)];
    const n = [Math.abs(nm.getX(i)), Math.abs(nm.getY(i)), Math.abs(nm.getZ(i))];
    const a = n[0] > n[1] && n[0] > n[2] ? 0 : n[1] > n[2] ? 1 : 2;
    const others = [0, 1, 2].filter((k) => k !== a);
    let u, v;
    if (others.includes(g)) {
      u = c[g];
      v = c[others.find((k) => k !== g)];
    } else {
      u = c[others[0]];
      v = c[others[1]];
    }
    uv[i * 2] = u * scale + offset[0];
    uv[i * 2 + 1] = v * scale + offset[1];
  }
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return geo;
}

// Stone block with softly rounded edges (catches a thin highlight on every arris, reads as dressed stone).
export function rbox(w, h, d, { r = 0.035, grain = 'x', uv = 1 } = {}) {
  const g = new RoundedBoxGeometry(w, h, d, 1, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3));
  return planarUV(g, grain, uv, [UVR() * 7, UVR() * 7]);
}

export function box(w, h, d, { grain = 'x', uv = 1, segs = [1, 1, 1] } = {}) {
  const g = new THREE.BoxGeometry(w, h, d, segs[0], segs[1], segs[2]);
  return planarUV(g, grain, uv, [UVR() * 7, UVR() * 7]);
}

// Cylinder / frustum with metric UVs: u along the axis (textures' grain runs along u), v around.
export function cylinder(rTop, rBot, h, radial = 12, hSegs = 1, { open = false, uv = 1 } = {}) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, radial, hSegs, open);
  const a = g.getAttribute('uv');
  const circ = Math.PI * (rTop + rBot);
  const off = UVR() * 5;
  for (let i = 0; i < a.count; i++) {
    const around = a.getX(i), along = a.getY(i);
    a.setXY(i, along * h * uv + off, around * circ * uv);
  }
  return g;
}

// Lathe from a [[r, y], ...] profile (bottom → top). Metric UVs.
export function lathe(profile, segs = 12, phase = 0, { uv = 1 } = {}) {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(r, 1e-4), y));
  const g = new THREE.LatheGeometry(pts, segs, phase, Math.PI * 2);
  const a = g.getAttribute('uv');
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += pts[i].distanceTo(pts[i - 1]);
  const maxR = Math.max(...profile.map((p) => p[0]));
  for (let i = 0; i < a.count; i++) a.setXY(i, a.getX(i) * Math.PI * 2 * maxR * uv, a.getY(i) * len * uv);
  return g;
}

// Beam along x with upswept ends (torii kasagi/shimaki, eave boards): y += lift*(|x|/half)^pow.
export function bentBeam(len, h, d, { segs = 24, lift = 0.3, pow = 2.2, uv = 1, taperTop = 0 } = {}) {
  const g = new THREE.BoxGeometry(len, h, d, segs, 1, 1);
  planarUV(g, 'x', uv, [UVR() * 7, UVR() * 7]);
  const p = g.getAttribute('position');
  const half = len / 2;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const k = Math.pow(Math.abs(x) / half, pow);
    let y = p.getY(i) + lift * k;
    // the upper face widens slightly outward at the tips (sweeping silhouette)
    if (taperTop && p.getY(i) > 0) y += taperTop * k;
    p.setY(i, y);
  }
  g.computeVertexNormals();
  return g;
}

// Sweep a rectangular (w×h) or round (r) section along a polyline of Vector3 points.
export function sweep(points, { w = 0.2, h = 0.2, radius = 0, radial = 8, up = new THREE.Vector3(0, 1, 0), uv = 1, closedEnds = true } = {}) {
  const pos = [], nrm = [], uvs = [], idx = [];
  const sect = [];
  if (radius > 0) {
    for (let k = 0; k <= radial; k++) {
      const a = (k / radial) * Math.PI * 2;
      sect.push([Math.cos(a) * radius, Math.sin(a) * radius, Math.cos(a), Math.sin(a)]);
    }
  } else {
    const hw = w / 2, hh = h / 2;
    const corners = [[hw, hh], [-hw, hh], [-hw, -hh], [hw, -hh], [hw, hh]];
    const normals = [[0, 1], [-1, 0], [0, -1], [1, 0]];
    for (let k = 0; k < 4; k++) {
      sect.push([corners[k][0], corners[k][1], normals[k][0], normals[k][1]]);
      sect.push([corners[k + 1][0], corners[k + 1][1], normals[k][0], normals[k][1]]);
    }
  }
  const T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3();
  let acc = 0;
  const ring = sect.length;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
    T.subVectors(b, a).normalize();
    B.crossVectors(T, up);
    if (B.lengthSq() < 1e-8) B.set(1, 0, 0);
    B.normalize();
    N.crossVectors(B, T).normalize();
    if (i > 0) acc += p.distanceTo(points[i - 1]);
    for (let k = 0; k < ring; k++) {
      const [sx, sy, nx, ny] = sect[k];
      pos.push(p.x + B.x * sx + N.x * sy, p.y + B.y * sx + N.y * sy, p.z + B.z * sx + N.z * sy);
      nrm.push(B.x * nx + N.x * ny, B.y * nx + N.y * ny, B.z * nx + N.z * ny);
      uvs.push((radius > 0 ? k / radial : k / ring) * (radius > 0 ? Math.PI * 2 * radius : 2 * (w + h)) * uv, acc * uv);
    }
  }
  const stride = radius > 0 ? 1 : 2;
  for (let i = 0; i < points.length - 1; i++) {
    for (let k = 0; k < ring - 1; k += radius > 0 ? 1 : 2) {
      const a = i * ring + k, b = i * ring + k + 1, c = (i + 1) * ring + k, d = (i + 1) * ring + k + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  void stride;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

// Deformed icosphere boulder (moss added by the stone material from the normal).
export function boulder(r, seed = 1, { detail = 2, squash = 0.7 } = {}) {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const p = g.getAttribute('position');
  const rnd = rng(seed);
  const lobes = [];
  for (let k = 0; k < 6; k++) lobes.push([rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1, 0.1 + rnd() * 0.25]);
  for (let i = 0; i < p.count; i++) {
    _v.fromBufferAttribute(p, i);
    _n.copy(_v).normalize();
    let k = 1;
    for (const [lx, ly, lz, a] of lobes) k += a * Math.max(0, _n.x * lx + _n.y * ly + _n.z * lz) ** 2 - a * 0.25;
    // flattened facets
    const facet = Math.round((_n.x * 3 + _n.z * 2.2 + _n.y * 1.3) * 1.5) / 1.5;
    k += (facet - (_n.x * 3 + _n.z * 2.2 + _n.y * 1.3)) * 0.035;
    _v.multiplyScalar(k);
    _v.y *= _v.y < 0 ? 0.55 : squash;
    p.setXYZ(i, _v.x, _v.y, _v.z);
  }
  g.deleteAttribute('uv');
  g.computeVertexNormals();
  return planarUV(g, 'x', 0.8, [rnd() * 9, rnd() * 9]);
}

// Vertex-colour weathering in world space: grime/damp near the ground, darker undersides (cheap AO),
// and a per-piece tone jitter.
export function weather(geo, groundY, { grimeH = 0.9, grime = [0.55, 0.5, 0.44], under = 0.62, jitter = 0.08, seed = 0, tint = null } = {}) {
  const p = geo.getAttribute('position'), n = geo.getAttribute('normal'), c = geo.getAttribute('color');
  const r = rng(seed * 97 + 13);
  const j = 1 - jitter / 2 + r() * jitter;
  const t = tint || [1, 1, 1];
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i) - groundY;
    const k = y < grimeH ? 1 - Math.max(0, y) / grimeH : 0;
    const ny = n.getY(i);
    const u = ny < -0.2 ? under + (1 - under) * Math.max(0, 1 + ny) : 1;
    const f = (a) => (1 + (a - 1) * k * k) * u * j;
    c.setXYZ(i, c.getX(i) * f(grime[0]) * t[0], c.getY(i) * f(grime[1]) * t[1], c.getZ(i) * f(grime[2]) * t[2]);
  }
  return geo;
}

// Local-space vertex shading (baked AO / wear) before placement: fn(x, y, z, nx, ny, nz) → multiplier.
export function shadeLocal(geo, fn) {
  const p = geo.getAttribute('position'), n = geo.getAttribute('normal');
  let c = geo.getAttribute('color');
  if (!c) {
    c = new THREE.Float32BufferAttribute(new Float32Array(p.count * 3).fill(1), 3);
    geo.setAttribute('color', c);
  }
  for (let i = 0; i < p.count; i++) {
    const k = fn(p.getX(i), p.getY(i), p.getZ(i), n ? n.getX(i) : 0, n ? n.getY(i) : 1, n ? n.getZ(i) : 0);
    c.setXYZ(i, c.getX(i) * k, c.getY(i) * k, c.getZ(i) * k);
  }
  return geo;
}

// Set a flutter attribute: weight grows with distance from an anchor line (pole / top edge).
export function setFlag(geo, weightFn, phase = 0) {
  const p = geo.getAttribute('position');
  const a = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    a[i * 2] = weightFn(p.getX(i), p.getY(i), p.getZ(i));
    a[i * 2 + 1] = phase;
  }
  geo.setAttribute('aFlag', new THREE.Float32BufferAttribute(a, 2));
  return geo;
}

// Collects geometry per material key, merges and builds meshes.
export class Builder {
  constructor(name) {
    this.name = name;
    this.buckets = new Map();
  }

  // add(key, geometry, matrix?, { ground, weather opts, flag })
  add(key, geo, matrix = null, opts = {}) {
    const g = finalize(geo, { flag: !!opts.flag });
    if (matrix) g.applyMatrix4(matrix);
    if (opts.ground !== undefined) weather(g, opts.ground, opts);
    if (!this.buckets.has(key)) this.buckets.set(key, []);
    this.buckets.get(key).push(g);
    return g;
  }

  build(materials, { castShadow = true, receiveShadow = true } = {}) {
    const group = new THREE.Group();
    group.name = this.name;
    for (const [key, geos] of this.buckets) {
      const mat = materials[key];
      if (!mat) {
        console.warn('[props] no material', key);
        continue;
      }
      const merged = mergeGeometries(geos, false);
      if (!merged) {
        console.warn('[props] merge failed', this.name, key);
        continue;
      }
      merged.computeBoundingSphere();
      merged.computeBoundingBox();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = `${this.name}:${key}`;
      mesh.castShadow = castShadow && !mat.userData.noShadow;
      mesh.receiveShadow = receiveShadow;
      group.add(mesh);
    }
    for (const geos of this.buckets.values()) for (const g of geos) g.dispose();
    this.buckets.clear();
    return group;
  }
}

// Matrix helpers --------------------------------------------------------------------------------
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

export function mat(x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
}

// Frame from an origin and a forward (through) direction on XZ: local z = forward, x = right.
export function frame(ox, oy, oz, fx, fz) {
  const ry = Math.atan2(fx, fz);
  return mat(ox, oy, oz, 0, ry, 0);
}

export function mul(a, b) {
  return new THREE.Matrix4().multiplyMatrices(a, b);
}

void _m;
