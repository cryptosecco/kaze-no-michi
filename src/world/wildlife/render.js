import * as THREE from 'three';

// Birds on the GPU: one InstancedMesh per species (a few hundred triangles), every pose in the vertex shader.
//   instanceMatrix : the hip joint's position, heading, pitch (climb, angle of attack, flare, pecking), bank, scale
//   aWing          : stroke (rad, + = up, about the body's long axis at the shoulder), hand (extra stroke of the outer
//                    wing: the whip of the beat), fold (0 spread → 1 tucked along the flank), sweep (rad, + = back)
//   aPose          : head yaw, head pitch (+ = down: a peck), legs (0 tucked → 1 down), tail fan (0..1)
//   aPose2         : cup (the hand curled down: flare), tail pitch (+ = up), body pitch (the legs stay vertical), crouch
//   aPose3         : step (stride: −1..1), lift (which foot swings: sign), head bob (thrust), flex (rad: the hand swept
//                    back at the wrist, the upstroke)
// Bird frame of the geometry: origin at the hip joint, +z forward, +y up, +x the bird's left; real sizes in metres. The
// wings are authored spread; their folded shape is a second position attribute (aAlt), the legs' tucked shape too.
// Materials go through game.add (atmosphere, fog), the shadow pass uses a depth material with the same deformation.

const VERT_PARS = /* glsl */ `
attribute vec4 aPart;   // x side (+1 left, -1 right, 0 middle), y span / along (0 root → 1 tip), z part, w weight
attribute vec3 aAlt;
attribute vec3 aAltN;
attribute vec4 aWing;
attribute vec4 aPose;
attribute vec4 aPose2;
attribute vec4 aPose3;
uniform vec4 uBirdWing;  // shoulder x, y, z, half span
uniform vec4 uBirdWrist; // wrist x, y, z (spread pose), span parameter of the wrist
uniform vec4 uBirdHead;  // neck pivot y, z, head-bob reach, —
uniform vec4 uBirdTail;  // tail base y, z, fan, —
uniform vec4 uBirdLeg;   // stride, foot lift, —, —
vec3 kzRx(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(v.x, v.y * c - v.z * s, v.y * s + v.z * c); }
vec3 kzRy(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(v.x * c + v.z * s, v.y, -v.x * s + v.z * c); }
vec3 kzRz(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(v.x * c - v.y * s, v.x * s + v.y * c, v.z); }
vec3 kzBird(vec3 p, inout vec3 n) {
  int part = int(aPart.z + 0.5);
  float side = aPart.x;
  if (part == 1) {
    // wing, two joints: the hand flexes back at the wrist (the upstroke: the span shrinks), curls down (cup) and
    // whips (extra stroke); the whole wing sweeps about the vertical at the shoulder and strokes about the body's long
    // axis; then toward the folded shape along the flank (perched, a bound)
    float s = aPart.y;
    vec3 m = n;
    float hk = smoothstep(uBirdWrist.w - 0.06, uBirdWrist.w + 0.04, s);
    vec3 wr = vec3(side * uBirdWrist.x, uBirdWrist.y, uBirdWrist.z);
    vec3 h = p - wr;
    float fl = side * aPose3.w * hk;
    h = kzRy(h, fl);
    m = kzRy(m, fl);
    float wh = side * aWing.y * hk;
    h = kzRz(h, wh);
    m = kzRz(m, wh);
    h.y -= aPose2.x * 0.35 * hk * dot(h.xz, h.xz) / max(1e-4, uBirdWing.w - uBirdWrist.x);
    vec3 sh = vec3(side * uBirdWing.x, uBirdWing.y, uBirdWing.z);
    vec3 q = wr + h - sh;
    float sw = side * aWing.w;
    q = kzRy(q, sw);
    m = kzRy(m, sw);
    float st = side * aWing.x;
    q = kzRz(q, st);
    m = kzRz(m, st);
    p = mix(sh + q, aAlt, aWing.z);
    n = normalize(mix(m, aAltN, aWing.z));
  } else if (part == 4) {
    // leg (y: 0 at the hip, 1 at the toes): stride, the swinging foot lifted, shortened by the crouch (the hip comes
    // down, the feet stay), kept vertical whatever the body's pitch; tucked under the belly in flight
    float k = aPart.y;
    vec3 q = p;
    float lift = side > 0.0 ? max(0.0, aPose3.y) : max(0.0, -aPose3.y);
    q.z += side * aPose3.x * uBirdLeg.x * k;
    q.y = q.y * (1.0 - 0.35 * aPose2.w) + lift * uBirdLeg.y * k;
    q = kzRx(q, aPose2.z);
    p = mix(aAlt, q, aPose.z);
    n = normalize(mix(aAltN, kzRx(n, aPose2.z), aPose.z));
  } else if (part == 3) {
    // head and neck: turn and nod about the neck's base (weighted along the neck), thrust forward when walking
    vec3 nk = vec3(0.0, uBirdHead.x, uBirdHead.y);
    float w = aPart.w;
    vec3 q = kzRy(kzRx(p - nk, aPose.y * w), aPose.x * w);
    n = kzRy(kzRx(n, aPose.y * w), aPose.x * w);
    p = nk + q + vec3(0.0, 0.0, aPose3.z * uBirdHead.z * w);
  } else if (part == 2) {
    // tail: fanned out sideways, flicked up or pressed down about its base
    vec3 tb = vec3(0.0, uBirdTail.x, uBirdTail.y);
    float t = aPart.y;
    vec3 q = p - tb;
    q.x *= 1.0 + aPose.w * uBirdTail.z * t;
    q = kzRx(q, aPose2.y);
    n = kzRx(n, aPose2.y);
    p = tb + q;
  }
  return p;
}
`;

