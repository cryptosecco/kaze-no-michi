// Tests for the S3 duel staging: where the actors stand and what their weapons do (run: npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SHOTS } from '../src/core/shots.js';
import { cameraFrame, s3Layout } from '../src/actors/staging.js';
import { buildRig, BONE_DEFS } from '../src/actors/rig/skeleton.js';
import { buildLibrary } from '../src/actors/anim/library.js';
import { SAMURAI, BANDITS } from '../src/actors/gen/character.js';
import { WEAPON_SPAN } from '../src/actors/gen/weapons.js';
import { TerrainGen } from '../src/world/TerrainGen.js';

const { clips } = buildLibrary(BONE_DEFS.map((d) => d[0]));

// the S3 camera as the shot applies it: the staging only reads its XZ frame, so a flat ground is enough for it; the
// screen-space checks below stand the camera and the actors on the island's own ground
function s3Camera(terrain = { heightAt: () => 0 }) {
  const s = SHOTS.S3_standoff;
  const { pos, target } = s.pose(terrain);
  const cam = new THREE.PerspectiveCamera(s.fov, 16 / 9, 0.1, 2000);
  cam.position.set(...pos);
  cam.lookAt(new THREE.Vector3(...target));
  cam.updateMatrixWorld(true);
  return cam;
}
const s3Frame = () => cameraFrame(s3Camera());

// the clip an Animator base (mode, clip) shows when the actor stands still
const clipOf = (base, clip) => clips[{ spear: 'spear_idle', combat: 'combat_idle', free: 'idle' }[base] || clip || base];

// Each staged actor over its whole (looping) clip, world space with the feet at groundY: the torso axis (Spine1), the
// head height above the feet and, when the clip holds the weapon drawn, points along the weapon from the pommel / butt
// to the tip (`blades`: the same points per clip frame).
function sweep(place, spec, weapon, groundY = 0) {
  const rig = buildRig({ scale: spec.scale || 1, shoulders: spec.shoulders || 1, hips: spec.hips || 1 });
  const rest = rig.bones.Hips.position.clone();
  const clip = clipOf(place.base, place.clip);
  assert.ok(clip, `clip for ${place.base}/${place.clip}`);
  const root = new THREE.Matrix4().compose(new THREE.Vector3(place.x, groundY, place.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), place.yaw), new THREE.Vector3(1, 1, 1));
  const out = { torso: [], head: 0, blade: [], blades: [], groundY };
  for (const F of clip.frames) {
    rig.list.forEach((b, k) => b.quaternion.set(F.q[k * 4], F.q[k * 4 + 1], F.q[k * 4 + 2], F.q[k * 4 + 3]));
    rig.bones.Hips.position.set(rest.x + F.hips[0], rest.y + F.hips[1], rest.z + F.hips[2]);
    rig.root.updateMatrixWorld(true);
    out.torso.push(rig.bones.Spine1.getWorldPosition(new THREE.Vector3()).applyMatrix4(root));
    out.head = Math.max(out.head, rig.bones.HeadTop_End.getWorldPosition(new THREE.Vector3()).y);
    if (F.sw && weapon) {
      const p = new THREE.Vector3(F.sw[0], F.sw[1], F.sw[2]), q = new THREE.Quaternion(F.sw[3], F.sw[4], F.sw[5], F.sw[6]);
      const [y0, y1] = WEAPON_SPAN[weapon];
      const pts = [];
      for (let k = 0; k <= 24; k++) pts.push(new THREE.Vector3(0, y0 + ((y1 - y0) * k) / 24, 0).applyQuaternion(q).add(p).applyMatrix4(root));
      out.blades.push(pts);
      out.blade.push(...pts);
    }
  }
  return out;
}

function staged(terrain = null) {
  const L = s3Layout(s3Frame());
  const g = (p) => (terrain ? terrain.heightAt(p.x, p.z) : 0);
  return [
    { name: 'samurai', ...sweep(L.samurai, SAMURAI, 'katana', g(L.samurai)) },
    ...L.bandits.map((b) => ({ name: `bandit ${b.i} (${BANDITS[b.i].weapon})`, bandit: true, ...sweep(b, BANDITS[b.i], BANDITS[b.i].weapon, g(b)) })),
  ];
}

test('in the S3 staging no weapon enters the body cylinder (r 0.35 m) of another actor', () => {
  const cast = staged();
  const hits = [];
  for (const A of cast)
    for (const B of cast) {
      if (A === B) continue;
      let worst = Infinity;
      for (const p of A.blade) {
        if (p.y < 0 || p.y > B.head) continue;
        for (const c of B.torso) worst = Math.min(worst, Math.hypot(p.x - c.x, p.z - c.z));
      }
      if (worst < 0.35) hits.push(`${A.name} → ${B.name}: ${worst.toFixed(2)} m`);
    }
  assert.deepEqual(hits, []);
});

