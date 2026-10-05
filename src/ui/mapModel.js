import { WORLD, POI, PATHS } from '../world/Layout.js';
import { clamp, smoothstep, hash2 } from '../core/math.js';
import { rng } from './brush.js';

// The pure logic of the map in the pause screen: no DOM, importable in Node (scripts/map.test.mjs). Where the map goes
// on the screen, the frame it shows, the world ↔ pixel projection, the marker geometry (heading, edge pinning,
// declutter), the label placement, the terrain raster and the seeded wave marks. src/ui/MapPanel.js is the canvas and
// DOM side.
// Conventions: metres, +X east, −Z north (src/world/Layout.js); the map is north-up, so a world z grows DOWN the
// screen and the terrain grid's rows (row 0 = north) are the image's rows. Pixels are CSS pixels unless a name says
// "device".

// ---------------------------------------------------------------------------------------------------- places
// The named places of the map, labelled through i18n (key). Positions are the layout's own.
export const PLACES = [
  { id: 'shrine', key: 'mapShrine', x: POI.shrine.x, z: POI.shrine.z },
  { id: 'camp', key: 'mapCamp', x: POI.camp.x, z: POI.camp.z },
  { id: 'ginkgo', key: 'mapGinkgo', x: POI.ginkgo.x, z: POI.ginkgo.z },
  { id: 'pagoda', key: 'mapPagoda', x: POI.pagoda.x, z: POI.pagoda.z },
  { id: 'cliff', key: 'mapCliff', x: POI.cliff.x, z: POI.cliff.z },
];

// ---------------------------------------------------------------------------------------------------- the frame
// The sea starts about here (TerrainGen.seaward: x = −700 with a ±70 m wobble); the frame reaches this far past it so
// the coast has some sea beside it.
export const COAST_X = -700;
export const SEA_REACH = 150;

// The map's aspect stays between these. The world is a square: a frame much wider than the places runs into its sides
// and leaves the places no room above and below for the fade at the map's edges (mapFrame).
export const MIN_ASPECT = 1.25;
export const MAX_ASPECT = 1.6;

// Every point the frame must hold: the layout's places (a disc where it has a radius), every path point, the sea.
export function mapPoints() {
  const pts = [];
  for (const k in POI) {
    const p = POI[k];
    if (p && typeof p.x === 'number' && typeof p.z === 'number') pts.push({ x: p.x, z: p.z, r: p.r || 0 });
  }
  for (const path of PATHS) for (const p of path) pts.push({ x: p.x, z: p.z, r: 0 });
  pts.push({ x: COAST_X - SEA_REACH, z: 0, r: 0 });
  return pts;
}

// The map's frame { x0, z0, w, h } (x0, z0 = the north-west corner, metres): the box around `points` (discs {x, z, r}),
// widened by a margin, grown on its short side to the panel's aspect (w / h) and slid back inside the world square.
// The margin keeps the places clear of the band where the map fades out at its edges. The aspect and the world are hard
// limits; the margin gives way first, and only a frame too tall or wide for the world (aspect beyond about 2) can lose a
// point.
export function mapFrame(points, aspect, { margin = 0.15, minMargin = 90 } = {}) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of points) {
    const r = p.r || 0;
    x0 = Math.min(x0, p.x - r);
    x1 = Math.max(x1, p.x + r);
    z0 = Math.min(z0, p.z - r);
    z1 = Math.max(z1, p.z + r);
  }
  const m = Math.max(minMargin, margin * Math.max(x1 - x0, z1 - z0));
  x0 -= m;
  x1 += m;
  z0 -= m;
  z1 += m;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  let w = x1 - x0, h = z1 - z0;
  if (w / h < aspect) w = h * aspect;
  else h = w / aspect;
  const k = Math.min(1, WORLD.size / w, WORLD.size / h);
  w *= k;
  h *= k;
  return {
    x0: clamp(cx - w / 2, -WORLD.half, WORLD.half - w),
    z0: clamp(cz - h / 2, -WORLD.half, WORLD.half - h),
    w,
    h,
  };
}

// World ↔ map pixels for a frame shown in width × height (the same aspect, so one scale serves both axes).
export function projection(frame, width, height) {
  const sx = width / frame.w, sy = height / frame.h;
  return {
    scale: sx, // pixels per metre
    toPx: (x, z) => [(x - frame.x0) * sx, (z - frame.z0) * sy],
    toWorld: (px, py) => [frame.x0 + px / sx, frame.z0 + py / sy],
  };
}

