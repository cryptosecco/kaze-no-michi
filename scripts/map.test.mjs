// Tests for the pure logic of the pause screen's map (src/ui/mapModel.js): where the map goes on the screen, the frame
// and the projection, the heading convention, edge pinning, the terrain raster over the real terrain, the seeded waves,
// the label layout at three resolutions (run: npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerrainGen } from '../src/world/TerrainGen.js';
import { POI, PATHS, WORLD } from '../src/world/Layout.js';
import { QUESTS } from '../src/actors/quest/Quests.js';
import { rng } from '../src/core/math.js';
import { barPx } from '../src/ui/bars.js';
import {
  PLACES,
  COAST_X,
  MIN_ASPECT,
  MAX_ASPECT,
  MIN_BOX,
  inlineBox,
  pinInset,
  mapPoints,
  mapFrame,
  projection,
  headingDeg,
  pinToStage,
  nudgeSpots,
  scaleBar,
  nextObjective,
  placeLabels,
  pathObstacles,
  layoutPage,
  TITLE_MAX,
  splitTitle,
  edgeFade,
  terrainRaster,
  rasterJob,
  waveMarks,
  baseKey,
} from '../src/ui/mapModel.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------------------------------- frame
const ASPECTS = [1.2, 1.4, 1.56, 1.6, 1.75, MAX_ASPECT];

test('the frame holds every place (with its radius), every path point and some sea, at every panel aspect', () => {
  const pts = mapPoints();
  assert.ok(pts.length > PATHS.reduce((n, p) => n + p.length, 0), 'places and paths are all in');
  for (const aspect of ASPECTS) {
    const f = mapFrame(pts, aspect);
    for (const p of pts) {
      const r = p.r || 0;
      assert.ok(p.x - r >= f.x0 + 40 && p.x + r <= f.x0 + f.w - 40, `x of (${p.x}, ${p.z}) r${r} at ${aspect}`);
      assert.ok(p.z - r >= f.z0 + 40 && p.z + r <= f.z0 + f.h - 40, `z of (${p.x}, ${p.z}) r${r} at ${aspect}`);
    }
    // the coast and a stretch of sea on the west
    assert.ok(f.x0 <= COAST_X - 100, `sea in the frame at ${aspect}`);
  }
});

test('the frame has the panel aspect and stays inside the world square', () => {
  for (const aspect of [0.9, 1, ...ASPECTS]) {
    const f = mapFrame(mapPoints(), aspect);
    assert.ok(near(f.w / f.h, aspect, 1e-9), `aspect ${aspect}: ${f.w / f.h}`);
    assert.ok(f.x0 >= -WORLD.half - 1e-9 && f.x0 + f.w <= WORLD.half + 1e-9, `x inside at ${aspect}`);
    assert.ok(f.z0 >= -WORLD.half - 1e-9 && f.z0 + f.h <= WORLD.half + 1e-9, `z inside at ${aspect}`);
  }
  // a tall panel still holds the points: the world's side is the limit, the margin gives way
  const tall = mapFrame(mapPoints(), 0.9);
  for (const p of mapPoints()) assert.ok(p.x >= tall.x0 && p.x <= tall.x0 + tall.w && p.z >= tall.z0 && p.z <= tall.z0 + tall.h);
});

test('the frame is a pure function of its inputs', () => {
  assert.deepEqual(mapFrame(mapPoints(), 1.6), mapFrame(mapPoints(), 1.6));
  // a point beyond the box widens it
  const base = mapFrame([{ x: 0, z: 0, r: 0 }], 1.5), wide = mapFrame([{ x: 0, z: 0, r: 0 }, { x: 400, z: 0, r: 0 }], 1.5);
  assert.ok(wide.w > base.w);
});

test('world ↔ map: the round trip, the corners, north up and east right', () => {
  const f = mapFrame(mapPoints(), 1.6);
  const W = 1276, H = Math.round(W / 1.6);
  const proj = projection(f, W, H);
  for (const [x, z] of [[0, 0], [-260, 180], [340, -76], [-620, 420], [40, -520], [-900, 300]]) {
    const [px, py] = proj.toPx(x, z);
    const [bx, bz] = proj.toWorld(px, py);
    assert.ok(near(bx, x, 1e-6) && near(bz, z, 1e-6), `round trip of (${x}, ${z})`);
  }
  const [nx, ny] = proj.toPx(f.x0, f.z0), [sx, sy] = proj.toPx(f.x0 + f.w, f.z0 + f.h);
  assert.ok(near(nx, 0) && near(ny, 0) && near(sx, W) && near(sy, H), 'the frame fills the stage');
  assert.ok(proj.toPx(0, -100)[1] < proj.toPx(0, 100)[1], 'north (−z) is up');
  assert.ok(proj.toPx(100, 0)[0] > proj.toPx(-100, 0)[0], 'east (+x) is right');
  assert.ok(near(proj.scale, W / f.w));
});

// ---------------------------------------------------------------------------------------------------- on the screen
const clearance = (a, b) => {
  // the gap between two boxes { x0, y0, x1, y1 } (0 when they touch or overlap)
  const dx = Math.max(0, b.x0 - a.x1, a.x0 - b.x1), dy = Math.max(0, b.y0 - a.y1, a.y0 - b.y1);
  return Math.hypot(dx, dy);
};
const boxOf = (b) => ({ x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h });
const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// The pause screen at any window, from the rules of styles.css (.kz-col, .kz-item, .kz-side, .kz-legend), sized like the
// game measures them: the menu column (logo, romaji, four entries, its widest label), the objective (one more line
// where its box is narrow) and the controls hint (its rows wrap on a narrow window).
function pauseScreen(width, height, letterbox = 1) {
  const left = clampN(width * 0.072, 40, 150), top = clampN(height * 0.15, 80, 190);
  const font = clampN(width * 0.0145, 21, 27), item = clampN(height * 0.05, 44, 56);
  const menu = { x0: left, y0: top, x1: left + 299 + 7.17 * (font - 21), y1: top + 138.4 + 4 * item };
  const right = clampN(width * 0.07, 40, 150), sw = Math.min(560, width * 0.4);
  const side = { x0: width - right - sw, y0: top, x1: width - right, y1: top + 100 + (sw < 390 ? 25 : 0) };
  const rows = Math.ceil(1450 / (width - left - right)), lh = rows * 17 + (rows - 1) * 10;
  const bottom = clampN(height * 0.05, 28, 58);
  const legend = { x0: left, y0: height - bottom - lh, x1: width - right, y1: height - bottom };
  return { width, height, bar: barPx(letterbox, width, height), menu, side, legend };
}

