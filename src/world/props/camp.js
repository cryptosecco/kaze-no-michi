import * as THREE from 'three';
import { POI, PATHS, PATH_INFO, campLocal } from '../Layout.js';
import { distToPolyline } from '../../core/math.js';
import { Builder, box, cylinder, sweep, boulder, lathe, mat, mul, rng, setFlag, shadeLocal } from './geom.js';
import { buildRoof } from './roof.js';
import { makeCampfire } from './fire.js';
import { BANNER_KINDS } from './textures.js';

// Bandit camp around an old farmhouse (S5_ginkgo): a minka under a huge layered thatch roof with a gabled
// entrance wing, worn banners strung on ropes and tall nobori fluttering in the wind, a rough palisade and crooked
// fences, crates, sheaves, bales and tarps, a dark lean-to, a spear rack and a smoking camp fire. The house front
// faces the S5 viewpoint (NNE); the bandits keep their fire in the open front yard; the spawn→camp path comes in
// through the palisade behind the house.

// Viewpoint 36 m in front of the farmhouse (the S5 framing) and the farmhouse centre (see Layout.js). Everything
// is built in the camp local frame, Layout.campLocal: +z into the house from the viewpoint, +x to the viewer's left.
export const CAMP_VIEW = POI.camp.view;
export const CAMP_HOUSE = POI.camp.house;
// the minka shows its long front and the entrance wing to the viewpoint, the hipped end three-quarters on the
// right; the eave corner on the left stays ~3 m clear of the hero ginkgo at local (11, −1)
const HOUSE_RY = -0.8;

// World → camp local frame (the inverse of Layout.campLocal): the fire is placed from POI.camp.fire, its only source.
export function campToLocal(x, z) {
  const f = (POI.camp.facing * Math.PI) / 180;
  const Zx = -Math.sin(f), Zz = Math.cos(f);
  const dx = x - CAMP_HOUSE.x, dz = z - CAMP_HOUSE.z;
  return { x: Zz * dx - Zx * dz, z: Zx * dx + Zz * dz };
}

// Strung banner lines (maku) in the camp local frame: end posts a, b and the prints hung along the rope.
// scripts/camp.test.mjs keeps every banner clear of the fire (not over it, nor right behind its flame in the S5 view).
export const MAKU_BANNER = { w: 1.75, h: 2.9 };
export const CAMP_MAKU = [
  // left: from the frame's left edge up to the fire's sight line, then a short line behind the samurai's place in
  // the S5 view (the smoke rises in the gap between them, in front of a dark lean-to)
  { a: [26, -3.2], b: [15.2, -5.3], kinds: [1, 0, 1, 2, 0] },
  { a: [12.6, -6.1], b: [7.4, -7.4], kinds: [0, 1] },
  // right: from the house's near corner to the frame's right edge, in front of the right ginkgo and the lean-to
  { a: [-5.2, -10.6], b: [-21.5, -7.4], kinds: [0, 1, 0, 2, 1, 0, 1, 0] },
];
// banner centres along a line (local x, z and the rope parameter t), evenly spaced between the posts
export function makuSpots(line) {
  const nb = line.kinds.length;
  const len = Math.hypot(line.b[0] - line.a[0], line.b[1] - line.a[1]);
  const mg = Math.min(0.3, 0.45 / len);
  return line.kinds.map((kind, k) => {
    const t = mg + ((k + 0.5) / nb) * (1 - 2 * mg);
    return { lx: line.a[0] + (line.b[0] - line.a[0]) * t, lz: line.a[1] + (line.b[1] - line.a[1]) * t, t, kind };
  });
}

