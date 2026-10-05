// Quadrupeds of the island (the red fox, the sika deer): skeletons, gaits, feet planted on the ground, leg IK and the
// pose as skinning matrices. Pure (no three.js): scripts/mammals.test.mjs runs the very same code.
//
//   BODIES[name]                 rest skeleton (model space, metres: +z forward, +y up, +x the animal's left, the ground
//                                at y = 0) → bones, legs (segment lengths, rest angles, reach)
//   GAITS[name], gaitAt(...)     footfall pattern, duty factor, stride, body motion per gait, blended by speed
//   Loco                         one animal's locomotion: speed and heading, the stride phase, the four feet (a foot in
//                                stance stays where it was put down; a foot in swing flies to where the body will want
//                                it), the body carried over them (height and pitch from the ground under the girdles,
//                                the gait's bob, pitch and spine flexion, ballistic flight phases), the leap (the fox's
//                                pounce), the stamp of a fore foot
//   poseBones(loco, pose, out)   FK of the trunk, neck, head, ears, tail and rump, analytic IK of the legs → one 3×4
//                                skinning matrix per bone (rows; rest pose → posed model) and the model's placement
//
// Legs are indexed 0 LF (left fore), 1 RF, 2 LH, 3 RH. A leg's offset is the fraction of the stride at which its foot
// touches down; it stays planted for `duty` of the stride, then swings. Sources: Hildebrand's gait diagrams (lateral-
// sequence walk, diagonal trot, rotary gallop of canids, transverse gallop of ungulates, the half-bound, the pronk or
// stott), stride lengths by dynamic similarity (Alexander & Jayes 1983: λ/h = 2.3·Fr^0.3, Fr = v²/gh), the pantograph
// limb of mammals (Fischer & Blickhan 2006: the first and third limb segments stay about parallel), so each limb is a
// rigid link turning with its proximal segment plus the middle segment: an analytic 2-bone solve. The fore limb
// counts the shoulder blade as its first segment (pivot high on the ribcage): it swings with the leg.

const TAU = Math.PI * 2;
export const G = 9.81;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const fract = (x) => x - Math.floor(x);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const ease = (v, t, rate, dt) => v + (t - v) * (1 - Math.exp(-rate * dt));
export const smooth = (a, b, x) => {
  const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
  return t * t * (3 - 2 * t);
};
// a bump 0 → 1 → 0 over [a, b] (half sine), 0 outside
const bump = (x, a, b) => (x <= a || x >= b ? 0 : Math.sin(((x - a) / (b - a)) * Math.PI));
// shortest way around the cycle from a to b
const cyc = (a, b, t) => fract(a + (((b - a + 1.5) % 1) - 0.5) * t);

export const LEGS = ['LF', 'RF', 'LH', 'RH'];
const NO_LEGS = [];
const DIAG = [3, 2, 1, 0]; // each leg's diagonal partner (LF–RH, RF–LH)

// ------------------------------------------------------------------------------------------------------------ bodies
// Joints of the rest pose, standing square ([z, y] per leg, the leg in the sagittal plane x = ±x). fore: shoulder
// blade top (its pivot on the ribcage), shoulder joint, elbow, carpus, fetlock (fox: the metacarpo-phalangeal joint
// over the metacarpal pad; deer: the fetlock over the pastern), toe (where the foot meets the ground: the fox's toe
// pads, the deer's hoof tip). hind: hip joint, stifle, hock, fetlock, toe. Neck: neck1 (its root in the chest), neck2,
// the poll (head bone), the nose tip. Tail: points root → tip.
const PLANS = {
  // Vulpes vulpes japonica, a ~6 kg fox: 0.38 m at the withers, ~0.65 m nose to tail root, a 0.4 m brush; slender
  // digitigrade legs, a deep narrow chest, a long muzzle, big pointed ears
  fox: {
    body: [0, 0.31, 0.0],
    chest: [0, 0.322, 0.1],
    pelvis: [0, 0.322, -0.105],
    neck: [[0, 0.315, 0.175], [0, 0.352, 0.225], [0, 0.398, 0.274]],
    nose: [0, 0.36, 0.414],
    ear: [0.03, 0.438, 0.268],
    earTip: [0.05, 0.53, 0.256],
    tail: [[0, 0.338, -0.205], [0, 0.308, -0.3], [0, 0.272, -0.392], [0, 0.228, -0.476], [0, 0.182, -0.55]],
    fore: { x: 0.047, top: [0.096, 0.384], joint: [0.152, 0.292], elbow: [0.104, 0.193], carpus: [0.117, 0.062], fetlock: [0.131, 0.02], toe: [0.163, 0.0] },
    hind: { x: 0.044, joint: [-0.16, 0.3], knee: [-0.098, 0.192], hock: [-0.19, 0.088], fetlock: [-0.168, 0.021], toe: [-0.13, 0.0] },
    spineShift: 0.1, // m of trunk shortening per radian of spine flexion (each end)
  },
  // Cervus nippon, a hind of ~40 kg in her autumn coat: 0.8 m at the withers, ~1.2 m long; long thin legs on hooves, a
  // long neck, the white rump patch edged in black around a short tail (scaled up for the stag, down for a calf)
  deer: {
    body: [0, 0.655, 0.0],
    chest: [0, 0.68, 0.19],
    pelvis: [0, 0.69, -0.21],
    neck: [[0, 0.64, 0.33], [0, 0.79, 0.44], [0, 0.95, 0.53]],
    nose: [0, 0.83, 0.78],
    ear: [0.05, 1.0, 0.535],
    earTip: [0.14, 1.06, 0.505],
    tail: [[0, 0.745, -0.465], [0, 0.705, -0.515], [0, 0.645, -0.54]],
    rump: [0, 0.69, -0.49],
    fore: { x: 0.098, top: [0.205, 0.795], joint: [0.3, 0.612], elbow: [0.232, 0.452], carpus: [0.247, 0.245], fetlock: [0.256, 0.072], toe: [0.31, 0.0] },
    hind: { x: 0.092, joint: [-0.33, 0.655], knee: [-0.235, 0.47], hock: [-0.4, 0.302], fetlock: [-0.376, 0.072], toe: [-0.322, 0.0] },
    spineShift: 0.08,
  },
};

const ang2 = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]); // [z, y] points: angle from +z toward +y
const len2 = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

// Bones (name, parent, head, tail) and the leg descriptions from a plan
function makeBody(name, P) {
  const bones = [];
  const index = {};
  const add = (n, parent, head, tail) => {
    index[n] = bones.length;
    bones.push({ name: n, parent: parent === null ? -1 : index[parent], head: head.slice(), tail: tail.slice() });
  };
  add('body', null, P.body, P.chest);
  add('chest', 'body', P.chest, P.neck[0]);
  add('pelvis', 'body', P.pelvis, P.tail[0]);
  add('neck1', 'chest', P.neck[0], P.neck[1]);
  add('neck2', 'neck1', P.neck[1], P.neck[2]);
  add('head', 'neck2', P.neck[2], P.nose);
  add('earL', 'head', P.ear, P.earTip);
  add('earR', 'head', [-P.ear[0], P.ear[1], P.ear[2]], [-P.earTip[0], P.earTip[1], P.earTip[2]]);
  for (let i = 0; i < P.tail.length - 1; i++) add('tail' + (i + 1), i ? 'tail' + i : 'pelvis', P.tail[i], P.tail[i + 1]);
  if (P.rump) add('rump', 'pelvis', P.rump, [P.rump[0], P.rump[1] - 0.05, P.rump[2] - 0.02]);
  const legs = [];
  const F = P.fore, H = P.hind;
  for (const [l, fore, sx] of [[0, true, 1], [1, true, -1], [2, false, 1], [3, false, -1]]) {
    const s = LEGS[l];
    const x = (fore ? F.x : H.x) * sx;
    const p3 = (zy) => [x, zy[1], zy[0]];
    let J, names;
    if (fore) {
      J = [F.top, F.joint, F.elbow, F.carpus, F.fetlock, F.toe];
      names = ['scap', 'hum', 'rad', 'mc', 'toe'];
    } else {
      J = [H.joint, H.knee, H.hock, H.fetlock, H.toe];
      names = ['fem', 'tib', 'mt', 'toe'];
    }
    names.forEach((n, k) => add(n + s, k ? names[k - 1] + s : fore ? 'chest' : 'pelvis', p3(J[k]), p3(J[k + 1])));
    const rest = names.map((n, k) => ang2(J[k], J[k + 1]));
    const lens = names.map((n, k) => len2(J[k], J[k + 1]));
    const n = names.length;
    // the limb: proximal p, middle m, distal d (+ e, the fore's metacarpus) → fetlock; the distal ones at fixed angles
    // to p: off1 = d − p, off2 = e − p (the fore's carpus folds e back from d by kappa)
    const fet = J[n - 1];
    const back = J[n][0] - fet[0];
    // the farthest the limb reaches with its distal joints at their standing angles (the composite link straight
    // in line with the middle segment): a little short of the segments' sum
    const o1 = rest[2] - rest[0], o2 = fore ? rest[3] - rest[0] : 0;
    const wz = lens[0] + lens[2] * Math.cos(o1) + (fore ? lens[3] * Math.cos(o2) : 0), wy = lens[2] * Math.sin(o1) + (fore ? lens[3] * Math.sin(o2) : 0);
    const reachEff = Math.hypot(wz, wy) + lens[1];
    legs.push({
      l, fore, side: sx, x, girdle: index[fore ? 'chest' : 'pelvis'], bones: names.map((nm) => index[nm + s]),
      root: { z: J[0][0], y: J[0][1] },
      Lp: lens[0], Lm: lens[1], Ld: lens[2], Le: fore ? lens[3] : 0, Lt: lens[n - 1],
      rest, off1: rest[2] - rest[0], kappa0: fore ? rest[2] - rest[3] : 0,
      // the foot standing: the fetlock this far behind and above the toe's contact
      foot: { back, up: fet[1] - J[n][1] },
      // where the toe stands: square (the rest pose) and in a stride (the stance sweep centred under the limb's pivot:
      // the fetlock under the shoulder blade's top / the hip joint at mid-stance)
      neutral: { x, z: J[n][0], zStride: J[0][0] + back },
      reach: lens[0] + lens[1] + lens[2] + (fore ? lens[3] : 0),
      reachEff,
      standD: len2(J[0], fet),
      drop: J[0][1] - fet[1], // root above the fetlock, standing
    });
  }
  const nb = bones.length;
  const rest = new Float64Array(nb * 3);
  bones.forEach((b, i) => rest.set(b.head, i * 3));
  return {
    name, plan: P, bones, index, legs, nb, rest,
    hipH: P.hind.joint[1], // hip joint height standing (the "h" of dynamic similarity)
    zFore: P.fore.joint[0], zHind: P.hind.joint[0],
    tail: P.tail.length - 1,
  };
}

