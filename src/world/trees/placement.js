import { POI, PATHS, PATH_INFO, WORLD, campLocal, CAMP_CLEARINGS, inClearing } from '../Layout.js';
import { SHOTS, aim } from '../../core/shots.js';
import { rng, clamp, smoothstep, Simplex, hash2 } from '../../core/math.js';
import { sunDirection } from '../Lighting.js';
import { drawnSunDir } from '../../render/drawnSun.js';

// Where the trees go. Deterministic for a seed. Rules:
//   - forests grow as irregular STANDS (clumps of 1–8 trees around a centre) seeded where
//     terrain.surfaceAt().forest is high; stand noise opens glades → no evenly spaced "picket fence" on crests
//   - deciduous first: big round crimson maples dominate the rim hills, ginkgos the camp valley;
//     dark conifers are accents (shrine hill, coast, high ridges)
//   - the field stays open: a few big specimen maples/pines at its edges
//   - clearings: stair corridor, shrine summit (16.5 m), camp (45 m), paths (width/2 + 3.5 m),
//     the canonical shot corridors, and the line of sight from the S1 camera to the summit torii
//   - hero trees frame the canonical shots; positions come from the shot poses (src/core/shots.js)
//   - bamboo groves flank the pagoda path; shrubs line forest edges and the shrine stairs
// Output records: { x, y, z, species, variant(key), scale, rot, hero }

const SH = POI.shrine;
// left of a viewer climbing the stairs: for a view direction d, (-d.z, d.x) is "right", so left = (d.z, -d.x)
const STAIR_LEFT = { x: SH.stairDir.z, z: -SH.stairDir.x };
// spacing between trunks inside a stand (crowns may interlock), by species, at scale 1
const SPACING = { maple: 5.8, ginkgo: 7.0, cedar: 3.6, pine: 5.0, bamboo: 2.4 };
// typical dimensions at scale 1 (height, crown radius, crown centre height fraction) for sight-line tests
const DIMS = { maple: [9, 5, 0.6], ginkgo: [19, 5, 0.58], cedar: [24, 2.8, 0.6], pine: [10.5, 3.2, 0.75], bamboo: [11, 2.2, 0.7] };
export const CAMP_CLEAR = 45;
// Hero trees framing S5: tall columnar ginkgos around the farmhouse — one cut by the left edge, one left of
// the house, one behind its roof, a backlit one right of it — and crimson maples on the rise behind.
// [species, lx, lz, scale, variant] in the camp local frame (Layout.campLocal: +x = left of the viewpoint,
// +z = behind the house, viewpoint at z = −36). scripts/camp.test.mjs keeps them outside Layout.CAMP_CLEARINGS.
export const S5_HEROES = [
  ['ginkgo', 13, -19, 1.2, 'ginkgoCol0'],
  ['ginkgo', 11, -1, 1.25, 'ginkgoCol1'],
  ['ginkgo', -1, 15, 1.3, 'ginkgoCol2'],
  ['ginkgo', -17, 7, 1.3, 'ginkgoCol0'],
  ['maple', 20, 20, 1.3, null],
  ['maple', 28, 10, 1.25, null],
  ['maple', 10, 32, 1.2, null],
];

// Maples framing a shot's edges, planted last like the S2 walls (nothing else moves), in the shot's frame:
// { shot: [[species, angle right of the frame's axis (deg), distance (m), scale, variant, rotDeg], ...] }
//   S1: a full crimson maple cut by the left edge, on the rise behind the field
//   S4 (title): one far off at the right edge; the left third stays a calm field under the calligraphy (a maple there,
//   behind the logo, sat on the S1 camera's sight line to the torii and was cleared by the props module)
export const FRAME_HEROES = {
  S1: [['maple', -37, 100, 1.7, 'mapleHero', 110]],
  S4: [['maple', 19, 95, 1.35, null, 200]],
};

// Forest walls of the S2 stair view, in stair coordinates [species, s, lat, scale, variant, rotDeg]: s along the
// climb from the foot of the stairs, lat > 0 = left of a climber. Dark pines with their trunks at the right edge of the
// frame and a golden ginkgo mass over the left curb; the crimson focus is the giant maple left of the stairs' top.
// Planted after the whole forest with fixed rotations, so they draw nothing from the random streams (every other tree
// stays where it was); random trees on their footprint give way. The S1 → sky torii sight line (props/index.js)
// crosses the stairs at s ≈ 39 and runs low over the right flank higher up: scripts/shrine.test.mjs keeps every crown
// here clear of it. Nothing tall is added near the summit: seen from S1 it would rise over the hill's silhouette.
export const S2_HEROES = [
  ['pine', 30, -7.2, 1.15, null, 20],
  ['pine', 34.5, -8.4, 1.25, null, 140],
  ['pine', 38.8, -10.4, 1.2, null, 260],
  ['ginkgo', 37, 16.5, 1.3, null, 30],
  ['ginkgo', 44, 12.5, 1.25, null, 200],
];
// Stair crowns taken out [s, lat]: the crimson maples along the left curb and on the left flank (S2
// keeps one crimson maple, the giant one left of the stairs' top); the first one overhung the steps with loose clumps
export const S2_CLEAR = [
  [31, 7.3],
  [38, 8],
  [52, 8.5],
  [58, 7],
  [50.9, 26.6],
  [58.1, 24.7],
];