export function buildCamp(game, mats) {
  const terrain = game.terrain;
  const rnd = rng(777);
  const b = new Builder('camp');
  // local frame: +z points away from the viewpoint (house back), −z = front yard; yaw turns local axes to world
  const yaw = (-POI.camp.facing * Math.PI) / 180;
  const W = campLocal;
  const G = (lx, lz) => {
    const p = W(lx, lz);
    return terrain.heightAt(p.x, p.z);
  };
  const F = (lx, lz, y, ry = 0) => {
    const p = W(lx, lz);
    return new THREE.Matrix4().multiplyMatrices(new THREE.Matrix4().makeTranslation(p.x, y ?? terrain.heightAt(p.x, p.z), p.z), new THREE.Matrix4().makeRotationY(yaw + ry));
  };
  // house local (x along the ridge, −z = front) → camp local
  const cH = Math.cos(HOUSE_RY), sH = Math.sin(HOUSE_RY);
  const H2L = (x, z) => ({ x: x * cH + z * sH, z: -x * sH + z * cH });
  let houseY = G(0, 0);
  for (let k = 0; k < 8; k++) houseY = Math.min(houseY, G(Math.cos(k * 0.785) * 8, Math.sin(k * 0.785) * 8));

  const minka = buildMinka(b, F(0, 0, houseY, HOUSE_RY), { groundY: houseY });
  const hc = W(0, 0);
  game.colliders.addBox(hc.x, hc.z, 7.0, 4.4, yaw + HOUSE_RY, { tag: 'minka' });
  {
    const c = H2L(minka.wing.x, minka.wing.z);
    const p = W(c.x, c.z);
    game.colliders.addBox(p.x, p.z, minka.wing.hw, minka.wing.hd, yaw + HOUSE_RY, { tag: 'minka' });
  }
  const info = { house: { ...hc, y: houseY, yaw: yaw + HOUSE_RY }, tents: [], fire: null, banners: [], yard: null };

  // ---- yard: camp fire with stone ring and logs, in the open left of the yard ----
  const fireL = campToLocal(POI.camp.fire.x, POI.camp.fire.z);
  const fy = G(fireL.x, fireL.z);
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2;
    const g = boulder(0.2 + rnd() * 0.08, 900 + k, { detail: 1 });
    b.add('stone', g, mul(F(fireL.x + Math.cos(a) * 0.85, fireL.z + Math.sin(a) * 0.85, fy + 0.03), mat(0, 0, 0, rnd(), rnd() * 6, 0)), { ground: fy, grimeH: 0.3, seed: k });
  }
  b.add('ash', cylinder(0.72, 0.8, 0.06, 14, 1), F(fireL.x, fireL.z, fy + 0.02), {});
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + 0.3;
    const log = cylinder(0.07, 0.09, 1.0, 8, 1);
    b.add('charcoal', log, mul(F(fireL.x, fireL.z, fy + 0.18), mat(Math.cos(a) * 0.18, 0.05, Math.sin(a) * 0.18, 1.05, -a + Math.PI / 2, 0, 1)), {});
  }
  b.add('embers', new THREE.SphereGeometry(0.32, 10, 6), mul(F(fireL.x, fireL.z, fy + 0.02), mat(0, 0, 0, 0, 0, 0, 1, 0.25, 1)), {});
  const fp = W(fireL.x, fireL.z);
  info.fire = { x: fp.x, y: fy, z: fp.z };
  info.yard = { ...W(0, -12), r: 9 };
  game.colliders.addCircle(fp.x, fp.z, 0.95, { tag: 'fire', top: fy + 0.4 });
  // firewood stacked by the fire, on the side away from the viewpoint
  for (let k = 0; k < 7; k++) {
    const row = k < 4 ? 0 : 1;
    const x = fireL.x + 1.9 + (row ? (k - 5) * 0.2 : (k - 1.5) * 0.2), z = fireL.z + 1.6;
    b.add('woodRaw', cylinder(0.08, 0.085, 1.1, 7, 1), mul(F(x, z, G(x, z) + 0.09 + row * 0.16), mat(0, 0, 0, Math.PI / 2, 0.35 + rnd() * 0.1, 0)), { ground: G(x, z), seed: 80 + k });
  }
  {
    const p = W(fireL.x + 1.9, fireL.z + 1.6);
    game.colliders.addCircle(p.x, p.z, 0.6, { tag: 'wood', top: fy + 0.4 });
  }
  // trodden yard: grass parted and short around the fire and the house front
  if (game.grass && typeof game.grass.setTrample === 'function') {
    const yd = W(3, -11);
    game.grass.setTrample([{ x: yd.x, z: yd.z, r: 12, s: 1 }, { x: hc.x, z: hc.z, r: 9, s: 1 }], 'camp');
  }
  // the camp ground is grazed short all the way to the arrival viewpoint (a lawn strewn with ginkgo
  // leaves, not the field's tall susuki)
  if (game.grass && typeof game.grass.setLawn === 'function') {
    const v = POI.camp.view;
    game.grass.setLawn([
      { x: hc.x, z: hc.z, r: 30, s: 1 },
      { x: (hc.x + v.x) / 2, z: (hc.z + v.z) / 2, r: 26, s: 1 },
      { x: v.x, z: v.z, r: 16, s: 1 },
    ]);
  }

  // ---- tents: behind the left banner line, dark weathered cloth, their long sides to the yard ----
  const tents = [{ l: [22, 2.2], ry: 1.75 }];
  for (const t of tents) {
    const ty = G(t.l[0], t.l[1]);
    addTent(b, mul(F(t.l[0], t.l[1], ty), mat(0, 0, 0, 0, t.ry, 0)), { groundY: ty, seed: t.l[0] * 7 });
    const p = W(t.l[0], t.l[1]);
    game.colliders.addBox(p.x, p.z, 1.5, 1.8, yaw + t.ry, { tag: 'tent' });
    info.tents.push({ ...p, y: ty });
  }
  // lean-tos of dark tarp (sagging shelters): behind the fire's smoke on the left, and behind the right
  // banner line
  for (const [lx, lz, ry, seed] of [[15.8, -1.2, 0.25, 6], [-15.2, -5.4, 0.2, 5]]) {
    const gy = G(lx, lz);
    addLeanTo(b, F(lx, lz, gy, ry), { groundY: gy, seed });
    const p = W(lx, lz);
    game.colliders.addBox(p.x, p.z, 2.7, 1.5, yaw + ry, { tag: 'tent' });
    info.tents.push({ ...p, y: gy });
  }

  // ---- strung banner lines (maku), left and right of the house at its front ----
  for (const ln of CAMP_MAKU) {
    const pa = { y: G(ln.a[0], ln.a[1]) }, pb = { y: G(ln.b[0], ln.b[1]) };
    const postH = 4.9;
    for (const [pt, gy] of [[ln.a, pa.y], [ln.b, pb.y]]) {
      b.add('woodRaw', cylinder(0.08, 0.11, postH + 0.4, 8, 2), mul(F(pt[0], pt[1], gy + postH / 2 - 0.2), mat(0, 0, 0, (rnd() - 0.5) * 0.06, 0, (rnd() - 0.5) * 0.06)), { ground: gy, seed: pt[0] });
      const p = W(pt[0], pt[1]);
      game.colliders.addCircle(p.x, p.z, 0.15, { tag: 'post' });
    }
    // rope with sag
    const A = W(ln.a[0], ln.a[1]), B = W(ln.b[0], ln.b[1]);
    const ropeY = (t) => pa.y + postH - 0.15 + (pb.y - pa.y) * t - Math.sin(Math.PI * t) * 0.45;
    const pts = [];
    const n = 18;
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      pts.push(new THREE.Vector3(A.x + (B.x - A.x) * t, ropeY(t), A.z + (B.z - A.z) * t));
    }
    b.add('straw', sweep(pts, { radius: 0.025, radial: 5 }), null, {});
    // hanging banners: big worn cloths with pleats, each hung a little differently
    const segYaw = Math.atan2(B.x - A.x, B.z - A.z) - Math.PI / 2;
    for (const [k, spot] of makuSpots(ln).entries()) {
      const t = spot.t;
      const px = A.x + (B.x - A.x) * t, pz = A.z + (B.z - A.z) * t;
      const py = ropeY(t);
      const bw = MAKU_BANNER.w * (0.94 + rnd() * 0.08), bh = MAKU_BANNER.h * (0.9 + rnd() * 0.12);
      const pg = new THREE.PlaneGeometry(bw, bh, 10, 14);
      const kind = spot.kind % BANNER_KINDS;
      const uv = pg.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) uv.setX(i, (kind + 0.01 + uv.getX(i) * 0.98) / BANNER_KINDS);
      // pleats that deepen toward the free hem, a belly in the wind and a slight twist
      const pos = pg.getAttribute('position');
      const ph = rnd() * 6.28, folds = 2.2 + rnd() * 1.3, belly = 0.08 + rnd() * 0.1;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i);
        const d = (bh / 2 - y) / bh; // 0 at the rope → 1 at the hem
        const z = Math.sin((x / bw) * Math.PI * 2 * folds + ph) * (0.03 + 0.07 * d) + belly * Math.sin(Math.PI * (x / bw + 0.5)) * d;
        pos.setXYZ(i, x + Math.sin(ph + d * 2) * 0.04 * d, y, z);
      }
      pg.computeVertexNormals();
      setFlag(pg, (x, y) => Math.min(1, (bh / 2 - y) / bh) * 0.9 + 0.1, k * 1.7 + t * 5);
      const M = new THREE.Matrix4().multiplyMatrices(new THREE.Matrix4().makeTranslation(px, py - bh / 2 - 0.02, pz), new THREE.Matrix4().makeRotationY(segYaw + (rnd() - 0.5) * 0.12));
      b.add('banner', pg, M, { flag: true });
      info.banners.push({ x: px, y: py, z: pz });
    }
  }

  // ---- nobori: tall vertical banners on L-poles where the path from the spawn comes in (behind the house) ----
  const nobori = [[-9, 14, 0], [-3.5, 18.5, 2]];
  for (const [lx, lz, kind] of nobori) {
    const gy = G(lx, lz);
    const poleH = 5.6;
    b.add('woodRaw', cylinder(0.05, 0.065, poleH, 8, 2), F(lx, lz, gy + poleH / 2 - 0.15), { ground: gy });
    b.add('woodRaw', cylinder(0.035, 0.035, 0.9, 6, 1), mul(F(lx, lz, gy + poleH - 0.35), mat(0.45, 0, 0, 0, 0, Math.PI / 2)), {});
    const bw = 0.85, bh = 3.6;
    const pg = new THREE.PlaneGeometry(bw, bh, 6, 12);
    const uv = pg.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setX(i, (kind + 0.01 + uv.getX(i) * 0.98) / BANNER_KINDS);
    setFlag(pg, (x) => Math.min(1, (x + bw / 2) / bw) * 0.95 + 0.05, lx * 0.3);
    b.add('banner', pg, mul(F(lx, lz, gy + poleH - 0.4 - bh / 2), mat(bw / 2 + 0.04, 0, 0, 0, 0.35, 0)), { flag: true });
    const p = W(lx, lz);
    game.colliders.addCircle(p.x, p.z, 0.12, { tag: 'post' });
  }

  // ---- palisade arc behind the house, rough sharpened stakes with rails (a narrow back gate + the path gap) ----
  const pal = [];
  const onPath = (x, z, m) => PATHS.some((p, i) => distToPolyline(x, z, p) < PATH_INFO[i].width * 0.5 + m);
  for (let a = -0.95; a <= 0.95; a += 0.028) {
    if (Math.abs(a - 0.35) < 0.07) continue; // back gate
    const r = 23 + Math.sin(a * 5) * 0.8;
    const lx = Math.sin(a) * r, lz = Math.cos(a) * r * 0.85 + 2;
    const wp = W(lx, lz);
    if (onPath(wp.x, wp.z, 1.6)) continue; // the path from the spawn comes in through here
    pal.push([lx, lz]);
  }
  for (let k = 0; k < pal.length; k++) {
    const [lx, lz] = pal[k];
    const gy = G(lx, lz);
    const h = 2.1 + rnd() * 0.6;
    const r0 = 0.08 + rnd() * 0.04;
    b.add('woodRaw', cylinder(r0 * 0.9, r0, h, 7, 2), mul(F(lx, lz, gy + h / 2 - 0.3), mat(0, 0, 0, (rnd() - 0.5) * 0.08, 0, (rnd() - 0.5) * 0.08)), { ground: gy, seed: k });
    b.add('woodRaw', new THREE.ConeGeometry(r0 * 0.9, 0.35, 7), F(lx, lz, gy + h - 0.3 + 0.17), {});
  }
  for (let k = 0; k < pal.length - 1; k++) {
    const [ax, az] = pal[k], [bx, bz] = pal[k + 1];
    if (Math.hypot(bx - ax, bz - az) > 1.5) continue;
    for (const hy of [0.6, 1.4]) {
      const A = W(ax, az), B = W(bx, bz);
      const gy = (G(ax, az) + G(bx, bz)) / 2;
      b.add('woodRaw', sweep([new THREE.Vector3(A.x, gy + hy, A.z), new THREE.Vector3(B.x, gy + hy, B.z)], { radius: 0.035, radial: 5 }), null, {});
    }
    const A = W((ax + bx) / 2, (az + bz) / 2);
    game.colliders.addCircle(A.x, A.z, 0.45, { tag: 'palisade' });
  }

  // ---- crooked fences of weathered stakes and pickets: across the right of the yard in front of the house
  //      and behind the house, clear of the roof eave ----
  const fences = [
    [[-2.8, -16.2], [-17, -14.2]],
    [[-5, 10.5], [5, 11.5]],
  ];
  for (const [a, c] of fences) addFence(b, game, { F, G, W, rnd }, a, c);

  // ---- clutter: crates (some stacked, some under tarps), barrels, straw bales, sheaves, spear rack ----
  // the S5 foreground (crates by the fire on the left, a big box and crates at the fence) + some by the house
  // [lx, lz, index of the crate it is stacked on]
  const crates = [
    [8.2, -18.8], [9.5, -18.2], [7.1, -19.5], [8.25, -18.75, 0], // foreground left, one stacked
    [-3.9, -15.3], [-4.9, -15.7], [-4.4, -15.5, 4], // at the right fence
    [9.4, -4.3], [10.1, -3.6], // left of the entrance wing
    [-8.2, -5.8], [11, 4],
    [-13.3, -6.4], [-14.1, -6.0], [-13.7, -6.2, 11], // under the lean-to, under a tarp
    [-10.4, -7.9], [-11.2, -7.5], // tarp-covered pile by the right banners
  ];
  const crateTop = [];
  crates.forEach(([lx, lz, on], k) => {
    const up = on !== undefined;
    const s = up ? 0.58 : 0.62 + rnd() * 0.3;
    const gy = G(lx, lz);
    const y0 = up ? crateTop[on] + 0.06 : gy;
    crateTop[k] = y0 + s * 0.8;
    addCrate(b, mul(F(lx, lz, y0 + s * 0.4), mat(0, 0, 0, 0, rnd() * 1.2, 0)), s, { ground: gy, seed: 50 + k });
    if (!up) {
      const p = W(lx, lz);
      game.colliders.addCircle(p.x, p.z, s * 0.6, { tag: 'crate', top: gy + s * 0.8 });
    }
  });
  // a big weathered chest in the foreground, left of the bales
  {
    const lx = 1.6, lz = -17.8;
    const gy = G(lx, lz);
    const R = F(lx, lz, gy, 0.25);
    b.add('woodAged', box(1.7, 0.95, 1.05, { grain: 'x' }), mul(R, mat(0, 0.47, 0)), { ground: gy, seed: 91 });
    for (const sx of [-0.8, 0.8]) b.add('woodDark', box(0.1, 1.0, 1.1, { grain: 'y' }), mul(R, mat(sx, 0.49, 0)), { ground: gy, seed: 92 });
    b.add('woodDark', box(1.75, 0.08, 1.1, { grain: 'x' }), mul(R, mat(0, 0.96, 0)), { ground: gy, seed: 93 });
    const p = W(lx, lz);
    game.colliders.addBox(p.x, p.z, 0.9, 0.58, yaw + 0.25, { tag: 'crate', top: gy + 1.0 });
  }
  // tarps thrown over two of the piles
  addTarp(b, F(-10.8, -7.7, G(-10.8, -7.7), 0.45), { w: 1.9, d: 1.1, h: Math.max(crateTop[14], crateTop[15]) - G(-10.8, -7.7) + 0.02, seed: 3 });
  addTarp(b, F(-13.7, -6.2, G(-13.7, -6.2), 0.5), { w: 1.7, d: 1.1, h: crateTop[13] - G(-13.7, -6.2) + 0.02, seed: 4 });
  const barrels = [[10.9, -2.6], [-9.2, -4.7], [-9.9, -5.6], [-14.1, -3.3]];
  barrels.forEach(([lx, lz], k) => {
    const gy = G(lx, lz);
    b.add('woodRaw', cylinder(0.34, 0.3, 0.8, 12, 2), F(lx, lz, gy + 0.4), { ground: gy, seed: 60 + k });
    for (const hy of [0.18, 0.62]) b.add('iron', cylinder(0.345, 0.345, 0.05, 12, 1), F(lx, lz, gy + hy), {});
    const p = W(lx, lz);
    game.colliders.addCircle(p.x, p.z, 0.36, { tag: 'barrel', top: gy + 0.8 });
  });
  const bales = [[-6.6, 6.6, 0.2], [-5.4, 7.1, 1.4], [-0.6, -16, 0.3], [-1.9, -16.7, 1.2], [5.6, -17.2, 0.9]];
  bales.forEach(([lx, lz, ry], k) => {
    const gy = G(lx, lz);
    const g = cylinder(0.42, 0.42, 1.05, 14, 1);
    b.add('straw', g, mul(F(lx, lz, gy + 0.4), mat(0, 0, 0, 0, ry, Math.PI / 2)), { ground: gy, seed: 70 + k });
    const p = W(lx, lz);
    game.colliders.addCircle(p.x, p.z, 0.55, { tag: 'bale', top: gy + 0.84 });
  });
  // rice-straw sheaves standing in stooks: by the right fence, by the lean-to and left of the crates by the fire
  const stooks = [[-8.6, -13.1], [-11.2, -12.6], [-16.8, -8.4], [11.8, -16.4], [4.4, -15.6]];
  stooks.forEach(([lx, lz], k) => {
    const n = 3 + (k % 2);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + k;
      const x = lx + Math.cos(a) * 0.32, z = lz + Math.sin(a) * 0.32;
      const gy = G(x, z);
      // ry = π/2 − a turns the sheaf's lean (toward its local −z) to the stook's centre
      addSheaf(b, mul(F(x, z, gy - 0.02, Math.PI / 2 - a), mat(0, 0, 0, -0.16, 0, 0)), 0.95 + rnd() * 0.25, { ground: gy, seed: 100 + k * 5 + i });
    }
    const p = W(lx, lz);
    game.colliders.addCircle(p.x, p.z, 0.6, { tag: 'sheaf', top: G(lx, lz) + 1.1 });
  });
  // spear rack left of the fire, facing the viewpoint (clear of the bandits' places around the fire and of the S5
  // hero ginkgos)
  {
    const lx = 17.5, lz = -15;
    const gy = G(lx, lz);
    const R = F(lx, lz, gy, 0.5);
    for (const sx of [-0.9, 0.9]) b.add('woodRaw', box(0.1, 1.5, 0.1, { grain: 'y' }), mul(R, mat(sx, 0.75, 0)), { ground: gy });
    b.add('woodRaw', box(1.95, 0.08, 0.1, { grain: 'x' }), mul(R, mat(0, 1.35, 0)), {});
    b.add('woodRaw', box(1.95, 0.08, 0.1, { grain: 'x' }), mul(R, mat(0, 0.35, 0.12)), {});
    for (let k = 0; k < 5; k++) {
      const x = -0.7 + k * 0.35;
      b.add('woodDark', cylinder(0.022, 0.025, 2.7, 6, 1), mul(R, mat(x, 1.3, 0.06, -0.1, 0, 0)), {});
      b.add('iron', new THREE.ConeGeometry(0.035, 0.28, 6), mul(R, mat(x, 2.78, -0.08, -0.1, 0, 0)), {});
    }
    const p = W(lx, lz);
    game.colliders.addBox(p.x, p.z, 1.0, 0.25, yaw + 0.5, { tag: 'rack' });
  }

  const group = b.build(mats);
  // the fire (animated shaders) lives outside the merged static meshes
  const fire = makeCampfire({ height: 9, intensity: 3.0 }); // a low drifting plume
  fire.position.set(fp.x, fy + 0.05, fp.z);
  fire.children[1].position.y = -1.4;
  group.add(fire);
  group.userData.info = info;
  return group;
}

