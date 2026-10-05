import * as THREE from 'three';

// Horse skeleton: a small, sturdy Japanese native horse, 1.35 m at the withers. Same conventions as the humanoid rig
// (rig/skeleton.js): model space, the horse faces +Z, its left side is +X, hooves on y = 0, every bone with an
// identity rest orientation (so a planar leg bends about local X). Body carries the barrel and moves as a whole
// (bob, pitch, roll); Chest carries the withers, the neck and the shoulder blades, Pelvis the croup, hips and tail.
//   buildHorseRig() → { root, bones, list, rest, child, skeleton, index }
//   LEG_CHAINS: per leg (0 LF, 1 RF, 2 LH, 3 RH) the bone names from the root joint down to the hoof

// name, parent, head position (m), main child (segment end for skinning)
export const HORSE_BONES = [
  ['Body', null, [0, 1.06, 0], 'Chest'],
  ['Chest', 'Body', [0, 1.1, 0.36], 'Neck1'],
  ['Pelvis', 'Body', [0, 1.12, -0.36], 'Tail1'],
  ['Neck1', 'Chest', [0, 1.18, 0.56], 'Neck2'],
  ['Neck2', 'Neck1', [0, 1.38, 0.74], 'Neck3'],
  ['Neck3', 'Neck2', [0, 1.56, 0.88], 'Head'],
  ['Head', 'Neck3', [0, 1.7, 1.0], 'HeadEnd'],
  ['HeadEnd', 'Head', [0, 1.27, 1.32], null],
  ['EarL', 'Head', [0.065, 1.76, 0.985], 'EarLEnd'],
  ['EarLEnd', 'EarL', [0.085, 1.88, 0.975], null],
  ['EarR', 'Head', [-0.065, 1.76, 0.985], 'EarREnd'],
  ['EarREnd', 'EarR', [-0.085, 1.88, 0.975], null],
  ['Tail1', 'Pelvis', [0, 1.22, -0.66], 'Tail2'],
  ['Tail2', 'Tail1', [0, 1.12, -0.76], 'Tail3'],
  ['Tail3', 'Tail2', [0, 0.98, -0.82], 'Tail4'],
  ['Tail4', 'Tail3', [0, 0.82, -0.85], 'Tail5'],
  ['Tail5', 'Tail4', [0, 0.64, -0.865], 'TailEnd'],
  ['TailEnd', 'Tail5', [0, 0.44, -0.87], null],
];
// fore legs: shoulder blade (from the withers), humerus (shoulder joint), forearm (elbow), cannon (carpus = knee),
// pastern (fetlock), hoof (coronet) → sole
const FORE = [
  ['Scap', 'Chest', [0.13, 1.28, 0.4], 'Hum'],
  ['Hum', 'Scap', [0.16, 1.0, 0.6], 'Fore'],
  ['Fore', 'Hum', [0.165, 0.8, 0.46], 'CanF'],
  ['CanF', 'Fore', [0.15, 0.42, 0.49], 'PasF'],
  ['PasF', 'CanF', [0.14, 0.155, 0.49], 'HoofF'],
  ['HoofF', 'PasF', [0.14, 0.072, 0.545], 'SoleF'],
  ['SoleF', 'HoofF', [0.14, 0.0, 0.58], null],
];
// hind legs: femur (hip joint), tibia (stifle), cannon (hock), pastern (fetlock), hoof (coronet) → sole
const HIND = [
  ['Fem', 'Pelvis', [0.19, 0.98, -0.46], 'Tib'],
  ['Tib', 'Fem', [0.205, 0.7, -0.28], 'CanH'],
  ['CanH', 'Tib', [0.15, 0.46, -0.58], 'PasH'],
  ['PasH', 'CanH', [0.14, 0.155, -0.545], 'HoofH'],
  ['HoofH', 'PasH', [0.14, 0.072, -0.49], 'SoleH'],
  ['SoleH', 'HoofH', [0.14, 0.0, -0.455], null],
];
for (const [side, sx] of [['L', 1], ['R', -1]])
  for (const [n, p, pos, c] of [...FORE, ...HIND])
    HORSE_BONES.push([n + side, p === 'Chest' || p === 'Pelvis' ? p : p + side, [pos[0] * sx, pos[1], pos[2]], c ? c + side : null]);

export const LEG_CHAINS = [
  ['ScapL', 'HumL', 'ForeL', 'CanFL', 'PasFL', 'HoofFL', 'SoleFL'],
  ['ScapR', 'HumR', 'ForeR', 'CanFR', 'PasFR', 'HoofFR', 'SoleFR'],
  ['FemL', 'TibL', 'CanHL', 'PasHL', 'HoofHL', 'SoleHL'],
  ['FemR', 'TibR', 'CanHR', 'PasHR', 'HoofHR', 'SoleHR'],
];

export function buildHorseRig() {
  const bones = {}, list = [], rest = {}, child = {};
  for (const [name, parent, p, main] of HORSE_BONES) {
    rest[name] = new THREE.Vector3(p[0], p[1], p[2]);
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
  root.name = 'horse-rig';
  root.add(bones.Body);
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(list);
  const index = {};
  list.forEach((b, i) => (index[b.name] = i));
  return { root, bones, list, rest, child, skeleton, index, scale: 1 };
}