// ------------------------------------------------------------------------------------------------ body plans

// linear colours (vertex colours are linear in three.js)
const srgb = (r, g, b) => [r, g, b].map((v) => Math.pow(v / 255, 2.2));

// Every species from the same parts, sized and shaped by its plan (metres, bird frame):
//   body    cross-sections [z, centre y, half width, half height] tail end → neck
//   head    centre, radii; bill: base z, tip z, base half width / height, tip y, culmen arch, hook (kite)
//   tail    base z / y, length, base / tip width, tip shape (+ rounded wedge, − forked), droop (rad)
//   wing    shoulder, leading / trailing edge stations [s, x, z] (s = 0 root → 1 tip), fingers (slotted primaries)
//   legs    hip half spacing, foot y (−hipH), toe length
const PLANS = {
  crow: {
    // glossy blue-black: a soft highlight tinted blue-violet. Feathers are no smooth dielectric: the stock specular
    // (and its grazing-angle Fresnel off the flat wings and tail, in a low golden sun) is cut to a fraction
    rough: 0.6,
    sheen: [0.13, 0.15, 0.22],
    body: [
      [-0.125, 0.03, 0.028, 0.024],
      [-0.085, 0.03, 0.052, 0.048],
      [-0.03, 0.03, 0.066, 0.063],
      [0.03, 0.04, 0.067, 0.067],
      [0.085, 0.058, 0.053, 0.054],
      [0.125, 0.078, 0.035, 0.037],
    ],
    head: { c: [0, 0.1, 0.163], r: [0.037, 0.041, 0.046] },
    bill: { z0: 0.192, z1: 0.268, w: 0.0135, h: 0.02, tipY: 0.079, arch: 0.012, hook: 0 },
    neck: [0.075, 0.115],
    tail: { z: -0.112, y: 0.032, len: 0.21, w0: 0.06, w1: 0.13, tip: 0.2, droop: 0.12, fan: 0.9, ridge: 0.016 },
    wing: {
      sh: [0.038, 0.07, 0.058],
      le: [[0, 0.038, 0.076], [0.24, 0.15, 0.099], [0.46, 0.258, 0.09], [0.72, 0.385, 0.056]],
      te: [[0, 0.038, -0.072], [0.24, 0.15, -0.118], [0.46, 0.258, -0.124], [0.72, 0.362, -0.108]],
      fingers: { n: 5, len: 0.14, w: 0.024, from: 0.18, to: -0.62 },
      span: 0.51,
      fold: { z0: 0.078, zw: 0.047, z1: -0.27, top: 0.08, depth: 0.075, x: 0.068 },
    },
    legs: { x: 0.021, top: -0.04, foot: -0.155, toe: 0.045, r: 0.0055, tuck: [-0.052, -0.088] },
    stride: 0.05,
    lift: 0.025,
    bob: 0.022,
    colors: { body: srgb(16, 16, 20), wing: srgb(18, 18, 22), tip: srgb(24, 23, 28), bill: srgb(9, 9, 11), leg: srgb(12, 12, 14) },
  },
  sparrow: {
    rough: 0.85,
    sheen: [0.12, 0.12, 0.12],
    // a plump little bird: round chest and belly, big head, short conical bill, a short notched tail
    body: [
      [-0.031, 0.012, 0.009, 0.009],
      [-0.021, 0.012, 0.02, 0.019],
      [-0.006, 0.012, 0.025, 0.025],
      [0.01, 0.015, 0.025, 0.025],
      [0.022, 0.021, 0.019, 0.02],
      [0.031, 0.027, 0.013, 0.014],
    ],
    head: { c: [0, 0.035, 0.039], r: [0.0145, 0.0155, 0.0165] },
    bill: { z0: 0.053, z1: 0.065, w: 0.005, h: 0.006, tipY: 0.031, arch: 0.0012, hook: 0 },
    neck: [0.026, 0.03],
    tail: { z: -0.028, y: 0.014, len: 0.046, w0: 0.016, w1: 0.026, tip: -0.12, droop: 0.02, fan: 0.8, ridge: 0.005 },
    wing: {
      sh: [0.012, 0.022, 0.016],
      le: [[0, 0.012, 0.022], [0.28, 0.038, 0.027], [0.5, 0.06, 0.023], [0.78, 0.087, 0.008], [1, 0.106, -0.012]],
      te: [[0, 0.012, -0.015], [0.28, 0.038, -0.027], [0.5, 0.06, -0.029], [0.78, 0.084, -0.027], [1, 0.106, -0.018]],
      fingers: null,
      span: 0.106,
      fold: { z0: 0.024, zw: 0.016, z1: -0.046, top: 0.029, depth: 0.025, x: 0.0255 },
    },
    legs: { x: 0.0065, top: -0.008, foot: -0.042, toe: 0.013, r: 0.0016, tuck: [-0.016, -0.022] },
    stride: 0.012,
    lift: 0.006,
    bob: 0.004,
    colors: {
      body: srgb(122, 86, 52),
      streak: srgb(52, 34, 20),
      belly: srgb(196, 186, 166),
      cap: srgb(118, 58, 30),
      cheek: srgb(226, 220, 208),
      bib: srgb(20, 18, 16),
      wing: srgb(110, 74, 44),
      bar: srgb(222, 214, 196),
      tip: srgb(70, 50, 34),
      tail: srgb(86, 60, 38),
      bill: srgb(36, 32, 28),
      leg: srgb(150, 112, 92),
    },
  },
  kite: {
    rough: 0.8,
    sheen: [0.14, 0.14, 0.14],
    body: [
      [-0.13, 0.03, 0.026, 0.022],
      [-0.09, 0.03, 0.045, 0.042],
      [-0.03, 0.03, 0.058, 0.056],
      [0.03, 0.04, 0.058, 0.058],
      [0.085, 0.056, 0.044, 0.046],
      [0.12, 0.072, 0.03, 0.032],
    ],
    head: { c: [0, 0.09, 0.152], r: [0.031, 0.034, 0.04] },
    bill: { z0: 0.178, z1: 0.212, w: 0.01, h: 0.014, tipY: 0.07, arch: 0.008, hook: 0.012 },
    neck: [0.07, 0.11],
    tail: { z: -0.118, y: 0.032, len: 0.26, w0: 0.07, w1: 0.17, tip: -0.18, droop: 0.06, fan: 1.1, ridge: 0.012 },
    wing: {
      sh: [0.036, 0.068, 0.056],
      le: [[0, 0.036, 0.078], [0.24, 0.2, 0.112], [0.46, 0.37, 0.102], [0.7, 0.55, 0.06]],
      te: [[0, 0.036, -0.08], [0.24, 0.2, -0.15], [0.46, 0.37, -0.16], [0.7, 0.52, -0.13]],
      fingers: { n: 6, len: 0.2, w: 0.03, from: 0.15, to: -0.65 },
      span: 0.775,
      fold: { z0: 0.08, zw: 0.05, z1: -0.33, top: 0.075, depth: 0.075, x: 0.06 },
    },
    legs: { x: 0.022, top: -0.04, foot: -0.15, toe: 0.04, r: 0.006, tuck: [-0.05, -0.09] },
    stride: 0.045,
    lift: 0.022,
    bob: 0.015,
    colors: { body: srgb(92, 64, 42), wing: srgb(74, 52, 36), tip: srgb(40, 30, 24), patch: srgb(176, 158, 132), bill: srgb(40, 34, 30), leg: srgb(196, 160, 60), tail: srgb(98, 70, 46) },
  },
};