// ---------------------------------------------------------------------------------------------------- on the screen
// The map is part of the pause screen. It takes the room the rest of the screen leaves on the right:
//   - right of the logo and the menu;
//   - below the objective, above the controls hint;
//   - inside the picture, between the film letterbox's bars.
// The gaps keep it clear of all of these.
//   width, height        the window, CSS px
//   bar                  the height of one letterbox bar (--kz-bar, src/ui/bars.js); 0 with the letterbox off
//   menu, side, legend   boxes { x0, y0, x1, y1 } of the logo and menu column, the objective and the controls hint;
//                        null for one that is not on the screen
// Returns the map's box { x, y, w, h } (whole pixels) or null.
//   - The box is as tall as the room and against its right side.
//   - It is at most MAX_ASPECT wide; a narrow room gives a shorter box, centred in it.
//   - null when the room cannot hold a map that can be read (MIN_BOX): the screen then shows no map rather than
//     crowd the menu.
// MIN_BOX is the smallest map whose labels always find a free spot (the seeded sweep of scripts/map.test.mjs runs on
// it); a smaller one would begin to draw labels over each other.
export const MIN_BOX = { w: 440, h: 275 };

export function inlineBox({ width, height, bar = 0, menu = null, side = null, legend = null }) {
  const gap = (size, f, lo, hi) => clamp(size * f, lo, hi);
  const off = gap(height, 0.012, 8, 20); // from a bar's edge into the picture
  const X0 = Math.ceil((menu ? menu.x1 : 0) + gap(width, 0.03, 28, 64));
  const X1 = Math.floor(width - gap(width, 0.03, 20, 64));
  const Y0 = Math.ceil(Math.max(side ? side.y1 + gap(height, 0.03, 16, 40) : 0, bar + off));
  const Y1 = Math.floor(Math.min(legend ? legend.y0 - gap(height, 0.022, 12, 32) : height, height - bar - off));
  const rw = X1 - X0, rh = Y1 - Y0;
  if (!(rw > 0 && rh > 0)) return null;
  let w = rw, h = rh;
  if (rw / rh > MAX_ASPECT) w = Math.floor(rh * MAX_ASPECT);
  else if (rw / rh < MIN_ASPECT) h = Math.floor(rw / MIN_ASPECT);
  if (w < MIN_BOX.w || h < MIN_BOX.h) return null;
  return { x: X1 - w, y: Y0 + Math.floor((rh - h) / 2), w, h };
}

// How far inside the border of a w × h map a marker that is off it is pinned (layoutPage's inset). The land fades out
// over the outer band of the map (styles.css, --kz-map-fade), and the pinned markers stay where it still shows.
export function pinInset(w, h) {
  return Math.round(0.09 * Math.min(w, h));
}

// ---------------------------------------------------------------------------------------------------- markers
// Rotation in degrees (clockwise, as CSS rotate() reads it) for an arrow drawn pointing UP on the north-up map to
// point where a character facing `yaw` looks. A character's forward is (sin yaw, cos yaw) in (x, z) (src/actors/
// Actor.js): yaw 0 faces +Z, south, so the arrow turns half way round (180°); yaw π/2 faces east (90°).
export function headingDeg(yaw) {
  const d = 180 - (yaw * 180) / Math.PI;
  return ((d % 360) + 360) % 360;
}

// A marker outside the stage is pinned to its edge, `inset` pixels inside it, on the line from the stage's centre to
// the marker (so it keeps its bearing). { x, y, pinned }
export function pinToStage(x, y, width, height, inset = 0) {
  const cx = width / 2, cy = height / 2;
  const hx = cx - inset, hy = cy - inset;
  const dx = x - cx, dy = y - cy;
  if (Math.abs(dx) <= hx && Math.abs(dy) <= hy) return { x, y, pinned: false };
  const k = Math.min(hx / (Math.abs(dx) || 1e-9), hy / (Math.abs(dy) || 1e-9));
  return { x: cx + dx * k, y: cy + dy * k, pinned: true };
}

