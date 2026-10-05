import * as THREE from 'three';
import { pose, keyClip, sampleClip, sym, EASE } from './pose.js';
import { buildRidingClips } from './ride.js';

// Animation library for the shared humanoid rig. buildLibrary(boneNames) → { clips, meta }
// Locomotion cycles are generated from gait parameters (stance-warped phase, flat-foot compensation);
// combat clips are keyframed with a model-space sword track (arms follow through IK in the Animator).
// Model space: character faces +Z, its left is +X.

const TAU = Math.PI * 2;
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Static poses
export const STAND = pose({
  Spine: [3, 0, 0], Spine1: [2, 0, 0], Spine2: [-3, 0, 0], Neck: [6, 0, 0], Head: [-4, 0, 0],
  LeftShoulder: [0, 0, -3], RightShoulder: [0, 0, 3],
  LeftArm: [-18, -10, -66], RightArm: [2, 8, 74], LeftForeArm: [0, -62, 0], RightForeArm: [0, 14, 0],
  RightHand: [0, 0, 6],
  LeftUpLeg: [-2, 0, 3], RightUpLeg: [2, 0, -3], LeftLeg: [4, 0, 0], RightLeg: [3, 0, 0], LeftFoot: [-2, 0, -3], RightFoot: [-5, 0, 3],
  hips: [0, -0.012, 0],
  ik: { R: 0, L: 0.9 },
});

// Rest with weight (contrapposto): the weight on the right leg (hip shifted over it and raised, knee locked), the
// left foot half a step forward and relaxed, the right shoulder dropped, the left hand on the hilt.
export const REST = pose(
  {
    Hips: [0, -7, -4], Spine: [3, 4, 3], Spine1: [2, 3, 3], Spine2: [-3, 0, 1], Neck: [6, 0, -2], Head: [-3, 5, -2],
    LeftShoulder: [0, 0, 1], RightShoulder: [0, 0, 7],
    RightArm: [4, 6, 76], RightForeArm: [0, 18, 0], RightHand: [0, 0, 6],
    RightUpLeg: [4, -4, 6], RightLeg: [2, 0, 0], RightFoot: [-6, 4, -2],
    LeftUpLeg: [-19, 4, 11], LeftLeg: [16, 0, 0], LeftFoot: [10, 8, -6],
    hips: [-0.03, -0.02, 0.012],
  },
  STAND
);

// Mid-step on a flight of stairs (held for stills): leaning into the climb, the right foot up on the next step,
// the left leg pushing from its toes; foot IK lifts the leading foot onto the slope.
export const CLIMB = pose(
  {
    Hips: [8, 8, 2], Spine: [8, -5, -1], Spine1: [4, -3, 0], Spine2: [0, 0, 0], Neck: [-2, 0, 0], Head: [-10, 0, 0],
    RightArm: [-16, 8, 72], RightForeArm: [0, 32, 0], RightShoulder: [0, 0, 4],
    RightUpLeg: [-30, -4, -2], RightLeg: [40, 0, 0], RightFoot: [-10, 0, 0],
    LeftUpLeg: [6, 0, 3], LeftLeg: [16, 0, 0], LeftFoot: [16, 0, -2],
    hips: [0, -0.05, 0.04],
  },
  STAND
);

// Chudan-no-kamae: right foot forward, both hands on the hilt, point at the opponent's throat.
const CHUDAN_SWORD = { p: [-0.03, 1.08, 0.36], d: [0.02, 0.52, 1], e: [0, -1, 0.5] };
export const CHUDAN = pose({
  Hips: [4, 16, 0], Spine: [6, -8, 0], Spine1: [3, -5, 0], Spine2: [-2, -3, 0], Neck: [2, 0, 0], Head: [-4, -4, 0],
  LeftShoulder: [0, 0, -2], RightShoulder: [0, 0, 2],
  LeftArm: [-40, -20, -50], RightArm: [-45, 25, 50], LeftForeArm: [0, -60, 0], RightForeArm: [0, 45, 0],
  RightUpLeg: [-22, 0, -4], LeftUpLeg: [14, 0, 8], RightLeg: [26, 0, 0], LeftLeg: [22, 0, 0], RightFoot: [-6, 0, 2], LeftFoot: [-34, 0, -8],
  hips: [0, -0.075, 0],
  sword: CHUDAN_SWORD,
  ik: { R: 1, L: 1 },
});

// Iai stance for the standoff: low, sheathed blade, right hand on the hilt, left hand on the scabbard mouth.
export const STANDOFF = pose({
  Hips: [6, 24, 0], Spine: [10, -10, 0], Spine1: [6, -8, 0], Spine2: [0, -6, 0], Neck: [-2, 0, 0], Head: [-8, -8, 0],
  LeftShoulder: [0, 0, -2], RightShoulder: [0, 0, 4],
  LeftArm: [-30, -20, -60], RightArm: [-40, -30, 60], LeftForeArm: [0, -70, 0], RightForeArm: [0, 70, 0],
  RightUpLeg: [-30, 0, -8], LeftUpLeg: [18, 0, 10], RightLeg: [40, 0, 0], LeftLeg: [30, 0, 0], RightFoot: [-10, 0, 4], LeftFoot: [-44, 0, -8],
  hips: [0, -0.13, 0],
  sword: null,
  ik: { R: 1, L: 1 },
});

