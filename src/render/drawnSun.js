import * as THREE from 'three';

// The sun as drawn in the sky. A shot may raise its giant cinematic disc above the true sun (Sky `sunLift`, in
// degrees) so that it rests whole above the hills: the disc climbs along its own bearing. Everything that sits ON
// the drawn disc goes through these twins, so the two can never drift apart: the sky dome's disc, aureole and cloud
// glow (GLSL, world/Sky.js) and the light shafts' origin (JS, render/Effects.js). Light, haze and shadows keep the
// true sun (uSunDir). No lift returns the true sun as it is.
//   drawnSunDir(sunDir, liftDeg, out)                      JS; sunDir: unit THREE.Vector3, left unchanged
//   DRAWN_SUN_GLSL → vec3 kazeDrawnSunDir(vec3 sunDir, float liftDeg)

export function drawnSunDir(sunDir, liftDeg, out = new THREE.Vector3()) {
  const h = Math.hypot(sunDir.x, sunDir.z);
  // straight overhead there is no bearing to climb along
  if (!liftDeg || h < 1e-6) return out.copy(sunDir);
  const el = Math.asin(THREE.MathUtils.clamp(sunDir.y, -1, 1)) + THREE.MathUtils.degToRad(liftDeg);
  const c = Math.cos(el) / h;
  return out.set(sunDir.x * c, Math.sin(el), sunDir.z * c);
}

export const DRAWN_SUN_GLSL = /* glsl */ `
vec3 kazeDrawnSunDir(vec3 sunDir, float liftDeg) {
  float h = length(sunDir.xz);
  if (liftDeg == 0.0 || h < 1e-6) return sunDir;
  float el = asin(clamp(sunDir.y, -1.0, 1.0)) + radians(liftDeg);
  vec2 b = sunDir.xz * (cos(el) / h);
  return vec3(b.x, sin(el), b.y);
}
`;