test('on the screen: at the three test windows the map takes the box the game drew, in the room the screen leaves', () => {
  for (const [res, st] of Object.entries(STAGES)) {
    if (!st.screen) continue;
    const { box, ...screen } = st.screen;
    assert.deepEqual(inlineBox(screen), box, `${res}: the box the game drew`);
    const b = boxOf(box);
    assert.ok(b.x0 >= screen.menu.x1 + 28, `${res}: right of the menu`);
    assert.ok(b.y0 >= screen.side.y1 + 16, `${res}: below the objective`);
    assert.ok(b.y1 <= screen.legend.y0 - 12, `${res}: above the controls hint`);
    assert.ok(b.y0 >= screen.bar && b.y1 <= screen.height - screen.bar, `${res}: between the letterbox's bars`);
    assert.ok(b.x1 <= screen.width - 20, `${res}: inside the window`);
    assert.ok(near(box.w / box.h, MAX_ASPECT, 0.01), `${res}: as wide as the map goes (${box.w / box.h})`);
  }
  // and the screens the model of the pause screen builds are those measured ones, near enough to hold the same map
  for (const [res, st] of Object.entries(STAGES)) {
    if (!st.screen) continue;
    const b = inlineBox(pauseScreen(st.screen.width, st.screen.height));
    assert.ok(b && Math.abs(b.w - st.w) <= 8 && Math.abs(b.h - st.h) <= 8 && Math.abs(b.x - st.screen.box.x) <= 8 && Math.abs(b.y - st.screen.box.y) <= 8, `${res}: the model's box ${JSON.stringify(b)}`);
  }
});

test('on the screen: at any window the map is clear of the menu, the objective, the hint and the bars, or not shown', () => {
  let shown = 0, n = 0;
  for (const letterbox of [1, 0]) {
    for (let width = 640; width <= 3840; width += 64) {
      for (let height = 400; height <= 2160; height += 40) {
        const s = pauseScreen(width, height, letterbox);
        const box = inlineBox(s);
        n++;
        if (!box) continue;
        shown++;
        const what = `${width}x${height}${letterbox ? '' : ' without the letterbox'}`;
        const b = boxOf(box);
        assert.ok([box.x, box.y, box.w, box.h].every(Number.isInteger), `${what}: whole pixels`);
        assert.ok(b.x0 >= 0 && b.x1 <= width && b.y0 >= s.bar && b.y1 <= height - s.bar, `${what}: inside the picture`);
        for (const k of ['menu', 'side', 'legend']) assert.ok(clearance(b, s[k]) >= 12, `${what}: clear of the ${k} (${clearance(b, s[k])})`);
        assert.ok(box.w / box.h >= MIN_ASPECT - 0.01 && box.w / box.h <= MAX_ASPECT + 0.01, `${what}: aspect ${box.w / box.h}`);
        assert.ok(box.w >= MIN_BOX.w && box.h >= MIN_BOX.h, `${what}: big enough to be read`);
      }
    }
  }
  assert.ok(shown > n * 0.5, `the map is on most screens (${shown} of ${n})`);
  // the common windows have it; a window too small for it does not
  for (const [w, h] of [[1024, 640], [1280, 720], [1366, 768], [1440, 900], [1920, 1080], [2560, 1440], [3840, 2160]]) assert.ok(inlineBox(pauseScreen(w, h)), `${w}x${h} shows the map`);
  for (const [w, h] of [[640, 400], [800, 500], [900, 520], [1024, 480], [700, 900]]) assert.equal(inlineBox(pauseScreen(w, h)), null, `${w}x${h} shows no map`);
});

test('on the screen: the box is the room\'s height against its right side; a narrow room gives a shorter box, centred', () => {
  const at = (menuRight, sideBottom, legendTop, width = 1600, height = 1000, bar = 0) =>
    inlineBox({ width, height, bar, menu: { x0: 0, y0: 0, x1: menuRight, y1: 400 }, side: { x0: 1000, y0: 100, x1: 1500, y1: sideBottom }, legend: { x0: 0, y0: legendTop, x1: width, y1: legendTop + 20 } });
  // a wide room: as tall as it, MAX_ASPECT wide, against its right side
  const wide = at(300, 200, 950);
  const top = Math.ceil(200 + clampN(1000 * 0.03, 16, 40)), bottom = Math.floor(950 - clampN(1000 * 0.022, 12, 32));
  const rightEdge = Math.floor(1600 - clampN(1600 * 0.03, 20, 64));
  assert.equal(wide.y, top);
  assert.equal(wide.h, bottom - top);
  assert.equal(wide.x + wide.w, rightEdge, 'against the right side');
  assert.equal(wide.w, Math.floor(wide.h * MAX_ASPECT));
  // a narrow room: its whole width, MIN_ASPECT tall at most, centred between the objective and the hint
  const narrow = at(1000, 200, 950);
  assert.equal(narrow.x + narrow.w, rightEdge);
  assert.equal(narrow.h, Math.floor(narrow.w / MIN_ASPECT));
  assert.ok(Math.abs(narrow.y - top - (bottom - narrow.y - narrow.h)) <= 1, 'centred');
  // the bars bound it too, and so does a missing element's absence
  const barred = at(300, 200, 950, 1600, 1000, 300);
  assert.ok(barred.y >= 300 && barred.y + barred.h <= 700);
  assert.ok(inlineBox({ width: 1600, height: 1000 }).w > wide.w, 'with nothing on the screen it has more room');
  // too small: none
  assert.equal(at(1100, 200, 950), null, 'a room narrower than the smallest map');
  assert.equal(at(300, 700, 950), null, 'a room lower than the smallest map');
  assert.equal(inlineBox({ width: 0, height: 0 }), null, 'a window with no size');
});

test('pin inset: a share of the map\'s short side', () => {
  assert.equal(pinInset(1012, 633), 57);
  assert.equal(pinInset(622, 389), 35);
  assert.ok(pinInset(2000, 600) === pinInset(600, 2000));
});

// ---------------------------------------------------------------------------------------------------- markers
test('heading: an arrow drawn pointing up turns to where the character looks (yaw 0 faces south, π/2 east)', () => {
  // CSS rotate(θ) turns clockwise on a screen whose y grows downward: (0, −1) → (sin θ, −cos θ)
  const arrow = (yaw) => {
    const th = (headingDeg(yaw) * Math.PI) / 180;
    return [Math.sin(th), -Math.cos(th)];
  };
  const cases = [
    [0, [0, 1], 'south: down'],
    [Math.PI / 2, [1, 0], 'east: right'],
    [Math.PI, [0, -1], 'north: up'],
    [-Math.PI / 2, [-1, 0], 'west: left'],
  ];
  for (const [yaw, [ex, ey], what] of cases) {
    const [ax, ay] = arrow(yaw);
    assert.ok(near(ax, ex, 1e-9) && near(ay, ey, 1e-9), `${what}: (${ax}, ${ay})`);
  }
  assert.equal(headingDeg(0), 180);
  assert.ok(near(headingDeg(Math.PI / 2), 90));
  // for any yaw it matches the actor's forward (sin yaw, cos yaw) in (x, z) = (right, down) on the north-up map
  for (let k = -9; k <= 9; k++) {
    const yaw = k * 0.37, [ax, ay] = arrow(yaw);
    assert.ok(near(ax, Math.sin(yaw), 1e-9) && near(ay, Math.cos(yaw), 1e-9), `yaw ${yaw}`);
  }
  for (const yaw of [-7, -0.3, 0, 2.2, 9]) {
    const d = headingDeg(yaw);
    assert.ok(d >= 0 && d < 360);
  }
});