// Duel stances of the sunset standoff (S3): blades drawn, bodies low, both feet planted (legs solved with the
// game's leg IK onto flat ground, ankles at the rest height). Staged stills only: the standoff mechanic keeps
// STANDOFF (sheathed) and the iai draw.
// The samurai's low guard: hands at the right hip, the blade rising forward at ~43° toward the enemy, leaning in.
export const DUEL_LOW = pose({
  Hips: [6, 18, 0], Spine: [14, -8, 0], Spine1: [8, -6, 0], Spine2: [3, -4, 0], Neck: [-4, 0, 0], Head: [-14, -6, 0],
  LeftShoulder: [0, 0, -2], RightShoulder: [0, 0, 4],
  LeftUpLeg: [16, -17, 6], LeftLeg: [28, 0, -1], LeftFoot: [-49, 29, -1], RightUpLeg: [-64, -5, -19], RightLeg: [57, 0, 1], RightFoot: [0, 10, 3],
  hips: [0, -0.2, 0.02],
  sword: { p: [-0.06, 0.86, 0.36], d: [0.06, 0.95, 1], e: [0, -1, 0.95] },
  ik: { R: 1, L: 1 },
}, STAND);
// Bandit guards, all crouched and each different: low with the point forward, coiled deep with the blade upright by
// the right cheek (hasso), the point raised at the opponent's eyes (seigan), and the blade trailing low behind the
// right hip (waki). Only the low guard reaches forward at body height: in the S3 wedge (staging.js) the others stand
// behind a comrade's back, where a level blade would cross his figure in the telephoto frame.
export const BANDIT_GUARDS = {
  b_low: pose({
    Hips: [10, 14, 0], Spine: [16, -6, 0], Spine1: [10, -4, 0], Spine2: [4, -2, 0], Neck: [-10, 0, 0], Head: [-18, -6, 0],
    LeftUpLeg: [-3, -13, 4], LeftLeg: [55, 0, -1], LeftFoot: [-60, 25, -5], RightUpLeg: [-75, 2, -16], RightLeg: [73, 0, 1], RightFoot: [-7, 8, 6],
    hips: [0, -0.26, 0.04],
    sword: { p: [-0.02, 0.76, 0.46], d: [0.05, 0.28, 1], e: [0, -1, 0] },
    ik: { R: 1, L: 1 },
  }, STAND),
  b_hasso: pose({
    Hips: [12, 10, -4], Spine: [18, -4, 2], Spine1: [10, -2, 0], Spine2: [4, 0, 0], Neck: [-12, 0, 0], Head: [-16, -4, 0],
    LeftUpLeg: [-13, -11, 13], LeftLeg: [70, 0, -1], LeftFoot: [-63, 23, -12], RightUpLeg: [-81, 4, -13], RightLeg: [74, 0, 1], RightFoot: [-4, 6, 10],
    hips: [0, -0.3, 0.05],
    sword: { p: [-0.1, 1.08, 0.5], d: [-0.1, 1, -0.36], e: [0, 0.36, 1] },
    ik: { R: 1, L: 1 },
  }, STAND),
  b_seigan: pose({
    Hips: [6, 20, 0], Spine: [10, -10, 0], Spine1: [6, -6, 0], Spine2: [2, -4, 0], Neck: [-4, 0, 0], Head: [-10, -8, 0],
    LeftUpLeg: [0, -19, 3], LeftLeg: [41, 0, -1], LeftFoot: [-45, 27, -3], RightUpLeg: [-57, -8, -20], RightLeg: [56, 0, 1], RightFoot: [-7, 10, 4],
    hips: [0, -0.16, 0.02],
    sword: { p: [-0.04, 1.14, 0.52], d: [0.1, 1.8, 1], e: [0, -0.55, 1] },
    ik: { R: 1, L: 1 },
  }, STAND),
  b_waki: pose({
    Hips: [4, -14, 0], Spine: [6, 10, 0], Spine1: [4, 6, 0], Spine2: [2, 2, 0], Neck: [-2, 0, 0], Head: [-6, 8, 0],
    LeftUpLeg: [-44, 8, 12], LeftLeg: [40, 0, -1], LeftFoot: [-1, -6, -3], RightUpLeg: [-2, 13, -4], RightLeg: [34, 0, 1], RightFoot: [-33, -23, 5],
    hips: [0, -0.1, 0],
    sword: { p: [-0.14, 1.02, 0.2], d: [-0.4, -0.7, -0.6], e: [0, -1, 0] },
    ik: { R: 1, L: 1 },
  }, STAND),
};

