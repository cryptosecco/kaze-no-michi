import * as THREE from 'three';
import { POI, PATHS, PATH_INFO } from '../Layout.js';
import { Builder, box, rbox, cylinder, lathe, boulder, sweep, mat, mul, rng } from './geom.js';
import { addTorii, addLantern } from './torii.js';
import { buildRoof } from './roof.js';
import { freeOfTrees } from './clearings.js';

// The ending spot on the western cliff (a lone torii facing the sea with a lantern and a stone bench) and
// scattered roadside detail along the island paths: mossy boulder clusters, jizō statues with red bibs,
// tiny hokora wayside shrines and short runs of weathered fence.

export function buildCliff(game, mats) {
  const terrain = game.terrain;
  const b = new Builder('cliff');
  // walk west from the cliff POI to the last solid ground before the drop
  let edge = { x: POI.cliff.x, z: POI.cliff.z };
  let top = terrain.heightAt(edge.x, edge.z);
  for (let d = 0; d < 160; d += 2) {
    const x = POI.cliff.x - d, z = POI.cliff.z;
    const h = terrain.heightAt(x, z);
    if (h < top - 6 || h < 8) break;
    edge = { x, z };
    top = Math.min(top, h);
  }
  const T = { x: edge.x + 9, z: edge.z }; // a few metres back from the edge
  const ty = terrain.heightAt(T.x, T.z);
  const face = -Math.PI / 2; // through-axis toward −x (the sea)
  const M = new THREE.Matrix4().makeTranslation(T.x, ty, T.z).multiply(new THREE.Matrix4().makeRotationY(face));
  const t = addTorii(b, M, { span: 4.4, height: 5.4, groundY: ty, seed: 311, baseDepth: 0.6 });
  for (const sd of [-1, 1]) game.colliders.addCircle(T.x, T.z + sd * t.span / 2, 0.35, { tag: 'torii' });
  // lantern on the landward side + a flat stone to sit on and watch the sunset
  const L = { x: T.x + 3.2, z: T.z + 3.6 };
  const ly = terrain.heightAt(L.x, L.z);
  addLantern(b, new THREE.Matrix4().makeTranslation(L.x, ly, L.z).multiply(new THREE.Matrix4().makeRotationY(face)), { scale: 1.0, groundY: ly, seed: 312 });
  game.colliders.addCircle(L.x, L.z, 0.45, { tag: 'lantern' });
  const S = { x: T.x + 5.5, z: T.z - 0.5 };
  const sy = terrain.heightAt(S.x, S.z);
  b.add('stoneMossy', rbox(1.7, 0.6, 0.8, { r: 0.08 }), mul(new THREE.Matrix4().makeTranslation(S.x, sy + 0.05, S.z), mat(0, 0, 0, 0.02, face, 0.03)), { ground: sy, grimeH: 0.3, seed: 313 });
  for (let k = 0; k < 4; k++) {
    const g = boulder(0.6 + k * 0.25, 320 + k);
    const p = { x: T.x - 2 + k * 1.7, z: T.z - 6 - (k % 2) * 2.5 };
    const py = terrain.heightAt(p.x, p.z);
    b.add('stoneMossy', g, new THREE.Matrix4().makeTranslation(p.x, py - 0.15, p.z), { ground: py, grimeH: 0.4, seed: 320 + k });
    game.colliders.addCircle(p.x, p.z, 0.6 + k * 0.25, { tag: 'rock' });
  }
  const group = b.build(mats);
  // the torii's beam runs along world z (face −π/2): its size lets the wildlife module perch crows on the kasagi
  group.userData.info = { torii: { x: T.x, y: ty, z: T.z, span: t.span, height: t.height, pillarR: t.pillarR, axis: { x: 0, z: 1 } }, bench: { x: S.x, y: sy + 0.35, z: S.z, facing: { x: -1, z: 0 } }, edge: { ...edge, y: top } };
  return group;
}

