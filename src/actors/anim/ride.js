import * as THREE from 'three';
import { pose, sampleClip, keyClip } from './pose.js';
import { solveLeg, solveArm, setWorldQuat } from './ik.js';
import { buildRig } from '../rig/skeleton.js';
import { STIRRUP, HANDS, RIDER_ROOT, MOUNT_SPOT, LAND_SPOT } from '../horse/seat.js';

// Riding clips for the shared humanoid rig (registered by library.js). The rider sits the horse's saddle
// (horse/seat.js): his feet stay in the stirrups and his fists on the reins whatever the seat, because every frame is
// solved at build time with the rig's leg and arm IK onto those points (rider space = horse space − RIDER_ROOT).
// The gait clips loop over ONE stride of the horse: the riding module sets base.time = stride phase × duration, so
// the rider's motion keeps time with the hooves.
//   ride_idle    seated at rest, breathing, glancing about
//   ride_walk    the pelvis follows the walk's swing, the upper body quiet
//   ride_trot    a sitting trot: the spine takes the two bounces of each stride
//   ride_canter  the rocking seat, the hands following the horse's nod
//   ride_gallop  forward seat: up in the stirrups, leaning over the withers, the legs taking the bound
//   mount / dismount   the short transitions (the riding module moves the root along with them)

const TAU = Math.PI * 2;
const D2R = Math.PI / 180;
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();

// stirrup ankle and rein-hand targets in rider space
const ANKLE = { x: STIRRUP.x, y: STIRRUP.y - RIDER_ROOT.y + 0.085, z: STIRRUP.z - RIDER_ROOT.z - 0.05 };
const HAND = { x: HANDS.x, y: HANDS.y - RIDER_ROOT.y, z: HANDS.z - RIDER_ROOT.z };

let RIG = null;
function rig() {
  if (!RIG) RIG = buildRig({});
  return RIG;
}

// Seated pose: FK from `spec` (on top of `base`), then legs into the stirrups and fists to the reins.
// hand: { dx, dy, dz } offsets of both fists; feet: outward turn of the feet (rad)
function seated(spec, base, { hand = {}, feet = 0.22 } = {}) {
  const P = pose({ ik: { R: 0, L: 0 }, sword: null, ...spec }, base);
  const R = rig();
  for (const b of R.list) b.quaternion.identity();
  for (const [k, q] of Object.entries(P.bones)) if (R.bones[k]) R.bones[k].quaternion.copy(q);
  R.bones.Hips.position.copy(R.rest.Hips).add(P.hips);
  R.root.updateMatrixWorld(true);
  for (const side of [1, -1]) {
    const L = side > 0 ? 'Left' : 'Right';
    const ankle = _v.set(side * ANKLE.x, ANKLE.y, ANKLE.z);
    const hip = R.bones[L + 'UpLeg'].getWorldPosition(new THREE.Vector3());
    // the knee goes forward and out around the barrel
    solveLeg(R, side, ankle.clone(), hip.clone().add(new THREE.Vector3(side * 0.55, -0.15, 0.9)), 1);
    setWorldQuat(R.bones[L + 'Foot'], _q.setFromEuler(_e.set(-0.08, side * feet, 0)), 1);
    const sh = R.bones[L + 'Arm'].getWorldPosition(new THREE.Vector3());
    const wrist = new THREE.Vector3(side * HAND.x + (hand.dx || 0) * side, HAND.y + (hand.dy || 0), HAND.z + (hand.dz || 0));
    solveArm(R, side, wrist, sh.add(new THREE.Vector3(side * 0.45, -0.55, -0.35)), 1);
  }
  R.root.updateMatrixWorld(true);
  const out = { bones: {}, hips: P.hips.clone(), sword: null, ik: { R: 0, L: 0 } };
  for (const b of R.list) out.bones[b.name] = b.quaternion.clone();
  return out;
}

// the seated rest: the pelvis upright in the saddle, a slight lean, the head level
const SEAT_SPEC = {
  Hips: [2, 0, 0], Spine: [5, 0, 0], Spine1: [3, 0, 0], Spine2: [0, 0, 0], Neck: [-1, 0, 0], Head: [-5, 0, 0],
  LeftShoulder: [0, 0, -2], RightShoulder: [0, 0, 2], hips: [0, 0, 0],
};

