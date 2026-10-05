// Tests for how the grass bends in the wind (run: npm test). The bend lives in GLSL, which cannot run here, so what is
// tested is its JS mirror (src/world/grassBend.js) and that the shaders Grass.js assembles carry the same constants,
// the same GLSL text and call the same functions. That the GLSL computes what the mirror does is checked on the GPU by
// scripts/grassbend.gpu.js, a probe snippet run by hand (node scripts/probe.mjs --file scripts/grassbend.gpu.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Grass } from '../src/world/Grass.js';
import { getPreset } from '../src/core/Quality.js';
import {
  BLADE_ARC_MAX,
  BLADE_ARC_GAIN,
  BLADE_ARC_GLSL,
  STALK_MAX_BEND,
  STALK_BEND_GLSL,
  LENS_FAR,
  LENS_DOWN,
  LENS_SPAN_FROM,
  LENS_SPAN_TO,
  PLUME_LENS_GLSL,
  bladeArc,
  bladeTipAngle,
  stalkBend,
  plumeLens,
  plumeSpan,
  plantLens,
} from '../src/world/grassBend.js';

// bends from a lull to well past the strongest guided gust (the ambient wind reaches ~1.1, the guiding wind ~2.0 plus
// the lean)
const BENDS = Array.from({ length: 51 }, (_, i) => i * 0.05); // 0 … 2.5
const range = (n) => Array.from({ length: n + 1 }, (_, i) => i / n);

// length of the blade's curve (per unit of blade height), from its points
function arcLength(bend, steps = 400) {
  let len = 0;
  let prev = bladeArc(bend, 0);
  for (let i = 1; i <= steps; i++) {
    const p = bladeArc(bend, i / steps);
    len += Math.hypot(p.reach - prev.reach, p.rise - prev.rise);
    prev = p;
  }
  return len;
}

test('a blade keeps its length at every bend (an arc, not a stretched parabola)', () => {
  for (const bend of BENDS) {
    const len = arcLength(bend);
    assert.ok(Math.abs(len - 1) < 0.01, `bend ${bend.toFixed(2)}: length ${len.toFixed(4)} H`);
  }
});

test('the tip is never below the root, and the whole blade stays above it', () => {
  for (const bend of [...BENDS, 5, 20, 1e3]) {
    for (const t of range(40)) {
      const p = bladeArc(bend, t);
      assert.ok(p.rise >= 0, `bend ${bend}, t ${t}: rise ${p.rise}`);
      if (t > 0) assert.ok(p.rise > 0, `bend ${bend}, t ${t}: the blade is at ground level`);
    }
    // a blade that rises more than 0.5 H clears any ground that climbs less steeply than its tip leans over
    const tip = bladeArc(bend, 1);
    assert.ok(tip.rise > 0.5, `bend ${bend}: the tip is only ${tip.rise.toFixed(2)} H high`);
  }
});

test('the tip angle grows with the bend and saturates below 90 degrees', () => {
  let prev = -Infinity;
  let prevStep = Infinity;
  for (let i = 0; i <= 60; i++) {
    const bend = i * 0.05;
    const a = bladeTipAngle(bend);
    assert.ok(a >= prev, `bend ${bend}: the angle fell (${a} < ${prev})`);
    if (i > 0) assert.ok(a > prev, `bend ${bend}: the angle did not grow`);
    assert.ok(a < Math.PI / 2, `bend ${bend}: ${((a * 180) / Math.PI).toFixed(1)} degrees`);
    // saturating: each step of bend adds less angle than the one before
    if (i > 1) assert.ok(a - prev < prevStep, `bend ${bend}: the angle does not saturate`);
    if (i > 0) prevStep = a - prev;
    prev = a;
  }
  assert.ok(bladeTipAngle(1e3) <= BLADE_ARC_MAX + 1e-12 && BLADE_ARC_MAX < Math.PI / 2);
  // the direction of the blade at its tip is the tip angle: sin/cos agree with it (up to the 1e-4 rad the formulas keep
  // away from 0/0 with)
  for (const bend of BENDS) {
    const tip = bladeArc(bend, 1);
    assert.ok(Math.abs(Math.atan2(tip.sin, tip.cos) - bladeTipAngle(bend)) < 2e-4, `bend ${bend}`);
  }
});

