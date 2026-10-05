import * as THREE from 'three';
import { rng, clamp, smoothstep } from '../../core/math.js';
import { CELLS, cellUV } from './textures.js';

// Procedural tree generator. A species "grower" builds a skeleton (tapered branch polylines with a wind
// weight and phase that are continuous from parent to child) plus foliage cards grouped in clumps; the
// builder turns it into
//   bark geometry  : parallel-transport tubes (position, normal, uv, color = AO, aWind)
//   leaf geometry  : alpha cards from the atlas (position, normal = soft crown/clump normal, uv,
//                    color = tint × AO, aWind)
// for LOD0 (full) and LOD1 (trunk + main limbs, fewer and larger cards).
// aWind = (x: height term for trunk sway, y: branch weight, z: phase, w: leaf flutter)
// Broadleaf crowns are many small cards (~0.7 m at scale 1, each a mass of small painted leaves) packed into
// clumps; every branch tip carries a clump and limbs end inside the crown envelope, so no bare twig or leader
// sticks out of the foliage (scripts/trees.test.mjs).

const V3 = THREE.Vector3;
const UP = new V3(0, 1, 0);

class Skeleton {
  constructor(rand) {
    this.rand = rand;
    this.branches = []; // { pts, rads, level, w0, w1, ph0, ph1 }
    this.leaves = []; // { p, dir, size, cell, tint, w, ph, keep1, n?, ao? }
    this.clumps = []; // { c, rx, ry, size, cells, weights, tintFn, w, ph } — LOD1 draws one card pair per clump
  }

  R(a, b) {
    return a + (b - a) * this.rand();
  }

  // Grow a curved polyline. upturn > 0 bends the tip upward, < 0 droops it.
  curve(start, dir, length, segs, { upturn = 0, noise = 0.08, pull = null, pullK = 0 } = {}) {
    const pts = [start.clone()];
    const d = dir.clone().normalize();
    const p = start.clone();
    const step = length / segs;
    for (let i = 1; i <= segs; i++) {
      d.y += upturn / segs;
      d.x += (this.rand() - 0.5) * noise;
      d.z += (this.rand() - 0.5) * noise;
      d.y += (this.rand() - 0.5) * noise * 0.5;
      if (pull) d.addScaledVector(pull, pullK / segs);
      d.normalize();
      p.addScaledVector(d, step);
      pts.push(p.clone());
    }
    return pts;
  }

  // Add a branch; radius tapers r0 → r1; wind weight/phase run from the parent's values at the attach point.
  branch(pts, r0, r1, level, w0, dw, ph0, dph) {
    const n = pts.length;
    const rads = pts.map((_, i) => r0 + (r1 - r0) * Math.pow(i / (n - 1), 0.9));
    const b = { pts, rads, level, w0, w1: w0 + dw, ph0, ph1: ph0 + dph };
    this.branches.push(b);
    return b;
  }

  // Point, tangent, radius, weight and phase at fraction t along a branch.
  at(b, t) {
    const n = b.pts.length - 1;
    const f = clamp(t, 0, 1) * n;
    const i = Math.min(n - 1, Math.floor(f));
    const k = f - i;
    const p = b.pts[i].clone().lerp(b.pts[i + 1], k);
    const d = b.pts[i + 1].clone().sub(b.pts[i]).normalize();
    const r = b.rads[i] + (b.rads[i + 1] - b.rads[i]) * k;
    return { p, d, r, w: b.w0 + (b.w1 - b.w0) * t, ph: b.ph0 + (b.ph1 - b.ph0) * t };
  }

  leaf(p, dir, size, cell, tint, w, ph, extra) {
    const L = { p: p.clone(), dir: dir.clone().normalize(), size, cell, tint, w, ph, keep1: this.rand() };
    if (extra) Object.assign(L, extra);
    this.leaves.push(L);
    return L;
  }

  // A foliage clump: n cards through a flattened ellipsoid around c (mostly toward its shell), facing outward
  // (+ `up` bias). Cards hang from their attach point upward, so the shell is lowered by ~0.35 card sizes.
  // Returns the clump record (LOD1 draws it as one crossed card pair of size `lod1`, default 2.1 × radius).
  clump(c, rx, ry, n, size, cells, weights, tintFn, w, ph, up = 0.4) {
    const K = { c: c.clone(), rx, ry, size, lod1: 2.1 * Math.max(rx, ry), cells, weights, tintFn, w, ph };
    this.clumps.push(K);
    for (let i = 0; i < n; i++) {
      const az = this.R(0, Math.PI * 2);
      const el = Math.asin(this.R(-0.55, 1));
      const d = new V3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
      const r = 0.25 + 0.75 * Math.sqrt(this.rand());
      const s = size * this.R(0.8, 1.2);
      const p = c.clone().add(new V3(d.x * rx * r, d.y * ry * r - s * 0.35, d.z * rx * r));
      this.leaf(p, d.clone().add(new V3(0, up, 0)), s, pick(this, cells, weights), tintFn(this), w, ph, {
        fromClump: true,
        n: d,
        ao: 0.72 + 0.28 * r * (0.6 + 0.4 * Math.max(0, d.y)),
      });
    }
    return K;
  }
}