test('edge pinning: inside is left alone, outside lands on the inset border along the bearing from the centre', () => {
  const W = 800, H = 500, inset = 20;
  const inside = pinToStage(400, 250, W, H, inset);
  assert.deepEqual(inside, { x: 400, y: 250, pinned: false });
  const onBorder = pinToStage(inset, H - inset, W, H, inset);
  assert.equal(onBorder.pinned, false);
  // east
  let p = pinToStage(2000, 250, W, H, inset);
  assert.ok(p.pinned && near(p.x, W - inset) && near(p.y, 250));
  // north-west, far: on the border, same direction as the true position seen from the centre
  p = pinToStage(-3000, -1000, W, H, inset);
  assert.ok(p.pinned);
  const dx = p.x - W / 2, dy = p.y - H / 2;
  assert.ok(near(dx / dy, (-3000 - W / 2) / (-1000 - H / 2), 1e-9), 'the bearing is kept');
  assert.ok(near(Math.max(Math.abs(dx) - (W / 2 - inset), Math.abs(dy) - (H / 2 - inset)), 0, 1e-9), 'on the inset rectangle');
  assert.ok(p.x >= inset - 1e-9 && p.x <= W - inset + 1e-9 && p.y >= inset - 1e-9 && p.y <= H - inset + 1e-9);
  // south, a little outside
  p = pinToStage(400, H + 50, W, H, inset);
  assert.ok(p.pinned && near(p.y, H - inset) && near(p.x, 400));
});

// the best spot of nudgeSpots(): where the marker goes
const nudge = (anchor, p, minDist, opts) => nudgeSpots(anchor, p, minDist, opts)[0];

test('two markers closer than their sizes are slid apart; the rest are left alone', () => {
  const a = { x: 100, y: 100 };
  assert.deepEqual(nudgeSpots(a, { x: 300, y: 100 }, 30), [{ x: 300, y: 100 }], 'clear of the anchor: one spot, where it is');
  const p = nudge(a, { x: 103, y: 104 }, 30);
  assert.ok(near(Math.hypot(p.x - a.x, p.y - a.y), 30, 1e-9));
  assert.ok(near((p.y - a.y) / (p.x - a.x), 4 / 3, 1e-9), 'along the line between them');
  const q = nudge(a, { x: 100, y: 100 }, 30, { hint: { x: 1, y: 0 } });
  assert.ok(near(q.x, 130) && near(q.y, 100), 'on top of each other: the hint gives the way');
});

test('a marker slid apart stays inside the bounds: beside an anchor on the border it goes round it', () => {
  const bounds = { x0: 20, y0: 20, x1: 780, y1: 480 };
  const R = 30, dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  // the anchor on the east border, the marker right beside it (a few px east, as a pinned horse is): straight out is off the stage
  const east = { x: 780, y: 240 };
  const out = nudge(east, { x: 783, y: 240 }, R, { bounds });
  assert.ok(out.x <= bounds.x1 + 1e-6, `the marker is on the stage (${out.x})`);
  assert.ok(near(dist(east, out), R, 1e-6), 'and a full distance from the anchor');
  assert.ok(out.y !== east.y || out.x < east.x, 'round him: north, south or inward');
  // every spot is inside the bounds, a full distance from the anchor, and they come in order of the turn from straight out
  for (const [anchor, p] of [[east, { x: 790, y: 250 }], [{ x: 780, y: 480 }, { x: 790, y: 490 }], [{ x: 20, y: 20 }, { x: 22, y: 21 }], [{ x: 400, y: 480 }, { x: 405, y: 481 }]]) {
    const spots = nudgeSpots(anchor, p, R, { bounds });
    assert.ok(spots.length >= 6, `${spots.length} spots`);
    let last = -1;
    for (const sp of spots) {
      assert.ok(sp.x >= bounds.x0 - 1e-6 && sp.x <= bounds.x1 + 1e-6 && sp.y >= bounds.y0 - 1e-6 && sp.y <= bounds.y1 + 1e-6, `(${sp.x}, ${sp.y}) is inside`);
      assert.ok(near(dist(anchor, sp), R, 1e-6));
      const straight = Math.atan2(p.y - anchor.y, p.x - anchor.x);
      const turn = Math.abs(Math.atan2(Math.sin(Math.atan2(sp.y - anchor.y, sp.x - anchor.x) - straight), Math.cos(Math.atan2(sp.y - anchor.y, sp.x - anchor.x) - straight)));
      assert.ok(turn >= last - 1e-9, 'the less the turn the better');
      last = turn;
    }
  }
  // in the south-east corner every spot is toward the middle
  for (const sp of nudgeSpots({ x: 780, y: 480 }, { x: 790, y: 490 }, R, { bounds })) assert.ok(sp.x <= 780 + 1e-6 && sp.y <= 480 + 1e-6);
  // of two spots as near the straight way, the one toward the middle of the stage comes first: an anchor in the upper half of the east border
  assert.ok(nudge({ x: 780, y: 100 }, { x: 785, y: 100 }, R, { bounds }).y > 100, 'south, toward the middle, not north');
  assert.ok(nudge({ x: 780, y: 400 }, { x: 785, y: 400 }, R, { bounds }).y < 400, 'and from the lower half, north');
  // without bounds there is the straight way only; with bounds too small for the distance, the nearest point of them
  assert.equal(nudgeSpots(east, { x: 783, y: 240 }, R).length, 1);
  const tiny = nudge({ x: 50, y: 50 }, { x: 51, y: 50 }, 500, { bounds: { x0: 40, y0: 40, x1: 60, y1: 60 } });
  assert.ok(tiny.x >= 40 && tiny.x <= 60 && tiny.y >= 40 && tiny.y <= 60);
});

test('the scale bar is a round length that fits', () => {
  for (const pxPerM of [0.1, 0.3, 0.41, 0.65, 1, 2]) {
    const s = scaleBar(pxPerM);
    assert.ok([50, 100, 200, 500, 1000].includes(s.meters));
    assert.ok(near(s.px, s.meters * pxPerM));
    if (pxPerM >= 0.3) assert.ok(s.px <= 190 + 1e-9, `${pxPerM}: ${s.px}`);
  }
  assert.equal(scaleBar(0.65).meters, 200);
  assert.equal(scaleBar(0.41).meters, 200);
  assert.equal(scaleBar(0.1).meters, 1000);
});

