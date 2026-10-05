// Flight of a bird as a point mass (pure math, no three.js: scripts/wildlife.test.mjs runs it in Node).
//
// Forces, all through the air the bird flies in (airspeed u = v − wind):
//   gravity      m·g, down
//   wing lift    ⊥ u, |L| ≤ ½ρ|u|²·S·CLmax (stall); its direction about u is the bank
//   drag         along −u, ½ρ|u|²·S·(CD0 + k·CL² [+ flare: wings cupped, tail fanned, legs down])
//   flapping     what the gliding wing cannot give (thrust, lift at low speed, braking backstrokes), power-limited:
//                |F| ≤ min(flapStatic, flapPower / |u|), never a net push downward
// The guidance asks for an acceleration; flightStep() turns it into the forces above within their limits and
// integrates (semi-implicit Euler). In level flight the lift equals the weight, in a coordinated turn its horizontal
// share is the centripetal force, so the bank comes out as φ = atan(v·ω / g). The share of the available flapping
// force in use (effort) drives the wingbeat: strong at take-off, in a climb and in the last metres of a landing,
// moderate in cruise, zero in a glide.

export const G = 9.81;
export const RHO = 1.2;

// Derived aerodynamic constants of a species (SI units).
//   mass (kg), S (m²), span (m), CD0, e (Oswald), CLmax (gliding wing), CLbody / CDbody (wings folded, over S),
//   flapLift (flapping force at rest, in body weights), flapPower (W), brakeG (braking strokes, in body weights),
//   flareCD (extra drag coefficient at full flare)
export function aero(sp) {
  const AR = (sp.span * sp.span) / sp.S;
  return {
    m: sp.mass,
    S: sp.S,
    CD0: sp.CD0,
    k: 1 / (Math.PI * sp.e * AR),
    CLmax: sp.CLmax,
    CLbody: sp.CLbody ?? 0.08,
    CDbody: sp.CDbody ?? sp.CD0 * 0.55,
    flapStatic: sp.flapLift * sp.mass * G,
    flapPower: sp.flapPower,
    brake: (sp.brakeG ?? 0.5) * sp.mass * G,
    flareCD: sp.flareCD ?? 1.0,
    AR,
  };
}

// Stall speed of the gliding wing (m/s)
export function stallSpeed(A) {
  return Math.sqrt((2 * A.m * G) / (RHO * A.S * A.CLmax));
}

// Steady level flight at airspeed V: lift coefficient, drag, glide ratio, power (diagnostics and tests)
export function levelFlight(A, V) {
  const q = 0.5 * RHO * V * V;
  const CL = (A.m * G) / (q * A.S);
  const D = q * A.S * (A.CD0 + A.k * CL * CL);
  return { CL, D, LD: (A.m * G) / D, power: D * V };
}