// A marker that lands closer than `minDist` to another (the horse grazes a few metres from the samurai, which is
// less than a pixel's worth at this scale) is slid away from it, so both stay readable. These are the spots it can take,
// the best first: straight away from the anchor (`hint` is the way when the two coincide), then fanned out on either side
// in steps of 15° (twelve make a half turn: every direction). `bounds` ({ x0, y0, x1, y1 }) keep it where it can be
// seen: a spot past them is left out, so beside a samurai pinned to an edge the horse goes round him; of two spots as
// near the straight way, the one closer to the middle of the bounds comes first. A marker that is clear of the anchor has
// one spot, where it is.
export function nudgeSpots(anchor, p, minDist, { hint = { x: 1, y: 0.6 }, bounds = null } = {}) {
  let dx = p.x - anchor.x, dy = p.y - anchor.y;
  const d = Math.hypot(dx, dy);
  if (d >= minDist) return [{ x: p.x, y: p.y }];
  if (d < 1e-6) {
    dx = hint.x;
    dy = hint.y;
  }
  const a0 = Math.atan2(dy, dx);
  const at = (a) => ({ x: anchor.x + Math.cos(a) * minDist, y: anchor.y + Math.sin(a) * minDist });
  if (!bounds) return [at(a0)];
  const eps = 1e-9; // a marker pinned to the border is on it, give or take the rounding
  const inside = (q) => q.x >= bounds.x0 - eps && q.x <= bounds.x1 + eps && q.y >= bounds.y0 - eps && q.y <= bounds.y1 + eps;
  const mid = { x: (bounds.x0 + bounds.x1) / 2, y: (bounds.y0 + bounds.y1) / 2 };
  const off = (q) => Math.hypot(q.x - mid.x, q.y - mid.y);
  const spots = [];
  for (let k = 0; k <= 12; k++) {
    const turn = (k * Math.PI) / 12;
    const pair = (k === 0 || k === 12 ? [at(a0 + turn)] : [at(a0 + turn), at(a0 - turn)]).filter(inside);
    if (pair.length > 1 && off(pair[1]) < off(pair[0])) pair.reverse();
    spots.push(...pair);
  }
  // no direction fits (bounds smaller than the distance asked): the nearest point of them
  if (!spots.length) spots.push({ x: clamp(at(a0).x, bounds.x0, bounds.x1), y: clamp(at(a0).y, bounds.y0, bounds.y1) });
  return spots;
}

// The scale bar: the longest round length (metres) that fits `maxPx`, and its length in pixels.
export function scaleBar(pxPerM, { maxPx = 190, steps = [50, 100, 200, 500, 1000] } = {}) {
  let meters = steps[0];
  for (const s of steps) if (s * pxPerM <= maxPx) meters = s;
  return { meters, px: meters * pxPerM };
}

// The objective the map points at, from the quest events (the HUD keeps only { id, title, objective }, no target).
// A completed quest has no objective until the next is announced, and after the ending there is none.
export function nextObjective(prev, type, detail) {
  if (type === 'quest:update') {
    const d = detail || {}, t = d.target;
    const ok = t && Number.isFinite(t.x) && Number.isFinite(t.z);
    return ok ? { id: d.id, title: d.title || '', target: { x: t.x, z: t.z } } : null;
  }
  if (type === 'quest:complete' || type === 'ending') return null;
  return prev;
}

// ---------------------------------------------------------------------------------------------------- labels
const SIDES = ['e', 'w', 'ne', 'se', 'nw', 'sw', 'n', 's'];

// The objective's title is the map's largest label. One wider than TITLE_MAX of the map goes on two lines: on a small
// map a long title on one line leaves it no room beside the ring.
export const TITLE_MAX = 0.3;

// A title on two lines, broken at the space that makes the longer line the shortest (by characters). A single word stays
// on one line. Returns [line] or [first, second].
export function splitTitle(title) {
  const words = String(title).trim().split(/\s+/);
  let best = [words.join(' ')];
  for (let k = 1, m = Infinity; k < words.length; k++) {
    const a = words.slice(0, k).join(' '), b = words.slice(k).join(' ');
    if (Math.max(a.length, b.length) < m) {
      m = Math.max(a.length, b.length);
      best = [a, b];
    }
  }
  return best;
}