test('no bend is a straight vertical blade', () => {
  for (const t of range(20)) {
    const p = bladeArc(0, t);
    assert.ok(Math.abs(p.reach) < 1e-3 * t + 1e-12, `t ${t}: reach ${p.reach}`);
    assert.ok(Math.abs(p.rise - t) < 1e-6, `t ${t}: rise ${p.rise}`);
    assert.ok(Math.abs(p.sin) < 1e-3 && Math.abs(p.cos - 1) < 1e-6, `t ${t}: direction ${p.sin}, ${p.cos}`);
  }
  // and a gentle bend is a gentle one: the tip hardly leaves the vertical
  const gentle = bladeArc(0.05, 1);
  assert.ok(gentle.reach < 0.12 && gentle.rise > 0.99, `reach ${gentle.reach}, rise ${gentle.rise}`);
});

test('a blade bows further as the bend grows, and runs outward and upward along itself', () => {
  let prevReach = -Infinity;
  for (const bend of BENDS) {
    const p = bladeArc(bend, 1);
    assert.ok(p.reach >= prevReach - 1e-12, `bend ${bend}: reach ${p.reach} < ${prevReach}`);
    prevReach = p.reach;
    // no loop back toward the root
    let prev = bladeArc(bend, 0);
    for (const t of range(40).slice(1)) {
      const q = bladeArc(bend, t);
      assert.ok(q.reach >= prev.reach && q.rise >= prev.rise, `bend ${bend}, t ${t}`);
      prev = q;
    }
  }
});

// the lulls and the breeze are most of what the field does, and its look is art-directed: up to a bend of 0.3 (half of
// the ambient blades stay under it) the blade ends where the reference parabola puts it
test('a blade in a lull ends where the reference parabola puts it', () => {
  const old = (bend, t) => {
    const c = 0.42 * Math.min(bend * bend, 1.5);
    return { reach: bend * t * t, rise: t * (1 - c * t) };
  };
  for (const bend of [0.05, 0.1, 0.15, 0.2, 0.25, 0.3]) {
    const tip = bladeArc(bend, 1);
    const was = old(bend, 1);
    const f = (p) => `(${p.reach.toFixed(3)}, ${p.rise.toFixed(3)})`;
    assert.ok(
      Math.abs(tip.reach - was.reach) < 0.03 && Math.abs(tip.rise - was.rise) < 0.03,
      `bend ${bend}: tip ${f(tip)} vs ${f(was)}`
    );
  }
});

test("the stalk's response is monotonic, saturates and starts out as the plain bend", () => {
  let prev = -Infinity;
  for (let i = 0; i <= 120; i++) {
    const d = i * 0.05; // 0 … 6
    const s = stalkBend(d);
    assert.ok(s >= prev, `d ${d}: the response fell (${s} < ${prev})`);
    if (i > 0) assert.ok(s > prev, `d ${d}: no growth`);
    assert.ok(s < STALK_MAX_BEND, `d ${d}: ${s} past the limit ${STALK_MAX_BEND}`);
    prev = s;
  }
  // saturates: the strongest gust of the guiding wind (bend ~2) is within a few percent of the limit
  assert.ok(stalkBend(2) > 0.97 * STALK_MAX_BEND);
  // and a breeze leans the stalk as much as the wind bends it
  for (const d of [0.01, 0.05, 0.1]) assert.ok(Math.abs(stalkBend(d) / d - 1) < 0.03, `d ${d}`);
  // the reference response d / (1 + 0.9 d d) peaks at 1.054 and falls back: this one does not
  const old = (d) => d / (1 + 0.9 * d * d);
  assert.ok(old(2) < old(1.054), 'the reference response straightens the stalk up at the peak of a gust');
  assert.ok(stalkBend(2) > stalkBend(1.054), 'the current response keeps leaning');
});

test('the ambient lean of the stalk stays near the reference response', () => {
  const old = (d) => d / (1 + 0.9 * d * d);
  // 84% of the ambient bends are below 0.6, 94% below 0.8
  for (let d = 0.01; d <= 0.6; d += 0.01) {
    assert.ok(Math.abs(stalkBend(d) - old(d)) < 0.005, `d ${d.toFixed(2)}`);
  }
  for (let d = 0.6; d <= 0.8; d += 0.01) {
    assert.ok(Math.abs(stalkBend(d) - old(d)) < 0.02, `d ${d.toFixed(2)}`);
  }
});

// --- plumes at the lens ---------------------------------------------------------------------------------------------
const P11 = 1 / Math.tan((52 * Math.PI) / 360); // the play camera's projection (fov 52)
const near = (a, b, tol = 1e-12) => Math.abs(a - b) < tol;