test('the objective follows the quest events: set by an update, gone when the quest completes and after the ending', () => {
  let o = null;
  o = nextObjective(o, 'quest:update', { id: 'shrine', title: 'La via del vento', target: { x: -260, z: 180 } });
  assert.deepEqual(o, { id: 'shrine', title: 'La via del vento', target: { x: -260, z: 180 } });
  assert.equal(nextObjective(o, 'something:else', {}), o);
  assert.equal(nextObjective(o, 'quest:complete', { id: 'shrine' }), null);
  o = nextObjective(null, 'quest:update', { id: 'cliff', title: 'Il tramonto sulla scogliera', target: { x: -620, z: 420 } });
  assert.equal(nextObjective(o, 'ending', {}), null);
  assert.equal(nextObjective(o, 'quest:update', { id: 'x', title: 'no target' }), null);
  assert.equal(nextObjective(o, 'quest:update', undefined), null);
});

// ---------------------------------------------------------------------------------------------------- raster
const terrain = new TerrainGen(1234).generate();
const RW = 400, RH = 250;
const frame = mapFrame(mapPoints(), RW / RH);
const proj = projection(frame, RW, RH);
const raster = terrainRaster(terrain, frame, RW, RH);
const pixel = (x, z, r = raster) => {
  const [px, py] = proj.toPx(x, z);
  return Math.min(r.height - 1, Math.max(0, Math.floor(py))) * r.width + Math.min(r.width - 1, Math.max(0, Math.floor(px)));
};

test('the raster has the requested size and is bone ink with only the alpha varying', () => {
  assert.equal(raster.width, RW);
  assert.equal(raster.height, RH);
  assert.equal(raster.rgba.length, RW * RH * 4);
  assert.equal(raster.sea.length, RW * RH);
  for (let i = 0; i < RW * RH; i += 97) {
    assert.deepEqual([raster.rgba[i * 4], raster.rgba[i * 4 + 1], raster.rgba[i * 4 + 2]], [242, 233, 216]);
  }
});

test('the raster is deterministic: the same bytes every time, and the generator gives the same ones', () => {
  const again = terrainRaster(terrain, mapFrame(mapPoints(), RW / RH), RW, RH);
  assert.ok(Buffer.from(again.rgba.buffer).equals(Buffer.from(raster.rgba.buffer)));
  assert.ok(Buffer.from(again.sea.buffer).equals(Buffer.from(raster.sea.buffer)));
  const job = rasterJob(terrain, frame, RW, RH);
  let slices = 0, r = job.next();
  while (!r.done) {
    slices++;
    r = job.next();
  }
  assert.ok(slices >= 4, `the work is cut into slices (${slices})`);
  assert.ok(Buffer.from(r.value.rgba.buffer).equals(Buffer.from(raster.rgba.buffer)));
});

test('the sea is empty, the land is washed: transparent far in the west, land at the spawn', () => {
  for (const [x, z] of [[-1000, 0], [-850, 0], [-850, 300], [-800, -200]]) {
    const i = pixel(x, z);
    assert.equal(raster.sea[i], 1, `(${x}, ${z}) is sea`);
    assert.equal(raster.rgba[i * 4 + 3], 0, `(${x}, ${z}) is transparent`);
  }
  for (const [x, z] of [[0, 0], [-260, 180], [320, -60]]) {
    const i = pixel(x, z);
    assert.equal(raster.sea[i], 0, `(${x}, ${z}) is land`);
    assert.ok(raster.rgba[i * 4 + 3] >= 12, `(${x}, ${z}) is washed (${raster.rgba[i * 4 + 3]})`);
  }
});

test('the coast is the brightest line: where the sea ends the ink is nearly opaque', () => {
  // walk east along the spawn's row from the sea to the first land pixel
  const row = Math.floor(proj.toPx(0, 0)[1]);
  let x = 0;
  while (x < RW && raster.sea[row * RW + x] === 0) x++; // skip the faded margin if any
  while (x < RW && raster.sea[row * RW + x] === 1) x++;
  assert.ok(x < RW, 'a coast exists on the row');
  let best = 0;
  for (let k = x - 3; k <= x + 3; k++) best = Math.max(best, raster.rgba[(row * RW + k) * 4 + 3]);
  assert.ok(best >= 0.7 * 255, `the shore's alpha ${best}`);
  // brighter than the wash a little inland
  assert.ok(best > raster.rgba[(row * RW + x + 25) * 4 + 3]);
});

test('the raster fades to nothing at the border of its area, and is full in the middle', () => {
  assert.ok(near(edgeFade(0.5, 0.5), 1));
  assert.equal(edgeFade(0, 0.5), 0);
  assert.equal(edgeFade(1, 0.5), 0);
  assert.equal(edgeFade(0.5, 0), 0);
  assert.equal(edgeFade(0.02, 0.02), 0);
  assert.ok(edgeFade(0.9, 0.5) < edgeFade(0.8, 0.5));
  for (let x = 0; x < RW; x++) {
    for (const y of [0, RH - 1]) assert.equal(raster.rgba[(y * RW + x) * 4 + 3], 0, `top/bottom row at ${x}`);
  }
  for (let y = 0; y < RH; y++) {
    for (const x of [0, RW - 1]) assert.equal(raster.rgba[(y * RW + x) * 4 + 3], 0, `left/right column at ${y}`);
  }
});

test('the height is in the tone: high ground is washed brighter than the low meadow', () => {
  // over the stage, away from the fade at its border: the land above 60 m against the land below 20 m
  let lo = 0, nLo = 0, hi = 0, nHi = 0;
  for (let y = 0; y < RH; y++) {
    for (let x = 0; x < RW; x++) {
      const fade = edgeFade((x + 0.5) / RW, (y + 0.5) / RH);
      if (fade < 0.6) continue;
      const [wx, wz] = proj.toWorld(x + 0.5, y + 0.5);
      const h = terrain.heightAt(wx, wz);
      const a = raster.rgba[(y * RW + x) * 4 + 3] / fade;
      if (h >= 3 && h < 20) (lo += a), nLo++;
      else if (h > 60) (hi += a), nHi++;
    }
  }
  assert.ok(nLo > 500 && nHi > 500, `samples: ${nLo} low, ${nHi} high`);
  assert.ok(hi / nHi > (lo / nLo) * 1.5, `high ${(hi / nHi).toFixed(1)} vs low ${(lo / nLo).toFixed(1)}`);
});