// Where each label's box goes around its marker, so that none covers another label or any marker.
//   items      in priority order: { id, x, y, r, w, h, sides?, rings?, optional? } (x, y) the marker, r its clearance,
//              (w, h) the box; `rings` lets one label look further out than the others; an optional label with no room
//              anywhere near is left out rather than drawn over something
//   obstacles  what no label may cover: discs { x, y, r } and boxes { x0, y0, x1, y1 } (every marker, the marks);
//              a `soft` one (the dots of a path) is only avoided when a spot near the marker clears it too
//   bounds     { x0, y0, x1, y1 } the labels stay inside
//   fixed      boxes of labels that are on the stage already (a second call placing the late ones)
// Each label tries the sides in order at growing distances: first a spot that is clear of everything and close, then
// any spot clear of the hard obstacles, and failing that the least covered one. Returns { [id]: { x, y, side, free,
// hidden? } } with (x, y) the box's top-left corner, free = nothing hard is covered, hidden = an optional label left out.
export function placeLabels(items, obstacles, bounds, { gap = 6, pad = 3, labelPad = 9, rings = 5, ringStep = 9, softRings = 3, fixed = [] } = {}) {
  const placed = [...fixed];
  const out = {};
  const boxAt = (side, it, d) => {
    const o = d * 0.74;
    switch (side) {
      case 'e': return [it.x + d, it.y - it.h / 2];
      case 'w': return [it.x - d - it.w, it.y - it.h / 2];
      case 'n': return [it.x - it.w / 2, it.y - d - it.h];
      case 's': return [it.x - it.w / 2, it.y + d];
      case 'ne': return [it.x + o, it.y - o - it.h];
      case 'se': return [it.x + o, it.y + o];
      case 'nw': return [it.x - o - it.w, it.y - o - it.h];
      default: return [it.x - o - it.w, it.y + o]; // 'sw'
    }
  };
  // how much a box (x, y, w, h) covers: [hard, soft] — the area it shares with the other labels and the obstacles,
  // and how far it sticks out of the bounds (an exact 0 inside: a difference of areas would leave rounding dust)
  const covered = (x, y, w, h) => {
    let hard = 0, soft = 0;
    const x1 = x + w, y1 = y + h;
    const share = (ax0, ay0, ax1, ay1) => Math.max(0, Math.min(x1, ax1) - Math.max(x, ax0)) * Math.max(0, Math.min(y1, ay1) - Math.max(y, ay0));
    for (const b of placed) hard += share(b.x0 - labelPad, b.y0 - labelPad, b.x1 + labelPad, b.y1 + labelPad);
    for (const o of obstacles) {
      let a;
      if (o.r !== undefined) {
        // the closest point of the box to the disc's centre, against the radius (+ pad): a depth, in px², of the overlap
        const nx = clamp(o.x, x, x1), ny = clamp(o.y, y, y1);
        const d = Math.hypot(o.x - nx, o.y - ny);
        a = d < o.r + pad ? (o.r + pad - d) * Math.min(w, h) + 1 : 0;
      } else a = share(o.x0 - pad, o.y0 - pad, o.x1 + pad, o.y1 + pad);
      if (o.soft) soft += a;
      else hard += a;
    }
    hard += (Math.max(0, bounds.x0 - x) + Math.max(0, x1 - bounds.x1) + Math.max(0, bounds.y0 - y) + Math.max(0, y1 - bounds.y1)) * 40;
    return [hard, soft];
  };
  for (const it of items) {
    const sides = it.sides || SIDES;
    let clear = null, free = null, least = null;
    for (let ring = 0; ring < (it.rings || rings) && !clear; ring++) {
      const d = it.r + gap + ring * ringStep;
      for (const side of sides) {
        const [x, y] = boxAt(side, it, d);
        const [hard, soft] = covered(x, y, it.w, it.h);
        const spot = { x, y, side, c: hard };
        if (hard === 0 && soft === 0 && ring < softRings) {
          clear = spot;
          break;
        }
        if (hard === 0 && !free) free = spot;
        if (!least || hard < least.c) least = spot;
      }
    }
    const best = clear || free || least;
    out[it.id] = { x: best.x, y: best.y, side: best.side, free: best.c === 0 };
    if (it.optional && best.c !== 0) out[it.id].hidden = true;
    else placed.push({ x0: best.x, y0: best.y, x1: best.x + it.w, y1: best.y + it.h });
  }
  return out;
}

// Small soft obstacles along the paths (one disc of radius r every `step` pixels of a polyline of {x, z}), for the
// labels to keep off the dotted lines where they can.
export function pathObstacles(paths, proj, { step = 12, r = 4 } = {}) {
  const out = [];
  for (const path of paths) {
    let carry = 0;
    for (let k = 0; k + 1 < path.length; k++) {
      const [ax, ay] = proj.toPx(path[k].x, path[k].z), [bx, by] = proj.toPx(path[k + 1].x, path[k + 1].z);
      const len = Math.hypot(bx - ax, by - ay);
      for (let d = carry; d < len; d += step) out.push({ x: ax + ((bx - ax) * d) / len, y: ay + ((by - ay) * d) / len, r, soft: true });
      carry = ((carry - len) % step + step) % step;
    }
  }
  return out;
}