// S2 accent crowns taken out for S1 [s, lat]: seen from the S1 camera they rise over the shrine hill's crest just
// right of the sky torii (a dark cedar spike, two pines); the S2 frame does not show them (S1: the torii alone on a bare
// crest; the S2 canopy left of it stays, it hides the gate hall from S1). scripts/shrine.test.mjs keeps them out.
export const S1_CREST_CLEAR = [
  [44, -19],
  [42.5, -14],
  [46, -16.5],
];

// stair coordinates → world (s along the climb from the foot, lat > 0 = left of a climber)
export function stairPoint(s, lat) {
  const u = SH.stairDir;
  return { x: SH.stairsBase.x + u.x * s + u.z * lat, z: SH.stairsBase.z + u.z * s - u.x * lat };
}

function segDist(px, pz, ax, az, bx, bz) {
  const abx = bx - ax, abz = bz - az;
  const l2 = abx * abx + abz * abz;
  const t = l2 > 0 ? clamp(((px - ax) * abx + (pz - az) * abz) / l2, 0, 1) : 0;
  return { d: Math.hypot(px - ax - abx * t, pz - az - abz * t), t };
}

// distance-to-path field on a 4 m grid (rasterised per segment)
function pathField() {
  const RES = 4, N = WORLD.size / RES + 1;
  const f = new Float32Array(N * N).fill(1e3);
  const R = 14;
  PATHS.forEach((pts, pi) => {
    const hw = PATH_INFO[pi].width * 0.5;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const x0 = Math.floor((Math.min(a.x, b.x) - R + WORLD.half) / RES), x1 = Math.ceil((Math.max(a.x, b.x) + R + WORLD.half) / RES);
      const z0 = Math.floor((Math.min(a.z, b.z) - R + WORLD.half) / RES), z1 = Math.ceil((Math.max(a.z, b.z) + R + WORLD.half) / RES);
      for (let j = Math.max(0, z0); j <= Math.min(N - 1, z1); j++)
        for (let k = Math.max(0, x0); k <= Math.min(N - 1, x1); k++) {
          const d = segDist(k * RES - WORLD.half, j * RES - WORLD.half, a.x, a.z, b.x, b.z).d - hw;
          const o = j * N + k;
          if (d < f[o]) f[o] = d;
        }
    }
  });
  return (x, z) => {
    const fx = clamp((x + WORLD.half) / RES, 0, N - 1.001), fz = clamp((z + WORLD.half) / RES, 0, N - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    const a = f[j * N + i] + (f[j * N + i + 1] - f[j * N + i]) * tx;
    const b = f[(j + 1) * N + i] + (f[(j + 1) * N + i + 1] - f[(j + 1) * N + i]) * tx;
    return a + (b - a) * tz;
  };
}

// A shot frame on the ground plane: camera position, unit forward f and right r.
function shotFrame(id, terrain) {
  const s = SHOTS[id];
  if (!s) return null;
  const { pos, target } = s.pose(terrain);
  return frameOf(pos, target);
}

function frameOf(pos, target) {
  let fx = target[0] - pos[0], fz = target[2] - pos[2];
  const l = Math.hypot(fx, fz) || 1;
  fx /= l;
  fz /= l;
  return { x: pos[0], y: pos[1], z: pos[2], fx, fz, rx: -fz, rz: fx };
}

// point at horizontal angle theta (deg, + = right of frame) and distance D in a shot frame
function inFrame(fr, thetaDeg, D) {
  const lat = D * Math.tan((thetaDeg * Math.PI) / 180);
  return { x: fr.x + fr.fx * D + fr.rx * lat, z: fr.z + fr.fz * D + fr.rz * lat };
}

function frameCoords(fr, x, z) {
  const dx = x - fr.x, dz = z - fr.z;
  return { along: dx * fr.fx + dz * fr.fz, lat: dx * fr.rx + dz * fr.rz };
}

