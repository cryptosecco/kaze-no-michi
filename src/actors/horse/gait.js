// Horse gaits as data: footfall pattern, duty factor, stride frequency and body motion, blended by ground speed.
// Legs are indexed 0 LF (left fore), 1 RF, 2 LH (left hind), 3 RH. A leg's phase offset is the fraction of the stride
// cycle at which its hoof touches down; it stays planted for its duty of the cycle, then swings. The canter and gallop
// lead with the right fore. Pure functions, no three.js (scripts/horse.test.mjs).
//   gaitAt(speed, out)          blended parameters at a ground speed (m/s) → out (reused, no allocation)
//   legPhase(p, off)            phase of a leg in [0, 1) for the global stride phase p (0 = touchdown)
//   legDuty(g, leg)             a leg's duty factor (fore or hind)
//   footfalls(g) / beats(g)     touchdown order of one stride / number of distinct beats (tests, audio)
//   support(g, p)               hooves on the ground at stride phase p

export const LEGS = ['LF', 'RF', 'LH', 'RH'];

// speed: the gait's own pace (m/s), freq: strides per second at that pace, duty / dutyH: stance fraction of each fore /
// hind hoof (the longest: at speed the stance is cut to what the limb can sweep, `sweep`), off: touchdown phase per
// leg, sweep: [fore, hind] longest stance sweep of a hoof under the body (m), place: [fore, hind] where a hoof lands,
// as a fraction of its stance sweep ahead of its rest spot, tdv: [fore, hind] the hoof's forward ground speed at
// touchdown as a fraction of the body's (the swing retracts the limb before it lands), toeOff: [fore, hind] how far
// the hoof has rolled over its toe as it leaves the ground (rad; at the trot the fore leaves well rolled, its heels
// already up out of the way of the hind of its side that comes in beneath it), ext: [fore, hind] how far the fetlock
// sinks past its standing angle under the peak load (rad; it follows the vertical force: McGuigan & Wilson 2003. At the
// trot the fore's digit is the limb's main spring, ~25–30° at mid-stance: Martuzzi et al. 2009; the walk loads it less;
// at the canter it keeps the walk's, and in the gallop's few-frame stance it sinks less), lift: peak hoof lift [fore,
// hind] (m), arc: the fore hoof's mid-swing trough and late peak as fractions of its early peak (the trot carries the
// hoof tucked up under the forearm and lifts it once more before it reaches for the ground: Clayton 1990; Gottleib et
// al. 2025), flex: peak carpus flexion in the swing (rad), slip: how much of the trunk's motion is the spring-mass
// bounce of the stance (1) rather than the authored bob / pitch / roll (0), bob: vertical body travel (m) with `beats`
// lows per stride at bobAt, pitch / nod: body and neck rocking (rad) at pitchAt / nodAt, roll: body roll (rad), scap:
// shoulder blade swing (rad), tail: carriage (0 hanging .. 1 streaming)
//
// The trot: a native Japanese pony (1.35 m, hip 0.98 m) at 4.0 m/s trots at Froude 1.66, a medium trot. Dynamic
// similarity (Alexander & Jayes 1983) puts its cadence near 1.5–1.75 Hz with the stride of a warmblood scaled by size
// (Clayton 1994: 3.26 m at 1.37 Hz for a warmblood at the same Froude number). Its limbs sweep ±20–22° about their
// pivots (Hobbs & Clayton 2019), ~0.9 m under this pony, which at 1.65 Hz is a fore stance of 0.38 of the stride and a
// hind one a little shorter (Rhodin et al. 2022: fore stances as long as or longer than the hind). The hind lands
// ~1.5 % of the stride before its diagonal fore and lifts first (positive diagonal dissociation: Holmström 1994;
// Clayton & Hobbs 2019). Each stance is swept nearly evenly about its limb's pivot (Hobbs & Clayton 2019: landing and
// lift-off almost symmetric about the vertical): the hind lands ~21° ahead of its hip and leaves ~28° behind it, never
// pushing off a limb locked out longer than it stands; the fore lands far enough ahead that the hind of its side, landing
// a pony's short overtrack (~0.1 m) ahead of the fore's print, comes in under a fore hoof that has already left.
export const GAITS = [
  // 4-beat lateral walk: LH, LF, RH, RF evenly spaced, always two or three hooves down
  { name: 'walk', speed: 1.8, freq: 1.18, duty: 0.64, dutyH: 0.6, off: [0, 0.5, 0.75, 0.25], sweep: [0.9, 0.84], place: [0.45, 0.45], tdv: [0.25, 0.3], toeOff: [0.75, 0.7], ext: [0.45, 0.36], lift: [0.1, 0.085], arc: [0.7, 0.25], flex: 1.25, slip: 0, bob: 0.014, beats: 2, bobAt: 0.12, pitch: 0.01, pitchAt: 0, nod: 0.07, nodBeats: 2, nodAt: 0.05, roll: 0.022, scap: 0.12, tail: 0 },
  // 2-beat diagonal trot with two moments of suspension: LF+RH, then RF+LH, each hind landing a little first
  { name: 'trot', speed: 4.0, freq: 1.65, duty: 0.46, dutyH: 0.43, off: [0, 0.5, 0.485, 0.985], sweep: [0.92, 0.84], place: [0.4, 0.43], tdv: [0.2, 0.5], toeOff: [1.0, 0.7], ext: [0.55, 0.36], lift: [0.06, 0.1], arc: [1.3, 1.25], flex: 1.45, slip: 1, bob: 0.03, beats: 2, bobAt: 0.2, pitch: 0, pitchAt: 0.1, nod: 0, nodBeats: 2, nodAt: 0.15, roll: 0.012, scap: 0.2, tail: 0.25 },
  // 3-beat canter on the right lead: LH, then LF+RH together, then RF, then all four in the air
  { name: 'canter', speed: 8.5, freq: 1.95, duty: 0.34, dutyH: 0.34, off: [0, 0.22, 0.76, 0], sweep: [0.95, 1.05], place: [0.3, 0.48], tdv: [0.3, 0.45], toeOff: [0.75, 0.7], ext: [0.45, 0.36], lift: [0.2, 0.15], arc: [0.7, 0.25], flex: 1.7, slip: 0, bob: 0.05, beats: 1, bobAt: 0.15, pitch: 0.075, pitchAt: 0.55, nod: 0.12, nodBeats: 1, nodAt: 0.45, roll: 0.01, scap: 0.22, tail: 0.6 },
  // 4-beat transverse gallop on the right lead: LH, RH, LF, RF, then a gathered suspension. Its stance lasts some 75 ms,
  // a few frames: the digits sink and roll less than at the trot, or the pasterns would snap from frame to frame, and
  // the trunk rocks ±3.5° (more would lift the forehand out of the trailing fore's reach just as it lands)
  { name: 'gallop', speed: 13.5, freq: 2.3, duty: 0.26, dutyH: 0.26, off: [0, 0.11, 0.68, 0.79], sweep: [1.0, 1.15], place: [0.3, 0.5], tdv: [0.3, 0.45], toeOff: [0.65, 0.5], ext: [0.35, 0.22], lift: [0.24, 0.17], arc: [0.7, 0.25], flex: 2.0, slip: 0, bob: 0.06, beats: 1, bobAt: 0.12, pitch: 0.06, pitchAt: 0.6, nod: 0.16, nodBeats: 1, nodAt: 0.5, roll: 0.006, scap: 0.27, tail: 1 },
];