test('a part of a plant dissolves within 0.55 of its radius, and is whole beyond it', () => {
  // level with the camera: the far radius
  assert.equal(plumeLens([0, 0, 0.5 * LENS_FAR]), 0);
  assert.equal(plumeLens([LENS_FAR, 0, 0]), 1);
  assert.equal(plumeLens([-LENS_FAR * 1.5, 0, 0]), 1);
  // looking steeply down on it (a raised camera over the field): the short one
  assert.equal(plumeLens([0, -0.5 * LENS_DOWN, 0.1]), 0);
  assert.equal(plumeLens([0.2, -1.2 * LENS_DOWN, 0.2]), 1);
  // a part above the camera behaves as one level with it
  assert.equal(plumeLens([0, 1.0, 1.0]), 0);
});

test('a plume lets go of the frame when it would span 40 to 60% of its height', () => {
  const L = 1.0;
  const dAt = (share) => (L * P11) / (2 * share); // distance at which a plume of length L spans `share` of the frame
  assert.ok(near(plumeSpan(L, dAt(LENS_SPAN_FROM), P11), 1, 1e-9));
  assert.ok(near(plumeSpan(L, dAt(LENS_SPAN_TO), P11), 0, 1e-9));
  assert.equal(plumeSpan(L, dAt(0.2), P11), 1);
  assert.equal(plumeSpan(L, dAt(1.0), P11), 0);
  // and it only goes as it comes closer
  let prev = 2;
  for (let d = 6; d > 0.05; d -= 0.01) {
    const s = plumeSpan(L, d, P11);
    assert.ok(s <= prev + 1e-12, `d ${d.toFixed(2)}`);
    prev = s;
  }
});

// the node, the middle and the end of a plume (offsets from the camera), as the shader computes them
const partsOf = ({ c0, C, E }) => [
  c0,
  [c0[0] + 0.5 * C[0] + 0.25 * E[0], c0[1] + 0.5 * C[1] + 0.25 * E[1], c0[2] + 0.5 * C[2] + 0.25 * E[2]],
  [c0[0] + E[0], c0[1] + E[1], c0[2] + E[2]],
];

// a plant `side` m to the side of the camera, its stalk tip a little below the lens, its plume leaving the tip upward
// and curling off in the direction of the wind (with the guiding wind behind the camera: across the frame)
const plant = (windAngle, side = 2.0) => {
  const L = 0.8;
  const c0 = [side, -0.6, 0.3];
  const C = [0, 0.5 * L, 0];
  const E = [Math.cos(windAngle) * 0.5 * L, 0.5 * L - 0.1, Math.sin(windAngle) * 0.5 * L];
  return { c0, C, E, L };
};
const lensOf = ({ c0, C, E, L }) => plantLens(c0, C, E, L, P11);

test('a plume reaching up to the lens is dissolved by its nearest part, the same plant out of reach is whole', () => {
  // the stalk's tip is looked down on from 1 m up (whole by itself), but the plume curls up to the camera's own height
  // 0.9 m from the lens: the part nearest the camera decides, not the tip
  const swept = { c0: [0.5, -1.0, 0.0], C: [0, 0.4, 0], E: [0.0, 0.9, 0.3], L: 0.8 };
  assert.equal(plumeLens(swept.c0), 1, 'the tip alone is out of reach ...');
  assert.equal(lensOf(swept), 0, '... the plant is gone');
  // the same plant 12 m away, in the same wind: whole
  const far = { ...swept, c0: [swept.c0[0] + 12, swept.c0[1], swept.c0[2] + 12] };
  assert.equal(lensOf(far), 1);
  // upright, 5 m from the camera: whole
  assert.equal(plantLens([4, -0.5, 3], [0, 0.4, 0], [0.05, 0.35, 0], 0.8, P11), 1);
});

// the largest change of a plant's fade from one frame to the next, as the wind turns its plume through half a turn (the
// guiding wind coming on) in 90 frames while the stalk swings with the gust, for plants at several distances from the
// camera and four starting directions
const turnSteps = (fade) => {
  let worst = 0;
  for (const side of [1.2, 2.0, 3.0, 4.5]) {
    for (let k = 0; k < 4; k++) {
      let prev = null;
      for (let f = 0; f <= 90; f++) {
        const p = plant((Math.PI * f) / 90 + (k * Math.PI) / 2, side);
        p.c0 = [p.c0[0] + 0.15 * Math.sin((f / 90) * Math.PI), p.c0[1], p.c0[2]];
        const v = fade(p);
        if (prev !== null) worst = Math.max(worst, Math.abs(v - prev));
        prev = v;
      }
    }
  }
  return worst;
};