// ------------------------------------------------------------------------------------------------ geometry builder
class Geo {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.col = [];
    this.part = [];
    this.alt = [];
    this.altN = [];
    this.idx = [];
  }
  v(p, n, c, part, alt = null, altN = null) {
    this.pos.push(p[0], p[1], p[2]);
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    this.nor.push(n[0] / l, n[1] / l, n[2] / l);
    this.col.push(c[0], c[1], c[2]);
    this.part.push(part[0], part[1], part[2], part[3]);
    const a = alt || p, an = altN || n;
    const al = Math.hypot(an[0], an[1], an[2]) || 1;
    this.alt.push(a[0], a[1], a[2]);
    this.altN.push(an[0] / al, an[1] / al, an[2] / al);
    return this.pos.length / 3 - 1;
  }
  tri(a, b, c) {
    this.idx.push(a, b, c);
  }
  quad(a, b, c, d) {
    this.idx.push(a, b, c, a, c, d);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(this.part, 4));
    g.setAttribute('aAlt', new THREE.Float32BufferAttribute(this.alt, 3));
    g.setAttribute('aAltN', new THREE.Float32BufferAttribute(this.altN, 3));
    g.setIndex(this.idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2);
    return g;
  }
}

const lerp = (a, b, t) => a + (b - a) * t;
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

