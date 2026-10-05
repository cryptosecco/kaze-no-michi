// Trot lab — geometric markers on the horse. Every point is read from a bone's WORLD matrix (bone.matrixWorld, after
// horse.root.updateMatrixWorld(true)), never from the horse's gait state, so the instrument keeps measuring the same
// anatomy if the locomotion code is rewritten. Pure math, no imports: it runs in Node (sim.mjs) and in the page
// (capture.mjs loads it through Vite).
//
//   makeProbe(horse, { contactM })  → probe; probe.sample(groundAt) → a fresh plain record (below)
//   LEGS                             the four legs: name, fore/hind, side, bone names
//   CONTACT_M                        contact threshold: the lowest hoof point within 4 mm of the ground
//   WITHERS / SACRUM                 trunk landmarks in rig model space (see below)
//
// Record (world metres, arrays [x, y, z]):
//   root, heading [fx, fz]            the horse's root object and its horizontal forward unit vector
//   body                              trunk centre: origin of the Body bone
//   withers, sacrum                   fixed points on Chest / Pelvis at the top line of mesh.js TOP (withers peak: z 0.40,
//                                     y 1.35; croup peak: z −0.38, y 1.33, rig model space)
//   poll, muzzle                      origins of the Head and HeadEnd bones
//   bodyAx, chestAx, pelvisAx         { f, u, l }: forward (+Z), up (+Y), left (+X) unit axes of Body, Chest, Pelvis
//   legs[0..3] (LF, RF, LH, RH):
//     sole, toe, heel                 centre, front and back of the hoof capsule's ground ring (mesh.js hoofMesh: the
//                                     lowest ring of the capsule, rigidly skinned to the hoof bone, read from the skinned
//                                     geometry when the probe is made)
//     low, lowH                       the lowest vertex of the whole hoof capsule and its height above the ground there
//     soleH, toeH, heelH              heights of sole / toe / heel above the ground below each of them
//     contact                         lowH <= contactM
//     coronet, fetlock                origins of the hoof and pastern bones
//     fore: carpus, elbow, shoulder, scapTop   origins of the cannon, forearm, humerus and shoulder-blade bones
//     hind: hock, stifle, hip                   origins of the cannon, tibia and femur bones

export const CONTACT_M = 0.004;

const FORE_BONES = { scapTop: 'Scap', shoulder: 'Hum', elbow: 'Fore', carpus: 'CanF', fetlock: 'PasF', coronet: 'HoofF' };
const HIND_BONES = { hip: 'Fem', stifle: 'Tib', hock: 'CanH', fetlock: 'PasH', coronet: 'HoofH' };
const named = (map, s) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v + s]));

export const LEGS = [
  { name: 'LF', fore: true, side: 'L', bones: named(FORE_BONES, 'L') },
  { name: 'RF', fore: true, side: 'R', bones: named(FORE_BONES, 'R') },
  { name: 'LH', fore: false, side: 'L', bones: named(HIND_BONES, 'L') },
  { name: 'RH', fore: false, side: 'R', bones: named(HIND_BONES, 'R') },
];
// mesh.js TOP profile (side view of the barrel's top line, rig model space): the withers peak and the croup peak
export const WITHERS = [0, 1.35, 0.4];
export const SACRUM = [0, 1.33, -0.38];

