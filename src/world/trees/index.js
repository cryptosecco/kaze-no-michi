import * as THREE from 'three';
import { SHOTS } from '../../core/shots.js';
import { POI } from '../Layout.js';
import { hash2 } from '../../core/math.js';
import { createLeafAtlas, createBarkTextures, createLitterTiles, CELLS, cellUV } from './textures.js';
import { buildTree } from './generator.js';
import { makeBarkMaterial, makeLeafMaterial, TREE_UNIFORMS } from './materials.js';
import { placeTrees, bakeLitterMask } from './placement.js';
import { Forest } from './Forest.js';
import { bakeImpostors, makeImpostorMesh } from './impostors.js';
import { FallingLeaves, LeafSwarm, Motes } from './Leaves.js';
import { Litter } from './Litter.js';
import { LeafCarpet } from './Carpet.js';

// Trees and forests of Hoshigashima (module entry, loaded by src/game/modules.js).
//   species: momiji maple, ginkgo, Japanese black pine, sugi cedar, bamboo, shrubs (azalea / evergreen)
//   LOD0 full trees → LOD1 light trees → baked impostor cards to ~2 km → terrain canopy colour beyond
//   + falling leaves, a wind-borne leaf swarm, sun motes, a continuous fallen-leaf carpet + close-up leaves;
//   trunk colliders.
// Public API (game.modules.trees):
//   records / shrubs / variants          placement records ({ x, y, z, species, scale, vi, hero })
//   nearest(x, z, r)                     trees within r: [{ x, z, species, radius, height, d }] (sorted)
//   clear(shapes)                        remove trees (and their impostors, colliders, leaf litter) inside
//                                        circles { x, z, r } or capsules { x, z, x2, z2, r }; returns count
//                                        (a shape with keepLitter: true leaves the fallen leaves, e.g. sight lines)
//   stats()                              counts and build time

const TQ = {
  low: { tree: { lod0: 45, lod1: 170, band: 10 }, shrub: { lod0: 26, lod1: 70, band: 8 }, imp: 1150, density: 0.85, fall: 500, swarm: 450, motes: 140, leaves: 14, leafHalf: 9, carpet: 64 },
  medium: { tree: { lod0: 65, lod1: 240, band: 12 }, shrub: { lod0: 36, lod1: 95, band: 10 }, imp: 1500, density: 0.95, fall: 900, swarm: 800, motes: 240, leaves: 22, leafHalf: 11, carpet: 88 },
  high: { tree: { lod0: 95, lod1: 320, band: 14 }, shrub: { lod0: 46, lod1: 120, band: 12 }, imp: 1900, density: 1, fall: 1500, swarm: 1200, motes: 380, leaves: 30, leafHalf: 14, carpet: 112 },
  ultra: { tree: { lod0: 125, lod1: 400, band: 16 }, shrub: { lod0: 62, lod1: 150, band: 14 }, imp: 2300, density: 1.05, fall: 2200, swarm: 1600, motes: 560, leaves: 40, leafHalf: 17, carpet: 136 },
};

export const SPECS = [
  { key: 'maple0', kind: 'maple', seed: 11 },
  { key: 'maple1', kind: 'maple', seed: 12 },
  { key: 'maple2', kind: 'maple', seed: 13 },
  { key: 'maple3', kind: 'maple', seed: 14 },
  { key: 'mapleHero', kind: 'maple', seed: 21, big: 1.3 },
  { key: 'ginkgo0', kind: 'ginkgo', seed: 31 },
  { key: 'ginkgo1', kind: 'ginkgo', seed: 32 },
  { key: 'ginkgo2', kind: 'ginkgo', seed: 33 },
  // tall columnar ginkgos of the camp valley; placed explicitly, never picked at random
  { key: 'ginkgoCol0', kind: 'ginkgo', seed: 34, shape: 'columnar' },
  { key: 'ginkgoCol1', kind: 'ginkgo', seed: 35, shape: 'columnar' },
  { key: 'ginkgoCol2', kind: 'ginkgo', seed: 36, shape: 'columnar' },
  { key: 'pine0', kind: 'pine', seed: 41 },
  { key: 'pine1', kind: 'pine', seed: 42 },
  { key: 'pine2', kind: 'pine', seed: 43 },
  { key: 'cedar0', kind: 'cedar', seed: 51 },
  { key: 'cedar1', kind: 'cedar', seed: 52 },
  { key: 'cedar2', kind: 'cedar', seed: 53 },
  { key: 'bamboo0', kind: 'bamboo', seed: 61 },
  { key: 'bamboo1', kind: 'bamboo', seed: 62 },
  { key: 'shrubRed', kind: 'shrub', seed: 71, cls: 'shrub', tint: [0.95, 0.13, 0.06] },
  { key: 'shrubGreen', kind: 'shrub', seed: 72, cls: 'shrub', tint: [0.2, 0.3, 0.1] },
  { key: 'shrubYellow', kind: 'shrub', seed: 73, cls: 'shrub', tint: [0.9, 0.55, 0.1] },
  // dark evergreen undergrowth along the shrine stairs
  { key: 'shrubDark', kind: 'shrub', seed: 74, cls: 'shrub', tint: [0.09, 0.13, 0.05] },
];

