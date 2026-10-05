import { POI } from '../../world/Layout.js';

// Horse steering and world rules, pure and allocation-free (scripts/horse.test.mjs).
//   wantedSpeed(mag, { sprint, walk })      stick/WASD magnitude → target ground speed (m/s)
//   maxTurnRate(speed)                      yaw rate limit (rad/s): it shrinks with speed, no pivots at a gallop
//   approach(v, target, dt, up, down)       speed toward a target with separate acceleration / deceleration
//   bodyCircles(x, z, yaw, out)             chest and hindquarters circles of a horse at (x, z) facing yaw
//   circleContact(colliders, x, z, r, footY, out)   deepest overlap of a circle with the static colliders
//   stairLocal(x, z, out) / onStairs(x, z)  position in the shrine stairs' frame / inside the stairs corridor
//   slope(groundAt, x, z, dx, dz, d)        rise over run along a direction (positive uphill)

export const SPEEDS = { walk: 1.8, trot: 4.0, canter: 8.5, gallop: 13.5, back: -0.9 };
// body circles: centres ahead of / behind the barrel centre (m) and radius (m)
export const BODY = { chest: 0.72, rump: -0.6, r: 0.42 };
// steepest grade (rise / run) the horse takes at a walk, and the one it refuses
export const SLOPE = { slow: 0.45, refuse: 0.85 };

export function wantedSpeed(mag, { sprint = false, walk = false } = {}) {
  if (mag < 0.15) return 0;
  if (walk) return SPEEDS.walk;
  if (sprint) return SPEEDS.gallop;
  if (mag < 0.45) return SPEEDS.walk;
  if (mag < 0.8) return SPEEDS.trot;
  return SPEEDS.canter;
}

export function maxTurnRate(speed) {
  const v = Math.abs(speed);
  // 1.7 rad/s at a standstill or a walk (a pivot on the haunches), ~1 at a canter, 0.62 at a full gallop
  if (v <= 1.8) return 1.7;
  if (v >= 13.5) return 0.62;
  const t = (v - 1.8) / (13.5 - 1.8);
  return 1.7 + (0.62 - 1.7) * Math.pow(t, 0.7);
}

export function approach(v, target, dt, up, down) {
  if (target > v) return Math.min(target, v + (v >= 0 ? up : down) * dt);
  return Math.max(target, v - (v > 0 ? down : up) * dt);
}

export function bodyCircles(x, z, yaw, out) {
  const s = Math.sin(yaw), c = Math.cos(yaw);
  out.cx = x + s * BODY.chest;
  out.cz = z + c * BODY.chest;
  out.rx = x + s * BODY.rump;
  out.rz = z + c * BODY.rump;
  out.r = BODY.r;
  return out;
}

const CELL = 16;
const _seen = new Set();

// Deepest overlap of a circle (x, z, r) with the colliders (game.colliders: circles and rotated boxes on a 16 m grid).
// Colliders whose top is below footY + 0.35 are stepped over, like Colliders.resolve(). out: { hit, depth, nx, nz,
// tag } with (nx, nz) the push-out direction. No allocation (the grid is read directly).
export function circleContact(colliders, x, z, r, footY, out) {
  out.hit = false;
  out.depth = 0;
  out.nx = 0;
  out.nz = 0;
  out.tag = '';
  _seen.clear();
  const range = r + 1;
  const x0 = Math.floor((x - range) / CELL), x1 = Math.floor((x + range) / CELL);
  const z0 = Math.floor((z - range) / CELL), z1 = Math.floor((z + range) / CELL);
  for (let ix = x0; ix <= x1; ix++)
    for (let iz = z0; iz <= z1; iz++) {
      const cell = colliders.grid.get(colliders._key(ix, iz));
      if (!cell) continue;
      for (let k = 0; k < cell.length; k++) {
        const c = cell[k];
        if (_seen.has(c)) continue;
        _seen.add(c);
        if (footY >= c.top - 0.35) continue;
        let depth = 0, nx = 0, nz = 0;
        if (c.type === 'circle') {
          const dx = x - c.x, dz = z - c.z;
          const d = Math.hypot(dx, dz), min = c.r + r;
          if (d >= min) continue;
          depth = min - d;
          if (d > 1e-5) (nx = dx / d), (nz = dz / d);
          else nx = 1;
        } else {
          const dx = x - c.x, dz = z - c.z;
          const lx = dx * c.cos - dz * c.sin, lz = dx * c.sin + dz * c.cos;
          const qx = Math.max(-c.hw, Math.min(c.hw, lx)), qz = Math.max(-c.hd, Math.min(c.hd, lz));
          const ex = lx - qx, ez = lz - qz;
          const d = Math.hypot(ex, ez);
          let lnx, lnz;
          if (d > 1e-5) {
            if (d >= r) continue;
            depth = r - d;
            lnx = ex / d;
            lnz = ez / d;
          } else {
            // centre inside the box: out through the nearest face
            const px = c.hw - Math.abs(lx), pz = c.hd - Math.abs(lz);
            if (px < pz) (lnx = Math.sign(lx || 1)), (lnz = 0), (depth = px + r);
            else (lnx = 0), (lnz = Math.sign(lz || 1)), (depth = pz + r);
          }
          nx = lnx * c.cos + lnz * c.sin;
          nz = -lnx * c.sin + lnz * c.cos;
        }
        if (depth > out.depth) {
          out.hit = true;
          out.depth = depth;
          out.nx = nx;
          out.nz = nz;
          out.tag = c.tag;
        }
      }
    }
  return out;
}

// Shrine stairs frame (props/shrine.js): s along the climb from the foot of the stairs, lat across (m).
export function stairLocal(x, z, out) {
  const sh = POI.shrine, u = sh.stairDir, B = sh.stairsBase;
  const dx = x - B.x, dz = z - B.z;
  out.s = dx * u.x + dz * u.z;
  out.lat = dx * u.z - dz * u.x;
  return out;
}

const _sl = { s: 0, lat: 0 };
// inside the stone stairs and their curbs, from the first step to the summit platform
export function onStairs(x, z, margin = 0.6) {
  const sh = POI.shrine;
  stairLocal(x, z, _sl);
  const len = Math.hypot(sh.stairsTop.x - sh.stairsBase.x, sh.stairsTop.z - sh.stairsBase.z);
  return _sl.s > -0.8 - margin && _sl.s < len + 6 && Math.abs(_sl.lat) < sh.stairHalf + 0.6 + margin;
}

export function slope(groundAt, x, z, dx, dz, d = 1.2) {
  const l = Math.hypot(dx, dz) || 1;
  const ux = dx / l, uz = dz / l;
  return (groundAt(x + ux * d, z + uz * d) - groundAt(x - ux * d * 0.5, z - uz * d * 0.5)) / (d * 1.5);
}