// Minka farmhouse: raised timber frame on stone footings, plank and earth walls, a gabled entrance wing over the
// dark doma, engawa veranda, and a huge steep irimoya thatched roof: layered courses, a thick ragged eave with loose
// straw, a heavy ridge with a lattice of crossed sticks. Returns the wing footprint (house local) for its collider.
function buildMinka(b, M, { groundY }) {
  const w = { ground: groundY, grimeH: 1.2 };
  const L = 13, D = 8, wallH = 2.55, floorH = 0.5;
  const xs = [-6.5, -3.25, 0, 3.25, 6.5], zs = [-4, 0, 4];
  // stone footings + posts
  for (const x of xs)
    for (const z of zs) {
      if (z === 0 && Math.abs(x) < 6) continue;
      b.add('stone', box(0.5, 0.35, 0.5, { grain: 'x' }), mul(M, mat(x, 0.1, z)), { ...w, grimeH: 0.3 });
      b.add('woodAged', box(0.24, wallH + floorH, 0.24, { grain: 'y' }), mul(M, mat(x, (wallH + floorH) / 2 + 0.25, z)), w);
    }
  // sill + head beams
  for (const z of [-4, 4]) {
    b.add('woodAged', box(L + 0.3, 0.28, 0.22, { grain: 'x' }), mul(M, mat(0, floorH + 0.1, z)), w);
    b.add('woodAged', box(L + 0.6, 0.32, 0.26, { grain: 'x' }), mul(M, mat(0, floorH + wallH + 0.1, z)), w);
  }
  for (const x of [-6.5, 6.5]) {
    b.add('woodAged', box(0.22, 0.28, D + 0.3, { grain: 'z' }), mul(M, mat(x, floorH + 0.1, 0)), w);
    b.add('woodAged', box(0.26, 0.32, D + 0.6, { grain: 'z' }), mul(M, mat(x, floorH + wallH + 0.1, 0)), w);
  }
  // walls. Front (−z): planks left, dark open entrance centre-left, paper/plank sliding panels right.
  const wallY = floorH + 0.25 + wallH / 2 - 0.1;
  const plank = (x0, x1, z, ry = 0, h = wallH, y = wallY) => {
    const n = Math.max(2, Math.round((x1 - x0) / 0.24));
    for (let k = 0; k < n; k++) {
      const x = x0 + ((x1 - x0) * (k + 0.5)) / n;
      const g = box((x1 - x0) / n - 0.012, h - 0.05, 0.05, { grain: 'y' });
      b.add('woodAged', g, mul(M, mat(ry ? z : x, y, ry ? x : z, 0, ry, 0)), { ...w, seed: k * 3 + x0 });
    }
  };
  plank(-6.4, -4.7, -3.95);
  // entrance (doma): the dark interior of the open doorway (no door leaf stands in it)
  b.add('woodDark', box(3.1, wallH, 0.05, { grain: 'y' }), mul(M, mat(-1.6, wallY - 0.15, -2.6)), { ...w, tint: [0.12, 0.12, 0.12] });
  // right: shoji panels over a plank dado
  for (let k = 0; k < 4; k++) {
    const x = 0.2 + k * 1.6 + 0.8;
    b.add('plaster', box(1.5, wallH * 0.62, 0.04, { grain: 'x' }), mul(M, mat(x, floorH + 0.25 + wallH * 0.62, -3.95)), { ...w, tint: [0.95, 0.9, 0.8] });
    for (let j = 1; j < 4; j++) b.add('woodAged', box(0.035, wallH * 0.62, 0.06, { grain: 'y' }), mul(M, mat(x - 0.75 + j * 0.375, floorH + 0.25 + wallH * 0.62, -3.97)), w);
    for (let j = 1; j < 5; j++) b.add('woodAged', box(1.5, 0.035, 0.06, { grain: 'x' }), mul(M, mat(x, floorH + 0.25 + wallH * 0.31 + j * wallH * 0.124, -3.97)), w);
  }
  plank(0.15, 6.4, -3.9);
  // sides: earth plaster over a plank wainscot; back: planks
  for (const sx of [-1, 1]) {
    b.add('earthWall', box(0.12, wallH * 0.62, D - 0.3, { grain: 'z' }), mul(M, mat(sx * 6.45, floorH + 0.25 + wallH * 0.62, 0)), w);
    plank(-3.85, 3.85, sx * 6.54, Math.PI / 2);
  }
  plank(-6.4, 6.4, 3.95);
  // engawa veranda along the right half of the front, beside the entrance wing
  b.add('woodAged', box(4.2, 0.1, 1.0, { grain: 'x' }), mul(M, mat(4.3, floorH + 0.15, -4.55)), w);
  for (const x of [2.3, 4.3, 6.3]) b.add('woodAged', box(0.12, floorH + 0.1, 0.12, { grain: 'y' }), mul(M, mat(x, (floorH + 0.1) / 2, -4.95)), w);
  b.add('stone', box(1.0, 0.25, 0.5, { grain: 'x' }), mul(M, mat(4.3, 0.1, -5.3)), { ...w, grimeH: 0.2 });

  // ---- entrance wing: a gabled thatched porch-room over the doma, its ridge running out
  //      of the main roof's front slope, the gable end a lattice of slats over a dark doorway ----
  const wx = -1.6, wz0 = -4.0, wz1 = -8.5, whw = 3.0; // walls: x ∈ wx ± whw, z from the front wall out to wz1
  const wEave = 2.45, wH = 5.0, wThick = 0.6;
  for (const sx of [-1, 1]) {
    const x = wx + sx * whw;
    b.add('stone', box(0.4, 0.3, 0.4, { grain: 'x' }), mul(M, mat(x, 0.08, wz1)), { ...w, grimeH: 0.3 });
    b.add('woodAged', box(0.22, 2.2, 0.22, { grain: 'y' }), mul(M, mat(x, 1.15, wz1)), w);
    plank(wz1 + 0.12, wz0, x, Math.PI / 2, 2.0, 1.05);
  }
  b.add('woodAged', box(2 * whw + 0.4, 0.26, 0.24, { grain: 'x' }), mul(M, mat(wx, 2.1, wz1)), w);
  plank(wx - whw + 0.1, wx - 1.25, wz1 + 0.02, 0, 2.0, 1.05);
  plank(wx + 1.25, wx + whw - 0.1, wz1 + 0.02, 0, 2.0, 1.05);
  b.add('woodDark', box(2.5, 2.0, 0.05, { grain: 'y' }), mul(M, mat(wx, 1.0, wz1 + 0.9)), { ...w, tint: [0.1, 0.1, 0.1] });
  const wr = { W: 7.1, D: 2 * whw + 1.6, H: wH, type: 'gable', pow: 0.95, lift: 0.1, thick: wThick, segE: 12, segS: 9, jitter: 0.1, seed: 23, courses: [{ s0: 0.16, span: 0.2, rise: 0.22 }], rag: 0.22, fringe: 0.32 };
  // gable: dark boards behind horizontal slats following the roof's underside
  const gTop = wEave + wH - wThick * 0.62;
  const gEdge = wEave + 0.55; // the roof's underside above the wing's side walls
  const gable = new THREE.BufferGeometry();
  gable.setAttribute('position', new THREE.Float32BufferAttribute([-whw, 2.2, 0, whw, 2.2, 0, whw, gEdge, 0, 0, gTop, 0, -whw, gEdge, 0], 3));
  gable.setAttribute('uv', new THREE.Float32BufferAttribute([-whw, 2.2, whw, 2.2, whw, gEdge, 0, gTop, -whw, gEdge], 2));
  gable.setIndex([0, 1, 2, 0, 2, 3, 0, 3, 4]);
  gable.computeVertexNormals();
  shadeLocal(gable, () => 0.55);
  b.add('woodDark', gable, mul(M, mat(wx, 0, wz1 - 0.02, 0, Math.PI, 0)), w);
  for (let y = 2.4; y < gTop - 0.15; y += 0.3) {
    const half = y <= gEdge ? whw : whw * (gTop - y) / (gTop - gEdge);
    if (half < 0.25) break;
    b.add('woodAged', box(2 * half - 0.1, 0.075, 0.06, { grain: 'x' }), mul(M, mat(wx, y, wz1 - 0.07)), { ...w, seed: y * 10 });
  }
  b.add('woodAged', box(0.1, gTop - 2.3, 0.08, { grain: 'y' }), mul(M, mat(wx, (gTop + 2.3) / 2, wz1 - 0.1)), w);
  // wing roof: ridge along the house's z (the roof's local x), from the front gable into the main slope
  const wroof = buildRoof(wr);
  const WM = mul(M, mat(wx, wEave, (wz1 - 0.9 + wz0 + 1.5) / 2, 0, Math.PI / 2, 0)); // its back end buried in the main roof
  b.add('thatch', wroof.top, WM, { ...w, grimeH: 0 });
  b.add('woodAged', wroof.under, WM, { ...w, tint: [0.45, 0.4, 0.36] });
  b.add('thatchEdge', wroof.fascia, WM, { ...w, grimeH: 0 });
  if (wroof.hafu) b.add('thatchEdge', wroof.hafu, WM, { ...w, grimeH: 0 });
  if (wroof.fringe) b.add('thatchFringe', wroof.fringe, WM, {});
  b.add('thatch', cylinder(0.3, 0.3, wr.W + 0.2, 10, 1), mul(WM, mat(0, wH + 0.12, 0, 0, 0, Math.PI / 2)), { ...w, grimeH: 0 });
  for (let k = 0; k <= 4; k++) {
    const x = -wr.W / 2 + 0.4 + k * ((wr.W - 1.4) / 4);
    for (const s of [-1, 1]) b.add('woodDark', cylinder(0.04, 0.04, 1.0, 6, 1), mul(WM, mat(x, wH + 0.3, 0, s * 0.62, 0, 0)), w);
  }

  // ---- thatched irimoya roof: huge, steep, thick, in stepped courses with a ragged eave ----
  const ro = {
    W: L + 3.4, D: D + 3.4, H: 10.2, type: 'irimoya', pow: 0.9, lift: 0.18, thick: 0.95, gableLen: 8.6, gableOver: 0.35,
    segE: 24, segS: 14, jitter: 0.16, seed: 17, ridgeH: 0.55, ridgeW: 0.8, hipW: 0.6,
    // the eave hangs unevenly, bundle ends and loose straw well below its line
    courses: [{ s0: 0.07, span: 0.15, rise: 0.34 }, { s0: 0.27, span: 0.13, rise: 0.26 }], rag: 0.42, fringe: 0.6,
  };
  const roof = buildRoof(ro);
  const RM = mul(M, mat(0, floorH + wallH + 0.26, 0));
  b.add('thatch', roof.top, RM, { ...w, grimeH: 0 });
  b.add('woodAged', roof.under, RM, { ...w, tint: [0.5, 0.45, 0.4] });
  b.add('thatchEdge', roof.fascia, RM, { ...w, grimeH: 0 });
  if (roof.fringe) b.add('thatchFringe', roof.fringe, RM, {});
  if (roof.gableWall) {
    shadeLocal(roof.gableWall, () => 0.5);
    b.add('woodDark', roof.gableWall, RM, w);
  }
  if (roof.hafu) b.add('thatchEdge', roof.hafu, RM, { ...w, grimeH: 0 });
  if (roof.hips) b.add('thatch', roof.hips, RM, { ...w, grimeH: 0 });
  // ridge: fat thatch cap, a ladder of battens between two poles, crossed sticks (umanori) astride it and
  // taller crossed pairs at both ends
  const rl = roof.ridgeTo.x - roof.ridgeFrom.x;
  const RY = ro.H;
  b.add('thatch', cylinder(0.5, 0.5, rl + 1.0, 12, 1), mul(RM, mat(0, RY + 0.28, 0, 0, 0, Math.PI / 2, 1, 1, 0.9)), { ...w, grimeH: 0 });
  // the cap is straw bound in bundles: dark rope bands around it every ~0.9 m
  for (let x = -rl / 2 - 0.2; x <= rl / 2 + 0.21; x += 0.9) b.add('straw', cylinder(0.535, 0.535, 0.1, 12, 1), mul(RM, mat(x, RY + 0.28, 0, 0, 0, Math.PI / 2, 1, 1, 0.9)), { ...w, grimeH: 0, tint: [0.45, 0.4, 0.33] });
  b.add('thatch', box(rl + 0.9, 0.35, 1.25, { grain: 'z' }), mul(RM, mat(0, RY + 0.1, 0)), { ...w, grimeH: 0 });
  for (const z of [-0.32, 0.32]) b.add('woodDark', cylinder(0.055, 0.055, rl + 1.9, 8, 1), mul(RM, mat(0, RY + 0.82, z, 0, 0, Math.PI / 2)), w);
  for (let x = -rl / 2 - 0.6; x <= rl / 2 + 0.61; x += 0.46) b.add('woodDark', cylinder(0.04, 0.04, 0.95, 6, 1), mul(RM, mat(x, RY + 0.86, 0, Math.PI / 2, 0, 0)), w);
  const nX = Math.max(3, Math.round(rl / 1.1));
  for (let k = 0; k <= nX; k++) {
    const x = roof.ridgeFrom.x + (rl * k) / nX;
    for (const s of [-1, 1]) b.add('woodDark', cylinder(0.055, 0.055, 1.9, 6, 1), mul(RM, mat(x, RY + 0.6, 0, s * 0.62, 0, 0)), w);
  }
  for (const ex of [-1, 1]) {
    const x = ex * (rl / 2 + 0.55);
    for (const s of [-1, 1]) b.add('woodDark', cylinder(0.06, 0.07, 2.3, 6, 1), mul(RM, mat(x, RY + 0.95, 0, s * 0.5, 0, 0)), w);
  }
  return { wing: { x: wx, z: (wz0 + wz1) / 2, hw: whw + 0.15, hd: (wz0 - wz1) / 2 + 0.15 } };
}