export const BODIES = Object.fromEntries(Object.entries(PLANS).map(([k, P]) => [k, makeBody(k, P)]));

// ------------------------------------------------------------------------------------------------------------ gaits
// v: the gait's speed range (m/s); off: touchdown phase per leg [LF, RF, LH, RH]; duty [slow end, fast end]; k: stride
// against dynamic similarity; sweep: longest stance sweep of a foot (× hip height: the duty shortens to keep within
// it); lift [fore, hind]: peak foot lift (× hip height); flex: carpus fold in the swing (rad); hock: extra hock
// flexion in the swing (rad); bob (× hip height), beats lows per stride at bobAt; pitch (rad) at pitchAt; spine:
// flexion (rad) peaking at spineAt; nod: head nod (rad), nodBeats; inset: the feet drawn toward the midline (× leg.x);
// crab: the body turned off the line of travel (rad: the fox's side-trot); stiff: legs held straight (the stott)
const FOX_GAITS = {
  // 4-beat lateral-sequence walk: LH, LF, RH, RF; always two or three feet down
  walk: { v: [0.15, 1.3], off: [0.26, 0.76, 0, 0.5], duty: [0.74, 0.62], k: 1, sweep: 0.95, lift: [0.22, 0.13], flex: 1.5, hock: 0.25, bob: 0.012, beats: 2, bobAt: 0.15, pitch: 0.012, pitchAt: 0.1, spine: 0, spineAt: 0, nod: 0.04, nodBeats: 2, nodAt: 0.1, inset: 0.35, crab: 0 },
  // 2-beat diagonal trot: LF+RH, RF+LH (the hind a touch ahead), a short suspension at speed; the brush level, the head
  // steady; the body turned a little off the line so the hind feet pass beside the fore feet
  trot: { v: [1.3, 4.6], off: [0.51, 0.01, 0, 0.5], duty: [0.52, 0.36], k: 0.92, sweep: 1.25, lift: [0.3, 0.18], flex: 1.9, hock: 0.35, bob: 0.03, beats: 2, bobAt: 0.2, pitch: 0.01, pitchAt: 0.25, spine: 0.015, spineAt: 0.2, nod: 0.015, nodBeats: 2, nodAt: 0.2, inset: 0.75, crab: 0.12 },
  // rotary gallop (canids): LH, RH, then RF, LF; two suspensions (extended after the hind lead, gathered after the
  // fore lead); the supple spine flexes under the gathered body and stretches out in the extended flight
  gallop: { v: [4.6, 13], off: [0.55, 0.44, 0, 0.11], duty: [0.34, 0.24], k: 1.12, sweep: 1.6, lift: [0.36, 0.24], flex: 2.1, hock: 0.5, bob: 0.05, beats: 1, bobAt: 0.25, pitch: 0.11, pitchAt: 0.08, spine: 0.3, spineAt: 0.95, nod: 0.08, nodBeats: 1, nodAt: 0.3, inset: 0.6, crab: 0 },
};
const DEER_GAITS = {
  walk: { v: [0.12, 1.6], off: [0.26, 0.76, 0, 0.5], duty: [0.76, 0.62], k: 1, sweep: 0.8, lift: [0.2, 0.1], flex: 1.6, hock: 0.2, bob: 0.01, beats: 2, bobAt: 0.15, pitch: 0.01, pitchAt: 0.1, spine: 0, spineAt: 0, nod: 0.06, nodBeats: 2, nodAt: 0.05, inset: 0.15, crab: 0 },
  trot: { v: [1.6, 5.5], off: [0.5, 0.0, 0, 0.5], duty: [0.5, 0.38], k: 0.95, sweep: 1.0, lift: [0.28, 0.14], flex: 1.9, hock: 0.3, bob: 0.025, beats: 2, bobAt: 0.2, pitch: 0.008, pitchAt: 0.25, spine: 0.01, spineAt: 0.2, nod: 0.02, nodBeats: 2, nodAt: 0.2, inset: 0.3, crab: 0 },
  // transverse gallop (ungulates): LH, RH, LF, RF; one gathered suspension after the fore lead
  gallop: { v: [5.5, 15], off: [0.6, 0.71, 0, 0.1], duty: [0.32, 0.22], k: 1.12, sweep: 1.25, lift: [0.32, 0.2], flex: 2.1, hock: 0.45, bob: 0.04, beats: 1, bobAt: 0.3, pitch: 0.08, pitchAt: 0.1, spine: 0.07, spineAt: 0.95, nod: 0.1, nodBeats: 1, nodAt: 0.35, inset: 0.3, crab: 0 },
  // the bound of a deer in flight (half-bound): the hind feet land almost together, the fore feet one after the
  // other, then a long gathered flight with the body arched over the folded legs
  bound: { v: [4, 15], off: [0.36, 0.43, 0, 0.04], duty: [0.26, 0.19], k: 1.25, sweep: 1.3, lift: [0.38, 0.26], flex: 2.3, hock: 0.6, bob: 0.05, beats: 1, bobAt: 0.25, pitch: 0.15, pitchAt: 0.05, spine: 0.08, spineAt: 0.95, nod: 0.12, nodBeats: 1, nodAt: 0.35, inset: 0.3, crab: 0 },
  // the stott (pronk): all four legs held stiff leave the ground and land together, a high slow bounce
  stott: { v: [0.5, 6], off: [0.02, 0.02, 0, 0], duty: [0.24, 0.18], k: 1, sweep: 2, lift: [0.0, 0.0], flex: 0.15, hock: 0.05, bob: 0.02, beats: 1, bobAt: 0.13, pitch: 0.04, pitchAt: 0.1, spine: 0.02, spineAt: 0.5, nod: 0.06, nodBeats: 1, nodAt: 0.4, inset: 0.15, crab: 0, stiff: true },
};
export const GAITS = { fox: FOX_GAITS, deer: DEER_GAITS };
// speed bands (m/s) over which one gait hands over to the next (walk → trot, trot → gallop)
const BANDS = { fox: [[1.15, 1.45], [4.3, 5.0]], deer: [[1.45, 1.85], [5.2, 6.2]] };
// the stott bounces at a fixed rate whatever the speed (Hz)
export const STOTT_HZ = 1.15;

const KEYS = ['lift0', 'lift1', 'flex', 'hock', 'bob', 'bobAt', 'pitch', 'pitchAt', 'spine', 'spineAt', 'nod', 'nodAt', 'inset', 'crab', 'k', 'sweep'];
for (const set of Object.values(GAITS)) for (const k in set) set[k] = { name: k, ...set[k], lift0: set[k].lift[0], lift1: set[k].lift[1] };

export function makeGait() {
  return {
    name: 'walk', w: 0, a: 'walk', b: 'walk', speed: 0, freq: 0, duty: 0.7, off: [0.26, 0.76, 0, 0.5], lift0: 0, lift1: 0, flex: 0, hock: 0, bob: 0, beats: 2,
    bobAt: 0, pitch: 0, pitchAt: 0, spine: 0, spineAt: 0, nod: 0, nodBeats: 2, nodAt: 0, inset: 0, crab: 0, k: 1, sweep: 1, stride: 0, amp: 0, stiff: false,
  };
}

// duty factor of a gait at speed v (over its own speed range, slow → fast)
function dutyOf(g, v) {
  const t = clamp((v - g.v[0]) / (g.v[1] - g.v[0]), 0, 1);
  return g.duty[0] + (g.duty[1] - g.duty[0]) * t;
}

// Blended gait at ground speed v (m/s, for the body's own size) ; mode 'bound' / 'stott' takes that gait at any speed.
// out.freq strides per second, out.stride metres per stride, out.amp 0 at a standstill → 1 from ~0.4 m/s.
export function gaitAt(body, v, mode, out = makeGait(), set = GAITS[body.name]) {
  v = Math.max(0, v);
  const h = body.hipH;
  let A, B, w = 0;
  if (mode && set[mode]) A = B = set[mode];
  else {
    const bands = BANDS[body.name];
    const order = ['walk', 'trot', 'gallop'];
    let i = 0;
    for (let k = 0; k < bands.length; k++) {
      if (v < bands[k][0]) break;
      if (v < bands[k][1]) {
        i = k;
        w = smooth(bands[k][0], bands[k][1], v);
        break;
      }
      i = k + 1;
    }
    A = set[order[i]];
    B = set[order[Math.min(order.length - 1, i + 1)]];
  }
  for (const k of KEYS) out[k] = A[k] + (B[k] - A[k]) * w;
  for (let l = 0; l < 4; l++) out.off[l] = cyc(A.off[l], B.off[l], w);
  out.duty = dutyOf(A, v) + (dutyOf(B, v) - dutyOf(A, v)) * w;
  out.beats = w < 0.5 ? A.beats : B.beats;
  out.nodBeats = w < 0.5 ? A.nodBeats : B.nodBeats;
  out.name = w < 0.5 ? A.name : B.name;
  out.a = A.name;
  out.b = B.name;
  out.w = w;
  out.stiff = !!(w < 0.5 ? A.stiff : B.stiff);
  out.speed = v;
  if (out.name === 'stott') {
    out.freq = STOTT_HZ;
    out.stride = v / STOTT_HZ;
  } else {
    // dynamic similarity: λ = k · 2.3 h Fr^0.3 → f = v / λ (falls toward 0 with the speed: the legs stop with the body)
    const Fr = (v * v) / (G * h);
    out.stride = out.k * 2.3 * h * Math.pow(Math.max(Fr, 1e-9), 0.3);
    out.freq = v > 1e-4 ? v / out.stride : 0;
  }
  out.amp = smooth(0.02, 0.4, v);
  return out;
}

export function legPhase(p, off) {
  return fract(p - off);
}

// Touchdowns of one stride sorted by time: [{ leg, at }]
export function footfalls(g) {
  return g.off.map((at, leg) => ({ leg, at: fract(at) })).sort((a, b) => a.at - b.at);
}

// Height of the ballistic flight at stride phase p (no foot down): t·(Tf − t)·g/2 over the suspension, 0 in support.
export function flightHeight(g, p, T) {
  let since = 1, until = 1;
  for (let l = 0; l < 4; l++) {
    const ph = fract(p - g.off[l]);
    if (ph < g.duty) return 0;
    since = Math.min(since, ph - g.duty);
    until = Math.min(until, 1 - ph);
  }
  const t = since * T, Tf = (since + until) * T;
  return (G * t * (Tf - t)) / 2;
}