export function buildRoadside(game, mats) {
  const terrain = game.terrain;
  const b = new Builder('roadside');
  const rnd = rng(8080);
  const placed = { jizo: [], hokora: [], rocks: 0, fences: 0 };
  const keepOut = [
    { x: POI.shrine.x, z: POI.shrine.z, r: POI.shrine.footRadius * 0.5 },
    { x: POI.camp.x, z: POI.camp.z, r: 45 },
    { x: POI.pagoda.x, z: POI.pagoda.z, r: 25 },
    { x: POI.cliff.x, z: POI.cliff.z, r: 40 },
    { x: POI.spawn.x, z: POI.spawn.z, r: 12 },
  ];
  const ok = (x, z, r) => keepOut.every((k) => Math.hypot(x - k.x, z - k.z) > k.r) && freeOfTrees(game, x, z, r) && terrain.surfaceAt(x, z).path < 0.3;
  let features = 0;
  PATHS.forEach((pts, pi) => {
    const halfW = PATH_INFO[pi].width / 2;
    let acc = 0;
    let next = 25 + rnd() * 20;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], c = pts[i];
      const seg = Math.hypot(c.x - a.x, c.z - a.z);
      if (seg < 1e-3) continue;
      const dir = { x: (c.x - a.x) / seg, z: (c.z - a.z) / seg };
      const nrm = { x: -dir.z, z: dir.x };
      while (acc + seg >= next) {
        const tt = (next - acc) / seg;
        const px = a.x + (c.x - a.x) * tt, pz = a.z + (c.z - a.z) * tt;
        const side = rnd() < 0.5 ? -1 : 1;
        const roll = rnd();
        const off = halfW + 1.6 + rnd() * 2.2;
        const x = px + nrm.x * off * side, z = pz + nrm.z * off * side;
        const faceYaw = Math.atan2(-nrm.x * side, -nrm.z * side); // turned toward the path
        if (roll < 0.12 && ok(x, z, 1.2)) {
          addJizo(b, x, terrain.heightAt(x, z), z, faceYaw, rnd);
          game.colliders.addCircle(x, z, 0.35, { tag: 'jizo' });
          placed.jizo.push({ x, z });
          features++;
        } else if (roll < 0.2 && ok(x, z, 1.6)) {
          addHokora(b, x, terrain.heightAt(x, z), z, faceYaw);
          game.colliders.addCircle(x, z, 0.6, { tag: 'hokora' });
          placed.hokora.push({ x, z });
          features++;
        } else if (roll < 0.34) {
          // short fence run along the verge
          const len = 5 + rnd() * 6;
          const fx = px + nrm.x * (halfW + 1.2) * side, fz = pz + nrm.z * (halfW + 1.2) * side;
          if (ok(fx, fz, 1) && ok(fx + dir.x * len, fz + dir.z * len, 1)) {
            addFence(b, game, fx, fz, dir, len, rnd);
            placed.fences++;
            features++;
          }
        } else if (ok(x, z, 2)) {
          // mossy boulder cluster
          const n = 1 + Math.floor(rnd() * 3);
          for (let k = 0; k < n; k++) {
            const r = 0.35 + rnd() * (k === 0 ? 1.0 : 0.5);
            const bx = x + (rnd() - 0.5) * 2.4, bz = z + (rnd() - 0.5) * 2.4;
            const by = terrain.heightAt(bx, bz);
            b.add('stoneMossy', boulder(r, Math.floor(rnd() * 1e6)), mul(new THREE.Matrix4().makeTranslation(bx, by - r * 0.18, bz), mat(0, 0, 0, 0, rnd() * 6.28, 0)), { ground: by, grimeH: 0.3, seed: k });
            game.colliders.addCircle(bx, bz, r * 0.9, { tag: 'rock', top: by + r * 0.6 });
            placed.rocks++;
          }
          features++;
        }
        next += 32 + rnd() * 40;
      }
      acc += seg;
    }
  });
  // extra boulders scattered through the open field (golden-grass meadows read better with a few rocks)
  for (let k = 0; k < 26; k++) {
    const a = rnd() * Math.PI * 2, r = 30 + rnd() * POI.field.r * 0.8;
    const x = POI.field.x + Math.cos(a) * r, z = POI.field.z + Math.sin(a) * r;
    if (!ok(x, z, 2)) continue;
    const rr = 0.5 + rnd() * 1.1;
    const y = terrain.heightAt(x, z);
    b.add('stoneMossy', boulder(rr, 5000 + k), mul(new THREE.Matrix4().makeTranslation(x, y - rr * 0.2, z), mat(0, 0, 0, 0, rnd() * 6.28, 0)), { ground: y, grimeH: 0.3, seed: k });
    game.colliders.addCircle(x, z, rr * 0.9, { tag: 'rock', top: y + rr * 0.6 });
    placed.rocks++;
  }
  const group = b.build(mats);
  group.userData.info = { ...placed, features };
  return group;
}