test('the forest is stippled: it adds fine dots to the wash where the wood is thick, none in the open', () => {
  const N = 1025;
  let wood = 0, nWood = 0, open = 0, nOpen = 0;
  const plain = (i) => raster.rgba[i * 4 + 3];
  for (let y = 50; y < RH - 50; y++) {
    for (let x = 90; x < RW - 50; x++) {
      const [wx, wz] = proj.toWorld(x + 0.5, y + 0.5);
      const gi = Math.round((wx + WORLD.half) / 2), gj = Math.round((wz + WORLD.half) / 2);
      const f = terrain.surf[(gj * N + gi) * 4 + 1] / 255;
      if (raster.sea[y * RW + x]) continue;
      // the dots are single pixels brighter than both neighbours to the left and right
      const dot = plain(y * RW + x) > plain(y * RW + x - 1) + 40 && plain(y * RW + x) > plain(y * RW + x + 1) + 40 ? 1 : 0;
      if (f > 0.8) (wood += dot), nWood++;
      else if (f < 0.02) (open += dot), nOpen++;
    }
  }
  assert.ok(nWood > 500 && nOpen > 500, `samples: ${nWood} wood, ${nOpen} open`);
  assert.ok(wood / nWood > 0.02, `dots in the wood: ${(wood / nWood).toFixed(3)}`);
  assert.ok(wood / nWood > 4 * (open / nOpen + 1e-4), `wood ${(wood / nWood).toFixed(3)} vs open ${(open / nOpen).toFixed(4)}`);
});

test('a different size or frame gives a different base key; the same gives the same', () => {
  assert.equal(baseKey(frame, 800, 500, 1), baseKey({ ...frame }, 800, 500, 1));
  assert.notEqual(baseKey(frame, 800, 500, 1), baseKey(frame, 800, 500, 2));
  assert.notEqual(baseKey(frame, 800, 500, 1), baseKey(frame, 801, 500, 1));
  assert.notEqual(baseKey(frame, 800, 500, 1), baseKey({ ...frame, x0: frame.x0 + 1 }, 800, 500, 1));
});

// ---------------------------------------------------------------------------------------------------- waves
test('the waves are seeded, deterministic, and all over the sea', () => {
  const big = terrainRaster(terrain, mapFrame(mapPoints(), 1.6), 800, 500);
  const marks = waveMarks({ width: 800, height: 500, dpr: 1, sea: big.sea });
  assert.ok(marks.length >= 8, `${marks.length} marks`);
  assert.deepEqual(marks, waveMarks({ width: 800, height: 500, dpr: 1, sea: big.sea }));
  assert.notDeepEqual(marks, waveMarks({ seed: 6, width: 800, height: 500, dpr: 1, sea: big.sea }));
  for (const m of marks) {
    for (const k of [0, 0.5, 1]) {
      const x = Math.round(m.x + m.len * k), y = Math.round(m.y);
      assert.equal(big.sea[y * 800 + x], 1, `a wave stays in the sea (${x}, ${y})`);
    }
    assert.ok(m.a > 0 && m.a < 0.3 && m.len > 8 && m.amp > 0);
  }
});

// ---------------------------------------------------------------------------------------------------- labels
test('labels: two that want the same spot do not overlap, and a label avoids a marker', () => {
  const bounds = { x0: 0, y0: 0, x1: 400, y1: 300 };
  const items = [
    { id: 'a', x: 100, y: 100, r: 10, w: 90, h: 16 },
    { id: 'b', x: 110, y: 104, r: 10, w: 90, h: 16 },
  ];
  const out = placeLabels(items, [{ x: 100, y: 100, r: 10 }, { x: 110, y: 104, r: 10 }], bounds);
  const A = out.a, B = out.b;
  assert.ok(A.free && B.free);
  assert.ok(!(A.x < B.x + 90 && B.x < A.x + 90 && A.y < B.y + 16 && B.y < A.y + 16), 'a and b are apart');
  // a marker sitting where the first choice would be pushes the label to another side
  const moved = placeLabels([items[0]], [{ x: 100, y: 100, r: 10 }, { x: 140, y: 100, r: 12 }], bounds);
  assert.notEqual(moved.a.side, 'e');
  // the corner of the stage keeps a label inside it
  const edge = placeLabels([{ id: 'c', x: 395, y: 5, r: 8, w: 80, h: 16 }], [], bounds);
  assert.ok(edge.c.x >= 0 && edge.c.y >= 0 && edge.c.x + 80 <= 400 && edge.c.y + 16 <= 300);
  // a soft obstacle is avoided when a close spot clears it, and given up when none does
  const soft = [{ x: 140, y: 100, r: 20, soft: true }];
  assert.notEqual(placeLabels([items[0]], soft, bounds).a.side, 'e');
  const boxed = placeLabels([{ id: 'd', x: 100, y: 100, r: 10, w: 90, h: 16 }], [{ x: 100, y: 100, r: 400, soft: true }], { x0: 0, y0: 0, x1: 400, y1: 300 });
  assert.ok(boxed.d.free, 'only hard obstacles make a spot not free');
});

test('labels: boxes already on the stage are kept clear of, and an optional label with no room is left out', () => {
  const bounds = { x0: 0, y0: 0, x1: 400, y1: 300 };
  const item = { id: 'a', x: 100, y: 100, r: 10, w: 90, h: 16 };
  // a label already standing where the first choice (east of the marker) would be
  const fixed = [{ x0: 116, y0: 90, x1: 220, y1: 110 }];
  const around = placeLabels([item], [], bounds, { fixed });
  assert.ok(around.a.free && around.a.side !== 'e');
  const clear = around.a.x >= 220 + 9 || around.a.x + 90 <= 116 - 9 || around.a.y >= 110 + 9 || around.a.y + 16 <= 90 - 9;
  assert.ok(clear, 'clear of the fixed one');
  assert.equal(placeLabels([item], [], bounds).a.side, 'e', 'and east, where the fixed one stood, without it');
  // a marker walled in on every side: a plain label goes over something (free: false), an optional one is left out
  const walls = [{ x: 100, y: 100, r: 300 }];
  const plain = placeLabels([item], walls, bounds);
  assert.equal(plain.a.free, false);
  assert.equal(plain.a.hidden, undefined);
  const optional = placeLabels([{ ...item, optional: true }], walls, bounds);
  assert.equal(optional.a.free, false);
  assert.equal(optional.a.hidden, true);
  // a label left out takes no room: the one after it has its first choice (one too wide for the stage can never be placed)
  const next = placeLabels([{ ...item, id: 'big', w: 500, optional: true }, { ...item, id: 'b' }], [], bounds);
  assert.equal(next.big.hidden, true);
  assert.ok(next.b.free && next.b.side === 'e' && near(next.b.x, 116), `b at ${next.b.side} ${next.b.x}`);
  // and an optional label that finds room is placed like any other
  assert.deepEqual(placeLabels([{ ...item, optional: true }], [], bounds), placeLabels([item], [], bounds));
});

test('a long title goes on two lines, broken where they come out most even; one word stays whole', () => {
  assert.deepEqual(splitTitle('Il tramonto sulla scogliera'), ['Il tramonto', 'sulla scogliera']);
  assert.deepEqual(splitTitle('La via del vento'), ['La via', 'del vento']);
  assert.deepEqual(splitTitle('  Kaze  '), ['Kaze']);
  for (const q of QUESTS) {
    const lines = splitTitle(q.title);
    assert.equal(lines.join(' '), q.title.trim().split(/\s+/).join(' '), `${q.title}: every word, in order`);
    if (lines.length === 2) assert.ok(Math.max(...lines.map((l) => l.length)) < q.title.length, `${q.title}: shorter lines`);
  }
});