const horiz = (az) => new V3(Math.cos(az), 0, Math.sin(az));
const tilt = (az, elev) => new V3(Math.cos(az) * Math.cos(elev), Math.sin(elev), Math.sin(az) * Math.cos(elev));

function pick(sk, arr, w) {
  let r = sk.rand(), acc = 0;
  for (let i = 0; i < arr.length; i++) {
    acc += w[i];
    if (r < acc) return arr[i];
  }
  return arr[arr.length - 1];
}

// Species growers (meters). Return { flex, kind, barkLod1 }.

// Normalised radius of p in a crown envelope (ellipsoid centre C, radii R; taper > 0 narrows it toward the top).
function envelopeQ(p, C, R, taper = 0) {
  const dy = (p.y - C.y) / R.y;
  const tp = 1 - taper * (clamp(dy, -1, 1) + 1) * 0.5;
  return Math.hypot((p.x - C.x) / (R.x * tp), dy, (p.z - C.z) / (R.z * tp));
}

// Cut a limb where it leaves the crown envelope (q > qMax) after having been inside it, so limbs end in the
// foliage instead of poking out of it.
function clipToEnvelope(pts, C, R, taper, qMax) {
  let inside = false;
  for (let i = 0; i < pts.length; i++) {
    const q = envelopeQ(pts[i], C, R, taper);
    if (q <= qMax) inside = true;
    else if (inside) {
      const q0 = envelopeQ(pts[i - 1], C, R, taper);
      const out = pts.slice(0, i);
      out.push(pts[i - 1].clone().lerp(pts[i], (qMax - q0) / (q - q0)));
      return out;
    }
  }
  return pts;
}

// Fill a crown envelope (ellipsoid centre C, radii R) with foliage clumps. Each clump is fed by a twig
// from the nearest point of the given limbs, so no clump floats and the wind weight/phase stay continuous.
// o.tips: branches whose tip carries a clump (placed first, counted in n), so no bare leader or limb end shows;
// o.lod1: LOD1 card size per clump radius (+ half a card), for the aggregate cards to keep the clump's mass.
function attachClumps(sk, limbs, C, R, n, o) {
  const samples = [];
  for (const b of limbs) for (let t = 0.3; t <= 1.0001; t += 0.1) samples.push(sk.at(b, t));
  const clump = (P, w, ph) => {
    const K = sk.clump(P, o.rx * sk.R(0.8, 1.2), o.ry * sk.R(0.8, 1.2), o.per + Math.floor(sk.rand() * 3), o.size, o.cells, o.weights, o.tint, w, ph, o.up ?? 0.5);
    if (o.lod1) K.lod1 = 2 * o.lod1 * (Math.max(K.rx, K.ry) + 0.5 * K.size);
  };
  const tips = o.tips || [];
  for (const b of tips) {
    const e = sk.at(b, 1);
    clump(e.p.clone().add(new V3(0, o.ry * 0.2, 0)), e.w, e.ph);
  }
  for (let i = tips.length; i < n; i++) {
    const az = sk.R(0, Math.PI * 2);
    const el = Math.asin(sk.R(o.elMin ?? -0.45, 1));
    const d = new V3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
    const shell = sk.rand() < (o.inner ?? 0.2) ? sk.R(0.25, 0.6) : sk.R(0.7, 1.0);
    // taper > 0 narrows the envelope toward the top (egg / cone crowns)
    const tp = 1 - (o.taper ?? 0) * (d.y + 1) * 0.5;
    const P = new V3(C.x + d.x * R.x * shell * tp, C.y + d.y * R.y * shell, C.z + d.z * R.z * shell * tp);
    let a = samples[0], bd = Infinity;
    for (const smp of samples) {
      const dd = smp.p.distanceToSquared(P);
      if (dd < bd) {
        bd = dd;
        a = smp;
      }
    }
    let w = a.w, ph = a.ph;
    const dir = P.clone().sub(a.p);
    const len = dir.length();
    if (len > 0.5) {
      const tw = sk.branch(sk.curve(a.p, dir, len * 0.9, 3, { noise: 0.12 }), Math.max(0.018, a.r * 0.45), 0.01, 2, a.w, 0.4, a.ph, sk.R(0.5, 1.5));
      const e = sk.at(tw, 1);
      w = e.w;
      ph = e.ph;
    }
    clump(P, w, ph);
  }
}

