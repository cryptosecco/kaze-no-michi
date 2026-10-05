import * as THREE from 'three';

// LOD manager for the 3D trees. Every tree record lives in a 32 m grid; when the camera moves (>2.5 m) or
// turns (>3°) the instance lists are rebuilt:
//   LOD0 (full)  : d < lod0 (+band)       — no culling within 25 m, frustum culling beyond
//   LOD1 (light) : lod0 (−band) < d < lod1 — frustum culling that also keeps trees whose long golden-hour
//                  shadow reaches into view (sphere tested at the tree and along its shadow)
// Bark and leaf meshes of a variant share one instanceMatrix buffer. Cross-fades are done in the shaders.

const GRID = 32;
const _sphere = new THREE.Sphere();
const _v = new THREE.Vector3();

export class Forest {
  constructor({ variants, records, lod, sunDir }) {
    this.variants = variants; // [{ lod0:{bark,leaves}, lod1:{bark,leaves}, radius, height, cls, mats:{bark:[m0,m1], leaves:[m0,m1]} }]
    this.lod = lod; // { tree: {lod0, lod1, band}, shrub: {...} }
    this.sunDir = sunDir;
    this.group = new THREE.Group();
    this.group.name = 'forest';
    const n = records.length;
    this.n = n;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.z = new Float32Array(n);
    this.s = new Float32Array(n);
    this.vi = new Uint16Array(n);
    this.mat = new Float32Array(n * 16);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pos = new THREE.Vector3();
    const perVariant = new Array(variants.length).fill(0);
    this.cells = new Map();
    records.forEach((r, i) => {
      this.x[i] = r.x;
      this.y[i] = r.y;
      this.z[i] = r.z;
      this.s[i] = r.scale;
      this.vi[i] = r.vi;
      perVariant[r.vi]++;
      q.setFromAxisAngle(_v.set(0, 1, 0), r.rot);
      m.compose(pos.set(r.x, r.y, r.z), q, sc.set(r.scale, r.scale, r.scale));
      m.toArray(this.mat, i * 16);
      const k = this._cellKey(Math.floor(r.x / GRID), Math.floor(r.z / GRID));
      let c = this.cells.get(k);
      if (!c) this.cells.set(k, (c = []));
      c.push(i);
    });
    for (const [k, c] of this.cells) this.cells.set(k, Int32Array.from(c));

    // instanced meshes per variant and LOD
    this.meshes = variants.map((v, vi) => {
      const out = [];
      for (let l = 0; l < 2; l++) {
        const cap = Math.max(1, Math.min(perVariant[vi], l === 0 ? 700 : 5000));
        const geo = l === 0 ? v.lod0 : v.lod1;
        const bark = new THREE.InstancedMesh(geo.bark, v.mats.bark[l], cap);
        const leaves = new THREE.InstancedMesh(geo.leaves, v.mats.leaves[l], cap);
        leaves.instanceMatrix = bark.instanceMatrix;
        for (const mesh of [bark, leaves]) {
          mesh.count = 0;
          mesh.frustumCulled = false;
          mesh.castShadow = v.castShadow !== false;
          mesh.receiveShadow = true;
          mesh.name = `tree-${v.key}-lod${l}`;
          this.group.add(mesh);
        }
        bark.customDepthMaterial = v.mats.bark[l].userData.depth;
        leaves.customDepthMaterial = v.mats.leaves[l].userData.depth;
        bark.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        out.push({ bark, leaves, cap, count: 0 });
      }
      return out;
    });
    this._lastPos = new THREE.Vector3(1e9, 0, 0);
    this._lastFwd = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._frustum = new THREE.Frustum();
    this._pm = new THREE.Matrix4();
    this.stats = { lod0: 0, lod1: 0 };
  }

  _cellKey(i, j) {
    return (i + 512) * 4096 + (j + 512);
  }

  _visible(i, v, withShadow) {
    const sc = this.s[i];
    const h = v.height * sc;
    const r = Math.max(v.radius * sc, h * 0.5) + 6;
    _sphere.center.set(this.x[i], this.y[i] + h * 0.5, this.z[i]);
    _sphere.radius = r;
    if (this._frustum.intersectsSphere(_sphere)) return true;
    if (!withShadow) return false;
    // long shadows: test along the shadow of the crown on the ground
    const sd = this.sunDir;
    const el = Math.max(0.06, sd.y);
    const L = Math.min(130, (h / el) * Math.hypot(sd.x, sd.z));
    const hl = Math.hypot(sd.x, sd.z) || 1;
    for (const t of [0.5, 1]) {
      _sphere.center.set(this.x[i] - (sd.x / hl) * L * t, this.y[i] + h * 0.25, this.z[i] - (sd.z / hl) * L * t);
      if (this._frustum.intersectsSphere(_sphere)) return true;
    }
    return false;
  }

  update(camera, force = false) {
    const p = camera.position;
    camera.getWorldDirection(this._fwd);
    if (!force && p.distanceToSquared(this._lastPos) < 6.25 && this._fwd.dot(this._lastFwd) > 0.9986) return false;
    this._lastPos.copy(p);
    this._lastFwd.copy(this._fwd);
    this._pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._pm, THREE.WebGLCoordinateSystem, camera.reversedDepth);
    for (const vm of this.meshes) for (const l of vm) l.count = 0;
    const slack = 3.5;
    const T = this.lod.tree, Sh = this.lod.shrub;
    const R = Math.max(T.lod1, Sh.lod1) + T.band + slack + 8;
    const ci0 = Math.floor((p.x - R) / GRID), ci1 = Math.floor((p.x + R) / GRID);
    const cj0 = Math.floor((p.z - R) / GRID), cj1 = Math.floor((p.z + R) / GRID);
    const x = this.x, z = this.z, vi = this.vi, mat = this.mat;
    for (let ci = ci0; ci <= ci1; ci++)
      for (let cj = cj0; cj <= cj1; cj++) {
        const cell = this.cells.get(this._cellKey(ci, cj));
        if (!cell) continue;
        for (let k = 0; k < cell.length; k++) {
          const i = cell[k];
          const dx = x[i] - p.x, dz = z[i] - p.z;
          const d = Math.sqrt(dx * dx + dz * dz);
          const v = this.variants[vi[i]];
          const L = v.cls === 'shrub' ? Sh : T;
          if (d > L.lod1 + L.band + slack) continue;
          const vm = this.meshes[vi[i]];
          if (d < L.lod0 + L.band * 0.5 + slack) {
            if (d < 25 || this._visible(i, v, true)) {
              const e = vm[0];
              if (e.count < e.cap) {
                e.bark.instanceMatrix.array.set(mat.subarray(i * 16, i * 16 + 16), e.count * 16);
                e.count++;
              }
            }
          }
          if (d > L.lod0 - L.band * 0.5 - slack) {
            if (this._visible(i, v, true)) {
              const e = vm[1];
              if (e.count < e.cap) {
                e.bark.instanceMatrix.array.set(mat.subarray(i * 16, i * 16 + 16), e.count * 16);
                e.count++;
              }
            }
          }
        }
      }
    let n0 = 0, n1 = 0;
    for (const vm of this.meshes)
      vm.forEach((e, l) => {
        e.bark.count = e.leaves.count = e.count;
        if (e.count) {
          e.bark.instanceMatrix.clearUpdateRanges();
          e.bark.instanceMatrix.addUpdateRange(0, e.count * 16);
          e.bark.instanceMatrix.needsUpdate = true;
        }
        if (l === 0) n0 += e.count;
        else n1 += e.count;
      });
    this.stats.lod0 = n0;
    this.stats.lod1 = n1;
    return true;
  }
}