test('a marker off the map is pinned at the inset asked for, and the place under the ring may give its label way', () => {
  const st = STAGES['1024x640'];
  const pr = projection(mapFrame(mapPoints(), st.w / st.h), st.w, st.h);
  const labels = Object.fromEntries(Object.entries(st.labels).map(([k, [w, h]]) => [k, { w, h }]));
  const base = { proj: pr, width: st.w, height: st.h, sizes: { ...st.r, labels: { ...labels, obj: { w: 120, h: 36 } } }, boxes: [] };
  for (const inset of [0, 40, 80]) {
    const p = layoutPage({ ...base, inset, you: { x: 2000, z: 0, yaw: 0 }, horse: null, objective: null });
    assert.ok(p.you.pinned && near(p.you.x, st.w - Math.max(14, st.r.you * 1.4, inset), 1e-9), `pinned ${inset} px in: ${p.you.x}`);
  }
  // the objective on the cliff: the cliff's label is optional (the title names it), every other place's is not. The
  // layout the game drew at 1024x640: the samurai between the shrine and the cliff, the horse at the start
  const q = QUEST.find((k) => /scogliera/.test(k.title));
  const sit = { you: { x: -464, z: 216, yaw: 0 }, horse: { x: 4.6, z: 5.2 } };
  const { page, labels: L } = pageAt(st, pr, sit, q);
  assert.ok(page.labels.cliff.hidden, 'with no room beside the ring the cliff gives its label way');
  assert.ok(Object.entries(page.labels).every(([id, s]) => id === 'cliff' || !s.hidden), 'and no other label does');
  assertClear(st, page, L, 'the objective on the cliff');
  const free = pageAt(st, pr, { you: null, horse: null }, q).page;
  assert.ok(!free.labels.cliff.hidden, 'with room it keeps it');
});

test('path dots make soft obstacles along the polylines', () => {
  const f = mapFrame(mapPoints(), 1.6);
  const p = projection(f, 1000, 625);
  const dots = pathObstacles(PATHS, p, { step: 12, r: 4 });
  assert.ok(dots.length > 50 && dots.every((d) => d.soft && d.r === 4));
  // every path's first point is covered
  const [sx, sy] = p.toPx(PATHS[0][0].x, PATHS[0][0].z);
  assert.ok(dots.some((d) => Math.hypot(d.x - sx, d.y - sy) < 1e-6));
});

// The map at the three test resolutions as the pause screen lays it out (src/ui/MapPanel.js), in CSS pixels. Measured in
// the game, in Italian (the longer language), on the first quest, with the letterbox on (the default):
//   screen   what inlineBox() reads there: the window, a letterbox bar, the logo and menu column, the objective and the
//            controls hint; and the map's box the game drew
//   w, h     the map's size, from that box; inset its pin inset (pinInset)
//   r        the radii of the markers; labels, the size of each label; obj, the objective's label by its title
//   boxes    the north mark and the scale bar, with the 4 px the map keeps around them
// The fourth stage is the smallest map the screen shows (MIN_BOX), with the small windows' marks and labels and the
// north mark and the scale bar where styles.css puts them: the guarantees below hold down to it.
const LABELS_SMALL = { shrine: [96, 14], camp: [136, 14], ginkgo: [153, 14], pagoda: [67, 14], cliff: [93, 14], horse: [74, 14] };
const stage = (s) => {
  const { w, h } = s.screen ? s.screen.box : s;
  return { ...s, w, h, inset: pinInset(w, h) };
};
const STAGES = {
  '1920x1080': stage({
    screen: {
      width: 1920, height: 1080, bar: 138.33,
      menu: { x0: 138, y0: 162, x1: 480, y1: 516 }, side: { x0: 1226, y0: 162, x1: 1786, y1: 262 }, legend: { x0: 138, y0: 1009, x1: 1786, y1: 1026 },
      box: { x: 850, y: 295, w: 1012, h: 633 },
    },
    r: { you: 21, horse: 8.5, ring: 22.8, mark: 9.5 },
    labels: { shrine: [108, 16], camp: [154, 16], ginkgo: [174, 16], pagoda: [76, 16], cliff: [105, 16], horse: [84, 16] },
    obj: { h: 40, perChar: 8.7, min: 100, line: 26 },
    boxes: [{ x0: 872, y0: 66, x1: 905, y1: 149 }, { x0: 796, y0: 521, x1: 905, y1: 561 }],
  }),
  '1280x720': stage({
    screen: {
      width: 1280, height: 720, bar: 92.22,
      menu: { x0: 92, y0: 108, x1: 391, y1: 422 }, side: { x0: 678, y0: 108, x1: 1190, y1: 208 }, legend: { x0: 92, y0: 640, x1: 1190, y1: 684 },
      box: { x: 619, y: 230, w: 622, h: 389 },
    },
    r: { you: 14, horse: 6, ring: 16.3, mark: 7 },
    labels: LABELS_SMALL,
    obj: { h: 36, perChar: 7.6, min: 90, line: 23 },
    boxes: [{ x0: 528, y0: 39, x1: 558, y1: 113 }, { x0: 487, y0: 309, x1: 558, y1: 346 }],
  }),
  '1024x640': stage({
    screen: {
      width: 1024, height: 640, bar: 105.77,
      menu: { x0: 74, y0: 96, x1: 373, y1: 410 }, side: { x0: 543, y0: 96, x1: 952, y1: 196 }, legend: { x0: 74, y0: 564, x1: 952, y1: 608 },
      box: { x: 497, y: 216, w: 496, h: 310 },
    },
    r: { you: 14, horse: 6, ring: 16.3, mark: 7 },
    labels: LABELS_SMALL,
    obj: { h: 36, perChar: 7.6, min: 90, line: 23 },
    boxes: [{ x0: 416, y0: 30, x1: 445, y1: 104 }, { x0: 387, y0: 240, x1: 445, y1: 277 }],
  }),
  smallest: stage({
    w: MIN_BOX.w, h: MIN_BOX.h,
    r: { you: 14, horse: 6, ring: 16.3, mark: 7 },
    labels: LABELS_SMALL,
    obj: { h: 36, perChar: 7.6, min: 90, line: 23 },
    boxes: [{ x0: 367, y0: 26, x1: 396, y1: 100 }, { x0: 338, y0: 209, x1: 396, y1: 246 }],
  }),
};
const QUEST = QUESTS.map((q) => ({ title: q.title, target: q.target() }));
// (x, z, yaw) of the samurai and where the horse stands, in the situations the map meets
const SITUATIONS = [
  { name: 'the start: spawn, the horse grazing beside him', you: { x: 0, z: 0, yaw: -0.965 }, horse: { x: 4.6, z: 5.2 } },
  { name: 'the horse on top of him', you: { x: 0, z: 0, yaw: 1 }, horse: { x: 0, z: 0 } },
  { name: 'on the shrine hill, riding (no horse mark)', you: { x: -260, z: 180, yaw: 2 }, horse: null },
  { name: 'by the camp', you: { x: 262, z: -46, yaw: 0.9 }, horse: { x: 222, z: -24 } },
  { name: 'in the camp yard', you: { x: 340, z: -70, yaw: 3 }, horse: { x: 300, z: -80 } },
  { name: 'at the cliff', you: { x: -590, z: 400, yaw: -1.5 }, horse: { x: -560, z: 380 } },
  { name: 'at the pagoda', you: { x: 40, z: -500, yaw: 3.1 }, horse: { x: 60, z: -480 } },
  { name: 'far to the south-east, outside the frame', you: { x: 900, z: 800, yaw: 0 }, horse: { x: 880, z: 700 } },
  { name: 'in the sea', you: { x: -900, z: 100, yaw: 1.6 }, horse: null },
];