// piecewise-linear [s, x, z] stations
function station(list, s) {
  for (let i = 0; i < list.length - 1; i++) {
    const a = list[i], b = list[i + 1];
    if (s <= b[0] || i === list.length - 2) {
      const t = Math.max(0, Math.min(1, (s - a[0]) / (b[0] - a[0] || 1)));
      return [lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
    }
  }
  return [list[0][1], list[0][2]];
}

function sparrowHeadColor(P, p) {
  // chestnut cap, white cheek with a black spot, black bib under the bill
  const C = P.colors, h = P.head;
  const dy = (p[1] - h.c[1]) / h.r[1], dz = (p[2] - h.c[2]) / h.r[2], dx = Math.abs(p[0] - h.c[0]) / h.r[0];
  if (dy > 0.35) return C.cap;
  if (dy < -0.35 && dz > -0.2 && dx < 0.6) return C.bib;
  if (dx > 0.55 && dy > -0.55 && dy < 0.35) {
    if (Math.abs(dz + 0.15) < 0.32 && dy < 0.05 && dy > -0.4) return C.bib; // the cheek spot
    return C.cheek;
  }
  return dz > 0.3 ? C.cheek : C.cap;
}

export function buildBird(name) {
  const P = PLANS[name];
  const g = new Geo();
  const C = P.colors;
  const sparrow = name === 'sparrow', kite = name === 'kite';
  // ---- body: lofted ellipses (the last two rings bend with the neck)
  const R = 10;
  const rings = [];
  P.body.forEach(([z, yc, hw, hh], si) => {
    const ring = [];
    const neckW = si === P.body.length - 1 ? 0.55 : si === P.body.length - 2 ? 0.2 : 0;
    for (let k = 0; k < R; k++) {
      const a = (k / R) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      const p = [hw * c, yc + hh * s, z];
      let col = C.body;
      if (sparrow) {
        col = s < -0.25 ? C.belly : (k + si) % 3 === 0 && s > 0.2 ? C.streak : C.body;
        if (si >= P.body.length - 2 && s < 0.1 && Math.abs(c) < 0.75) col = C.bib;
      }
      if (kite && s > 0.3 && (k + si) % 2 === 0) col = C.wing;
      ring.push(g.v(p, [c / hw, s / hh, 0], col, [0, 0, neckW > 0 ? 3 : 0, neckW]));
    }
    rings.push(ring);
  });
  for (let r = 0; r < rings.length - 1; r++)
    for (let k = 0; k < R; k++) {
      const k1 = (k + 1) % R;
      g.quad(rings[r][k], rings[r][k1], rings[r + 1][k1], rings[r + 1][k]);
    }
  {
    const [z, yc] = P.body[0];
    const tipC = g.v([0, yc, z - 0.012 * (sparrow ? 0.3 : 1)], [0, 0, -1], C.body, [0, 0, 0, 0]);
    for (let k = 0; k < R; k++) g.tri(tipC, rings[0][(k + 1) % R], rings[0][k]);
  }
  // ---- head: an ellipsoid on the neck (cap / cheek / bib for the sparrow)
  const H = P.head, HR = 10, HL = 7;
  const hv = [];
  for (let l = 0; l <= HL; l++) {
    const phi = (l / HL) * Math.PI; // 0 top → π bottom
    const row = [];
    for (let k = 0; k < HR; k++) {
      const a = (k / HR) * Math.PI * 2;
      const nx = Math.sin(phi) * Math.cos(a), ny = Math.cos(phi), nz = Math.sin(phi) * Math.sin(a);
      const p = [H.c[0] + nx * H.r[0], H.c[1] + ny * H.r[1], H.c[2] + nz * H.r[2]];
      const col = sparrow ? sparrowHeadColor(P, p) : kite ? (ny > 0.2 ? srgb(150, 128, 104) : C.body) : C.body;
      row.push(g.v(p, [nx / H.r[0], ny / H.r[1], nz / H.r[2]], col, [0, 0, 3, 1]));
    }
    hv.push(row);
  }
  for (let l = 0; l < HL; l++)
    for (let k = 0; k < HR; k++) {
      const k1 = (k + 1) % HR;
      g.quad(hv[l][k], hv[l + 1][k], hv[l + 1][k1], hv[l][k1]);
    }
  // ---- bill: a four-sided wedge, arched along the culmen (hooked for the kite)
  {
    const B = P.bill;
    const yb = H.c[1] - H.r[1] * 0.05;
    const base = [[0, yb + B.h, B.z0], [B.w, yb, B.z0], [0, yb - B.h, B.z0], [-B.w, yb, B.z0]];
    const zm = lerp(B.z0, B.z1, 0.55);
    const ym = lerp(yb, B.tipY, 0.5);
    const mid = [[0, ym + B.h * 0.55 + B.arch, zm], [B.w * 0.5, ym, zm], [0, ym - B.h * 0.4, zm], [-B.w * 0.5, ym, zm]];
    const tip = [0, B.tipY - B.hook, B.z1];
    const col = C.bill;
    const face = (a, b, c) => {
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      g.tri(g.v(a, n, col, [0, 0, 3, 1]), g.v(b, n, col, [0, 0, 3, 1]), g.v(c, n, col, [0, 0, 3, 1]));
    };
    for (let k = 0; k < 4; k++) {
      const k1 = (k + 1) % 4;
      face(base[k], mid[k], mid[k1]);
      face(base[k], mid[k1], base[k1]);
      face(mid[k], tip, mid[k1]);
    }
  }
  // ---- tail: a fan (rounded wedge, square or forked), drooping a little; t: 0 base → 1 tip, x spreads with the fan
  {
    const T = P.tail;
    const cols = 5;
    const dr = T.droop;
    const at = (u, t) => {
      const w = lerp(T.w0, T.w1, t) * 0.5;
      // tip shape: + longer in the middle (a rounded wedge), − longer at the sides (a fork)
      const len = T.len * t * (1 - (T.tip > 0 ? T.tip * u * u : -T.tip * (1 - Math.abs(u))) * t);
      // the folded feathers stack into a low tent along the middle (the tail has some depth seen from the side)
      const ridge = (T.ridge || 0) * (1 - Math.abs(u)) * (1 - 0.65 * t);
      // back from the base and a little down (the droop)
      return [u * w, T.y + ridge - len * Math.sin(dr), T.z - len * Math.cos(dr)];
    };
    const n = [0, Math.cos(dr), -Math.sin(dr)];
    const grid = [];
    for (let j = 0; j <= 2; j++) {
      const t = j / 2;
      const row = [];
      for (let i = 0; i < cols; i++) {
        const u = (i / (cols - 1)) * 2 - 1;
        const col = sparrow ? C.tail : kite ? (j === 2 ? C.tip : C.tail) : j === 2 ? C.tip : C.body;
        row.push(g.v(at(u, t), n, col, [u, t, 2, 0]));
      }
      grid.push(row);
    }
    for (let j = 0; j < 2; j++) for (let i = 0; i < cols - 1; i++) g.quad(grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]);
  }
  // ---- wings: spread planform (a strip root → hand, then the slotted primaries), folded shape along the flank
  for (const side of [1, -1]) {
    const W = P.wing, F = W.fold;
    const sx = (x) => x * side;
    const folded = (s, c) => {
      const z = s < 0.45 ? lerp(F.z0, F.zw, s / 0.45) : lerp(F.zw, F.z1, (s - 0.45) / 0.55);
      const y = F.top - c * F.depth * (1 - 0.45 * s) - 0.012 * s * (F.depth / 0.072);
      return [sx(F.x + 0.006 * (F.x / 0.063) * (1 - s) + 0.004 * c * (F.x / 0.063)), y, z];
    };
    const fn = [side, 0.25, 0];
    const yAt = (s) => W.sh[1] + 0.004 * (F.x / 0.063) * (1 - s);
    const stations = W.le.map((l) => l[0]);
    const sMax = stations[stations.length - 1];
    const vtx = (s, c) => {
      const le = station(W.le, s), te = station(W.te, s);
      const x = lerp(le[0], te[0], c), z = lerp(le[1], te[1], c);
      const ss = (x - W.sh[0]) / (W.span - W.sh[0]);
      let col = C.wing;
      if (sparrow) col = Math.abs(c - 0.32) < 0.06 && ss < 0.55 ? C.bar : Math.abs(c - 0.55) < 0.05 && ss < 0.4 ? C.bar : c > 0.6 && ss > 0.45 ? C.tip : C.wing;
      if (kite && ss > 0.5 && c > 0.35 && c < 0.75) col = C.patch;
      if (!sparrow && !kite && c > 0.75) col = C.tip;
      return g.v([sx(x), yAt(ss), z], [0, 1, 0], col, [side, ss, 1, 0], folded(ss, c), fn);
    };
    const cs = [0, 0.33, 0.66, 1];
    const sList = [];
    for (let i = 0; i < stations.length - 1; i++) {
      sList.push(stations[i], lerp(stations[i], stations[i + 1], 0.5));
    }
    sList.push(sMax);
    const grid = sList.map((s) => cs.map((c) => vtx(s, c)));
    for (let i = 0; i < grid.length - 1; i++)
      for (let j = 0; j < cs.length - 1; j++) {
        if (side > 0) g.quad(grid[i][j], grid[i][j + 1], grid[i + 1][j + 1], grid[i + 1][j]);
        else g.quad(grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]);
      }
    // slotted primaries: n tapering feathers fanning out from the hand's outer edge, overlapping at their base (the
    // hand reads as one surface), separate only toward the tips (the "fingers" of a crow or a kite)
    if (W.fingers) {
      const Fi = W.fingers;
      const le = station(W.le, sMax), te = station(W.te, sMax);
      for (let k = 0; k < Fi.n; k++) {
        const t = (k + 0.5) / Fi.n;
        const bx = lerp(le[0], te[0], 0.05 + t * 0.9), bz = lerp(le[1], te[1], 0.05 + t * 0.9);
        const ang = lerp(Fi.from, Fi.to, t); // forward-out → back-out
        const dx = Math.cos(ang), dz = Math.sin(ang);
        const len = Fi.len * (1 - 0.3 * Math.abs(t - 0.3));
        const gap = Math.hypot(te[0] - le[0], te[1] - le[1]) / Fi.n;
        const w0 = gap * 1.35, wm = Fi.w, w1 = Fi.w * 0.45;
        const px = -dz, pz = dx; // across the feather
        // base (2), middle (2: where the slot opens), tip (2)
        const rows = [
          [0, w0],
          [0.45, wm],
          [1, w1],
        ];
        const vs = rows.map(([u, w]) =>
          [1, -1].map((sgn) => {
            const x = bx + dx * len * u + px * w * 0.5 * sgn, z = bz + dz * len * u + pz * w * 0.5 * sgn;
            const ss = Math.min(1, (x - W.sh[0]) / (W.span - W.sh[0]));
            const c = Math.min(1, 0.12 + t * 0.85);
            return g.v([sx(x), yAt(ss) - 0.0015 * u, z], [0, 1, 0], u > 0.3 ? C.tip : C.wing, [side, ss, 1, 0], folded(lerp(0.8, 1, u), c), fn);
          })
        );
        for (let r = 0; r < 2; r++) {
          if (side > 0) g.quad(vs[r][0], vs[r][1], vs[r + 1][1], vs[r + 1][0]);
          else g.quad(vs[r][0], vs[r + 1][0], vs[r + 1][1], vs[r][1]);
        }
      }
    }
  }
  // ---- legs: tarsus (a thin three-sided prism) and toes (three forward, one back); tucked under the belly in flight
  for (const side of [1, -1]) {
    const L = P.legs;
    const x = L.x * side;
    const tuckY = L.tuck[0], tuckZ = L.tuck[1];
    const col = C.leg;
    const pr = (y, z) => [[x + L.r, y, z], [x - L.r * 0.5, y, z + L.r * 0.87], [x - L.r * 0.5, y, z - L.r * 0.87]];
    const top = pr(L.top, 0.0), bot = pr(L.foot + L.r, L.r * 2);
    const ttop = pr(tuckY * 0.6, -0.004), tbot = pr(tuckY, tuckZ);
    const kTop = (L.top - 0) / (L.foot - 0), kBot = 1;
    for (let e = 0; e < 3; e++) {
      const e1 = (e + 1) % 3;
      const nrm = [top[e][0] + top[e1][0] - 2 * x, 0, top[e][2] + top[e1][2]];
      const a = g.v(top[e], nrm, col, [side, kTop, 4, 0], ttop[e], nrm);
      const b = g.v(top[e1], nrm, col, [side, kTop, 4, 0], ttop[e1], nrm);
      const c = g.v(bot[e1], nrm, col, [side, kBot, 4, 0], tbot[e1], nrm);
      const d = g.v(bot[e], nrm, col, [side, kBot, 4, 0], tbot[e], nrm);
      g.quad(a, b, c, d);
    }
    // toes: flat on the perch at foot level, spread forward (and one back)
    const fz = L.r * 2;
    for (const [ang, len] of [[-0.45, 1], [0, 1.1], [0.45, 1], [Math.PI, 0.62]]) {
      const dx = Math.sin(ang) * side * (ang === Math.PI ? 0 : 1), dz = Math.cos(ang);
      const l = L.toe * len;
      const w = L.r * 1.1;
      const px = -dz, pz = dx;
      const y = L.foot + 0.0015;
      const p0 = [x + px * w, y, fz + pz * w], p1 = [x - px * w, y, fz - pz * w], p2 = [x + dx * l, y, fz + dz * l];
      const tk = [x, tuckY, tuckZ];
      g.tri(g.v(p0, [0, 1, 0], col, [side, 1, 4, 0], tk, [0, 1, 0]), g.v(p1, [0, 1, 0], col, [side, 1, 4, 0], tk, [0, 1, 0]), g.v(p2, [0, 1, 0], col, [side, 1, 4, 0], tk, [0, 1, 0]));
    }
  }
  const geo = g.build();
  geo.userData.plan = P;
  return geo;
}