// Crate: planked box with a lid and corner battens.
function addCrate(b, M, s, opts) {
  b.add('woodRaw', box(s, s * 0.8, s, { grain: 'x' }), M, opts);
  b.add('woodAged', box(s + 0.06, 0.06, s + 0.06, { grain: 'x' }), mul(M, mat(0, s * 0.4 + 0.02, 0)), opts);
  for (const [cx, cz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) b.add('woodAged', box(0.06, s * 0.8, 0.06, { grain: 'y' }), mul(M, mat((cx * s) / 2, 0, (cz * s) / 2)), opts);
}

// Standing sheaf of rice straw: a tied bundle, flared at the foot, loose at the top (strands run up the stalks).
function addSheaf(b, M, h, opts) {
  const prof = [[0.2, 0], [0.25, 0.06], [0.2, 0.32 * h], [0.11, 0.6 * h], [0.1, 0.66 * h], [0.15, 0.78 * h], [0.2, 0.95 * h], [0.15, 1.08 * h], [0.04, 1.14 * h]];
  b.add('thatch', lathe(prof, 9, opts.seed), M, { ...opts, tint: [1.35, 1.2, 0.95] });
  b.add('straw', cylinder(0.105, 0.11, 0.07, 9, 1), mul(M, mat(0, 0.63 * h, 0)), opts);
}

// Rustic fence of crooked stakes: posts of uneven height and lean, thinner pickets between them (some missing),
// two sagging rails per bay, one rail broken off and hanging.
function addFence(b, game, { F, G, W, rnd }, a, c) {
  const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
  const n = Math.max(2, Math.round(len / 2.0));
  const posts = [];
  for (let k = 0; k <= n; k++) {
    const t = Math.min(1, Math.max(0, (k + (k > 0 && k < n ? (rnd() - 0.5) * 0.3 : 0)) / n));
    const lx = a[0] + (c[0] - a[0]) * t, lz = a[1] + (c[1] - a[1]) * t;
    const gy = G(lx, lz);
    const h = 1.15 + rnd() * 0.5, r = 0.055 + rnd() * 0.035;
    const tilt = [(rnd() - 0.5) * 0.2, (rnd() - 0.5) * 0.2];
    b.add(rnd() < 0.3 ? 'woodRaw' : 'woodAged', cylinder(r * 0.8, r, h + 0.3, 7, 2), mul(F(lx, lz, gy + h / 2 - 0.15), mat(0, 0, 0, tilt[0], rnd() * 3, tilt[1])), { ground: gy, seed: k });
    const p = W(lx, lz);
    posts.push({ ...p, y: gy, lx, lz, h });
  }
  for (let k = 0; k < posts.length - 1; k++) {
    const A = posts[k], B = posts[k + 1];
    // pickets: irregular sticks every ~0.35 m
    const span = Math.hypot(B.lx - A.lx, B.lz - A.lz);
    const np = Math.max(1, Math.round(span / 0.36));
    for (let i = 1; i < np; i++) {
      if (rnd() < 0.18) continue; // gaps where a picket was lost
      const t = (i + (rnd() - 0.5) * 0.4) / np;
      const lx = A.lx + (B.lx - A.lx) * t, lz = A.lz + (B.lz - A.lz) * t;
      const gy = G(lx, lz);
      const h = 0.75 + rnd() * 0.65, r = 0.025 + rnd() * 0.02;
      b.add(rnd() < 0.4 ? 'woodRaw' : 'woodAged', cylinder(r * 0.7, r, h, 5, 1), mul(F(lx, lz, gy + h / 2 - 0.08), mat(0, 0, 0, (rnd() - 0.5) * 0.22, 0, (rnd() - 0.5) * 0.22)), { ground: gy, seed: k * 13 + i });
    }
    // rails: sagging, uneven; one bay has its upper rail broken and hanging down
    const broken = k === Math.floor(posts.length / 2) - 1;
    for (const [j, hy] of [[0, 0.42], [1, 0.95]]) {
      const ya = A.y + hy + (rnd() - 0.5) * 0.12, yb = B.y + hy + (rnd() - 0.5) * 0.12;
      let P0 = new THREE.Vector3(A.x, ya, A.z), P1 = new THREE.Vector3(B.x, yb, B.z);
      if (broken && j === 1) P1 = new THREE.Vector3(A.x + (B.x - A.x) * 0.7, B.y + 0.12, A.z + (B.z - A.z) * 0.7);
      const mid = P0.clone().lerp(P1, 0.5);
      mid.y -= 0.05 + rnd() * 0.05;
      b.add('woodAged', sweep([P0, mid, P1], { radius: 0.035 + rnd() * 0.015, radial: 5 }), null, {});
    }
    const m = { x: (A.x + B.x) / 2, z: (A.z + B.z) / 2 };
    game.colliders.addCircle(m.x, m.z, 0.5, { tag: 'fence', top: A.y + 1.0 });
  }
}

// Cloth thrown over a pile (w × d, h high): flat on top, falling down the sides in loose folds.
function addTarp(b, M, { w, d, h, seed }) {
  const r = rng(seed * 17 + 3);
  const ext = 0.75;
  const g = new THREE.PlaneGeometry(w + 2 * ext, d + 2 * ext, 14, 10);
  g.rotateX(-Math.PI / 2);
  const p = g.getAttribute('position');
  const ph = r() * 6.28;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    const ox = Math.max(0, Math.abs(x) - w / 2), oz = Math.max(0, Math.abs(z) - d / 2);
    const out = Math.hypot(ox, oz);
    const fall = Math.min(1, out / ext);
    const y = h + 0.03 - fall * fall * (h - 0.05) * (0.85 + 0.15 * Math.sin(x * 5 + z * 3 + ph));
    const pull = 1 - 0.55 * fall; // the cloth hangs down instead of sticking out
    p.setXYZ(i, Math.sign(x) * (Math.min(Math.abs(x), w / 2) + ox * pull), y + Math.sin(x * 7 + ph) * Math.sin(z * 6) * 0.025, Math.sign(z) * (Math.min(Math.abs(z), d / 2) + oz * pull));
  }
  g.computeVertexNormals();
  setFlag(g, (x, y) => Math.max(0, 1 - y / h) * 0.25, seed);
  b.add('tarp', g, M, { flag: true });
}

