import * as THREE from 'three';

// Analytic two-bone IK for bones with identity rest orientation (see rig/skeleton.js).
//   solveArm(rig, side, wristTarget, pole, weight)   side = +1 left / −1 right; world-space targets
//   solveLeg(rig, side, ankleTarget, pole, weight)
//   setWorldQuat(bone, q)                            local = parentWorld⁻¹ · q
// The bend plane is built so that the child bone's rotation relative to its parent is a pure hinge
// (elbow flexion about local Y, knee flexion about local X), which keeps skinning twist natural.

const _S = new THREE.Vector3(), _E = new THREE.Vector3(), _T = new THREE.Vector3(), _u = new THREE.Vector3(), _w = new THREE.Vector3();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _tmp = new THREE.Vector3();
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _pq = new THREE.Quaternion(), _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
const _pos = new THREE.Vector3(), _scl = new THREE.Vector3();

export function worldQuat(obj, out) {
  obj.matrixWorld.decompose(_pos, out, _scl);
  return out;
}

export function setWorldQuat(bone, q, weight = 1) {
  bone.parent.matrixWorld.decompose(_pos, _pq, _scl);
  _q.copy(_pq).invert().multiply(q);
  if (weight >= 1) bone.quaternion.copy(_q);
  else bone.quaternion.slerp(_q, weight);
  bone.updateMatrixWorld(true);
}

function basisQuat(x, y, z, out) {
  _m.makeBasis(x, y, z);
  return out.setFromRotationMatrix(_m);
}

// Elbow/knee position for a chain S→E→T with lengths a, b bending toward the pole.
function bendPoint(S, T, a, b, pole, out) {
  _u.subVectors(T, S);
  let d = _u.length();
  if (d < 1e-5) {
    _u.set(0, -1, 0);
    d = 1e-5;
  } else _u.multiplyScalar(1 / d);
  const dc = Math.min(Math.max(d, Math.abs(a - b) + 1e-4), a + b - 1e-4);
  const cosA = (a * a + dc * dc - b * b) / (2 * a * dc);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  _w.subVectors(pole, S);
  _w.addScaledVector(_u, -_w.dot(_u));
  if (_w.lengthSq() < 1e-8) _w.set(0, 0, 1).addScaledVector(_u, -_u.z);
  _w.normalize();
  out.copy(S).addScaledVector(_u, a * cosA).addScaledVector(_w, a * sinA);
  return dc;
}

export function solveArm(rig, side, target, pole, weight = 1) {
  if (weight <= 0) return;
  const L = side > 0 ? 'Left' : 'Right';
  const arm = rig.bones[L + 'Arm'], fore = rig.bones[L + 'ForeArm'], hand = rig.bones[L + 'Hand'];
  const a = fore.position.length(), b = hand.position.length();
  arm.getWorldPosition(_S);
  _T.copy(target);
  bendPoint(_S, _T, a, b, pole, _E);
  // upper arm basis: local X along the bone (±), local Z toward the forearm bend
  _x.subVectors(_E, _S).normalize();
  _tmp.subVectors(_T, _E);
  _z.copy(_tmp).addScaledVector(_x, -_tmp.dot(_x));
  if (_z.lengthSq() < 1e-8) _z.subVectors(pole, _E).addScaledVector(_x, -_tmp.dot(_x));
  _z.normalize();
  const bx = _x.clone().multiplyScalar(side);
  _y.crossVectors(_z, bx).normalize();
  _z.crossVectors(bx, _y).normalize();
  basisQuat(bx, _y, _z, _qa);
  setWorldQuat(arm, _qa, weight);
  // forearm: along E→T, same hinge axis (local Y)
  fore.getWorldPosition(_E);
  const fx = _tmp.subVectors(_T, _E).normalize().multiplyScalar(side);
  const fz = new THREE.Vector3().crossVectors(fx, _y).normalize();
  const fy = new THREE.Vector3().crossVectors(fz, fx).normalize();
  basisQuat(fx, fy, fz, _qb);
  setWorldQuat(fore, _qb, weight);
}

export function solveLeg(rig, side, target, pole, weight = 1) {
  if (weight <= 0) return;
  const L = side > 0 ? 'Left' : 'Right';
  const up = rig.bones[L + 'UpLeg'], leg = rig.bones[L + 'Leg'], foot = rig.bones[L + 'Foot'];
  const a = leg.position.length(), b = foot.position.length();
  up.getWorldPosition(_S);
  _T.copy(target);
  bendPoint(_S, _T, a, b, pole, _E);
  // thigh: local −Y along the bone, local −Z toward the shin bend (knee flexes backward)
  const ny = _tmp.subVectors(_E, _S).normalize();
  const y = ny.clone().negate();
  const toA = new THREE.Vector3().subVectors(_T, _E);
  const bend = toA.clone().addScaledVector(ny, -toA.dot(ny));
  let z;
  if (bend.lengthSq() < 1e-8) z = new THREE.Vector3().subVectors(pole, _E).addScaledVector(ny, -new THREE.Vector3().subVectors(pole, _E).dot(ny));
  else z = bend.negate();
  z.normalize();
  const x = new THREE.Vector3().crossVectors(y, z).normalize();
  z.crossVectors(x, y).normalize();
  basisQuat(x, y, z, _qa);
  setWorldQuat(up, _qa, weight);
  leg.getWorldPosition(_E);
  const sy = new THREE.Vector3().subVectors(_E, _T).normalize(); // local +Y points from ankle to knee
  const sz = new THREE.Vector3().crossVectors(x, sy).normalize();
  const sx = new THREE.Vector3().crossVectors(sy, sz).normalize();
  basisQuat(sx, sy, sz, _qb);
  setWorldQuat(leg, _qb, weight);
}