// S3 as its telephoto lens sees it: the lens flattens depth, so actors metres apart can still cover each other in
// the frame. Each figure is its body cylinder (r 0.35 m around the torso axis, from the feet to the top of the head)
// projected into the S3 camera over the whole clip, on the island's own ground; NDC, x −1..1 left to right.
let screenCast = null;
function s3Screen() {
  if (screenCast) return screenCast;
  const terrain = new TerrainGen(1234).generate();
  const cam = s3Camera(terrain);
  const right = cameraFrame(cam).right;
  const ndc = (p) => p.clone().project(cam);
  return (screenCast = staged(terrain).map((A) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const c of A.torso)
      for (const s of [-0.35, 0.35])
        for (const y of [A.groundY, A.groundY + A.head]) {
          const p = ndc(new THREE.Vector3(c.x + right.x * s, y, c.z + right.z * s));
          (x0 = Math.min(x0, p.x)), (x1 = Math.max(x1, p.x)), (y0 = Math.min(y0, p.y)), (y1 = Math.max(y1, p.y));
        }
    const depth = A.torso.reduce((d, c) => d - c.clone().applyMatrix4(cam.matrixWorldInverse).z / A.torso.length, 0);
    return { ...A, box: { x0, x1, y0, y1 }, depth, blades: A.blades.map((pts) => pts.map(ndc)) };
  }));
}
// 2D segments ab and cd cross (NDC): each segment's ends lie on opposite sides of the other, by the sign of the
// orientation determinant (a positive stretch of x, such as the aspect ratio, scales every determinant alike and
// cannot change a sign, so none is applied)
function cross(a, b, c, d) {
  const o = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

test('in the S3 frame the bandits stand apart and no blade crosses another figure or blade', () => {
  const cast = s3Screen();
  const bandits = cast.filter((A) => A.bandit);
  const faults = [];
  for (const A of bandits)
    for (const B of bandits) {
      if (A.name >= B.name) continue;
      const ov = Math.min(A.box.x1, B.box.x1) - Math.max(A.box.x0, B.box.x0);
      if (ov > 0) faults.push(`${A.name} and ${B.name} overlap by ${ov.toFixed(3)} (NDC x)`);
    }
  const inBox = (p, b) => p.x > b.x0 && p.x < b.x1 && p.y > b.y0 && p.y < b.y1;
  for (const A of cast)
    for (const B of cast) {
      if (A === B) continue;
      const n = A.blades.flat().filter((p) => inBox(p, B.box)).length;
      if (n) faults.push(`${A.name}'s blade enters ${B.name} (${n} points)`);
      if (A.name < B.name && A.blades.some((a) => B.blades.some((b) => cross(a[0], a[24], b[0], b[24])))) faults.push(`${A.name}'s blade crosses ${B.name}'s`);
    }
  assert.deepEqual(faults, []);
});

test('the S3 bandits keep a tight, staggered wedge on the right of the frame', () => {
  const bandits = s3Screen().filter((A) => A.bandit);
  const x0 = Math.min(...bandits.map((A) => A.box.x0)), x1 = Math.max(...bandits.map((A) => A.box.x1));
  const depths = bandits.map((A) => A.depth);
  assert.ok(x0 > 0.1 && x1 < 0.9, `the bandits span NDC x ${x0.toFixed(3)}..${x1.toFixed(3)}`);
  assert.ok(x1 - x0 < 0.7, `the wedge is ${(x1 - x0).toFixed(3)} wide (NDC x)`);
  assert.ok(Math.max(...depths) - Math.min(...depths) > 1.5, `depths ${depths.map((d) => d.toFixed(2)).join(', ')} m`);
});

test('the S3 samurai stands in profile, facing the bandits across the frame', () => {
  const cf = s3Frame();
  const { samurai } = s3Layout(cf);
  const facing = Math.atan2(Math.sin(samurai.yaw), Math.cos(samurai.yaw));
  const right = Math.atan2(cf.right.x, cf.right.z);
  const off = Math.abs(Math.atan2(Math.sin(facing - right), Math.cos(facing - right))) * (180 / Math.PI);
  assert.ok(off < 25, `the samurai faces ${off.toFixed(1)}° off screen-right`);
});

test('the four bandits closing in at sunset carry swords; the camp keeps a spear', () => {
  const { bandits } = s3Layout(s3Frame());
  assert.equal(bandits.length, 4);
  for (const b of bandits) assert.equal(BANDITS[b.i].weapon, 'katana', `bandit ${b.i}`);
  assert.ok(BANDITS.some((b) => b.weapon === 'spear'));
});

test('the duel stances hold the blade drawn with both feet planted on the ground', () => {
  const rig = buildRig({});
  const rest = rig.bones.Hips.position.clone();
  const y = (n) => rig.bones[n].getWorldPosition(new THREE.Vector3()).y;
  for (const name of ['duel_low', 'b_low', 'b_hasso', 'b_seigan', 'b_waki']) {
    const clip = clips[name];
    assert.ok(clip && clip.loop, name);
    clip.frames.forEach((F, k) => {
      assert.ok(F.sw, `${name} frame ${k}: blade drawn`);
      rig.list.forEach((b, i) => b.quaternion.set(F.q[i * 4], F.q[i * 4 + 1], F.q[i * 4 + 2], F.q[i * 4 + 3]));
      rig.bones.Hips.position.set(rest.x + F.hips[0], rest.y + F.hips[1], rest.z + F.hips[2]);
      rig.root.updateMatrixWorld(true);
      for (const f of ['LeftFoot', 'RightFoot']) assert.ok(Math.abs(y(f) - 0.085) < 0.02, `${name} frame ${k}: ${f} ankle at ${y(f).toFixed(3)} m`);
      for (const t of ['LeftToe_End', 'RightToe_End']) assert.ok(y(t) > -0.012 && y(t) < 0.05, `${name} frame ${k}: ${t} at ${y(t).toFixed(3)} m`);
    });
  }
});
