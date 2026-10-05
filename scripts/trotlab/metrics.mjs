// Trot lab — metrics. Pure functions over a recorded run (sim.mjs: samples of geometric markers, markers.mjs) and the
// primitives they are built from (unit tested in scripts/trotlab.test.mjs). Nothing here reads the horse's code.
//   analyze(run, { stand })      → { metrics (flat map key → value), details, D (per-sample angles, lengths), iv / plants
//                                  (contact intervals per hoof), strides, diag (diagonal stances), susp } for a steady run
//   robust(run)                  → { slip_mm, scrape_mm, slip_full_mm, penetration_mm, float_mm, hover_mm, duty_fore,
//                                  duty_hind, max_bone_step_deg, ik_unreached_frames, ... } over a whole recording
//   standAngles(run)             → joint angles of the square stand (the reference of the "relative to standing" metrics)
//   evaluate(metrics, reference) → rows { key, value, lo, hi, unit, note, pass }
// Conventions (docs/trot-lab.md has the full list):
//   contact      the lowest vertex of the hoof capsule within CONTACT_M (4 mm) of the ground; touchdown / lift-off times are
//                interpolated where that height crosses the threshold; a PLANT sits flat at some point after 10 % of the
//                contact, a SCRAPE never does
//   stride       from one LF plant's touchdown to the next; stride phase 0 = LF touchdown
//   joint angle  angle between the two segments meeting at the joint, in the leg plane, 0 = straight (collinear), signed so
//                that FLEXION is positive; the fetlocks are negative standing (they are extended, dorsiflexed)
//   horizontal   the x–z plane; "along the travel" = along the horse's heading (unit, horizontal)

export const DEG = 180 / Math.PI;
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const neg = (a) => [-a[0], -a[1], -a[2]];
const lerp = (a, b, k) => a + (b - a) * k;
const lerpN = (a, b, k) => a.map((v, i) => lerp(v, b[i], k));
const hdist = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
export const LEG_NAMES = ['LF', 'RF', 'LH', 'RH'];
const FORE = [0, 1], HIND = [2, 3];

// ---- primitives -------------------------------------------------------------------------------------------------------

// Contact intervals of one hoof: samples with h[i] <= thr are in contact. Touchdown (td) and lift-off (lo) times are
// interpolated linearly where h crosses thr between two samples. An interval that starts at the first sample or ends at
// the last one is open (openStart / openEnd: its td / lo is that sample's time, not a real event).
//   → [{ i0, i1, td, lo, openStart, openEnd }] (i0..i1 inclusive are the contact samples)
export function contactIntervals(t, h, thr) {
  const out = [];
  const n = t.length;
  let i = 0;
  while (i < n) {
    if (!(h[i] <= thr)) {
      i++;
      continue;
    }
    const i0 = i;
    while (i + 1 < n && h[i + 1] <= thr) i++;
    const i1 = i;
    const openStart = i0 === 0, openEnd = i1 === n - 1;
    const td = openStart ? t[0] : lerp(t[i0 - 1], t[i0], (h[i0 - 1] - thr) / (h[i0 - 1] - h[i0] || 1));
    const lo = openEnd ? t[n - 1] : lerp(t[i1], t[i1 + 1], (thr - h[i1]) / (h[i1 + 1] - h[i1] || 1));
    out.push({ i0, i1, td, lo, openStart, openEnd });
    i++;
  }
  return out;
}

// Strides from the touchdowns of the reference hoof: [{ t0, t1, T }]
export function stridesFrom(tds) {
  const s = [];
  for (let k = 0; k + 1 < tds.length; k++) s.push({ t0: tds[k], t1: tds[k + 1], T: tds[k + 1] - tds[k] });
  return s;
}

// The stride that contains time t (t0 <= t < t1), or null
export function strideAt(strides, t) {
  for (const s of strides) if (t >= s.t0 && t < s.t1) return s;
  return null;
}

// Duty factor of each contact: its duration over the period of the stride its touchdown falls in
export function dutyFactors(intervals, strides) {
  const out = [];
  for (const c of intervals) {
    if (c.openStart || c.openEnd) continue;
    const s = strideAt(strides, c.td);
    if (s) out.push((c.lo - c.td) / s.T);
  }
  return out;
}

// Fraction of [t0, t1] covered by the intervals (each hoof's own contacts never overlap): the geometric duty factor
export function contactFraction(intervals, t0, t1) {
  let on = 0;
  for (const c of intervals) on += Math.max(0, Math.min(c.lo, t1) - Math.max(c.td, t0));
  return on / (t1 - t0);
}