// Gait generator
const GAITS = {
  walk: { stance: 0.61, At: 21, bias: -2, knee: 58, load: 12, heel: 13, push: 22, drop: 0.014, bob: 0.02, bobPh: 0, sway: 0.018, twist: 6, roll: 3, lean: 3, arm: 15, elbow: 16, dur: 1.08, ikL: 0.9 },
  run: { stance: 0.42, At: 33, bias: -6, knee: 92, load: 22, heel: 9, push: 30, drop: 0.045, bob: 0.03, bobPh: 0.12, sway: 0.012, twist: 9, roll: 4, lean: 11, arm: 30, elbow: 78, dur: 0.72, ikL: 0.92 },
  sprint: { stance: 0.36, At: 42, bias: -9, knee: 108, load: 26, heel: 7, push: 36, drop: 0.06, bob: 0.036, bobPh: 0.15, sway: 0.01, twist: 11, roll: 4, lean: 17, arm: 46, elbow: 86, dur: 0.6, ikL: 0.92 },
  // combat footwork (sword drawn): short gliding steps, low
  cwalk: { stance: 0.6, At: 14, bias: -3, knee: 34, load: 14, heel: 6, push: 12, drop: 0.08, bob: 0.01, bobPh: 0, sway: 0.01, twist: 3, roll: 2, lean: 6, arm: 0, elbow: 0, dur: 0.9, ikL: 1 },
};

const FOOT_KEYS = (G) => [
  [0, -G.heel], [0.12, 0], [0.34, 0], [0.5, G.push], [0.62, G.push * 0.4], [0.8, -6], [1, -G.heel],
];

function interpKeys(keys, x) {
  for (let i = 0; i < keys.length - 1; i++)
    if (x >= keys[i][0] && x <= keys[i + 1][0]) {
      const t = smooth(keys[i][0], keys[i + 1][0], x);
      return keys[i][1] + (keys[i + 1][1] - keys[i][1]) * t;
    }
  return keys[keys.length - 1][1];
}

function legPose(q, G) {
  q = ((q % 1) + 1) % 1;
  const st = G.stance;
  const qq = q < st ? (q / st) * 0.5 : 0.5 + ((q - st) / (1 - st)) * 0.5;
  const thigh = -G.At * Math.cos(TAU * qq) + G.bias;
  let knee = qq < 0.3 ? G.load * Math.sin((qq / 0.3) * Math.PI) : 0;
  if (qq > 0.5) knee += G.knee * Math.pow(Math.sin(Math.pow((qq - 0.5) / 0.5, 0.85) * Math.PI), 1.2);
  knee += 3;
  const abs = interpKeys(FOOT_KEYS(G), qq);
  return { thigh, knee, foot: abs - thigh - knee };
}

function gaitPose(p, G, upper) {
  const L = legPose(p, G), R = legPose(p + 0.5, G);
  const c = Math.cos(TAU * p), s = Math.sin(TAU * p);
  const spec = {
    Hips: [G.lean * 0.3, -G.twist * c, G.roll * s],
    Spine: [G.lean * 0.35 + 2, G.twist * 0.5 * c, -G.roll * 0.5 * s],
    Spine1: [G.lean * 0.2 + 1, G.twist * 0.3 * c, 0],
    Spine2: [G.lean * 0.1 - 3, G.twist * 0.3 * c, 0],
    Neck: [6 - G.lean * 0.3, 0, 0],
    Head: [-4 - G.lean * 0.25, -G.twist * 0.2 * c, -G.roll * 0.3 * s],
    LeftUpLeg: [L.thigh, 0, 3], LeftLeg: [L.knee, 0, 0], LeftFoot: [L.foot, 0, -2],
    RightUpLeg: [R.thigh, 0, -3], RightLeg: [R.knee, 0, 0], RightFoot: [R.foot, 0, 2],
    hips: [G.sway * s, -G.drop - G.bob * Math.cos(2 * TAU * (p - G.bobPh)), 0],
  };
  if (!upper) {
    Object.assign(spec, {
      LeftShoulder: [0, 0, -3], RightShoulder: [0, 0, 3],
      LeftArm: [-18 + G.arm * 0.25 * c, -10, -64], LeftForeArm: [0, -62, 0],
      RightArm: [-G.arm * c - G.lean * 0.4, 8, 72 - G.arm * 0.12], RightForeArm: [0, G.elbow + G.elbow * 0.15 * Math.max(0, -c), 0],
      RightHand: [0, 0, 8],
    });
  }
  return spec;
}