export function placeTrees(terrain, { seed = 1234, density = 1 } = {}) {
  const rand = rng(seed * 3 + 17);
  // hero trees draw from their own stream, so adding or moving one never reshuffles the forest
  const hrand = rng(seed * 5 + 29);
  const S = new Simplex(seed + 101);
  const pd = pathField();
  const out = [];
  const shrubs = [];
  const frames = { S1: shotFrame('S1_field', terrain), S3: shotFrame('S3_standoff', terrain), S4: shotFrame('S4_title', terrain), S5: shotFrame('S5_ginkgo', terrain) };
  const summitY = terrain.heightAt(SH.x, SH.z);

  // --- sight lines that must stay open: S1 camera → summit torii (and 45 m of sky behind it) --------------
  const sights = [];
  if (frames.S1) {
    const c = frames.S1;
    for (const T of [
      { x: SH.x, z: SH.z },
      { x: SH.stairsTop.x, z: SH.stairsTop.z },
    ]) {
      const ty = summitY + 6.5;
      const dx = T.x - c.x, dy = ty - c.y, dz = T.z - c.z;
      const L = Math.hypot(dx, dy, dz);
      const k = (L + 90) / L;
      sights.push({ ax: c.x, ay: c.y, az: c.z, bx: c.x + dx * k, by: c.y + dy * k, bz: c.z + dz * k, tBehind: L / (L + 90) });
    }
  }
  // does a crown (sphere) at this tree intersect a protected sight line?
  const blocksSight = (species, x, z, gy, scale) => {
    if (!sights.length) return false;
    const [h, cr, cf] = DIMS[species] || DIMS.maple;
    const px = x, py = gy + h * cf * scale, pz = z;
    const r = cr * scale + 1.5;
    for (const s of sights) {
      const vx = s.bx - s.ax, vy = s.by - s.ay, vz = s.bz - s.az;
      const t = clamp(((px - s.ax) * vx + (py - s.ay) * vy + (pz - s.az) * vz) / (vx * vx + vy * vy + vz * vz), 0, 1);
      const qx = s.ax + vx * t, qy = s.ay + vy * t, qz = s.az + vz * t;
      // crowns are spheres; behind the torii keep a wider band of open sky around its silhouette
      const rr = t > s.tBehind ? r + 4 : r;
      if (Math.hypot(px - qx, py - qy, pz - qz) < rr) return true;
      const ty = gy + h * scale;
      if (Math.hypot(px - qx, Math.max(0, qy - ty), pz - qz) < cr * scale * 0.6 && ty > qy) return true;
    }
    return false;
  };

  // --- shot corridors: 0 = clear, 0..1 = thinning factor, 1 = untouched ---------------------------------
  const corridor = (x, z) => {
    let keep = 1;
    const f1 = frames.S1;
    if (f1) {
      const { along, lat } = frameCoords(f1, x, z);
      if (Math.hypot(x - f1.x, z - f1.z) < 14) return 0;
      const w = Math.abs(lat) - along * 0.84; // tan(40°)
      if (along > 0 && along < 150 && w < 4) return 0;
      if (along >= 150 && along < 330 && w < 0) keep = Math.min(keep, 0.35);
    }
    const f3 = frames.S3;
    if (f3) {
      const { along, lat } = frameCoords(f3, x, z);
      if (Math.hypot(x - f3.x, z - f3.z) < 12) return 0;
      if (along > 0 && along < 420 && Math.abs(lat) < along * 0.66 + 5) return 0;
    }
    const f5 = frames.S5;
    if (f5) {
      const { along, lat } = frameCoords(f5, x, z);
      if (Math.hypot(x - f5.x, z - f5.z) < 12) return 0;
      if (along > 0 && along < 34 && Math.abs(lat) < 10 + along * 0.4) return 0;
    }
    return keep;
  };

  // --- occupancy (trunk spacing) -------------------------------------------------------------------
  const occ = new Map();
  const CELL = 8;
  const key = (i, j) => i * 100003 + j;
  const free = (x, z, r) => {
    const i0 = Math.floor((x - r) / CELL), i1 = Math.floor((x + r) / CELL);
    const j0 = Math.floor((z - r) / CELL), j1 = Math.floor((z + r) / CELL);
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const c = occ.get(key(i, j));
        if (c) for (const t of c) if (Math.hypot(t.x - x, t.z - z) < Math.max(r, t.r)) return false;
      }
    return true;
  };
  const mark = (x, z, r) => {
    const k = key(Math.floor(x / CELL), Math.floor(z / CELL));
    let c = occ.get(k);
    if (!c) occ.set(k, (c = []));
    c.push({ x, z, r });
  };
  const ground = (x, z, r) =>
    Math.min(terrain.heightAt(x, z), terrain.heightAt(x + r, z), terrain.heightAt(x - r, z), terrain.heightAt(x, z + r), terrain.heightAt(x, z - r));
  const stairD = (x, z) => segDist(x, z, SH.stairsBase.x, SH.stairsBase.z, SH.stairsTop.x, SH.stairsTop.z);
  const campD = (x, z) => Math.hypot(x - POI.camp.x, z - POI.camp.z);
  const add = (species, x, z, scale, opts = {}) => {
    const rec = { species, x, z, y: ground(x, z, 0.6 * scale), scale, rot: (opts.hero ? hrand : rand)() * Math.PI * 2, hero: !!opts.hero, variant: opts.variant || null };
    out.push(rec);
    mark(x, z, opts.space ?? (SPACING[species] || 4) * scale);
    return rec;
  };
  // common exclusion rules for any tree
  const blocked = (species, x, z, scale, { stair = 6.2, camp = CAMP_CLEAR, path = 3.5, sight = true } = {}) => {
    const h = terrain.heightAt(x, z);
    if (h < 0.8) return true;
    if (pd(x, z) < path) return true;
    if (stairD(x, z).d < stair) return true;
    if (Math.hypot(x - SH.x, z - SH.z) < 16.5) return true;
    if (campD(x, z) < camp) return true;
    if (sight && blocksSight(species, x, z, h, scale)) return true;
    return false;
  };
  // hero placement: nudge sideways (lateral) until the spot is legal
  const addHero = (species, p, scale, variant, lateral, opts = {}) => {
    let { x, z } = p;
    for (let k = 0; k < 10; k++) {
      if (!blocked(species, x, z, scale, { stair: opts.stair ?? 5, camp: CAMP_CLEAR, path: 4, sight: opts.sight ?? true })) {
        return add(species, x, z, scale, { hero: true, variant, space: (SPACING[species] || 4) * scale * 1.2 });
      }
      x += lateral.x * 3;
      z += lateral.z * 3;
    }
    return null;
  };

  // ---- hero trees: S2 shrine stairs (lush mixed canopy, giant maple near the summit) ------------------
  const along = (t, lat) => ({
    x: SH.stairsBase.x + (SH.stairsTop.x - SH.stairsBase.x) * t + STAIR_LEFT.x * lat,
    z: SH.stairsBase.z + (SH.stairsTop.z - SH.stairsBase.z) * t + STAIR_LEFT.z * lat,
  });
  const RIGHT = { x: -STAIR_LEFT.x, z: -STAIR_LEFT.z };
  const SL = Math.hypot(SH.stairsTop.x - SH.stairsBase.x, SH.stairsTop.z - SH.stairsBase.z);
  const atS = (s, lat) => along(s / SL, lat); // by metres along the stairs
  {
    // giant maple left of the stairs' top, pushed further left if it would hide the torii from S1
    const p = along(0.97, 13);
    addHero('maple', p, 1.45, 'mapleHero', STAIR_LEFT, { stair: 8 });
  }
  // the flights climb through a closed canopy — trunks 6.5–9 m off the axis, crowns overhanging the curbs;
  // gold and crimson on the left (kept low near the top: the S1 sight line to the summit torii passes there),
  // dark pines and cedars with crimson maples on the right
  const leftSeq = ['ginkgo', 'maple', 'maple', 'ginkgo', 'maple', 'maple', 'ginkgo', 'maple', 'maple', 'maple'];
  const rightSeq = ['cedar', 'maple', 'pine', 'cedar', 'maple', 'pine', 'pine', 'maple', 'pine', 'maple'];
  for (let i = 0; i < leftSeq.length; i++) {
    const s = 3 + i * 6.8 + hrand() * 2;
    addHero(leftSeq[i], atS(s, 6.6 + hrand() * 2.2), 1.0 + hrand() * 0.3, null, STAIR_LEFT, { stair: 5.5 });
    addHero(rightSeq[i], atS(s + 3.2, -(6.6 + hrand() * 2.2)), 0.95 + hrand() * 0.3, null, RIGHT, { stair: 5.5 });
  }
  // S2 accents for the view from the second landing: big golden ginkgos on the left, dark pines framing the
  // top-right corner. Spots checked against the S1 → sky torii sight line (props clear crowns that cut it in
  // 3D: it crosses the stairs at s ≈ 39 m and runs over the right flank higher up, so the right-hand pines stay
  // near the camera and well out to the side)
  for (const [sp, s, lat, sc] of [
    ['ginkgo', 48, 11, 1.2],
    ['ginkgo', 56, 9.5, 1.25],
    ['maple', 61, 12, 1.3],
    ['maple', 52, 8.5, 1.2],
    ['maple', 58, 7, 1.15],
    ['pine', 40, -10.5, 1.2],
    ['pine', 42.5, -14, 1.25],
    ['pine', 46, -16.5, 1.2],
    ['cedar', 44, -19, 1.0],
  ])
    addHero(sp, atS(s, lat), sc, null, lat > 0 ? STAIR_LEFT : RIGHT, { stair: 5.5, sight: false });

  // ---- hero trees framing S1 (big maple at the left edge, crimson maples on the far rises) -------------
  if (frames.S1) {
    const f = frames.S1;
    const L = { x: -f.rx, z: -f.rz }, Rt = { x: f.rx, z: f.rz };
    for (const [sp, th, D, s] of [
      ['maple', -36, 58, 1.5],
      ['maple', -23, 175, 1.4],
      ['maple', -19, 192, 1.25],
      ['maple', -27, 210, 1.2],
      ['pine', -31, 228, 1.1],
      ['maple', 22, 150, 1.4],
      ['maple', 29, 225, 1.25],
      ['maple', 12, 310, 1.35],
    ])
      addHero(sp, inFrame(f, th, D), s, null, th < 0 ? L : Rt);
  }
  // ---- two maples on the east rise of the basin: they stay (moving them re-rolls the forest and every shrub
  //      after them); the title's own framing maple is in FRAME_HEROES
  {
    const pos = [175, terrain.heightAt(175, 100) + 9, 100];
    const { target } = aim(pos, 249, -4);
    const f = frameOf(pos, target);
    const L = { x: -f.rx, z: -f.rz };
    for (const [sp, th, D, s] of [
      ['maple', -21, 26, 1.55],
      ['maple', -8, 46, 1.3],
    ])
      addHero(sp, inFrame(f, th, D), s, null, L);
  }
  // ---- hero trees framing S5 (list in S5_HEROES): clear of the camp dressing (props/camp.js: tents, banner
  //      lines, fences, palisade), so the 45 m camp rule does not apply here — only the props clearings do ----
  {
    const YD = POI.camp.yard;
    for (const [sp, lx, lz, s, variant] of S5_HEROES) {
      const p = campLocal(lx, lz);
      if (inClearing(p.x, p.z, CAMP_CLEARINGS) || Math.hypot(p.x - YD.x, p.z - YD.z) < 6 || pd(p.x, p.z) < 2.5) {
        console.warn(`[trees] S5 hero ${variant || sp} at camp (${lx}, ${lz}) dropped: inside a camp clearing, the yard or a path`);
        continue;
      }
      add(sp, p.x, p.z, s, { hero: true, variant, space: (SPACING[sp] || 4) * s });
    }
  }

  // ---- forest: irregular stands ------------------------------------------------------------------------
  const SG = 15 / Math.sqrt(density);
  for (let z = -WORLD.half + SG / 2; z < WORLD.half; z += SG)
    for (let x = -WORLD.half + SG / 2; x < WORLD.half; x += SG) {
      const cx = x + (rand() - 0.5) * SG, cz = z + (rand() - 0.5) * SG;
      const sf = terrain.surfaceAt(cx, cz);
      const f = sf.forest;
      if (f < 0.1 || sf.rock > 0.6) continue;
      const glade = 0.5 + 0.5 * S.noise(cx * 0.011 + 5.3, cz * 0.011 - 2.7); // woods and glades at ~90 m
      const grove = inGrove(cx, cz);
      const p = smoothstep(0.1, 0.6, f) * (0.2 + 0.8 * smoothstep(0.25, 0.7, glade)) * (grove ? 0.42 : 1);
      if (rand() > p) continue;
      const h0 = terrain.heightAt(cx, cz);
      const dsh = Math.hypot(cx - SH.x, cz - SH.z);
      const main = pickSpecies(cx, cz, h0, dsh, S, rand);
      // stand size grows with the forest density; single big trees are common on the open rises
      const nT = 1 + Math.floor(Math.pow(rand(), 1.7) * (grove ? 2.5 : 1.5 + 6.5 * f));
      const rad = 2.5 + nT * (main === 'cedar' ? 1.2 : 1.9);
      for (let k = 0; k < nT; k++) {
        const species = rand() < 0.82 ? main : pickSpecies(cx + 30, cz - 20, h0, dsh, S, rand);
        const a = rand() * Math.PI * 2, r = k === 0 ? rand() * 1.5 : rad * Math.sqrt(rand());
        const px = cx + Math.cos(a) * r, pz = cz + Math.sin(a) * r;
        const s = terrain.surfaceAt(px, pz);
        if (s.forest < 0.06 || s.rock > 0.6) continue;
        const deciduous = species === 'maple' || species === 'ginkgo';
        let scale = (deciduous ? 1.0 + rand() * 0.42 : 0.8 + rand() * 0.35) * (k === 0 ? 1.08 : 1);
        if (grove && species === 'ginkgo') scale = 1.25 + rand() * 0.35;
        if (blocked(species, px, pz, scale)) continue;
        const cor = corridor(px, pz);
        if (cor < 1 && rand() >= cor) continue;
        const sp = (SPACING[species] || 4) * scale * (0.8 + 0.3 * rand()) * (grove ? 1.35 : 1);
        if (!free(px, pz, sp)) continue;
        // half of the camp valley's ginkgos grow tall and columnar; hashed so the random stream is untouched
        const hc = hash2(Math.round(px * 7), Math.round(pz * 7));
        const variant = grove && species === 'ginkgo' && hc < 0.5 ? 'ginkgoCol' + Math.floor(hc * 6) : null;
        add(species, px, pz, scale, { space: sp, variant });
      }
    }

  // ---- specimen trees at the field edges -------------------------------------------------------------
  const F = POI.field;
  for (let z = F.z - F.r; z < F.z + F.r; z += 26)
    for (let x = F.x - F.r; x < F.x + F.r; x += 26) {
      const px = x + (rand() - 0.5) * 22, pz = z + (rand() - 0.5) * 22;
      const df = Math.hypot(px - F.x, pz - F.z);
      if (df > F.r) continue;
      const edge = smoothstep(F.r * 0.45, F.r * 0.9, df);
      const n = S.noise(px * 0.012 + 3.3, pz * 0.012 - 1.1);
      if (rand() > (0.05 + 0.22 * edge) * (0.7 + 0.6 * n)) continue;
      const sp = rand() < 0.8 ? 'maple' : 'pine';
      const scale = sp === 'maple' ? 1.15 + rand() * 0.35 : 0.95 + rand() * 0.25;
      if (blocked(sp, px, pz, scale, { stair: 12, path: 7 }) || corridor(px, pz) < 1) continue;
      if (!free(px, pz, 10)) continue;
      add(sp, px, pz, scale, { space: 10 });
    }

  // ---- bamboo groves along the pagoda path ----------------------------------------------------------
  const pag = PATHS[3];
  for (let i = 0; i < pag.length - 1; i++) {
    const a = pag[i], b = pag[i + 1];
    if (a.z > -205 || a.z < -345) continue;
    const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz);
    const lx = -dz / l, lz = dx / l;
    for (let s = 0; s < l; s += 4.2) {
      for (const side of [-1, 1]) {
        for (let row = 0; row < 3; row++) {
          const off = 4.2 + row * 4.5 + rand() * 2.5;
          const px = a.x + (dx / l) * s + lx * off * side + (rand() - 0.5) * 2;
          const pz = a.z + (dz / l) * s + lz * off * side + (rand() - 0.5) * 2;
          if (pd(px, pz) < 2.6 || !free(px, pz, 2.2)) continue;
          add('bamboo', px, pz, 0.85 + rand() * 0.35, { space: 2.4 });
        }
      }
    }
  }

  // ---- shrubs / undergrowth --------------------------------------------------------------------------
  const GS = 5.5;
  for (let z = -WORLD.half + GS / 2; z < WORLD.half; z += GS)
    for (let x = -WORLD.half + GS / 2; x < WORLD.half; x += GS) {
      const px = x + (rand() - 0.5) * GS, pz = z + (rand() - 0.5) * GS;
      const s = terrain.surfaceAt(px, pz);
      const edge = smoothstep(0.03, 0.2, s.forest) * (1 - smoothstep(0.5, 0.85, s.forest));
      const p = edge * 0.28 + smoothstep(0.6, 0.95, s.forest) * 0.05;
      if (rand() > p) continue;
      if (terrain.heightAt(px, pz) < 0.8 || s.rock > 0.5 || pd(px, pz) < 1.8 || stairD(px, pz).d < 3.4) continue;
      if (corridor(px, pz) < 1 || campD(px, pz) < CAMP_CLEAR - 5 || Math.hypot(px - SH.x, pz - SH.z) < 15) continue;
      shrubs.push({ species: 'shrub', x: px, z: pz, y: terrain.heightAt(px, pz), scale: 0.75 + rand() * 0.6, rot: rand() * 6.283, hero: false, variant: null, tone: pickTone(rand) });
    }
  // azalea hedges along both sides of the shrine stairs, just outside the curbs: mostly dark evergreen (the
  // crimson is kept for one maple and the torii); fixed draws per shrub, so the streams below are unchanged
  for (let t = 0.03; t < 0.97; t += 0.06)
    for (const side of [1, -1]) {
      const p = along(t + rand() * 0.02, side * (SH.stairHalf + 1.4 + rand() * 1.4));
      shrubs.push({ species: 'shrub', x: p.x, z: p.z, y: terrain.heightAt(p.x, p.z), scale: 0.65 + rand() * 0.3, rot: rand() * 6.283, hero: true, variant: null, tone: rand() < 0.2 ? 'red' : 'dark' });
    }
  // S3: a low crimson thicket behind the bandits, right of the sun
  if (frames.S3) {
    const f = frames.S3;
    for (let i = 0; i < 9; i++) {
      const p = inFrame(f, 7 + rand() * 17, 25 + rand() * 10);
      if (pd(p.x, p.z) < 2) continue;
      shrubs.push({ species: 'shrub', x: p.x, z: p.z, y: terrain.heightAt(p.x, p.z), scale: 1.5 + rand() * 0.7, rot: rand() * 6.283, hero: true, variant: null, tone: rand() < 0.8 ? 'red' : 'yellow' });
    }
  }

  // ---- S2 forest walls and the shots' framing maples, planted last (see S2_HEROES, FRAME_HEROES): no random
  //      draws, nothing else moves; random trees and shrubs on their footprint give way ---------------------------
  const s2 = [];
  for (const [sp, s, lat, sc, variant, rotDeg] of S2_HEROES) {
    const p = stairPoint(s, lat);
    if (blocked(sp, p.x, p.z, sc, { stair: SH.stairHalf + 1.6, camp: CAMP_CLEAR, path: 3, sight: false })) {
      console.warn(`[trees] S2 hero ${sp} at stair (${s}, ${lat}) dropped: on the stairs, the summit or a path`);
      continue;
    }
    s2.push({ species: sp, x: p.x, z: p.z, y: ground(p.x, p.z, 0.6 * sc), scale: sc, rot: (rotDeg * Math.PI) / 180, hero: true, variant, tag: 'S2' });
  }
  for (const [shot, list] of Object.entries(FRAME_HEROES)) {
    const fr = frames[shot];
    if (!fr) continue;
    for (const [sp, th, D, sc, variant, rotDeg] of list) {
      const p = inFrame(fr, th, D);
      if (blocked(sp, p.x, p.z, sc, { stair: 5, camp: CAMP_CLEAR, path: 4 })) {
        console.warn(`[trees] ${shot} framing ${sp} at ${th}° / ${D} m dropped: in the water, on a path, the stairs, the summit, the camp or an S1 sight line`);
        continue;
      }
      s2.push({ species: sp, x: p.x, z: p.z, y: ground(p.x, p.z, 0.6 * sc), scale: sc, rot: (rotDeg * Math.PI) / 180, hero: true, variant, tag: shot });
    }
  }
  const clearOf = (t, pad) => s2.every((h) => Math.hypot(t.x - h.x, t.z - h.z) > (SPACING[h.species] || 4) * h.scale * 0.5 + pad);
  // Filtered after everything is planted, so no random stream moves:
  //   - the stair crowns taken out (S2_CLEAR for S2, S1_CREST_CLEAR for S1);
  //   - S1: the random crowns in front of the low sun (the S1 sky keeps its drawn disc and the core of its glow clear
  //     above the crest; the heroes stay, the S2 stair canopy sits below the lifted disc);
  //   - S4: the random crowns close behind the title's calligraphy and menu (a calm field under the logo)
  const gone = S2_CLEAR.concat(S1_CREST_CLEAR).map(([s, lat]) => stairPoint(s, lat));
  const inSun = frames.S1 ? s1SunWindow(frames.S1) : () => false;
  const behindLogo = (t) => {
    const fr = frames.S4;
    if (!fr) return false;
    const { along, lat } = frameCoords(fr, t.x, t.z);
    const ang = (Math.atan2(lat, along) * 180) / Math.PI;
    return along > 0 && along < 120 && ang > -24 && ang < -2;
  };
  const trees = out
    .filter((t) => clearOf(t, 0) && gone.every((g) => Math.hypot(t.x - g.x, t.z - g.z) > 1.5) && (t.hero || (!inSun(t) && !behindLogo(t))))
    .concat(s2);
  const kept = shrubs.filter((t) => t.hero || clearOf(t, -1));
  // the undergrowth on the stair banks is dark evergreen too (tones already drawn: nothing else changes)
  for (const t of kept) {
    const dx = t.x - SH.stairsBase.x, dz = t.z - SH.stairsBase.z;
    const s = dx * SH.stairDir.x + dz * SH.stairDir.z, lat = dx * SH.stairDir.z - dz * SH.stairDir.x;
    if (!t.hero && s > -6 && s < SL + 6 && Math.abs(lat) < 22) t.tone = 'dark';
  }
  return { trees, shrubs: kept, frames };
}