export function buildRidingClips(boneNames, { STAND }) {
  const clips = {};
  const add = (c) => (clips[c.name] = c);
  const S = (spec, opts) => seated({ ...SEAT_SPEC, ...spec }, STAND, opts);

  add(
    sampleClip(
      'ride_idle',
      4.6,
      (t, p) => {
        const b = Math.sin(TAU * p);
        return S({ Spine1: [3 + 0.8 * b, 0, 0], Spine2: [-0.6 * b, 0, 0], Head: [-5, 8 * Math.sin(TAU * p * 2 + 0.5) * Math.sin(TAU * p), 0], hips: [0, 0.002 * b, 0] });
      },
      boneNames,
      { loop: true, fps: 15 }
    )
  );
  add(
    sampleClip(
      'ride_walk',
      1,
      (t, p) => {
        const s1 = Math.sin(TAU * p), s2 = Math.sin(2 * TAU * p);
        return S({ Hips: [2 + 2 * s2, 3 * s1, 2 * s1], Spine: [5 - 1.2 * s2, -2 * s1, -1.5 * s1], Spine1: [3, -1 * s1, -0.5 * s1], hips: [0.008 * s1, 0.006 * s2, 0.008 * s2] }, { hand: { dz: 0.02 * s2 } });
      },
      boneNames,
      { loop: true, fps: 30 }
    )
  );
  add(
    sampleClip(
      'ride_trot',
      1,
      (t, p) => {
        // the diagonal pairs land at 0.21 and 0.71 of the stride: the seat drops, the spine gives
        const k = Math.cos(2 * TAU * (p - 0.21));
        return S({ Hips: [4 - 2 * k, 0, 0], Spine: [8 + 2 * k, 0, 0], Spine1: [4 + 1.5 * k, 0, 0], Neck: [-2 - k, 0, 0], Head: [-7 - 1.5 * k, 0, 0], hips: [0, 0.012 * k, 0] }, { hand: { dz: 0.04, dy: -0.02 + 0.01 * k } });
      },
      boneNames,
      { loop: true, fps: 30 }
    )
  );
  add(
    sampleClip(
      'ride_canter',
      1,
      (t, p) => {
        // the rocking seat: the pelvis swings with the horse's pitch, the shoulders stay over it, the fists follow the nod
        const k = Math.sin(TAU * (p - 0.55));
        const n = Math.sin(TAU * (p - 0.45));
        return S({ Hips: [10 + 6 * k, 0, 0], Spine: [8 - 3 * k, 0, 0], Spine1: [5 - 2 * k, 0, 0], Neck: [-6, 0, 0], Head: [-10 + 2 * k, 0, 0], hips: [0, 0.03 + 0.02 * k, -0.015] }, { hand: { dz: 0.08 + 0.05 * n, dy: -0.05 } });
      },
      boneNames,
      { loop: true, fps: 30 }
    )
  );
  add(
    sampleClip(
      'ride_gallop',
      1,
      (t, p) => {
        // forward seat: up off the saddle, folded over the withers; the legs take the bound so the body glides
        const b = Math.cos(TAU * (p - 0.12));
        const n = Math.sin(TAU * (p - 0.5));
        return S(
          { Hips: [34, 0, 0], Spine: [14 + 2 * b, 0, 0], Spine1: [8, 0, 0], Spine2: [5, 0, 0], Neck: [-16, 0, 0], Head: [-24 - 2 * b, 0, 0], hips: [0, 0.075 + 0.035 * b, -0.05] },
          { hand: { dz: 0.17 + 0.05 * n, dy: -0.1, dx: 0.01 } }
        );
      },
      boneNames,
      { loop: true, fps: 30 }
    )
  );

  // ---- mount / dismount (≈0.8 s) — the riding module carries the root from the ground spot to the saddle ----------
  const RIDE = S({});
  const REACH = pose({ Spine: [8, 0, 6], Spine1: [4, 0, 4], LeftArm: [-70, 0, -40], RightArm: [-75, 0, 30], LeftForeArm: [0, -40, 0], RightForeArm: [0, 40, 0], ik: { R: 0, L: 0 }, sword: null }, STAND);
  const FOOT_UP = pose(
    { Hips: [-6, 0, 0], Spine: [16, 0, 10], Spine1: [6, 0, 6], LeftUpLeg: [-100, 0, 14], LeftLeg: [110, 0, 0], LeftFoot: [-10, 0, 0], RightUpLeg: [4, 0, -2], RightLeg: [8, 0, 0], LeftArm: [-80, 0, -20], RightArm: [-85, 0, 20], LeftForeArm: [0, -50, 0], RightForeArm: [0, 50, 0], hips: [0, -0.02, 0], ik: { R: 0, L: 0 }, sword: null },
    STAND
  );
  const SWING = pose(
    { Hips: [24, -10, 0], Spine: [24, 0, 12], Spine1: [8, 0, 6], LeftUpLeg: [-30, 0, 6], LeftLeg: [40, 0, 0], RightUpLeg: [36, 0, -58], RightLeg: [50, 0, 0], RightFoot: [30, 0, 0], LeftArm: [-70, 0, -30], RightArm: [-60, 0, 40], LeftForeArm: [0, -60, 0], RightForeArm: [0, 60, 0], hips: [0, 0.05, 0], ik: { R: 0, L: 0 }, sword: null },
    STAND
  );
  add(keyClip('mount', [{ t: 0, pose: REACH }, { t: 0.24, ease: 'out', pose: FOOT_UP }, { t: 0.5, ease: 'inout', pose: SWING }, { t: 0.8, ease: 'inout', pose: RIDE }], boneNames));
  const OVER = pose(
    { Hips: [28, 10, 0], Spine: [26, 0, -10], Spine1: [8, 0, -6], RightUpLeg: [40, 0, -60], RightLeg: [50, 0, 0], LeftUpLeg: [-40, 0, 10], LeftLeg: [70, 0, 0], LeftArm: [-70, 0, -30], RightArm: [-60, 0, 40], LeftForeArm: [0, -60, 0], RightForeArm: [0, 60, 0], hips: [0, 0.04, 0], ik: { R: 0, L: 0 }, sword: null },
    STAND
  );
  const LAND = pose({ Hips: [14, 0, 0], Spine: [10, 0, 0], LeftUpLeg: [-34, 0, 4], LeftLeg: [56, 0, 0], RightUpLeg: [-30, 0, -4], RightLeg: [52, 0, 0], LeftFoot: [-14, 0, 0], RightFoot: [-14, 0, 0], hips: [0, -0.16, 0], ik: { R: 0, L: 0.6 } }, STAND);
  add(keyClip('dismount', [{ t: 0, pose: RIDE }, { t: 0.3, ease: 'inout', pose: OVER }, { t: 0.52, ease: 'in', pose: LAND }, { t: 0.75, ease: 'out', pose: STAND }], boneNames));
  return clips;
}

