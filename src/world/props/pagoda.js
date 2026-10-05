import * as THREE from 'three';
import { POI } from '../Layout.js';
import { Builder, box, cylinder, mat, mul } from './geom.js';
import { buildRoof } from './roof.js';

// Five-storey pagoda (gojū-no-tō) on the northern ridge: stone kidan with steps toward the field,
// vermilion posts and brackets, white walls, studded doors, strongly curved tile roofs with upswept
// corners, balconies with railings on the upper tiers, and a bronze sōrin spire with nine rings.

export function buildPagoda(game, mats) {
  const terrain = game.terrain;
  const P = POI.pagoda;
  const SC = 1.45; // landmark scale (≈ 45 m to the spire tip)
  let gy = Infinity;
  for (let a = 0; a < 8; a++) gy = Math.min(gy, terrain.heightAt(P.x + Math.cos(a) * 6.5 * SC, P.z + Math.sin(a) * 6.5 * SC));
  const b = new Builder('pagoda');
  // face the field / spawn (to the south)
  const face = Math.atan2(0 - P.x, 0 - P.z);
  const M = new THREE.Matrix4().makeTranslation(P.x, gy, P.z).multiply(new THREE.Matrix4().makeRotationY(face)).multiply(new THREE.Matrix4().makeScale(SC, SC, SC));
  const w = { ground: gy, grimeH: 1.2 };

  // kidan platform + steps (local +z faces the field)
  const kid = 0.95;
  b.add('stone', box(12.6, kid + 0.8, 12.6, { grain: 'x' }), mul(M, mat(0, (kid - 0.8) / 2, 0)), { ...w, grimeH: 0.6 });
  b.add('stone', box(13.0, 0.14, 13.0, { grain: 'x' }), mul(M, mat(0, kid + 0.02, 0)), w);
  for (let k = 0; k < 4; k++) b.add('stone', box(3.2, 0.24 * (k + 1), 0.42, { grain: 'x' }), mul(M, mat(0, 0.12 * (k + 1) - 0.05, 6.3 + (3 - k) * 0.42 + 0.2)), { ...w, grimeH: 0.3 });

  const cores = [6.6, 5.9, 5.3, 4.8, 4.3];
  const heights = [3.7, 2.35, 2.3, 2.25, 2.2];
  const overs = [3.0, 2.85, 2.7, 2.58, 2.46];
  let base = kid + 0.09;
  let top = 0;
  for (let i = 0; i < 5; i++) {
    const c = cores[i], h = heights[i], hc = c / 2;
    // balcony on the upper tiers
    if (i > 0) {
      b.add('woodDark', box(c + 1.0, 0.14, c + 1.0, { grain: 'x' }), mul(M, mat(0, base + 0.07, 0)), w);
      for (const sx of [-1, 1]) {
        b.add('lacquer', box(0.07, 0.07, c + 0.9, { grain: 'z' }), mul(M, mat(sx * (hc + 0.45), base + 0.62, 0)), w);
        b.add('lacquer', box(c + 0.9, 0.07, 0.07, { grain: 'x' }), mul(M, mat(0, base + 0.62, sx * (hc + 0.45))), w);
        for (let k = 0; k <= 6; k++) {
          const t = -hc - 0.45 + (k * (c + 0.9)) / 6;
          b.add('lacquer', box(0.06, 0.5, 0.06, { grain: 'y' }), mul(M, mat(sx * (hc + 0.45), base + 0.38, t)), w);
          b.add('lacquer', box(0.06, 0.5, 0.06, { grain: 'y' }), mul(M, mat(t, base + 0.38, sx * (hc + 0.45))), w);
        }
      }
      base += 0.14;
    }
    // posts: corners + two intermediate per side (3 bays)
    const xs = [-hc, -hc / 3, hc / 3, hc];
    for (const x of xs)
      for (const z of xs) {
        if (Math.abs(x) < hc - 0.01 && Math.abs(z) < hc - 0.01) continue;
        b.add('lacquer', cylinder(0.15, 0.16, h, 10, 2), mul(M, mat(x, base + h / 2, z)), w);
      }
    // walls: centre bay door (dark, studded), side bays white plaster over a dark wainscot
    for (let side = 0; side < 4; side++) {
      const ry = (side * Math.PI) / 2;
      const S = (x, y, z) => mul(M, mat(0, 0, 0, 0, ry, 0)).multiply(mat(x, y, z));
      b.add('woodDark', box((c / 3) * 0.92, h * 0.78, 0.1, { grain: 'y' }), S(0, base + h * 0.42, hc - 0.02), { ...w, tint: [0.75, 0.62, 0.55] });
      for (let k = 0; k < 3; k++) for (let j = 0; j < 4; j++) b.add('iron', box(0.05, 0.05, 0.04), S(-0.5 + (k * 1.0) / 2 + (c / 3 - 2.0) * 0, base + h * (0.18 + j * 0.16), hc + 0.05), w);
      for (const sx of [-1, 1]) {
        b.add('plaster', box((c / 3) * 0.95, h * 0.62, 0.1, { grain: 'x' }), S(sx * (c / 3), base + h * 0.55, hc - 0.03), w);
        b.add('woodDark', box((c / 3) * 0.95, h * 0.24, 0.12, { grain: 'x' }), S(sx * (c / 3), base + h * 0.12, hc - 0.03), w);
      }
      // head beam + tie beam
      b.add('lacquer', box(c + 0.4, 0.24, 0.2, { grain: 'x' }), S(0, base + h - 0.12, hc), w);
      b.add('lacquer', box(c + 0.3, 0.16, 0.16, { grain: 'x' }), S(0, base + h * 0.24, hc + 0.02), w);
    }
    // bracket cornice: stepped layers stepping outward (vermilion with white ends)
    let by = base + h;
    for (let k = 0; k < 3; k++) {
      const wd = c + 0.5 + k * 0.62;
      b.add(k === 1 ? 'plaster' : 'lacquer', box(wd, 0.2, wd, { grain: 'x' }), mul(M, mat(0, by + 0.1, 0)), w);
      by += 0.2;
    }
    // roof
    const W = c + overs[i] * 2;
    const ro = { W, D: W, H: 1.45 + i * 0.03, type: 'hip', pow: 1.8, lift: 1.15, liftPow: 3, thick: 0.5, segE: 16, segS: 10, seed: 40 + i, hipW: 0.32, ridgeW: 0.5 };
    const roof = buildRoof(ro);
    const RM = mul(M, mat(0, by + 0.02, 0));
    b.add('tile', roof.top, RM, w);
    b.add('woodDark', roof.under, RM, { ...w, tint: [0.72, 0.6, 0.55] });
    b.add('lacquer', roof.fascia, RM, w);
    if (roof.hips) b.add('black', roof.hips, RM, w);
    // corner bells
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add('bronze', cylinder(0.08, 0.14, 0.32, 8, 1), mul(RM, mat((sx * W) / 2 * 0.97, ro.lift - 0.35, (sz * W) / 2 * 0.97)), w);
    // next tier sits on this roof where it meets the smaller core
    if (i < 4) {
      const cn = cores[i + 1];
      const s = (W / 2 - cn / 2 - 0.35) / (W / 2);
      base = by + ro.H * Math.pow(Math.max(0, s), ro.pow) - 0.05;
    } else top = by + ro.H;
  }
  // sōrin spire
  b.add('tile', box(1.2, 0.5, 1.2, { grain: 'x' }), mul(M, mat(0, top + 0.1, 0)), w);
  b.add('bronze', cylinder(0.12, 0.14, 8.2, 10, 1), mul(M, mat(0, top + 4.2, 0)), w);
  for (let k = 0; k < 9; k++) b.add('bronze', cylinder(0.46 - k * 0.012, 0.46 - k * 0.012, 0.09, 16, 1), mul(M, mat(0, top + 1.0 + k * 0.52, 0)), w);
  b.add('bronze', cylinder(0.62, 0.62, 0.05, 16, 1), mul(M, mat(0, top + 6.0, 0)), w);
  for (let k = 0; k < 4; k++) b.add('bronze', box(0.05, 0.9, 1.1, { grain: 'y' }), mul(M, mat(0, top + 6.45, 0, 0, (k * Math.PI) / 4, 0)), w);
  b.add('bronze', new THREE.SphereGeometry(0.2, 12, 8), mul(M, mat(0, top + 7.25, 0)), w);
  b.add('bronze', new THREE.SphereGeometry(0.16, 12, 8), mul(M, mat(0, top + 7.8, 0)), w);
  b.add('bronze', new THREE.ConeGeometry(0.06, 0.4, 8), mul(M, mat(0, top + 8.1, 0)), w);

  game.colliders.addBox(P.x, P.z, 6.3 * SC, 6.3 * SC, face, { tag: 'pagoda-kidan', top: gy + kid * SC });
  game.colliders.addBox(P.x, P.z, 3.5 * SC, 3.5 * SC, face, { tag: 'pagoda' });
  const inv = new THREE.Matrix4().copy(M).invert();
  const v = new THREE.Vector3();
  game.addGroundOverride((x, z) => {
    if (Math.abs(x - P.x) > 14 || Math.abs(z - P.z) > 14) return null;
    v.set(x, gy, z).applyMatrix4(inv);
    return Math.abs(v.x) < 6.5 && Math.abs(v.z) < 6.5 ? gy + (kid + 0.09) * SC : null;
  });

  const group = b.build(mats);
  group.userData.info = { x: P.x, z: P.z, y: gy, height: (top + 8.3) * SC, radius: 8.5 * SC };
  return group;
}
