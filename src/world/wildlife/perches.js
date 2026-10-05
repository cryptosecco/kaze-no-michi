// Perches from the real geometry of the trees (pure: reads BufferGeometry attributes, no rendering).
//
// A crown is its leaf cards (trees/generator.js, LOD0). Seen from above, the highest card centre in each cell of a small
// grid is the foliage surface; from it:
//   top     the summit of the leaf mass: where a crow sits on a treetop (feet among the topmost leaves)
//   outer   the upper flanks all round the crown: a crow on an outer upper branch, a sparrow on a lookout twig
//   inner   card centres inside the leaf mass near its shell, at mid height: where small birds hide
// Points are in the variant's local frame (scale 1, unrotated) and carry what the sway mirror needs: the card's wind
// attributes (aWind: x = height term × flex, y = branch weight, z = branch phase).
// Never inside a trunk: the trunk of a grown tree ends inside its foliage (scripts/trees.test.mjs keeps every bark
// vertex under the leaves), top and outer perches lie on the foliage surface, and inner ones keep 40 % of the crown's
// radius from its axis (scripts/wildlife.test.mjs measures all of them against the trunk the generator grew).

const SECTORS_OUTER = 8;
const SECTORS_INNER = 6;

export function crownPerches(variant) {
  const geo = variant.lod0 && variant.lod0.leaves;
  if (!geo) return { top: [], outer: [], inner: [] };
  const pos = geo.getAttribute('position');
  const aw = geo.getAttribute('aWind');
  const P = pos.array, W = aw ? aw.array : null;
  const nCards = Math.floor(pos.count / 4);
  const C = variant.crown.c, R = variant.crown.r;
  const rh = Math.max(R.x, R.z);
  const shrub = variant.cls === 'shrub';
  // card centres (+ their wind attributes)
  const cx = new Float32Array(nCards), cy = new Float32Array(nCards), cz = new Float32Array(nCards);
  const wh = new Float32Array(nCards), ww = new Float32Array(nCards), wp = new Float32Array(nCards);
  for (let k = 0; k < nCards; k++) {
    let x = 0, y = 0, z = 0, a = 0, b = 0, c = 0;
    for (let j = 0; j < 4; j++) {
      const o = (k * 4 + j) * 3;
      x += P[o];
      y += P[o + 1];
      z += P[o + 2];
      if (W) {
        const q = (k * 4 + j) * 4;
        a += W[q];
        b += W[q + 1];
        c += W[q + 2];
      }
    }
    cx[k] = x / 4;
    cy[k] = y / 4;
    cz[k] = z / 4;
    wh[k] = a / 4;
    ww[k] = b / 4;
    wp[k] = c / 4;
  }
  // the foliage surface seen from above
  const cell = Math.max(shrub ? 0.25 : 0.4, Math.min(0.9, rh / 6));
  const x0 = C.x - rh - cell, z0 = C.z - rh - cell;
  const n = Math.ceil((2 * rh + 2 * cell) / cell) + 1;
  const best = new Int32Array(n * n).fill(-1);
  for (let k = 0; k < nCards; k++) {
    const i = Math.floor((cx[k] - x0) / cell), j = Math.floor((cz[k] - z0) / cell);
    if (i < 0 || j < 0 || i >= n || j >= n) continue;
    const o = j * n + i;
    if (best[o] < 0 || cy[k] > cy[best[o]]) best[o] = k;
  }
  const pt = (k, tier) => {
    const dx = cx[k] - C.x, dz = cz[k] - C.z, l = Math.hypot(dx, dz);
    return { x: cx[k], y: cy[k], z: cz[k], nx: l > 1e-3 ? dx / l : 0, nz: l > 1e-3 ? dz / l : 0, h: wh[k], w: ww[k], ph: wp[k], tier };
  };
  const surface = [];
  for (let o = 0; o < best.length; o++) if (best[o] >= 0) surface.push(best[o]);
  surface.sort((a, b) => cy[b] - cy[a]);
  // a perch on the surface must have leaves under it (not a lone card sticking up: at least 3 cards within 0.6 m) and
  // open air over it (no card centre within 0.3 m sideways and 0.25 m higher: a bird comes down onto it)
  const supported = (k) => {
    let m = 0;
    for (let q = 0; q < nCards; q++) {
      const dx = cx[q] - cx[k], dy = cy[q] - cy[k], dz = cz[q] - cz[k];
      if (dx * dx + dy * dy + dz * dz < 0.36) m++;
      if (dy > 0.25 && dx * dx + dz * dz < 0.09) return false;
    }
    return m >= 3;
  };
  // top: the highest supported surface points, ~1.2 m apart (two crows can share a big crown's top)
  const top = [];
  const yTop = surface.length ? cy[surface[0]] : 0;
  for (const k of surface) {
    if (cy[k] < yTop - (shrub ? 0.25 : 0.7)) break;
    if (!supported(k)) continue;
    if (top.some((p) => Math.hypot(p.x - cx[k], p.z - cz[k]) < 1.2)) continue;
    top.push(pt(k, 'top'));
    if (top.length >= 2) break;
  }
  // outer: per sector, the supported surface point highest up and farthest out on the upper half of the crown
  const outer = [];
  const bySector = Array.from({ length: SECTORS_OUTER }, () => []);
  for (const k of surface) {
    const dx = cx[k] - C.x, dz = cz[k] - C.z;
    const rho = Math.hypot(dx, dz);
    if (rho < rh * 0.42 || cy[k] < C.y + R.y * 0.1) continue;
    let a = Math.atan2(dz, dx);
    if (a < 0) a += Math.PI * 2;
    bySector[Math.min(SECTORS_OUTER - 1, Math.floor((a / (Math.PI * 2)) * SECTORS_OUTER))].push([k, (cy[k] - C.y) / R.y + 0.6 * (rho / rh)]);
  }
  for (const cand of bySector) {
    cand.sort((a, b) => b[1] - a[1]);
    for (const [k] of cand.slice(0, 12)) {
      if (top.some((p) => Math.hypot(p.x - cx[k], p.z - cz[k]) < 0.8) || !supported(k)) continue;
      outer.push(pt(k, 'outer'));
      break;
    }
  }
  // inner: per sector, the card centre nearest a spot 60 % out and a little above the middle (in the leaf mass)
  const inner = [];
  for (let s = 0; s < SECTORS_INNER; s++) {
    let bk = -1, bd = Infinity;
    for (let k = 0; k < nCards; k++) {
      const dx = cx[k] - C.x, dz = cz[k] - C.z;
      const rho = Math.hypot(dx, dz);
      if (rho < rh * 0.4 || rho > rh * 0.85) continue;
      const dyn = (cy[k] - C.y) / R.y;
      if (dyn < -0.35 || dyn > 0.45) continue;
      let a = Math.atan2(dz, dx);
      if (a < 0) a += Math.PI * 2;
      if (Math.floor((a / (Math.PI * 2)) * SECTORS_INNER) !== s) continue;
      const d = (rho / rh - 0.6) ** 2 + (dyn - 0.1) ** 2;
      if (d < bd) (bd = d), (bk = k);
    }
    if (bk >= 0) inner.push(pt(bk, 'inner'));
  }
  // clear of the trunk: a perch the leader runs through goes onto its tip (a crow on a cedar's spire grips the top of
  // the leader), one the trunk passes elsewhere is dropped
  const tr = variant.trunk;
  const clearOfTrunk = (list) => {
    if (!tr) return list;
    const tip = tr.pts[tr.pts.length - 1];
    const out = [];
    for (const p of list) {
      const { d, r } = trunkDistance(tr, p.x, p.y, p.z);
      if (d > r + 0.12) out.push(p);
      else if (tip[1] - p.y < 0.6 && p.tier === 'top') {
        p.x = tip[0];
        p.y = tip[1] + 0.03;
        p.z = tip[2];
        out.push(p);
      }
    }
    return out;
  };
  return { top: clearOfTrunk(top), outer: clearOfTrunk(outer), inner: clearOfTrunk(inner), crownTop: yTop };
}

