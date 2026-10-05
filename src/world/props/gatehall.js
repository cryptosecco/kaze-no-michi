import * as THREE from 'three';
import { box, cylinder, bentBeam, sweep, mat, mul, setFlag, finalize } from './geom.js';
import { buildRoof, roofHeightAt } from './roof.js';

// Gate hall at the top of the shrine stairs, local frame: x across the approach, z along it (−z faces the
// stairs). One tall storey of dark timber, 3 × 2 bays: the central bay is an open passage (the low sun behind
// the summit shines through it), the side bays are closed by a board wainscot, a vertical lattice and a transom.
// Three-stepped bracket sets on every post carry deep eaves under a heavy tiled irimoya roof, and a cusped
// karahafu gable rises from its front slope over the passage.
export function buildGateHall(b, M, { groundY }) {
  const w = { ground: groundY, grimeH: 1.0 };
  const bays = [-5.2, -1.8, 1.8, 5.2];
  const rows = [-3.0, 3.0];
  const floorY = 0.45, postH = 5.0;
  const topY = floorY + postH;
  // stone platform (kidan) + front/back steps
  b.add('stone', box(12.2, 1.2, 8.0, { grain: 'x' }), mul(M, mat(0, floorY - 0.6, 0)), { ...w, grimeH: 0.4, seed: 1 });
  for (const zz of [-4.4, 4.4]) b.add('stone', box(4.6, 0.24, 0.8, { grain: 'x' }), mul(M, mat(0, 0.1, zz)), { ...w, grimeH: 0.2, seed: 2 });

  // ---- posts and tie beams ----
  for (const x of bays)
    for (const z of [...rows, 0]) {
      if (z === 0 && Math.abs(x) < 2) continue; // the passage
      b.add('woodDark', cylinder(0.23, 0.25, postH, 14, 3), mul(M, mat(x, floorY + postH / 2, z)), w);
      b.add('stone', cylinder(0.36, 0.42, 0.22, 12, 1), mul(M, mat(x, floorY + 0.09, z)), w);
    }
  for (const z of rows) {
    b.add('woodDark', box(11.1, 0.42, 0.3, { grain: 'x' }), mul(M, mat(0, topY - 0.25, z)), w); // head tie beam
    b.add('woodDark', box(10.9, 0.22, 0.2, { grain: 'x' }), mul(M, mat(0, floorY + 2.3, z)), w); // mid nuki
  }
  for (const x of bays) b.add('woodDark', box(0.3, 0.42, 6.6, { grain: 'z' }), mul(M, mat(x, topY - 0.25, 0)), w);
  // rainbow beams (kōryō) over the passage, front and back, gently arched
  for (const z of rows) b.add('woodDark', bentBeam(3.9, 0.46, 0.32, { segs: 16, lift: -0.16, pow: 2 }), mul(M, mat(0, topY - 0.95, z)), w);

  // ---- side bays: board wainscot, vertical lattice over a dark interior, transom ----
  for (const sx of [-1, 1]) {
    const xc = sx * 3.5, bw = 3.4 - 0.46;
    for (const z of rows) {
      const zo = z + Math.sign(z) * 0.02;
      b.add('woodDark', box(bw, 1.05, 0.1, { grain: 'x' }), mul(M, mat(xc, floorY + 0.12 + 0.52, zo)), { ...w, tint: [0.78, 0.74, 0.7] });
      b.add('woodDark', box(bw, 0.12, 0.16, { grain: 'x' }), mul(M, mat(xc, floorY + 1.2, zo)), w);
      const n = 17;
      for (let k = 0; k < n; k++) {
        const xx = xc - bw / 2 + (bw * (k + 0.5)) / n;
        b.add('woodDark', box(0.06, 2.42, 0.08, { grain: 'y' }), mul(M, mat(xx, floorY + 1.26 + 1.21, zo)), w);
      }
      b.add('woodDark', box(bw, 0.12, 0.16, { grain: 'x' }), mul(M, mat(xc, floorY + 3.7, zo)), w);
      // transom: dark board pierced by short studs
      b.add('woodDark', box(bw, 0.62, 0.06, { grain: 'x' }), mul(M, mat(xc, floorY + 4.08, z * 0.98)), { ...w, tint: [0.5, 0.48, 0.46] });
      for (let k = 0; k < 7; k++) b.add('woodDark', box(0.08, 0.62, 0.1, { grain: 'y' }), mul(M, mat(xc - bw / 2 + (bw * (k + 0.5)) / 7, floorY + 4.08, zo)), w);
      // the dark interior seen through the lattice
      b.add('woodDark', box(bw, 3.2, 0.05, { grain: 'y' }), mul(M, mat(xc, floorY + 2.6, z * 0.62)), { ...w, tint: [0.22, 0.21, 0.2] });
    }
    // end walls: dark boards
    b.add('woodDark', box(0.14, postH - 0.4, 6.0, { grain: 'z' }), mul(M, mat(sx * 5.2, floorY + (postH - 0.4) / 2 + 0.1, 0)), { ...w, tint: [0.8, 0.76, 0.72] });
  }
  // shimenawa across the passage (front) with shide papers
  const ropeY = topY - 1.35;
  const ropePts = [];
  for (let k = 0; k <= 16; k++) {
    const t = k / 16;
    ropePts.push(new THREE.Vector3(-1.66 + 3.32 * t, ropeY - Math.sin(Math.PI * t) * 0.34, -3.26));
  }
  b.add('straw', sweep(ropePts, { radius: 0.13, radial: 10 }), M, { ...w, grimeH: 0 });
  b.add('straw', sweep(ropePts.map((p) => p.clone().add(new THREE.Vector3(0, 0.06, 0.03))), { radius: 0.07, radial: 8 }), M, { ...w, grimeH: 0 });
  for (const t of [0.2, 0.4, 0.6, 0.8]) {
    const pg = new THREE.PlaneGeometry(0.2, 0.56, 1, 4);
    setFlag(pg, (px, py) => Math.min(1, (0.28 - py) / 0.56), t * 7);
    b.add('paper', pg, mul(M, mat(-1.66 + 3.32 * t, ropeY - Math.sin(Math.PI * t) * 0.34 - 0.42, -3.34)), { flag: true });
  }
  // plaque under the eaves over the passage
  b.add('black', box(1.0, 1.25, 0.1, { grain: 'y' }), mul(M, mat(0, topY + 0.2, -3.5)), w);
  b.add('woodDark', box(1.14, 1.4, 0.06, { grain: 'y' }), mul(M, mat(0, topY + 0.2, -3.43)), w);

  // ---- bracket sets (three steps) on every post of the long walls, one between posts; eave purlins ----
  const brY = topY; // top of the head beam
  const bracket = (x, z, outward) => {
    const zs = Math.sign(z) || 1;
    b.add('woodDark', box(0.58, 0.28, 0.58, { grain: 'x' }), mul(M, mat(x, brY + 0.14, z)), w); // bearing block
    b.add('woodDark', box(1.6, 0.24, 0.3, { grain: 'x' }), mul(M, mat(x, brY + 0.4, z)), w); // cross arm
    if (outward) {
      b.add('woodDark', box(0.3, 0.24, 1.3, { grain: 'z' }), mul(M, mat(x, brY + 0.4, z + zs * 0.5)), w); // step 1
      b.add('woodDark', box(0.36, 0.18, 0.36, { grain: 'x' }), mul(M, mat(x, brY + 0.61, z + zs * 1.05)), w);
      b.add('woodDark', box(0.3, 0.24, 1.2, { grain: 'z' }), mul(M, mat(x, brY + 0.82, z + zs * 1.25)), w); // step 2
      b.add('woodDark', box(0.36, 0.18, 0.36, { grain: 'x' }), mul(M, mat(x, brY + 1.03, z + zs * 1.75)), w);
      b.add('woodDark', box(1.2, 0.22, 0.3, { grain: 'x' }), mul(M, mat(x, brY + 1.03, z + zs * 1.75)), w);
    }
    for (const dx of [-0.62, 0, 0.62]) b.add('woodDark', box(0.34, 0.18, 0.34, { grain: 'x' }), mul(M, mat(x + dx, brY + 0.61, z)), w);
  };
  for (const x of bays) for (const z of rows) bracket(x, z, true);
  for (const x of [-3.5, 0, 3.5]) for (const z of rows) bracket(x, z, false);
  for (const z of rows) {
    const zs = Math.sign(z);
    b.add('woodDark', box(11.4, 0.3, 0.3, { grain: 'x' }), mul(M, mat(0, brY + 0.86, z)), w); // wall plate
    b.add('woodDark', box(12.6, 0.3, 0.32, { grain: 'x' }), mul(M, mat(0, brY + 1.26, z + zs * 1.75)), w); // eave purlin
  }

  // ---- roof: tiled irimoya with deep eaves ----
  const roofY = brY + 1.25;
  const ro = { W: 15.2, D: 11.6, H: 4.9, type: 'irimoya', pow: 1.6, lift: 0.75, thick: 0.55, gableLen: 8.2, gableOver: 0.4, segE: 26, segS: 14, seed: 3 };
  const roof = buildRoof(ro);
  const RM = mul(M, mat(0, roofY, 0));
  b.add('tile', roof.top, RM, w);
  b.add('woodDark', roof.under, RM, { ...w, tint: [0.55, 0.52, 0.5] });
  b.add('woodDark', roof.fascia, RM, w);
  if (roof.gableWall) b.add('woodDark', roof.gableWall, RM, { ...w, tint: [0.7, 0.66, 0.62] });
  if (roof.hafu) b.add('black', roof.hafu, RM, w);
  b.add('black', roof.ridge, RM, w);
  if (roof.hips) b.add('black', roof.hips, RM, w);
  for (const sx of [-1, 1]) b.add('black', box(0.55, 0.9, 0.6, { grain: 'y' }), mul(RM, mat(sx * (roof.ridgeTo.x + 0.1), ro.H + 0.62, 0, 0, 0, -sx * 0.14)), w);
  // exposed rafters under the long eaves, following the soffit out to the eave edge
  const nR = 34;
  const hd = ro.D / 2;
  const soffit = (x, z) => {
    const s = Math.min(1, Math.max(0, (hd - Math.abs(z)) / hd));
    return roofY + roofHeightAt(ro, x, z) - ro.thick * (1 - 0.35 * s) - 0.07;
  };
  for (const sz of [-1, 1]) {
    for (let k = 0; k < nR; k++) {
      const x = -7.1 + (14.2 * (k + 0.5)) / nR;
      const zIn = sz * 4.0, zOut = sz * 5.75;
      const yIn = soffit(x, zIn);
      const yOut = soffit(x, zOut);
      const len = Math.hypot(zOut - zIn, yOut - yIn);
      const ang = Math.atan2(yOut - yIn, (zOut - zIn) * sz);
      b.add('woodDark', box(0.1, 0.12, len, { grain: 'z' }), mul(M, mat(x, (yIn + yOut) / 2, (zIn + zOut) / 2, -ang * sz, 0, 0)), w);
    }
  }

  // ---- karahafu: a cusped, bow-shaped gable over the passage, projecting from the front slope ----
  const kW = 2.9, kH = 2.2, kFront = -hd - 0.4;
  // front curve: convex in the middle, concave toward the ends, the tips flicking up a little
  const curve = (x) => {
    const t = Math.min(1, Math.abs(x) / kW);
    return kH * (0.5 + 0.5 * Math.cos(Math.PI * t)) + 0.16 * Math.pow(t, 6) - 0.12;
  };
  // how far back the extruded hood runs before it disappears into the main roof slope (+ overlap)
  const backZ = (y) => {
    const s = Math.min(1, Math.max(0, y / ro.H) ** (1 / ro.pow));
    return -hd * (1 - s) + 0.6;
  };
  const nE = 28, nS = 8;
  const top = [], under = [], uvs = [], idx = [];
  for (let j = 0; j <= nS; j++) {
    for (let i = 0; i <= nE; i++) {
      const x = -kW + (2 * kW * i) / nE;
      const y = curve(x);
      const zb = Math.max(kFront + 0.4, backZ(y));
      const z = kFront + ((zb - kFront) * j) / nS;
      top.push(x, y, z);
      under.push(x, y - 0.32, z);
      // tile courses run down the bow from its crest: u along z, v across
      uvs.push(z, x);
    }
  }
  for (let j = 0; j < nS; j++)
    for (let i = 0; i < nE; i++) {
      const a = j * (nE + 1) + i, c = a + nE + 1;
      idx.push(a, c, a + 1, a + 1, c, c + 1);
    }
  const grid = (pos, flip) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs.slice(), 2));
    g.setIndex(flip ? idx.slice().reverse() : idx);
    g.computeVertexNormals();
    return finalize(g);
  };
  b.add('tile', grid(top, false), RM, w);
  b.add('woodDark', grid(under, true), RM, { ...w, tint: [0.5, 0.48, 0.46] });
  // the thick bargeboard following the bow, with a lighter lip that catches the light
  const bow = [];
  for (let i = 0; i <= 40; i++) {
    const x = -kW - 0.15 + ((2 * kW + 0.3) * i) / 40;
    bow.push(new THREE.Vector3(x, curve(x) - 0.12, kFront - 0.02));
  }
  b.add('black', sweep(bow, { w: 0.22, h: 0.5 }), RM, w);
  b.add('woodAged', sweep(bow.map((p) => p.clone().add(new THREE.Vector3(0, 0.27, -0.02))), { w: 0.26, h: 0.08 }), RM, w);
  // gable face between the eave line and the bow (dark boards) and a hanging gegyo ornament at the peak
  const face = [], fIdx = [];
  for (let i = 0; i <= nE; i++) {
    const x = -kW + (2 * kW * i) / nE;
    face.push(x, -0.04, kFront + 0.18, x, Math.max(-0.04, curve(x) - 0.3), kFront + 0.18);
  }
  for (let i = 0; i < nE; i++) {
    const a = i * 2;
    fIdx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const fg = new THREE.BufferGeometry();
  fg.setAttribute('position', new THREE.Float32BufferAttribute(face, 3));
  fg.setIndex(fIdx);
  fg.computeVertexNormals();
  b.add('woodDark', finalize(fg), RM, { ...w, tint: [0.62, 0.58, 0.54] });
  b.add('black', box(0.9, 0.7, 0.16, { grain: 'y' }), mul(RM, mat(0, kH - 0.62, kFront - 0.06)), w);
  return { floorY: groundY + floorY, width: 10.4, depth: 6, height: roofY + ro.H + 0.9 };
}