const MAPLE_CELLS = [CELLS.mapleA, CELLS.mapleB, CELLS.mapleC];
const MAPLE_W = [0.42, 0.33, 0.25];

function mapleTint(sk) {
  // crimson; a few cards lean red-orange; brightness varies per card
  const b = 0.8 + sk.rand() * 0.32;
  const warm = sk.rand() < 0.08 ? 1.08 : 1.0;
  return [b * 1.02, b * (0.9 + 0.12 * sk.rand()) * warm, b * (0.9 + 0.1 * sk.rand())];
}

// Momiji: short trunk, 4–5 spreading gnarled leaders, a broad rounded dome of dense crimson clumps.
function growMaple(sk, big = 1) {
  const R = (a, b) => sk.R(a, b);
  const trunkLen = R(1.3, 2.2) * big;
  const baseR = R(0.22, 0.32) * big;
  const leanDir = horiz(R(0, Math.PI * 2));
  const lean = leanDir.clone().multiplyScalar(R(0.05, 0.25)).add(UP);
  const trunkPts = sk.curve(new V3(0, -0.3, 0), lean, trunkLen + 0.3, 4, { noise: 0.06 });
  sk.branch(trunkPts, baseR * 1.4, baseR * 0.9, 0, 0, 0, R(0, 6.28), 0);
  const top = trunkPts[trunkPts.length - 1];
  const Rx = R(4.0, 5.0) * big, Ry = R(2.6, 3.2) * big;
  const C = top.clone().add(new V3(leanDir.x * 0.5 * big, Ry * 0.8, leanDir.z * 0.5 * big));
  const Rv = new V3(Rx, Ry, Rx * R(0.9, 1.1));
  const limbs = [];
  const nLead = 4 + Math.floor(sk.rand() * 2);
  const az0 = R(0, Math.PI * 2);
  for (let l = 0; l < nLead; l++) {
    const az = az0 + (l / nLead) * Math.PI * 2 + R(-0.3, 0.3);
    const len = R(3.4, 4.4) * big;
    const lp = clipToEnvelope(sk.curve(top, tilt(az, R(0.45, 0.85)), len, 7, { upturn: -0.2, noise: 0.2 }), C, Rv, 0, 0.95);
    const lead = sk.branch(lp, baseR * 0.7, baseR * 0.18, 1, 0.05, 0.4, R(0, 6.28), R(0.5, 1.5));
    limbs.push(lead);
    const a = sk.at(lead, R(0.35, 0.6));
    const sp = clipToEnvelope(sk.curve(a.p, tilt(az + R(-1.2, 1.2), R(0.1, 0.5)), len * R(0.5, 0.7), 4, { upturn: 0.2, noise: 0.2 }), C, Rv, 0, 0.95);
    limbs.push(sk.branch(sp, a.r * 0.6, 0.03, 2, a.w, 0.4, a.ph, R(0.5, 1.5)));
  }
  attachClumps(sk, limbs, C, Rv, Math.round(R(36, 42)), {
    rx: 1.3 * big, ry: 0.85 * big, per: 19, size: R(0.62, 0.72) * big, tips: limbs, lod1: 1.0,
    cells: MAPLE_CELLS, weights: MAPLE_W, tint: mapleTint, up: 0.8, inner: 0.25, elMin: -0.5,
  });
  return { flex: 0.8, kind: 'maple', barkLod1: 1 };
}

const GINKGO_CELLS = [CELLS.ginkgoA, CELLS.ginkgoB];

function ginkgoTint(sk) {
  const green = sk.rand() < 0.03;
  const b = 0.84 + sk.rand() * 0.28;
  return green ? [0.85 * b, 0.97 * b, 0.6 * b] : [b, b * (0.94 + 0.08 * sk.rand()), b * 0.9];
}