// Distance from a point to a trunk axis { pts: [[x, y, z]…], rads } and the trunk's radius at the nearest point. A
// point above the tip is measured to the tip with a radius of zero: the trunk ends there.
export function trunkDistance(tr, x, y, z) {
  let best = Infinity, rad = 0;
  const n = tr.pts.length;
  for (let i = 0; i < n - 1; i++) {
    const a = tr.pts[i], b = tr.pts[i + 1];
    const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
    const l2 = abx * abx + aby * aby + abz * abz || 1;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * abx + (y - a[1]) * aby + (z - a[2]) * abz) / l2));
    const d = Math.hypot(x - a[0] - abx * t, y - a[1] - aby * t, z - a[2] - abz * t);
    if (d < best) {
      best = d;
      rad = tr.rads[i] + (tr.rads[i + 1] - tr.rads[i]) * t;
      if (i === n - 2 && t >= 1 && y > b[1]) rad = 0;
    }
  }
  return { d: best, r: rad };
}

// A perch of a crown in the world: the tree record's position, rotation about y and scale applied.
//   t: { x, y, z, s, cos, sin } (base, scale, rotation of the instance)   p: a crownPerches() point
export function toWorld(t, p, out = {}) {
  const lx = p.x * t.s, lz = p.z * t.s;
  out.x = t.x + lx * t.cos + lz * t.sin;
  out.y = t.y + p.y * t.s;
  out.z = t.z - lx * t.sin + lz * t.cos;
  out.nx = p.nx * t.cos + p.nz * t.sin;
  out.nz = -p.nx * t.sin + p.nz * t.cos;
  out.tier = p.tier;
  return out;
}