// ------------------------------------------------------------------------------------------------------------ 3×3
// Row-major rotations in plain arrays (length 9). rotX(+a) turns +z toward −y (nose down) and +y toward +z; rotY(+a)
// turns +z toward +x (to the animal's left); rotZ(+a) turns +y toward −x.
function rx(a, o) {
  const c = Math.cos(a), s = Math.sin(a);
  o[0] = 1; o[1] = 0; o[2] = 0;
  o[3] = 0; o[4] = c; o[5] = -s;
  o[6] = 0; o[7] = s; o[8] = c;
  return o;
}
function ry(a, o) {
  const c = Math.cos(a), s = Math.sin(a);
  o[0] = c; o[1] = 0; o[2] = s;
  o[3] = 0; o[4] = 1; o[5] = 0;
  o[6] = -s; o[7] = 0; o[8] = c;
  return o;
}
function rz(a, o) {
  const c = Math.cos(a), s = Math.sin(a);
  o[0] = c; o[1] = -s; o[2] = 0;
  o[3] = s; o[4] = c; o[5] = 0;
  o[6] = 0; o[7] = 0; o[8] = 1;
  return o;
}
function mul(a, b, o) {
  const a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3], a4 = a[4], a5 = a[5], a6 = a[6], a7 = a[7], a8 = a[8];
  const b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3], b4 = b[4], b5 = b[5], b6 = b[6], b7 = b[7], b8 = b[8];
  o[0] = a0 * b0 + a1 * b3 + a2 * b6; o[1] = a0 * b1 + a1 * b4 + a2 * b7; o[2] = a0 * b2 + a1 * b5 + a2 * b8;
  o[3] = a3 * b0 + a4 * b3 + a5 * b6; o[4] = a3 * b1 + a4 * b4 + a5 * b7; o[5] = a3 * b2 + a4 * b5 + a5 * b8;
  o[6] = a6 * b0 + a7 * b3 + a8 * b6; o[7] = a6 * b1 + a7 * b4 + a8 * b7; o[8] = a6 * b2 + a7 * b5 + a8 * b8;
  return o;
}
const _ma = new Array(9), _mb = new Array(9), _mc = new Array(9), _md = new Array(9), _me = new Array(9);

// ------------------------------------------------------------------------------------------------------------ IK
// 2-bone solve in a sagittal plane, root (Rz, Ry) → target (Tz, Ty), lengths l1 then l2; side +1 bends the first link
// counterclockwise of the root → target line (in front of it for a downward leg). The distance is clamped to what the
// links reach (and to maxD); the result has the first link's angle, the line's angle and the clamped distance.
const _r = { a1: 0, base: 0, dc: 0, reach: true };
function twoBone(Rz, Ry, Tz, Ty, l1, l2, side, maxD) {
  const dz = Tz - Rz, dy = Ty - Ry;
  const d = Math.hypot(dz, dy);
  const lo = Math.abs(l1 - l2) + 1e-4, hi = Math.min(l1 + l2 - 1e-4, maxD);
  _r.reach = d >= lo - 1e-6 && d <= hi + 1e-6;
  const dc = d < lo ? lo : d > hi ? hi : d;
  _r.base = d > 1e-9 ? Math.atan2(dy, dz) : -Math.PI / 2;
  _r.dc = dc;
  const cosA = (l1 * l1 + dc * dc - l2 * l2) / (2 * l1 * dc);
  _r.a1 = _r.base + side * Math.acos(cosA < -1 ? -1 : cosA > 1 ? 1 : cosA);
  return _r;
}

// A pantograph limb from its root R to the fetlock F: proximal segment p, middle m, distal d at a fixed angle off1 to p
// and (fore) e at off2 to p. p + d (+ e) is one rigid link W turning with p; m closes the triangle (the stifle / the
// shoulder joint in front of the line, the hock / the elbow behind). Writes the segment angles a[0..3] and the joints
// j (z, y pairs: root, end of p, end of m, end of d, end of e) into o.
function solveLimb(leg, Rz, Ry, Fz, Fy, off1, off2, maxD, o) {
  const Lp = leg.Lp, Lm = leg.Lm, Ld = leg.Ld, Le = leg.Le;
  const wz = Lp + Ld * Math.cos(off1) + Le * Math.cos(off2), wy = Ld * Math.sin(off1) + Le * Math.sin(off2);
  const lw = Math.hypot(wz, wy), gamma = Math.atan2(wy, wz);
  const r = twoBone(Rz, Ry, Fz, Fy, lw, Lm, 1, maxD);
  o.reach = r.reach;
  const Tz = Rz + Math.cos(r.base) * r.dc, Ty = Ry + Math.sin(r.base) * r.dc;
  const aP = r.a1 - gamma, aD = aP + off1, aE = aP + off2;
  const j = o.j;
  j[0] = Rz;
  j[1] = Ry;
  j[2] = Rz + Math.cos(aP) * Lp;
  j[3] = Ry + Math.sin(aP) * Lp;
  // the distal chain hangs from the (clamped) target back up: end of m = T − e − d
  j[4] = Tz - Math.cos(aE) * Le - Math.cos(aD) * Ld;
  j[5] = Ty - Math.sin(aE) * Le - Math.sin(aD) * Ld;
  j[6] = j[4] + Math.cos(aD) * Ld;
  j[7] = j[5] + Math.sin(aD) * Ld;
  j[8] = j[6] + Math.cos(aE) * Le;
  j[9] = j[7] + Math.sin(aE) * Le;
  o.a[0] = aP;
  o.a[1] = Math.atan2(j[5] - j[3], j[4] - j[2]);
  o.a[2] = aD;
  o.a[3] = aE;
  o.err = Math.hypot(Fz - (Le ? j[8] : j[6]), Fy - (Le ? j[9] : j[7]));
  return o;
}

// ------------------------------------------------------------------------------------------------------------ Loco
// A leg: stance (st 0: the toe's contact point c stays put in the world; the fetlock stands over it and rolls up over
// the toe at the end of the stance) or swing (st 1: the fetlock flies from where it lifted to where the body will
// want it, over an arc).
function makeLeg(l) {
  return {
    l, st: 0, ph: 0, u: 0,
    cx: 0, cy: 0, cz: 0, cyaw: 0, // contact (toe) in the world and the heading it was put down at
    fx: 0, fy: 0, fz: 0, // fetlock target in the world (the IK's goal)
    sx: 0, sy: 0, sz: 0, // the fetlock where the swing started
    ex: 0, ey: 0, ez: 0, eyaw: 0, // where the swing will put the toe down (updated as the body moves)
    s: 1, T: 0.2, // swing progress 0..1, duration (s)
    heel: 0, // the fetlock rolled up over the toe (rad)
    stamping: false,
    forced: 0, // lift-offs forced by an over-stretched leg (tests)
  };
}

export class Loco {
  constructor(body, opts = {}) {
    this.body = body;
    this.set = GAITS[body.name];
    this.scale = opts.scale || 1;
    this.x = 0;
    this.z = 0;
    this.yaw = 0; // heading of travel (the body may be turned off it by the crab)
    this.v = 0; // forward speed (m/s)
    this.w = 0; // yaw rate (rad/s)
    this.phase = 0;
    this.g = makeGait();
    this.legs = [0, 1, 2, 3].map(makeLeg);
    this.standing = true; // no stride: the feet stay down and step only when the body has left them
    this.stepT = 0;
    this.stampLeg = -1;
    // body
    this.gy = 0; // ground reference under the trunk (m)
    this.gf = 0; // ground under the fore / hind girdle (smoothed)
    this.gh = 0;
    this.gPitch = 0;
    this.bodyY = body.plan.body[1] * this.scale; // body bone height over the ground reference (m)
    this.pitch = 0;
    this.roll = 0;
    this.spine = 0;
    this.crab = 0;
    this.bob = 0;
    this.nod = 0;
    this.lower = 0; // the body let down (m): legs short of the planted feet, speed, a crouch
    this.sit = 0; // 0 standing → 1 sitting on the haunches (fox)
    this.crouch = 0; // 0 → 1 gathered (a pounce, a stamp of alarm)
    this.air = null; // a leap in progress
    this.airPhase = -1;
    this.lod = 0; // 0: every foot on the terrain exactly; 1 (far from the camera): no per-foot terrain corrections
    this.forcedLifts = 0;
    this.time = 0;
    this.onStep = null; // (leg) → footfall
    this._p = { x: 0, z: 0 };
    this._f = { fx: 0, fy: 0, fz: 0 };
  }

  get h() {
    return this.body.hipH * this.scale;
  }

  // Put the animal down at once (spawning, tests): every foot on the ground under its girdle
  place(x, z, yaw, ground) {
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    this.v = 0;
    this.w = 0;
    this.standing = true;
    this.air = null;
    this.airPhase = -1;
    this.groundRef(ground, 1);
    for (const L of this.legs) {
      this.neutral(L, 0, this._p, x, z, yaw, 0);
      L.cx = this._p.x;
      L.cz = this._p.z;
      L.cy = ground(L.cx, L.cz);
      L.cyaw = yaw;
      L.cdh = this.heelRise(L, L.cx, L.cy, L.cz, yaw, ground);
      L.st = 0;
      L.s = 1;
      L.heel = 0;
      this.fetlockOf(L, L.cx, L.cy, L.cz, L.cyaw, 0, L);
    }
  }

  // Where a leg's toe goes down under its girdle (world) for a body at (bx, bz) heading yaw, turned by crab; inset draws
  // it toward the midline; centre (0 square → 1 striding) moves it under the limb's pivot. → o { x, z }
  neutral(L, inset, o, bx, bz, yaw, crab, centre = 0) {
    const leg = this.body.legs[L.l], s = this.scale;
    // (sitting, the hind feet are gathered forward under the knees, close behind the fore feet: one step each, to
    // where the sit will want them)
    const sitZ = leg.fore ? 0 : (this.sitWant || 0) * 0.2;
    const lx = leg.x * (1 - inset) * s, lz = (leg.neutral.z + (leg.neutral.zStride - leg.neutral.z) * centre + sitZ) * s;
    const a = yaw + crab;
    const c = Math.cos(a), sn = Math.sin(a);
    o.x = bx + lx * c + lz * sn;
    o.z = bz - lx * sn + lz * c;
    return o;
  }

  // The fetlock over a toe at (x, y, z) put down heading yaw, rolled up over the toe by heel (rad) → o.fx/fy/fz; dh:
  // how much higher the ground is under the heel than under the toe (the foot lies on a slope)
  fetlockOf(L, x, y, z, yaw, heel, o, dh = L.cdh || 0) {
    const leg = this.body.legs[L.l], s = this.scale;
    const back = leg.foot.back * s, up = leg.foot.up * s;
    // the foot turned about its toe to lie on the slope (heel up where the ground rises behind the toe)
    const r = Math.hypot(back, up), a = Math.atan2(up, -back) - heel - Math.atan2(dh, back);
    const dz = Math.cos(a) * r;
    o.fx = x + Math.sin(yaw) * dz;
    o.fy = y + Math.sin(a) * r;
    o.fz = z + Math.cos(yaw) * dz;
    return o;
  }

