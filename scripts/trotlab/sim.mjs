#!/usr/bin/env node
// Trot lab — Node simulation of the REAL horse (src/actors/horse/Horse.js) on stand-ins for the game, recorded from
// geometry (markers.mjs) at a fixed small step, then measured (metrics.mjs) and reported (report.mjs).
//   npm run trotlab -- --label <name> [--no-plots] [--hz 240] [--ref scripts/trotlab/reference.json]
//   → out/trotlab/<label>/metrics.json, metrics.md, trace_steady_4.0.json, plots/*.png|svg (docs/trot-lab.md)
// The horse is driven without its brain: horse.ridden = true, then want.speed / want.yaw are set every step (and
// horse.speed directly when a scenario starts at its speed, to skip the acceleration ramp). Math.random is seeded
// (mulberry32) for each scenario, so a run repeats exactly. The internal gait state (phase, gait name, stance, IK reach)
// is recorded as LABELS only: contact truth is geometric (the lowest point of the hoof capsule within 4 mm of the ground).
import * as THREE from 'three';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Horse } from '../../src/actors/horse/Horse.js';
import { Colliders } from '../../src/game/Colliders.js';
import { makeProbe, relQuat, quatAngle, CONTACT_M } from './markers.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ---- stand-ins (as scripts/horse.test.mjs) ----------------------------------------------------------------------------
// the canvas the horse's textures are drawn on draws nothing in Node
export function installDocumentStub() {
  if (globalThis.document) return;
  const blank = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
  const ctx2d = new Proxy({}, { get: (_, k) => (k === 'createImageData' || k === 'getImageData' ? blank : () => {}), set: () => true });
  globalThis.document = { documentElement: {}, createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }) };
}

// dry ground given by groundAt(x, z), no colliders, no wind: what is under test is the horse
export function makeGame(groundAt) {
  const events = new EventTarget();
  return {
    state: 'play',
    standoffActive: false,
    colliders: new Colliders(),
    terrain: { heightAt: groundAt, surfaceAt: () => ({ path: 0, rock: 0 }) },
    groundAt,
    wind: { sample: (x, z, out) => out.set(0, 0) },
    camera: new THREE.PerspectiveCamera(52, 16 / 9, 0.1, 2000),
    emit: (type, detail) => events.dispatchEvent(new CustomEvent(type, { detail })),
    on(type, fn) {
      events.addEventListener(type, fn);
      return () => events.removeEventListener(type, fn);
    },
    add() {},
    addStat() {},
  };
}

// Math.random from a seed (mulberry32)
export const mulberry32 = (a) => () => {
  a = (a + 0x6d2b79f5) | 0;
  let x = Math.imul(a ^ (a >>> 15), 1 | a);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};

// ---- scenarios --------------------------------------------------------------------------------------------------------
const FLAT = () => 1;
const GRADE = 0.15; // 15 % grade
// trot speeds: the main one and the two around it; regression guards at the other gaits' own paces (steer.js SPEEDS)
export const TROT_SPEEDS = [3.2, 4.0, 5.0];
export const MAIN_SPEED = 4.0;
const TURN_RADIUS = 8;

const straight = (v) => (h) => {
  h.want.speed = v;
  h.want.yaw = 0;
};
// a speed schedule [[until_s, speed], ...] on a straight line (the horse's own acceleration between them)
const schedule = (steps) => (h, t) => {
  let v = 0;
  for (const [until, s] of steps) {
    v = s;
    if (t < until) break;
  }
  h.want.speed = v;
  h.want.yaw = 0;
};
// a circle: the wanted heading leads the current one by ω·0.12 s, so Horse._move's turn controller asks for a yaw rate ω
// (it divides the heading error by max(dt, 0.12 s)) and the horse settles on a circle of radius v / ω
const circle = (v, omega) => (h) => {
  h.want.speed = v;
  h.want.yaw = h.yaw + omega * 0.12;
};