// The map's moving parts for a state of the world: where the samurai, the horse and the objective's ring stand on
// the stage, which way he faces, and where every label goes. Everything in pixels of the stage (width × height).
//   you        { x, z, yaw } | null            the samurai (world)
//   horse      { x, z } | null                 the horse, null when he rides it or there is none
//   objective  { title, target: { x, z } } | null
//   sizes      what the map measured: { you, horse, ring, mark, labels }, radii in pixels, labels { [id]: { w, h } }
//              for 'obj', 'horse' and each place id
//   boxes      boxes { x0, y0, x1, y1 } the labels keep off (the north mark, the scale bar)
//   inset      how far inside the stage's border a marker that is off it is pinned, at least (px): the map fades out
//              toward its edges, and a pinned marker stays where the land still shows
// Returns { you, horse, ring, marks, labels }: you { x, y, deg, r, pinned }, horse and ring { x, y, r }, marks
// [{ id, x, y, r }], labels { [id]: { x, y, side, free, hidden? } } (see placeLabels). Two labels can be hidden, where a
// crowded corner leaves them no spot: the horse's, which matters least, and that of the place the objective's ring
// stands on, which the objective's title names.
export function layoutPage({ proj, width, height, you, horse, objective, sizes, boxes = [], inset: edge = 0, places = PLACES, paths = PATHS }) {
  const inset = Math.max(14, sizes.you * 1.4, edge);
  const bounds = { x0: inset, y0: inset, x1: width - inset, y1: height - inset }; // where a marker's centre can be
  const labelBounds = { x0: 2, y0: 2, x1: width - 2, y1: height - 2 };
  const out = { you: null, horse: null, ring: null, marks: [], labels: {} };
  if (you) {
    const p = pinToStage(...proj.toPx(you.x, you.z), width, height, inset);
    out.you = { x: p.x, y: p.y, pinned: p.pinned, deg: headingDeg(you.yaw || 0), r: sizes.you };
  }
  // the horse: where he stands, pinned to the stage when outside it. Beside the samurai (pinned to the same edge, or just
  // near) he is slid apart but kept on the stage; the spots that gives are kept in order, for his label to choose from
  let spots = [];
  if (horse) {
    const p = pinToStage(...proj.toPx(horse.x, horse.z), width, height, inset);
    spots = out.you ? nudgeSpots(out.you, p, sizes.you + sizes.horse + 3, { bounds }) : [p];
    out.horse = { x: spots[0].x, y: spots[0].y, r: sizes.horse };
  }
  if (objective && objective.target) {
    const p = pinToStage(...proj.toPx(objective.target.x, objective.target.z), width, height, inset);
    out.ring = { x: p.x, y: p.y, r: sizes.ring };
  }
  // the labels go around their marks, never over another label or any marker; the dots of a path are avoided where
  // a spot near the mark clears them too
  const obstacles = [...boxes, ...pathObstacles(paths, proj)];
  const items = [];
  const L = sizes.labels;
  if (out.ring) {
    obstacles.push({ x: out.ring.x, y: out.ring.y, r: out.ring.r });
    // the objective's label is the largest: in a corner crowded with markers it may stand a little further out
    items.push({ id: 'obj', x: out.ring.x, y: out.ring.y, r: out.ring.r, ...L.obj, sides: ['ne', 'e', 'se', 'nw', 'w', 'sw', 'n', 's'], rings: 8 });
  }
  if (out.you) obstacles.push({ x: out.you.x, y: out.you.y, r: out.you.r });
  for (const pl of places) {
    const [x, y] = proj.toPx(pl.x, pl.z);
    const r = sizes.mark + 1;
    out.marks.push({ id: pl.id, x, y, r });
    obstacles.push({ x, y, r });
    // a mark inside the objective's ring keeps its label outside the ring
    const d = out.ring ? Math.hypot(out.ring.x - x, out.ring.y - y) : Infinity;
    const under = out.ring && d < out.ring.r;
    items.push({ id: pl.id, x, y, r: under ? d + out.ring.r : r, ...L[pl.id], optional: !!under });
  }
  // the objective and the places first, with the horse's mark at its first spot
  out.labels = placeLabels(items, out.horse ? [...obstacles, out.horse] : obstacles, labelBounds);
  if (!out.horse) return out;
  // then the horse's: at his first spot, and, when no label fits there, at the next spot of the fan that gives it room
  // (only a spot the labels are clear of: his mark must not sit under one). With none, the label is left out
  const fixed = Object.entries(out.labels).map(([id, s]) => ({ x0: s.x, y0: s.y, x1: s.x + L[id].w, y1: s.y + L[id].h }));
  let first = null;
  for (let i = 0; i < spots.length; i++) {
    const spot = { x: spots[i].x, y: spots[i].y, r: sizes.horse };
    if (i && fixed.some((b) => Math.hypot(spot.x - clamp(spot.x, b.x0, b.x1), spot.y - clamp(spot.y, b.y0, b.y1)) < spot.r + 3)) continue;
    const item = { id: 'horse', ...spot, ...L.horse, sides: ['e', 'w', 'se', 'sw', 'ne', 'nw', 's', 'n'], optional: true };
    const got = placeLabels([item], [...obstacles, spot], labelBounds, { fixed }).horse;
    first = first || got;
    if (!got.hidden) {
      out.horse = spot;
      out.labels.horse = got;
      return out;
    }
  }
  out.labels.horse = first;
  return out;
}