// Ginkgo: tall straight dark trunk, ascending limbs, a big dense ovate crown of golden clumps; the leader ends
// inside the top clump.
// shape 'columnar': taller, a narrow egg-shaped crown on steeply ascending limbs, clear trunk below.
function growGinkgo(sk, big = 1, opts = {}) {
  const R = (a, b) => sk.R(a, b);
  const col = opts.shape === 'columnar';
  const H = (col ? R(21, 25) : R(15, 19)) * big;
  const baseR = R(0.42, 0.56) * big;
  const tp = sk.curve(new V3(0, -0.3, 0), new V3(R(-0.04, 0.04), 1, R(-0.04, 0.04)), H * 0.9 + 0.3, 10, { noise: 0.025 });
  const trunk = sk.branch(tp, baseR * 1.25, 0.08, 0, 0, 0.25, R(0, 6.28), R(0.3, 0.8));
  const Rxz = (col ? R(3.7, 4.4) : R(5.2, 6.4)) * big, Ry = H * (col ? R(0.41, 0.44) : R(0.37, 0.41));
  const mid = sk.at(trunk, 0.6).p;
  const C = new V3(mid.x, H * (col ? 0.56 : 0.58), mid.z);
  const Rv = new V3(Rxz, Ry, Rxz * R(0.9, 1.1));
  const taper = col ? 0.38 : 0;
  const limbs = [trunk];
  let az = R(0, 6.28);
  const n = Math.floor(col ? R(15, 19) : R(12, 16));
  for (let k = 0; k < n; k++) {
    const t = (col ? 0.2 : 0.3) + (k / n) * (col ? 0.72 : 0.6);
    const a = sk.at(trunk, t);
    az += 2.39996 + R(-0.3, 0.3);
    const dy = (a.p.y - C.y) / Ry;
    const reach = Rxz * Math.sqrt(Math.max(0.15, 1 - dy * dy)) * R(0.7, 0.95) * (col ? 1 - 0.3 * (t - 0.2) : 1);
    const el = col ? R(0.95, 1.25) : R(0.55, 0.95);
    // limbs wander a little and end well inside the foliage (the branches show inside the crown, they do not
    // pierce its surface as straight dark sticks)
    const bp = clipToEnvelope(sk.curve(a.p, tilt(az, el), reach / Math.cos(el), 5, { upturn: 0.1, noise: 0.16 }), C, Rv, taper, 0.8);
    limbs.push(sk.branch(bp, Math.max(0.04, a.r * 0.45), 0.025, 1, a.w, 0.5, a.ph, R(0.5, 1.4)));
  }
  // many small cards per clump: a fine, even leaf mass instead of bunches of big cluster cards; the clumps a
  // little tighter, so the crown keeps its extent with more cards reaching toward their shells
  attachClumps(sk, limbs, C, Rv, Math.round(col ? R(104, 114) : R(98, 108)), {
    rx: (col ? 1.3 : 1.54) * big, ry: (col ? 1.25 : 1.2) * big, per: 30, size: R(0.52, 0.6) * big, tips: limbs, lod1: 1.0,
    cells: GINKGO_CELLS, weights: [0.5, 0.5], tint: ginkgoTint, up: 0.4, inner: col ? 0.38 : 0.32, elMin: -0.75, taper,
  });
  return { flex: 0.95, kind: 'ginkgo', barkLod1: 1 };
}

// Japanese black pine: leaning, twisting trunk; tiered horizontal limbs ending in dark cloud pads.
function growPine(sk, big = 1) {
  const R = (a, b) => sk.R(a, b);
  const H = R(8, 12) * big;
  const baseR = R(0.22, 0.32) * big;
  const lean = horiz(R(0, 6.28)).multiplyScalar(R(0.15, 0.45)).add(UP);
  const tp = sk.curve(new V3(0, -0.3, 0), lean, H * 0.92, 9, { noise: 0.28, pull: UP, pullK: 0.35 });
  const trunk = sk.branch(tp, baseR * 1.25, 0.07, 0, 0, 0.3, R(0, 6.28), R(0.3, 0.7));
  const n = 5 + Math.floor(sk.rand() * 3);
  let az = R(0, 6.28);
  for (let k = 0; k < n; k++) {
    const t = 0.4 + (k / n) * 0.55;
    const a = sk.at(trunk, t);
    az += R(1.6, 2.8);
    const len = R(2.0, 3.8) * (1.1 - t * 0.6) * big;
    const bp = sk.curve(a.p, tilt(az, R(-0.15, 0.2)), len, 5, { upturn: 0.25, noise: 0.22 });
    const br = sk.branch(bp, Math.max(0.045, a.r * 0.5), 0.03, 1, a.w, 0.4, a.ph, R(0.6, 1.6));
    pad(sk, sk.at(br, 1), R(1.4, 2.0) * big);
    if (sk.rand() < 0.5) pad(sk, sk.at(br, 0.55), R(1.0, 1.4) * big);
  }
  pad(sk, sk.at(trunk, 1), R(1.5, 2.0) * big);
  return { flex: 0.6, kind: 'pine', barkLod1: 0 };
}

// conifers are the dark counterpoint of the autumn crowns: deep needle greens, with little light getting through
function pineTint(sk) {
  const t = 0.4 + sk.rand() * 0.2;
  return [t, t, t * 0.95];
}

// Cloud pad: a flattened, rounded clump of needle cards facing every way (reads as a mass from any angle).
function pad(sk, b, radius) {
  sk.clump(b.p.clone().add(new V3(0, radius * 0.18, 0)), radius, radius * 0.45, Math.round(8 + radius * 4), sk.R(0.95, 1.25) * (0.7 + radius * 0.2), [CELLS.pinePad, CELLS.pineSpray], [0.5, 0.5], pineTint, b.w, b.ph, 0.9);
}

