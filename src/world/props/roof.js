import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { sweep, finalize, rng } from './geom.js';

// Parametric Japanese roofs in a local frame: x = long axis (width W), z = depth D, y up.
// The eave line sits at y = 0 (before corner lift), the ridge at y = H.
//   type 'hip'      yosemune (4 faces, ridge length W − D)
//        'pyramid'  hōgyō (W = D)
//        'irimoya'  hip below + gable panels above, with gable walls (tsuma) at x = ±gableLen/2
//        'gable'    kirizuma (2 faces, full-length ridge), frontExt > 0 → nagare-zukuri front slope
// Profile: height = H · s^pow (s = 0 eave → 1 ridge): steep near the ridge, flattening at the eaves (sori);
// corners lift by `lift` (upswept eave tips). Returns geometries for the caller to assign materials:
//   { top, under, fascia, fringe, gableWall, hafu, ridge, hips, points: { ridgeY, gableBaseY } }

// Thatch options (all off by default, so tiled and shingled roofs are unchanged):
//   courses [{ s0, span, rise }]  stepped layers: from s0 up to s0 + span the slope stands proud by up to `rise`
//                                 (at its lower edge), then drops back at s0 — the trimmed butt ends of a course.
//                                 A function of s only, so neighbouring faces still meet exactly along the hips.
//   rag                           the eave's lower edge hangs unevenly (bundle ends), up to `rag` metres lower
//   fringe                        loose straw hanging below the eave: a strip for an alpha-tested material
function faceGrid({ eA, eB, rA, rB, H, pow, lift, liftPow = 4, segE, segS, thick, jitter, seed, uFrom, run, courses = null, rag = 0, fringe = 0 }) {
  const top = [], under = [], uvs = [], uvu = [], idx = [];
  const rnd = rng(seed);
  const bumps = [];
  for (let k = 0; k < 5; k++) bumps.push([rnd() * 6.28, rnd() * 6.28, 0.6 + rnd() * 1.4, 0.4 + rnd() * 1.1]);
  const ex = eB.x - eA.x, ez = eB.z - eA.z;
  const eLen = Math.hypot(ex, ez) || 1;
  const slopeLen = Math.hypot(run, H);
  // rows along the slope: the regular ones plus the two rows of every course step
  let rows = [];
  for (let j = 0; j <= segS; j++) rows.push(j / segS);
  if (courses) for (const c of courses) rows.push(c.s0, c.s0 - 0.004);
  rows.sort((a, b) => a - b);
  rows = rows.filter((s, i) => s >= 0 && s <= 1 && (i === 0 || s - rows[i - 1] > 1e-4));
  const nS = rows.length - 1;
  const step = (s) => {
    let d = 0;
    if (courses) for (const c of courses) if (s >= c.s0 && s <= c.s0 + c.span) d += c.rise * Math.pow(1 - (s - c.s0) / c.span, 1.5);
    return d;
  };
  const P = (e, s) => {
    const Ex = eA.x + ex * e, Ez = eA.z + ez * e;
    const Rx = rA.x + (rB.x - rA.x) * e, Rz = rA.z + (rB.z - rA.z) * e;
    const x = Ex + (Rx - Ex) * s, z = Ez + (Rz - Ez) * s;
    const c = Math.abs(2 * e - 1);
    let y = H * Math.pow(s, pow) + lift * Math.pow(c, liftPow) * (1 - s) * (1 - s);
    if (jitter) {
      let b = 0;
      for (const [p1, p2, f1, f2] of bumps) b += Math.sin(x * f1 + p1) * Math.sin(z * f2 + p2);
      y += b * jitter * 0.2 * Math.sin(Math.PI * Math.min(1, s * 1.05));
    }
    return [x, y + step(s), z, Ex - Rx, Ez - Rz];
  };
  for (let j = 0; j <= nS; j++) {
    const s = rows[j];
    for (let i = 0; i <= segE; i++) {
      const e = i / segE;
      const [x, y, z] = P(e, s);
      top.push(x, y, z);
      under.push(x, y - thick * (1 - 0.35 * s), z);
      // u along the eave (metres), v down-slope distance from the ridge (tile rows run along v)
      const u = uFrom + e * eLen;
      uvs.push(u, (1 - s) * slopeLen);
      uvu.push(u, (1 - s) * slopeLen);
    }
  }
  const row = segE + 1;
  for (let j = 0; j < nS; j++)
    for (let i = 0; i < segE; i++) {
      const a = j * row + i, b = a + 1, c = a + row, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  const mk = (pos, uv, ix) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(ix);
    g.computeVertexNormals();
    return g;
  };
  // eave fascia: the thickness strip along s = 0 (sampled finer when its lower edge is ragged or fringed)
  const segF = rag || fringe ? segE * 3 : segE;
  const fp = [], fuv = [], fidx = [], hp = [], huv = [], hidx = [];
  const rr = rng(seed * 31 + 7);
  for (let i = 0; i <= segF; i++) {
    const e = i / segF;
    const [x, y, z, ox, oz] = P(e, 0);
    const drop = rag ? rag * Math.pow(rr(), 1.6) : 0;
    const yb = y - thick - drop;
    fp.push(x, y, z, x, yb, z);
    const uu = uFrom + e * eLen;
    fuv.push(uu, 0, uu, thick + drop);
    if (fringe) {
      const ol = Math.hypot(ox, oz) || 1;
      const fl = fringe * (0.45 + 0.9 * rr());
      const out = 0.03;
      hp.push(x + (ox / ol) * out, yb + 0.12, z + (oz / ol) * out, x + (ox / ol) * (out + fl * 0.35), yb - fl, z + (oz / ol) * (out + fl * 0.35));
      huv.push(uu, 0, uu, 1);
    }
  }
  for (let i = 0; i < segF; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    fidx.push(a, b, c, c, b, d);
    if (fringe) hidx.push(a, b, c, c, b, d);
  }
  const fascia = mk(fp, fuv, fidx);
  const fringeGeo = fringe ? mk(hp, huv, hidx) : null;
  return { top: mk(top, uvs, idx), under: mk(under, uvu, idx.slice().reverse()), fascia, fringe: fringeGeo, pts: top, row, segS: nS };
}