const BARK_TINT = { maple: 0xffffff, ginkgo: 0xffffff, pine: 0xffffff, cedar: 0xffffff, bamboo: 0xffffff, shrub: 0xb0a090 };

export async function install(game, ctx) {
  const t0 = performance.now();
  const q = TQ[game.quality.name] || TQ.high;
  const msaa = game.quality.msaa || 0;
  const aniso = Math.min(8, game.gl.capabilities.getMaxAnisotropy());

  // ---- textures ----
  const leafAtlas = createLeafAtlas(71, aniso); // { map, normalMap }: the leaf materials use both
  const atlas = leafAtlas.map; // colour atlas: impostor bake, falling leaves, litter
  TREE_UNIFORMS.uAtlasSize.value = atlas.userData.size;
  const bark = {};
  let s = 5;
  for (const k of ['maple', 'ginkgo', 'pine', 'cedar', 'bamboo']) bark[k] = createBarkTextures(k, s++, aniso);
  bark.shrub = bark.maple;

  // ---- variants ----
  const variants = SPECS.map((spec) => {
    const v = buildTree(spec.kind, spec.seed, spec.big || 1, { shape: spec.shape });
    v.key = spec.key;
    v.cls = spec.cls || 'tree';
    v.barkTint = BARK_TINT[spec.kind];
    if (spec.tint) {
      for (const lod of [v.lod0, v.lod1]) {
        const c = lod.leaves.getAttribute('color');
        for (let i = 0; i < c.count; i++) c.setXYZ(i, c.getX(i) * spec.tint[0], c.getY(i) * spec.tint[1], c.getZ(i) * spec.tint[2]);
        c.needsUpdate = true;
      }
    }
    v.castShadow = true;
    return v;
  });
  const byKey = Object.fromEntries(variants.map((v, i) => [v.key, i]));
  const bySpecies = {};
  variants.forEach((v, i) => {
    if (v.key === 'mapleHero' || v.key.startsWith('ginkgoCol')) return;
    (bySpecies[v.kind] ||= []).push(i);
  });

  // ---- materials (per LOD; cross-fade windows in world meters) ----
  const T = q.tree, S = q.shrub;
  const fade = {
    tree0: new THREE.Vector4(-2, -1, T.lod0 - T.band * 0.5, T.lod0 + T.band * 0.5),
    tree1: new THREE.Vector4(T.lod0 - T.band * 0.5, T.lod0 + T.band * 0.5, T.lod1 - T.band, T.lod1 + T.band),
    shrub0: new THREE.Vector4(-2, -1, S.lod0 - S.band * 0.5, S.lod0 + S.band * 0.5),
    shrub1: new THREE.Vector4(S.lod0 - S.band * 0.5, S.lod0 + S.band * 0.5, S.lod1 - S.band, S.lod1),
    imp: new THREE.Vector4(T.lod1 - T.band, T.lod1 + T.band, q.imp - 260, q.imp),
  };
  const barkMats = {};
  for (const k of ['maple', 'ginkgo', 'pine', 'cedar', 'bamboo', 'shrub']) {
    const f0 = k === 'shrub' ? fade.shrub0 : fade.tree0, f1 = k === 'shrub' ? fade.shrub1 : fade.tree1;
    barkMats[k] = [makeBarkMaterial(bark[k], f0, BARK_TINT[k], 'bark'), makeBarkMaterial(bark[k], f1, BARK_TINT[k], 'bark')];
  }
  // shrub cells carry no leaf normals: their materials skip the normal map
  const leafMats = {
    tree: [makeLeafMaterial(leafAtlas, fade.tree0, msaa), makeLeafMaterial(leafAtlas, fade.tree1, msaa)],
    shrub: [makeLeafMaterial({ map: atlas }, fade.shrub0, msaa), makeLeafMaterial({ map: atlas }, fade.shrub1, msaa)],
  };
  for (const v of variants) v.mats = { bark: barkMats[v.kind], leaves: leafMats[v.cls] };

  // ---- placement ----
  const { trees, shrubs } = placeTrees(game.terrain, { seed: game.seed, density: q.density });
  for (const r of trees) {
    if (r.variant && byKey[r.variant] !== undefined) r.vi = byKey[r.variant];
    else {
      const list = bySpecies[r.species];
      r.vi = list[Math.floor(hash2(Math.round(r.x * 10), Math.round(r.z * 10)) * list.length)];
    }
  }
  const toneKey = { red: 'shrubRed', green: 'shrubGreen', yellow: 'shrubYellow', dark: 'shrubDark' };
  for (const r of shrubs) r.vi = byKey[toneKey[r.tone] || 'shrubGreen'];

  // ---- forest (LOD0/LOD1 instancing) ----
  const forest = new Forest({ variants, records: trees.concat(shrubs), lod: { tree: T, shrub: S }, sunDir: game.lighting.sunDir });
  game.add(forest.group);

  // ---- impostors for every tree ----
  const baked = bakeImpostors(game.gl, variants, bark, atlas);
  const impEntries = trees
    .filter((r) => variants[r.vi].cls === 'tree')
    .map((r) => ({ x: r.x, y: r.y, z: r.z, scale: r.scale, variant: r.vi, flip: hash2(Math.round(r.x), Math.round(r.z * 3)) < 0.5, tint: 0.82 + 0.3 * hash2(Math.round(r.z), Math.round(r.x * 3)) }));
  const impostors = makeImpostorMesh(impEntries, baked.cells, baked.texture, fade.imp, msaa);
  game.add(impostors);

  // ---- litter mask, fallen leaves, falling leaves, motes ----
  const lm = bakeLitterMask(trees, (r) => variants[r.vi]);
  const litterMask = new THREE.DataTexture(lm.data, lm.res, lm.res, THREE.RGBAFormat, THREE.UnsignedByteType);
  litterMask.minFilter = litterMask.magFilter = THREE.LinearFilter;
  litterMask.generateMipmaps = false;
  litterMask.needsUpdate = true;
  const fall = new FallingLeaves({ count: q.fall, atlas, litterMask, cellMaple: cellUV(CELLS.mapleLeaf), cellGinkgo: cellUV(CELLS.ginkgoLeaf), msaa });
  game.add(fall.mesh);
  const leafCells = { atlas, litterMask, cellMaple: cellUV(CELLS.mapleLeaf), cellGinkgo: cellUV(CELLS.ginkgoLeaf), msaa };
  const swarm = new LeafSwarm({ count: q.swarm, ...leafCells });
  // the near one is dense enough that now and then a leaf crosses a few metres from the lens, large and out of focus,
  // and the field near the camera carries more of them
  const swarmNear = new LeafSwarm({ count: Math.round(q.swarm * 0.2), ...leafCells, box: [12, 5, 0.35, 1], seed: 733, name: 'leaf-swarm-near' });
  game.add(swarm.mesh);
  game.add(swarmNear.mesh);
  const carpet = new LeafCarpet({ litterMask, tiles: createLitterTiles(91, aniso), cells: q.carpet, fade: [q.carpet * 0.62, q.carpet * 0.95], msaa });
  game.add(carpet.mesh);
  const litter = new Litter({ atlas, litterMask, cellMaple: cellUV(CELLS.mapleLeaf), cellGinkgo: cellUV(CELLS.ginkgoLeaf), half: q.leafHalf, density: q.leaves, msaa });
  litter.uniforms.uLitBox.value.set(q.leafHalf, q.leafHalf * 0.6, q.leafHalf * 0.95, 0.12);
  game.add(litter.mesh);
  const motes = new Motes({ count: q.motes });
  game.add(motes.mesh);

  // ---- colliders (trunks; bamboo clumps are a dense cylinder) ----
  for (const r of trees) {
    const v = variants[r.vi];
    const rad = v.kind === 'bamboo' ? 1.1 * r.scale : Math.max(0.22, v.trunkR * r.scale * 1.1);
    game.colliders.addCircle(r.x, r.z, rad, { tag: 'tree' });
  }

  // ---- per-frame ----
  const cam = game.camera;
  game.addSystem({
    frame(dt) {
      TREE_UNIFORMS.uTreeCam.value.copy(cam.position);
      forest.update(cam);
      fall.update(dt, cam);
      swarm.update(dt, cam);
      swarmNear.update(dt, cam);
      motes.update(dt, cam);
      litter.update(cam);
      carpet.update(cam);
    },
  });
  game.onShot(() => {
    // the airborne leaves restart from the same place at every shot (their drift ran since the page loaded)
    fall.reset();
    swarm.reset();
    swarmNear.reset();
    motes.reset();
    TREE_UNIFORMS.uTreeCam.value.copy(cam.position);
    forest.update(cam, true);
    carpet.update(cam);
    litter.update(cam);
  });

  registerShots(game);

  const api = {
    records: trees,
    shrubs,
    variants,
    forest,
    impostors,
    // trees within r of (x, z): [{ x, z, species, radius, height }]
    nearest(x, z, r = 20) {
      const out = [];
      for (const t of trees) {
        const d = Math.hypot(t.x - x, t.z - z);
        if (d < r) out.push({ x: t.x, z: t.z, species: t.species, radius: variants[t.vi].radius * t.scale, height: variants[t.vi].height * t.scale, d });
      }
      return out.sort((a, b) => a.d - b.d);
    },
    clear(shapes) {
      return clearTrees(game, api, shapes, lm, litterMask);
    },
    stats() {
      return { trees: trees.length, shrubs: shrubs.length, impostors: impEntries.length, lod0: forest.stats.lod0, lod1: forest.stats.lod1, buildMs: Math.round(buildMs) };
    },
  };
  const buildMs = performance.now() - t0;
  const tri = (g) => (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  console.info(
    `[trees] ${trees.length} trees, ${shrubs.length} shrubs, ${variants.length} variants in ${buildMs.toFixed(0)} ms · tris/variant ` +
      variants.map((v) => `${v.key}:${tri(v.lod0.bark) + tri(v.lod0.leaves)}/${tri(v.lod1.bark) + tri(v.lod1.leaves)}`).join(' ')
  );
  return api;
}

// Remove trees inside circles { x, z, r } / capsules { x, z, x2, z2, r }: forest instances, impostors,
// trunk colliders and the leaf litter under them. Sight lines { x, y, z, x2, y2, z2, r } are 3D: only trees
// whose crown comes within r of the segment go (the litter stays).
function clearTrees(game, api, shapes, lm, litterMask) {
  if (!shapes || !shapes.length) return 0;
  const flat = shapes.filter((c) => c.y === undefined);
  const lines = shapes.filter((c) => c.y !== undefined);
  const inside = (x, z, pad = 0, list = flat) =>
    list.some((c) => {
      const r = c.r + pad;
      if (c.x2 === undefined) return (x - c.x) ** 2 + (z - c.z) ** 2 < r * r;
      const ax = c.x2 - c.x, az = c.z2 - c.z;
      const t = Math.max(0, Math.min(1, ((x - c.x) * ax + (z - c.z) * az) / (ax * ax + az * az || 1)));
      return (x - c.x - ax * t) ** 2 + (z - c.z - az * t) ** 2 < r * r;
    });
  const blocks = (px, py, pz, cr) =>
    lines.some((c) => {
      const ax = c.x2 - c.x, ay = c.y2 - c.y, az = c.z2 - c.z;
      const t = Math.max(0, Math.min(1, ((px - c.x) * ax + (py - c.y) * ay + (pz - c.z) * az) / (ax * ax + ay * ay + az * az || 1)));
      return Math.hypot(px - c.x - ax * t, py - c.y - ay * t, pz - c.z - az * t) < c.r + cr;
    });
  const f = api.forest;
  const crownBlocks = (i) => {
    const v = api.variants[f.vi[i]], s = f.s[i];
    return blocks(f.x[i] + v.crown.c.x * s, f.y[i] + v.crown.c.y * s, f.z[i] + v.crown.c.z * s, Math.max(v.crown.r.x, v.crown.r.y, v.crown.r.z) * s * 0.85);
  };
  let removed = 0;
  const gone = new Set(); // trunks removed by sight lines (their colliders go too)
  for (const [k, cell] of f.cells) {
    const keep = [];
    for (const i of cell) {
      if (inside(f.x[i], f.z[i])) removed++;
      else if (lines.length && crownBlocks(i)) {
        removed++;
        gone.add(`${f.x[i].toFixed(2)},${f.z[i].toFixed(2)}`);
      } else keep.push(i);
    }
    if (keep.length !== cell.length) f.cells.set(k, Int32Array.from(keep));
  }
  f._lastPos.set(1e9, 1e9, 1e9);
  const attr = api.impostors.geometry.getAttribute('aImpPos');
  const size = api.impostors.geometry.getAttribute('aImpSize');
  for (let i = 0; i < attr.count; i++) {
    const a = attr.array, o = i * 4;
    if (inside(a[o], a[o + 2])) a[o + 3] = 0;
    else if (lines.length && a[o + 3] > 0) {
      // impostor card (width, height, base offset) × scale ≈ the crown
      const w = size.array[o], h = size.array[o + 1], y0 = size.array[o + 2], s = a[o + 3];
      if (blocks(a[o], a[o + 1] + (y0 + h * 0.62) * s, a[o + 2], w * 0.4 * s)) a[o + 3] = 0;
    }
  }
  attr.needsUpdate = true;
  const C = game.colliders;
  const dead = new Set(C.items.filter((c) => c.tag === 'tree' && (inside(c.x, c.z) || gone.has(`${Math.fround(c.x).toFixed(2)},${Math.fround(c.z).toFixed(2)}`))));
  if (dead.size) {
    C.items = C.items.filter((c) => !dead.has(c));
    for (const [k, cell] of C.grid) C.grid.set(k, cell.filter((c) => !dead.has(c)));
  }
  // no leaf litter inside the cleared shapes (e.g. building floors)
  const floors = flat.filter((c) => !c.keepLitter);
  const res = lm.res, cell = 2048 / res;
  for (let j = 0; j < res && floors.length; j++)
    for (let i = 0; i < res; i++) {
      const x = -1024 + (i + 0.5) * cell, z = -1024 + (j + 0.5) * cell;
      if (inside(x, z, -1, floors)) {
        const o = (j * res + i) * 4;
        lm.data[o] = lm.data[o + 1] = lm.data[o + 2] = 0;
      }
    }
  litterMask.needsUpdate = true;
  return removed;
}

function registerShots(game) {
  const H = (x, z) => game.terrain.heightAt(x, z);
  SHOTS.T5_maple = {
    hours: 17.62,
    fov: 50,
    t0: 11,
    pose() {
      const tx = -76, tz = 86;
      const px = tx + 24, pz = tz - 15;
      return { pos: [px, H(px, pz) + 1.7, pz], target: [tx, H(tx, tz) + 5, tz] };
    },
  };
  SHOTS.T5_forest = {
    hours: 17.5,
    fov: 55,
    t0: 3,
    pose() {
      const px = POI.shrine.x + 18, pz = POI.shrine.z - 10;
      return { pos: [px, H(px, pz) + 22, pz], target: [140, 40, -140] };
    },
  };
  SHOTS.T5_ginkgo = {
    hours: 17.3,
    fov: 55,
    t0: 7,
    pose() {
      const px = 300, pz = -140, tx = 360, tz = -96;
      return { pos: [px, H(px, pz) + 1.7, pz], target: [tx, H(tx, tz) + 7, tz] };
    },
  };
  SHOTS.T5_bamboo = {
    hours: 17.45,
    fov: 55,
    t0: 5,
    pose() {
      const px = 26, pz = -222, tx = 31, tz = -320;
      return { pos: [px, H(px, pz) + 1.7, pz], target: [tx, H(tx, tz) + 4, tz] };
    },
  };
}