  // the ground under a foot's heel (its fetlock) against the ground under its toe at (x, y, z) heading yaw
  heelRise(L, x, y, z, yaw, ground) {
    const back = this.body.legs[L.l].foot.back * this.scale;
    return ground(x - Math.sin(yaw) * back, z - Math.cos(yaw) * back) - y;
  }

  // ground heights under the girdles → reference height and pitch of the ground (k: smoothing 0..1, 1 = at once)
  groundRef(ground, k) {
    const s = this.scale, b = this.body;
    const sn = Math.sin(this.yaw), c = Math.cos(this.yaw);
    const zf = b.zFore * s, zh = b.zHind * s;
    const gf = ground(this.x + sn * zf, this.z + c * zf), gh = ground(this.x + sn * zh, this.z + c * zh);
    this.gf = k >= 1 || Math.abs(gf - this.gf) > 0.4 * s ? gf : this.gf + (gf - this.gf) * k;
    this.gh = k >= 1 || Math.abs(gh - this.gh) > 0.4 * s ? gh : this.gh + (gh - this.gh) * k;
    this.gy = (this.gf + this.gh) / 2;
    this.gPitch = Math.atan2(this.gf - this.gh, zf - zh);
  }

  // a stamp of alarm: the fore foot l lifts and strikes down where it stood (standing only)
  stamp(l) {
    if (this.standing && !this.air) this.stampLeg = l;
  }

  // One step of locomotion. ctl: { v (wanted speed), yaw (wanted heading), turn (max turn rate), accel, decel, mode
  // ('bound' | 'stott' | null), sit (0..1), crouch (0..1), crabSide (±1) }; ground(x, z): walkable ground height.
  step(dt, ground, ctl) {
    this.time += dt;
    const b = this.body, s = this.scale;
    this.sitWant = ctl.sit || 0;
    if (this.air) return this.stepAir(dt, ground, ctl);
    // ---- speed and heading (the brain's wishes, within what the body can do)
    const vWant = Math.max(0, ctl.v || 0);
    const acc = ctl.accel || 6 * s, dec = ctl.decel || 8 * s;
    this.v += clamp(vWant - this.v, -dec * dt, acc * dt);
    if (this.v < 1e-4) this.v = 0;
    const dyaw = wrap((ctl.yaw ?? this.yaw) - this.yaw);
    // turning: at a walk a few degrees a step (~0.9 rad/s), faster at a trot, at speed what the lateral grip allows
    // (~0.7 g); one standing pivots on the spot, stepping round
    const vs = this.v / s;
    const wGait = vs < 0.06 ? 0.8 : vs < 1.5 ? 0.9 : vs < 4 ? 1.6 : 3;
    const wMax = ctl.turn || Math.min(wGait, (0.7 * G) / Math.max(this.v, 0.5));
    this.w = ease(this.w, clamp(dyaw * 4, -wMax, wMax), 12, dt);
    this.yaw = wrap(this.yaw + this.w * dt);
    this.x += Math.sin(this.yaw) * this.v * dt;
    this.z += Math.cos(this.yaw) * this.v * dt;
    // ---- gait at this speed (for the body's own size: a calf takes shorter, quicker strides)
    const mode = ctl.mode || null;
    const g = gaitAt(b, this.v / s, mode, this.g, this.set);
    g.stride *= s;
    if (g.name !== 'stott') g.freq = g.stride > 1e-9 ? this.v / g.stride : 0;
    // the stance can't sweep a foot further than the leg reaches: at speed the duty factor shortens
    const sweep = g.sweep * this.h;
    if (g.freq > 1e-4 && this.v > 1e-3 && !g.stiff) g.duty = Math.min(g.duty, (sweep * g.freq) / this.v);
    g.duty = Math.max(0.14, g.duty);
    this.crab = ease(this.crab, g.crab * smooth(0.6, 1.2, this.v / s) * (ctl.crabSide || 1), 3, dt);
    // ---- standing or striding
    const stride = vWant > 0.04 || this.v > 0.06 || mode === 'stott';
    if (stride && this.standing) {
      this.standing = false;
      this.phase = this.startPhase(g);
    } else if (!stride && !this.standing) this.standing = true;
    if (!this.standing) this.phase = fract(this.phase + g.freq * dt);
    // ---- the feet, the ground, the body (the ground is continuous: no lag on it, the body follows it exactly)
    this.groundRef(ground, 1);
    this.updateLegs(dt, ground, g);
    this.updateBody(dt, g, ctl);
  }

  // the stride phase to start from a standstill: the trailing hind foot is just lifting
  startPhase(g) {
    let worst = 2, back = Infinity;
    const sn = Math.sin(this.yaw), c = Math.cos(this.yaw);
    for (const L of this.legs) {
      if (L.l < 2) continue;
      const lz = (L.cx - this.x) * sn + (L.cz - this.z) * c;
      if (lz < back) (back = lz), (worst = L.l);
    }
    return fract(g.off[worst] + g.duty - 0.01);
  }

  updateLegs(dt, ground, g) {
    const s = this.scale, b = this.body;
    const f = g.freq, duty = g.duty;
    const T = f > 1e-4 ? 1 / f : Infinity;
    const Tsw = Math.min(0.6 * Math.sqrt(s), Math.max(0.07, (1 - duty) * T));
    // standing, one foot steps at a time; pivoting, a diagonal pair together (the other pair holding)
    const pivot = Math.abs(this.w) > 0.25;
    let nAir = 0, inAir = -1;
    for (const o of this.legs) if (o.st === 1) (nAir++, (inAir = o.l));
    for (const L of this.legs) {
      const leg = b.legs[L.l];
      const ph = legPhase(this.phase, g.off[L.l]);
      L.ph = ph;
      let wantSwing = !this.standing && ph >= duty;
      const mayStep = nAir === 0 ? this.stepT <= 0 || pivot : pivot && nAir === 1 && DIAG[L.l] === inAir;
      if (this.standing && L.st === 0 && mayStep) {
        // standing: a foot steps only when the body has left it (or turned away from it), one at a time; a stamp
        this.neutral(L, 0, this._p, this.x, this.z, this.yaw, 0);
        const off = Math.hypot(this._p.x - L.cx, this._p.z - L.cz);
        const turned = Math.abs(wrap(L.cyaw - this.yaw));
        if (off > (b.name === 'fox' ? 0.06 : 0.12) * s || turned > 0.4 || this.stampLeg === L.l) wantSwing = true;
      }
      if (L.st === 0) {
        L.u = this.standing ? 0.5 : clamp(ph / duty, 0, 1);
        if (!wantSwing && !this.standing && this.overreach(L, leg)) {
          // stretched beyond reach (a sharp turn, a sudden stop): the foot lifts early
          wantSwing = true;
          L.forced++;
          this.forcedLifts++;
          this.forcedReach = (this.forcedReach || 0) + 1;
        }
        if (wantSwing) this.liftOff(L, Tsw);
        else {
          // the heel rolls up over the toe at the end of the stance (push-off), with the stride
          const roll = g.stiff || this.standing ? 0 : (b.name === 'fox' ? 0.75 : 0.6) * g.amp * smooth(0.65, 1, L.u);
          L.heel = ease(L.heel, roll, 40, dt);
          this.fetlockOf(L, L.cx, L.cy, L.cz, L.cyaw, L.heel, L);
        }
      }
      if (L.st === 1) {
        // progress from the stride phase when striding (monotone, at most 2.5× the nominal rate); else at the
        // stepping rate; a foot whose stance is already due finishes its swing quickly
        let target;
        if (this.standing) target = L.s + dt / L.T;
        else if (ph >= duty) target = (ph - duty) / (1 - duty);
        else target = L.s + dt / 0.05;
        const sNew = Math.min(target, L.s + (2.5 * dt) / L.T);
        L.s = clamp(sNew > L.s ? sNew : L.s + dt / L.T, 0, 1);
        this.swingTarget(L, g, ground);
        this.swingPath(L, leg, g, ground);
        if (L.s >= 1) this.touchDown(L, ground);
      }
    }
    if (this.standing) {
      this.stepT -= dt;
      if (this.legs.some((o) => o.st === 1)) this.stepT = b.name === 'fox' ? 0.05 : 0.1;
    }
  }

  // the girdle joint (pivot) of a leg in the world, the body at its current height
  rootWorld(leg, o) {
    const s = this.scale, b = this.body;
    const a = this.yaw + this.crab;
    const sn = Math.sin(a), c = Math.cos(a);
    const jz = leg.root.z * s, jx = leg.x * s;
    o.x = this.x + jx * c + jz * sn;
    o.z = this.z - jx * sn + jz * c;
    const pitch = this.refPitch ?? this.pitch;
    o.y = this.gy + this.bodyY + (leg.root.y - b.plan.body[1]) * s + Math.sin(pitch) * leg.root.z * s;
    return o;
  }

  // stretched past its reach (late in the stance: as soon as it can't reach; earlier: well past it), or left out to the
  // side further than a leg swings out (a sharp turn over a planted foot)
  overreach(L, leg) {
    const r = this.rootWorld(leg, this._rw || (this._rw = { x: 0, y: 0, z: 0 }));
    if (Math.hypot(L.fx - r.x, L.fy - r.y, L.fz - r.z) > leg.reachEff * this.scale * (L.u > 0.85 ? 0.999 : 1.03)) return true;
    const a = this.yaw + this.crab;
    const side = (L.fx - r.x) * Math.cos(a) - (L.fz - r.z) * Math.sin(a); // + = toward the animal's left
    return Math.abs(side) > Math.tan(0.36) * Math.max(0.1, r.y - L.fy);
  }

  liftOff(L, Tsw) {
    L.st = 1;
    L.s = 0;
    L.stamping = this.standing && this.stampLeg === L.l;
    if (L.stamping) this.stampLeg = -1;
    L.T = this.standing ? (this.body.name === 'fox' ? 0.2 : 0.3) * Math.sqrt(this.scale) * (L.stamping ? 1.2 : 1) : Tsw;
    L.sx = L.fx;
    L.sy = L.fy;
    L.sz = L.fz;
  }