export function buildLibrary(boneNames) {
  const clips = {};
  const add = (c) => (clips[c.name] = c);

  // idle: the weighted rest pose, breathing + a slow settling of the weight on the standing leg
  add(
    sampleClip(
      'idle',
      4.2,
      (t, p) => {
        const b = Math.sin(TAU * p), w = Math.sin(TAU * p * 1 + 0.6);
        return pose(
          {
            Spine1: [2 + 0.9 * b, 3, 3], Spine2: [-3 - 0.8 * b, 0, 1], Neck: [6 - 0.4 * b, 0, -2],
            LeftShoulder: [0, 0, 1 - 0.8 * b], RightShoulder: [0, 0, 7 + 0.8 * b],
            Hips: [0, -7, -4 + 0.8 * w], hips: [-0.03 + 0.006 * w, -0.02 + 0.002 * b, 0.012],
            Head: [-3, 5 + 3 * Math.sin(TAU * p * 0.5), -2],
          },
          REST
        );
      },
      boneNames,
      { loop: true, fps: 20 }
    )
  );
  // stair climb, held (staging of stills)
  add(sampleClip('climb', 1, () => CLIMB, boneNames, { loop: true, fps: 2 }));

  for (const name of ['walk', 'run', 'sprint']) {
    const G = GAITS[name];
    add(sampleClip(name, G.dur, (t, p) => pose({ ...gaitPose(p, G, false), ik: { R: 0, L: G.ikL } }), boneNames, { loop: true, fps: 30 }));
  }

  // combat idle (chudan, subtle bounce) and combat footwork (legs only; upper body = chudan + sword)
  add(
    sampleClip(
      'combat_idle',
      2.4,
      (t, p) => {
        const b = Math.sin(TAU * p);
        const sw = { p: [CHUDAN_SWORD.p[0], CHUDAN_SWORD.p[1] + 0.006 * b, CHUDAN_SWORD.p[2]], d: CHUDAN_SWORD.d, e: CHUDAN_SWORD.e };
        return pose({ Spine1: [3 + 0.8 * b, -5, 0], hips: [0, -0.075 + 0.004 * b, 0], sword: sw }, CHUDAN);
      },
      boneNames,
      { loop: true, fps: 20 }
    )
  );
  add(
    sampleClip(
      'combat_move',
      GAITS.cwalk.dur,
      (t, p) => {
        const g = gaitPose(p, GAITS.cwalk, true);
        return pose({ ...g, Hips: [4 + g.Hips[0], 16 + g.Hips[1], g.Hips[2]], Spine: [6, -8 + g.Spine[1], 0], sword: CHUDAN_SWORD, ik: { R: 1, L: 1 } }, CHUDAN);
      },
      boneNames,
      { loop: true, fps: 30 }
    )
  );
  // drawn-sword run (the drawn jog and the combat sprint; the Animator blends it in above the footwork's pace): the run
  // stride, the blade carried low in the right hand with its point trailing, the left arm swinging free
  add(
    sampleClip(
      'combat_run',
      GAITS.run.dur,
      (t, p) => {
        const G = GAITS.run, c = Math.cos(TAU * p), b = Math.cos(2 * TAU * p);
        return pose(
          {
            ...gaitPose(p, G, true),
            LeftShoulder: [0, 0, -3], LeftArm: [G.arm * c - G.lean * 0.4, -8, -72 + G.arm * 0.12], LeftForeArm: [0, -G.elbow - G.elbow * 0.15 * Math.max(0, c), 0],
            sword: { p: [-0.22, 0.95 + 0.012 * b, 0.12 + 0.07 * c], d: [-0.35, -0.55, -0.75], e: [0, -1, 0] },
            ik: { R: 1, L: 0 },
          },
          STAND
        );
      },
      boneNames,
      { loop: true, fps: 30 }
    )
  );

  // ---- attacks -------------------------------------------------------------------------------------
  const C = CHUDAN;
  const P = (spec) => pose(spec, C);
  add(
    keyClip(
      'light1',
      [
        { t: 0, pose: C },
        { t: 0.11, ease: 'out', pose: P({ Hips: [2, -4, 0], Spine: [2, -22, 0], Spine1: [0, -12, 0], sword: { p: [-0.26, 1.52, 0.16], d: [0.25, 0.8, -0.55], e: [0.45, 0.35, 0.8] } }) },
        { t: 0.2, ease: 'in', pose: P({ Hips: [8, 30, 0], Spine: [12, 14, 0], Spine1: [4, 8, 0], hips: [0, -0.1, 0.05], RightUpLeg: [-30, 0, -4], RightLeg: [30, 0, 0], sword: { p: [0.2, 1.0, 0.46], d: [0.6, -0.32, 0.72], e: [0.55, -0.62, -0.5] } }) },
        { t: 0.3, ease: 'out', pose: P({ Hips: [8, 36, 0], Spine: [12, 20, 0], hips: [0, -0.1, 0.05], RightUpLeg: [-30, 0, -4], RightLeg: [30, 0, 0], sword: { p: [0.3, 0.93, 0.3], d: [0.78, -0.5, 0.3], e: [0.3, -0.1, -0.95] } }) },
        { t: 0.62, ease: 'inout', pose: C },
      ],
      boneNames,
      { meta: { hit: [0.13, 0.23], reach: 2.3, arc: [-70, 60], damage: 24, posture: 18, lunge: [0.08, 0.22, 0.7], combo: 0.28, recover: 0.4 } }
    )
  );
  add(
    keyClip(
      'light2',
      [
        { t: 0, pose: C },
        { t: 0.09, ease: 'out', pose: P({ Hips: [6, 30, 0], Spine: [10, 18, 0], hips: [0, -0.1, 0], sword: { p: [0.24, 0.96, 0.34], d: [0.7, -0.4, 0.55], e: [-0.2, 0.8, 0.5] } }) },
        { t: 0.19, ease: 'in', pose: P({ Hips: [2, -12, 0], Spine: [0, -22, 0], Spine1: [-4, -10, 0], hips: [0, -0.06, 0.05], sword: { p: [-0.26, 1.46, 0.42], d: [-0.5, 0.66, 0.55], e: [-0.6, 0.2, -0.7] } }) },
        { t: 0.28, ease: 'out', pose: P({ Hips: [0, -16, 0], Spine: [-2, -26, 0], hips: [0, -0.06, 0.05], sword: { p: [-0.3, 1.56, 0.24], d: [-0.62, 0.72, 0.06], e: [-0.4, -0.3, -0.85] } }) },
        { t: 0.6, ease: 'inout', pose: C },
      ],
      boneNames,
      { meta: { hit: [0.11, 0.21], reach: 2.2, arc: [-60, 70], damage: 22, posture: 16, lunge: [0.05, 0.2, 0.6], combo: 0.26, recover: 0.38 } }
    )
  );
  add(
    keyClip(
      'light3',
      [
        { t: 0, pose: C },
        { t: 0.16, ease: 'out', pose: P({ Hips: [-2, 8, 0], Spine: [-8, -4, 0], Spine1: [-4, 0, 0], Head: [-8, -2, 0], hips: [0, -0.04, -0.02], sword: { p: [-0.02, 1.76, 0.08], d: [0.02, 0.55, -0.85], e: [0, 0.85, 0.55] } }) },
        { t: 0.28, ease: 'in', pose: P({ Hips: [14, 8, 0], Spine: [18, -4, 0], Spine1: [6, 0, 0], hips: [0, -0.16, 0.12], RightUpLeg: [-40, 0, -4], RightLeg: [48, 0, 0], LeftUpLeg: [24, 0, 8], sword: { p: [0.0, 1.02, 0.56], d: [0, -0.22, 1], e: [0, -1, -0.22] } }) },
        { t: 0.38, ease: 'out', pose: P({ Hips: [16, 8, 0], Spine: [22, -4, 0], hips: [0, -0.18, 0.12], RightUpLeg: [-40, 0, -4], RightLeg: [48, 0, 0], LeftUpLeg: [24, 0, 8], sword: { p: [0.02, 0.86, 0.5], d: [0.05, -0.6, 0.78], e: [0, -0.78, -0.6] } }) },
        { t: 0.82, ease: 'inout', pose: C },
      ],
      boneNames,
      { meta: { hit: [0.2, 0.32], reach: 2.5, arc: [-30, 30], damage: 34, posture: 30, lunge: [0.12, 0.3, 1.0], combo: 0, recover: 0.55 } }
    )
  );
  add(
    keyClip(
      'heavy',
      [
        { t: 0, pose: C },
        { t: 0.4, ease: 'inout', pose: P({ Hips: [0, -20, 0], Spine: [-2, -18, 0], Spine1: [0, -8, 0], hips: [0, -0.09, -0.05], LeftUpLeg: [20, 0, 10], RightUpLeg: [-16, 0, -6], sword: { p: [-0.24, 1.6, 0.1], d: [0.08, 1, 0.1], e: [0.1, 0, 1] } }) },
        { t: 0.53, ease: 'in', pose: P({ Hips: [16, 34, 0], Spine: [16, 18, 0], Spine1: [6, 8, 0], hips: [0, -0.2, 0.15], RightUpLeg: [-44, 0, -6], RightLeg: [52, 0, 0], LeftUpLeg: [26, 0, 10], sword: { p: [0.2, 0.95, 0.52], d: [0.52, -0.45, 0.72], e: [0.6, -0.55, -0.55] } }) },
        { t: 0.64, ease: 'out', pose: P({ Hips: [18, 40, 0], Spine: [18, 22, 0], hips: [0, -0.2, 0.15], RightUpLeg: [-44, 0, -6], RightLeg: [52, 0, 0], LeftUpLeg: [26, 0, 10], sword: { p: [0.32, 0.86, 0.3], d: [0.8, -0.52, 0.2], e: [0.2, -0.1, -0.97] } }) },
        { t: 1.1, ease: 'inout', pose: C },
      ],
      boneNames,
      { meta: { hit: [0.44, 0.58], reach: 2.7, arc: [-80, 70], damage: 48, posture: 45, lunge: [0.38, 0.56, 1.3], heavy: true, combo: 0, recover: 0.8 } }
    )
  );

  // block (hold) and parry (snap deflection)
  const BLOCK = P({ Hips: [2, 10, 0], Spine: [4, -6, 0], hips: [0, -0.1, -0.02], sword: { p: [-0.06, 1.3, 0.34], d: [0.72, 0.6, 0.2], e: [0.05, -0.2, 1] } });
  add(keyClip('block', [{ t: 0, pose: C }, { t: 0.1, ease: 'snap', pose: BLOCK }, { t: 0.6, ease: 'linear', pose: BLOCK }], boneNames, { loop: false }));
  add(
    keyClip(
      'parry',
      [
        { t: 0, pose: BLOCK },
        { t: 0.07, ease: 'snap', pose: P({ Hips: [2, -10, 0], Spine: [2, -20, 0], hips: [0, -0.1, -0.03], sword: { p: [-0.26, 1.34, 0.36], d: [-0.4, 0.85, 0.3], e: [-0.8, -0.3, 0.5] } }) },
        { t: 0.36, ease: 'inout', pose: C },
      ],
      boneNames
    )
  );

  // dodge: quick low evasive step (direction handled by the controller)
  const DODGE_LOW = P({
    Hips: [18, 10, 0], Spine: [16, -4, 0], Spine1: [8, 0, 0], Head: [-14, 0, 0], hips: [0, -0.3, 0],
    LeftUpLeg: [-40, 0, 16], LeftLeg: [70, 0, 0], RightUpLeg: [10, 0, -24], RightLeg: [30, 0, 0], LeftFoot: [-24, 0, -10], RightFoot: [-30, 0, 10],
    sword: { p: [0.05, 0.9, 0.28], d: [-0.2, 0.2, 1], e: [0, -1, 0.2] },
  });
  // cancel windows (Player.js): an attack or a block may cut in from `cancel` (the travel is over), movement takes the
  // tail from `recover`, another dodge chains from `chain`
  const DODGE_META = { iframes: [0.03, 0.34], move: [0.0, 0.3, 3.2], cancel: 0.3, recover: 0.3, chain: 0.42 };
  add(keyClip('dodge', [{ t: 0, pose: C }, { t: 0.12, ease: 'snap', pose: DODGE_LOW }, { t: 0.32, ease: 'linear', pose: DODGE_LOW }, { t: 0.55, ease: 'inout', pose: C }], boneNames, { meta: DODGE_META }));
  // the same step with the blade sheathed (out of combat): the left hand keeps the hilt, the right arm swings back
  const DODGE_FREE = pose(
    {
      Hips: [18, 10, 0], Spine: [16, -4, 0], Spine1: [8, 0, 0], Head: [-14, 0, 0], hips: [0, -0.3, 0],
      LeftUpLeg: [-40, 0, 16], LeftLeg: [70, 0, 0], RightUpLeg: [10, 0, -24], RightLeg: [30, 0, 0], LeftFoot: [-24, 0, -10], RightFoot: [-30, 0, 10],
      RightArm: [26, 8, 62], RightForeArm: [0, 34, 0],
    },
    STAND
  );
  add(keyClip('dodge_free', [{ t: 0, pose: STAND }, { t: 0.12, ease: 'snap', pose: DODGE_FREE }, { t: 0.32, ease: 'linear', pose: DODGE_FREE }, { t: 0.55, ease: 'inout', pose: STAND }], boneNames, { meta: DODGE_META }));

  // hit reaction and death
  add(
    keyClip(
      'hit',
      [
        { t: 0, pose: C },
        { t: 0.08, ease: 'snap', pose: P({ Hips: [-8, 4, 0], Spine: [-14, 6, 0], Spine1: [-6, 0, 0], Head: [-18, 8, 6], hips: [0, -0.06, -0.12], sword: { p: [0.02, 1.02, 0.22], d: [0.4, 0.7, 0.6], e: [0, -0.6, 0.8] } }) },
        { t: 0.45, ease: 'inout', pose: C },
      ],
      boneNames,
      { meta: { move: [0, 0.2, -0.6] } }
    )
  );
  const DEAD = pose({
    Hips: [84, 20, 8], Spine: [8, 4, 0], Spine1: [4, 0, 0], Neck: [10, 30, 0], Head: [0, 20, 0],
    LeftArm: [-60, 0, -30], RightArm: [-80, 20, 40], LeftForeArm: [0, -20, 0], RightForeArm: [0, 30, 0],
    LeftUpLeg: [-10, 0, 10], RightUpLeg: [-4, 0, -6], LeftLeg: [30, 0, 0], RightLeg: [10, 0, 0], LeftFoot: [30, 0, 0], RightFoot: [34, 0, 0],
    hips: [0, -0.83, 0.55],
    ik: { R: 0, L: 0 },
  });
  const KNEEL = pose(
    {
      Hips: [20, 10, 0], Spine: [20, 0, 0], Spine1: [10, 0, 0], Head: [20, 0, 0], hips: [0, -0.45, 0.1],
      LeftUpLeg: [-70, 0, 10], LeftLeg: [110, 0, 0], RightUpLeg: [10, 0, -6], RightLeg: [100, 0, 0], LeftFoot: [-30, 0, 0], RightFoot: [40, 0, 0],
      LeftArm: [-30, 0, -60], RightArm: [-40, 0, 60], ik: { R: 0, L: 0 },
    },
    STAND
  );
  add(keyClip('death', [{ t: 0, pose: C }, { t: 0.35, ease: 'out', pose: KNEEL }, { t: 1.1, ease: 'in', pose: DEAD }, { t: 1.6, ease: 'linear', pose: DEAD }], boneNames));

  // standoff stance (loop with tension breathing) and iai draw-strike
  add(
    sampleClip(
      'standoff',
      3.0,
      (t, p) => {
        const b = Math.sin(TAU * p);
        return pose({ Spine1: [6 + 0.6 * b, -8, 0], hips: [0, -0.13 + 0.003 * b, 0] }, STANDOFF);
      },
      boneNames,
      { loop: true, fps: 20 }
    )
  );
  // duel stances (S3 staging): held, with a slow tense breath through the chest
  for (const [name, P0, dur] of [['duel_low', DUEL_LOW, 3.2], ...Object.entries(BANDIT_GUARDS).map(([n, p], k) => [n, p, 2.6 + 0.3 * k])]) {
    const s1 = new THREE.Euler().setFromQuaternion(P0.bones.Spine1, 'XYZ').toArray().slice(0, 3).map((a) => a * THREE.MathUtils.RAD2DEG);
    add(
      sampleClip(name, dur, (t, p) => {
        const b = Math.sin(TAU * p);
        return pose({ Spine1: [s1[0] + 0.7 * b, s1[1], s1[2]], hips: [P0.hips.x, P0.hips.y + 0.003 * b, P0.hips.z] }, P0);
      }, boneNames, { loop: true, fps: 20 })
    );
  }
  const IAI_END = P({
    Hips: [14, -30, 0], Spine: [14, -26, 0], Spine1: [6, -10, 0], Head: [-10, 20, 0], hips: [0, -0.2, 0.25],
    RightUpLeg: [-46, 0, -8], RightLeg: [54, 0, 0], LeftUpLeg: [30, 0, 12], LeftLeg: [36, 0, 0], LeftFoot: [-40, 0, 0],
    sword: { p: [-0.42, 1.2, 0.4], d: [-0.85, 0.08, 0.5], e: [-0.5, 0, -0.85] },
    ik: { R: 1, L: 0 },
  });
  add(
    keyClip(
      'iai',
      [
        { t: 0, pose: pose({ sword: null, ik: { R: 1, L: 1 } }, STANDOFF) },
        { t: 0.07, ease: 'in', pose: pose({ Hips: [8, 10, 0], Spine: [10, -4, 0], hips: [0, -0.16, 0.1], sword: { p: [0.18, 1.08, 0.46], d: [0.62, 0.02, 0.78], e: [-0.78, 0, 0.62] }, ik: { R: 1, L: 0.2 } }, STANDOFF) },
        { t: 0.16, ease: 'snap', pose: IAI_END },
        { t: 0.9, ease: 'linear', pose: IAI_END },
        { t: 1.3, ease: 'inout', pose: C },
      ],
      boneNames,
      { meta: { drawFromSaya: [0, 0.07], hit: [0.08, 0.17], reach: 3.2, arc: [-80, 80], damage: 999, lunge: [0.03, 0.16, 2.4] } }
    )
  );
  // sheathe: flick (chiburi) then return the blade into the scabbard
  add(
    keyClip(
      'sheathe',
      [
        { t: 0, pose: C },
        { t: 0.22, ease: 'out', pose: P({ Hips: [2, -8, 0], Spine: [2, -10, 0], sword: { p: [-0.34, 1.14, 0.46], d: [-0.4, -0.35, 0.85], e: [-0.2, -0.9, -0.3] }, ik: { R: 1, L: 0.3 } }) },
        { t: 0.55, ease: 'inout', pose: pose({ sword: { p: [0.22, 1.1, 0.4], d: [-0.2, 0.25, 0.95], e: [0, -1, 0.25] }, ik: { R: 1, L: 1 } }, STAND) },
        { t: 0.95, ease: 'inout', pose: pose({ sword: null, ik: { R: 1, L: 0.9 } }, STAND) },
        { t: 1.15, ease: 'inout', pose: pose({ ik: { R: 0, L: 0.9 } }, STAND) },
      ],
      boneNames,
      { meta: { toSaya: [0.55, 0.95] } }
    )
  );
  add(keyClip('draw', [{ t: 0, pose: pose({ sword: null, ik: { R: 1, L: 0.9 } }, STAND) }, { t: 0.18, ease: 'inout', pose: pose({ sword: { p: [0.2, 1.12, 0.42], d: [0.3, 0.3, 0.9], e: [0, -1, 0.3] }, ik: { R: 1, L: 0.5 } }, STAND) }, { t: 0.42, ease: 'inout', pose: C }], boneNames, { meta: { drawFromSaya: [0, 0.18] } }));

  // prayer at the shrine: kneel and bow
  const SEIZA = pose(
    {
      Hips: [10, 0, 0], Spine: [8, 0, 0], Spine1: [4, 0, 0], Head: [18, 0, 0], hips: [0, -0.52, -0.16],
      LeftUpLeg: [-86, 0, 6], RightUpLeg: [-86, 0, -6], LeftLeg: [150, 0, 0], RightLeg: [150, 0, 0], LeftFoot: [60, 0, 0], RightFoot: [60, 0, 0],
      LeftArm: [-50, 0, -64], RightArm: [-50, 0, 64], LeftForeArm: [0, -40, 0], RightForeArm: [0, 40, 0], ik: { R: 0, L: 0 },
    },
    STAND
  );
  const BOW = pose({ Hips: [38, 0, 0], Spine: [18, 0, 0], Head: [24, 0, 0] }, SEIZA);
  add(keyClip('pray', [{ t: 0, pose: STAND }, { t: 0.9, ease: 'inout', pose: SEIZA }, { t: 1.8, ease: 'inout', pose: BOW }, { t: 3.2, ease: 'linear', pose: BOW }, { t: 4.0, ease: 'inout', pose: SEIZA }, { t: 4.8, ease: 'inout', pose: STAND }], boneNames));

  // ---- spear set (bandits): weapon track = lead-hand grip, blade forward --------------------------------
  const SPEAR_STANCE = pose({
    Hips: [6, 30, 0], Spine: [6, -14, 0], Spine1: [2, -8, 0], Head: [-4, -10, 0],
    RightUpLeg: [10, 0, -10], LeftUpLeg: [-20, 0, 8], RightLeg: [24, 0, 0], LeftLeg: [26, 0, 0], LeftFoot: [-8, 0, 0], RightFoot: [-30, 0, 0],
    hips: [0, -0.1, 0],
    sword: { p: [0.1, 1.12, 0.42], d: [-0.05, 0.12, 1], e: [0, 1, 0] },
    ik: { R: 1, L: 1 },
  });
  add(
    sampleClip(
      'spear_idle',
      2.2,
      (t, p) => {
        const b = Math.sin(TAU * p);
        return pose({ hips: [0, -0.1 + 0.005 * b, 0], sword: { p: [0.1, 1.12 + 0.01 * b, 0.42], d: [-0.05, 0.12 + 0.02 * b, 1], e: [0, 1, 0] } }, SPEAR_STANCE);
      },
      boneNames,
      { loop: true, fps: 20 }
    )
  );
  add(
    keyClip(
      'spear_thrust',
      [
        { t: 0, pose: SPEAR_STANCE },
        { t: 0.34, ease: 'inout', pose: pose({ Hips: [2, 40, 0], Spine: [0, -20, 0], hips: [0, -0.1, -0.12], sword: { p: [0.12, 1.14, 0.12], d: [-0.05, 0.1, 1], e: [0, 1, 0] } }, SPEAR_STANCE) },
        { t: 0.46, ease: 'in', pose: pose({ Hips: [14, 14, 0], Spine: [16, -6, 0], hips: [0, -0.2, 0.3], LeftUpLeg: [-44, 0, 8], LeftLeg: [50, 0, 0], sword: { p: [0.04, 1.2, 1.02], d: [-0.02, 0.06, 1], e: [0, 1, 0] } }, SPEAR_STANCE) },
        { t: 0.62, ease: 'out', pose: pose({ Hips: [14, 14, 0], Spine: [16, -6, 0], hips: [0, -0.2, 0.3], LeftUpLeg: [-44, 0, 8], LeftLeg: [50, 0, 0], sword: { p: [0.04, 1.18, 0.95], d: [-0.02, 0.04, 1], e: [0, 1, 0] } }, SPEAR_STANCE) },
        { t: 1.0, ease: 'inout', pose: SPEAR_STANCE },
      ],
      boneNames,
      { meta: { hit: [0.4, 0.52], reach: 3.1, arc: [-22, 22], damage: 16, posture: 14, lunge: [0.34, 0.48, 0.8] } }
    )
  );
  add(
    keyClip(
      'spear_sweep',
      [
        { t: 0, pose: SPEAR_STANCE },
        { t: 0.5, ease: 'inout', pose: pose({ Hips: [0, 60, 0], Spine: [0, 20, 0], hips: [0, -0.14, 0], sword: { p: [0.35, 1.3, 0.1], d: [0.9, 0.2, -0.3], e: [0, 1, 0] } }, SPEAR_STANCE) },
        { t: 0.68, ease: 'in', pose: pose({ Hips: [8, -30, 0], Spine: [6, -30, 0], hips: [0, -0.2, 0.2], sword: { p: [-0.2, 1.05, 0.5], d: [-0.8, -0.1, 0.6], e: [0, 1, 0] } }, SPEAR_STANCE) },
        { t: 1.25, ease: 'inout', pose: SPEAR_STANCE },
      ],
      boneNames,
      { meta: { hit: [0.56, 0.7], reach: 3.3, arc: [-80, 80], damage: 26, posture: 30, lunge: [0.5, 0.68, 0.5], unblockable: true } }
    )
  );
  add(
    sampleClip(
      'spear_move',
      GAITS.cwalk.dur,
      (t, p) => {
        const g = gaitPose(p, GAITS.cwalk, true);
        return pose({ ...g, Hips: [6 + g.Hips[0], 30 + g.Hips[1], g.Hips[2]], Spine: [6, -14, 0], sword: SPEAR_STANCE.sword ? { p: [0.1, 1.12, 0.42], d: [-0.05, 0.12, 1], e: [0, 1, 0] } : null, ik: { R: 1, L: 1 } }, SPEAR_STANCE);
      },
      boneNames,
      { loop: true, fps: 30 }
    )
  );

  // bandit katana: slower telegraphed overhead (can be unblockable) — reuse light3/heavy timings
  clips.b_slash = clips.light1;
  clips.b_heavy = clips.heavy;
  // on horseback (anim/ride.js): seated gait clips, mount and dismount
  Object.assign(clips, buildRidingClips(boneNames, { STAND }));
  return { clips, gaits: GAITS };
}

export { EASE };
export const UPPER_BODY = new Set(['Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand']);
void THREE;
void sym;