function cedarTint(sk) {
  const b = 0.45 + sk.rand() * 0.2;
  return sk.rand() < 0.06 ? [1.25 * b, 0.9 * b, 0.65 * b] : [b, b, b];
}

// Sugi: tall straight dark-red trunk, a narrow cone of short drooping branches wrapped in dense sprays.
function growCedar(sk, big = 1) {
  const R = (a, b) => sk.R(a, b);
  const H = R(20, 27) * big;
  const baseR = R(0.36, 0.5) * big;
  const tp = sk.curve(new V3(0, -0.3, 0), new V3(R(-0.02, 0.02), 1, R(-0.02, 0.02)), H + 0.3, 12, { noise: 0.015 });
  const trunk = sk.branch(tp, baseR * 1.3, 0.05, 0, 0, 0.3, R(0, 6.28), R(0.3, 0.8));
  const clear = R(0.2, 0.3);
  let az = R(0, 6.28);
  const whorls = Math.floor(R(22, 28));
  for (let k = 0; k < whorls; k++) {
    const t = clear + (k / whorls) * (0.97 - clear);
    const hn = (t - clear) / (1 - clear);
    const per = 3 + (sk.rand() < 0.5 ? 1 : 0);
    for (let j = 0; j < per; j++) {
      az += 2.39996 + R(-0.3, 0.3);
      const a = sk.at(trunk, t);
      const len = (0.6 + 2.8 * Math.pow(1 - hn, 0.85)) * R(0.8, 1.2) * big;
      const bp = sk.curve(a.p, tilt(az, R(-0.4, 0.02)), len, 3, { upturn: 0.18, noise: 0.1 });
      const br = sk.branch(bp, Math.max(0.025, a.r * 0.22), 0.012, 1, a.w, 0.35, a.ph, R(0.5, 1.3));
      const b0 = sk.at(br, 0.05), b1 = sk.at(br, 1);
      const axis = b1.p.clone().sub(b0.p).normalize();
      const out = axis.clone().setY(0).normalize();
      const size = Math.max(1.0, len * 1.2) * R(0.95, 1.1);
      const roll0 = R(0, Math.PI);
      for (let m = 0; m < 3; m++) {
        sk.leaf(b0.p, axis, size, pick(sk, [CELLS.cedarA, CELLS.cedarB], [0.5, 0.5]), cedarTint(sk), b0.w, b0.ph, {
          axis, roll: roll0 + (m * Math.PI) / 3 + R(-0.15, 0.15), n: out.clone().add(new V3(0, 0.35, 0)).normalize(), ao: 0.8,
        });
      }
      if (len > 1.2) sk.leaf(b1.p.clone().add(new V3(0, -0.3, 0)), out.clone().add(new V3(0, 0.4, 0)), R(0.9, 1.2) * big, CELLS.cedarB, cedarTint(sk), b1.w, b1.ph, { n: out, ao: 1 });
    }
  }
  const e = sk.at(trunk, 1);
  // leader spray wrapped around the tip (cards along the trunk axis, ~0.26 card above it): no bare leader on top
  const topS = R(1.1, 1.4) * big;
  for (let m = 0; m < 3; m++)
    sk.leaf(e.p.clone().add(new V3(0, -topS * 0.62, 0)), UP, topS, CELLS.cedarA, cedarTint(sk), e.w, e.ph, { axis: UP, roll: (m * Math.PI) / 3 + R(-0.2, 0.2), n: UP, ao: 1 });
  for (let m = 0; m < 6; m++) sk.leaf(e.p.clone().add(new V3(0, -1.0 - m * 0.35, 0)), new V3(R(-0.5, 0.5), 1, R(-0.5, 0.5)), R(1.0, 1.3) * big, CELLS.cedarA, cedarTint(sk), e.w, e.ph, { n: UP, ao: 1 });
  return { flex: 0.7, kind: 'cedar', barkLod1: 0 };
}

// Bamboo clump: many slender culms, foliage fans on the upper half (heavy flex: sways a lot).
function growBamboo(sk, big = 1) {
  const R = (a, b) => sk.R(a, b);
  const culms = 10 + Math.floor(sk.rand() * 9);
  const clumpR = R(1.2, 2.2);
  for (let c = 0; c < culms; c++) {
    const ang = R(0, 6.28), r = Math.sqrt(sk.rand()) * clumpR;
    const base = new V3(Math.cos(ang) * r, -0.2, Math.sin(ang) * r);
    const H = R(8, 13) * big;
    const lean = new V3(Math.cos(ang) * r * 0.03 + R(-0.05, 0.05), 1, Math.sin(ang) * r * 0.03 + R(-0.05, 0.05));
    const cp = sk.curve(base, lean, H, 8, { noise: 0.02, upturn: -0.12 });
    const culm = sk.branch(cp, R(0.035, 0.06), 0.02, 0, 0, 0.9, R(0, 6.28), R(0.6, 1.4));
    culm.bamboo = R(0.28, 0.42);
    const nL = Math.round(R(14, 20));
    for (let m = 0; m < nL; m++) {
      const b = sk.at(culm, 0.4 + (m / nL) * 0.6);
      const side = horiz(R(0, 6.28));
      sk.leaf(b.p.clone().addScaledVector(side, 0.15), side.clone().add(new V3(0, R(-0.2, 0.6), 0)), R(0.8, 1.2), CELLS.bamboo, [0.9 + sk.rand() * 0.25, 0.9 + sk.rand() * 0.25, 0.85], b.w, b.ph);
    }
  }
  return { flex: 1.35, kind: 'bamboo', barkLod1: 0 };
}