// One integration step.
//   b: { x, y, z, vx, vy, vz, hx, hz }   (hx, hz: the heading the wings work along when the airspeed is ~0)
//   c: { ax, ay, az } wanted acceleration (world, m/s²); flap 0..1 (flapping allowed); folded (wings closed: a bound);
//      flare 0..1
//   w: wind { x, y, z } (m/s)
//   out (optional) receives: V (airspeed), CL, L, D, F (flapping force, N), effort 0..1, bank (rad, + = right wing
//      down), gamma (climb angle of the airspeed), ux, uy, uz (unit airspeed), ax, ay, az (actual acceleration)
export function flightStep(b, A, c, w, dt, out) {
  const m = A.m;
  const ux = b.vx - w.x, uy = b.vy - w.y, uz = b.vz - w.z;
  const V = Math.sqrt(ux * ux + uy * uy + uz * uz);
  let hx, hy, hz;
  if (V > 0.25) {
    hx = ux / V;
    hy = uy / V;
    hz = uz / V;
  } else {
    // (almost) still air around the bird: the wings work along its heading
    const l = Math.hypot(b.hx || 0, b.hz || 0);
    hx = l > 1e-6 ? b.hx / l : 0;
    hy = 0;
    hz = l > 1e-6 ? b.hz / l : 1;
  }
  const q = 0.5 * RHO * V * V;
  // the aerodynamic force the guidance wants (gravity is no aerodynamic force)
  const Fx = m * c.ax, Fy = m * (c.ay + G), Fz = m * c.az;
  const Fpar = Fx * hx + Fy * hy + Fz * hz;
  const Px = Fx - Fpar * hx, Py = Fy - Fpar * hy, Pz = Fz - Fpar * hz;
  const Pm = Math.sqrt(Px * Px + Py * Py + Pz * Pz);
  // the wing: lift perpendicular to the airspeed, up to the stall (wings folded: the body alone)
  const Lmax = q * A.S * (c.folded ? A.CLbody : A.CLmax);
  const kL = Pm > 1e-9 ? Math.min(1, Lmax / Pm) : 0;
  const Lx = Px * kL, Ly = Py * kL, Lz = Pz * kL;
  const Lm = Pm * kL;
  const CL = q * A.S > 1e-9 ? Lm / (q * A.S) : 0;
  const CD = c.folded ? A.CDbody : A.CD0 + A.k * CL * CL + A.flareCD * (c.flare || 0);
  const D = q * A.S * CD;
  // what is left for the flapping wings: thrust (power-limited: F·V ≤ flapPower), braking backstrokes (with the body
  // pitched up and the tail fanned: up to `brake` body weights), and the lift the wing cannot give at low speed (up to
  // flapStatic in all)
  let Fx2 = 0, Fy2 = 0, Fz2 = 0, effort = 0, Fm = 0;
  const flap = c.folded ? 0 : c.flap || 0;
  if (flap > 0) {
    const Rx = Fx - Lx + D * hx, Rz = Fz - Lz + D * hz;
    let Ry = Fy - Ly + D * hy;
    // the stroke pushes up, forward or back, not the bird down (a dive is gravity's work)
    if (Ry < 0) Ry *= 0.1;
    const Rpar = Rx * hx + Ry * hy + Rz * hz;
    const Qx = Rx - Rpar * hx, Qy = Ry - Rpar * hy, Qz = Rz - Rpar * hz;
    const Qm = Math.sqrt(Qx * Qx + Qy * Qy + Qz * Qz);
    const thrustCap = (A.flapPower / Math.max(V, 1)) * flap;
    const brakeCap = A.brake * flap;
    const fpar = Rpar >= 0 ? Math.min(Rpar, thrustCap) : Math.max(Rpar, -brakeCap);
    const perpCap = Math.sqrt(Math.max(0, A.flapStatic * A.flapStatic * flap * flap - fpar * fpar));
    const kq = Qm > 1e-9 ? Math.min(1, perpCap / Qm) : 0;
    Fx2 = fpar * hx + Qx * kq;
    Fy2 = fpar * hy + Qy * kq;
    Fz2 = fpar * hz + Qz * kq;
    Fm = Math.sqrt(Fx2 * Fx2 + Fy2 * Fy2 + Fz2 * Fz2);
    // how hard the wings work: the largest share of a limit in use
    effort = Math.min(1, Math.max(fpar > 0 ? fpar / Math.max(1e-6, A.flapPower / Math.max(V, 1)) : -fpar / Math.max(1e-6, A.brake), (Qm * kq) / A.flapStatic));
  }
  const ax = (Lx - D * hx + Fx2) / m;
  const ay = (Ly - D * hy + Fy2) / m - G;
  const az = (Lz - D * hz + Fz2) / m;
  b.vx += ax * dt;
  b.vy += ay * dt;
  b.vz += az * dt;
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.z += b.vz * dt;
  if (out) {
    // bank: the angle about the airspeed axis of the force perpendicular to it (the lift and the flapping share of
    // it), from the vertical plane through the airspeed
    const fpar = Fx2 * hx + Fy2 * hy + Fz2 * hz;
    const Tx = Lx + Fx2 - fpar * hx, Ty = Ly + Fy2 - fpar * hy, Tz = Lz + Fz2 - fpar * hz;
    let upx = -hy * hx, upy = 1 - hy * hy, upz = -hy * hz;
    const ul = Math.sqrt(upx * upx + upy * upy + upz * upz);
    let bank = 0;
    if (ul > 1e-4) {
      upx /= ul;
      upy /= ul;
      upz /= ul;
      // right = h × up
      const rx = hy * upz - hz * upy, ry = hz * upx - hx * upz, rz = hx * upy - hy * upx;
      const tu = Tx * upx + Ty * upy + Tz * upz, tr = Tx * rx + Ty * ry + Tz * rz;
      if (Math.abs(tu) + Math.abs(tr) > 1e-6) bank = Math.atan2(tr, tu);
    }
    out.V = V;
    out.CL = CL;
    out.L = Lm;
    out.D = D;
    out.F = Fm;
    out.effort = effort;
    out.bank = bank;
    out.gamma = Math.asin(Math.max(-1, Math.min(1, hy)));
    out.ux = hx;
    out.uy = hy;
    out.uz = hz;
    out.ax = ax;
    out.ay = ay;
    out.az = az;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ guidance

// Ground speed along the horizontal unit direction (dx, dz) that gives the airspeed Va in the horizontal wind
// (wx, wz): |s·d − w| = Va. The bird crabs into a crosswind; a headwind stronger than Va leaves it a crawl.
export function groundSpeedFor(dx, dz, Va, wx, wz) {
  const dw = dx * wx + dz * wz;
  const disc = Va * Va - (wx * wx + wz * wz) + dw * dw;
  if (disc <= 0) return Math.max(0.5, dw);
  return Math.max(0.5, dw + Math.sqrt(disc));
}

// Track a wanted velocity with time constant 1/k, the correction capped at amax (m/s²). Writes c.ax / ay / az.
export function trackVelocity(b, vx, vy, vz, k, amax, c) {
  let ax = (vx - b.vx) * k, ay = (vy - b.vy) * k, az = (vz - b.vz) * k;
  const a = Math.sqrt(ax * ax + ay * ay + az * az);
  if (a > amax) {
    const s = amax / a;
    ax *= s;
    ay *= s;
    az *= s;
  }
  c.ax = ax;
  c.ay = ay;
  c.az = az;
  return c;
}

// A landing plan: the bird's hip must arrive at (cx, cy, cz) travelling along the horizontal unit direction (dx, dz)
// (into the wind), down a glide slope of `slope` rad. The approach line runs from the gate, `gate` metres back and up
// the slope, to the target; the closing speed follows v = √(2·decel·d) (a constant deceleration: τ̇ = ½, the
// time-to-contact law of landing birds), so the bird arrives with no speed left.
export function planApproach(cx, cy, cz, dx, dz, { slope = 0.3, gate = 15, decel = 3.5, vmax = 11 } = {}) {
  const l = Math.hypot(dx, dz) || 1;
  dx /= l;
  dz /= l;
  const rise = Math.tan(slope) * gate;
  const L = Math.hypot(gate, rise);
  return {
    cx, cy, cz,
    dx, dz,
    gx: cx - dx * gate, gy: cy + rise, gz: cz - dz * gate,
    // unit vector along the line, from the gate to the target
    tx: (dx * gate) / L, ty: -rise / L, tz: (dz * gate) / L,
    L, gate, decel, vmax, slope,
  };
}

// The closing speed of a landing `d` metres out: the constant deceleration of the plan, then, inside the last
// TOUCH_DIST, a linear fade (an exponential settle onto the perch: the feet meet it at a walking pace and the legs
// take up the rest), so the contact comes at nearly zero relative speed.
export const TOUCH_DIST = 0.3;
export function closingSpeed(plan, d) {
  if (d >= TOUCH_DIST) return Math.min(plan.vmax, Math.sqrt(2 * plan.decel * d));
  return Math.min(plan.vmax, Math.sqrt(2 * plan.decel * TOUCH_DIST)) * (d / TOUCH_DIST);
}

// Is the bird in position for the final approach (on the line's side of the gate, close to the line, heading in)?
// Otherwise it first flies to the gate. Hysteresis is the caller's: once final, stay final.
export function readyForFinal(b, plan) {
  const px = b.x - plan.cx, py = b.y - plan.cy, pz = b.z - plan.cz;
  const s = px * plan.tx + py * plan.ty + pz * plan.tz;
  const qx = px - s * plan.tx, qy = py - s * plan.ty, qz = pz - s * plan.tz;
  const lateral = Math.sqrt(qx * qx + qy * qy + qz * qz);
  const gx = b.x - plan.gx, gy = b.y - plan.gy, gz = b.z - plan.gz;
  const nearGate = gx * gx + gy * gy + gz * gz < Math.max(6.25, (plan.L * 0.35) ** 2);
  // heading in: the ground velocity points along the line (not away from the target)
  const vin = b.vx * plan.tx + b.vy * plan.ty + b.vz * plan.tz;
  const vh = Math.hypot(b.vx, b.vy, b.vz) || 1;
  return nearGate || (s < -plan.L * 0.7 && lateral < plan.L * 0.35 && vin > 0.5 * vh);
}

// Guidance along a landing plan: pure pursuit of the approach line (a smooth intercept from wherever the bird is), the
// speed on the τ̇ = ½ profile of the distance still to fly, and a feed-forward of the deceleration on the line.
// Returns (a shared object) { d: distance to the target (m), along: metres before the target on the line (< 0 past
// it), lateral: distance off the line, flare 0..1 } and writes the wanted acceleration into c.
const _ap = { d: 0, along: 0, flare: 0, lateral: 0, vref: 0 };
export function approachGuidance(b, plan, flareDist, c, look = 8, k = 4, amax = 9) {
  const px = b.x - plan.cx, py = b.y - plan.cy, pz = b.z - plan.cz;
  // signed coordinate along the line (0 at the target, negative before it)
  const s = px * plan.tx + py * plan.ty + pz * plan.tz;
  const qx = px - s * plan.tx, qy = py - s * plan.ty, qz = pz - s * plan.tz;
  const lateral = Math.sqrt(qx * qx + qy * qy + qz * qz);
  const d = Math.sqrt(px * px + py * py + pz * pz);
  // pursuit point on the line, ahead of the bird's projection, never past the target
  const lk = Math.min(look, Math.max(0.15, d * 0.6));
  const t = Math.min(0, s + lk);
  const ex = plan.tx * t - px, ey = plan.ty * t - py, ez = plan.tz * t - pz;
  const el = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1;
  // distance still to fly: along the line, plus the way back onto it
  const togo = Math.max(d, -s + lateral * 0.5);
  const v = closingSpeed(plan, togo);
  trackVelocity(b, (ex / el) * v, (ey / el) * v, (ez / el) * v, k, amax, c);
  // feed-forward: the rate at which the profile's speed falls at the bird's actual closing speed (dv/dt = dv/dd · ḋ);
  // without it a lagging tracker arrives too fast, and it vanishes once the bird stops
  const vc = (b.vx * ex + b.vy * ey + b.vz * ez) / el;
  if (v < plan.vmax && s < 0 && vc > 0) {
    const prof = togo >= TOUCH_DIST ? (plan.decel * vc) / Math.max(v, 0.2) : (vc * closingSpeed(plan, TOUCH_DIST)) / TOUCH_DIST;
    const ff = Math.min(prof, plan.decel * 1.5) * Math.min(1, 1.5 - lateral * 0.25);
    if (ff > 0) {
      c.ax -= (ex / el) * ff;
      c.ay -= (ey / el) * ff;
      c.az -= (ez / el) * ff;
    }
  }
  _ap.d = d;
  _ap.along = -s;
  _ap.lateral = lateral;
  _ap.vref = v;
  _ap.flare = 1 - smooth(flareDist * 0.3, flareDist, d);
  return _ap;
}

export function smooth(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Bank of a steady coordinated turn at speed v and turn rate ω (rad/s): φ = atan(v·ω / g)
export function bankForTurn(v, omega) {
  return Math.atan((v * omega) / G);
}
