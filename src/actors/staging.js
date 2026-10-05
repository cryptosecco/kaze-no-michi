import * as THREE from 'three';
import { SHOTS } from '../core/shots.js';

// Shot staging: place actors relative to whatever camera pose the canonical shot applied, so framing
// survives changes to src/core/shots.js. Debug shots (T8_*) frame the samurai for close inspection.

const _f = new THREE.Vector3();

export function cameraFrame(camera) {
  camera.updateMatrixWorld(true);
  const fwd = camera.getWorldDirection(new THREE.Vector3());
  fwd.y = 0;
  fwd.normalize();
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const tanH = tanV * camera.aspect;
  return { pos: camera.position.clone(), fwd, right, tanV, tanH, yaw: Math.atan2(fwd.x, fwd.z) };
}

// world XZ of a point at `depth` meters ahead of the camera and horizontal NDC position ndcX (−1..1)
export function inFrame(cf, depth, ndcX) {
  return cf.pos.clone().addScaledVector(cf.fwd, depth).addScaledVector(cf.right, ndcX * depth * cf.tanH);
}

export const yawTo = (from, to) => Math.atan2(to.x - from.x, to.z - from.z);

// S3: the samurai in profile on the left third, the four bandits in a tight, staggered wedge on the right third,
// the setting sun between them. A pure function of the camera frame (scripts/staging.test.mjs checks it):
// { samurai: { x, z, yaw, base, clip }, bandits: [{ i, x, z, yaw, base, clip }] }, where i indexes the actors
// module's bandits and base/clip are Animator.setBase arguments.
// Bandits: [index, depth (m), ndcX, guard] — the long-haired one low in front with the point toward the samurai, the
// rust-brown one coiled behind his back with the blade upright, the ochre one nearest the camera with the point raised
// over that one's head, the olive one upright at the far end with the blade trailing (all with swords). The long
// lens flattens the 2.4 m of stagger: side by side in the frame, each figure (a 0.35 m body cylinder) stands clear of
// the next and no blade reaches across another figure (the low point is the only one level with the bodies, and it
// leads the wedge).
export const S3_BANDITS = [
  [2, 7.4, 0.28, 'b_low'],
  [4, 8.8, 0.435, 'b_hasso'],
  [0, 6.4, 0.61, 'b_seigan'],
  [3, 7.8, 0.77, 'b_waki'],
];
export function s3Layout(cf) {
  const ps = inFrame(cf, 7.0, -0.58);
  const bandits = S3_BANDITS.map(([i, depth, ndc, guard]) => {
    const q = inFrame(cf, depth, ndc);
    return { i, x: q.x, z: q.z, yaw: yawTo(q, ps), base: guard, clip: guard };
  });
  const mid = bandits.reduce((m, b) => ((m.x += b.x / bandits.length), (m.z += b.z / bandits.length), m), { x: 0, z: 0 });
  return { samurai: { x: ps.x, z: ps.z, yaw: yawTo(ps, mid), base: 'duel_low', clip: 'duel_low' }, bandits };
}

// Debug stage near the field (lit by the low west sun)
export const DEBUG_STAGE = { x: 140, z: 86, yaw: -1.309 };

export function registerDebugShots() {
  const S = DEBUG_STAGE;
  const at = (terrain, dist, angle, h, look = 1.1) => {
    const f = new THREE.Vector3(Math.sin(S.yaw + angle), 0, Math.cos(S.yaw + angle));
    const gx = S.x, gz = S.z;
    const g = terrain.heightAt(gx, gz);
    const px = gx - f.x * dist, pz = gz - f.z * dist;
    return { pos: [px, g + h, pz], target: [gx, g + look, gz] };
  };
  SHOTS.T8_back = { hours: 18.0, fov: 40, t0: 14, pose: (t) => at(t, 3.6, 0, 1.75, 1.25) };
  SHOTS.T8_front = { hours: 17.4, fov: 38, t0: 14, pose: (t) => at(t, 3.4, Math.PI, 1.55, 1.1) };
  SHOTS.T8_side = { hours: 17.4, fov: 38, t0: 14, pose: (t) => at(t, 3.6, Math.PI * 0.5, 1.4, 1.0) };
  SHOTS.T8_three = { hours: 17.6, fov: 40, t0: 14, pose: (t) => at(t, 3.8, Math.PI * 0.78, 1.6, 1.1) };
  SHOTS.T8_group = { hours: 17.4, fov: 45, t0: 14, pose: (t) => at(t, 7.5, Math.PI * 0.62, 1.7, 1.0) };
  void _f;
}