  // where the toe will go down: under its girdle at the middle of the coming stance, the body's motion predicted
  swingTarget(L, g, ground) {
    if (L.stamping) {
      // a stamp: the fore foot strikes back down where it stood
      L.ex = L.cx;
      L.ez = L.cz;
      L.eyaw = L.cyaw;
      L.ey = L.cy;
      return;
    }
    const tLand = (1 - L.s) * L.T;
    const T = g.freq > 1e-4 ? 1 / g.freq : 0;
    const tMid = this.standing ? 0 : tLand + (g.duty * T) / 2;
    const yawM = this.yaw + this.w * tMid * 0.5;
    const yawE = this.yaw + this.w * tMid;
    const px = this.x + Math.sin(yawM) * this.v * tMid, pz = this.z + Math.cos(yawM) * this.v * tMid;
    this.neutral(L, this.standing ? 0 : g.inset, this._p, px, pz, yawE, this.crab, this.standing ? 0 : g.amp);
    L.ex = this._p.x;
    L.ez = this._p.z;
    L.eyaw = yawE + this.crab;
    L.ey = ground(L.ex, L.ez);
    // never a step down a drop or up a wall (a cliff edge, the side of a stone step): the foot comes down under its
    // girdle instead
    const ref = this.body.legs[L.l].fore ? this.gf : this.gh;
    if (Math.abs(L.ey - ref) > 0.45 * this.h) {
      this.neutral(L, 0, this._p, this.x, this.z, this.yaw, this.crab, 0);
      L.ex = this._p.x;
      L.ez = this._p.z;
      L.ey = ground(L.ex, L.ez);
    }
    // the slope under the coming foot (the heel's ground; none far from the camera)
    L.edh = this.lod ? 0 : this.heelRise(L, L.ex, L.ey, L.ez, L.eyaw, ground);
  }

  swingPath(L, leg, g, ground) {
    const s = this.scale, h = this.h;
    const fe = this.fetlockOf(L, L.ex, L.ey, L.ez, L.eyaw, 0, this._f, L.edh || 0);
    const u = L.s, e = u * u * (3 - 2 * u);
    let lift = (leg.fore ? g.lift0 : g.lift1) * h * g.amp;
    if (this.standing) lift = (this.body.name === 'fox' ? 0.08 : 0.06) * h;
    if (L.stamping) lift = 0.2 * h;
    // the fore foot rises early and reaches out at the end; the hind foot's arc is rounder
    const arc = leg.fore ? Math.pow(Math.sin(Math.PI * Math.pow(u, 0.75)), 1.2) : Math.sin(Math.PI * u);
    L.fx = L.sx + (fe.fx - L.sx) * e;
    L.fz = L.sz + (fe.fz - L.sz) * e;
    const base = L.sy + (fe.fy - L.sy) * e;
    // never through the ground in between (a rise under the swing; far from the camera: the straight line)
    L.gSwing = this.lod ? L.cy + (L.ey - L.cy) * e : ground(L.fx, L.fz);
    const gy = this.lod ? base : L.gSwing + leg.foot.up * s;
    L.fy = Math.max(base, gy) + lift * arc;
    if (g.stiff) {
      // the stott: in the air the stiff legs hang straight under the body, then reach for the ground again
      const r = this.rootWorld(leg, this._rw2 || (this._rw2 = { x: 0, y: 0, z: 0 }));
      const hang = r.y - leg.reachEff * s * 0.98;
      const k = bump(u, 0, 1);
      L.fx += (r.x - L.fx) * k * 0.6;
      L.fz += (r.z - L.fz) * k * 0.6;
      L.fy = Math.max(L.fy, hang);
    }
    L.heel = 0;
  }

  touchDown(L, ground) {
    L.st = 0;
    L.s = 1;
    L.u = 0;
    L.cx = L.ex;
    L.cz = L.ez;
    L.cy = ground(L.cx, L.cz);
    L.cyaw = L.eyaw;
    L.cdh = this.lod ? 0 : L.edh !== undefined ? L.edh : this.heelRise(L, L.cx, L.cy, L.cz, L.cyaw, ground);
    L.heel = 0;
    const was = L.stamping;
    L.stamping = false;
    this.fetlockOf(L, L.cx, L.cy, L.cz, L.cyaw, 0, L);
    if (this.onStep) this.onStep(L, was);
  }

  // the body over the feet: height (ground under the girdles, the gait's bob and flight, let down where the legs can't
  // reach), pitch (the ground's, the gait's rocking), spine flexion, roll into the turns; the sit, the crouch
  updateBody(dt, g, ctl) {
    const b = this.body, s = this.scale, h = this.h;
    const amp = g.amp, ph = this.phase;
    let bob = 0, pitch = 0, spine = 0, nod = 0, fly = 0;
    if (!this.standing) {
      const T = g.freq > 1e-4 ? 1 / g.freq : 0;
      bob = -g.bob * h * amp * Math.cos(TAU * (g.beats * ph - g.bobAt));
      // the suspensions are ballistic: exactly the parabola of the flight, back to the ground at the touchdown
      fly = flightHeight(g, ph, T);
      pitch = g.pitch * amp * Math.sin(TAU * (ph - g.pitchAt));
      spine = g.spine * amp * Math.cos(TAU * (ph - g.spineAt));
      nod = g.nod * amp * Math.sin(TAU * (g.nodBeats * ph - g.nodAt));
    }
    this.bobC = ease(this.bobC || 0, bob, 45, dt);
    this.bob = this.bobC + fly;
    this.spine = ease(this.spine, spine, 30, dt);
    this.nod = ease(this.nod, nod, 30, dt);
    this.sit = ease(this.sit, ctl.sit || 0, 3.5, dt);
    this.crouch = ease(this.crouch, ctl.crouch || 0, 10, dt);
    // the body rides as low as the gait's stance sweep needs (the legs reach the ends of the sweep), a little lower
    // with speed (the legs work more flexed); a crouch gathers it down
    const lowV = (b.name === 'fox' ? 0.05 : 0.03) * h * smooth(1, 8, this.v / s);
    const gl = this.standing ? 0 : this.gaitLower(g);
    this.gLow = ease(this.gLow || 0, gl, 6, dt);
    // a planted leg that still can't stretch to its foot (a hollow, downhill, a sudden stop) lets its girdle down to
    // it (the fore and the hind end each: the body pitches when only one end needs it), up to a point: beyond it a
    // foot late in its stance is picked up instead. Measured against the body at its nominal height and pitch.
    const basePitch = this.gPitch + pitch - this.crouch * 0.05;
    this.bodyY = b.plan.body[1] * s + this.bob;
    this.refPitch = basePitch;
    let needF = 0, needH = 0;
    const cap = 0.12 * h;
    // (far from the camera, lod 1: the gait's own lowering only, no per-foot reach corrections; none sitting either:
    // the sit poses the legs itself)
    for (const L of this.lod || this.sit > 0.05 ? NO_LEGS : this.legs) {
      const leg = b.legs[L.l];
      let lack = 0;
      if (L.st !== 0) {
        // a foot about to land lower than the body can reach: the body starts down before it lands (the landing spot
        // against where the girdle will be by then)
        if (L.s > 0.4) {
          this.fetlockOf(L, L.ex, L.ey, L.ez, L.eyaw, 0, this._f, L.edh || 0);
          const tr = this.v * (1 - L.s) * L.T;
          const ax = this._f.fx - Math.sin(this.yaw) * tr, az = this._f.fz - Math.cos(this.yaw) * tr;
          lack = this.lackAt(leg, ax, this._f.fy, az) * smooth(0.4, 0.92, L.s);
        }
      } else {
        lack = this.lack(L, leg);
        // (late in its stance only: a foot that has just landed low, downhill, is a reach the body comes down to)
        if (lack > cap + this.gLow + lowV && !this.standing && L.u > 0.5) {
          this.liftOff(L, Math.max(0.08, L.T));
          L.forced++;
          this.forcedLifts++;
          this.forcedLack = (this.forcedLack || 0) + 1;
          continue;
        }
      }
      if (leg.fore) needF = Math.max(needF, lack);
      else needH = Math.max(needH, lack);
    }
    this.refPitch = null;
    const base = lowV + this.gLow + this.crouch * 0.14 * h;
    const wf = Math.max(base, Math.min(needF, 0.38 * h)), wh = Math.max(base, Math.min(needH, 0.38 * h));
    this.lowF = ease(this.lowF ?? 0, wf, wf > (this.lowF ?? 0) ? 60 : 6, dt);
    this.lowH = ease(this.lowH ?? 0, wh, wh > (this.lowH ?? 0) ? 60 : 6, dt);
    this.lower = (this.lowF + this.lowH) / 2;
    this.bodyY -= this.lower;
    // the girdles lowered unequally pitch the trunk (nose down when the fore end comes down further)
    const lg = (b.zFore - b.zHind) * s;
    this.pitch = basePitch - Math.atan2(this.lowF - this.lowH, lg);
    this.roll = ease(this.roll, clamp(-this.w * this.v * 0.02, -0.15, 0.15), 6, dt);
  }

  // how much lower than square the body must ride for its legs to reach both ends of the gait's stance sweep (m)
  gaitLower(g) {
    if (g.stiff) return 0;
    const s = this.scale;
    const sweep = Math.min(g.sweep * this.h, g.duty * g.stride);
    let need = 0;
    for (let k = 0; k < 3; k += 2) {
      const leg = this.body.legs[k];
      const max = leg.reachEff * s * 0.98, half = sweep / 2;
      const v = half < max ? Math.sqrt(max * max - half * half) : 0;
      need = Math.max(need, leg.drop * s - v);
    }
    return Math.max(0, need);
  }

  // how far (m) a planted leg falls short of its fetlock with the body at its nominal height (0: it reaches)
  lack(L, leg) {
    return this.lackAt(leg, L.fx, L.fy, L.fz);
  }

  lackAt(leg, fx, fy, fz) {
    const r = this.rootWorld(leg, this._rw || (this._rw = { x: 0, y: 0, z: 0 }));
    const max = leg.reachEff * this.scale * 0.985;
    const dxz = Math.hypot(fx - r.x, fz - r.z);
    if (dxz >= max) return 0;
    const lack = r.y - fy - Math.sqrt(max * max - dxz * dxz);
    return lack > 0 ? lack : 0;
  }

  // ---- a leap (the fox's pounce): crouch → push-off → ballistic flight → the fore feet first, the nose down
  // leap({ dist, height, yaw, drop, crouchT, settle }); false if already in the air
  leap(o) {
    if (this.air) return false;
    const h = Math.max(0.05, o.height), d = Math.max(0.1, o.dist);
    const vy = Math.sqrt(2 * G * h);
    const drop = (o.drop || 0) * this.scale; // the body lands this much lower than it took off (reaching down)
    const T = vy / G + Math.sqrt((2 * (h + drop)) / G);
    this.air = { t: -(o.crouchT ?? 0.45), T, vy, vh: d / T, yaw: o.yaw ?? this.yaw, y0: 0, x0: 0, z0: 0, h, d, drop, landed: 0, settle: o.settle ?? 0.9 };
    this.v = 0;
    this.w = 0;
    this.standing = true;
    return true;
  }