// ---- small column-major 4x4 helpers (three.js Matrix4.elements layout) ------------------------------------------------
export function xform(e, x, y, z, out = [0, 0, 0]) {
  out[0] = e[0] * x + e[4] * y + e[8] * z + e[12];
  out[1] = e[1] * x + e[5] * y + e[9] * z + e[13];
  out[2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  return out;
}
const origin = (e) => [e[12], e[13], e[14]];
function axes(e) {
  const n = (x, y, z) => {
    const l = Math.hypot(x, y, z) || 1;
    return [x / l, y / l, z / l];
  };
  return { l: n(e[0], e[1], e[2]), u: n(e[4], e[5], e[6]), f: n(e[8], e[9], e[10]) };
}

// The hoof capsule of one leg in its hoof bone's local frame: every vertex of the horse's skinned meshes carried by that
// bone alone (weight >= 0.999), plus the centre, toe and heel of its ground ring (the vertices within 1 mm of the
// capsule's lowest model-space height; toe / heel = the most forward / backward of them, centre = middle of their
// bounding box). Throws if the geometry has no such vertices (the hoof is no longer rigidly skinned to its bone).
export function hoofCapsule(horse, boneName) {
  const sk = horse.rig.skeleton;
  const bi = sk.bones.findIndex((b) => b.name === boneName);
  if (bi < 0) throw new Error(`trotlab: no bone "${boneName}" in the horse's skeleton`);
  const inv = sk.boneInverses[bi].elements;
  const model = [];
  for (const mesh of horse.meshes) {
    const g = mesh.geometry, pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    if (!pos || !si || !sw) continue;
    const bind = mesh.bindMatrix ? mesh.bindMatrix.elements : null;
    for (let i = 0; i < pos.count; i++) {
      let w = 0;
      for (let k = 0; k < 4; k++) if (si.getComponent(i, k) === bi) w += sw.getComponent(i, k);
      if (w < 0.999) continue;
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      model.push(bind ? xform(bind, x, y, z) : [x, y, z]);
    }
  }
  if (model.length < 8) throw new Error(`trotlab: no hoof capsule rigidly skinned to "${boneName}" (found ${model.length} vertices)`);
  let ymin = Infinity;
  for (const p of model) ymin = Math.min(ymin, p[1]);
  const ring = model.filter((p) => p[1] < ymin + 0.001);
  let x0 = Infinity, x1 = -Infinity, toe = ring[0], heel = ring[0];
  for (const p of ring) {
    x0 = Math.min(x0, p[0]);
    x1 = Math.max(x1, p[0]);
    if (p[2] > toe[2]) toe = p;
    if (p[2] < heel[2]) heel = p;
  }
  const centre = [(x0 + x1) / 2, ymin, (toe[2] + heel[2]) / 2];
  const local = (p) => xform(inv, p[0], p[1], p[2]);
  // dedupe (loft seams repeat a vertex): 0.1 mm grid
  const seen = new Set(), verts = [];
  for (const p of model) {
    const key = p.map((v) => Math.round(v * 1e4)).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    verts.push(...local(p));
  }
  return {
    verts: Float64Array.from(verts),
    sole: local(centre),
    toe: local([centre[0], ymin, toe[2]]),
    heel: local([centre[0], ymin, heel[2]]),
    model: { sole: centre, toe: [centre[0], ymin, toe[2]], heel: [centre[0], ymin, heel[2]], count: verts.length / 3 },
  };
}

// a model-space point carried rigidly by a bone, in that bone's local frame (its inverse bind matrix)
function localOf(horse, boneName, p) {
  const sk = horse.rig.skeleton;
  const bi = sk.bones.findIndex((b) => b.name === boneName);
  if (bi < 0) throw new Error(`trotlab: no bone "${boneName}" in the horse's skeleton`);
  return xform(sk.boneInverses[bi].elements, p[0], p[1], p[2]);
}

export function makeProbe(horse, { contactM = CONTACT_M } = {}) {
  const B = horse.bones;
  const bone = (n) => {
    if (!B[n]) throw new Error(`trotlab: the horse has no bone "${n}"`);
    return B[n];
  };
  const legs = LEGS.map((def) => {
    const bones = Object.fromEntries(Object.entries(def.bones).map(([k, n]) => [k, bone(n)]));
    return { def, bones, cap: hoofCapsule(horse, def.bones.coronet) };
  });
  const body = bone('Body'), chest = bone('Chest'), pelvis = bone('Pelvis'), head = bone('Head'), headEnd = bone('HeadEnd');
  const withersL = localOf(horse, 'Chest', WITHERS), sacrumL = localOf(horse, 'Pelvis', SACRUM);
  const root = horse.root;

  function sample(groundAt) {
    const re = root.matrixWorld.elements;
    const fx = re[8], fz = re[10], fl = Math.hypot(fx, fz) || 1;
    const rec = {
      root: origin(re),
      heading: [fx / fl, fz / fl],
      body: origin(body.matrixWorld.elements),
      withers: xform(chest.matrixWorld.elements, ...withersL),
      sacrum: xform(pelvis.matrixWorld.elements, ...sacrumL),
      poll: origin(head.matrixWorld.elements),
      muzzle: origin(headEnd.matrixWorld.elements),
      bodyAx: axes(body.matrixWorld.elements),
      chestAx: axes(chest.matrixWorld.elements),
      pelvisAx: axes(pelvis.matrixWorld.elements),
      legs: [],
    };
    const p = [0, 0, 0];
    for (const L of legs) {
      const he = L.bones.coronet.matrixWorld.elements;
      const v = L.cap.verts;
      let lowH = Infinity, low = null;
      for (let i = 0; i < v.length; i += 3) {
        xform(he, v[i], v[i + 1], v[i + 2], p);
        const h = p[1] - groundAt(p[0], p[2]);
        if (h < lowH) {
          lowH = h;
          low = [p[0], p[1], p[2]];
        }
      }
      const sole = xform(he, ...L.cap.sole), toe = xform(he, ...L.cap.toe), heel = xform(he, ...L.cap.heel);
      const leg = {
        sole, toe, heel, low, lowH,
        soleH: sole[1] - groundAt(sole[0], sole[2]),
        toeH: toe[1] - groundAt(toe[0], toe[2]),
        heelH: heel[1] - groundAt(heel[0], heel[2]),
        contact: lowH <= contactM,
      };
      for (const [k, b] of Object.entries(L.bones)) leg[k] = origin(b.matrixWorld.elements);
      rec.legs.push(leg);
    }
    return rec;
  }

  return { legs, sample, contactM, withersLocal: withersL, sacrumLocal: sacrumL };
}

// Rotation of a bone relative to its parent, from the two world matrices (rotation parts only, scale divided out), as a
// unit quaternion [x, y, z, w]: the frame-to-frame smoothness metric compares these.
export function relQuat(parentE, boneE) {
  const P = rot3(parentE), B = rot3(boneE);
  // M = Pᵀ · B (row-major 3x3)
  const M = new Array(9);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) M[r * 3 + c] = P[0 * 3 + r] * B[0 * 3 + c] + P[1 * 3 + r] * B[1 * 3 + c] + P[2 * 3 + r] * B[2 * 3 + c];
  return quatFromRot(M);
}