// Points of a face grid column e (0..segE) from eave to ridge (for hip ridges).
function column(face, i) {
  const out = [];
  for (let j = 0; j <= face.segS; j++) {
    const k = (j * face.row + i) * 3;
    out.push(new THREE.Vector3(face.pts[k], face.pts[k + 1], face.pts[k + 2]));
  }
  return out;
}

export function buildRoof(o) {
  const {
    W, D, H,
    type = 'hip',
    pow = 1.35,
    lift = 0.3,
    thick = 0.3,
    segE = 16,
    segS = 10,
    gableLen = W * 0.62,
    gableOver = 0.5,
    frontExt = 0,
    jitter = 0,
    seed = 1,
    ridgeH = 0.4,
    ridgeW = 0.45,
    hipW = 0.26,
    liftPow = 4,
    courses = null,
    rag = 0,
    fringe = 0,
  } = o;
  const hw = W / 2, hd = D / 2;
  const tops = [], unders = [], fascias = [], fringes = [], hips = [], hafu = [], gableWall = [];
  const V = (x, z) => ({ x, z });
  let ridgeFrom, ridgeTo;
  const common = { H, pow, lift, liftPow, segS, thick, jitter, courses, rag, fringe };

  if (type === 'gable') {
    const zf = hd + frontExt;
    const front = faceGrid({ ...common, eA: V(-hw, zf), eB: V(hw, zf), rA: V(-hw, 0), rB: V(hw, 0), segE, seed, uFrom: -hw, run: zf });
    const back = faceGrid({ ...common, eA: V(hw, -hd), eB: V(-hw, -hd), rA: V(hw, 0), rB: V(-hw, 0), segE, seed: seed + 1, uFrom: -hw, run: hd });
    for (const f of [front, back]) {
      tops.push(f.top);
      unders.push(f.under);
      fascias.push(f.fascia);
      if (f.fringe) fringes.push(f.fringe);
    }
    // bargeboards along both gable edges (front + back slope), following the curve
    for (const sx of [-1, 1]) {
      const iF = sx < 0 ? 0 : segE, iB = sx < 0 ? segE : 0;
      const pts = column(front, iF).concat(column(back, iB).reverse().slice(1));
      for (const p of pts) p.y -= thick * 0.2;
      hafu.push(sweep(pts, { w: 0.14, h: Math.max(0.28, thick * 1.2) }));
    }
    ridgeFrom = new THREE.Vector3(-hw - 0.1, H, 0);
    ridgeTo = new THREE.Vector3(hw + 0.1, H, 0);
  } else {
    const rh = Math.max(0, (W - D) / 2);
    const f1 = faceGrid({ ...common, eA: V(-hw, hd), eB: V(hw, hd), rA: V(-rh, 0), rB: V(rh, 0), segE, seed, uFrom: -hw, run: hd });
    const f2 = faceGrid({ ...common, eA: V(hw, -hd), eB: V(-hw, -hd), rA: V(rh, 0), rB: V(-rh, 0), segE, seed: seed + 1, uFrom: -hw, run: hd });
    const segEnd = Math.max(6, Math.round(segE * (D / W)));
    const f3 = faceGrid({ ...common, eA: V(hw, hd), eB: V(hw, -hd), rA: V(rh, 0), rB: V(rh, 0), segE: segEnd, seed: seed + 2, uFrom: -hd, run: hd });
    const f4 = faceGrid({ ...common, eA: V(-hw, -hd), eB: V(-hw, hd), rA: V(-rh, 0), rB: V(-rh, 0), segE: segEnd, seed: seed + 3, uFrom: -hd, run: hd });
    for (const f of [f1, f2, f3, f4]) {
      tops.push(f.top);
      unders.push(f.under);
      fascias.push(f.fascia);
      if (f.fringe) fringes.push(f.fringe);
    }
    // hip ridges along the four diagonals (from the corners up to the ridge ends)
    const hipLines = [column(f1, 0), column(f1, segE), column(f2, 0), column(f2, segE)];
    let gableBase = null;
    if (type === 'irimoya') {
      // hip ends only below the gable: z-extent of the gable panels and gable base height
      const zg = hd - (hw - gableLen / 2);
      if (zg > 0.2) {
        const sG = (hw - gableLen / 2) / hd;
        gableBase = H * Math.pow(sG, pow);
        const gx = gableLen / 2 + gableOver;
        const eps = 0.05;
        for (const side of [1, -1]) {
          const segZ = 8;
          const pos = [], uv = [], ix = [], posU = [];
          for (let j = 0; j <= segZ; j++) {
            const z = side * zg * (1 - j / segZ); // eave side of the panel → ridge
            const s = 1 - Math.abs(z) / hd;
            const y = H * Math.pow(s, pow) + eps;
            for (let i = 0; i <= segE; i++) {
              const x = -gx + (2 * gx * i) / segE;
              pos.push(x, y, z);
              posU.push(x, y - thick * 0.8, z);
              uv.push(x, (1 - s) * Math.hypot(hd, H));
            }
          }
          const row = segE + 1;
          for (let j = 0; j < segZ; j++)
            for (let i = 0; i < segE; i++) {
              const a = j * row + i, b = a + 1, c = a + row, d = c + 1;
              if (side > 0) ix.push(a, b, c, b, d, c);
              else ix.push(a, c, b, b, c, d);
            }
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
          g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
          g.setIndex(ix);
          g.computeVertexNormals();
          tops.push(g);
          const gu = new THREE.BufferGeometry();
          gu.setAttribute('position', new THREE.Float32BufferAttribute(posU, 3));
          gu.setAttribute('uv', new THREE.Float32BufferAttribute(uv.slice(), 2));
          gu.setIndex(ix.slice().reverse());
          gu.computeVertexNormals();
          unders.push(gu);
        }
        // gable walls (vertical, at x = ±gableLen/2) and bargeboards on the panel ends
        for (const sx of [-1, 1]) {
          const x = sx * gableLen / 2;
          const segZ = 12;
          const pos = [], uv = [], ix = [];
          for (let j = 0; j <= segZ; j++) {
            const z = -zg + (2 * zg * j) / segZ;
            const s = 1 - Math.abs(z) / hd;
            const yTop = H * Math.pow(s, pow);
            pos.push(x, gableBase - 0.05, z, x, yTop, z);
            uv.push(z, gableBase, z, yTop);
          }
          for (let j = 0; j < segZ; j++) {
            const a = j * 2, b = a + 1, c = a + 2, d = a + 3;
            if (sx > 0) ix.push(a, b, c, b, d, c);
            else ix.push(a, c, b, b, c, d);
          }
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
          g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
          g.setIndex(ix);
          g.computeVertexNormals();
          gableWall.push(g);
          const pts = [];
          for (let j = 0; j <= 16; j++) {
            const z = -zg + (2 * zg * j) / 16;
            const s = 1 - Math.abs(z) / hd;
            pts.push(new THREE.Vector3(sx * gx, H * Math.pow(s, pow) - 0.08, z));
          }
          // flared tips
          pts[0].y -= 0.12;
          pts[pts.length - 1].y -= 0.12;
          hafu.push(sweep(pts, { w: 0.12, h: 0.36 }));
        }
        ridgeFrom = new THREE.Vector3(-gx, H + eps, 0);
        ridgeTo = new THREE.Vector3(gx, H + eps, 0);
        // hips run only up to the gable base
        for (const line of hipLines) {
          const cut = line.filter((p) => p.y <= gableBase + 0.3);
          if (cut.length > 1) hips.push(sweep(cut.map((p) => p.clone().setY(p.y + 0.08)), { w: hipW, h: hipW * 0.9 }));
        }
      }
    }
    if (!ridgeFrom) {
      for (const line of hipLines) hips.push(sweep(line.map((p) => p.clone().setY(p.y + 0.08)), { w: hipW, h: hipW * 0.9 }));
      ridgeFrom = new THREE.Vector3(-rh - 0.05, H, 0);
      ridgeTo = new THREE.Vector3(rh + 0.05, H, 0);
    }
    o._gableBase = gableBase;
  }

  // ridge beam
  let ridge = null;
  const rl = ridgeFrom.distanceTo(ridgeTo);
  if (rl > 0.05) {
    ridge = new THREE.BoxGeometry(rl + ridgeW * 0.6, ridgeH, ridgeW, 8, 1, 1);
    ridge.translate((ridgeFrom.x + ridgeTo.x) / 2, H + ridgeH * 0.35, 0);
  } else {
    ridge = new THREE.CylinderGeometry(ridgeW * 0.55, ridgeW * 0.8, ridgeH * 1.4, 8);
    ridge.translate(0, H + ridgeH * 0.3, 0);
  }
  const merge = (list) => (list.length ? mergeGeometries(list.map((g) => finalize(g)), false) : null);
  return {
    top: merge(tops),
    under: merge(unders),
    fascia: merge(fascias),
    fringe: merge(fringes),
    gableWall: merge(gableWall),
    hafu: merge(hafu),
    ridge: finalize(ridge),
    hips: merge(hips),
    ridgeFrom,
    ridgeTo,
    gableBase: o._gableBase ?? null,
  };
}

// Height of the roof surface above the eave line at local (x, z) — used to seat ridges/ornaments.
export function roofHeightAt(o, x, z) {
  const { W, D, H, pow = 1.35 } = o;
  const hw = W / 2, hd = D / 2;
  const dist = Math.min(hd - Math.abs(z), hw - Math.abs(x));
  const s = Math.max(0, Math.min(1, dist / hd));
  return H * Math.pow(s, pow);
}