// Lean-to of dark tarp: a front edge high on three poles, the back pegged low, the cloth sagging between.
function addLeanTo(b, M, { groundY, seed }) {
  const w = { ground: groundY, grimeH: 0.4 };
  const Wd = 5.2, Dp = 2.8, hF = 2.55, hB = 0.9;
  for (const x of [-Wd / 2, 0, Wd / 2]) {
    b.add('woodRaw', cylinder(0.045, 0.055, hF + 0.25, 6, 1), mul(M, mat(x, (hF + 0.25) / 2, -Dp / 2)), w);
    b.add('woodRaw', cylinder(0.04, 0.05, hB + 0.15, 6, 1), mul(M, mat(x, (hB + 0.15) / 2, Dp / 2)), w);
  }
  b.add('woodRaw', cylinder(0.04, 0.04, Wd + 0.4, 6, 1), mul(M, mat(0, hF, -Dp / 2, 0, 0, Math.PI / 2)), w);
  const g = new THREE.PlaneGeometry(Wd + 0.3, Math.hypot(Dp, hF - hB) + 0.2, 12, 6);
  const p = g.getAttribute('position');
  const hl = (Math.hypot(Dp, hF - hB) + 0.2) / 2;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i);
    const t = (y + hl) / (2 * hl);
    const sag = Math.sin(Math.PI * t) * 0.22 * (0.5 - 0.5 * Math.cos((x / (Wd / 2)) * Math.PI * 2)); // between the poles
    p.setZ(i, -sag);
  }
  g.computeVertexNormals();
  setFlag(g, (x, y) => Math.max(0, (y + hl) / (2 * hl)) * 0.35, seed);
  const slope = Math.atan2(hF - hB, Dp);
  b.add('tarp', g, mul(M, mat(0, (hF + hB) / 2, 0, -Math.PI / 2 + slope, 0, 0)), { ...w, flag: true });
  // ragged valance hanging from the front edge
  const v = new THREE.PlaneGeometry(Wd + 0.3, 0.55, 12, 2);
  setFlag(v, (x, y) => (0.275 - y) / 0.55, seed + 1);
  b.add('tarp', v, mul(M, mat(0, hF - 0.25, -Dp / 2 - 0.03)), { ...w, flag: true });
}