// ------------------------------------------------------------------------------------------------ material + mesh
function inject(shader, uniforms, depth) {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\n' + VERT_PARS);
  if (depth) shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', 'vec3 kzBirdN = vec3(0.0, 1.0, 0.0);\nvec3 transformed = kzBird(position, kzBirdN);');
  else
    shader.vertexShader = shader.vertexShader
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(normal);\nvec3 kzBirdP = kzBird(position, objectNormal);')
      .replace('#include <begin_vertex>', 'vec3 transformed = kzBirdP;');
}

export class BirdMesh {
  constructor(name, max) {
    const P = PLANS[name];
    this.name = name;
    this.max = max;
    const geo = buildBird(name);
    const W = P.wing, T = P.tail;
    // the wrist: the last leading-edge station at mid span
    const wst = W.le.filter((l) => l[0] <= 0.5).pop();
    this.uniforms = {
      uBirdWing: { value: new THREE.Vector4(W.sh[0], W.sh[1], W.sh[2], W.span) },
      uBirdWrist: { value: new THREE.Vector4(wst[1], W.sh[1], wst[2], (wst[1] - W.sh[0]) / (W.span - W.sh[0])) },
      uBirdHead: { value: new THREE.Vector4(P.neck[0], P.neck[1], P.bob, 0) },
      uBirdTail: { value: new THREE.Vector4(T.y, T.z, T.fan, 0) },
      uBirdLeg: { value: new THREE.Vector4(P.stride, P.lift, 0, 0) },
      uBirdSheen: { value: new THREE.Vector3(...P.sheen) },
    };
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: P.rough, metalness: 0, side: THREE.DoubleSide });
    mat.userData.shaderKey = 'wildlife-bird';
    // Plumage gloss is a faint sheen (uBirdSheen scales the specular). Feathers are no sheet of lacquer: against
    // the sun their barbs shadow the glancing specular a smooth surface would throw at the camera (Fresnel → 1 seen
    // edge-on), so a crow flying against a low sun stays a dark silhouette instead of turning silver.
    mat.userData.onBeforeCompile = (shader) => {
      inject(shader, this.uniforms, false);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uBirdSheen;')
        .replace(
          '#include <lights_fragment_end>',
          `#include <lights_fragment_end>
  float kzBack = 1.0;
  #if NUM_SUN_LIGHTS > 0
    kzBack = smoothstep( -0.9, -0.4, dot( geometryViewDir, sunLights[ 0 ].direction ) );
  #elif NUM_DIR_LIGHTS > 0
    kzBack = smoothstep( -0.9, -0.4, dot( geometryViewDir, directionalLights[ 0 ].direction ) );
  #endif
  reflectedLight.directSpecular *= uBirdSheen * kzBack;
  reflectedLight.indirectSpecular *= uBirdSheen;`
        );
    };
    const depth = new THREE.MeshDepthMaterial({ side: THREE.DoubleSide });
    depth.onBeforeCompile = (shader) => inject(shader, this.uniforms, true);
    depth.customProgramCacheKey = () => 'kaze|wildlife-bird-depth';
    this.attrs = {};
    for (const k of ['aWing', 'aPose', 'aPose2', 'aPose3']) {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(k, a);
      this.attrs[k] = a;
    }
    const mesh = new THREE.InstancedMesh(geo, mat, max);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.customDepthMaterial = depth;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.name = 'wildlife-' + name;
    mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh = mesh;
    this.shadows = true; // false: this species never casts shadows (sync decides when it does)
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler(0, 0, 0, 'YXZ');
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();
  }

  // write the pose of these birds (within `far` metres of the camera) into the instance buffers; the species casts
  // shadows only while one of its birds is near the camera (farther off a bird's shadow is a few texels)
  sync(birds, cam, far = 230, shadowNear = 45) {
    const mesh = this.mesh, A = this.attrs, w = A.aWing.array, p = A.aPose.array, p2 = A.aPose2.array, p3 = A.aPose3.array;
    let n = 0, near = Infinity;
    for (const b of birds) {
      if (n >= this.max) break;
      const d2 = cam ? (b.x - cam.x) ** 2 + (b.z - cam.z) ** 2 : 0;
      if (d2 > far * far) continue;
      if (d2 < near) near = d2;
      this._e.set(-b.pitch, b.yaw, b.roll, 'YXZ');
      this._q.setFromEuler(this._e);
      this._m.compose(this._p.set(b.x, b.y, b.z), this._q, this._s.setScalar(b.scale));
      this._m.toArray(mesh.instanceMatrix.array, n * 16);
      const o = n * 4;
      w[o] = b.stroke;
      w[o + 1] = b.hand;
      w[o + 2] = b.fold;
      w[o + 3] = b.sweep;
      p[o] = b.headYaw;
      p[o + 1] = b.headPitch;
      p[o + 2] = b.legs;
      p[o + 3] = b.tailFan;
      p2[o] = b.cup;
      p2[o + 1] = b.tailPitch;
      p2[o + 2] = b.pitch;
      p2[o + 3] = b.crouch;
      p3[o] = b.step;
      p3[o + 1] = b.lift;
      p3[o + 2] = b.headBob;
      p3[o + 3] = b.flex;
      mesh.setColorAt(n, this._c.setScalar(b.tint));
      n++;
    }
    mesh.count = n;
    mesh.castShadow = this.shadows && near < shadowNear * shadowNear;
    if (n) {
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, n * 16);
      mesh.instanceMatrix.needsUpdate = true;
      for (const k in A) {
        A[k].clearUpdateRanges();
        A[k].addUpdateRange(0, n * 4);
        A[k].needsUpdate = true;
      }
      mesh.instanceColor.clearUpdateRanges();
      mesh.instanceColor.addUpdateRange(0, n * 3);
      mesh.instanceColor.needsUpdate = true;
    }
    return n;
  }
}

export { PLANS };