// speed bands (m/s) over which one gait hands over to the next
export const BANDS = [
  [2.4, 3.2],
  [5.4, 6.8],
  [10.2, 12.0],
];

const KEYS = ['freq', 'duty', 'dutyH', 'flex', 'slip', 'bob', 'bobAt', 'pitch', 'pitchAt', 'nod', 'nodAt', 'roll', 'scap', 'tail'];
const PAIRS = ['lift', 'sweep', 'place', 'tdv', 'toeOff', 'ext', 'arc'];

const smooth = (a, b, x) => {
  const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
  return t * t * (3 - 2 * t);
};
const fract = (x) => x - Math.floor(x);
// shortest way around the cycle from a to b
const cyc = (a, b, t) => fract(a + (((b - a + 1.5) % 1) - 0.5) * t);

export function makeGait() {
  return {
    name: 'walk', index: 0, w: 0, speed: 0, freq: 0, duty: 0.64, dutyH: 0.6, off: [0, 0.5, 0.75, 0.25], lift: [0, 0], arc: [0.7, 0.25], sweep: [0.95, 0.88],
    place: [0.45, 0.45], tdv: [0.25, 0.3], toeOff: [0.75, 0.7], ext: [0.45, 0.36], flex: 0, slip: 0, bob: 0, beats: 2, bobAt: 0, pitch: 0, pitchAt: 0, nod: 0, nodBeats: 2, nodAt: 0, roll: 0,
    scap: 0, tail: 0, stride: 0, amp: 0,
  };
}

