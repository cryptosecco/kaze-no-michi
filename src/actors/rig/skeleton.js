import * as THREE from 'three';

// Humanoid rig with Mixamo-compatible bone names (a rigged GLB with the same names can replace the mesh).
// Rest pose: T-pose, character faces +Z, its left side is +X, feet on y = 0.
// Every bone has an identity rest orientation, so authored Euler angles (degrees, parent space) read as:
//   X  pitch: spine/head bend forward (+) · thigh forward (−) · knee bend (+) · toes up (−) · arm forward (−)
//   Y  yaw:   twist toward the character's left (+)
//   Z  roll:  left arm down (−) / right arm down (+) · body lean toward its right (+) / left (−)
// Helper bones (Sode = shoulder guards, Kusazuri = armored tassets) are driven procedurally, not by clips.

// name, parent, head position for a 1.75 m reference body, main child (segment end used for skinning)
export const BONE_DEFS = [
  ['Hips', null, [0, 0.97, 0], 'Spine'],
  ['Spine', 'Hips', [0, 1.07, -0.004], 'Spine1'],
  ['Spine1', 'Spine', [0, 1.19, -0.01], 'Spine2'],
  ['Spine2', 'Spine1', [0, 1.31, -0.014], 'Neck'],
  ['Neck', 'Spine2', [0, 1.47, -0.012], 'Head'],
  ['Head', 'Neck', [0, 1.56, 0.0], 'HeadTop_End'],
  ['HeadTop_End', 'Head', [0, 1.75, 0.0], null],
  ['LeftShoulder', 'Spine2', [0.045, 1.43, -0.015], 'LeftArm'],
  ['LeftArm', 'LeftShoulder', [0.175, 1.43, -0.02], 'LeftForeArm'],
  ['LeftForeArm', 'LeftArm', [0.445, 1.43, -0.02], 'LeftHand'],
  ['LeftHand', 'LeftForeArm', [0.69, 1.43, -0.02], 'LeftHandEnd'],
  ['LeftHandEnd', 'LeftHand', [0.84, 1.43, -0.02], null],
  ['RightShoulder', 'Spine2', [-0.045, 1.43, -0.015], 'RightArm'],
  ['RightArm', 'RightShoulder', [-0.175, 1.43, -0.02], 'RightForeArm'],
  ['RightForeArm', 'RightArm', [-0.445, 1.43, -0.02], 'RightHand'],
  ['RightHand', 'RightForeArm', [-0.69, 1.43, -0.02], 'RightHandEnd'],
  ['RightHandEnd', 'RightHand', [-0.84, 1.43, -0.02], null],
  ['LeftUpLeg', 'Hips', [0.095, 0.925, 0.0], 'LeftLeg'],
  ['LeftLeg', 'LeftUpLeg', [0.1, 0.51, 0.008], 'LeftFoot'],
  ['LeftFoot', 'LeftLeg', [0.104, 0.085, -0.02], 'LeftToeBase'],
  ['LeftToeBase', 'LeftFoot', [0.106, 0.022, 0.1], 'LeftToe_End'],
  ['LeftToe_End', 'LeftToeBase', [0.106, 0.018, 0.17], null],
  ['RightUpLeg', 'Hips', [-0.095, 0.925, 0.0], 'RightLeg'],
  ['RightLeg', 'RightUpLeg', [-0.1, 0.51, 0.008], 'RightFoot'],
  ['RightFoot', 'RightLeg', [-0.104, 0.085, -0.02], 'RightToeBase'],
  ['RightToeBase', 'RightFoot', [-0.106, 0.022, 0.1], 'RightToe_End'],
  ['RightToe_End', 'RightToeBase', [-0.106, 0.018, 0.17], null],
  // procedural helpers (armor that hangs from the body)
  ['LeftSode', 'LeftShoulder', [0.2, 1.47, -0.02], null],
  ['RightSode', 'RightShoulder', [-0.2, 1.47, -0.02], null],
  ['LeftKusazuri', 'Hips', [0.12, 1.04, 0.0], null],
  ['RightKusazuri', 'Hips', [-0.12, 1.04, 0.0], null],
  ['FrontKusazuri', 'Hips', [0, 1.04, 0.14], null],
  ['BackKusazuri', 'Hips', [0, 1.04, -0.14], null],
];

export const HELPER_BONES = new Set(['LeftSode', 'RightSode', 'LeftKusazuri', 'RightKusazuri', 'FrontKusazuri', 'BackKusazuri']);

// Build a rig. `scale` scales the whole body; `shape` tweaks proportions (shoulder/hip width multipliers).
export function buildRig({ scale = 1, shoulders = 1, hips = 1 } = {}) {
  const bones = {};
  const list = [];
  const rest = {}; // model-space head positions
  const child = {};
  for (const [name, parent, p, main] of BONE_DEFS) {
    let x = p[0];
    if (/Shoulder|Arm|Hand|Sode/.test(name)) x *= shoulders;
    else if (/UpLeg|Leg|Foot|Toe|Kusazuri/.test(name) && !/Front|Back/.test(name)) x *= hips;
    rest[name] = new THREE.Vector3(x * scale, p[1] * scale, p[2] * scale);
    child[name] = main;
    const b = new THREE.Bone();
    b.name = name;
    bones[name] = b;
    list.push(b);
    if (parent) {
      bones[parent].add(b);
      b.position.copy(rest[name]).sub(rest[parent]);
    } else b.position.copy(rest[name]);
  }
  const root = new THREE.Group();
  root.name = 'rig';
  root.add(bones.Hips);
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(list);
  const index = {};
  list.forEach((b, i) => (index[b.name] = i));
  return { root, bones, list, rest, child, skeleton, index, scale };
}

// Segment of a bone for skinning distance: head → head of its main child (or a short stub for leaves).
export function boneSegment(rig, name, outA, outB) {
  outA.copy(rig.rest[name]);
  const c = rig.child[name];
  if (c) outB.copy(rig.rest[c]);
  else outB.copy(outA).add(new THREE.Vector3(0, 0.05, 0));
  return [outA, outB];
}