// Union of intervals [[a, b], ...] clipped to [t0, t1], and its complement there (the gaps)
export function coverage(intervals, t0, t1) {
  const iv = intervals.map(([a, b]) => [Math.max(a, t0), Math.min(b, t1)]).filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
  const covered = [];
  for (const [a, b] of iv) {
    const last = covered[covered.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else covered.push([a, b]);
  }
  const gaps = [];
  let c = t0;
  for (const [a, b] of covered) {
    if (a > c) gaps.push([c, a]);
    c = Math.max(c, b);
  }
  if (t1 > c) gaps.push([c, t1]);
  return { covered, gaps };
}

// Suspension over whole strides: the gaps in the union of every hoof's contacts.
//   → { frac (time with no hoof down / stride time), count (gaps per stride), gaps }
export function suspension(allIntervals, strides) {
  if (!strides.length) return { frac: NaN, count: NaN, gaps: [] };
  const t0 = strides[0].t0, t1 = strides[strides.length - 1].t1;
  const { gaps } = coverage(allIntervals.map((c) => [c.td, c.lo]), t0, t1);
  const air = gaps.reduce((s, [a, b]) => s + (b - a), 0);
  return { frac: air / (t1 - t0), count: gaps.length / strides.length, gaps };
}

// For each time in a, the time in b nearest to it within maxLag: a − b (unpaired ones are skipped)
export function pairLags(a, b, maxLag) {
  const out = [];
  for (const x of a) {
    let best = null;
    for (const y of b) if (Math.abs(x - y) <= maxLag && (best === null || Math.abs(x - y) < Math.abs(x - best))) best = y;
    if (best !== null) out.push(x - best);
  }
  return out;
}

// Largest horizontal (x–z) distance of any point from the first one (m)
export function horizontalTravel(points) {
  if (!points.length) return 0;
  let m = 0;
  for (const p of points) m = Math.max(m, hdist(p, points[0]));
  return m;
}

export function peakToPeak(v) {
  if (!v.length) return NaN;
  let lo = Infinity, hi = -Infinity;
  for (const x of v) (lo = Math.min(lo, x)), (hi = Math.max(hi, x));
  return hi - lo;
}

// Mean second derivative of y (uniform step dt) over the samples i with mask[i] true and both neighbours present:
// central differences (y[i+1] − 2y[i] + y[i−1]) / dt². → { mean, n }
export function meanSecondDerivative(y, dt, mask) {
  let s = 0, n = 0;
  for (let i = 1; i + 1 < y.length; i++) {
    if (!mask[i]) continue;
    s += (y[i + 1] - 2 * y[i] + y[i - 1]) / (dt * dt);
    n++;
  }
  return { mean: n ? s / n : NaN, n };
}

// Minimum of y over samples i0..i1 (inclusive), refined by a parabola through the lowest sample and its neighbours
// (uniform t). → { t, y, i }
export function argminParabolic(t, y, i0, i1) {
  let k = i0;
  for (let i = i0; i <= i1; i++) if (y[i] < y[k]) k = i;
  if (k <= 0 || k >= y.length - 1) return { t: t[k], y: y[k], i: k };
  const a = y[k - 1], b = y[k], c = y[k + 1];
  const den = a - 2 * b + c;
  if (!(den > 0)) return { t: t[k], y: b, i: k };
  const off = Math.max(-1, Math.min(1, (a - c) / (2 * den)));
  const dt = t[k + 1] - t[k];
  return { t: t[k] + off * dt, y: b - ((a - c) * off) / 4, i: k };
}

// Signed angle (radians) from vector u to vector v about the axis n: atan2((u × v)·n, u·v)
export function signedAngle(u, v, n) {
  return Math.atan2(dot(cross(u, v), n), dot(u, v));
}

// Joint angle (degrees) at j between the segments a→j and j→b, 0 when they are collinear. n is the horse's RIGHT axis
// (unit): the rotation from a→j to j→b about it is positive when the distal segment turns forward-and-up as seen from the
// right side (where the horse faces right); `sign` turns that into flexion-positive for the joint (FLEX_SIGN).
export function jointAngle(a, j, b, n, sign) {
  return sign * signedAngle(sub(j, a), sub(b, j), n) * DEG;
}

// flexion sign per joint (see jointAngle): the elbow and the hock flex by turning the distal segment forward-up; the
// shoulder, carpus, stifle and fetlocks by turning it back
export const FLEX_SIGN = { shoulder: -1, elbow: 1, carpus: -1, fetlockF: -1, stifle: -1, hock: 1, fetlockH: -1 };

// Angle (degrees) of the segment a→b in a body frame { f, u } (forward, up): 0 = pointing forward, −90 = straight down
export function segmentAngle(a, b, frame) {
  const v = sub(b, a);
  return Math.atan2(dot(v, frame.u), dot(v, frame.f)) * DEG;
}

// Pitch (nose up +) and roll (left side up +) in degrees from a frame's axes { f, u, l }
export const pitchOf = (ax) => Math.asin(Math.max(-1, Math.min(1, ax.f[1]))) * DEG;
export const rollOf = (ax) => Math.atan2(ax.l[1], ax.u[1]) * DEG;

// Sole pitch (degrees): + toe up (heel first), 0 flat, − toe down; from toe/heel heights above the ground and their
// horizontal distance
export function solePitch(toe, heel, toeH, heelH) {
  return Math.atan2(toeH - heelH, hdist(toe, heel)) * DEG;
}

// Reference check of one value: in [lo, hi] (either bound may be missing)
export function inRange(v, ref) {
  if (!ref || !Number.isFinite(v)) return null;
  if (ref.lo != null && v < ref.lo) return false;
  if (ref.hi != null && v > ref.hi) return false;
  return true;
}

export function evaluate(metrics, reference = {}) {
  return Object.entries(reference).map(([key, r]) => ({ key, value: metrics[key], lo: r.lo, hi: r.hi, unit: r.unit, note: r.note, pass: inRange(metrics[key], r) }));
}

// ---- per-sample derived quantities --------------------------------------------------------------------------------------

// Joint angles of one leg in one sample (degrees). Fore: shoulder, elbow, carpus, fetlock (flexion +) and scap (the
// shoulder blade's angle in the Chest frame). Hind: stifle, hock, fetlock (flexion +) and hip (the femur's angle in the
// Pelvis frame).
export function legAngles(g, l) {
  const L = g.legs[l];
  if (l < 2) {
    const n = neg(g.chestAx.l);
    return {
      shoulder: jointAngle(L.scapTop, L.shoulder, L.elbow, n, FLEX_SIGN.shoulder),
      elbow: jointAngle(L.shoulder, L.elbow, L.carpus, n, FLEX_SIGN.elbow),
      carpus: jointAngle(L.elbow, L.carpus, L.fetlock, n, FLEX_SIGN.carpus),
      fetlock: jointAngle(L.carpus, L.fetlock, L.coronet, n, FLEX_SIGN.fetlockF),
      scap: segmentAngle(L.scapTop, L.shoulder, g.chestAx),
    };
  }
  const n = neg(g.pelvisAx.l);
  return {
    stifle: jointAngle(L.hip, L.stifle, L.hock, n, FLEX_SIGN.stifle),
    hock: jointAngle(L.stifle, L.hock, L.fetlock, n, FLEX_SIGN.hock),
    fetlock: jointAngle(L.hock, L.fetlock, L.coronet, n, FLEX_SIGN.fetlockH),
    hip: segmentAngle(L.hip, L.stifle, g.pelvisAx),
  };
}

// distance from the proximal joint (shoulder / hip) to the sole centre
const legLength = (g, l) => {
  const L = g.legs[l];
  const p = l < 2 ? L.shoulder : L.hip;
  return Math.hypot(...sub(L.sole, p));
};

// ---- helpers over a run -----------------------------------------------------------------------------------------------

function series(run) {
  const S = run.samples;
  const t = S.map((s) => s.t);
  const legs = [0, 1, 2, 3].map((l) => ({
    h: S.map((s) => s.geo.legs[l].lowH),
    ang: S.map((s) => legAngles(s.geo, l)),
    len: S.map((s) => legLength(s.geo, l)),
  }));
  return { t, legs };
}

// value of a per-sample quantity at time x (linear interpolation; uniform steps)
function at(t, get, x) {
  const dt = t[1] - t[0];
  const f = (x - t[0]) / dt;
  const i = Math.max(0, Math.min(t.length - 2, Math.floor(f)));
  const k = Math.max(0, Math.min(1, f - i));
  const a = get(i), b = get(i + 1);
  return Array.isArray(a) ? lerpN(a, b, k) : lerp(a, b, k);
}

// sample indices with t in [a, b]
function idxRange(t, a, b) {
  const dt = t[1] - t[0];
  const i0 = Math.max(0, Math.ceil((a - t[0]) / dt - 1e-9)), i1 = Math.min(t.length - 1, Math.floor((b - t[0]) / dt + 1e-9));
  return [i0, i1];
}

// The planted part of a contact. The hoof is FLAT when both its toe and its heel are within thr of the ground. The window
// starts at 10 % of the contact, or later if the hoof is not flat yet (a toe-first or heel-first landing still rolling
// onto its sole), and ends at the BREAKOVER START: the first time after that the heel rises above thr (a hoof that lifts
// off flat breaks over at its lift-off). A contact that is never flat after 10 % is not a plant but a SCRAPE (a toe or
// a rim brushing the ground): flat false, window 10 %..100 % of the contact.
//   → { start, bo, flat }
export function plantedWindow(t, toeH, heelH, c, thr) {
  const dur = c.lo - c.td;
  let i = c.i0;
  while (i <= c.i1 && t[i] < c.td + 0.1 * dur) i++;
  while (i <= c.i1 && !(toeH[i] <= thr && heelH[i] <= thr)) i++;
  if (i > c.i1) return { start: c.td + 0.1 * dur, bo: c.lo, flat: false };
  const start = t[i];
  while (i <= c.i1 && heelH[i] <= thr) i++;
  const bo = i > c.i1 ? c.lo : (t[i - 1] + t[i]) / 2;
  return { start, bo, flat: true };
}

// toe / heel heights of leg l over the contact's samples (indexed like the run)
function plantedOf(S, t, l, c, thr) {
  const toeH = [], heelH = [];
  for (let i = c.i0; i <= c.i1; i++) {
    toeH[i] = S[i].geo.legs[l].toeH;
    heelH[i] = S[i].geo.legs[l].heelH;
  }
  return plantedWindow(t, toeH, heelH, c, thr);
}

// Slip of one contact. A plant (flat): horizontal travel of the sole centre over the planted window (slip) and over the
// whole contact (slipFull). A scrape (never flat): horizontal travel of the hoof's lowest point over 10 %..100 % of the
// contact (scrape); slip is then NaN (nothing was planted). → { slip, scrape, slipFull, win, n }
function slipOf(S, t, l, c, thr) {
  const win = plantedOf(S, t, l, c, thr);
  const [p0, p1] = idxRange(t, win.start, win.bo);
  const pts = [];
  for (let i = p0; i <= p1; i++) pts.push(win.flat ? S[i].geo.legs[l].sole : S[i].geo.legs[l].low);
  const all = [];
  for (let i = c.i0; i <= c.i1; i++) all.push(S[i].geo.legs[l].sole);
  const travel = horizontalTravel(pts);
  return { slip: win.flat ? travel : NaN, scrape: win.flat ? NaN : travel, slipFull: horizontalTravel(all), win, n: pts.length };
}

// Everything measured on one contact of leg l (a complete one: both ends inside the recording)
function contactInfo(run, D, l, c, stand) {
  const S = run.samples, t = D.t, thr = run.contactM;
  const dur = c.lo - c.td;
  const g = (i) => S[i].geo.legs[l];
  const sl = slipOf(S, t, l, c, thr);
  const bo = sl.win.bo;
  const [p0, p1] = idxRange(t, sl.win.start, bo);
  const planted = [];
  for (let i = p0; i <= p1; i++) planted.push(g(i).sole);
  // float: highest lowest-point during 20–70 % of the contact
  const [f0, f1] = idxRange(t, c.td + 0.2 * dur, c.td + 0.7 * dur);
  let float = -Infinity;
  for (let i = f0; i <= f1; i++) float = Math.max(float, g(i).lowH);
  // touchdown kinematics over the last 1/60 s
  const w = 1 / 60;
  const pTd = at(t, (i) => g(i).sole, c.td), pPre = at(t, (i) => g(i).sole, c.td - w);
  const hd = at(t, (i) => S[i].geo.heading, c.td);
  const hn = Math.hypot(hd[0], hd[1]) || 1;
  const vh = ((pTd[0] - pPre[0]) * hd[0] + (pTd[2] - pPre[2]) * hd[1]) / hn / w;
  const vv = (pTd[1] - pPre[1]) / w;
  const pitch = solePitch(at(t, (i) => g(i).toe, c.td), at(t, (i) => g(i).heel, c.td), at(t, (i) => g(i).toeH, c.td), at(t, (i) => g(i).heelH, c.td));
  // breakover: the toe's travel from the breakover start to the lift-off
  const [b0, b1] = idxRange(t, bo, c.lo);
  const toes = [];
  for (let i = b0; i <= b1; i++) toes.push(g(i).toe);
  // limb compression and joint behaviour during the contact
  const L0 = at(t, (i) => D.legs[l].len[i], c.td);
  let comp = 0, fetExt = -Infinity, fetExtAt = NaN, carpDev = 0, hockYield = -Infinity;
  const hock0 = l >= 2 ? at(t, (i) => D.legs[l].ang[i].hock, c.td) : 0;
  for (let i = c.i0; i <= c.i1; i++) {
    comp = Math.max(comp, ((L0 - D.legs[l].len[i]) / L0) * 100);
    const A = D.legs[l].ang[i];
    const ext = stand.legs[l].fetlock - A.fetlock;
    if (ext > fetExt) (fetExt = ext), (fetExtAt = (t[i] - c.td) / dur);
    if (l < 2) carpDev = Math.max(carpDev, Math.abs(A.carpus));
    else hockYield = Math.max(hockYield, A.hock - hock0);
  }
  // print: the sole centre over the planted window (mid-contact if that window is empty)
  const print = planted.length ? [mean(planted.map((p) => p[0])), mean(planted.map((p) => p[1])), mean(planted.map((p) => p[2]))] : at(t, (i) => g(i).sole, c.td + dur / 2);
  return {
    leg: l, td: c.td, lo: c.lo, dur, bo, boFrac: (bo - c.td) / dur, flat: sl.win.flat,
    slip: sl.slip, scrape: sl.scrape, slipFull: sl.slipFull, plantedN: sl.n,
    float: Number.isFinite(float) ? float : NaN,
    tdVh: vh, tdVv: vv, tdPitch: pitch, boToeSlip: horizontalTravel(toes),
    comp, fetExt, fetExtAt, carpDev, hockYield: Number.isFinite(hockYield) ? hockYield : NaN,
    print, heading: [hd[0] / hn, hd[1] / hn],
  };
}

// Swing of leg l between a lift-off and the next touchdown of the same hoof
function swingInfo(run, D, l, lo, tdNext, stand) {
  const S = run.samples, t = D.t;
  const [i0, i1] = idxRange(t, lo, tdNext);
  const dur = tdNext - lo;
  let hMax = -Infinity, hAt = NaN, fMax = -Infinity, fAt = NaN;
  for (let i = i0; i <= i1; i++) {
    const h = S[i].geo.legs[l].soleH;
    if (h > hMax) (hMax = h), (hAt = (t[i] - lo) / dur);
    const A = D.legs[l].ang[i];
    const f = l < 2 ? A.carpus : A.hock - stand.legs[l].hock;
    if (f > fMax) (fMax = f), (fAt = (t[i] - lo) / dur);
  }
  return { hMax, hAt, flexMax: fMax, flexAt: fAt, dur };
}

// ---- the square stand ------------------------------------------------------------------------------------------------
export function standAngles(run) {
  const D = series(run);
  const legs = [0, 1, 2, 3].map((l) => {
    const keys = Object.keys(D.legs[l].ang[0]);
    return Object.fromEntries(keys.map((k) => [k, mean(D.legs[l].ang.map((a) => a[k]))]));
  });
  const lowH = [0, 1, 2, 3].map((l) => mean(D.legs[l].h));
  return { legs, lowH };
}

// ---- robustness (any scenario, the whole recording) --------------------------------------------------------------------
// Slip and float are measured on plants only: a scenario with no plant at all reports them as NaN (not measurable), never
// as 0. hover_mm is the highest of the four hooves' lowest heights over the recording: positive = some hoof never came
// within that distance of the ground (it never touched); duty_fore / duty_hind are the contact fractions of the recording.
export function robust(run) {
  const S = run.samples, thr = run.contactM;
  const t = S.map((s) => s.t);
  let slip = -Infinity, scrape = 0, slipFull = 0, float = -Infinity, pen = 0, plants = 0, scrapes = 0, hover = -Infinity;
  const frac = [];
  for (let l = 0; l < 4; l++) {
    const h = S.map((s) => s.geo.legs[l].lowH);
    let lowest = Infinity;
    for (const x of h) (pen = Math.max(pen, -x)), (lowest = Math.min(lowest, x));
    hover = Math.max(hover, lowest);
    const all = contactIntervals(t, h, thr);
    frac.push(contactFraction(all, t[0], t[t.length - 1]));
    // a contact cut by the start of the recording has no touchdown to measure from (its first part is unseen): skipped;
    // one cut by the end is measured up to the end
    for (const c of all) {
      if (c.openStart) continue;
      const sl = slipOf(S, t, l, c, thr);
      if (!sl.win.flat) {
        scrape = Math.max(scrape, sl.scrape);
        scrapes++;
        continue;
      }
      plants++;
      slip = Math.max(slip, sl.slip);
      slipFull = Math.max(slipFull, sl.slipFull);
      const dur = c.lo - c.td;
      const [f0, f1] = idxRange(t, c.td + 0.2 * dur, c.td + 0.7 * dur);
      for (let i = f0; i <= f1; i++) float = Math.max(float, S[i].geo.legs[l].lowH);
    }
  }
  const F = run.frames60;
  let step = 0, stepBone = '';
  for (const f of F) if (f.stepLoco > step) (step = f.stepLoco), (stepBone = f.stepLocoBone);
  const fin = (v) => (Number.isFinite(v) ? v * 1000 : NaN);
  return {
    slip_mm: fin(slip),
    scrape_mm: scrape * 1000,
    slip_full_mm: plants ? slipFull * 1000 : NaN,
    penetration_mm: pen * 1000,
    float_mm: fin(float),
    hover_mm: hover * 1000,
    duty_fore: (frac[0] + frac[1]) / 2,
    duty_hind: (frac[2] + frac[3]) / 2,
    max_bone_step_deg: step,
    max_bone_step_bone: stepBone,
    ik_unreached_frames: F.filter((f) => f.unreached).length,
    frames: F.length,
    plants,
    scrapes,
  };
}

// ---- the full analysis of a steady run ----------------------------------------------------------------------------------
export function analyze(run, { stand }) {
  const S = run.samples, thr = run.contactM;
  const D = series(run);
  const t = D.t;
  // every geometric contact, and among them the PLANTS (the hoof sits flat at some point after 10 % of the contact); the
  // others are SCRAPES (a toe or a rim brushing the ground). Strides, contact and swing metrics follow the plants; the
  // duty factor and the suspensions count every contact.
  const iv = [0, 1, 2, 3].map((l) => contactIntervals(t, D.legs[l].h, thr).map((c) => ({ ...c, win: plantedOf(S, t, l, c, thr) })));
  const plants = iv.map((cs) => cs.filter((c) => c.win.flat));
  const lfTd = plants[0].filter((c) => !c.openStart).map((c) => c.td);
  const strides = stridesFrom(lfTd);
  if (strides.length < 1) throw new Error(`${run.name}: no complete stride (LF planted ${lfTd.length} times)`);
  const T0 = strides[0].t0, T1 = strides[strides.length - 1].t1;
  const Tm = mean(strides.map((s) => s.T));
  const inWin = (c) => !c.openStart && !c.openEnd && c.td >= T0 && c.td < T1;
  const M = {};
  const details = { strides: strides.length, window_s: [T0, T1], contact_m: thr };

  // ---- stride
  const bodyAt = (x) => at(t, (i) => S[i].geo.body, x);
  M['stride.period_s'] = Tm;
  M['stride.freq_hz'] = 1 / Tm;
  M['stride.length_m'] = mean(strides.map((s) => hdist(bodyAt(s.t1), bodyAt(s.t0))));
  M['stride.speed_mps'] = M['stride.length_m'] / Tm;
  // print-to-print stride of each hoof (a cross-check of the body's travel)
  details.print_stride_m = LEG_NAMES.map((_, l) => {
    const c = plants[l].filter((x) => !x.openStart && !x.openEnd);
    const d = [];
    for (let k = 0; k + 1 < c.length; k++) d.push(hdist(at(t, (i) => S[i].geo.legs[l].sole, (c[k].td + c[k].lo) / 2), at(t, (i) => S[i].geo.legs[l].sole, (c[k + 1].td + c[k + 1].lo) / 2)));
    return mean(d);
  });

  // ---- contacts and swings (plants; a swing runs from a plant's lift-off to the next plant of the same hoof)
  const contacts = [0, 1, 2, 3].map((l) => plants[l].filter(inWin).map((c) => contactInfo(run, D, l, c, stand)));
  const swings = [0, 1, 2, 3].map((l) => {
    const out = [];
    const all = plants[l].filter((c) => !c.openStart && !c.openEnd);
    for (let k = 0; k + 1 < all.length; k++) if (all[k].td >= T0 && all[k].td < T1) out.push(swingInfo(run, D, l, all[k].lo, all[k + 1].td, stand));
    return out;
  });
  const pick = (legs, f) => legs.flatMap((l) => contacts[l].map(f)).filter(Number.isFinite);
  const pickS = (legs, f) => legs.flatMap((l) => swings[l].map(f)).filter(Number.isFinite);
  const max = (a) => (a.length ? Math.max(...a) : NaN);
  // duty factor: the fraction of the analysed strides each hoof spends in contact (every contact: plants and scrapes)
  details.duty_by_leg = [0, 1, 2, 3].map((l) => contactFraction(iv[l], T0, T1));
  M['duty.fore'] = mean(FORE.map((l) => details.duty_by_leg[l]));
  M['duty.hind'] = mean(HIND.map((l) => details.duty_by_leg[l]));
  // contact duration over the stride, per plant (the classic per-step duty factor; equal to the above without scrapes)
  details.plant_duty_by_leg = [0, 1, 2, 3].map((l) => mean(dutyFactors(plants[l].filter(inWin), strides)));
  details.contacts_per_stride = LEG_NAMES.map((_, l) => iv[l].filter((c) => c.td >= T0 && c.td < T1 && !c.openStart).length / strides.length);
  details.plants_per_stride = LEG_NAMES.map((_, l) => plants[l].filter((c) => c.td >= T0 && c.td < T1 && !c.openStart).length / strides.length);
  // how the duty factor depends on the contact threshold (the instrument's one free parameter)
  details.duty_by_threshold_mm = Object.fromEntries(
    [2, 4, 8].map((mm) => {
      const ivs = [0, 1, 2, 3].map((l) => contactIntervals(t, D.legs[l].h, mm / 1000));
      const d = (legs) => mean(legs.map((l) => contactFraction(ivs[l], T0, T1)));
      const n = ivs.reduce((s, x) => s + x.filter((c) => !c.openStart && c.td >= T0 && c.td < T1).length, 0);
      return [mm, { fore: d(FORE), hind: d(HIND), per_stride: n / 4 / strides.length }];
    })
  );

  // ---- suspension
  const susp = suspension([0, 1, 2, 3].flatMap((l) => iv[l]), strides);
  M['suspension.frac'] = susp.frac;
  M['suspension.count'] = susp.count;

  // ---- diagonal dissociation (fore − diagonal hind; + = the hind lands / lifts first)
  const tdOf = (l) => plants[l].filter((c) => !c.openStart).map((c) => c.td);
  const loOf = (l) => plants[l].filter((c) => !c.openEnd).map((c) => c.lo);
  const winT = (a) => a.filter((x) => x >= T0 && x < T1);
  const q = Tm / 4;
  const dTd = { LF_RH: pairLags(winT(tdOf(0)), tdOf(3), q), RF_LH: pairLags(winT(tdOf(1)), tdOf(2), q) };
  const dLo = { LF_RH: pairLags(winT(loOf(0)), loOf(3), q), RF_LH: pairLags(winT(loOf(1)), loOf(2), q) };
  for (const [k, v] of Object.entries(dTd)) M[`diag.dap_td_ms.${k}`] = mean(v) * 1000;
  for (const [k, v] of Object.entries(dLo)) M[`diag.dap_lo_ms.${k}`] = mean(v) * 1000;
  M['diag.dap_td_ms'] = mean([M['diag.dap_td_ms.LF_RH'], M['diag.dap_td_ms.RF_LH']]);
  M['diag.dap_lo_ms'] = mean([M['diag.dap_lo_ms.LF_RH'], M['diag.dap_lo_ms.RF_LH']]);

  // ---- contact quality
  for (const [name, legs] of [['fore', FORE], ['hind', HIND]]) {
    M[`contact.slip_mm.${name}`] = max(pick(legs, (c) => c.slip)) * 1000;
    M[`contact.slip_full_mm.${name}`] = max(pick(legs, (c) => c.slipFull)) * 1000;
    M[`contact.td_hvel_mps.${name}`] = mean(pick(legs, (c) => c.tdVh));
    M[`contact.td_vvel_mps.${name}`] = mean(pick(legs, (c) => c.tdVv));
    M[`contact.td_pitch_deg.${name}`] = mean(pick(legs, (c) => c.tdPitch));
    M[`contact.breakover_toe_slip_mm.${name}`] = max(pick(legs, (c) => c.boToeSlip)) * 1000;
    M[`contact.float_mm.${name}`] = max(pick(legs, (c) => c.float)) * 1000;
    M[`contact.breakover_at.${name}`] = mean(pick(legs, (c) => c.boFrac));
  }
  M['contact.slip_full_mm'] = Math.max(M['contact.slip_full_mm.fore'], M['contact.slip_full_mm.hind']);
  // scrapes: contacts that never sit flat (a toe dragging in the swing): the travel of their lowest point
  const scrapes = [0, 1, 2, 3].flatMap((l) => iv[l].filter((c) => inWin(c) && !c.win.flat).map((c) => slipOf(S, t, l, c, thr).scrape));
  M['contact.scrape_mm'] = scrapes.length ? Math.max(...scrapes) * 1000 : 0;
  M['contact.scrape_per_stride'] = scrapes.length / strides.length;
  M['contact.breakover_toe_slip_mm'] = Math.max(M['contact.breakover_toe_slip_mm.fore'], M['contact.breakover_toe_slip_mm.hind']);
  M['contact.float_mm'] = Math.max(M['contact.float_mm.fore'], M['contact.float_mm.hind']);
  let pen = 0;
  const penLeg = [0, 0, 0, 0];
  for (let l = 0; l < 4; l++) for (const h of D.legs[l].h) (pen = Math.max(pen, -h)), (penLeg[l] = Math.max(penLeg[l], -h));
  M['contact.penetration_mm'] = pen * 1000;
  details.penetration_mm_by_leg = penLeg.map((v) => v * 1000);

  // ---- trunk
  const y = (key) => S.map((s) => s.geo[key][1]);
  const perStride = (arr, f) => mean(strides.map((s) => {
    const [i0, i1] = idxRange(t, s.t0, s.t1);
    return f(arr.slice(i0, i1 + 1));
  }));
  const yW = y('withers'), yS = y('sacrum'), yB = y('body'), yP = y('poll'), yM = y('muzzle');
  M['trunk.withers_dy_mm'] = perStride(yW, peakToPeak) * 1000;
  M['trunk.sacrum_dy_mm'] = perStride(yS, peakToPeak) * 1000;
  M['trunk.body_dy_mm'] = perStride(yB, peakToPeak) * 1000;
  const pitch = S.map((s) => pitchOf(s.geo.bodyAx)), roll = S.map((s) => rollOf(s.geo.bodyAx)), proll = S.map((s) => rollOf(s.geo.pelvisAx));
  M['trunk.pitch_deg'] = perStride(pitch, peakToPeak);
  M['trunk.roll_deg'] = perStride(roll, peakToPeak);
  M['trunk.pelvis_roll_deg'] = perStride(proll, peakToPeak);
  // lateral: the trunk centre's offset from the straight line of travel (least squares through the root's path)
  const lat = lateralOffsets(S, (s) => s.geo.body), latW = lateralOffsets(S, (s) => s.geo.withers);
  M['trunk.lateral_mm'] = perStride(lat, peakToPeak) * 1000;
  M['trunk.withers_lateral_mm'] = perStride(latW, peakToPeak) * 1000;

  // diagonal support intervals (union of a fore contact and the overlapping diagonal hind contact) and, for each, the
  // timing of the withers' and sacrum's lowest point and the poll's lag
  const diag = [];
  for (const [f, h] of [[0, 3], [1, 2]])
    for (const c of plants[f].filter((x) => !x.openStart && !x.openEnd)) {
      let best = null, ov = 0;
      for (const d of plants[h]) {
        const o = Math.min(c.lo, d.lo) - Math.max(c.td, d.td);
        if (o > ov) (ov = o), (best = d);
      }
      diag.push({ pair: f === 0 ? 'LF_RH' : 'RF_LH', start: best ? Math.min(c.td, best.td) : c.td, end: best ? Math.max(c.lo, best.lo) : c.lo });
    }
  diag.sort((a, b) => a.start - b.start);
  const mins = { withers: [], sacrum: [], body: [], lag: [] };
  const half = Tm / 2;
  for (let k = 1; k + 1 < diag.length; k++) {
    const d = diag[k], a = (diag[k - 1].end + d.start) / 2, b = (d.end + diag[k + 1].start) / 2;
    if (d.start < T0 || d.start >= T1) continue;
    const [i0, i1] = idxRange(t, a, b);
    const span = d.end - d.start;
    const mW = argminParabolic(t, yW, i0, i1), mS = argminParabolic(t, yS, i0, i1), mB = argminParabolic(t, yB, i0, i1);
    mins.withers.push((mW.t - d.start) / span);
    mins.sacrum.push((mS.t - d.start) / span);
    mins.body.push((mB.t - d.start) / span);
    // the poll's lowest point within half a beat of the withers' one
    const [j0, j1] = idxRange(t, mW.t - half / 2, mW.t + half / 2);
    mins.lag.push(argminParabolic(t, yP, j0, j1).t - mW.t);
  }
  M['trunk.withers_min_at_stance'] = mean(mins.withers);
  M['trunk.sacrum_min_at_stance'] = mean(mins.sacrum);
  M['trunk.body_min_at_stance'] = mean(mins.body);
  details.diagonal_stance_s = mean(diag.filter((d) => d.start >= T0 && d.start < T1).map((d) => d.end - d.start));

  // vertical acceleration of the trunk centre while no hoof is down
  const air = S.map((s) => s.geo.legs.every((L) => !(L.lowH <= thr)));
  const inW = t.map((x) => x >= T0 && x <= T1);
  const acc = meanSecondDerivative(yB, run.dt, air.map((a, i) => a && inW[i]));
  M['trunk.flight_accel_mps2'] = acc.mean;
  details.flight_samples = acc.n;

  // ---- head
  M['head.poll_dy_mm'] = perStride(yP, peakToPeak) * 1000;
  M['head.muzzle_dy_mm'] = perStride(yM, peakToPeak) * 1000;
  M['head.lag_ms'] = mean(mins.lag) * 1000;

  // ---- fore limb
  const romOf = (l, key) => perStride(D.legs[l].ang.map((a) => a[key]), peakToPeak);
  M['fore.carpus_stance_dev_deg'] = max(pick(FORE, (c) => c.carpDev));
  M['fore.carpus_max_flex_deg'] = mean(pickS(FORE, (s) => s.flexMax));
  M['fore.carpus_max_flex_at_swing'] = mean(pickS(FORE, (s) => s.flexAt));
  M['fore.fetlock_ext_deg'] = mean(pick(FORE, (c) => c.fetExt));
  M['fore.fetlock_ext_at_stance'] = mean(pick(FORE, (c) => c.fetExtAt));
  M['fore.elbow_rom_deg'] = mean(FORE.map((l) => romOf(l, 'elbow')));
  M['fore.shoulder_rom_deg'] = mean(FORE.map((l) => romOf(l, 'shoulder')));
  M['fore.scap_rom_deg'] = mean(FORE.map((l) => romOf(l, 'scap')));
  M['fore.carpus_rom_deg'] = mean(FORE.map((l) => romOf(l, 'carpus')));
  M['fore.fetlock_rom_deg'] = mean(FORE.map((l) => romOf(l, 'fetlock')));
  M['fore.hoof_max_h_mm'] = mean(pickS(FORE, (s) => s.hMax)) * 1000;
  M['fore.hoof_max_h_at_swing'] = mean(pickS(FORE, (s) => s.hAt));

  // ---- hind limb
  M['hind.hock_stance_yield_deg'] = mean(pick(HIND, (c) => c.hockYield));
  M['hind.hock_max_flex_deg'] = mean(pickS(HIND, (s) => s.flexMax));
  M['hind.hock_max_flex_at_swing'] = mean(pickS(HIND, (s) => s.flexAt));
  M['hind.stifle_rom_deg'] = mean(HIND.map((l) => romOf(l, 'stifle')));
  M['hind.hock_rom_deg'] = mean(HIND.map((l) => romOf(l, 'hock')));
  M['hind.hip_rom_deg'] = mean(HIND.map((l) => romOf(l, 'hip')));
  M['hind.fetlock_ext_deg'] = mean(pick(HIND, (c) => c.fetExt));
  M['hind.fetlock_ext_at_stance'] = mean(pick(HIND, (c) => c.fetExtAt));
  M['hind.fetlock_rom_deg'] = mean(HIND.map((l) => romOf(l, 'fetlock')));
  M['hind.hoof_max_h_mm'] = mean(pickS(HIND, (s) => s.hMax)) * 1000;
  M['hind.hoof_max_h_at_swing'] = mean(pickS(HIND, (s) => s.hAt));

  // ---- tracking: each hind print against the last print of the fore hoof on the same side
  for (const [side, f, h] of [['left', 0, 2], ['right', 1, 3]]) {
    const d = [];
    for (const hc of contacts[h]) {
      const fc = [...plants[f].filter((x) => !x.openStart && !x.openEnd && x.td < hc.td)].pop();
      if (!fc) continue;
      const fi = contactInfo(run, D, f, fc, stand);
      d.push((hc.print[0] - fi.print[0]) * hc.heading[0] + (hc.print[2] - fi.print[2]) * hc.heading[1]);
    }
    M[`track.overtrack_mm.${side}`] = mean(d) * 1000;
  }

  // ---- limb compression
  M['leg.compression_pct.fore'] = mean(pick(FORE, (c) => c.comp));
  M['leg.compression_pct.hind'] = mean(pick(HIND, (c) => c.comp));

  // ---- smoothness and IK (every 1/60 s frame of the recording)
  const F = run.frames60;
  let step = 0, stepBone = '', stepAll = 0, stepAllBone = '';
  for (const f of F) {
    if (f.stepLoco > step) (step = f.stepLoco), (stepBone = f.stepLocoBone);
    if (f.stepAll > stepAll) (stepAll = f.stepAll), (stepAllBone = f.stepAllBone);
  }
  M['smooth.max_bone_step_deg'] = step;
  M['smooth.max_bone_step_all_deg'] = stepAll;
  M['smooth.ik_unreached_frames'] = F.filter((f) => f.unreached).length;
  details.smooth = {
    max_bone_step_bone: stepBone, max_bone_step_all_deg: stepAll, max_bone_step_all_bone: stepAllBone, frames: F.length,
    ik_unreached_by_leg: LEG_NAMES.map((_, l) => F.filter((f) => f.unreachedLegs && f.unreachedLegs[l]).length),
  };
  details.contacts = contacts.map((cs) => cs.map((c) => ({ ...c, print: c.print.map((v) => +v.toFixed(5)) })));
  details.swings = swings;
  return { metrics: M, details, D, iv, plants, strides, diag, susp };
}

// signed horizontal offset of a point from the least-squares line through the root's path (m), per sample
function lateralOffsets(S, get) {
  const xs = S.map((s) => s.geo.root[0]), zs = S.map((s) => s.geo.root[2]);
  const mx = mean(xs), mz = mean(zs);
  let sxx = 0, szz = 0, sxz = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx, dz = zs[i] - mz;
    sxx += dx * dx;
    szz += dz * dz;
    sxz += dx * dz;
  }
  // principal direction of the path
  const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const ux = Math.cos(ang), uz = Math.sin(ang);
  return S.map((s) => {
    const p = get(s);
    return -(p[0] - mx) * uz + (p[2] - mz) * ux;
  });
}