function growShrub(sk, big = 1, opts = {}) {
  const R = (a, b) => sk.R(a, b);
  const cells = opts.cells || [CELLS.shrub, CELLS.shrubB];
  const rad = R(0.8, 1.4) * big, h = R(0.8, 1.5) * big;
  const stems = 4 + Math.floor(sk.rand() * 4);
  for (let s = 0; s < stems; s++) {
    const sp = sk.curve(new V3(0, -0.1, 0), tilt(R(0, 6.28), R(0.7, 1.2)), h, 3, { noise: 0.2 });
    sk.branch(sp, 0.03, 0.01, 1, 0, 0.5, R(0, 6.28), 1);
  }
  const n = Math.round(24 + rad * 16);
  for (let i = 0; i < n; i++) {
    const az = R(0, 6.28), el = R(-0.1, 1.3);
    const d = tilt(az, el);
    const p = new V3(d.x * rad * R(0.35, 0.9), 0.1 + h * (0.3 + 0.55 * Math.sin(el) * R(0.6, 1.0)), d.z * rad * R(0.35, 0.9));
    const b = 0.85 + sk.rand() * 0.3;
    sk.leaf(p, d, R(0.8, 1.2) * big, cells[i % cells.length], [b, b, b], 0.5 + 0.3 * (p.y / h), R(0, 6.28), { n: d, ao: 0.7 + 0.3 * Math.max(0, d.y) });
  }
  return { flex: 0.5, kind: 'shrub', barkLod1: 1 };
}

export const GROWERS = { maple: growMaple, ginkgo: growGinkgo, pine: growPine, cedar: growCedar, bamboo: growBamboo, shrub: growShrub };

// Geometry builders
class GeoBuf {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.col = [];
    this.wind = [];
    this.idx = [];
  }
  get count() {
    return this.pos.length / 3;
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aWind', new THREE.Float32BufferAttribute(this.wind, 4));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

// Bark in the crown's shade (the foliage blocks the sky): limbs darken toward the crown core, and the trunk under
// the canopy loses the sky overhead, so the branch structure reads dark through and below the lit leaves.
function crownShade(p, crown) {
  const dx = (p.x - crown.c.x) / crown.r.x, dz = (p.z - crown.c.z) / crown.r.z;
  const inside = 0.45 + 0.55 * smoothstep(0.3, 1.0, Math.hypot(dx, (p.y - crown.c.y) / crown.r.y, dz));
  const under = p.y < crown.c.y ? 0.6 + 0.4 * smoothstep(0.35, 1.1, Math.hypot(dx, dz)) : 1;
  return Math.min(inside, under);
}

function tube(buf, b, radial, H, flex, lodSimplify, crown) {
  let pts = b.pts, rads = b.rads;
  if (lodSimplify && pts.length > 3) {
    const keep = [0];
    for (let i = 2; i < pts.length - 1; i += 2) keep.push(i);
    keep.push(pts.length - 1);
    pts = keep.map((i) => b.pts[i]);
    rads = keep.map((i) => b.rads[i]);
  }
  const n = pts.length;
  const T = [], N = [], B = [];
  for (let i = 0; i < n; i++) T.push(pts[Math.min(n - 1, i + 1)].clone().sub(pts[Math.max(0, i - 1)]).normalize());
  const nrm = Math.abs(T[0].y) > 0.9 ? new V3(1, 0, 0) : new V3(0, 1, 0);
  nrm.sub(T[0].clone().multiplyScalar(nrm.dot(T[0]))).normalize();
  N.push(nrm);
  B.push(T[0].clone().cross(nrm));
  for (let i = 1; i < n; i++) {
    const axis = T[i - 1].clone().cross(T[i]);
    const l = axis.length();
    const ni = N[i - 1].clone();
    if (l > 1e-6) ni.applyAxisAngle(axis.divideScalar(l), Math.acos(clamp(T[i - 1].dot(T[i]), -1, 1)));
    N.push(ni);
    B.push(T[i].clone().cross(ni));
  }
  const base = buf.count;
  const circ = 2 * Math.PI * rads[0];
  const uRep = b.bamboo ? 1 : Math.max(1, Math.round(circ / 0.9));
  const vScale = b.bamboo ? 1 / b.bamboo : 1 / 1.8;
  let s = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) s += pts[i].distanceTo(pts[i - 1]);
    const t = i / (n - 1);
    const w = b.w0 + (b.w1 - b.w0) * t;
    const ph = b.ph0 + (b.ph1 - b.ph0) * t;
    for (let k = 0; k <= radial; k++) {
      const a = (k / radial) * Math.PI * 2;
      const c = Math.cos(a), sn = Math.sin(a);
      const nx = N[i].x * c + B[i].x * sn, ny = N[i].y * c + B[i].y * sn, nz = N[i].z * c + B[i].z * sn;
      const p = pts[i];
      const y = p.y + ny * rads[i];
      buf.pos.push(p.x + nx * rads[i], y, p.z + nz * rads[i]);
      buf.nor.push(nx, ny, nz);
      buf.uv.push((k / radial) * uRep, s * vScale);
      // AO: dark at the root (terrain contact) and inside the crown
      const ao = (0.45 + 0.55 * clamp((y + 0.2) / 1.6, 0, 1)) * crownShade(p, crown);
      buf.col.push(ao, ao, ao);
      buf.wind.push(clamp(y / H, 0, 1.2) * flex, w, ph, 0);
    }
  }
  for (let i = 0; i < n - 1; i++)
    for (let k = 0; k < radial; k++) {
      const a = base + i * (radial + 1) + k, bb = a + radial + 1;
      buf.idx.push(a, bb, a + 1, a + 1, bb, bb + 1);
    }
}

