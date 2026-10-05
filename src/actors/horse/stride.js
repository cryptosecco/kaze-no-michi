// Stride physics for the horse, pure and allocation-free (scripts/horse.test.mjs): how a hoof loads the ground over its
// stance, the path of a hoof through its swing, and the reach geometry of a limb planted on the ground.
//   loadShape(u)                                 vertical load over a stance (u: 0 touchdown .. 1 lift-off), unit area,
//                                                peaking a little before mid-stance (LOAD_PEAK)
//   loadImpulse(u)                               its integral from 0 to u
//   hermite(p0, m0, p1, m1, s) / hermiteD(…)     cubic Hermite and its derivative (m0, m1: slopes per unit of s)
//   quintic(p0, v0, a0, p1, v1, a1, s)           quintic Hermite: position, slope and curvature at both ends
//   foldCurve(s, at, end)                        0 → 1 → 0 over a swing: rising at once, most at `at`, gone by `end`
//   peakCurve(s, y0, m0, yPk, sPk, y1, m1)       two cubic pieces through a peak yPk at sPk (zero slope there)
//   knotCurve(s, K, n)                           cubic Hermite pieces through n knots K = [s, y, slope, …]
//   scapAngle(F, r, want, lo, hi, R, out)        shoulder-blade angle nearest `want` within [lo, hi] that brings the
//                                                shoulder joint within R of the fetlock F
//   tipToReach(P, F, J, R)                       extra roll of the hoof over the pivot P (toe) that brings F within R of J
// 2D points are { z, y } in a leg's sagittal plane (z forward, y up), angles from +z toward +y.

const TAU = Math.PI * 2;

// Vertical ground reaction of one hoof over its stance: a half-sine skewed so that it peaks at LOAD_PEAK of the stance.
// A trotting horse's forelimb force peaks at 43–48 % of the stance, the hind's at 40–45 % (Hobbs et al. 2016). The
// shape has unit area, so a hoof that carries a share s of the weight over a stance of duty D pushes s·g·loadShape(u)/D:
// its mean over the stride is then s·g, the weight it holds up.
export const LOAD_PEAK = 0.45;
const LOAD_P = Math.log(0.5) / Math.log(LOAD_PEAK);
const LOAD_NORM = (() => {
  // ∫₀¹ sin(π·u^p) du by Simpson's rule (once, at load)
  const n = 400;
  let s = 0;
  for (let i = 0; i <= n; i++) {
    const u = i / n, w = i === 0 || i === n ? 1 : i % 2 ? 4 : 2;
    s += w * Math.sin(Math.PI * Math.pow(u, LOAD_P));
  }
  return 1 / ((s / (3 * n)) || 1);
})();
export function loadShape(u) {
  if (u <= 0 || u >= 1) return 0;
  return LOAD_NORM * Math.sin(Math.PI * Math.pow(u, LOAD_P));
}
// the same shape scaled to 1 at its peak (the hoof's load as a fraction of its own maximum)
export function loadFrac(u) {
  return u <= 0 || u >= 1 ? 0 : Math.sin(Math.PI * Math.pow(u, LOAD_P));
}
// its integral from 0 to u (0 .. 1): the share of a stance's impulse delivered by then. A frame's impulse from a hoof is
// the difference of two of these, whatever the frame rate (the load is never sampled: a 60 Hz frame is longer than the
// few ms between a hind and its diagonal fore landing)
const IMP_N = 256, IMP = new Float64Array(IMP_N + 1);
for (let i = 1; i <= IMP_N; i++) {
  // Simpson on each cell
  const a = (i - 1) / IMP_N, b = i / IMP_N;
  IMP[i] = IMP[i - 1] + ((b - a) / 6) * (loadShape(a) + 4 * loadShape((a + b) / 2) + loadShape(b));
}
for (let i = 1; i <= IMP_N; i++) IMP[i] /= IMP[IMP_N];
export function loadImpulse(u) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const x = u * IMP_N, i = Math.floor(x);
  return IMP[i] + (IMP[i + 1] - IMP[i]) * (x - i);
}