  stepAir(dt, ground, ctl) {
    const A = this.air, b = this.body, s = this.scale;
    A.t += dt;
    this.yaw += wrap(A.yaw - this.yaw) * Math.min(1, dt * 12);
    const nominal = b.plan.body[1] * s;
    if (A.t < 0) {
      // the crouch: hind legs gathered under, the body low and the weight back, ears and eyes on the spot
      this.crouch = ease(this.crouch, 1, 8, dt);
      this.lower = ease(this.lower, 0.22 * this.h, 9, dt);
      this.bodyY = nominal - this.lower;
      this.pitch = ease(this.pitch, this.gPitch + 0.16, 8, dt);
      this.groundRef(ground, 0.3);
      for (const L of this.legs) if (L.st === 0) this.fetlockOf(L, L.cx, L.cy, L.cz, L.cyaw, 0, L);
      A.x0 = this.x;
      A.z0 = this.z;
      A.y0 = this.gy + this.bodyY;
      // the arc to the ground where it will land (a rise or a dip ahead): apex `h` over the higher end, the body coming
      // down to its landing height (a little lower than it took off: it reaches down) over that ground
      if (A.t + dt >= 0) {
        const lx = this.x + Math.sin(A.yaw) * A.d, lz = this.z + Math.cos(A.yaw) * A.d;
        // it comes down nose first, propped on its fore legs: the shoulder blades a fore leg's reach over the ground
        // at the dive's pitch (the body's centre above them by the trunk's tilt)
        const fl = b.legs[0], pl = -1.0;
        const rootOff = (fl.root.z * Math.sin(pl) + (fl.root.y - b.plan.body[1]) * Math.cos(pl)) * s;
        const yEnd = ground(lx, lz) + Math.max(this.bodyY - A.drop, 0.8 * fl.reachEff * s - rootOff);
        const apex = Math.max(A.y0, yEnd) + A.h;
        A.vy = Math.sqrt(2 * G * (apex - A.y0));
        A.T = A.vy / G + Math.sqrt((2 * (apex - yEnd)) / G);
        A.vh = A.d / A.T;
      }
      return;
    }
    if (A.t < A.T) {
      // ballistic flight of the body; pitch along the velocity (nose up out of the push, nose down into the landing)
      const t = A.t;
      this.x = A.x0 + Math.sin(this.yaw) * A.vh * t;
      this.z = A.z0 + Math.cos(this.yaw) * A.vh * t;
      const y = A.y0 + A.vy * t - (G * t * t) / 2;
      this.groundRef(ground, 1);
      this.bodyY = y - this.gy;
      const vy = A.vy - G * t;
      // (the mousing dive: the body tips past its path at the end, nose first into the grass)
      this.pitch = ease(this.pitch, Math.max(-1.2, Math.atan2(vy, A.vh) * 0.9 - 0.3 * smooth(0.55, 1, t / A.T)), 16, dt);
      this.crouch = ease(this.crouch, 0, 8, dt);
      this.lower = 0;
      this.airPhase = t / A.T;
      // the feet: off the ground, posed from the body (poseBones reads airPhase); kept here for the bookkeeping
      for (const L of this.legs) {
        L.st = 1;
        L.s = 0.5;
        this.airFoot(L, this.airPhase, ground);
      }
      return;
    }
    // landed: the fore feet first (reaching out, the nose down between them), the hind feet a beat later as the rear
    // comes down
    const k = A.t - A.T;
    const plant = (L, fwd) => {
      this.neutral(L, 0.4, this._p, this.x, this.z, this.yaw, 0);
      L.cx = this._p.x + Math.sin(this.yaw) * fwd;
      L.cz = this._p.z + Math.cos(this.yaw) * fwd;
      L.cy = ground(L.cx, L.cz);
      L.cyaw = this.yaw;
      L.cdh = this.heelRise(L, L.cx, L.cy, L.cz, L.cyaw, ground);
      L.st = 0;
      L.s = 1;
      L.u = 0;
      L.heel = 0;
      this.fetlockOf(L, L.cx, L.cy, L.cz, L.cyaw, 0, L);
      if (this.onStep) this.onStep(L, false);
    };
    if (!A.landed) {
      A.landed = A.t;
      this.airPhase = -1;
      for (const L of this.legs) if (b.legs[L.l].fore) plant(L, 0.05 * s);
    }
    if (!A.hind && k > 0.16) {
      A.hind = true;
      for (const L of this.legs) if (!b.legs[L.l].fore) plant(L, -0.03 * s);
    }
    if (!A.hind) for (const L of this.legs) if (!b.legs[L.l].fore) this.airFoot(L, 1, ground);
    this.groundRef(ground, 1);
    // the landing taken up by the fore legs: the body sinks, then rises; the rear comes down; the planted legs reach
    const sink = 0.18 * this.h * Math.exp(-k * 4) * (1 - Math.exp(-k * 30));
    this.pitch = ease(this.pitch, this.gPitch - 0.3 * Math.exp(-k * 1.4), 10, dt);
    const was = this.bodyY;
    this.bodyY = nominal - sink;
    let need = 0;
    for (const L of this.legs) if (L.st === 0) need = Math.max(need, this.lack(L, b.legs[L.l]));
    this.bodyY = ease(was, nominal - sink - Math.min(need, 0.4 * this.h), 16, dt);
    if (k > A.settle) {
      this.air = null;
      this.lower = this.lowF = this.lowH = Math.max(0, nominal - this.bodyY);
      this.standing = true;
    }
  }

  // a foot in the leap's flight: posed from the body (fore legs tucked on the rise, reaching down and forward for the
  // landing; hind legs stretched back after the push, then gathered); its ground (for the toe) right under it
  airFoot(L, u, ground = null) {
    const leg = this.body.legs[L.l], s = this.scale;
    const a = this.yaw, sn = Math.sin(a), c = Math.cos(a);
    const pitch = this.pitch;
    // in the body's frame: the girdle joint, then the foot hanging from it
    const rz = leg.root.z * s, ry = (leg.root.y - this.body.plan.body[1]) * s;
    const len = leg.reach * s;
    let ang; // the leg's direction (rad from straight down, + = forward) in the body frame
    if (leg.fore) ang = -0.6 + 1.6 * smooth(0.25, 0.85, u);
    else ang = -0.9 * (1 - smooth(0.0, 0.7, u)) - 0.2 + 0.5 * smooth(0.6, 1, u);
    const k = leg.fore ? 0.78 + 0.2 * smooth(0.4, 0.9, u) : 0.8;
    const lz = rz + Math.sin(ang) * len * k, ly = ry - Math.cos(ang) * len * k;
    // body pitch: rotate (lz, ly) by pitch (nose up = +)
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const wz = lz * cp - ly * sp, wy = lz * sp + ly * cp;
    L.fx = this.x + sn * wz + (leg.x * s) * c;
    L.fz = this.z + c * wz - (leg.x * s) * sn;
    L.fy = this.gy + this.bodyY + wy;
    if (ground) {
      L.cx = L.ex = L.fx;
      L.cz = L.ez = L.fz;
      L.cy = L.ey = ground(L.fx, L.fz);
      // a foot reaching down never into the ground (the fetlock a foot's height over it)
      L.fy = Math.max(L.fy, L.cy + leg.foot.up * s);
    }
  }

}

// ------------------------------------------------------------------------------------------------------------ pose
// The pose channels a brain sets on top of the locomotion: head look (yaw / pitch, rad, + = left / up), neck carriage
// (rad, + = up), graze (0..1: the muzzle to the ground), head cock (roll), ears (prick 0..1, back 0..1, turn each),
// tail (lift rad, + = up; curl 0..1 round the feet; sway), rump flare (0..1).
export function makePose() {
  return { lookYaw: 0, lookPitch: 0, neck: 0, graze: 0, cock: 0, prick: 0.5, earBack: 0, earL: 0, earR: 0, tail: 0, tailCurl: 0, tailSway: 0, flare: 0 };
}

const _lim = { reach: true, err: 0, j: new Float64Array(10), a: new Float64Array(4) };
// the trunk's tilt sitting (rad): a fox sits up at ~50°
const SIT_PITCH = 0.85;
const _Rg = new Array(9), _Rz = new Array(9);
const _t = { x: 0, y: 0, z: 0 }, _c = { x: 0, y: 0, z: 0 }, _tl = { x: 0, y: 0, z: 0 }, _cl = { x: 0, y: 0, z: 0 };