test('the dissolve is gradual in time as the wind turns: no step between one frame and the next', () => {
  const worst = turnSteps(lensOf);
  assert.ok(worst < 0.03, `a plume changed by ${worst.toFixed(3)} of its opacity in one frame`);
  // the camera walking by (a stride a frame) fades plants as gradually
  let walk = 0;
  let prev = null;
  for (let f = 0; f <= 240; f++) {
    const z = 8 - f * 0.04; // 2.4 m/s past a plant beside the lens
    const v = plantLens([1.5, -0.8, z], [0, 0.4, 0], [0.4, 0.3, 0.2], 0.8, P11);
    if (prev !== null) walk = Math.max(walk, Math.abs(v - prev));
    prev = v;
  }
  assert.ok(walk < 0.05, `a plant changed by ${walk.toFixed(3)} of its opacity in one step of the camera`);
});

// the sweep above does reach the case it guards against: judging a plant by whichever of its parts is nearest the
// camera lets its radius jump when another part becomes the nearest, and a plume appears in one frame
test('judging a plant by its single nearest part would step: the sweep catches it', () => {
  const nearestPart = (p) => {
    const c = partsOf(p).sort((u, v) => Math.hypot(...u) - Math.hypot(...v))[0];
    return plumeLens(c) * plumeSpan(p.L, Math.hypot(...c), P11);
  };
  assert.ok(turnSteps(nearestPart) > 0.3, 'the sweep misses the jump it is there to catch');
});

// --- the shaders ----------------------------------------------------------------------------------------------------
// what the game compiles: the layers' own onBeforeCompile applied to a stand-in for three's standard vertex shader
const grass = new Grass({ quality: getPreset('medium') });
const vertexSource = (layer) => {
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  };
  layer.mesh.material.userData.onBeforeCompile(shader);
  return shader.vertexShader;
};
const sources = (kind) => grass.layers.filter((l) => l.kind === kind).map(vertexSource);
// the number a shader #define carries
const defined = (src, name) => {
  const m = src.match(new RegExp(`#define ${name} ([0-9.eE+-]+)\\b`));
  return m ? Number(m[1]) : null;
};

test('the blade layers carry the blade arc constants of the CPU mirror, and use the arc', () => {
  const blades = [...sources('near'), ...sources('mid')];
  assert.ok(sources('near').length >= 2 && sources('mid').length === 1, 'near and mid layers exist');
  for (const src of blades) {
    assert.equal(defined(src, 'KZ_BLADE_ARC_MAX'), BLADE_ARC_MAX);
    assert.equal(defined(src, 'KZ_BLADE_ARC_GAIN'), BLADE_ARC_GAIN);
    assert.ok(src.includes(BLADE_ARC_GLSL.trim()), 'the arc function is declared as exported');
    assert.ok(/kzBladeArc\(Dl, t, /.test(src), 'the bend of the blade goes through the arc');
    // none of the parabola's clamp and shortening is left behind
    assert.ok(!/Dl > 1\.25|shorten/.test(src), 'the clamped parabola is gone');
  }
});

test('the susuki layers carry the stalk and lens constants of the CPU mirror, and use them', () => {
  const stalks = sources('pampas');
  assert.equal(stalks.length, 2, 'the near and far pampas layers exist');
  for (const src of stalks) {
    assert.equal(defined(src, 'KZ_STALK_MAX_BEND'), STALK_MAX_BEND);
    assert.ok(src.includes(STALK_BEND_GLSL.trim()), 'the stalk function is declared as exported');
    assert.ok(/kzStalkBend\(kzDl\)/.test(src), "the stalk's bend goes through its response");
    assert.ok(!/1\.0 \+ 0\.9 \* dot\(D, D\)/.test(src), 'the non-monotonic response is gone');
    assert.equal(defined(src, 'KZ_LENS_FAR'), LENS_FAR);
    assert.equal(defined(src, 'KZ_LENS_DOWN'), LENS_DOWN);
    assert.equal(defined(src, 'KZ_LENS_SPAN_FROM'), LENS_SPAN_FROM);
    assert.equal(defined(src, 'KZ_LENS_SPAN_TO'), LENS_SPAN_TO);
    assert.ok(src.includes(PLUME_LENS_GLSL.trim()), 'the lens functions are declared as exported');
    const dissolve = /float kzLens = kzPlantLens\(tipPos - cameraPosition, C, E, plumeL\);/;
    assert.ok(dissolve.test(src), 'the plant dissolves by its nearest parts');
  }
});

test('the other layers do not declare the bend functions they do not use', () => {
  for (const src of [...sources('lily'), ...sources('tuft')]) {
    assert.ok(!/kzBladeArc|kzStalkBend|kzPlantLens/.test(src));
  }
  for (const src of sources('pampas')) assert.ok(!src.includes('kzBladeArc'));
  for (const src of [...sources('near'), ...sources('mid')]) assert.ok(!/kzStalkBend|kzPlantLens/.test(src));
});