function cards(buf, leaves, crown, H, flex, sizeMul, rand) {
  const tmpR = new V3(), tmpU = new V3(), nrm = new V3(), sph = new V3();
  for (const L of leaves) {
    let face;
    if (L.axis) {
      // card "up" runs along a branch (sprays wrapped around it), rolled around the branch axis
      tmpU.copy(L.axis).normalize();
      const ref = Math.abs(tmpU.y) < 0.9 ? UP : new V3(1, 0, 0);
      face = ref.clone().sub(tmpU.clone().multiplyScalar(ref.dot(tmpU))).normalize().applyAxisAngle(tmpU, L.roll || 0);
      tmpR.crossVectors(tmpU, face).normalize();
    } else {
      // card faces outward (L.dir) with a random roll; its bottom edge sits at the attach point
      face = L.dir.clone().add(new V3((rand() - 0.5) * 0.6, (rand() - 0.5) * 0.4, (rand() - 0.5) * 0.6)).normalize();
      let up = L.dir.clone();
      if (Math.abs(up.dot(face)) > 0.95) up = UP.clone();
      tmpR.crossVectors(up, face);
      if (tmpR.lengthSq() < 1e-6) tmpR.set(1, 0, 0);
      tmpR.normalize();
      tmpR.applyAxisAngle(face, (rand() - 0.5) * 1.6);
      tmpU.crossVectors(face, tmpR).normalize();
    }
    const s = L.size * sizeMul;
    const uvr = cellUV(L.cell);
    const flip = rand() < 0.5;
    const u0 = flip ? uvr.u1 : uvr.u0, u1 = flip ? uvr.u0 : uvr.u1;
    // soft normal: crown ellipsoid normal blended with the clump normal (if any) and the card facing
    sph.copy(L.p).sub(crown.c).divide(crown.r);
    if (sph.lengthSq() < 1e-6) sph.set(0, 1, 0);
    const depth = clamp(sph.length(), 0, 1.2);
    sph.normalize();
    if (L.n) nrm.copy(sph).multiplyScalar(0.55).addScaledVector(L.n, 0.33).addScaledVector(face, 0.12);
    else nrm.copy(sph).multiplyScalar(0.8).addScaledVector(face, 0.2);
    nrm.addScaledVector(UP, crown.upBias).normalize();
    // inner and lower cards are darker (self-shadowing of the crown)
    const low = clamp((L.p.y - (crown.c.y - crown.r.y)) / (2 * crown.r.y), 0, 1);
    const ao = (0.5 + 0.5 * clamp(depth, 0, 1)) * (0.78 + 0.22 * low) * (L.ao ?? 1);
    const base = buf.count;
    const off = -0.12 * s; // bury the bottom a little so the twig meets the branch
    const corners = [
      [-0.5, 0, u0, uvr.vBottom],
      [0.5, 0, u1, uvr.vBottom],
      [-0.5, 1, u0, uvr.vTop],
      [0.5, 1, u1, uvr.vTop],
    ];
    for (const [cx, cy, u, v] of corners) {
      const px = L.p.x + tmpR.x * cx * s + tmpU.x * (cy * s + off);
      const py = L.p.y + tmpR.y * cx * s + tmpU.y * (cy * s + off);
      const pz = L.p.z + tmpR.z * cx * s + tmpU.z * (cy * s + off);
      buf.pos.push(px, py, pz);
      buf.nor.push(nrm.x, nrm.y, nrm.z);
      buf.uv.push(u, v);
      buf.col.push(L.tint[0] * ao, L.tint[1] * ao, L.tint[2] * ao);
      buf.wind.push(clamp(py / H, 0, 1.2) * flex, L.w + cy * 0.12, L.ph + cy * 0.3, 0.6 + cy * 0.4);
    }
    buf.idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }
}