// Ragged ridge tent: two A-frame poles, a ridge pole and two sagging cloth panels, closed at both ends.
function addTent(b, M, { groundY, seed = 1 }) {
  const w = { ground: groundY, grimeH: 0.5 };
  const Lt = 3.4, Wt = 2.8, Ht = 2.0;
  for (const z of [-Lt / 2, Lt / 2]) {
    for (const s of [-1, 1]) {
      const len = Math.hypot(Wt / 2, Ht);
      b.add('woodRaw', cylinder(0.035, 0.04, len + 0.1, 6, 1), mul(M, mat((s * Wt) / 4, Ht / 2, z, 0, 0, s * Math.atan2(Wt / 2, Ht))), w);
    }
  }
  b.add('woodRaw', cylinder(0.035, 0.035, Lt + 0.3, 6, 1), mul(M, mat(0, Ht + 0.03, 0, Math.PI / 2, 0, 0)), w);
  for (const s of [-1, 1]) {
    const pg = new THREE.PlaneGeometry(Lt + 0.2, Math.hypot(Wt / 2, Ht) + 0.1, 10, 6);
    const p = pg.getAttribute('position');
    const hh = (Math.hypot(Wt / 2, Ht) + 0.1) / 2;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i);
      const t = (y + hh) / (2 * hh); // 0 bottom … 1 ridge
      const sag = Math.sin(Math.PI * t) * 0.14 * (0.6 + 0.4 * Math.cos((x / (Lt / 2)) * Math.PI * 0.5));
      p.setZ(i, -sag);
    }
    pg.computeVertexNormals();
    setFlag(pg, (x, y) => Math.max(0, (hh - y) / (2 * hh)) * 0.6, seed + s);
    const slope = Math.atan2(Wt / 2, Ht);
    const R = mul(M, mat((s * Wt) / 4, Ht / 2, 0, 0, Math.PI / 2, 0));
    b.add('tent', pg, mul(R, mat(0, 0, 0, s * slope, 0, 0)), { ...w, flag: true });
  }
  // end walls (triangles)
  for (const ez of [-1, 1]) {
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-Wt / 2, 0, 0, Wt / 2, 0, 0, 0, Ht, 0], 3));
    tri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, Wt, 0, Wt / 2, Ht], 2));
    tri.setIndex([0, 1, 2]);
    tri.computeVertexNormals();
    setFlag(tri, () => 0.05, seed + ez);
    b.add('tent', tri, mul(M, mat(0, 0, ez * (Lt / 2 + 0.05))), { ...w, flag: true });
  }
}