// name → { ground, speed0 (set directly at the start), settle (s), record (s), control(h, t), kind }
export function scenarios() {
  const S = {};
  for (const v of TROT_SPEEDS) S[`steady_${v.toFixed(1)}`] = { kind: 'steady', speed: v, ground: FLAT, speed0: v, settle: 4, record: 6.5, control: straight(v) };
  S.walk = { kind: 'guard', speed: 1.8, ground: FLAT, speed0: 1.8, settle: 4, record: 7, control: straight(1.8) };
  S.canter = { kind: 'guard', speed: 8.5, ground: FLAT, speed0: 8.5, settle: 4, record: 5, control: straight(8.5) };
  S.gallop = { kind: 'guard', speed: 13.5, ground: FLAT, speed0: 13.5, settle: 4, record: 4.5, control: straight(13.5) };
  // standstill → walk → trot → canter → stop, with the horse's own acceleration and braking
  S.accel = { kind: 'accel', ground: FLAT, speed0: 0, settle: 1, record: 18, control: schedule([[3, 0], [7, 1.8], [11, 4.0], [15, 8.5], [Infinity, 0]]) };
  S.turn_left = { kind: 'turn', speed: 4, ground: FLAT, speed0: 4, settle: 4, record: 6.5, control: circle(4, 4 / TURN_RADIUS) };
  S.turn_right = { kind: 'turn', speed: 4, ground: FLAT, speed0: 4, settle: 4, record: 6.5, control: circle(4, -4 / TURN_RADIUS) };
  // 15 % grade along the heading (+z): uphill and downhill
  S.slope_up = { kind: 'slope', speed: 4, ground: (x, z) => 10 + GRADE * z, speed0: 4, settle: 4, record: 6.5, control: straight(4) };
  S.slope_down = { kind: 'slope', speed: 4, ground: (x, z) => 60 - GRADE * z, speed0: 4, settle: 4, record: 6.5, control: straight(4) };
  // the square stand: the reference for "relative to standing" joint angles
  S.stand = { kind: 'stand', ground: FLAT, speed0: 0, settle: 2, record: 0.5, control: straight(0) };
  return S;
}

// bones the smoothness metric watches (locomotion: trunk, neck, head, legs); ears and tail are secondary motion with
// their own springs and random flicks, reported apart
const SECONDARY = /^(Ear|Tail)/;

// ---- the recorder -----------------------------------------------------------------------------------------------------
// Runs one scenario at step dt (s): settle, then record every step. Returns { name, dt, samples, frames60 }:
//   samples[i] = { t, lab: { phase, gait, gi, gw, speed, yawRate, duty, freq, stance[4], reach[4] }, geo: probe record }
//   frames60[k] = { t, i (sample index), stepLoco, stepLocoBone, stepAll, stepAllBone (deg), unreached }, every 1/60 s
export function simulate(name, scn, { dt = 1 / 240, seed = 1 } = {}) {
  installDocumentStub();
  const real = Math.random;
  Math.random = mulberry32(seed);
  try {
    const game = makeGame(scn.ground);
    const horse = new Horse(game);
    horse.place(0, 0, 0);
    horse.ridden = true;
    horse.mode = 'ridden';
    horse.graze = 0;
    horse.grazeWant = 0;
    horse.speed = scn.speed0;
    scn.control(horse, 0);
    const probe = makeProbe(horse);
    const bones = horse.rig.list;
    const per60 = Math.max(1, Math.round(1 / 60 / dt));
    const samples = [], frames60 = [];
    let prevQ = null;
    const nSettle = Math.round(scn.settle / dt), nRec = Math.round(scn.record / dt);
    let t = 0;
    for (let i = 0; i < nSettle + nRec; i++) {
      scn.control(horse, t);
      horse.update(dt);
      t += dt;
      if (i < nSettle) continue;
      // the pose as it is rendered: _pose() updates the world matrices before it bends the legs, ears and tail
      horse.root.updateMatrixWorld(true);
      const k = i - nSettle;
      const g = horse.gait;
      samples.push({
        t: +(k * dt).toFixed(9),
        lab: {
          phase: horse.phase, gait: g.name, gi: g.index, gw: g.w, speed: horse.speed, yawRate: horse.yawRate,
          duty: horse.duty, freq: g.freq, stance: [...horse.stance], reach: horse.legs.map((L) => !!L.ik.reach),
        },
        geo: probe.sample(scn.ground),
      });
      if (k % per60 === 0) {
        const q = bones.map((b) => relQuat(b.parent.matrixWorld.elements, b.matrixWorld.elements));
        const reach = samples[k].lab.reach;
        const f = { t: samples[k].t, i: k, stepLoco: 0, stepLocoBone: '', stepAll: 0, stepAllBone: '', unreached: reach.some((r) => !r), unreachedLegs: reach.map((r) => !r) };
        if (prevQ)
          for (let b = 0; b < bones.length; b++) {
            const a = (quatAngle(prevQ[b], q[b]) * 180) / Math.PI;
            if (a > f.stepAll) (f.stepAll = a), (f.stepAllBone = bones[b].name);
            if (!SECONDARY.test(bones[b].name) && a > f.stepLoco) (f.stepLoco = a), (f.stepLocoBone = bones[b].name);
          }
        prevQ = q;
        frames60.push(f);
      }
    }
    return { name, dt, seed, kind: scn.kind, speed: scn.speed ?? null, contactM: CONTACT_M, samples, frames60, hoof: probe.legs.map((L) => L.cap.model) };
  } finally {
    Math.random = real;
  }
}

// ---- CLI --------------------------------------------------------------------------------------------------------------
// (report.mjs imports this module: it is loaded once this one has finished evaluating, never awaited at the top level)
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain)
  import('./report.mjs')
    .then((m) => m.main(process.argv.slice(2)))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    });