// Root path of the mount (and, reversed, of the dismount), horse space: from the spot by the stirrup up to the seat.
// k in [0, 1] → out { x, y, z }
export function mountPath(k, out) {
  const a = MOUNT_SPOT, b = RIDER_ROOT;
  const t = Math.min(1, Math.max(0, k));
  // the foot goes up first (the root stays down), then the body rises over the saddle and settles
  const up = t < 0.3 ? 0 : Math.sin(Math.min(1, (t - 0.3) / 0.55) * Math.PI * 0.62) / Math.sin(Math.PI * 0.62);
  const across = t < 0.4 ? 0 : (t - 0.4) / 0.6;
  const s = across * across * (3 - 2 * across);
  out.x = a.x + (b.x - a.x) * s;
  out.z = a.z + (b.z - a.z) * s;
  out.y = a.y + (b.y + 0.22 * (1 - s) - a.y) * up;
  if (t >= 1) out.y = b.y;
  return out;
}

export function dismountPath(k, out) {
  const a = RIDER_ROOT, b = LAND_SPOT;
  const t = Math.min(1, Math.max(0, k));
  const across = t < 0.25 ? 0 : Math.min(1, (t - 0.25) / 0.5);
  const s = across * across * (3 - 2 * across);
  out.x = a.x + (b.x - a.x) * s;
  out.z = a.z + (b.z - a.z) * s;
  // up a little as the leg swings over, then the drop to the ground
  out.y = t < 0.3 ? a.y + 0.12 * Math.sin((t / 0.3) * Math.PI * 0.5) : a.y + 0.12 - (a.y + 0.12 - b.y) * Math.min(1, ((t - 0.3) / 0.4) ** 2);
  return out;
}

export { D2R };