// ---------------------------------------------------------------------------------------------------- raster
// How the terrain is washed: bone ink on the pause's dark. The tone steps up with the height over a handful of bands
// (their edges are the contour lines); a hillshade from the north-west models the relief; the forest is stippled; the
// coast, where the height crosses 0, is the brightest line; the sea is left empty. Heights in metres.
export const BAND_EDGES = [10, 18, 26, 36, 48, 64, 90, 130];
export const BONE = [242, 233, 216]; // --kz-bone

// The fade toward the edge of the map's area: 1 in the middle, 0 at the border, over a superellipse so the corners
// go first and no rectangle shows. (u, v) in 0..1 across the area.
export function edgeFade(u, v) {
  const a = Math.abs(2 * u - 1), b = Math.abs(2 * v - 1);
  const d = Math.sqrt(Math.sqrt(a * a * a * a + b * b * b * b)); // |.|⁴ norm
  return 1 - smoothstep(0.7, 1, d);
}

// Box blur of radius r pixels, run twice (a tent), edges clamped; `src` is w×h, a new array comes back (the generator's
// return value: `yield*` it). Both passes walk the rows (the vertical one keeps a running sum per column), so the memory is
// read in order. It yields every million pixels or so of work, so the map's painting keeps to its slices (a blur of
// a 2552 × 1586 base is some 80 ms in one go).
function* blur(src, w, h, r) {
  r = Math.max(1, Math.round(r));
  const inv = 1 / (2 * r + 1);
  const tmp = new Float32Array(w * h);
  const col = new Float64Array(w);
  const rows = Math.max(16, Math.ceil(1.5e6 / w)); // rows between two yields
  let a = src;
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = a[row] * (r + 1);
      for (let k = 1; k <= r; k++) acc += a[row + Math.min(k, w - 1)];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc * inv;
        acc += a[row + Math.min(x + r + 1, w - 1)] - a[row + Math.max(x - r, 0)];
      }
      if (y % rows === rows - 1) yield;
    }
    const out = new Float32Array(w * h);
    for (let x = 0; x < w; x++) col[x] = tmp[x] * (r + 1);
    for (let k = 1; k <= r; k++) {
      const row = Math.min(k, h - 1) * w;
      for (let x = 0; x < w; x++) col[x] += tmp[row + x];
    }
    for (let y = 0; y < h; y++) {
      const row = y * w, add = Math.min(y + r + 1, h - 1) * w, sub = Math.max(y - r, 0) * w;
      for (let x = 0; x < w; x++) {
        out[row + x] = col[x] * inv;
        col[x] += tmp[add + x] - tmp[sub + x];
      }
      if (y % rows === rows - 1) yield;
    }
    a = out;
  }
  return a;
}

const TONE = new Float32Array(257).map((_, i) => 0.09 + 0.32 * Math.pow(i / 256, 0.85)); // the wash's alpha by tone

// The terrain base as an RGBA image (straight alpha, bone ink: only the alpha varies) of `width` × `height` device
// pixels showing `frame`. `terrain` = { H, surf }: the heights and the surface masks of src/world/TerrainGen.js
// (square grids, row 0 = north, R rock, G forest, B sand, A wet). `dpr` scales the hairlines and the stipple.
// Returns { width, height, rgba, sea } with sea = 1 where the height is below 0 (the waves are drawn there).
// Deterministic: the same inputs give the same bytes.
// terrainRaster() runs it in one go; rasterJob() is the same work as a generator that yields between its slices
// (a few ms at a time), so the map can paint its base without a hitch while the pause menu fades in.
export function terrainRaster(terrain, frame, width, height, opts) {
  const job = rasterJob(terrain, frame, width, height, opts);
  let r = job.next();
  while (!r.done) r = job.next();
  return r.value;
}