// Bones → skinning matrices. out.bones: Float32Array(nb × 12), rows of each bone's 3×4 matrix (rest model → posed
// model); out.place: { x, y, z, yaw, scale } the model's world placement (the instance matrix); pose: the channels.
export function poseBones(loco, pose, out) {
  const b = loco.body, s = loco.scale, P = b.plan;
  const nb = b.nb;
  if (!out.R) {
    out.R = new Float64Array(nb * 9);
    out.H = new Float64Array(nb * 3);
    out.bones = new Float32Array(nb * 12);
    out.place = { x: 0, y: 0, z: 0, yaw: 0, scale: 1 };
    out.joints = new Float64Array(4 * 6 * 3); // leg joints in the girdle frames (tests)
    out.err = new Float64Array(4);
  }
  const R = out.R, H = out.H, rest = b.rest;
  const place = out.place;
  place.x = loco.x;
  place.z = loco.z;
  place.y = loco.gy;
  place.yaw = loco.yaw;
  place.scale = s;
  const set = (i, M, hx, hy, hz) => {
    for (let k = 0; k < 9; k++) R[i * 9 + k] = M[k];
    H[i * 3] = hx;
    H[i * 3 + 1] = hy;
    H[i * 3 + 2] = hz;
  };
  // a child bone: head = parent's head + R_parent (rest_i − rest_parent) (+ shift in the parent's frame), rotation M
  const child = (i, parent, M, sz = 0) => {
    const p = parent * 3, c = i * 3, pr = parent * 9;
    const dx = rest[c] - rest[p], dy = rest[c + 1] - rest[p + 1], dz = rest[c + 2] - rest[p + 2] + sz;
    H[c] = H[p] + R[pr] * dx + R[pr + 1] * dy + R[pr + 2] * dz;
    H[c + 1] = H[p + 1] + R[pr + 3] * dx + R[pr + 4] * dy + R[pr + 5] * dz;
    H[c + 2] = H[p + 2] + R[pr + 6] * dx + R[pr + 7] * dy + R[pr + 8] * dz;
    for (let k = 0; k < 9; k++) R[i * 9 + k] = M[k];
  };
  const Rof = (i, o) => {
    for (let k = 0; k < 9; k++) o[k] = R[i * 9 + k];
    return o;
  };
  // ---- trunk: body (crab, pitch, roll, height); chest and pelvis (spine flexion: both ends down, the trunk shorter).
  // Sitting (fox) turns the trunk up about the tops of the shoulder blades (the fore legs stay straight and planted):
  // the haunches come down and forward over the gathered hind feet.
  const fox = b.name === 'fox';
  const sit = loco.sit;
  // (the trunk's angle sitting is the fox's, whatever the slope: the slope's own pitch fades out of it)
  const th = sit * (SIT_PITCH - loco.gPitch);
  const pitch = loco.pitch + th;
  mul(ry(loco.crab, _ma), rx(-pitch, _mb), _mc);
  mul(_mc, rz(loco.roll, _ma), _md);
  const Sz = P.fore.top[0], Sy = P.fore.top[1], vz = P.body[2] - Sz, vy = P.body[1] - Sy;
  const cz = Sz + vz * Math.cos(th) - vy * Math.sin(th), cyy = Sy + vz * Math.sin(th) + vy * Math.cos(th);
  const by = loco.bodyY / s + (cyy - P.body[1]);
  set(0, _md, P.body[0], by, cz);
  const ci = b.index.chest, pi = b.index.pelvis;
  const shift = loco.spine * P.spineShift;
  child(ci, 0, mul(_md, rx(loco.spine, _ma), _mb), -shift);
  child(pi, 0, mul(_md, rx(-loco.spine, _ma), _mc), shift);
  // ---- neck and head: carriage + look spread over the neck; the head keeps a natural angle to the ground
  const n1 = b.index.neck1, n2 = b.index.neck2, hd = b.index.head;
  const lookY = clamp(pose.lookYaw, -2.0, 2.0);
  const lookP = clamp(pose.lookPitch, -1.0, 0.9);
  const graze = pose.graze;
  const carriage = pose.neck - graze * (fox ? 1.1 : 1.75) - loco.nod;
  const p1 = -(carriage * 0.55 + lookP * 0.25) + pitch * 0.4 * (1 - graze);
  const p2 = -(carriage * 0.45 + lookP * 0.3);
  const p3 = -(lookP * 0.45) + (carriage + pitch) * 0.6 - graze * (fox ? 0.1 : -0.15);
  child(n1, ci, mul(Rof(ci, _Rg), mul(ry(lookY * 0.3, _ma), rx(p1, _mb), _mc), _md));
  child(n2, n1, mul(Rof(n1, _Rg), mul(ry(lookY * 0.35, _ma), rx(p2, _mb), _mc), _md));
  mul(ry(lookY * 0.35, _ma), rx(p3, _mb), _mc);
  child(hd, n2, mul(Rof(n2, _Rg), mul(_mc, rz(pose.cock, _ma), _mb), _md));
  // ---- ears: pricked (up, forward), laid back (flight), turned (listening)
  for (const [n, sd, turn] of [['earL', 1, pose.earL], ['earR', -1, pose.earR]]) {
    const i = b.index[n];
    const tiltBack = 1.0 * pose.earBack - 0.3 * pose.prick + 0.15;
    const out_ = sd * (0.35 * (1 - pose.prick) + 0.35 * pose.earBack);
    mul(ry(sd * 0.25 * (1 - pose.prick) + turn, _ma), rx(-tiltBack, _mb), _mc);
    child(i, hd, mul(Rof(hd, _Rg), mul(_mc, rz(-out_, _ma), _mb), _md));
  }
  // ---- tail: lift at the root, droop / sway down the chain; curl wraps it round the feet (a sitting fox)
  const nt = b.tail;
  for (let k = 0; k < nt; k++) {
    const i = b.index['tail' + (k + 1)];
    const parent = k ? b.index['tail' + k] : pi;
    const root = k === 0;
    const lift = root ? pose.tail : fox ? -0.1 * pose.tail : 0.15 * pose.tail;
    const sway = pose.tailSway * (root ? 0.5 : 0.3) + pose.tailCurl * (fox ? (root ? 0.25 : 0.6) : 0);
    const curl = pose.tailCurl * (root ? -0.35 : 0.2);
    mul(ry(sway, _ma), rx(lift + curl, _mb), _mc);
    child(i, parent, mul(Rof(parent, _Rg), _mc, _md));
  }
  // ---- rump patch (deer): it rides the pelvis (its flare is a morph of the patch in the mesh: beasts.js aKzAlt)
  if (b.index.rump !== undefined) child(b.index.rump, pi, Rof(pi, _Rg));
  // ---- legs: targets from the world into each girdle's rest frame, the pantograph IK, bones
  const cy = Math.cos(loco.yaw), sy = Math.sin(loco.yaw);
  for (let l = 0; l < 4; l++) poseLeg(loco, b.legs[l], loco.legs[l], R, H, rest, out, cy, sy);
  // ---- skinning matrices: M = [R | head − R·rest]
  const M = out.bones;
  for (let i = 0; i < nb; i++) {
    const r = i * 9, h = i * 3, o = i * 12;
    const x0 = rest[h], y0 = rest[h + 1], z0 = rest[h + 2];
    M[o] = R[r]; M[o + 1] = R[r + 1]; M[o + 2] = R[r + 2]; M[o + 3] = H[h] - (R[r] * x0 + R[r + 1] * y0 + R[r + 2] * z0);
    M[o + 4] = R[r + 3]; M[o + 5] = R[r + 4]; M[o + 6] = R[r + 5]; M[o + 7] = H[h + 1] - (R[r + 3] * x0 + R[r + 4] * y0 + R[r + 5] * z0);
    M[o + 8] = R[r + 6]; M[o + 9] = R[r + 7]; M[o + 10] = R[r + 8]; M[o + 11] = H[h + 2] - (R[r + 6] * x0 + R[r + 7] * y0 + R[r + 8] * z0);
  }
  return out;
}

// world → model (the model sits at (x, gy, z), turned by yaw, scaled by s)
function toModel(loco, wx, wy, wz, cy, sy, o) {
  const dx = wx - loco.x, dy = wy - loco.gy, dz = wz - loco.z, s = loco.scale;
  o.x = (cy * dx - sy * dz) / s;
  o.y = dy / s;
  o.z = (sy * dx + cy * dz) / s;
  return o;
}

