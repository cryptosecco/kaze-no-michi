import * as THREE from 'three';
import { PATHS, PATH_INFO, POI, WORLD } from '../Layout.js';
import { GLOBAL_UNIFORMS } from '../../render/globals.js';
import { kasagiTop } from '../props/torii.js';
import { crownPerches, toWorld } from './perches.js';
import { awayFrom } from './sim.js';

// The island as the birds see it, built from the game's own data (see sim.js for the interface it serves):
//   crowns      every tree of the trees module (forest instances: position, rotation, scale, variant) as an ellipsoid
//               crown, indexed lazily in 64 m tiles of 8 m cells: obstacleTop(x, z) for the flight's look-ahead,
//               the trees around a point for perches (crownPerches() of the variant, placed by the instance)
//   statics     buildings, walls, lanterns, rocks… from game.colliders, with a height: obstacles to fly over
//   ground      foraging spots on bare walkable ground: the paths, the shrine stairs, grazed lawns, the beach; a spot
//               is dry, above the sea, flat enough, outside every collider and under open sky
//   props       the kasagi of the big torii (sky torii, entrance torii, cliff torii): crows' perches
//   sway        the trees' wind sway at a perch (CPU mirror of trees/materials.js), so a crow rides its swaying top
// and as the fox and the deer see it (mammals.js):
//   walkable    dry land above the sea, not too steep, no floor / stairs / platform (an override over the terrain),
//               clear of every collider (trunks, rocks, walls, buildings) by the animal's clearance; cached on 0.5 m
//   cover       forest (the terrain's forest mask) and tall grass
//   habitat     candidate places per species, sampled lazily every 6 m in 64 m tiles: the deer's forest edges (grass
//               with the forest within ~25 m) and clearings (open grass ringed by forest), the fox's paths, field
//               edges and the shrine hill's surroundings (never the stairs or the summit buildings)

const TILE = 64;
const CELL = 8;
const NC = TILE / CELL;
const FOREST_GRID = 32; // trees/Forest.js
const fkey = (i, j) => (i + 512) * 4096 + (j + 512);
const tkey = (i, j) => (i + 128) * 1024 + (j + 128);
const fract = (v) => v - Math.floor(v);
const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// obstacle heights by collider tag when the collider has no top of its own (metres above the ground)
const TAG_HEIGHT = { pagoda: 33, gate: 13, honden: 11, minka: 10, chozuya: 4.5, tent: 3, palisade: 3.2, torii: 11, rack: 2.2 };
// crows like a tall, open top: conifers and the big ginkgos first
const CROW_PREF = { pine: 0.8, cedar: 0.7, ginkgo: 0.6, maple: 0.35, bamboo: -0.6, shrub: -2 };
// foraging ground by kind: [crow, sparrow]
const GROUND_PREF = { path: [1, 1.2], stairs: [0.7, 0.5], lawn: [1.3, 0.7], sand: [1.4, 0.3] };

export class Island {
  constructor(game, { rng }) {
    this.game = game;
    this.terrain = game.terrain;
    this.rng = rng;
    const trees = game.modules && game.modules.trees && game.modules.trees.forest ? game.modules.trees : null;
    this.forest = trees ? trees.forest : null;
    this.variants = trees ? trees.variants : [];
    this.vPerch = new Map();
    this.crowns = new Map();
    this.tiles = new Map();
    this.okCache = new Map();
    this.statics = this.buildStatics();
    this.ground = this.buildGround();
    const props = game.modules && game.modules.props && game.modules.props.sites ? game.modules.props.sites : null;
    this.props = props ? this.buildTorii(props) : [];
    this._v2 = new THREE.Vector2();
    this.walkCache = new Map();
    this.habitat = new Map();
  }

  // ------------------------------------------------------------------------------------------------ mammals
  // ground a mammal may step on (sp.clearance: the room it keeps from trunks, rocks and walls)
  walkable(x, z, sp) {
    const cl = sp && sp.clearance ? sp.clearance : 0.25;
    const ci = cl > 0.3 ? 1 : 0;
    const key = ((Math.round(x * 2) + 8192) * 16384 + (Math.round(z * 2) + 8192)) * 2 + ci;
    let v = this.walkCache.get(key);
    if (v !== undefined) return v;
    v = this.computeWalkable(Math.round(x * 2) / 2, Math.round(z * 2) / 2, ci ? 0.35 : 0.18);
    if (this.walkCache.size > 120000) this.walkCache.clear();
    this.walkCache.set(key, v);
    return v;
  }

