import * as THREE from 'three';
import { loft, lathe, mergeParts, place } from './shapes.js';
import { paint } from '../rig/skin.js';
import { bladeMap, tsukaWrap } from './textures.js';

// Weapons in their own local frame: grip center at the origin, blade along +Y, edge toward +Z,
// spine (mune) toward −Z. The same frame is used for the scabbard, so "sheathed" = same transform.
//   makeKatana({ rusty, silk }) → Group { blade, handle, fittings } with userData { tip, base, length }
//   makeSaya()                  → Mesh (black lacquer scabbard)
//   makeSpear()                 → Group (shaft + blade), userData.tip

const BLADE_LEN = 0.72;
const BLADE_Y0 = 0.15;
const SPEAR_LEN = 2.3;

// Extent of each weapon along its local +Y axis (m, grip centre at 0): [pommel / butt, tip]. Used to keep the
// weapons of staged actors out of each other's bodies (scripts/staging.test.mjs).
export const WEAPON_SPAN = { katana: [-0.152, BLADE_Y0 + BLADE_LEN], spear: [-SPEAR_LEN * 0.55, SPEAR_LEN * 0.45 + 0.26] };

function curveZ(t, sori) {
  // curvature concentrated toward the lower-middle (koshi-zori), spine side = −Z
  return -sori * t * t * (1.4 - 0.4 * t);
}

