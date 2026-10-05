// Where the rider meets the horse, shared by the horse's tack (mesh.js), the riding clips of the humanoid library
// (anim/ride.js) and the mount logic (Riding.js). Horse model space: facing +Z, left = +X, hooves on y = 0 (m).
//   SEAT        the saddle's seat surface under the rider's pelvis
//   STIRRUP     the left stirrup's tread centre (the right one mirrors x)
//   HANDS       the left fist on the reins above the pommel (the right one mirrors x)
//   HIPS_ABOVE  height of the rider's Hips bone above the seat surface
//   RIDER_ROOT  the seated rider's root (feet reference of the humanoid rig) in horse space
// Every rider-space point is horse space minus RIDER_ROOT (the rider faces the horse's way).

export const SEAT = { x: 0, y: 1.36, z: 0.09 };
export const STIRRUP = { x: 0.3, y: 0.85, z: 0.15 };
export const HANDS = { x: 0.075, y: 1.56, z: 0.4 };
export const HIPS_ABOVE = 0.13;
const HIPS_REST_Y = 0.97; // rig/skeleton.js
export const RIDER_ROOT = { x: SEAT.x, y: SEAT.y + HIPS_ABOVE - HIPS_REST_Y, z: SEAT.z };
// mounting spot on the near (left) side, by the stirrup, and where the rider lands when he gets off (horse space)
export const MOUNT_SPOT = { x: 0.66, y: 0, z: 0.08 };
export const LAND_SPOT = { x: 0.8, y: 0, z: 0.0 };