function poseLeg(loco, leg, L, R, H, rest, out, cy, sy) {
  const g = leg.girdle, gr = g * 9, gh = g * 3;
  toModel(loco, L.fx, L.fy, L.fz, cy, sy, _t);
  toModel(loco, L.cx, L.cy, L.cz, cy, sy, _c);
  // → the girdle's rest frame: R_gᵀ (p − head_g) + rest_g
  const toLocal = (p, o) => {
    const dx = p.x - H[gh], dy = p.y - H[gh + 1], dz = p.z - H[gh + 2];
    o.x = R[gr] * dx + R[gr + 3] * dy + R[gr + 6] * dz + rest[gh];
    o.y = R[gr + 1] * dx + R[gr + 4] * dy + R[gr + 7] * dz + rest[gh + 1];
    o.z = R[gr + 2] * dx + R[gr + 5] * dy + R[gr + 8] * dz + rest[gh + 2];
    return o;
  };
  toLocal(_t, _tl);
  toLocal(_c, _cl);
  const g8 = loco.g, amp = g8.amp;
  const swing = L.st === 1 ? L.s : 0;
  const air = loco.airPhase;
  const standK = loco.standing ? 0.6 : 0;
  // abduction about the z axis through the root: the leg's plane leans toward the target (a principal angle, the
  // target's depth in the plane signed: a foot gathered level with a tilted pelvis, sitting, is in front of the hip,
  // not out to its side); a leg swings out ±0.4 rad at most
  const jz = leg.root.z, jy = leg.root.y;
  const ox = _tl.x - leg.x, oy = _tl.y - jy;
  // (a target nearly straight ahead of the root in a pitched girdle — the pounce's dive — leans the plane little)
  const den = Math.max(-oy, 0.6 * Math.hypot(oy, _tl.z - jz), 1e-5);
  const abd = clamp(Math.atan(ox / den), -0.4, 0.4);
  const Fy = jy - (ox * Math.sin(abd) - oy * Math.cos(abd));
  let off1 = leg.off1, off2 = 0;
  if (leg.fore) {
    // carpus: a little overextended under load, folding toward the end of the stance; folded up in the swing (the
    // paw tucked under the forearm), loose in a stott; tucked on the rise of a leap, opening for the landing
    let kappa;
    if (L.st === 0) kappa = leg.kappa0 - 0.1 * amp * Math.sin(Math.PI * L.u) + 0.5 * amp * smooth(0.8, 1, L.u);
    else kappa = leg.kappa0 + g8.flex * Math.max(amp, standK) * bump(swing, 0.02, 0.88) * (g8.stiff ? 0.25 : 1);
    if (air >= 0) kappa = leg.kappa0 + 1.6 * bump(air, 0.0, 0.62);
    off2 = leg.off1 - kappa; // the metacarpus: kappa back from the radius
  } else {
    // the hock flexes harder early in the swing (the foot trails, then is brought forward); sitting, the metatarsus
    // comes to lie along the ground under the forward-pointing thigh
    if (L.st === 1) off1 = leg.off1 - g8.hock * Math.max(amp, standK) * bump(swing, 0.0, 0.7) * (g8.stiff ? 0.2 : 1);
    if (air >= 0) off1 = leg.off1 - 0.45 * bump(air, 0.1, 1);
    off1 += loco.sit * 0.45;
  }
  // a fold that leaves the limb too short for its target opens just enough (closed form: |W| as a function of the
  // carpus / hock angle); never past the standing angle
  const d = Math.hypot(_tl.z - jz, Fy - jy);
  if (leg.fore) {
    const Pz = leg.Lp + leg.Ld * Math.cos(off1), Py = leg.Ld * Math.sin(off1), Pl = Math.hypot(Pz, Py);
    const lwNow = Math.hypot(Pz + leg.Le * Math.cos(off2), Py + leg.Le * Math.sin(off2));
    const want = d / 0.999 - leg.Lm;
    if (want > lwNow) {
      const c = (want * want - Pl * Pl - leg.Le * leg.Le) / (2 * leg.Le * Pl);
      const th = Math.atan2(Py, Pz);
      // off2 = th − acos(c) (the metacarpus behind the composite's line, as it folds)
      const o2 = c >= 1 ? th : th - Math.acos(Math.max(-1, c));
      off2 = Math.max(off2, Math.min(o2, leg.off1 - leg.kappa0));
    }
  } else {
    const lwNow = Math.hypot(leg.Lp + leg.Ld * Math.cos(off1), leg.Ld * Math.sin(off1));
    const want = d / 0.999 - leg.Lm;
    if (want > lwNow) {
      const c = (want * want - leg.Lp * leg.Lp - leg.Ld * leg.Ld) / (2 * leg.Lp * leg.Ld);
      const o1 = c >= 1 ? 0 : -Math.acos(Math.max(-1, c));
      off1 = Math.max(off1, Math.min(o1, leg.off1));
    }
  }
  const lim = solveLimb(leg, jz, jy, _tl.z, Fy, off1, off2, leg.reach * 0.999, _lim);
  out.err[leg.l] = lim.err;
  if (!leg.fore && L.st === 0 && air < 0) hockAboveGround(leg, lim, jz, jy, R, gr, (L.cdh || 0) / loco.scale, smooth(0.3, 0.85, loco.sit));
  const n = leg.fore ? 4 : 3; // proximal segments solved; then the toe
  const ang = _ang;
  for (let k = 0; k < n; k++) ang[k] = lim.a[k === 3 ? 3 : k];
  if (!leg.fore) ang[2] = lim.a[2];
  // joints into out.joints (girdle frame, the abduction applied)
  const j = lim.j;
  for (let k = 0; k <= n; k++) planar(out, leg, k, jy, j[k * 2], j[k * 2 + 1], abd);
  // toe: in stance from the fetlock to the contact (in the leg's plane); in the swing following the metapodial, curled
  const ez = leg.fore ? j[8] : j[6], ey = leg.fore ? j[9] : j[7];
  const meta = ang[n - 1];
  // the toe: in stance aimed (in 3D) from the fetlock at its contact; in the swing it follows the metapodial, curled,
  // and at the ends of the swing still points at the ground it left / already at the ground it will meet
  const fo = (leg.l * 6 + n) * 3;
  const fxj = out.joints[fo], fyj = out.joints[fo + 1], fzj = out.joints[fo + 2];
  const aim = (p, o) => {
    const tx = p.x - fxj, ty = p.y - fyj, tz = p.z - fzj, tl = Math.hypot(tx, ty, tz) || 1;
    o.a = -Math.acos(clamp(tz / tl, -1, 1));
    o.abd = Math.atan2(tx, -ty);
    return o;
  };
  let aToe, abdToe = abd;
  if (L.st === 0 && air < 0) {
    aim(_cl, _aim);
    aToe = _aim.a;
    abdToe = _aim.abd;
  } else {
    const curl = (leg.fore ? 0.9 : 0.6) * bump(swing, 0.0, 0.8) * (g8.stiff ? 0.2 : 1) * Math.max(amp, standK);
    aToe = meta + (leg.rest[n] - leg.rest[n - 1]) - curl;
    if (air >= 0) aToe = meta + (leg.rest[n] - leg.rest[n - 1]) - (leg.fore ? 0.4 : 0.9) * (1 - air);
    else {
      const w0 = 1 - smooth(0, 0.18, swing), w1 = smooth(0.82, 1, swing);
      if (w0 > 0) {
        aim(_cl, _aim);
        aToe += wrap(_aim.a - aToe) * w0;
        abdToe += wrap(_aim.abd - abdToe) * w0;
      }
      if (w1 > 0) {
        toModel(loco, L.ex, L.ey, L.ez, cy, sy, _c);
        aim(toLocal(_c, _cl), _aim);
        aToe += wrap(_aim.a - aToe) * w1;
        abdToe += wrap(_aim.abd - abdToe) * w1;
      }
    }
    // the toe never dips through the ground (between the ground it left and the ground it will land on), measured
    // along the true vertical (the model's up in the girdle frame: the girdle may be pitched steeply, a dive)
    const gyw = (air >= 0 ? L.cy : L.gSwing ?? L.cy + (L.ey - L.cy) * swing) + 0.004 * loco.scale;
    toModel(loco, L.fx, gyw, L.fz, cy, sy, _c);
    toLocal(_c, _cl);
    const ux = R[gr + 3], uy = R[gr + 4], uz = R[gr + 5];
    const need = (_cl.x - fxj) * ux + (_cl.y - fyj) * uy + (_cl.z - fzj) * uz; // ground over the fetlock (−: below it)
    // the toe's rise along up: A sin a + B cos a (the toe vector Lt·(−sin abd sin a, cos abd sin a, cos a))
    const A = leg.Lt * (uy * Math.cos(abdToe) - ux * Math.sin(abdToe)), B = leg.Lt * uz;
    const Rr = Math.hypot(A, B);
    if (Rr > 1e-6 && A * Math.sin(aToe) + B * Math.cos(aToe) < need) {
      const q = need / Rr;
      if (q < 1) {
        const phi = Math.atan2(B, A), s0 = Math.asin(Math.max(-1, q));
        const a1 = s0 - phi, a2 = Math.PI - s0 - phi;
        aToe = Math.abs(wrap(a1 - aToe)) < Math.abs(wrap(a2 - aToe)) ? a1 : a2;
      }
    }
  }
  ang[n] = aToe;
  // the toe's end, for the tests: the fetlock + Lt along rotZ(abdToe)·(0, sin a, cos a)
  {
    const sa = Math.sin(aToe), o = (leg.l * 6 + n + 1) * 3;
    out.joints[o] = fxj - Math.sin(abdToe) * sa * leg.Lt;
    out.joints[o + 1] = fyj + Math.cos(abdToe) * sa * leg.Lt;
    out.joints[o + 2] = fzj + Math.cos(aToe) * leg.Lt;
  }
  // bones (girdle frame → model): R = R_g · rotZ(abd) · rotX(rest − angle)
  for (let k = 0; k < 9; k++) _Rg[k] = R[gr + k];
  const bones = leg.bones;
  for (let k = 0; k <= n; k++) {
    const bi = bones[k];
    rz(k === n ? abdToe : abd, _Rz);
    rx(leg.rest[k] - ang[k], _ma);
    mul(_Rz, _ma, _mc);
    mul(_Rg, _mc, _me);
    for (let q = 0; q < 9; q++) R[bi * 9 + q] = _me[q];
    const o = (leg.l * 6 + k) * 3;
    const ddx = out.joints[o] - rest[gh], ddy = out.joints[o + 1] - rest[gh + 1], ddz = out.joints[o + 2] - rest[gh + 2];
    H[bi * 3] = H[gh] + _Rg[0] * ddx + _Rg[1] * ddy + _Rg[2] * ddz;
    H[bi * 3 + 1] = H[gh + 1] + _Rg[3] * ddx + _Rg[4] * ddy + _Rg[5] * ddz;
    H[bi * 3 + 2] = H[gh + 2] + _Rg[6] * ddx + _Rg[7] * ddy + _Rg[8] * ddz;
  }
}
const _ang = [0, 0, 0, 0, 0];
const _aim = { a: 0, abd: 0 };

// The hock of a planted hind leg never through the ground (a hip let down low: a deep crouch), and resting on it when
// the animal sits (sit 0..1): the metatarsus then lies along the ground, the hock a skin's thickness over it behind
// the fetlock, and the thigh and the shank are solved from the hip to that hock (the stifle in front). In the leg's
// plane (girdle frame), against the model's up.
const HOCK_SKIN = 0.012;
function hockAboveGround(leg, lim, jz, jy, R, gr, dh, sit) {
  const upz = R[gr + 5], upy = R[gr + 4];
  const ul = Math.hypot(upz, upy) || 1;
  const uz = upz / ul, uy = upy / ul;
  const j = lim.j;
  // the ground at the heel (dh over the toe's contact, along the model's up)
  const Cz = _cl.z + uz * dh, Cy = _cl.y + uy * dh;
  const hgt = (j[4] - Cz) * uz + (j[5] - Cy) * uy;
  if (hgt >= HOCK_SKIN && sit <= 0) return;
  const want = Math.max(HOCK_SKIN, hgt) + (HOCK_SKIN - Math.max(HOCK_SKIN, hgt)) * sit;
  const Fz = j[6], Fy = j[7];
  // the slope carried on from the toe through the heel to under the hock (twice: the hock's place depends on it)
  const back = Math.max(1e-3, Math.hypot(Fz - _cl.z, Fy - _cl.y));
  let aM = 0, Hz = 0, Hy = 0, ref = 0;
  for (let it = 0; it < 2; it++) {
    const c = ((Fz - Cz) * uz + (Fy - Cy) * uy - want - ref) / leg.Ld;
    if (!(c > -1 && c < 1)) return;
    aM = Math.atan2(uy, uz) - Math.acos(c);
    Hz = Fz - Math.cos(aM) * leg.Ld;
    Hy = Fy - Math.sin(aM) * leg.Ld;
    const along = Math.max(0, _cl.z - Hz) - back;
    ref = (dh / back) * Math.max(0, along);
  }
  const r = twoBone(jz, jy, Hz, Hy, leg.Lp, leg.Lm, 1, Infinity);
  const Kz = jz + Math.cos(r.a1) * leg.Lp, Ky = jy + Math.sin(r.a1) * leg.Lp;
  j[2] = Kz;
  j[3] = Ky;
  j[4] = Hz;
  j[5] = Hy;
  lim.a[0] = r.a1;
  lim.a[1] = Math.atan2(Hy - Ky, Hz - Kz);
  lim.a[2] = aM;
}

// joint k of a leg at in-plane (z, y), the leg abducted by abd about the z axis through its root (height ry) → out
function planar(out, leg, k, ry, z, y, abd) {
  const d = ry - y, o = (leg.l * 6 + k) * 3;
  out.joints[o] = leg.x + d * Math.sin(abd);
  out.joints[o + 1] = ry - d * Math.cos(abd);
  out.joints[o + 2] = z;
}

// Leg joints in the world from a poseBones() result: [root, …, fetlock, toe end] of leg l (tests)
export function legJointsWorld(loco, out, l) {
  const b = loco.body, leg = b.legs[l], g = leg.girdle;
  const R = out.R, H = out.H, rest = b.rest;
  const n = (leg.fore ? 5 : 4) + 1;
  const res = [];
  const c = Math.cos(loco.yaw), sn = Math.sin(loco.yaw), s = loco.scale;
  for (let k = 0; k < n; k++) {
    const o = (l * 6 + k) * 3;
    const dx = out.joints[o] - rest[g * 3], dy = out.joints[o + 1] - rest[g * 3 + 1], dz = out.joints[o + 2] - rest[g * 3 + 2];
    const mx = H[g * 3] + R[g * 9] * dx + R[g * 9 + 1] * dy + R[g * 9 + 2] * dz;
    const my = H[g * 3 + 1] + R[g * 9 + 3] * dx + R[g * 9 + 4] * dy + R[g * 9 + 5] * dz;
    const mz = H[g * 3 + 2] + R[g * 9 + 6] * dx + R[g * 9 + 7] * dy + R[g * 9 + 8] * dz;
    res.push({ x: loco.x + (mx * c + mz * sn) * s, y: loco.gy + my * s, z: loco.z + (-mx * sn + mz * c) * s });
  }
  return res;
}

// a rest-pose point through a bone's skinning matrix, then the model's placement → world (tests)
export function skinWorld(loco, out, bone, x, y, z) {
  const M = out.bones, o = bone * 12;
  const mx = M[o] * x + M[o + 1] * y + M[o + 2] * z + M[o + 3];
  const my = M[o + 4] * x + M[o + 5] * y + M[o + 6] * z + M[o + 7];
  const mz = M[o + 8] * x + M[o + 9] * y + M[o + 10] * z + M[o + 11];
  const c = Math.cos(loco.yaw), sn = Math.sin(loco.yaw), s = loco.scale;
  return { x: loco.x + (mx * c + mz * sn) * s, y: loco.gy + my * s, z: loco.z + (-mx * sn + mz * c) * s };
}