// Blended gait at `speed` (m/s, ≥ 0). out.index / out.w: the lower gait and the blend toward the next one (0..1);
// out.freq: strides per second (it falls toward 0 with the speed, so the legs stop where the horse stops);
// out.stride: m per stride; out.amp: 0 at a standstill .. 1 from ~0.6 m/s (scales steps, lift and body motion).
export function gaitAt(speed, out = makeGait()) {
  const v = Math.max(0, speed);
  let i = 0, w = 0;
  for (let k = 0; k < BANDS.length; k++) {
    if (v < BANDS[k][0]) break;
    if (v < BANDS[k][1]) {
      i = k;
      w = smooth(BANDS[k][0], BANDS[k][1], v);
      break;
    }
    i = k + 1;
  }
  const A = GAITS[i], B = GAITS[Math.min(GAITS.length - 1, i + 1)];
  for (const k of KEYS) out[k] = A[k] + (B[k] - A[k]) * w;
  for (let l = 0; l < 4; l++) out.off[l] = cyc(A.off[l], B.off[l], w);
  for (const k of PAIRS) {
    out[k][0] = A[k][0] + (B[k][0] - A[k][0]) * w;
    out[k][1] = A[k][1] + (B[k][1] - A[k][1]) * w;
  }
  out.beats = w < 0.5 ? A.beats : B.beats;
  out.nodBeats = w < 0.5 ? A.nodBeats : B.nodBeats;
  out.name = w < 0.5 ? A.name : B.name;
  out.index = i;
  out.w = w;
  out.speed = v;
  // within a gait the horse lengthens its stride more than it quickens it; below the walk both shrink
  const pace = A.speed + (B.speed - A.speed) * w;
  out.freq *= Math.pow(Math.max(v, 1e-4) / pace, v < GAITS[0].speed ? 0.6 : 0.3);
  out.stride = out.freq > 1e-5 ? v / out.freq : 0;
  out.amp = smooth(0.02, 0.6, v);
  return out;
}

export function legPhase(p, off) {
  return fract(p - off);
}

export function legDuty(g, leg) {
  return leg < 2 ? g.duty : g.dutyH;
}

// Touchdowns of one stride sorted by time: [{ leg, at }] (at = phase in [0, 1)).
export function footfalls(g) {
  return g.off.map((at, leg) => ({ leg, at: fract(at) })).sort((a, b) => a.at - b.at);
}

// Number of distinct beats in a stride: touchdowns closer than `tol` of a cycle sound as one.
export function beats(g, tol = 0.04) {
  const f = footfalls(g);
  let n = 0;
  for (let i = 0; i < f.length; i++) if (fract(f[(i + 1) % f.length].at - f[i].at) > tol) n++;
  return Math.max(1, n);
}

// Hooves on the ground at stride phase p.
export function support(g, p) {
  let n = 0;
  for (let l = 0; l < 4; l++) if (legPhase(p, g.off[l]) < legDuty(g, l)) n++;
  return n;
}