// row-major 3x3 rotation from a column-major 4x4 (columns normalized)
function rot3(e) {
  const sx = Math.hypot(e[0], e[1], e[2]) || 1, sy = Math.hypot(e[4], e[5], e[6]) || 1, sz = Math.hypot(e[8], e[9], e[10]) || 1;
  return [e[0] / sx, e[4] / sy, e[8] / sz, e[1] / sx, e[5] / sy, e[9] / sz, e[2] / sx, e[6] / sy, e[10] / sz];
}

// unit quaternion [x, y, z, w] of a row-major 3x3 rotation
export function quatFromRot(m) {
  const [m11, m12, m13, m21, m22, m23, m31, m32, m33] = m;
  const tr = m11 + m22 + m33;
  let x, y, z, w;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    w = 0.25 / s;
    x = (m32 - m23) * s;
    y = (m13 - m31) * s;
    z = (m21 - m12) * s;
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    w = (m32 - m23) / s;
    x = 0.25 * s;
    y = (m12 + m21) / s;
    z = (m13 + m31) / s;
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    w = (m13 - m31) / s;
    x = (m12 + m21) / s;
    y = 0.25 * s;
    z = (m23 + m32) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    w = (m21 - m12) / s;
    x = (m13 + m31) / s;
    y = (m23 + m32) / s;
    z = 0.25 * s;
  }
  const l = Math.hypot(x, y, z, w) || 1;
  return [x / l, y / l, z / l, w / l];
}

// angle (radians) between two unit quaternions
export function quatAngle(a, b) {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(Math.min(1, d));
}