// A bell over the stance, 0 with zero slope at both ends and 1 at BELL_PEAK: how far the fetlock joint opens past its
// standing angle. It follows the load, proportionally (McGuigan & Wilson 2003), and peaks with it near mid-stance, the
// cannon upright (Clayton, Mechanics of equine locomotion; Hobbs et al. 2016: 43–48 % of the stance); the joint takes
// up the impact over a few hundredths of a second, so it starts gently.
export const BELL_PEAK = 0.45;
const BELL_P = Math.log(0.5) / Math.log(BELL_PEAK);
export function fetlockBell(u) {
  if (u <= 0 || u >= 1) return 0;
  const s = Math.sin(Math.PI * Math.pow(u, BELL_P));
  return s * s;
}

// Soft reach: a distance d pulled under the limit R, untouched up to `knee`·R and easing toward R beyond it (a swing
// target never stretches the limb into its straight, singular pose).
export function softReach(d, R, knee = 0.92) {
  const k = knee * R;
  if (d <= k) return d;
  const w = R - k;
  if (w < 1e-6) return R; // a hard limit
  return k + w * (1 - Math.exp(-(d - k) / w));
}

export function hermite(p0, m0, p1, m1, s) {
  const s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * m0 + (-2 * s3 + 3 * s2) * p1 + (s3 - s2) * m1;
}

export function hermiteD(p0, m0, p1, m1, s) {
  const s2 = s * s;
  return (6 * s2 - 6 * s) * p0 + (3 * s2 - 4 * s + 1) * m0 + (-6 * s2 + 6 * s) * p1 + (3 * s2 - 2 * s) * m1;
}

// Quintic Hermite over s in [0, 1]: from p0 (slope v0, second derivative a0) to p1 (v1, a1), all per unit of s. A swing
// whose ends are set by the hoof's real velocities and accelerations: how hard the folding limb pulls the hoof off its
// lift-off, how hard it is braked into its landing.
export function quintic(p0, v0, a0, p1, v1, a1, s) {
  const s2 = s * s, s3 = s2 * s, s4 = s3 * s, s5 = s4 * s;
  return (
    (1 - 10 * s3 + 15 * s4 - 6 * s5) * p0 +
    (s - 6 * s3 + 8 * s4 - 3 * s5) * v0 +
    (0.5 * s2 - 1.5 * s3 + 1.5 * s4 - 0.5 * s5) * a0 +
    (0.5 * s3 - s4 + 0.5 * s5) * a1 +
    (-4 * s3 + 7 * s4 - 3 * s5) * v1 +
    (10 * s3 - 15 * s4 + 6 * s5) * p1
  );
}

// A fold over a swing (0 .. 1 .. 0): rising from s = 0 at once (slope 2 / at, no pause at the lift-off), at its most at
// `at` (zero slope), easing back to nothing by `end` and staying there.
export function foldCurve(s, at, end) {
  if (s <= 0 || s >= end) return 0;
  if (s < at) {
    const x = s / at;
    return x * (2 - x);
  }
  const t = (s - at) / (end - at);
  return 1 - t * t * (3 - 2 * t);
}

// Two cubic pieces: y0 (slope m0) at s = 0 up to the peak yPk at sPk (slope 0), then down to y1 (slope m1) at s = 1.
export function peakCurve(s, y0, m0, yPk, sPk, y1, m1) {
  if (s <= sPk) return hermite(y0, m0 * sPk, yPk, 0, sPk > 1e-6 ? s / sPk : 1);
  const w = 1 - sPk;
  return hermite(yPk, 0, y1, m1 * w, w > 1e-6 ? (s - sPk) / w : 1);
}

