// Tests for the samurai's rest and climbing poses on the shared humanoid rig (run: npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRig, BONE_DEFS } from '../src/actors/rig/skeleton.js';
import { REST, CLIMB, buildLibrary } from '../src/actors/anim/library.js';

const rig = buildRig({});
const restHips = rig.bones.Hips.position.clone();
const at = (name) => rig.bones[name].getWorldPosition(restHips.clone()); // model space (the rig root is at 0)

// forward kinematics of a pose ({ bones: { Name: Quaternion }, hips }) on the rest rig, model space (feet at y 0)
function fkPose(P) {
  for (const b of rig.list) b.quaternion.identity();
  for (const [k, q] of Object.entries(P.bones)) if (rig.bones[k]) rig.bones[k].quaternion.copy(q);
  rig.bones.Hips.position.copy(restHips).add(P.hips);
  rig.root.updateMatrixWorld(true);
}

// the same for one sampled clip frame ({ q: Float32Array per bone in rig order, hips })
function fkFrame(F) {
  rig.list.forEach((b, i) => b.quaternion.set(F.q[i * 4], F.q[i * 4 + 1], F.q[i * 4 + 2], F.q[i * 4 + 3]));
  rig.bones.Hips.position.set(restHips.x + F.hips[0], restHips.y + F.hips[1], restHips.z + F.hips[2]);
  rig.root.updateMatrixWorld(true);
}

// weight on the right leg: the free left foot half a step forward, both feet on the ground, the pelvis over the
// standing foot, the right shoulder dropped (so the pose never reads as rigid and weightless)
function assertWeighted(label) {
  const lf = at('LeftFoot'), rf = at('RightFoot');
  assert.ok(lf.z - rf.z > 0.15, `${label}: left foot ${(lf.z - rf.z).toFixed(3)} m ahead`);
  for (const f of ['LeftFoot', 'RightFoot']) assert.ok(Math.abs(at(f).y - 0.08) < 0.02, `${label}: ${f} ankle at ${at(f).y.toFixed(3)} m`);
  for (const t of ['LeftToe_End', 'RightToe_End']) assert.ok(at(t).y > -0.012 && at(t).y < 0.035, `${label}: ${t} at ${at(t).y.toFixed(3)} m`);
  assert.ok(at('Hips').x < -0.015, `${label}: pelvis x ${at('Hips').x.toFixed(3)}`);
  assert.ok(at('LeftArm').y - at('RightArm').y > 0.02, `${label}: shoulders ${(at('LeftArm').y - at('RightArm').y).toFixed(3)} m apart`);
  assert.ok(lf.x - rf.x < 0.32, `${label}: stance ${(lf.x - rf.x).toFixed(3)} m wide`);
}

test('the rest pose carries the weight on one leg', () => {
  fkPose(REST);
  assertWeighted('REST');
});

test('every frame of the idle clip keeps the weighted stance', () => {
  const { clips } = buildLibrary(BONE_DEFS.map((d) => d[0]));
  const idle = clips.idle;
  assert.ok(idle.loop && idle.frames.length > 10);
  idle.frames.forEach((F, k) => {
    fkFrame(F);
    assertWeighted(`idle frame ${k}`);
  });
});

test('the climbing pose leans into the step with the right foot leading', () => {
  fkPose(CLIMB);
  assert.ok(at('RightFoot').z - at('LeftFoot').z > 0.3);
  assert.ok(at('Head').z - at('Hips').z > 0.12);
  assert.ok(at('LeftToe_End').y < 0.02); // the trailing foot pushes from its toes
  const { clips } = buildLibrary(BONE_DEFS.map((d) => d[0]));
  assert.ok(clips.climb && clips.climb.loop);
});