export function* rasterJob(terrain, frame, width, height, { dpr = 1, seed = 7 } = {}) {
  const { H, surf } = terrain;
  const N = Math.round(Math.sqrt(H.length));
  const cell = WORLD.size / (N - 1);
  const mpp = frame.w / width; // metres per device pixel
  const W2 = width + 2, H2 = height + 2;

  // pass 1: the height at every pixel centre (one pixel of margin for the gradients), the forest inside
  const colI = new Int32Array(W2), colF = new Float32Array(W2);
  for (let x = 0; x < W2; x++) {
    const g = clamp((frame.x0 + (x - 0.5) * mpp + WORLD.half) / cell, 0, N - 1.0001);
    colI[x] = Math.floor(g);
    colF[x] = g - colI[x];
  }
  const hp = new Float32Array(W2 * H2);
  const land = new Float32Array(W2 * H2); // the same without the sea floor, which would pull the coast down
  const forest = new Uint8Array(width * height);
  for (let y = 0; y < H2; y++) {
    const g = clamp((frame.z0 + (y - 0.5) * mpp + WORLD.half) / cell, 0, N - 1.0001);
    const j0 = Math.floor(g), fz = g - j0;
    const r0 = j0 * N, r1 = r0 + N;
    const inside = y > 0 && y <= height;
    for (let x = 0; x < W2; x++) {
      const i0 = colI[x], fx = colF[x];
      const a = H[r0 + i0], b = H[r0 + i0 + 1], c = H[r1 + i0], d = H[r1 + i0 + 1];
      const hv = a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
      hp[y * W2 + x] = hv;
      land[y * W2 + x] = hv > 0 ? hv : 0;
      if (inside && x > 0 && x <= width) {
        const fa = surf[(r0 + i0) * 4 + 1], fb = surf[(r0 + i0 + 1) * 4 + 1];
        const fc = surf[(r1 + i0) * 4 + 1], fd = surf[(r1 + i0 + 1) * 4 + 1];
        forest[(y - 1) * width + x - 1] = fa + (fb - fa) * fx + (fc - fa) * fz + (fa - fb - fc + fd) * fx * fz;
      }
    }
    if (y % 96 === 95) yield;
  }
  // the contour field is the land smoothed over ~25 m (the hummocks of the meadow would braid the lines), the
  // hillshade's a lighter one (~16 m)
  const hs = yield* blur(land, W2, H2, 25 / mpp);
  yield;
  const hl = yield* blur(land, W2, H2, 16 / mpp);
  yield;

  // the fade toward the area's edge, by column and row (the |.|⁴ norm's parts, see edgeFade)
  const fadeX = new Float32Array(width), fadeY = new Float32Array(height);
  for (let x = 0; x < width; x++) fadeX[x] = Math.pow(Math.abs((2 * (x + 0.5)) / width - 1), 4);
  for (let y = 0; y < height; y++) fadeY[y] = Math.pow(Math.abs((2 * (y + 0.5)) / height - 1), 4);
  const F0 = Math.pow(0.7, 4);

  // pass 2: the wash, the contours, the coast
  const rgba = new Uint8ClampedArray(width * height * 4);
  const sea = new Uint8Array(width * height);
  const L = [-0.62, 0.5, -0.6]; // toward the light: west, up, north
  const Ll = Math.sqrt(L[0] * L[0] + L[1] * L[1] + L[2] * L[2]);
  const lx = L[0] / Ll, ly = L[1] / Ll, lz = L[2] / Ll;
  const lift = 1.6 * (1 / mpp); // the relief's vertical exaggeration, and metres per pixel → slope
  const NE = BAND_EDGES.length;
  const lineHalf = 0.55 * dpr, coastHalf = 0.9 * dpr;
  for (let y = 0; y < height; y++) {
    if (y % 48 === 47) yield;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      rgba[i * 4] = BONE[0];
      rgba[i * 4 + 1] = BONE[1];
      rgba[i * 4 + 2] = BONE[2];
      const c = (y + 1) * W2 + x + 1;
      const h = hp[c];
      if (h < 0) sea[i] = 1;
      const s4 = fadeX[x] + fadeY[y];
      if (s4 >= 1) continue; // outside the fade: nothing there
      let alpha = 0;
      if (h >= 0) {
        // tonal band from the smoothed height, with an anti-aliased step at every edge
        const hh = hs[c];
        const gsx = (hs[c + 1] - hs[c - 1]) * 0.5, gsz = (hs[c + W2] - hs[c - W2]) * 0.5;
        const gs = Math.sqrt(gsx * gsx + gsz * gsz);
        const w = Math.max(0.04, gs * 0.7), inv = 1 / Math.max(gs, 1e-4);
        let k = 0;
        while (k < NE && hh >= BAND_EDGES[k]) k++;
        let tone = k, line = 0;
        if (k > 0) {
          const d = hh - BAND_EDGES[k - 1];
          tone = k - 1 + smoothstep(-w, w, d);
          line = 1 - smoothstep(lineHalf, lineHalf + 1, Math.abs(d) * inv);
        }
        if (k < NE) {
          const d = hh - BAND_EDGES[k];
          tone += smoothstep(-w, w, d);
          line = Math.max(line, 1 - smoothstep(lineHalf, lineHalf + 1, Math.abs(d) * inv));
        }
        // hillshade: 1 on the flat, more toward the light, less away from it
        const dx = (hl[c + 1] - hl[c - 1]) * 0.5 * lift, dz = (hl[c + W2] - hl[c - W2]) * 0.5 * lift;
        const lit = (-dx * lx + ly - dz * lz) / (Math.sqrt(dx * dx + 1 + dz * dz) * ly);
        const wash = TONE[Math.round((tone / NE) * 256)] * (0.55 + 0.45 * (lit < 0.05 ? 0.05 : lit > 1.9 ? 1.9 : lit));
        alpha = 1 - (1 - wash) * (1 - line * 0.24);
      }
      // the coast: a bright line where the height crosses 0, from the raw heights
      if (h < 12 && h > -12) {
        const gx = (hp[c + 1] - hp[c - 1]) * 0.5, gz = (hp[c + W2] - hp[c - W2]) * 0.5;
        const dCoast = Math.abs(h) / Math.max(Math.sqrt(gx * gx + gz * gz), 0.02); // pixels to the shore
        alpha = 1 - (1 - alpha) * (1 - (1 - smoothstep(coastHalf, coastHalf + 1, dCoast)) * 0.9);
      }
      if (s4 > F0) alpha *= 1 - smoothstep(0.7, 1, Math.sqrt(Math.sqrt(s4)));
      rgba[i * 4 + 3] = Math.round(alpha * 255);
    }
  }

  // pass 3: the forest as a fine stipple, a CSS-pixel dot in a 4 px cell, denser where the wood is thicker
  const cs = Math.max(2, Math.round(4 * dpr)), dot = Math.max(1, Math.round(dpr));
  for (let cy = 0; cy * cs < height; cy++) {
    if (cy % 24 === 23) yield;
    for (let cx = 0; cx * cs < width; cx++) {
      const ox = Math.floor(hash2(cx + 311, cy + seed * 17) * (cs - dot + 1)), oy = Math.floor(hash2(cx + 97, cy + 53 + seed) * (cs - dot + 1));
      const px = cx * cs + ox, py = cy * cs + oy;
      if (px >= width || py >= height) continue;
      const f = forest[py * width + px] / 255;
      if (f < 0.04 || hash2(cx, cy + seed * 31) >= 0.6 * Math.pow(f, 1.2)) continue;
      const a = (0.28 + 0.16 * f) * edgeFade((px + 0.5) / width, (py + 0.5) / height);
      for (let yy = py; yy < Math.min(height, py + dot); yy++) {
        for (let xx = px; xx < Math.min(width, px + dot); xx++) {
          const o = (yy * width + xx) * 4;
          const prev = rgba[o + 3] / 255;
          rgba[o + 3] = Math.round((1 - (1 - prev) * (1 - a)) * 255);
        }
      }
    }
  }
  return { width, height, rgba, sea };
}