// Cubic Hermite pieces through n knots, K = [s0, y0, m0, s1, y1, m1, …] with increasing s and the slopes per unit of s
// (zero at a peak or a trough, so each piece between two of them is monotonic): one C¹ curve through a swing's peaks.
// Before the first knot and after the last it holds their values.
export function knotCurve(s, K, n) {
  if (s <= K[0]) return K[1];
  for (let i = 0; i < n - 1; i++) {
    const j = i * 3, sa = K[j], sb = K[j + 3];
    if (s <= sb) {
      const w = sb - sa;
      return w > 1e-9 ? hermite(K[j + 1], K[j + 2] * w, K[j + 4], K[j + 5] * w, (s - sa) / w) : K[j + 4];
    }
  }
  return K[(n - 1) * 3 + 1];
}

// The shoulder blade pivots near the withers: the shoulder joint J = r·(cos a, sin a) about the blade's top (the
// origin of the leg plane). The angle nearest `want`, within the blade's swing [lo, hi], that brings J within R of the
// fetlock F; when no angle does, the one that comes closest. out.a, out.reach.
export function scapAngle(F, r, want, lo, hi, R, out) {
  const d = Math.hypot(F.z, F.y);
  const phiF = Math.atan2(F.y, F.z);
  // |F − J|² = d² + r² − 2dr·cos(a − phiF) ≤ R²  ⇔  cos(a − phiF) ≥ c
  const c = d > 1e-9 ? (d * d + r * r - R * R) / (2 * d * r) : -2;
  let a = want < lo ? lo : want > hi ? hi : want;
  if (c <= -1) {
    out.a = a;
    out.reach = true;
    return out;
  }
  if (c > 1) {
    // nothing reaches: point the blade at the target as far as it swings
    const aim = phiF + Math.round((a - phiF) / TAU) * TAU;
    out.a = aim < lo ? lo : aim > hi ? hi : aim;
    out.reach = false;
    return out;
  }
  const w = Math.acos(c);
  // the reaching arc [phiF − w, phiF + w], taken on the turn nearest the wanted angle
  const mid = phiF + Math.round((a - phiF) / TAU) * TAU;
  if (Math.abs(a - mid) <= w) {
    out.a = a;
    out.reach = true;
    return out;
  }
  // the end of the arc nearest the wanted angle, if the blade can swing that far
  const edge = a > mid ? mid + w : mid - w;
  if (edge >= lo && edge <= hi) {
    out.a = edge;
    out.reach = true;
    return out;
  }
  // the arc lies beyond the blade's swing: the nearest limit
  out.a = edge < lo ? lo : hi;
  out.reach = Math.abs(out.a - mid) <= w + 1e-9;
  return out;
}

// Breakover: the hoof rolls over its toe P, carrying the coronet and the fetlock F round it (clockwise in the leg plane:
// the heel rises). The smallest extra roll (rad, ≥ 0) that brings F within R of the limb's root J; 0 when F already is,
// or when rolling forward cannot help.
export function tipToReach(P, F, J, R) {
  const rz = F.z - P.z, ry = F.y - P.y;
  const rho = Math.hypot(rz, ry);
  const jz = J.z - P.z, jy = J.y - P.y;
  const D = Math.hypot(jz, jy);
  if ((F.z - J.z) ** 2 + (F.y - J.y) ** 2 <= R * R) return 0;
  if (rho < 1e-6 || D < 1e-6) return 0;
  const c = (rho * rho + D * D - R * R) / (2 * rho * D);
  if (c > 1) return 0; // no roll reaches
  const w = c < -1 ? Math.PI : Math.acos(c);
  const psi0 = Math.atan2(ry, rz), phiJ = Math.atan2(jy, jz);
  // rolling clockwise lowers psi; the reaching arc is [phiJ − w, phiJ + w]: how far clockwise to its upper end
  let need = psi0 - (phiJ + w);
  need -= Math.floor(need / TAU) * TAU; // in [0, 2π)
  return need < Math.PI ? need : 0;
}