  computeWalkable(x, z, cl) {
    const g = this.game, T = this.terrain;
    const h = g.groundAt(x, z);
    if (!(h > 0.5)) return false;
    // stairs, platforms, floors: ground raised over the terrain by an override
    if (h - T.heightAt(x, z) > 0.05) return false;
    const e = 0.5;
    if (Math.abs(T.heightAt(x + e, z) - T.heightAt(x - e, z)) > 0.75 || Math.abs(T.heightAt(x, z + e) - T.heightAt(x, z - e)) > 0.75) return false;
    for (const c of g.colliders.nearby(x, z, cl + 0.6)) {
      if (c.type === 'circle') {
        if ((x - c.x) ** 2 + (z - c.z) ** 2 < (c.r + cl) ** 2) return false;
      } else {
        const dx = x - c.x, dz = z - c.z;
        const lx = dx * c.cos - dz * c.sin, lz = dx * c.sin + dz * c.cos;
        if (Math.abs(lx) < c.hw + cl && Math.abs(lz) < c.hd + cl) return false;
      }
    }
    return true;
  }

  // The tree trunks (no shrubs) around (x, z) within r, straight from the forest's arrays (no crown records): how many,
  // the nearest, and which of 8 sectors around the point they stand in (a bit mask)
  treesAround(x, z, r, o = this._ta || (this._ta = { n: 0, near: Infinity, sectors: 0 })) {
    o.n = 0;
    o.near = Infinity;
    o.sectors = 0;
    const f = this.forest;
    if (!f) return o;
    const i0 = Math.floor((x - r) / FOREST_GRID), i1 = Math.floor((x + r) / FOREST_GRID);
    const j0 = Math.floor((z - r) / FOREST_GRID), j1 = Math.floor((z + r) / FOREST_GRID);
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const cell = f.cells.get(fkey(i, j));
        if (!cell) continue;
        for (let q = 0; q < cell.length; q++) {
          const k = cell[q];
          const dx = f.x[k] - x, dz = f.z[k] - z, d2 = dx * dx + dz * dz;
          if (d2 > r * r) continue;
          const v = this.variants[f.vi[k]];
          if (v && v.cls === 'shrub') continue;
          o.n++;
          const d = Math.sqrt(d2);
          if (d < o.near) o.near = d;
          o.sectors |= 1 << (Math.floor(((Math.atan2(dx, dz) + Math.PI) / (Math.PI * 2)) * 8) & 7);
        }
      }
    return o;
  }

  // 0..1: how much a place hides an animal ('forest': trunks around it; 'grass': tall grass and susuki; else both)
  cover(x, z, kind) {
    const s = this.terrain.surfaceAt(x, z);
    const grass = Math.max(s.pampas, s.grass * 0.6) * (1 - s.path);
    if (kind === 'grass') return grass;
    const woods = this.forest ? Math.min(1, this.treesAround(x, z, 12).n / 5) : s.forest;
    if (kind === 'forest') return woods;
    return Math.max(woods, grass * 0.7);
  }

  // candidate places of a species in a tile (lazily): [{ x, z, kind, score }]
  habitatTile(sp, ti, tj) {
    const key = tkey(ti, tj) * 4 + (sp.name === 'fox' ? 1 : 2);
    let list = this.habitat.get(key);
    if (list) return list;
    list = [];
    const T = this.terrain, step = 6;
    const sh = POI.shrine;
    for (let z = tj * TILE + step / 2; z < (tj + 1) * TILE; z += step)
      for (let x = ti * TILE + step / 2; x < (ti + 1) * TILE; x += step) {
        const jx = x + (fract(Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) - 0.5) * step * 0.8;
        const jz = z + (fract(Math.sin(x * 39.346 + z * 11.135) * 24634.6345) - 0.5) * step * 0.8;
        if (!this.walkable(jx, jz, sp)) continue;
        const s = T.surfaceAt(jx, jz);
        if (s.rock > 0.5 || s.sand > 0.5) continue;
        // the trees around, as they stand: the nearest trunk, how many within 25 m, and on how many sides (an edge has
        // the wood on one side and the open on the other; a clearing is ringed by it)
        const ta = this.treesAround(jx, jz, 25);
        const n25 = ta.n, near = ta.near;
        let sides = 0;
        for (let b = 0; b < 8; b++) if (ta.sectors & (1 << b)) sides++;
        const open = near > 6 && s.grass > 0.25; // grass under open sky, not the leaf litter under the crowns
        const dShrine = Math.hypot(jx - sh.x, jz - sh.z);
        let kind = null, score = 0;
        if (sp.name === 'fox') {
          if (s.path > 0.5) (kind = 'path'), (score = 1.0);
          else if (open && n25 >= 3 && sides <= 5) (kind = 'edge'), (score = 1.2);
          else if (s.grass > 0.4 && near > 15) (kind = 'field'), (score = 0.45);
          if (kind && dShrine < sh.footRadius + 40) score += 0.8; // the Inari fox: around the shrine hill
          if (s.pampas > 0.75) score -= 0.4; // lost in the susuki
        } else {
          if (s.path > 0.4) continue;
          // (never in the susuki: a deer grazes the shorter grass; the taller the grass, the less it likes it)
          if (s.pampas > 0.55) continue;
          if (open && near > 9 && n25 >= 6 && sides >= 6) (kind = 'clearing'), (score = 1.6);
          else if (open && n25 >= 4 && sides <= 5) (kind = 'edge'), (score = 1.4);
          else if (near > 1.5 && this.treesAround(jx, jz, 12).n >= 5) (kind = 'wood'), (score = 0.3);
          score -= s.pampas * 0.8 + s.grass * 0.3;
          // the camp, the shrine summit: people
          if (dShrine < sh.topRadius + 12 || Math.hypot(jx - POI.camp.x, jz - POI.camp.z) < POI.camp.r) continue;
        }
        if (kind) list.push({ x: jx, z: jz, kind, score });
      }
    this.habitat.set(key, list);
    if (this.habitat.size > 400) {
      const c = this.center || { x: 0, z: 0 };
      for (const [k] of this.habitat) {
        const t = Math.floor(k / 4), i = Math.floor(t / 1024) - 128, j = (t % 1024) - 128;
        if (Math.hypot((i + 0.5) * TILE - c.x, (j + 0.5) * TILE - c.z) > 400) this.habitat.delete(k);
      }
    }
    return list;
  }

  // A place for a group of `count` in the ring rMin..rMax around (x, z), away from o.away: the best candidates by
  // score (a little random), then the spots of the members around it (walkable, a couple of metres apart)
  findHabitat(sp, x, z, o) {
    const rng = this.rng, list = [];
    const ti0 = Math.floor((x - o.rMax) / TILE), ti1 = Math.floor((x + o.rMax) / TILE);
    const tj0 = Math.floor((z - o.rMax) / TILE), tj1 = Math.floor((z + o.rMax) / TILE);
    for (let tj = tj0; tj <= tj1; tj++)
      for (let ti = ti0; ti <= ti1; ti++)
        for (const c of this.habitatTile(sp, ti, tj)) {
          const d = Math.hypot(c.x - x, c.z - z);
          if (d < o.rMin || d > o.rMax) continue;
          if (o.away && Math.hypot(c.x - o.away.x, c.z - o.away.z) < sp.fid.ground * 1.2) continue;
          list.push([c.score + rng() * 0.8, c]);
        }
    list.sort((a, b) => b[0] - a[0]);
    const n = o.count || 1;
    for (const [, c] of list.slice(0, 6)) {
      const spots = [];
      const sep = sp.name === 'fox' ? 0 : 2.2;
      for (let k = 0; k < n * 8 && spots.length < n; k++) {
        const a = rng() * Math.PI * 2, r = spots.length ? range(rng, 1.5, 6) : 0;
        const sx = c.x + Math.sin(a) * r, sz = c.z + Math.cos(a) * r;
        if (!this.walkable(sx, sz, sp)) continue;
        if (spots.some((p) => Math.hypot(p.x - sx, p.z - sz) < sep)) continue;
        // room for the body around the spot
        if (!this.walkable(sx + 0.8, sz, sp) || !this.walkable(sx - 0.8, sz, sp) || !this.walkable(sx, sz + 0.8, sp) || !this.walkable(sx, sz - 0.8, sp)) continue;
        spots.push({ x: sx, z: sz, yaw: rng() * Math.PI * 2 });
      }
      if (spots.length >= n) return { x: c.x, z: c.z, kind: c.kind, spots };
    }
    return null;
  }

  // A refuge: in cover (the forest; for the fox also the susuki), walkable, in the ring rMin..rMax around (x, z) and
  // away from o.away (never back past it)
  findCover(sp, x, z, o) {
    const rng = this.rng;
    let best = null, bs = -Infinity;
    const ax = o.away ? x - o.away.x : 0, az = o.away ? z - o.away.z : 0, al = Math.hypot(ax, az) || 1;
    for (let k = 0; k < 28; k++) {
      // around the way away from the threat (±100°), or anywhere without one
      const base = o.away ? Math.atan2(ax / al, az / al) : rng() * Math.PI * 2;
      const a = base + (rng() - 0.5) * (o.away ? 3.4 : Math.PI * 2);
      const r = range(rng, o.rMin, o.rMax);
      const px = x + Math.sin(a) * r, pz = z + Math.cos(a) * r;
      if (o.away && !awayFrom(x, z, o.away, px, pz)) continue;
      if (!this.walkable(px, pz, sp)) continue;
      const cv = sp.name === 'fox' ? this.cover(px, pz) : this.cover(px, pz, 'forest');
      if (cv < (sp.name === 'fox' ? 0.45 : 0.55)) continue;
      let s = cv + rng() * 0.3;
      if (o.away) s += Math.min(Math.hypot(px - o.away.x, pz - o.away.z), 150) * 0.006;
      if (s > bs) (bs = s), (best = { x: px, z: pz });
    }
    return best;
  }

  // ------------------------------------------------------------------------------------------------ crowns
  crown(i) {
    let c = this.crowns.get(i);
    if (c) return c;
    const f = this.forest, vi = f.vi[i], v = this.variants[vi], s = f.s[i], m = f.mat;
    const cos = m[i * 16] / s, sin = m[i * 16 + 8] / s;
    const C = v.crown.c, R = v.crown.r;
    const x = f.x[i], y = f.y[i], z = f.z[i];
    c = {
      i, vi, v, x, y, z, s, cos, sin,
      cx: x + (C.x * cos + C.z * sin) * s,
      cy: y + C.y * s,
      cz: z + (-C.x * sin + C.z * cos) * s,
      rh: Math.max(R.x, R.z) * s * 1.05,
      ry: R.y * s * 1.05,
      shrub: v.cls === 'shrub',
      kind: v.kind,
      // the trees' per-instance sway phase, as the shader hashes it (on the CPU: not bit-exact, see sway())
      cph: fract(Math.sin(Math.floor(x * 2) * 12.9898 + Math.floor(z * 2) * 78.233) * 43758.5453) * Math.PI * 2,
      perches: null,
    };
    c.top = c.cy + c.ry;
    this.crowns.set(i, c);
    return c;
  }

  forestCell(i, j, fn) {
    if (!this.forest) return;
    const cell = this.forest.cells.get(fkey(i, j));
    if (cell) for (let k = 0; k < cell.length; k++) fn(this.crown(cell[k]));
  }

  tile(ti, tj) {
    const key = tkey(ti, tj);
    let t = this.tiles.get(key);
    if (t) return t;
    t = new Array(NC * NC);
    for (let k = 0; k < t.length; k++) t[k] = null;
    const x0 = ti * TILE, z0 = tj * TILE;
    const put = (o, minx, maxx, minz, maxz) => {
      const i0 = Math.max(0, Math.floor((minx - x0) / CELL)), i1 = Math.min(NC - 1, Math.floor((maxx - x0) / CELL));
      const j0 = Math.max(0, Math.floor((minz - z0) / CELL)), j1 = Math.min(NC - 1, Math.floor((maxz - z0) / CELL));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) (t[j * NC + i] ||= []).push(o);
    };
    const m = 14; // crowns overhang their trunk's forest cell by at most this
    const fi0 = Math.floor((x0 - m) / FOREST_GRID), fi1 = Math.floor((x0 + TILE + m) / FOREST_GRID);
    const fj0 = Math.floor((z0 - m) / FOREST_GRID), fj1 = Math.floor((z0 + TILE + m) / FOREST_GRID);
    for (let fj = fj0; fj <= fj1; fj++)
      for (let fi = fi0; fi <= fi1; fi++)
        this.forestCell(fi, fj, (c) => {
          if (c.cx + c.rh < x0 || c.cx - c.rh > x0 + TILE || c.cz + c.rh < z0 || c.cz - c.rh > z0 + TILE) return;
          put(c, c.cx - c.rh, c.cx + c.rh, c.cz - c.rh, c.cz + c.rh);
        });
    for (const o of this.statics) {
      if (o.x + o.r < x0 || o.x - o.r > x0 + TILE || o.z + o.r < z0 || o.z - o.r > z0 + TILE) continue;
      put(o, o.x - o.r, o.x + o.r, o.z - o.r, o.z + o.r);
    }
    this.tiles.set(key, t);
    if (this.tiles.size > 96) this.trim();
    return t;
  }

  // drop the tiles (and crown records) far from the population centre
  trim() {
    const c = this.center || { x: 0, z: 0 };
    for (const [k, t] of this.tiles) {
      const ti = Math.floor(k / 1024) - 128, tj = (k % 1024) - 128;
      if (Math.hypot((ti + 0.5) * TILE - c.x, (tj + 0.5) * TILE - c.z) > 330) this.tiles.delete(k);
    }
    if (this.crowns.size > 6000) {
      for (const [i, cr] of this.crowns) if (Math.hypot(cr.x - c.x, cr.z - c.z) > 330) this.crowns.delete(i);
    }
  }

  // highest crown or roof over (x, z), −Infinity in the open
  obstacleTop(x, z) {
    const ti = Math.floor(x / TILE), tj = Math.floor(z / TILE);
    const t = this.tile(ti, tj);
    const list = t[Math.floor((z - tj * TILE) / CELL) * NC + Math.floor((x - ti * TILE) / CELL)];
    if (!list) return -Infinity;
    let top = -Infinity;
    for (const o of list) {
      if (o.static) {
        if ((x - o.x) ** 2 + (z - o.z) ** 2 < o.r * o.r && o.top > top) top = o.top;
        continue;
      }
      const dx = x - o.cx, dz = z - o.cz, d2 = dx * dx + dz * dz, r2 = o.rh * o.rh;
      if (d2 >= r2) continue;
      const h = o.cy + o.ry * Math.sqrt(1 - d2 / r2);
      if (h > top) top = h;
    }
    return top;
  }

  // no crown or roof over a spot (within ~2.5 m): a flock can come down onto it
  openSky(x, z, gy) {
    const lim = gy + 1.3;
    if (this.obstacleTop(x, z) > lim) return false;
    for (const [dx, dz] of RING) if (this.obstacleTop(x + dx, z + dz) > lim) return false;
    return true;
  }

  // world perches of a crown (stable objects: occupancy and the cached approach plans hang on them)
  treePerches(c, tiers) {
    const key = tiers.join(',');
    c.perches ||= {};
    if (c.perches[key]) return c.perches[key];
    let P = this.vPerch.get(c.vi);
    if (!P) this.vPerch.set(c.vi, (P = crownPerches(c.v)));
    const out = [];
    for (const tier of tiers)
      (P[tier] || []).forEach((p, k) => {
        const w = toWorld(c, p, {});
        w.kind = 'tree';
        w.key = `t${c.i}:${tier[0]}${k}`;
        w.tree = { bx: c.x, bz: c.z, h: p.h, w: p.w, ph: p.ph, cph: c.cph };
        out.push(w);
      });
    c.perches[key] = out;
    return out;
  }

  // A tree for a flock: crows want a tall, open top away from the threat; small birds the nearest low cover (a shrub, a
  // small tree) away from it. Trees are sampled around random points of the ring rMin..rMax.
  findTree(sp, x, z, o) {
    if (!this.forest) return null;
    const crow = sp.name === 'crow', cover = !!o.cover;
    let best = null, bs = -Infinity;
    const seen = new Set();
    const tries = cover ? 14 : 10;
    for (let k = 0; k < tries; k++) {
      const a = this.rng() * Math.PI * 2, r = o.rMin + (o.rMax - o.rMin) * Math.sqrt(this.rng());
      const px = x + Math.sin(a) * r, pz = z + Math.cos(a) * r;
      this.forestCell(Math.floor(px / FOREST_GRID), Math.floor(pz / FOREST_GRID), (c) => {
        if (seen.has(c.i)) return;
        seen.add(c.i);
        const d = Math.hypot(c.x - x, c.z - z);
        if (d < o.rMin || d > o.rMax) return;
        const h = c.top - c.y;
        if (cover ? !c.shrub && h > 15 : c.shrub || h < (crow ? 6 : 3)) return;
        if (o.flee && !awayFrom(x, z, o.away, c.x, c.z)) return;
        let s = this.rng() * 0.9;
        if (o.away) {
          const da = Math.hypot(c.x - o.away.x, c.z - o.away.z);
          if (da < (crow ? 22 : 9)) return;
          s += Math.min(da, 60) * 0.03;
        }
        if (cover) s += (c.shrub ? 1.2 : 0.3) - d * 0.03 - h * 0.04;
        else if (crow) s += (CROW_PREF[c.kind] || 0) + Math.min(h, 24) * 0.05;
        if (s > bs) (bs = s), (best = c);
      });
    }
    if (!best) return null;
    let perches = this.treePerches(best, o.tiers || sp.perchTiers);
    // a flock bigger than one crown's perches spreads to the neighbouring crowns
    if (perches.length < o.count) {
      perches = perches.slice();
      this.forestCell(Math.floor(best.x / FOREST_GRID), Math.floor(best.z / FOREST_GRID), (c) => {
        if (c === best || perches.length >= o.count * 1.5 || Math.hypot(c.x - best.x, c.z - best.z) > (crow ? 14 : 8)) return;
        if (cover ? !c.shrub && c.top - c.y > 15 : c.shrub) return;
        perches.push(...this.treePerches(c, o.tiers || sp.perchTiers));
      });
    }
    return { x: best.x, z: best.z, perches };
  }

  // ------------------------------------------------------------------------------------------------ statics
  buildStatics() {
    const g = this.game, out = [];
    for (const c of g.colliders.items) {
      if (c.tag === 'tree') continue;
      const gy = this.terrain.heightAt(c.x, c.z);
      let top = Number.isFinite(c.top) ? c.top : TAG_HEIGHT[c.tag] !== undefined ? gy + (c.tag === 'torii' && c.r < 0.2 ? 1.8 : TAG_HEIGHT[c.tag]) : null;
      if (top === null || top - gy < 1.4) continue;
      out.push({ static: true, x: c.x, z: c.z, r: c.type === 'circle' ? c.r + 0.3 : c.bound + 0.3, top });
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------------ ground
  // Candidate foraging places, bucketed in 64 m tiles: along the paths (every 5 m), the shrine stairs, grazed lawns,
  // the beach.
  buildGround() {
    const cands = [];
    PATHS.forEach((pts, pi) => {
      const hw = PATH_INFO[pi].width * 0.5;
      let acc = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const l = Math.hypot(b.x - a.x, b.z - a.z);
        if (l < 1e-3) continue;
        const tx = (b.x - a.x) / l, tz = (b.z - a.z) / l;
        for (; acc < l; acc += 5) cands.push({ x: a.x + tx * acc, z: a.z + tz * acc, tx, tz, hw, kind: 'path' });
        acc -= l;
      }
    });
    const sh = POI.shrine, sb = sh.stairsBase, st = sh.stairsTop;
    const sl = Math.hypot(st.x - sb.x, st.z - sb.z);
    for (let s = 3; s < sl - 2; s += 4) cands.push({ x: sb.x + sh.stairDir.x * s, z: sb.z + sh.stairDir.z * s, tx: sh.stairDir.x, tz: sh.stairDir.z, hw: sh.stairHalf * 0.8, kind: 'stairs' });
    const lawns = GLOBAL_UNIFORMS.uLawn ? GLOBAL_UNIFORMS.uLawn.value : [];
    for (const L of lawns) {
      if (!(L.z > 0)) continue;
      for (let a = 0; a < 6; a++) {
        const r = L.z * 0.35;
        cands.push({ x: L.x + Math.sin(a) * r, z: L.y + Math.cos(a) * r, tx: 1, tz: 0, hw: L.z * 0.3, kind: 'lawn' });
      }
    }
    // the beach on the west coast
    for (let z = -WORLD.half + 6; z < WORLD.half; z += 12)
      for (let x = -WORLD.half + 6; x < -420; x += 12) {
        const s = this.terrain.surfaceAt(x, z);
        if (s.sand < 0.6 || s.wet > 0.4) continue;
        const h = this.terrain.heightAt(x, z);
        if (h < 0.9 || h > 6) continue;
        cands.push({ x, z, tx: 1, tz: 0, hw: 3, kind: 'sand' });
      }
    const buckets = new Map();
    for (const c of cands) {
      const k = tkey(Math.floor(c.x / TILE), Math.floor(c.z / TILE));
      let b = buckets.get(k);
      if (!b) buckets.set(k, (b = []));
      b.push(c);
    }
    return buckets;
  }

  lawnAt(x, z) {
    const lawns = GLOBAL_UNIFORMS.uLawn ? GLOBAL_UNIFORMS.uLawn.value : [];
    let l = 0;
    for (const L of lawns) {
      if (!(L.z > 0)) continue;
      l = Math.max(l, (1 - smooth(L.z * 0.6, L.z, Math.hypot(x - L.x, z - L.y))) * L.w);
    }
    return l;
  }

  // a spot a bird may stand on: dry ground above the sea, bare (a path, the stairs, a lawn, sand), not steep, outside
  // every collider (trunks, rocks, walls, buildings). Cached on a 0.5 m grid.
  groundOK(x, z) {
    const key = (Math.round(x * 2) + 8192) * 16384 + (Math.round(z * 2) + 8192);
    let v = this.okCache.get(key);
    if (v !== undefined) return v;
    v = this.computeGroundOK(x, z);
    if (this.okCache.size > 60000) this.okCache.clear();
    this.okCache.set(key, v);
    return v;
  }

  computeGroundOK(x, z) {
    const g = this.game;
    const h = g.groundAt(x, z);
    if (!(h > 0.6)) return false;
    const floor = h - this.terrain.heightAt(x, z) > 0.05; // stone steps, a platform
    if (!floor) {
      const s = this.terrain.surfaceAt(x, z);
      const bare = s.path > 0.45 || (s.sand > 0.5 && s.wet < 0.5) || this.lawnAt(x, z) > 0.6;
      if (!bare || s.rock > 0.6) return false;
    }
    const e = 0.4, lim = floor ? 0.55 : 0.3;
    if (Math.abs(g.groundAt(x + e, z) - g.groundAt(x - e, z)) > lim || Math.abs(g.groundAt(x, z + e) - g.groundAt(x, z - e)) > lim) return false;
    for (const c of g.colliders.nearby(x, z, 0.6)) {
      const m = 0.2;
      if (c.type === 'circle') {
        if ((x - c.x) ** 2 + (z - c.z) ** 2 < (c.r + m) ** 2) return false;
      } else {
        const dx = x - c.x, dz = z - c.z;
        const lx = dx * c.cos - dz * c.sin, lz = dx * c.sin + dz * c.cos;
        if (Math.abs(lx) < c.hw + m && Math.abs(lz) < c.hd + m) return false;
      }
    }
    return true;
  }

  // A foraging place for a flock: a candidate in the ring, preferred by kind, away from the threat, with `count` spots
  // on it (spread along the path, `spacing` apart, each one walkable and under open sky).
  findGround(sp, x, z, o) {
    const crow = sp.name === 'crow';
    const list = [];
    const ti0 = Math.floor((x - o.rMax) / TILE), ti1 = Math.floor((x + o.rMax) / TILE);
    const tj0 = Math.floor((z - o.rMax) / TILE), tj1 = Math.floor((z + o.rMax) / TILE);
    for (let tj = tj0; tj <= tj1; tj++)
      for (let ti = ti0; ti <= ti1; ti++) {
        const b = this.ground.get(tkey(ti, tj));
        if (!b) continue;
        for (const c of b) {
          const d = Math.hypot(c.x - x, c.z - z);
          if (d < o.rMin || d > o.rMax) continue;
          if (o.flee && !awayFrom(x, z, o.away, c.x, c.z)) continue;
          let s = (GROUND_PREF[c.kind] || [0, 0])[crow ? 0 : 1] + this.rng() * 1.2;
          if (o.away) {
            const da = Math.hypot(c.x - o.away.x, c.z - o.away.z);
            if (da < sp.fid.ground * 2.6 + 4) continue;
            s += Math.min(da, 60) * 0.02;
          }
          list.push([s, c]);
        }
      }
    list.sort((a, b) => b[0] - a[0]);
    for (const [, c] of list.slice(0, 8)) {
      const spots = this.spotsAt(c, sp, o.count);
      if (spots.length >= Math.min(o.count, 2)) return { x: c.x, z: c.z, tx: c.tx, tz: c.tz, kind: c.kind, perches: spots };
    }
    return null;
  }

  spotsAt(c, sp, n) {
    const out = [];
    const nx = -c.tz, nz = c.tx;
    const along = Math.max(1.2, n * sp.spacing * 0.8);
    for (let k = 0; k < n * 4 && out.length < n; k++) {
      const u = (this.rng() * 2 - 1) * along, v = (this.rng() * 2 - 1) * c.hw * 0.7;
      const x = c.x + c.tx * u + nx * v, z = c.z + c.tz * u + nz * v;
      if (out.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < sp.spacing * sp.spacing)) continue;
      if (!this.groundOK(x, z)) continue;
      const y = this.game.groundAt(x, z);
      if (!this.openSky(x, z, y)) continue;
      out.push({ x, y, z, kind: 'ground', key: `g${Math.round(x * 4)},${Math.round(z * 4)}` });
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------------ props
  // the kasagi of the big torii: perches spaced along the beam, at the exact height of its upswept top
  buildTorii(sites) {
    const out = [];
    const add = (name, T, ax, az, n) => {
      if (!T || !T.height || !T.span) return;
      const r = T.pillarR ?? Math.min(0.46, Math.max(0.2, T.span * 0.05));
      const half = (T.span + r * 10.5) / 2;
      const perches = [];
      for (let k = 0; k < n; k++) {
        const u = (k / (n - 1) - 0.5) * half * 1.3;
        perches.push({ x: T.x + ax * u, y: T.y + kasagiTop(T, u), z: T.z + az * u, kind: 'prop', tier: 'top', yaw: Math.atan2(-az, ax), nx: 0, nz: 0, key: `p${name}${k}` });
      }
      out.push({ x: T.x, z: T.z, perches });
    };
    const sh = sites.shrine;
    if (sh) {
      const st = sh.skyTorii;
      if (st && st.facing) add('sky', st, st.facing.z, -st.facing.x, 5);
      const gate = sh.torii && sh.torii[0];
      if (gate && sh.frame && sh.frame.X) add('gate', gate, sh.frame.X.x, sh.frame.X.z, 5);
    }
    const cl = sites.cliff && sites.cliff.torii;
    if (cl && cl.axis) add('cliff', cl, cl.axis.x, cl.axis.z, 3);
    return out;
  }

  findProp(sp, x, z, o) {
    const ok = this.props.filter((p) => {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < o.rMin || d > o.rMax) return false;
      if (o.flee && !awayFrom(x, z, o.away, p.x, p.z)) return false;
      return !o.away || Math.hypot(p.x - o.away.x, p.z - o.away.z) > 25;
    });
    if (!ok.length) return null;
    return ok[Math.floor(this.rng() * ok.length)];
  }

  // ------------------------------------------------------------------------------------------------ sway
  // A perch on a crown moves with it: the crown's sway (∝ height²) and the branch bob of trees/materials.js, from the
  // same wind field on the CPU. The per-tree phase hash is not bit-exact on the GPU, so only the mean bend is exact:
  // the oscillating part may run out of phase (a few cm on a big crown).
  sway(perch, out) {
    const t = perch.tree, wind = this.game.wind;
    if (!t || !wind) return null;
    const v2 = wind.sample(t.bx, t.bz, this._v2);
    const gl = Math.hypot(v2.x, v2.y), k = 1 / Math.max(gl, 0.15);
    const wdx = v2.x * k, wdz = v2.y * k;
    const gp = Math.max(wind.gustPeak(), 1e-3);
    const G = Math.min(gl, gp) + 0.2 * gp * Math.tanh(Math.max(gl - gp, 0) / (0.2 * gp));
    const T = wind.uniforms.uTime.value;
    const sway = G * (0.6 + 0.4 * Math.sin(T * 0.72 + t.cph)) + 0.08 * Math.sin(T * 1.9 + t.cph * 2);
    const bend = t.h * t.h * sway * 1.05;
    const B = Math.sin(T * (1.6 + 0.4 * Math.sin(t.ph * 3.1)) + t.ph + t.cph);
    const bob = t.w * G * 0.3;
    out.x = wdx * (bend + (0.55 + 0.45 * B) * bob);
    out.z = wdz * (bend + (0.55 + 0.45 * B) * bob);
    out.y = B * 0.16 * bob;
    return out;
  }
}

const RING = [[2.2, 0], [-2.2, 0], [0, 2.2], [0, -2.2]];
const range = (rng, a, b) => a + (b - a) * rng();