// Short wave hairlines over the sea, on a loose staggered grid, seeded: { x, y, len, amp, a, ph } in device pixels.
// `sea` is the raster's mask (1 = sea); a mark and a margin around it must be all sea.
export function waveMarks({ seed = 5, width, height, dpr = 1, sea }) {
  const r = rng(seed);
  const cw = 50 * dpr, ch = 32 * dpr;
  const at = (x, y) => {
    const ix = Math.round(x), iy = Math.round(y);
    return ix >= 0 && iy >= 0 && ix < width && iy < height && sea[iy * width + ix] === 1;
  };
  const marks = [];
  for (let row = 0, y0 = 0; y0 < height; row++, y0 += ch) {
    for (let x0 = (row & 1) * cw * 0.5 - cw; x0 < width; x0 += cw) {
      const keep = r() < 0.6, jx = r(), jy = r(), len = (14 + r() * 24) * dpr, amp = (1 + r() * 1.5) * dpr, ph = r() * Math.PI * 2;
      const a = 0.13 + r() * 0.15;
      if (!keep) continue;
      const x = x0 + jx * cw * 0.7, y = y0 + jy * ch * 0.8;
      const m = 6 * dpr;
      if (!(at(x - m, y) && at(x + len / 2, y) && at(x + len + m, y) && at(x + len / 2, y - m) && at(x + len / 2, y + m))) continue;
      const alpha = a * edgeFade(x / width, y / height);
      if (alpha >= 0.03) marks.push({ x, y, len, amp, a: alpha, ph }); // not the ones that fade out at the border
    }
  }
  return marks;
}

// A cheap key for what the cached base shows: the same size, density and frame give the same picture.
export function baseKey(frame, width, height, dpr) {
  return [width, height, dpr, frame.x0.toFixed(2), frame.z0.toFixed(2), frame.w.toFixed(2)].join('|');
}