const overlap = (a, b, pad = 0) => a.x0 < b.x1 + pad && b.x0 < a.x1 + pad && a.y0 < b.y1 + pad && b.y0 < a.y1 + pad;
const hitsDisc = (b, d, pad = 0) => Math.hypot(d.x - Math.max(b.x0, Math.min(d.x, b.x1)), d.y - Math.max(b.y0, Math.min(d.y, b.y1))) < d.r + pad;

// The objective's label as MapPanel sets it: the title on one line, or on two (splitTitle) when one line would be wider
// than TITLE_MAX of the map.
const objLabel = (st, q) => {
  const one = (q ? q.title.length : 0) * st.obj.perChar;
  const lines = one > TITLE_MAX * st.w ? splitTitle(q.title) : [];
  if (lines.length < 2) return { w: Math.max(st.obj.min, one), h: st.obj.h };
  return { w: Math.max(st.obj.min, ...lines.map((l) => l.length * st.obj.perChar)), h: st.obj.h + st.obj.line };
};

// The page at a resolution for a situation and an objective (null: none), with the Italian label sizes of that stage.
const pageAt = (st, pr, sit, q) => {
  const labels = {};
  for (const k in st.labels) labels[k] = { w: st.labels[k][0], h: st.labels[k][1] };
  labels.obj = objLabel(st, q);
  const page = layoutPage({
    proj: pr,
    width: st.w,
    height: st.h,
    you: sit.you,
    horse: sit.horse,
    objective: q,
    sizes: { you: st.r.you, horse: st.r.horse, ring: st.r.ring, mark: st.r.mark, labels },
    boxes: st.boxes,
    inset: st.inset,
  });
  return { page, labels };
};

// What must hold of any page: every label that is drawn has a free spot, stays on the stage and is over no other label,
// no marker and neither the north mark nor the scale bar; the horse's mark is inside the pin inset and clear of the
// samurai's. A label may be left out (hidden: it is not drawn, so it is out of every check) only if it is the horse's or
// that of the place the objective's ring stands on, which the objective's title names.
const assertClear = (st, page, labels, what = '') => {
  for (const [id, s] of Object.entries(page.labels)) {
    if (!s.hidden || id === 'horse') continue;
    const m = page.marks.find((k) => k.id === id);
    assert.ok(m && page.ring && Math.hypot(m.x - page.ring.x, m.y - page.ring.y) < page.ring.r, `${what}: the label of ${id} is shown`);
  }
  const shown = Object.entries(page.labels).filter(([, s]) => !s.hidden);
  const boxes = shown.map(([id, s]) => ({ id, x0: s.x, y0: s.y, x1: s.x + labels[id].w, y1: s.y + labels[id].h }));
  const discs = [...(page.you ? [{ id: 'you', ...page.you }] : []), ...(page.ring ? [{ id: 'ring', ...page.ring }] : []), ...(page.horse ? [{ id: 'horse', ...page.horse }] : []), ...page.marks];
  for (const [id, s] of shown) assert.ok(s.free, `${what}: the label of ${id} found a free spot`);
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i];
    assert.ok(a.x0 >= 0 && a.y0 >= 0 && a.x1 <= st.w && a.y1 <= st.h, `${what}: ${a.id} stays on the stage`);
    for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlap(a, boxes[j]), `${what}: ${a.id} over ${boxes[j].id}`);
    for (const d of discs) assert.ok(!hitsDisc(a, d), `${what}: ${a.id} over the marker ${d.id}`);
    for (const b of st.boxes) assert.ok(!overlap(a, b), `${what}: ${a.id} over the north mark or the scale bar`);
  }
  if (page.horse) {
    const inset = Math.max(14, st.r.you * 1.4, st.inset);
    const { x, y } = page.horse;
    assert.ok(x >= inset - 1e-6 && x <= st.w - inset + 1e-6 && y >= inset - 1e-6 && y <= st.h - inset + 1e-6, `${what}: the horse's mark is on the stage (${x}, ${y})`);
    if (page.you) assert.ok(Math.hypot(page.you.x - x, page.you.y - y) >= page.you.r + page.horse.r - 1e-9, `${what}: the horse and the samurai apart`);
  }
};

for (const [res, st] of Object.entries(STAGES)) {
  const f = mapFrame(mapPoints(), st.w / st.h);
  const pr = projection(f, st.w, st.h);
  for (const q of QUEST) {
    for (const sit of SITUATIONS) {
      test(`labels at ${res}, objective "${q.title}", ${sit.name}: none over another label or a marker`, () => {
        const { page, labels } = pageAt(st, pr, sit, q);
        assert.equal(Object.keys(page.labels).length, PLACES.length + 1 + (sit.horse ? 1 : 0), 'a label for every place, the objective and the horse');
        // on the measured windows every one is shown; on the smallest map the place under the ring may give way
        if (res !== 'smallest') for (const [id, s] of Object.entries(page.labels)) assert.ok(!s.hidden, `the label of ${id} is shown`);
        assertClear(st, page, labels, sit.name);
      });
    }
  }
}

// The samurai off the frame is pinned to its border, and the horse beside him with him: both on the same edge or corner.
const PINNED = {
  'the east edge': [[1000, 0], [1000, -300], [1000, 300]],
  'the south edge': [[-90, 900], [400, 900], [-600, 900]],
  'the north edge': [[-90, -800], [400, -800], [-600, -800]],
  'the west edge': [[-1020, 0]],
  'a corner': [[1000, -800], [1000, 800], [-1020, -800], [-1020, 800]],
};
// where the horse stands relative to him (metres): on him, a few metres off, a trot away, a gallop away
const BESIDE = [[0, 0], [3, 3], [30, 0], [0, 30], [-30, 0], [0, -30], [60, -60], [-60, 60], [100, 0]];

