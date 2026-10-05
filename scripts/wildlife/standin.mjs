// A stand-in world for the wildlife simulation (src/world/wildlife/sim.js) in Node: rolling terrain with a sea to the
// west, round crowns with top / outer / inner perches, open walkable ground, a steady wind, threats you move by hand;
// and the mammals' services (walkable ground, cover, a habitat near the trees, refuges in them).
// Used by scripts/wildlife.test.mjs and scripts/mammals.test.mjs (and handy to tune the behaviour without a browser).
import { awayFrom } from '../../src/world/wildlife/sim.js';

export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// opts: { seed, flat (no hills), wind [x, z] (m/s), trees (count), sea (x below which there is water), size }
export function standinWorld(opts = {}) {
  const r = rng(opts.seed ?? 7);
  const flat = !!opts.flat;
  const sea = opts.sea ?? -170;
  const size = opts.size ?? 200;
  const wind = opts.wind ?? [2.5, 0.8];
  const ground = (x, z) => {
    if (x < sea) return -2;
    if (flat) return 4;
    return 6 + 5 * Math.sin(x / 37) * Math.cos(z / 29) + 3 * Math.sin((x + 2 * z) / 53) + 0.4 * Math.sin(x / 3.1) * Math.sin(z / 4.3);
  };
  // crowns: ellipsoids on trunks, perches on their surface / inside
  const trees = [];
  const nTrees = opts.trees ?? 40;
  for (let i = 0; i < nTrees; i++) {
    const x = (r() * 2 - 1) * size, z = (r() * 2 - 1) * size;
    if (x < sea + 10) continue;
    const shrub = r() < 0.3;
    const H = shrub ? 1.2 + r() * 0.8 : 8 + r() * 14;
    const y = ground(x, z);
    const t = { i, x, z, y, H, shrub, cy: y + H * (shrub ? 0.55 : 0.62), rh: H * (shrub ? 0.5 : 0.28), ry: H * (shrub ? 0.4 : 0.26), perches: null };
    trees.push(t);
  }
  const perchesOf = (t) => {
    if (t.perches) return t.perches;
    const P = [];
    P.push({ x: t.x, y: t.cy + t.ry * 0.97, z: t.z, kind: 'tree', tier: 'top', nx: 0, nz: 0, key: `t${t.i}:top`, tree: t });
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      const rho = 0.72, el = Math.sqrt(1 - rho * rho) * 0.95;
      P.push({ x: t.x + c * t.rh * rho, y: t.cy + t.ry * el, z: t.z + s * t.rh * rho, kind: 'tree', tier: 'outer', nx: c, nz: s, key: `t${t.i}:o${k}`, tree: t });
    }
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + 0.3, c = Math.cos(a), s = Math.sin(a);
      P.push({ x: t.x + c * t.rh * 0.6, y: t.cy + t.ry * 0.1, z: t.z + s * t.rh * 0.6, kind: 'tree', tier: 'inner', nx: c, nz: s, key: `t${t.i}:i${k}`, tree: t });
    }
    t.perches = P;
    return P;
  };
  const crownTop = (t, x, z) => {
    const d2 = (x - t.x) ** 2 + (z - t.z) ** 2;
    if (d2 >= t.rh * t.rh) return -Infinity;
    return t.cy + t.ry * Math.sqrt(1 - d2 / (t.rh * t.rh));
  };
  const slope = (x, z) => Math.max(Math.abs(ground(x + 0.5, z) - ground(x - 0.5, z)), Math.abs(ground(x, z + 0.5) - ground(x, z - 0.5)));
  const groundOK = (x, z) => {
    if (ground(x, z) < 0.6 || slope(x, z) > 0.4) return false;
    for (const t of trees) if (!t.shrub && (x - t.x) ** 2 + (z - t.z) ** 2 < 1) return false;
    return true;
  };
  // open sky over a spot (no crown overhead within a couple of metres): where a flock can come down
  const openSky = (x, z) => {
    const g = ground(x, z) + 1;
    for (const [ox, oz] of [[0, 0], [2.5, 0], [-2.5, 0], [0, 2.5], [0, -2.5]]) for (const t of trees) if (crownTop(t, x + ox, z + oz) > g) return false;
    return true;
  };
  const awayScore = (x, z, away) => (away ? Math.hypot(x - away.x, z - away.z) : 0);
  const w = {
    time: 0,
    rng: rng((opts.seed ?? 7) + 101),
    center: { x: 0, z: 0 },
    threats: [],
    noises: [],
    alarm: 1,
    events: [],
    trees,
    groundAt: ground,
    groundOK,
    wind(x, y, z, out) {
      out.x = wind[0];
      out.y = 0;
      out.z = wind[1];
      return out;
    },
    obstacleTop(x, z) {
      let m = -Infinity;
      for (const t of trees) {
        const h = crownTop(t, x, z);
        if (h > m) m = h;
      }
      return m;
    },
    findTree(sp, x, z, o) {
      let best = null, bs = -Infinity;
      for (const t of trees) {
        const d = Math.hypot(t.x - x, t.z - z);
        if (d < o.rMin || d > o.rMax) continue;
        if (o.flee && !awayFrom(x, z, o.away, t.x, t.z)) continue;
        if (o.cover ? false : t.shrub) continue;
        if (!o.cover && sp.name === 'crow' && t.H < 9) continue;
        const s = awayScore(t.x, t.z, o.away) * 0.05 + (o.cover ? -d * 0.05 + (t.shrub ? 1 : 0) - t.H * 0.06 : t.H * 0.1) + w.rng() * 0.8;
        if (s > bs) (bs = s), (best = t);
      }
      if (!best) return null;
      const tiers = o.tiers || ['top', 'outer'];
      const perches = perchesOf(best).filter((p) => tiers.includes(p.tier));
      return { x: best.x, z: best.z, perches };
    },
    findGround(sp, x, z, o) {
      for (let k = 0; k < 30; k++) {
        const a = w.rng() * Math.PI * 2, d = o.rMin + (o.rMax - o.rMin) * w.rng();
        const px = x + Math.sin(a) * d, pz = z + Math.cos(a) * d;
        if (!groundOK(px, pz) || !openSky(px, pz)) continue;
        if (o.flee && !awayFrom(x, z, o.away, px, pz)) continue;
        if (o.away && Math.hypot(px - o.away.x, pz - o.away.z) < 15) continue;
        const perches = [];
        for (let i = 0; i < o.count * 3 && perches.length < o.count; i++) {
          const qa = w.rng() * Math.PI * 2, qd = Math.sqrt(w.rng()) * sp.patch * 0.6;
          const qx = px + Math.sin(qa) * qd, qz = pz + Math.cos(qa) * qd;
          if (!groundOK(qx, qz) || perches.some((p) => Math.hypot(p.x - qx, p.z - qz) < sp.spacing)) continue;
          perches.push({ x: qx, y: ground(qx, qz), z: qz, kind: 'ground', key: `g${qx.toFixed(2)},${qz.toFixed(2)}` });
        }
        if (perches.length >= Math.min(o.count, 2)) return { x: px, z: pz, perches };
      }
      return null;
    },
    findProp() {
      return null;
    },
    sway: null,
    inView: () => false,
    emit(type, detail) {
      w.events.push({ type, t: w.time, detail });
    },
    // ---- the mammals' services (mammals.js): ground they may walk, cover, habitat, refuges
    camera: { x: 0, y: 0, z: 0 },
    walkable(x, z, sp) {
      const cl = sp && sp.clearance ? sp.clearance : 0.25;
      if (ground(x, z) < 0.5) return false;
      if (slope(x, z) > 0.75) return false;
      for (const t of trees) if (!t.shrub && (x - t.x) ** 2 + (z - t.z) ** 2 < (0.3 + cl) ** 2) return false;
      return true;
    },
    cover(x, z) {
      let n = 0;
      for (const t of trees) if (!t.shrub && (x - t.x) ** 2 + (z - t.z) ** 2 < 144) n++;
      return Math.min(1, n / 3);
    },
    findHabitat(sp, x, z, o) {
      // open walkable ground; the deer within reach of the trees (an edge), the fox anywhere open
      for (let k = 0; k < 40; k++) {
        const a = w.rng() * Math.PI * 2, d = o.rMin + (o.rMax - o.rMin) * Math.sqrt(w.rng());
        const px = x + Math.sin(a) * d, pz = z + Math.cos(a) * d;
        if (!w.walkable(px, pz, sp)) continue;
        if (o.away && Math.hypot(px - o.away.x, pz - o.away.z) < sp.fid.ground * 1.2) continue;
        const near = trees.reduce((m, t) => (t.shrub ? m : Math.min(m, Math.hypot(t.x - px, t.z - pz))), Infinity);
        if (near < 6 || (sp.name === 'deer' && near > 40)) continue;
        const spots = [];
        for (let i = 0; i < (o.count || 1) * 10 && spots.length < (o.count || 1); i++) {
          const qa = w.rng() * Math.PI * 2, qd = spots.length ? 1.5 + w.rng() * 4 : 0;
          const qx = px + Math.sin(qa) * qd, qz = pz + Math.cos(qa) * qd;
          if (!w.walkable(qx, qz, sp) || spots.some((s) => Math.hypot(s.x - qx, s.z - qz) < 2)) continue;
          spots.push({ x: qx, z: qz, yaw: w.rng() * Math.PI * 2 });
        }
        if (spots.length >= (o.count || 1)) return { x: px, z: pz, kind: 'edge', spots };
      }
      return null;
    },
    findCover(sp, x, z, o) {
      let best = null, bs = -Infinity;
      for (let k = 0; k < 28; k++) {
        const base = o.away ? Math.atan2(x - o.away.x, z - o.away.z) : w.rng() * Math.PI * 2;
        const a = base + (w.rng() - 0.5) * (o.away ? 3.4 : Math.PI * 2);
        const r = o.rMin + (o.rMax - o.rMin) * w.rng();
        const px = x + Math.sin(a) * r, pz = z + Math.cos(a) * r;
        if (o.away && !awayFrom(x, z, o.away, px, pz)) continue;
        if (!w.walkable(px, pz, sp)) continue;
        const cv = w.cover(px, pz);
        if (cv < 0.5) continue;
        const s = cv + w.rng() * 0.3 + (o.away ? Math.min(Math.hypot(px - o.away.x, pz - o.away.z), 150) * 0.006 : 0);
        if (s > bs) (bs = s), (best = { x: px, z: pz });
      }
      return best;
    },
  };
  return w;
}

// A threat that walks / runs / gallops along a straight line toward a point
export function mover(x, z, toX, toZ, speed, scale = 1) {
  const dx = toX - x, dz = toZ - z, l = Math.hypot(dx, dz) || 1;
  return {
    x, y: 0, z, vx: (dx / l) * speed, vz: (dz / l) * speed, speed, scale,
    step(dt, ground) {
      this.x += this.vx * dt;
      this.z += this.vz * dt;
      this.y = ground(this.x, this.z);
    },
  };
}