function bladeGeometry({ length = BLADE_LEN, y0 = BLADE_Y0, w0 = 0.031, w1 = 0.022, th0 = 0.0074, th1 = 0.0052, sori = 0.026, steps = 48 } = {}) {
  const pos = [], nor = [], uv = [], index = [];
  // facets: [from, to] indices into the cross-section ring, and uv.v range
  const section = (t) => {
    const w = w0 + (w1 - w0) * t, th = th0 + (th1 - th0) * t;
    const tipT = Math.max(0, (t - 0.93) / 0.07);
    const fuk = Math.pow(tipT, 1.4);
    const zs = -w / 2, ze = w / 2 - (w * 0.95) * fuk; // edge recedes toward the spine at the kissaki
    const shin = zs + (ze - zs) * 0.3;
    const thk = th * (1 - 0.85 * fuk);
    return [
      [0, ze],
      [thk / 2, shin],
      [thk * 0.35, zs],
      [-thk * 0.35, zs],
      [-thk / 2, shin],
    ];
  };
  const faces = [
    [0, 1, 0.0, 0.7],
    [1, 2, 0.7, 0.92],
    [2, 3, 0.92, 1.0],
    [3, 4, 0.92, 0.7],
    [4, 0, 0.7, 0.0],
  ];
  const ringPts = [];
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const y = y0 + t * length;
    const cz = curveZ(t, sori);
    ringPts.push(section(t).map(([x, z]) => new THREE.Vector3(x, y, z + cz)));
  }
  for (const [a, b, va, vb] of faces) {
    const start = pos.length / 3;
    for (let s = 0; s <= steps; s++) {
      const pa = ringPts[s][a], pb = ringPts[s][b];
      const next = ringPts[Math.min(steps, s + 1)], prev = ringPts[Math.max(0, s - 1)];
      const along = new THREE.Vector3().subVectors(next[a], prev[a]).normalize();
      const across = new THREE.Vector3().subVectors(pb, pa);
      const n = new THREE.Vector3().crossVectors(across, along).normalize();
      for (const [p, v] of [[pa, va], [pb, vb]]) {
        pos.push(p.x, p.y, p.z);
        nor.push(n.x, n.y, n.z);
        uv.push(s / steps, v);
      }
    }
    for (let s = 0; s < steps; s++) {
      const i0 = start + s * 2;
      index.push(i0, i0 + 1, i0 + 2, i0 + 1, i0 + 3, i0 + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  // flip winding if normals point inward (cross order above yields outward for this layout)
  return g;
}

const matCache = new Map();
function mat(key, fn) {
  if (!matCache.has(key)) matCache.set(key, fn());
  return matCache.get(key);
}

export function makeKatana({ rusty = false, silk = '#15171d', gold = true, scale = 1 } = {}) {
  const group = new THREE.Group();
  group.name = 'katana';
  const bladeMat = mat('blade' + rusty, () =>
    new THREE.MeshStandardMaterial({ map: bladeMap(rusty).map, metalness: rusty ? 0.75 : 1.0, roughness: rusty ? 0.5 : 0.2, envMapIntensity: 1.3 })
  );
  const blade = new THREE.Mesh(bladeGeometry({ sori: 0.026 }), bladeMat);
  blade.name = 'blade';
  blade.castShadow = true;

  // tsuka: oval, slightly waisted, wrapped
  const wrap = tsukaWrap(rusty ? '#3a2a1c' : silk);
  const handleMat = mat('tsuka' + rusty + silk, () => new THREE.MeshStandardMaterial({ map: wrap.map, normalMap: wrap.normalMap, roughness: 0.8 }));
  const rings = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const y = -0.14 + t * 0.27;
    const waist = 1 - 0.1 * Math.sin(t * Math.PI);
    rings.push({ c: [0, y, curveZ(-0.05 + t * 0.05, 0.026) * 0], ax: [1, 0, 0], ay: [0, 0, 1], rx: 0.0135 * waist, ry: 0.0165 * waist });
  }
  const tsuka = loft(rings, { seg: 14, tile: 1, capStart: true });
  // uv: u around 0..1, v along 0..1 (loft gives meters; renormalize)
  const uvA = tsuka.attributes.uv;
  for (let i = 0; i < uvA.count; i++) uvA.setXY(i, uvA.getX(i) / 0.095, uvA.getY(i) / 0.27);
  const handle = new THREE.Mesh(tsuka, handleMat);
  handle.name = 'handle';
  handle.castShadow = true;

  // fittings: tsuba (guard), habaki (collar), kashira (pommel), seppa — vertex colored metal
  const iron = new THREE.Color(rusty ? 0x2a2019 : 0x151413), brass = new THREE.Color(rusty ? 0x5a4a38 : 0xb08744);
  const tsubaG = lathe([[0.0, 0.0035], [0.036, 0.0035], [0.039, 0.0015], [0.039, -0.0015], [0.036, -0.0035], [0.0, -0.0035]], 28);
  tsubaG.scale(1, 1, 1.12);
  place(tsubaG, [0, 0.139, -0.001]);
  paint(tsubaG, iron);
  const seppa = lathe([[0.0, 0.0012], [0.02, 0.0012], [0.02, -0.0012], [0.0, -0.0012]], 16);
  seppa.scale(0.72, 1, 1);
  place(seppa, [0, 0.1325, 0]);
  paint(seppa, gold ? brass : iron);
  const habaki = new THREE.BoxGeometry(0.011, 0.028, 0.034);
  place(habaki, [0, 0.158, -0.001]);
  paint(habaki, gold ? brass : iron);
  const kashira = lathe([[0.0, 0.006], [0.012, 0.005], [0.015, 0.0], [0.014, -0.006], [0.0, -0.007]], 16);
  kashira.scale(0.95, 1, 1.18);
  place(kashira, [0, -0.145, 0]);
  paint(kashira, iron);
  const fuchi = lathe([[0.0145, 0.006], [0.0145, -0.006]], 16);
  fuchi.scale(1, 1, 1.18);
  place(fuchi, [0, 0.127, 0]);
  paint(fuchi, iron);
  const fitMat = mat('fit' + rusty, () => new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.85, roughness: rusty ? 0.7 : 0.4 }));
  const fittings = new THREE.Mesh(mergeParts([tsubaG, seppa, habaki, kashira, fuchi]), fitMat);
  fittings.name = 'fittings';
  fittings.castShadow = true;

  group.add(blade, handle, fittings);
  group.scale.setScalar(scale);
  const tipT = 1;
  group.userData = {
    base: new THREE.Vector3(0, BLADE_Y0 + 0.02, 0),
    tip: new THREE.Vector3(0, BLADE_Y0 + BLADE_LEN * tipT, curveZ(1, 0.026)),
    length: BLADE_LEN,
    blade,
  };
  return group;
}