// Does a crown reach into the drawn S1 sun (the shot's sunLift and sunSize, as the sky draws it) and the core of its glow,
// as seen from the S1 camera? Crowns as spheres from DIMS (padded: the built variants are a little larger).
function s1SunWindow(frame) {
  const shot = SHOTS.S1_field, sky = shot.sky || {};
  const sun = drawnSunDir(sunDirection(shot.hours), sky.sunLift || 0);
  const win = 0.0082 * (sky.sunSize || 1) + (0.6 * Math.PI) / 180;
  return (t) => {
    const [h, cr, cf] = DIMS[t.species] || DIMS.maple;
    const dx = t.x - frame.x, dy = t.y + h * cf * t.scale - frame.y, dz = t.z - frame.z;
    const d = Math.hypot(dx, dy, dz);
    const ang = Math.acos(clamp((dx * sun.x + dy * sun.y + dz * sun.z) / d, -1, 1));
    return ang - Math.atan2(cr * 1.2 * t.scale, d) < win;
  };
}

// the ginkgo valley around the bandit camp: huge ginkgos in small groups, gold leaves everywhere
const GROVE = { x: 335, z: -85, r: 150 };
function inGrove(x, z) {
  return Math.hypot(x - GROVE.x, z - GROVE.z) < GROVE.r;
}