// Build a tree variant: returns { lod0: {bark, leaves}, lod1: {bark, leaves}, height, radius, crown, kind }
export function buildTree(kind, seed, big = 1, opts = {}) {
  const rand = rng(seed);
  const sk = new Skeleton(rand);
  const info = (opts.grower || GROWERS[kind])(sk, big, opts);
  const box = new THREE.Box3();
  for (const b of sk.branches) for (const p of b.pts) box.expandByPoint(p);
  const lbox = new THREE.Box3();
  for (const L of sk.leaves) lbox.expandByPoint(L.p);
  if (lbox.isEmpty()) lbox.copy(box);
  box.union(lbox.clone().expandByScalar(1.2));
  const H = Math.max(1, box.max.y);
  const crown = {
    c: lbox.getCenter(new V3()),
    r: lbox.getSize(new V3()).multiplyScalar(0.5).max(new V3(0.8, 0.8, 0.8)),
    upBias: kind === 'maple' ? 0.3 : kind === 'pine' ? 0.4 : 0.15,
  };
  const flex = info.flex;
  const radial = (lvl, lod) => (lod === 0 ? [9, 6, 4, 3][lvl] : [6, 4, 3, 3][lvl]);

  const bark0 = new GeoBuf(), bark1 = new GeoBuf();
  for (const b of sk.branches) {
    tube(bark0, b, radial(b.level, 0) || 3, H, flex, false, crown);
    if (b.level <= (info.barkLod1 ?? 1) || kind === 'bamboo') tube(bark1, b, kind === 'bamboo' ? 3 : radial(b.level, 1), H, flex, true, crown);
  }
  const leaves0 = new GeoBuf(), leaves1 = new GeoBuf();
  cards(leaves0, sk.leaves, crown, H, flex, 1, rng(seed * 7 + 3));
  // LOD1: clumped foliage → one crossed pair of big cluster cards per clump (keeps the crown mass: sized from the
  // clump's radius and card size, see attachClumps); loose cards (cedar sprays, bamboo, shrubs) → ~45% of them,
  // scaled up
  const r1 = rng(seed * 11 + 5);
  const lod1 = [];
  if (sk.clumps.length) {
    for (const K of sk.clumps) {
      const out = K.c.clone().sub(crown.c).setY(0);
      if (out.lengthSq() < 1e-4) out.set(1, 0, 0);
      out.normalize();
      const size = K.lod1;
      const base = K.c.clone().add(new V3(0, -size * 0.38, 0));
      const tint = K.tintFn(sk);
      const cell = pick(sk, K.cells, K.weights);
      const n = K.c.clone().sub(crown.c).normalize();
      lod1.push({ p: base, dir: out.clone().add(new V3(0, 0.25, 0)), size, cell, tint, w: K.w, ph: K.ph, n, ao: 0.95 });
      lod1.push({ p: base, dir: out.clone().applyAxisAngle(UP, Math.PI / 2).add(new V3(0, 0.25, 0)), size, cell, tint, w: K.w, ph: K.ph, n, ao: 0.9 });
    }
    cards(leaves1, lod1, crown, H, flex, 1, r1);
  }
  const loose = sk.leaves.filter((L) => !L.fromClump && L.keep1 < 0.45);
  if (!sk.clumps.length || loose.length) cards(leaves1, sk.clumps.length ? loose : sk.leaves.filter((L) => L.keep1 < 0.45), crown, H, flex, 1.4, r1);

  const size = box.getSize(new V3());
  const stem = sk.branches[0];
  return {
    kind,
    height: H,
    radius: Math.max(size.x, size.z) * 0.5,
    box,
    crown,
    trunkR: stem ? stem.rads[0] : 0.1,
    // the trunk's axis and radii (the wildlife module keeps its perches out of it)
    trunk: stem ? { pts: stem.pts.map((p) => [p.x, p.y, p.z]), rads: stem.rads.slice() } : null,
    lod0: { bark: bark0.build(), leaves: leaves0.build() },
    lod1: { bark: bark1.build(), leaves: leaves1.count ? leaves1.build() : leaves0.build() },
    cards: sk.leaves.length,
  };
}
