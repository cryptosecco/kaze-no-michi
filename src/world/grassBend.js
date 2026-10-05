// How the grass bends in the wind, in one place: Grass.js interpolates these constants and functions into its shaders,
// and the JS functions below are the CPU mirror of the GLSL ones, line for line. `npm test` (grassbend.test.mjs) tests
// the mirror and checks that every shader Grass.js assembles carries these constants and this very GLSL text. That the
// GLSL computes what the mirror does cannot run in node: scripts/grassbend.gpu.js evaluates the exported GLSL on the
// GPU against the mirror (node scripts/probe.mjs --file scripts/grassbend.gpu.js); run it after changing either.
import { smoothstep } from '../core/math.js';

const glslFloat = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

// Blades (VERT_BLADE, near and mid rings).
// A blade bows in a circular arc of constant length, its height H. The wind's bend |D| sets the angle the tip makes
// with the vertical, A = BLADE_ARC_MAX · tanh(BLADE_ARC_GAIN · |D| / BLADE_ARC_MAX): it grows with the bend and
// saturates a little short of 90°. A strong gust lays a blade over without stretching it into a horizontal needle, and
// the tip stays at least 0.66 H high and at most 0.62 H to the side. The blades are planted 4 cm into the ground, so a
// blade bent uphill keeps its tip above any slope (rise over run) gentler than 1.07 − 0.065 / H, H in m: 37° for a
// 0.2 m blade, 23° for 0.1 m, none for one under 6 cm, whose tip is under even level ground at full bend. The shortest
// thatch of the field, ring 1's, is 0.16 m before the grass mask and the clump noise scale it and about 0.1 m at the
// lowest of them (its median is 0.21 m), and shorter still where trampled or beside a camera in the grass. Its tip can
// end up under the ground on a steeper slope: measured between the spawn and the shrine in a guided gust, 0.2% of the
// tips, 2 cm under at most. (A parabolic bend with a hard clamp at |D| = 1.25 ends up 1.45 H long, 1.25 H to the side
// and 0.37 H high, with its last segments turned back down: on a 0.8 slope the tip of a 0.9 m blade ends up to 0.6 m
// under the ground.)
// The gain is that parabola's own: both lean a blade by about 2 rad per unit of bend at rest, so the lulls and the
// breeze, which are most of what the field does, look the same; only the fronts, where a parabola runs away, are
// different. (Fitted to the parabola over the ambient wind's blades: a tanh a little closer than an exponential.)
export const BLADE_ARC_MAX = 1.5; // rad: the tip's angle from the vertical in an endless gust (86°)
export const BLADE_ARC_GAIN = 2.1; // rad of tip angle per unit of bend at rest

// Angle (rad, from the vertical) of the tip of a blade bent by `bend`.
export function bladeTipAngle(bend) {
  return BLADE_ARC_MAX * Math.tanh((BLADE_ARC_GAIN * bend) / BLADE_ARC_MAX);
}

// The blade at the fraction t (0 root … 1 tip) of its length: how far it has reached sideways (toward the bend) and how
// high it has risen, per unit of blade height, and its direction there as (sin, cos) of its angle from the vertical.
export function bladeArc(bend, t) {
  const a = Math.max(bladeTipAngle(bend), 1e-4);
  const h = 0.5 * a * t;
  const sh = Math.sin(h);
  const ch = Math.cos(h);
  return { reach: (2 * sh * sh) / a, rise: (2 * sh * ch) / a, sin: 2 * sh * ch, cos: 1 - 2 * sh * sh };
}

// kzBladeArc(bend, t, reach, rise, dir) in the vertex shader. Half-angle forms: (1 − cos x) = 2 sin²(x/2) and
// sin x = 2 sin(x/2) cos(x/2), so there is no 0/0 at the root and no cancellation at a small bend; a bend of 0 gives
// the straight vertical blade (reach 0, rise t).
export const BLADE_ARC_GLSL = /* glsl */ `
#define KZ_BLADE_ARC_MAX ${glslFloat(BLADE_ARC_MAX)}
#define KZ_BLADE_ARC_GAIN ${glslFloat(BLADE_ARC_GAIN)}
void kzBladeArc(float bend, float t, out float reach, out float rise, out vec2 dir) {
  float a = max(KZ_BLADE_ARC_MAX * tanh(KZ_BLADE_ARC_GAIN * bend / KZ_BLADE_ARC_MAX), 1e-4);
  float h = 0.5 * a * t;
  float sh = sin(h), ch = cos(h);
  reach = 2.0 * sh * sh / a;
  rise = 2.0 * sh * ch / a;
  dir = vec2(2.0 * sh * ch, 1.0 - 2.0 * sh * sh);
}
`;

// Susuki stalks (VERT_PAMPAS).
// The stalk is stiff. The bend D the wind gives it is carried over as STALK_MAX_BEND · tanh(D / STALK_MAX_BEND): the
// same as D in a breeze, and ever slower toward STALK_MAX_BEND, which no gust passes, so a front can't lay the stalk
// down into the grass (where its plume would seem to float stalkless in mid-air) and the lean never falls back as the
// gust grows. (A response of 1 / (1 + 0.9 D·D) peaks at |D| = 1.05 and then straightens the stalk up again.)
// 0.6 is where the lean of the ambient wind stays closest to that response: within 0.004 of it up to a bend of 0.6 (84%
// of the ambient bends), 0.015 up to 0.8 (94%) and 0.04 up to its peak (99%); 0.0025 off on average.
export const STALK_MAX_BEND = 0.6;