function pickTone(rand) {
  const r = rand();
  return r < 0.36 ? 'red' : r < 0.8 ? 'green' : 'yellow';
}

// Species by region (weights). Deciduous dominate; conifers are dark accents except on the coast/heights.
function pickSpecies(x, z, h, dsh, S, rand) {
  const dg = Math.hypot(x - POI.ginkgo.x, z - POI.ginkgo.z);
  const dc = Math.hypot(x - POI.camp.x, z - POI.camp.z);
  const red = S.noise(x * 0.0042 + 7.1, z * 0.0042 + 2.2); // stands of red maple vs mixed woods
  let w;
  if (dg < POI.ginkgo.r * 1.6 || dc < 150) w = { ginkgo: 0.62, maple: 0.36, pine: 0.02 };
  else if (dsh < SH.footRadius + 18) w = { maple: 0.56, cedar: 0.08, ginkgo: 0.1, pine: 0.26 };
  else if (x < -440) w = { pine: 0.6, maple: 0.38, cedar: 0.02 };
  else if (h > 130) w = { maple: 0.55, pine: 0.35, cedar: 0.1 };
  else w = { maple: 0.74 + 0.14 * red, ginkgo: 0.06, pine: 0.16, cedar: 0.03 };
  let tot = 0;
  for (const k in w) tot += Math.max(0, w[k]);
  let r = rand() * tot;
  for (const k in w) {
    r -= Math.max(0, w[k]);
    if (r <= 0) return k;
  }
  return 'maple';
}

