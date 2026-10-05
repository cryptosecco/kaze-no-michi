// World layout of Hoshigashima. Meters, +X = east, -Z = north, Y up. World square [-1024, 1024]².
// Everything that places content (terrain shaping, props, quests) reads from here.

import { smoothPolyline } from '../core/math.js';

export const WORLD = { half: 1024, size: 2048 };

export const SEA = { level: 0 };

// Shrine hill geometry: a conical hill with a flat top; a straight stair corridor on the NE flank
// climbs toward the SW (i.e. toward the golden-hour sun).
const SHRINE_X = -260, SHRINE_Z = 180;
const stairDirRaw = { x: SHRINE_X - 0, z: SHRINE_Z - 0 }; // from spawn toward the shrine → climbing direction
const stairLen = Math.hypot(stairDirRaw.x, stairDirRaw.z);
const STAIR_DIR = { x: stairDirRaw.x / stairLen, z: stairDirRaw.z / stairLen }; // unit, points SW (uphill)
const TOP_RADIUS = 28; // flat summit radius
const STAIR_BASE_DIST = 96; // stairs start this far from the hill center (NE side)

// Bandit camp: the farmhouse front faces NNE (compass az 29.5°), away from the low western sun, so that the S5
// view — house from the front, backlit, the sun at the right edge of the frame — is the natural approach.
const CAMP_HOUSE = { x: 334, z: -66 };
const CAMP_FACING = 29.5;
const campAt = (d) => ({
  x: CAMP_HOUSE.x + Math.sin((CAMP_FACING * Math.PI) / 180) * d,
  z: CAMP_HOUSE.z - Math.cos((CAMP_FACING * Math.PI) / 180) * d,
});

// Camp local frame (the one src/world/props/camp.js builds in): origin at the house centre, +z from the
// viewpoint into the house (its back), +x to the left as seen from the viewpoint. Returns world { x, z }.
export function campLocal(lx, lz) {
  const f = (CAMP_FACING * Math.PI) / 180;
  const Zx = -Math.sin(f), Zz = Math.cos(f); // toward the back
  return { x: CAMP_HOUSE.x + Zz * lx + Zx * lz, z: CAMP_HOUSE.z - Zx * lx + Zz * lz };
}

export const POI = {
  spawn: { x: 0, z: 0 },
  field: { x: -60, z: 40, r: 260 },
  shrine: {
    x: SHRINE_X,
    z: SHRINE_Z,
    rise: 38, // summit height above the surrounding basin
    topRadius: TOP_RADIUS,
    footRadius: 118,
    stairDir: STAIR_DIR, // unit vector pointing uphill (SW)
    stairWidth: 4.2, // path-mask corridor of the stairs (TerrainGen: packed earth, no forest floor)
    stairHalf: 4.5, // half width of the stone steps (props/shrine.js): TerrainGen carves the ramp corridor for them
    stairsBase: { x: SHRINE_X - STAIR_DIR.x * STAIR_BASE_DIST, z: SHRINE_Z - STAIR_DIR.z * STAIR_BASE_DIST },
    stairsTop: { x: SHRINE_X - STAIR_DIR.x * (TOP_RADIUS - 2), z: SHRINE_Z - STAIR_DIR.z * (TOP_RADIUS - 2) },
  },
  // bandit camp (valley centre + clearing radius): farmhouse centre, the direction its front faces, the front
  // yard where the bandits keep their fire, and the viewpoint 36 m in front of the house (S5). The fire burns in
  // the open left of the yard, where the smoke rises just left of the samurai: clear of the hero ginkgo trunks behind
  // it in the S5 view and of the banner lines (scripts/camp.test.mjs)
  camp: { x: 320, z: -60, r: 60, house: CAMP_HOUSE, facing: CAMP_FACING, yard: campAt(12), view: campAt(36), fire: campLocal(11.2, -11) },
  ginkgo: { x: 360, z: -120, r: 80 },
  pagoda: { x: 40, z: -520 },
  cliff: { x: -620, z: 420 },
};

// Tree clearings of the camp: the props module removes the trees inside them once it is built, and the S5 hero
// ginkgos (trees/placement.js) are planted against the same list, so neither can silently delete the other.
// Circles { x, z, r } and capsules { x, z, x2, z2, r } (trunk position tested, as in trees.clear()).
export const CAMP_CLEARINGS = [
  { x: CAMP_HOUSE.x, z: CAMP_HOUSE.z, r: 10.5 }, // the roof footprint: the S5 ginkgos stand close around it
  { x: POI.camp.fire.x, z: POI.camp.fire.z, r: 8, keepLitter: true },
  { x: POI.camp.view.x, z: POI.camp.view.z, x2: CAMP_HOUSE.x, z2: CAMP_HOUSE.z, r: 6, keepLitter: true }, // S5 view
];

export function inClearing(x, z, shapes) {
  return shapes.some((c) => {
    if (c.x2 === undefined) return (x - c.x) ** 2 + (z - c.z) ** 2 < c.r * c.r;
    const ax = c.x2 - c.x, az = c.z2 - c.z;
    const t = Math.max(0, Math.min(1, ((x - c.x) * ax + (z - c.z) * az) / (ax * ax + az * az || 1)));
    return (x - c.x - ax * t) ** 2 + (z - c.z - az * t) ** 2 < c.r * c.r;
  });
}

// Dirt paths (raw control points, smoothed below). Width in meters.
const RAW_PATHS = [
  {
    name: 'spawn-shrine',
    width: 3.2,
    pts: [
      { x: 0, z: 0 },
      { x: -38, z: 22 },
      { x: -84, z: 58 },
      { x: -128, z: 88 },
      { x: -160, z: 108 },
      { x: POI.shrine.stairsBase.x + STAIR_DIR.x * -6, z: POI.shrine.stairsBase.z + STAIR_DIR.z * -6 },
    ],
  },
  {
    name: 'spawn-camp',
    width: 3.0,
    pts: [
      { x: 0, z: 0 },
      { x: 58, z: -8 },
      { x: 128, z: -34 },
      { x: 205, z: -40 },
      { x: 268, z: -58 },
      { x: 320, z: -60 },
    ],
  },
  {
    name: 'shrine-cliff',
    width: 2.6,
    pts: [
      { x: POI.shrine.stairsBase.x + STAIR_DIR.x * -6, z: POI.shrine.stairsBase.z + STAIR_DIR.z * -6 },
      { x: -205, z: 76 },
      { x: -272, z: 50 },
      { x: -352, z: 78 },
      { x: -412, z: 150 },
      { x: -470, z: 240 },
      { x: -540, z: 332 },
      { x: -600, z: 400 },
    ],
  },
  {
    name: 'spawn-pagoda',
    width: 2.6,
    pts: [
      { x: 0, z: 0 },
      { x: 14, z: -110 },
      { x: 28, z: -250 },
      { x: 30, z: -380 },
      { x: 40, z: -492 },
    ],
  },
];

// PATHS: array of smoothed {x,z} polylines, in order [spawn→shrine, spawn→camp, shrine→cliff, spawn→pagoda].
// PATH_INFO holds the matching name/width for each entry.
export const PATHS = RAW_PATHS.map((p) => smoothPolyline(p.pts, 10));
export const PATH_INFO = RAW_PATHS.map((p) => ({ name: p.name, width: p.width }));