export function stalkBend(d) {
  return STALK_MAX_BEND * Math.tanh(d / STALK_MAX_BEND);
}

// kzStalkBend(d) in the vertex shader: the same function of the bend's length d (the stalk's D is scaled by it / d).
export const STALK_BEND_GLSL = /* glsl */ `
#define KZ_STALK_MAX_BEND ${glslFloat(STALK_MAX_BEND)}
float kzStalkBend(float d) { return KZ_STALK_MAX_BEND * tanh(d / KZ_STALK_MAX_BEND); }
`;

// Susuki plumes near the lens (VERT_PAMPAS).
// A plume (0.5–1.1 m) streams downwind from its stalk's tip, so with the wind from behind the camera (the guiding wind)
// the plants beside and behind it throw their plumes across the frame, a metre or two from the lens. A plant therefore
// dissolves by the part of it nearest the camera (the node, the middle of the plume, its end), not by the tip alone,
// and a plume lets go when it would span LENS_SPAN_FROM … LENS_SPAN_TO of the frame's height. Each part fades on its
// own and the plant by the least of them: a smooth function of where the parts are, so as the wind turns the plume
// goes gradually, never in one frame. (Judging by the single nearest part instead lets the radius jump when another
// part becomes the nearest: a plume appears in one frame.)
export const LENS_FAR = 3.6; // m: a part at eye level or above the camera is gone within 0.55 × this, whole beyond it
export const LENS_DOWN = 0.9; // m: the same for a part the camera looks steeply down on (a field shot's foreground)
export const LENS_SPAN_FROM = 0.4; // share of the frame's height from which a plume starts to dissolve
export const LENS_SPAN_TO = 0.6; // ... and where it is gone

// What is left of a part of a plant at the offset c = [x, y, z] from the camera (1 whole … 0 dissolved).
export function plumeLens(c) {
  const down = -c[1] / Math.max(Math.hypot(c[0], c[2]), 0.1); // steepness of the camera's view down onto the part
  const r = LENS_FAR + (LENS_DOWN - LENS_FAR) * smoothstep(0.18, 0.45, down);
  return smoothstep(0.55 * r, r, Math.hypot(c[0], c[1], c[2]));
}

// What is left of a plume of length `plumeL` whose nearest part is `nearest` m from the camera, by the share of the
// frame's height it spans (`p11` = the projection matrix's [1][1], 1 / tan(fov / 2)).
export function plumeSpan(plumeL, nearest, p11) {
  return 1 - smoothstep(LENS_SPAN_FROM, LENS_SPAN_TO, (plumeL * p11) / (2 * Math.max(nearest, 0.05)));
}

// What is left of a plant whose stalk ends at c0 (offset from the camera) and whose plume runs from there as the
// quadratic curve with control point C and end E (offsets from c0): its node, the middle of its axis (0.5 C + 0.25 E)
// and its end (E) each fade on their own and the plant by the least of them, then by the span of the plume at its
// nearest.
export function plantLens(c0, C, E, plumeL, p11) {
  const c1 = [c0[0] + 0.5 * C[0] + 0.25 * E[0], c0[1] + 0.5 * C[1] + 0.25 * E[1], c0[2] + 0.5 * C[2] + 0.25 * E[2]];
  const c2 = [c0[0] + E[0], c0[1] + E[1], c0[2] + E[2]];
  const lens = Math.min(plumeLens(c0), plumeLens(c1), plumeLens(c2));
  const nearest = Math.min(Math.hypot(...c0), Math.hypot(...c1), Math.hypot(...c2));
  return lens * plumeSpan(plumeL, nearest, p11);
}

// kzPlumeLens(c), kzPlumeSpan(plumeL, nearest) and kzPlantLens(c0, C, E, plumeL) in the vertex shader (projectionMatrix
// is three's own uniform).
export const PLUME_LENS_GLSL = /* glsl */ `
#define KZ_LENS_FAR ${glslFloat(LENS_FAR)}
#define KZ_LENS_DOWN ${glslFloat(LENS_DOWN)}
#define KZ_LENS_SPAN_FROM ${glslFloat(LENS_SPAN_FROM)}
#define KZ_LENS_SPAN_TO ${glslFloat(LENS_SPAN_TO)}
float kzPlumeLens(vec3 c) {
  float r = mix(KZ_LENS_FAR, KZ_LENS_DOWN, smoothstep(0.18, 0.45, -c.y / max(length(c.xz), 0.1)));
  return smoothstep(0.55 * r, r, length(c));
}
float kzPlumeSpan(float plumeL, float nearest) {
  float span = plumeL * projectionMatrix[1][1] / (2.0 * max(nearest, 0.05));
  return 1.0 - smoothstep(KZ_LENS_SPAN_FROM, KZ_LENS_SPAN_TO, span);
}
float kzPlantLens(vec3 c0, vec3 C, vec3 E, float plumeL) {
  vec3 c1 = c0 + 0.5 * C + 0.25 * E;
  vec3 c2 = c0 + E;
  float lens = min(kzPlumeLens(c0), min(kzPlumeLens(c1), kzPlumeLens(c2)));
  return lens * kzPlumeSpan(plumeL, min(length(c0), min(length(c1), length(c2))));
}
`;