// Litter / leaf-fall mask over the world (4 m texels): R maple litter, G ginkgo litter, B any tree nearby.
export function bakeLitterMask(records, variantsByKey, res = 512) {
  const data = new Float32Array(res * res * 3);
  const cell = WORLD.size / res;
  for (const r of records) {
    const v = variantsByKey(r);
    if (!v) continue;
    const ch = r.species === 'maple' ? 0 : r.species === 'ginkgo' ? 1 : -1;
    const rad = Math.max(3, v.radius * r.scale * (inGrove(r.x, r.z) ? 1.2 : 0.95));
    const cx = (r.x + WORLD.half) / cell, cz = (r.z + WORLD.half) / cell;
    const rr = rad / cell;
    const bR = rr * 2.2;
    for (let j = Math.max(0, Math.floor(cz - bR)); j <= Math.min(res - 1, Math.ceil(cz + bR)); j++)
      for (let i = Math.max(0, Math.floor(cx - bR)); i <= Math.min(res - 1, Math.ceil(cx + bR)); i++) {
        const d = Math.hypot(i + 0.5 - cx, j + 0.5 - cz) / rr;
        const o = (j * res + i) * 3;
        if (ch >= 0) data[o + ch] = Math.max(data[o + ch], 1 - smoothstep(0.6, 1.4, d));
        data[o + 2] = Math.max(data[o + 2], 1 - smoothstep(0.8, 2.2, d));
      }
  }
  // the whole ginkgo valley floor is carpeted gold (thinning toward its rim); on the grazed camp ground the
  // leaves lie scattered over green grass instead
  const HS = POI.camp.house, VW = POI.camp.view;
  const stairLen = Math.hypot(SH.stairsTop.x - SH.stairsBase.x, SH.stairsTop.z - SH.stairsBase.z);
  const ax = VW.x - HS.x, az = VW.z - HS.z, a2 = ax * ax + az * az;
  for (let j = 0; j < res; j++)
    for (let i = 0; i < res; i++) {
      const x = -WORLD.half + (i + 0.5) * cell, z = -WORLD.half + (j + 0.5) * cell;
      const g = 0.72 * (1 - smoothstep(GROVE.r * 0.55, GROVE.r * 1.05, Math.hypot(x - GROVE.x, z - GROVE.z)));
      const o = (j * res + i) * 3;
      if (g > data[o + 1]) data[o + 1] = g;
      // distance to the camp axis (house → viewpoint, a little beyond it)
      const t = clamp(((x - HS.x) * ax + (z - HS.z) * az) / a2, 0, 1.2);
      const lawn = 0.5 + 0.5 * smoothstep(16, 34, Math.hypot(x - HS.x - ax * t, z - HS.z - az * t));
      data[o] *= lawn;
      data[o + 1] *= lawn;
      // the banks of the shrine stairs: a dark forest floor with scattered leaves, not a lit carpet
      const sx = x - SH.stairsBase.x, sz = z - SH.stairsBase.z;
      const ss = sx * SH.stairDir.x + sz * SH.stairDir.z, sl = Math.abs(sx * SH.stairDir.z - sz * SH.stairDir.x);
      if (ss > -10 && ss < stairLen + 8 && sl < 26) {
        const bank = (1 - smoothstep(12, 26, sl)) * smoothstep(-10, 0, ss) * (1 - smoothstep(stairLen, stairLen + 8, ss));
        data[o] *= 1 - 0.7 * bank;
        data[o + 1] *= 1 - 0.7 * bank;
      }
    }
  const out = new Uint8Array(res * res * 4);
  for (let i = 0; i < res * res; i++) {
    out[i * 4] = Math.round(clamp(data[i * 3], 0, 1) * 255);
    out[i * 4 + 1] = Math.round(clamp(data[i * 3 + 1], 0, 1) * 255);
    out[i * 4 + 2] = Math.round(clamp(data[i * 3 + 2], 0, 1) * 255);
    out[i * 4 + 3] = 255;
  }
  return { data: out, res };
}