for (const [res, st] of Object.entries(STAGES)) {
  const f = mapFrame(mapPoints(), st.w / st.h);
  const pr = projection(f, st.w, st.h);
  for (const [where, spots] of Object.entries(PINNED)) {
    test(`at ${res}, the horse beside the samurai pinned to ${where} stays on the stage, and nothing is drawn over anything`, () => {
      let shown = 0, total = 0;
      for (const [x, z] of spots) {
        for (const q of [null, ...QUEST]) {
          for (const [dx, dz] of BESIDE) {
            const sit = { you: { x, z, yaw: 0.7 }, horse: { x: x + dx, z: z + dz } };
            const { page, labels } = pageAt(st, pr, sit, q);
            assert.ok(page.you.pinned, 'the samurai is pinned');
            assertClear(st, page, labels, `(${x}, ${z}) + (${dx}, ${dz}) ${q ? q.title : 'no objective'}`);
            total++;
            if (!page.labels.horse.hidden) shown++;
          }
        }
      }
      // along an edge there is room for the horse's label; in a corner, next to the north mark or the scale bar, there may not be
      if (where !== 'a corner') assert.equal(shown, total, 'the horse keeps his label along an edge');
      else assert.ok(shown >= total * 0.8, `${shown} of ${total} corner layouts keep the horse's label`);
    });
  }
}

test('the horse next to the samurai on the east and on the south edge (the layouts that put his mark off the stage)', () => {
  // the camp quest at 1280x720, the samurai at (1000, 0), the horse at (1070, -40): the horse's label must not land over
  // the objective's title
  const st = STAGES['1280x720'], pr = projection(mapFrame(mapPoints(), st.w / st.h), st.w, st.h);
  const q = QUEST[1];
  const { page, labels } = pageAt(st, pr, { you: { x: 1000, z: 0, yaw: 0 }, horse: { x: 1070, z: -40 } }, q);
  assertClear(st, page, labels, 'the camp quest, the samurai on the east edge');
  assert.ok(!page.labels.horse.hidden, 'with his label');
  // beside him on the east edge: the horse went round him, not out past the border
  assert.ok(page.horse.x <= st.w - Math.max(14, st.r.you * 1.4, st.inset) + 1e-6);
  for (const [name, you, horse] of [
    ['east', { x: 1000, z: 100 }, { x: 1004, z: 98 }],
    ['south', { x: 100, z: 900 }, { x: 102, z: 906 }],
  ]) {
    for (const res of Object.keys(STAGES)) {
      const s2 = STAGES[res], p2 = projection(mapFrame(mapPoints(), s2.w / s2.h), s2.w, s2.h);
      const r = pageAt(s2, p2, { you: { ...you, yaw: 1 }, horse }, null);
      assert.ok(r.page.you.pinned, `${res}: the samurai is pinned on the ${name} edge`);
      assertClear(s2, r.page, r.labels, `${res} ${name} edge`);
      assert.ok(!r.page.labels.horse.hidden, `${res} ${name} edge: the horse keeps his label`);
    }
  }
});

test('a seeded sweep of layouts, the samurai and the horse anywhere in the world: nothing is drawn over anything', () => {
  const quests = [null, ...QUEST];
  for (const [res, st] of Object.entries(STAGES)) {
    const pr = projection(mapFrame(mapPoints(), st.w / st.h), st.w, st.h);
    const r = rng(20240514);
    const N = 1500;
    let hidden = 0, withHorse = 0;
    for (let n = 0; n < N; n++) {
      // the samurai anywhere in the world (about half of it is outside the frame), the horse close to him
      const you = { x: (r() * 2 - 1) * WORLD.half, z: (r() * 2 - 1) * WORLD.half, yaw: (r() * 2 - 1) * Math.PI };
      const d = r() < 0.5 ? r() * 40 : r() * 160, a = r() * Math.PI * 2;
      const horse = r() < 0.9 ? { x: you.x + Math.cos(a) * d, z: you.z + Math.sin(a) * d } : null;
      const q = quests[Math.floor(r() * quests.length)];
      const { page, labels } = pageAt(st, pr, { you, horse }, q);
      assertClear(st, page, labels, `${res} layout ${n}: samurai (${you.x.toFixed(0)}, ${you.z.toFixed(0)}) horse ${horse ? `(${horse.x.toFixed(0)}, ${horse.z.toFixed(0)})` : 'none'} ${q ? q.title : ''}`);
      if (horse) withHorse++;
      if (page.labels.horse && page.labels.horse.hidden) hidden++;
    }
    // the horse's label is left out only where a corner leaves it no room, with the samurai off the frame: rarely
    assert.ok(hidden <= withHorse * 0.01, `${res}: ${hidden} of ${withHorse} layouts leave the horse without his label`);
  }
});

test('the page puts the samurai, the horse and the ring where the world says, and pins what is outside', () => {
  const st = STAGES['1920x1080'];
  const f = mapFrame(mapPoints(), st.w / st.h);
  const pr = projection(f, st.w, st.h);
  const base = { proj: pr, width: st.w, height: st.h, sizes: { you: 21, horse: 8.5, ring: 22.8, mark: 9.5, labels: { obj: { w: 120, h: 40 }, horse: { w: 80, h: 16 }, ...Object.fromEntries(PLACES.map((p) => [p.id, { w: 100, h: 16 }])) } }, boxes: [] };
  const spawn = layoutPage({ ...base, you: { x: 0, z: 0, yaw: 0 }, horse: null, objective: null });
  const [sx, sy] = pr.toPx(0, 0);
  assert.ok(near(spawn.you.x, sx) && near(spawn.you.y, sy) && !spawn.you.pinned);
  assert.equal(spawn.you.deg, 180, 'yaw 0 faces south');
  assert.equal(spawn.horse, null);
  assert.equal(spawn.ring, null, 'no objective, no ring');
  assert.ok(!('obj' in spawn.labels));
  assert.equal(layoutPage({ ...base, you: null, horse: null, objective: null }).you, null);
  const out = layoutPage({ ...base, you: { x: 1000, z: 1000, yaw: 1 }, horse: { x: -1000, z: -1000 }, objective: null });
  assert.ok(out.you.pinned);
  assert.ok(out.you.x <= st.w - 14 && out.you.y <= st.h - 14 && out.you.x >= 14 && out.you.y >= 14);
  const ring = layoutPage({ ...base, you: null, horse: null, objective: { title: 'x', target: { x: -260, z: 180 } } }).ring;
  const [rx, ry] = pr.toPx(-260, 180);
  assert.ok(near(ring.x, rx) && near(ring.y, ry));
  // the layout is a pure function of its inputs
  const args = { ...base, you: { x: 5, z: 6, yaw: 0.2 }, horse: { x: 9, z: 9 }, objective: QUEST[0] };
  assert.deepEqual(layoutPage(args), layoutPage(args));
  assert.equal(PLACES.length, 5);
  assert.ok(PLACES.every((p) => POI[p.id] || p.id === 'pagoda'), 'every place is a layout point of interest');
});
