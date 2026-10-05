// Analytic leg solvers for the horse, in the leg's sagittal plane: 2D points { z, y } (z forward, y up), angles in
// radians measured from +z toward +y (−π/2 points straight down). Pure math (scripts/horse.test.mjs).
//   solveFore(S, F, L, kappa, out, maxD)   shoulder joint S → fetlock F with the carpus flexed by kappa: the forearm
//                                          and the cannon form one rigid link, the elbow bends backward
//   solveHind(P, F, L, delta, out, maxD)   hip joint P → fetlock F; the reciprocal apparatus flexes stifle and hock
//                                          together, so the cannon keeps a fixed angle `delta` to the femur and the
//                                          stifle bends forward
//   foreReach(L, kappa, minElbow)          the farthest the fetlock gets from the shoulder joint with the elbow flexed
//                                          at least minElbow (a horse's elbow never straightens: at most ~146°,
//                                          Martuzzi et al. 2009)
// L = segment lengths: fore { a: humerus, b: forearm, c: cannon }, hind { e: femur, f: tibia, g: cannon }.
// maxD (optional) caps the root → fetlock distance the solver will stretch to (an anatomical limit short of a straight
// limb); beyond it the limb points at the target at that length and the result reports it out of reach.
// out receives the joint positions and segment angles; the result says whether the target was in reach.

const dir = (o, a, len, out) => {
  out.z = o.z + Math.cos(a) * len;
  out.y = o.y + Math.sin(a) * len;
  return out;
};

// 2-bone solve from root R to target T with bone lengths l1 (first) and l2; side = +1 bends the first bone
// counterclockwise of the root→target line (in front of it for a downward leg), −1 clockwise (behind it).
// Returns { a1, reach, z, y } with a1 the first bone's angle and (z, y) the point the chain ends on: the target, or
// the nearest point to it the chain can reach along the root → target line.
function twoBone(R, T, l1, l2, side, res, maxD = Infinity) {
  const dz = T.z - R.z, dy = T.y - R.y;
  let d = Math.hypot(dz, dy);
  const lo = Math.abs(l1 - l2) + 1e-4, hi = Math.min(l1 + l2 - 1e-4, maxD);
  // a millimetre of tolerance: the callers aim at the limit itself
  res.reach = d >= lo && d <= hi + 1e-3;
  const dc = d < lo ? lo : d > hi ? hi : d;
  const base = d > 1e-6 ? Math.atan2(dy, dz) : -Math.PI / 2;
  const cosA = (l1 * l1 + dc * dc - l2 * l2) / (2 * l1 * dc);
  const A = Math.acos(cosA < -1 ? -1 : cosA > 1 ? 1 : cosA);
  res.a1 = base + side * A;
  res.z = R.z + Math.cos(base) * dc;
  res.y = R.y + Math.sin(base) * dc;
  return res;
}

const _r = { a1: 0, reach: true, z: 0, y: 0 };

export function makeFore() {
  return { E: { z: 0, y: 0 }, K: { z: 0, y: 0 }, F: { z: 0, y: 0 }, aH: 0, aR: 0, aC: 0, reach: true };
}

export function foreReach(L, kappa, minElbow) {
  const vz = L.b + L.c * Math.cos(kappa), vy = -L.c * Math.sin(kappa);
  const lv = Math.hypot(vz, vy), gamma = Math.atan2(vy, vz);
  // the elbow flexion is the forearm's turn from the humerus; the link (forearm + cannon) turns gamma further
  const t = Math.max(0, minElbow + gamma);
  return Math.sqrt(L.a * L.a + lv * lv + 2 * L.a * lv * Math.cos(t));
}

export function solveFore(S, F, L, kappa, out = makeFore(), maxD = Infinity) {
  // forearm + cannon as one link: its length and the angle it makes with the forearm
  const vz = L.b + L.c * Math.cos(kappa), vy = -L.c * Math.sin(kappa);
  const lv = Math.hypot(vz, vy), gamma = Math.atan2(vy, vz);
  twoBone(S, F, L.a, lv, -1, _r, maxD);
  out.reach = _r.reach;
  out.aH = _r.a1;
  dir(S, out.aH, L.a, out.E);
  const aV = Math.atan2(_r.y - out.E.y, _r.z - out.E.z);
  out.aR = aV - gamma;
  out.aC = out.aR - kappa;
  dir(out.E, out.aR, L.b, out.K);
  dir(out.K, out.aC, L.c, out.F);
  return out;
}

export function makeHind() {
  return { K: { z: 0, y: 0 }, H: { z: 0, y: 0 }, F: { z: 0, y: 0 }, aF: 0, aT: 0, aC: 0, reach: true };
}

export function solveHind(P, F, L, delta, out = makeHind(), maxD = Infinity) {
  // femur + cannon as one link (they turn together), the tibia as the second bone
  const wz = L.e + L.g * Math.cos(delta), wy = L.g * Math.sin(delta);
  const lw = Math.hypot(wz, wy), gamma = Math.atan2(wy, wz);
  twoBone(P, F, lw, L.f, 1, _r, maxD);
  out.reach = _r.reach;
  const aW = _r.a1;
  out.aF = aW - gamma;
  out.aC = out.aF + delta;
  dir(P, out.aF, L.e, out.K);
  // the tibia runs from the stifle to the hock; the hock sits a cannon's length above the fetlock along aC
  const hz = _r.z - Math.cos(out.aC) * L.g, hy = _r.y - Math.sin(out.aC) * L.g;
  out.aT = Math.atan2(hy - out.K.y, hz - out.K.z);
  dir(out.K, out.aT, L.f, out.H);
  dir(out.H, out.aC, L.g, out.F);
  return out;
}

// angle of segment a → b
export function segAngle(a, b) {
  return Math.atan2(b.y - a.y, b.z - a.z);
}