// Jizō: small stone monk figure on a plinth, red cloth bib and cap.
function addJizo(b, x, y, z, yaw, rnd) {
  const M = new THREE.Matrix4().makeTranslation(x, y, z).multiply(new THREE.Matrix4().makeRotationY(yaw));
  const w = { ground: y, grimeH: 0.5 };
  const s = 0.85 + rnd() * 0.3;
  b.add('stone', rbox(0.5 * s, 0.3, 0.42 * s, { r: 0.03 }), mul(M, mat(0, 0.05, 0)), { ...w, seed: 1 });
  const body = lathe([[0.001, 0], [0.19, 0.02], [0.2, 0.18], [0.17, 0.42], [0.13, 0.55], [0.1, 0.6], [0.001, 0.61]], 12);
  b.add('stoneMossy', body, mul(M, mat(0, 0.2, 0, 0, 0, 0, s)), { ...w, seed: 2 });
  b.add('stoneMossy', new THREE.SphereGeometry(0.11, 12, 10), mul(M, mat(0, 0.2 + 0.7 * s, 0, 0, 0, 0, s)), { ...w, seed: 3 });
  // red bib (hangs on the front) and knitted cap
  const bib = new THREE.ConeGeometry(0.2, 0.26, 12, 1, true, -Math.PI * 0.55, Math.PI * 1.1);
  b.add('redCloth', bib, mul(M, mat(0, 0.2 + 0.5 * s, 0.015, 0, Math.PI / 2, 0, s)), {});
  b.add('redCloth', new THREE.SphereGeometry(0.118, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.5), mul(M, mat(0, 0.2 + 0.72 * s, 0, 0, 0, 0, s)), {});
}

// Hokora: tiny wooden wayside shrine on a stone base, with a small gable roof and offerings.
function addHokora(b, x, y, z, yaw) {
  const M = new THREE.Matrix4().makeTranslation(x, y, z).multiply(new THREE.Matrix4().makeRotationY(yaw));
  const w = { ground: y, grimeH: 0.6 };
  b.add('stoneMossy', rbox(1.0, 0.7, 0.9, { r: 0.05 }), mul(M, mat(0, 0.15, 0)), { ...w, seed: 4 });
  b.add('woodAged', box(0.62, 0.55, 0.5, { grain: 'y' }), mul(M, mat(0, 0.78, 0)), w);
  b.add('woodDark', box(0.4, 0.4, 0.04, { grain: 'y' }), mul(M, mat(0, 0.76, -0.26)), { ...w, tint: [0.35, 0.3, 0.28] });
  const roof = buildRoof({ W: 0.95, D: 0.85, H: 0.3, type: 'gable', pow: 1.3, lift: 0.05, thick: 0.06, segE: 4, segS: 4, seed: 9 });
  const RM = mul(M, mat(0, 1.06, 0, 0, Math.PI / 2, 0));
  b.add('bark', roof.top, RM, w);
  b.add('woodDark', roof.under, RM, w);
  b.add('woodDark', roof.fascia, RM, w);
  if (roof.hafu) b.add('woodDark', roof.hafu, RM, w);
  b.add('black', roof.ridge, RM, w);
  // a tiny paper streamer rope + sake cup
  const pts = [];
  for (let k = 0; k <= 6; k++) pts.push(new THREE.Vector3(-0.3 + k * 0.1, 1.04 - Math.sin((k / 6) * Math.PI) * 0.06, -0.27));
  b.add('straw', sweep(pts, { radius: 0.02, radial: 5 }), M, {});
  b.add('plaster', cylinder(0.035, 0.025, 0.04, 8, 1), mul(M, mat(0.14, 0.52, -0.34)), {});
}

function addFence(b, game, x, z, dir, len, rnd) {
  const terrain = game.terrain;
  const n = Math.max(2, Math.round(len / 1.9));
  const posts = [];
  for (let k = 0; k <= n; k++) {
    const px = x + dir.x * (len * k) / n, pz = z + dir.z * (len * k) / n;
    const py = terrain.heightAt(px, pz);
    const lean = (rnd() - 0.5) * 0.14;
    b.add('woodAged', box(0.11, 1.15, 0.11, { grain: 'y' }), mul(new THREE.Matrix4().makeTranslation(px, py + 0.45, pz), mat(0, 0, 0, lean, rnd(), (rnd() - 0.5) * 0.12)), { ground: py, seed: k });
    posts.push(new THREE.Vector3(px, py, pz));
  }
  for (const hy of [0.42, 0.88]) {
    const pts = posts.map((p) => new THREE.Vector3(p.x, p.y + hy + (rnd() - 0.5) * 0.05, p.z));
    b.add('woodAged', sweep(pts, { w: 0.06, h: 0.09 }), null, {});
  }
  for (let k = 0; k < posts.length - 1; k++) {
    const m = posts[k].clone().add(posts[k + 1]).multiplyScalar(0.5);
    game.colliders.addCircle(m.x, m.z, 0.4, { tag: 'fence', top: m.y + 0.95 });
  }
}