export function makeSaya({ color = 0x0c0a09, cord = 0x6b1e17 } = {}) {
  const rings = [];
  const n = 20;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const y = 0.128 + t * (BLADE_LEN + 0.04);
    const z = curveZ(Math.max(0, (y - BLADE_Y0) / BLADE_LEN), 0.026);
    const w = 0.0205 - 0.004 * t, th = 0.0128 - 0.0022 * t;
    rings.push({ c: [0, y, z + 0.0015], ax: [1, 0, 0], ay: [0, 0, 1], rx: th, ry: w });
  }
  const body = loft(rings, { seg: 14, tile: 0.2, capEnd: true, capStart: true });
  paint(body, new THREE.Color(color));
  // koiguchi ring + kojiri cap (horn) + kurikata knob with a cord knot
  const koi = lathe([[0.0145, 0.004], [0.0145, -0.004]], 16);
  koi.scale(1, 1, 1.5);
  place(koi, [0, 0.13, 0]);
  paint(koi, new THREE.Color(0x2a2522));
  const kojiri = lathe([[0.012, 0.012], [0.013, 0.0], [0.009, -0.01], [0.0, -0.013]], 16);
  kojiri.scale(1, 1, 1.35);
  place(kojiri, [0, 0.128 + BLADE_LEN + 0.03, curveZ(1, 0.026) + 0.002]);
  paint(kojiri, new THREE.Color(0x1d1612));
  const knot = new THREE.SphereGeometry(0.012, 10, 8);
  knot.scale(0.8, 1.4, 1);
  place(knot, [0.012, 0.22, -0.004]);
  paint(knot, new THREE.Color(cord));
  const cordRings = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    cordRings.push({ c: [0.014 + Math.sin(t * Math.PI) * 0.02, 0.22 - t * 0.14, -0.006 - t * 0.01], ax: [1, 0, 0], ay: [0, 0, 1], rx: 0.004, ry: 0.004 });
  }
  const cordG = loft(cordRings, { seg: 6, tile: 0.1 });
  paint(cordG, new THREE.Color(cord));
  const m = mat('saya' + color, () =>
    new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.38, clearcoat: 0.8, clearcoatRoughness: 0.25, metalness: 0.0 })
  );
  const mesh = new THREE.Mesh(mergeParts([body, koi, kojiri, knot, cordG]), m);
  mesh.name = 'saya';
  mesh.castShadow = true;
  return mesh;
}

// Yari: straight triangular blade on a long shaft. Grip (lead hand) at the origin, blade toward +Y.
export function makeSpear({ length = SPEAR_LEN, rusty = true } = {}) {
  const group = new THREE.Group();
  group.name = 'spear';
  const shaftRings = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    shaftRings.push({ c: [0, -length * 0.55 + t * length, 0], ax: [1, 0, 0], ay: [0, 0, 1], rx: 0.0165 - 0.003 * t, ry: 0.0165 - 0.003 * t });
  }
  const shaft = loft(shaftRings, { seg: 10, tile: 0.4, capStart: true, capEnd: true });
  paint(shaft, new THREE.Color(0x3b2a1c));
  const collar = lathe([[0.017, 0.03], [0.02, 0.0], [0.017, -0.03]], 12);
  place(collar, [0, length * 0.45 - 0.02, 0]);
  paint(collar, new THREE.Color(0x2a221d));
  const woodMat = mat('spearwood', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.2 }));
  const wood = new THREE.Mesh(mergeParts([shaft, collar]), woodMat);
  wood.castShadow = true;
  // blade: 3-sided (sankaku yari)
  const pos = [], idx = [];
  const y0 = length * 0.45, L = 0.26;
  const tri = (s) => [0, 1, 2].map((k) => [Math.cos((k / 3) * Math.PI * 2 + 0.5) * s, Math.sin((k / 3) * Math.PI * 2 + 0.5) * s]);
  const base = tri(0.018), mid = tri(0.013);
  const pts = [...base.map(([x, z]) => [x, y0, z]), ...mid.map(([x, z]) => [x, y0 + L * 0.35, z]), [0, y0 + L, 0]];
  for (const p of pts) pos.push(p[0], p[1], p[2]);
  for (let k = 0; k < 3; k++) {
    const a = k, b = (k + 1) % 3;
    idx.push(a, b, 3 + a, b, 3 + b, 3 + a, 3 + a, 3 + b, 6);
  }
  const bg = new THREE.BufferGeometry();
  bg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  bg.setIndex(idx);
  const flat = bg.toNonIndexed();
  flat.computeVertexNormals();
  const steel = mat('spearsteel' + rusty, () => new THREE.MeshStandardMaterial({ color: rusty ? 0x6d655c : 0xb8bec4, metalness: 0.9, roughness: rusty ? 0.55 : 0.25 }));
  const bladeMesh = new THREE.Mesh(flat, steel);
  bladeMesh.castShadow = true;
  group.add(wood, bladeMesh);
  group.userData = { tip: new THREE.Vector3(0, y0 + L, 0), base: new THREE.Vector3(0, y0, 0), length: L, blade: bladeMesh };
  return group;
}
