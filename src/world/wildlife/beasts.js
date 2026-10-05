import * as THREE from 'three';
import { BODIES } from './quad.js';
import { characterShading } from '../../actors/gen/charShading.js';

// The fox and the sika deer on the GPU: procedural, skinned, low-poly bodies built around the rest skeletons of
// quad.js, one InstancedMesh per form (fox, deer — hinds and calves — and stag), every animal's bones in a float
// texture (one row per instance, three texels per bone: the rows of its 3×4 skinning matrix) read in the vertex
// shader by gl_InstanceID. Fur is vertex colour (coat, white chest and tail tip, black stockings; the deer's greyish
// autumn coat, faint spots, the black-edged white rump patch on a bone of its own that flares) lit like the
// characters (characterShading: the backlit rim of the fur, the sky fill, the ears glowing against the sun).
// Materials go through game.add (atmosphere, fog); the shadow pass skins the same way (depth material).
//   buildBeast(form)            BufferGeometry: position, normal, color, aKzSkin (4 bone indices), aKzWeight
//   new BeastMesh(form, max)    .mesh (add with game.add), sync(animals, camPos) → count drawn

// linear colours (vertex colours are linear in three.js)
const srgb = (r, g, b) => [r, g, b].map((v) => Math.pow(v / 255, 2.2));
const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const sm = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
// value noise for fur mottling (deterministic)
const hash3 = (x, y, z) => {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
};

// ------------------------------------------------------------------------------------------------ geometry builder
class Builder {
  constructor(body) {
    this.body = body;
    this.pos = [];
    this.col = [];
    this.skin = [];
    this.wt = [];
    this.alt = [];
    this.idx = [];
  }
  get n() {
    return this.pos.length / 3;
  }
  // alt: the vertex's offset at full flare (the rump patch), else none
  vert(p, c, sk, alt = null) {
    this.pos.push(p[0], p[1], p[2]);
    this.col.push(c[0], c[1], c[2]);
    this.alt.push(alt ? alt[0] : 0, alt ? alt[1] : 0, alt ? alt[2] : 0);
    for (let k = 0; k < 4; k++) {
      this.skin.push(sk[k] ? sk[k][0] : 0);
      this.wt.push(sk[k] ? sk[k][1] : 0);
    }
    return this.n - 1;
  }
  tri(a, b, c) {
    this.idx.push(a, b, c);
  }
  // a triangle wound so that its front faces `dir`
  triOut(a, b, c, dir) {
    const P = this.pos;
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * dir[0] + ny * dir[1] + nz * dir[2] >= 0) this.idx.push(a, b, c);
    else this.idx.push(a, c, b);
  }
  vpos(i) {
    return [this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]];
  }
  // A tube through centres pts[i] with elliptical sections (rx across, ry along `up`), `seg` around; colour(p, i, th)
  // and skin(p, i) per vertex; capped (a point a little beyond the ends) unless told otherwise. Winding: outward.
  tube(pts, radii, { seg = 10, up = [0, 1, 0], color, skin, cap0 = true, cap1 = true, shape = null }) {
    const n = pts.length;
    const rings = [];
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      let T = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
      const U = Array.isArray(up[0]) ? up[i] : up;
      // the section's frame: N toward `up` (orthogonal to the path), B = T × N (the animal's side)
      let N = sub(U, scale(T, dot(U, T)));
      if (len(N) < 1e-6) N = sub([0, 0, 1], scale(T, T[2]));
      N = norm(N);
      const B = cross(T, N);
      const [rx, ry] = radii[i];
      const ring = [];
      for (let j = 0; j < seg; j++) {
        const th = (j / seg) * Math.PI * 2;
        let c = Math.cos(th), s = Math.sin(th);
        const k = shape ? shape(i, th) : 1;
        // th = 0 along +N (up), π/2 along +B
        const p = [pts[i][0] + (N[0] * c * ry + B[0] * s * rx) * k, pts[i][1] + (N[1] * c * ry + B[1] * s * rx) * k, pts[i][2] + (N[2] * c * ry + B[2] * s * rx) * k];
        ring.push(this.vert(p, color(p, i, th), skin(p, i)));
      }
      rings.push(ring);
    }
    for (let i = 0; i < n - 1; i++) {
      const cm = lerp3(pts[i], pts[i + 1], 0.5);
      for (let j = 0; j < seg; j++) {
        const j1 = (j + 1) % seg;
        const a = rings[i][j], b = rings[i][j1], c = rings[i + 1][j], d = rings[i + 1][j1];
        // outward: away from the axis
        const out = sub(lerp3(this.vpos(a), this.vpos(d), 0.5), cm);
        this.triOut(a, b, c, out);
        this.triOut(b, d, c, out);
      }
    }
    const capAt = (i, dir) => {
      const T = norm(sub(pts[i], pts[i - dir]));
      const r = Math.min(radii[i][0], radii[i][1]);
      const p = [pts[i][0] + T[0] * r * 0.35, pts[i][1] + T[1] * r * 0.35, pts[i][2] + T[2] * r * 0.35];
      const ci = this.vert(p, color(p, i, 0), skin(p, i));
      for (let j = 0; j < seg; j++) this.triOut(rings[i][j], rings[i][(j + 1) % seg], ci, T);
    };
    if (cap0 && n > 1) capAt(0, -1);
    if (cap1 && n > 1) capAt(n - 1, 1);
    return rings;
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aKzSkin', new THREE.Float32BufferAttribute(this.skin, 4));
    g.setAttribute('aKzWeight', new THREE.Float32BufferAttribute(this.wt, 4));
    g.setAttribute('aKzAlt', new THREE.Float32BufferAttribute(this.alt, 3));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 0), 2.5);
    return g;
  }
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => scale(a, 1 / (len(a) || 1));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// distance from p to the segment a–b
function segDist(p, a, b) {
  const ab = sub(b, a), t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / (dot(ab, ab) || 1)));
  return len(sub(p, add(a, scale(ab, t))));
}

// skin weights to the nearest bone segments among the candidates (inverse distance^power, the best four)
function skinBy(body, names, power = 4, bias = {}) {
  const segs = names.map((n) => {
    const b = body.bones[body.index[n]];
    return { i: body.index[n], a: b.head, b: b.tail, k: bias[n] ?? 1 };
  });
  return (p) => {
    const w = segs.map((s) => [s.i, s.k / Math.pow(segDist(p, s.a, s.b) + 2e-3, power)]);
    w.sort((x, y) => y[1] - x[1]);
    const top = w.slice(0, 4);
    const sum = top.reduce((a, x) => a + x[1], 0);
    return top.map(([i, v]) => [i, v / sum]);
  };
}
const rigid = (body, name) => {
  const i = body.index[name];
  return () => [[i, 1]];
};

// the trunk: pelvis / body / chest blended along z (a quadratic B-spline), so the spine bends smoothly
function trunkSkin(body) {
  const P = body.plan;
  const zp = P.pelvis[2], zc = P.chest[2];
  const ip = body.index.pelvis, ib = body.index.body, ic = body.index.chest;
  return (p) => {
    const t = Math.max(0, Math.min(1, (p[2] - zp) / (zc - zp)));
    return [[ip, (1 - t) * (1 - t)], [ib, 2 * t * (1 - t)], [ic, t * t]];
  };
}

// profile table lookup: rows [z, ...values]
function prof(T, z, k) {
  if (z <= T[0][0]) return T[0][k];
  for (let i = 0; i < T.length - 1; i++)
    if (z <= T[i + 1][0]) {
      const t = (z - T[i][0]) / (T[i + 1][0] - T[i][0]);
      const s = t * t * (3 - 2 * t) * 0.35 + t * 0.65;
      return T[i][k] + (T[i + 1][k] - T[i][k]) * s;
    }
  return T[T.length - 1][k];
}

// a trunk lofted along z through superellipse sections: profile rows [z, top, bottom, half width]; n: exponent
function trunk(B, T, { seg = 14, rings = 16, color, skin, nTop = 2.3, nBot = 2.1 }) {
  const z0 = T[0][0], z1 = T[T.length - 1][0];
  const pts = [], radii = [];
  for (let i = 0; i < rings; i++) {
    const z = z0 + ((z1 - z0) * i) / (rings - 1);
    const top = prof(T, z, 1), bot = prof(T, z, 2), hw = prof(T, z, 3);
    pts.push([0, (top + bot) / 2, z]);
    radii.push([hw, (top - bot) / 2]);
  }
  // superellipse: flatter flanks, a rounded back and belly
  const shape = (i, th) => {
    const c = Math.abs(Math.cos(th)), s = Math.abs(Math.sin(th));
    const n = Math.cos(th) > 0 ? nTop : nBot;
    return Math.pow(Math.pow(c, n) + Math.pow(s, n), -1 / n);
  };
  return B.tube(pts, radii, { seg, up: [0, 1, 0], color, skin, shape, cap0: true, cap1: true });
}

// an ellipsoid (lat-long), rigid on one bone
function ellipsoid(B, c, r, color, skin, lat = 5, lon = 8) {
  const rows = [];
  for (let i = 0; i <= lat; i++) {
    const ph = (i / lat) * Math.PI;
    const row = [];
    for (let j = 0; j < lon; j++) {
      const th = (j / lon) * Math.PI * 2;
      const p = [c[0] + Math.sin(ph) * Math.cos(th) * r[0], c[1] + Math.cos(ph) * r[1], c[2] + Math.sin(ph) * Math.sin(th) * r[2]];
      row.push(B.vert(p, color(p), skin(p)));
    }
    rows.push(row);
  }
  for (let i = 0; i < lat; i++)
    for (let j = 0; j < lon; j++) {
      const j1 = (j + 1) % lon;
      B.tri(rows[i][j], rows[i][j1], rows[i + 1][j]);
      B.tri(rows[i][j1], rows[i + 1][j1], rows[i + 1][j]);
    }
}

// an ear: a cupped leaf from the base (two corners) to the tip, two-sided (front pale, back coloured)
function ear(B, base, tip, side, w, { front, back, skin, cup = 0.35, thick = 0.006 }) {
  const ax = sub(tip, base), L = len(ax), T = norm(ax);
  // across the ear: sideways (out of the head); F: the side its opening faces (forward)
  let X = sub([side, 0, 0], scale(T, T[0] * side));
  X = norm(X);
  let F = sub(sub([0, 0, 1], scale(T, T[2])), scale(X, X[2]));
  F = norm(F);
  const rows = 4, cols = 4;
  const grid = [[], []];
  for (const face of [0, 1]) {
    for (let i = 0; i <= rows; i++) {
      const t = i / rows;
      const half = w * 0.5 * Math.pow(1 - t, 0.85) * (1 - 0.15 * (1 - t));
      const row = [];
      for (let j = 0; j <= cols; j++) {
        const u = (j / cols) * 2 - 1;
        const depth = cup * w * (1 - u * u) * (1 - t) * 0.5;
        let p = add(add(base, scale(T, t * L)), scale(X, u * half));
        p = add(p, scale(F, -depth + (face ? -thick : 0)));
        row.push(B.vert(p, face ? back(p, t) : front(p, t), skin(p)));
      }
      grid[face].push(row);
    }
  }
  for (const face of [0, 1]) {
    const dir = face ? scale(F, -1) : F;
    for (let i = 0; i < rows; i++)
      for (let j = 0; j < cols; j++) {
        const g = grid[face];
        const a = g[i][j], b = g[i][j + 1], c = g[i + 1][j], d = g[i + 1][j + 1];
        B.triOut(a, b, c, dir);
        B.triOut(b, d, c, dir);
      }
  }
  // the rim between the two faces
  const g0 = grid[0], g1 = grid[1];
  for (let i = 0; i < rows; i++)
    for (const j of [0, cols]) {
      const out = scale(X, j ? 1 : -1);
      B.triOut(g0[i][j], g0[i + 1][j], g1[i][j], out);
      B.triOut(g0[i + 1][j], g1[i + 1][j], g1[i][j], out);
    }
}

// leg tube through the rest joints of one leg (plus extra points), radii per point; skinned on the leg's bones
function legTube(B, body, l, pts, radii, color, seg = 7) {
  const leg = body.legs[l];
  const names = leg.bones.map((i) => body.bones[i].name);
  const girdle = leg.fore ? 'chest' : 'pelvis';
  const sk = skinBy(body, [girdle, ...names], 4, { [girdle]: 0.5 });
  // the legs' sections face forward-up: their "up" turned to +z (the front of the leg)
  B.tube(pts, radii, { seg, up: [0, 0, 1], color, skin: sk, cap0: true, cap1: false });
}

// joints of a leg in rest model space: 3D points [x, y, z]
function legPts(body, l) {
  const b = body.bones;
  return body.legs[l].bones.map((i) => b[i].head).concat([b[body.legs[l].bones[body.legs[l].bones.length - 1]].tail]);
}

// ------------------------------------------------------------------------------------------------ the fox
const FOX = {
  coat: srgb(190, 98, 40),
  back: srgb(150, 74, 32),
  pale: srgb(222, 166, 104),
  white: srgb(236, 230, 218),
  belly: srgb(206, 196, 180),
  black: srgb(30, 22, 18),
  nose: srgb(18, 14, 12),
  eye: srgb(42, 26, 10),
};

function buildFox() {
  const body = BODIES.fox, P = body.plan;
  const B = new Builder(body);
  const C = FOX;
  // ---- trunk: a deep narrow chest, a tucked belly; the coat orange, darker along the back, the belly pale, the chest
  // white
  const T = [
    [-0.24, 0.345, 0.3, 0.028],
    [-0.215, 0.36, 0.262, 0.05],
    [-0.17, 0.372, 0.238, 0.062],
    [-0.11, 0.37, 0.235, 0.062],
    [-0.05, 0.368, 0.226, 0.066],
    [0.01, 0.37, 0.21, 0.07],
    [0.07, 0.378, 0.195, 0.073],
    [0.12, 0.386, 0.188, 0.068],
    [0.165, 0.375, 0.198, 0.058],
    [0.2, 0.352, 0.225, 0.044],
  ];
  const fur = (p) => 0.92 + 0.16 * hash3(Math.round(p[0] * 60), Math.round(p[1] * 60), Math.round(p[2] * 60));
  trunk(B, T, {
    color: (p) => {
      const top = prof(T, p[2], 1), bot = prof(T, p[2], 2);
      const v = (p[1] - bot) / (top - bot); // 0 belly → 1 back
      let c = mixc(C.belly, C.coat, sm(0.18, 0.42, v));
      c = mixc(c, C.back, sm(0.8, 0.98, v) * 0.7);
      // the white bib on the chest, between the fore legs
      const bib = sm(0.1, 0.17, p[2]) * (1 - sm(0.25, 0.5, v)) * (1 - sm(0.035, 0.06, Math.abs(p[0])));
      c = mixc(c, C.white, bib);
      return scale(c, fur(p));
    },
    skin: trunkSkin(body),
  });
  // ---- neck: thick with the ruff; white throat
  const nk = [[0, 0.305, 0.155], [0, 0.33, 0.2], [0, 0.365, 0.245], [0, 0.392, 0.28]];
  const neckSkin = skinBy(body, ['chest', 'neck1', 'neck2', 'head'], 4, { chest: 0.6 });
  B.tube(nk, [[0.052, 0.062], [0.05, 0.058], [0.045, 0.05], [0.038, 0.043]], {
    seg: 10, up: [0, 1, 0.3], skin: neckSkin, cap0: false, cap1: false,
    color: (p, i, th) => {
      const down = Math.cos(th); // +1 the crest, −1 the throat
      let c = mixc(C.white, C.coat, sm(-0.55, -0.1, down));
      return scale(mixc(c, C.back, sm(0.6, 1, down) * 0.5), fur(p));
    },
  });
  // ---- head: a wedge, the cheeks ruffed; orange above, white lips, cheeks and chin; black nose
  const h0 = [0, 0.412, 0.252], h1 = P.nose;
  const HS = [
    // s, half width, up, down (from the axis): a broad ruffed face, the slender muzzle
    [0.0, 0.03, 0.028, 0.028],
    [0.1, 0.052, 0.041, 0.04],
    [0.26, 0.062, 0.039, 0.047],
    [0.42, 0.046, 0.031, 0.034],
    [0.56, 0.03, 0.023, 0.025],
    [0.74, 0.021, 0.018, 0.018],
    [0.9, 0.015, 0.014, 0.013],
    [1.0, 0.007, 0.007, 0.006],
  ];
  const hpts = HS.map(([s]) => lerp3(h0, h1, s));
  const hrad = HS.map(([, w, u, d]) => [w, (u + d) / 2]);
  const headSkin = rigid(body, 'head');
  B.tube(hpts.map((p, i) => add(p, [0, (HS[i][2] - HS[i][3]) / 2, 0])), hrad, {
    seg: 12, up: [0, 1, 0.1], skin: headSkin, cap0: true, cap1: true,
    color: (p, i, th) => {
      const s = HS[i][0], up = Math.cos(th), side = Math.abs(Math.sin(th));
      let c = C.coat;
      // white: the lower jaw and lips, the cheeks below the eye line
      const white = sm(-0.15, -0.5, up) * (s > 0.15 ? 1 : 0.3);
      c = mixc(c, C.white, white);
      if (s > 0.94) c = C.nose;
      // the dark muzzle line from the eye to the lip
      if (s > 0.45 && s < 0.9 && up > -0.3 && up < 0.15 && side > 0.8) c = mixc(c, C.black, 0.35);
      return scale(c, fur(p));
    },
  });
  // eyes: dark amber ovals, slanted
  for (const sx of [1, -1]) {
    const e = add(lerp3(h0, h1, 0.4), [sx * 0.028, 0.017, 0]);
    ellipsoid(B, e, [0.007, 0.006, 0.01], () => C.eye, headSkin, 4, 6);
  }
  // ---- ears: big, pointed, black-backed, pale inside
  for (const [sx, n] of [[1, 'earL'], [-1, 'earR']]) {
    const base = [sx * P.ear[0], P.ear[1] - 0.004, P.ear[2]], tip = [sx * P.earTip[0], P.earTip[1], P.earTip[2]];
    ear(B, base, tip, sx, 0.056, { front: (p, t) => mixc(C.white, C.coat, sm(0.75, 1, t) * 0.4), back: (p, t) => mixc(C.coat, C.black, sm(0.15, 0.45, t)), skin: rigid(body, n), cup: 0.5 });
  }
  // ---- legs: orange above, black stockings below (the fore legs' fronts from the elbow, the hind from the hock)
  for (let l = 0; l < 4; l++) {
    const leg = body.legs[l];
    const J = legPts(body, l);
    let pts, radii, blackFrom;
    // sections [across, fore-aft]: the shoulder and the thigh flat against the trunk (no flaps standing out of it)
    if (leg.fore) {
      // shoulder (inside the trunk: the blade's swing stays under the coat) → shoulder joint → elbow → carpus →
      // fetlock → toe
      pts = [lerp3(J[0], J[1], 0.72), J[1], lerp3(J[1], J[2], 0.5), J[2], lerp3(J[2], J[3], 0.5), J[3], J[4], J[5]];
      radii = [[0.016, 0.03], [0.021, 0.034], [0.021, 0.028], [0.017, 0.02], [0.013, 0.015], [0.011, 0.012], [0.012, 0.011], [0.013, 0.007]];
      blackFrom = J[2][1] - 0.02;
    } else {
      // hip → thigh → stifle → gaskin → hock → metatarsus → fetlock → toe (the fox's thick "trousers")
      pts = [lerp3(J[0], J[1], 0.1), lerp3(J[0], J[1], 0.55), J[1], lerp3(J[1], J[2], 0.5), J[2], lerp3(J[2], J[3], 0.5), J[3], J[4]];
      radii = [[0.024, 0.06], [0.03, 0.055], [0.026, 0.034], [0.018, 0.024], [0.013, 0.016], [0.011, 0.012], [0.012, 0.011], [0.013, 0.007]];
      blackFrom = J[2][1] + 0.01;
    }
    legTube(B, body, l, pts, radii, (p) => {
      const k = sm(blackFrom + 0.03, blackFrom - 0.01, p[1]);
      const front = leg.fore ? 1 : sm(-0.01, 0.01, p[2] - J[2][2]) * 0.5 + 0.5;
      return scale(mixc(C.coat, C.black, k * front), fur(p));
    });
    // the paw: a small oval pad of toes on the ground
    const toe = J[J.length - 1], fet = J[J.length - 2];
    ellipsoid(B, lerp3(fet, toe, 0.55), [0.017, 0.011, 0.024], () => C.black, rigid(body, body.bones[leg.bones[leg.bones.length - 1]].name), 4, 7);
  }
  // ---- the brush: long, very bushy, the darker top, the white tip
  const tp = P.tail.map((p) => p.slice());
  const tailNames = [];
  for (let i = 1; i <= body.tail; i++) tailNames.push('tail' + i);
  const tailSkin = skinBy(body, ['pelvis', ...tailNames], 4, { pelvis: 0.4 });
  // densify the tail path
  const tpts = [], trad = [];
  const profile = [0.03, 0.05, 0.062, 0.064, 0.058, 0.044, 0.02];
  for (let i = 0; i <= 12; i++) {
    const u = i / 12;
    const f = u * (tp.length - 1), k = Math.min(tp.length - 2, Math.floor(f));
    tpts.push(lerp3(tp[k], tp[k + 1], f - k));
    const pr = u * (profile.length - 1), pk = Math.min(profile.length - 2, Math.floor(pr));
    const r = profile[pk] + (profile[pk + 1] - profile[pk]) * (pr - pk);
    trad.push([r * 0.92, r]);
  }
  B.tube(tpts, trad, {
    seg: 10, up: [0, 1, 0], skin: tailSkin, cap0: true, cap1: true,
    color: (p, i, th) => {
      const u = i / 12;
      let c = mixc(C.coat, C.back, sm(0.2, 1, Math.cos(th)) * 0.6);
      c = mixc(c, C.black, sm(0.65, 0.8, u) * 0.35 * (1 - sm(0.82, 0.86, u)));
      c = mixc(c, C.white, sm(0.82, 0.88, u));
      return scale(c, fur(p));
    },
  });
  return B.build();
}

// ------------------------------------------------------------------------------------------------ the sika deer
const DEER = {
  coat: srgb(64, 55, 47), // dark greyish brown, the autumn coat
  back: srgb(48, 41, 35),
  stripe: srgb(30, 25, 21),
  belly: srgb(116, 106, 94),
  leg: srgb(78, 67, 57),
  white: srgb(236, 232, 224),
  black: srgb(20, 17, 15),
  hoof: srgb(26, 22, 20),
  muzzle: srgb(46, 39, 33),
  nose: srgb(22, 18, 16),
  spot: srgb(92, 80, 68),
  mane: srgb(38, 32, 28),
  antler: srgb(104, 84, 62),
  tip: srgb(200, 186, 162),
  eye: srgb(14, 10, 8),
};

function buildDeer(stag) {
  const body = BODIES.deer, P = body.plan;
  const B = new Builder(body);
  const C = DEER;
  const fur = (p) => 0.94 + 0.12 * hash3(Math.round(p[0] * 40), Math.round(p[1] * 40), Math.round(p[2] * 40));
  // faint spots in two rows along the flanks (the autumn coat keeps only a trace of them)
  const spots = (p) => {
    if (Math.abs(p[0]) < 0.08) return 0;
    let k = 0;
    for (const [y0, dz] of [[0.715, 0.11], [0.665, 0.12]]) {
      const zz = (p[2] + 0.4) / dz, zi = Math.round(zz);
      if (zi < 0 || zi > 6) continue;
      const d = Math.hypot((zz - zi) * dz, p[1] - y0 - 0.01 * (zi % 2));
      k = Math.max(k, 1 - sm(0.012, 0.022, d));
    }
    return k;
  };
  const T = [
    [-0.505, 0.73, 0.63, 0.05],
    [-0.475, 0.775, 0.565, 0.112],
    [-0.4, 0.8, 0.525, 0.136],
    [-0.3, 0.805, 0.5, 0.146],
    [-0.18, 0.795, 0.475, 0.152],
    [-0.05, 0.79, 0.455, 0.16],
    [0.08, 0.795, 0.45, 0.162],
    [0.2, 0.812, 0.455, 0.15],
    [0.3, 0.79, 0.475, 0.126],
    [0.37, 0.745, 0.52, 0.09],
  ];
  trunk(B, T, {
    seg: 16,
    rings: 18,
    color: (p) => {
      const top = prof(T, p[2], 1), bot = prof(T, p[2], 2);
      const v = (p[1] - bot) / (top - bot);
      let c = mixc(C.belly, C.coat, sm(0.12, 0.35, v));
      c = mixc(c, C.back, sm(0.78, 0.95, v) * 0.8);
      // the dark stripe down the spine
      c = mixc(c, C.stripe, (1 - sm(0.012, 0.03, Math.abs(p[0]))) * sm(0.9, 1, v));
      c = mixc(c, C.spot, spots(p) * (stag ? 0 : 0.5));
      // the rump: a little paler right round the patch (the patch itself is a shell of its own)
      c = mixc(c, C.belly, sm(-0.46, -0.5, p[2]) * sm(0.3, 0.6, v) * 0.5);
      if (stag) c = mixc(c, C.mane, sm(0.22, 0.36, p[2]) * 0.6);
      return scale(c, fur(p));
    },
    skin: trunkSkin(body),
  });
  // ---- neck: long; the stag's thick with the dark rutting mane
  const nk = [[0, 0.64, 0.31], [0, 0.72, 0.385], [0, 0.8, 0.445], [0, 0.88, 0.495], [0, 0.945, 0.53]];
  const nr = stag ? [[0.1, 0.14], [0.09, 0.125], [0.078, 0.104], [0.066, 0.085], [0.058, 0.07]] : [[0.085, 0.12], [0.07, 0.098], [0.058, 0.08], [0.05, 0.066], [0.046, 0.058]];
  const neckSkin = skinBy(body, ['chest', 'neck1', 'neck2', 'head'], 4, { chest: 0.6 });
  B.tube(nk, nr, {
    seg: 12, up: [0, 0.6, -1], skin: neckSkin, cap0: false, cap1: false,
    color: (p, i, th) => {
      const crest = Math.cos(th);
      let c = mixc(C.belly, C.coat, sm(-0.75, -0.3, crest));
      c = mixc(c, C.back, sm(0.5, 1, crest) * 0.6);
      // the pale throat patch under the jaw
      c = mixc(c, C.white, sm(-0.7, -0.95, crest) * sm(0.45, 0.5, p[2]) * 0.6);
      if (stag) c = mixc(c, C.mane, 0.7);
      return scale(c, fur(p));
    },
  });
  // ---- head: long, a broad dark nose; the eyes' dark line toward the muzzle; pale around the eye and on the chin
  const h0 = [0, 0.985, 0.515], h1 = P.nose;
  const HS = [
    [0.0, 0.035, 0.035, 0.04],
    [0.1, 0.058, 0.05, 0.055],
    [0.25, 0.066, 0.047, 0.056],
    [0.42, 0.054, 0.038, 0.048],
    [0.6, 0.042, 0.03, 0.04],
    [0.78, 0.034, 0.026, 0.034],
    [0.92, 0.032, 0.025, 0.03],
    [1.0, 0.018, 0.014, 0.017],
  ];
  const hpts = HS.map(([s], i) => add(lerp3(h0, h1, s), [0, (HS[i][2] - HS[i][3]) / 2, 0]));
  const hrad = HS.map(([, w, u, d]) => [w, (u + d) / 2]);
  const headSkin = rigid(body, 'head');
  B.tube(hpts, hrad, {
    seg: 12, up: [0, 1, 0.35], skin: headSkin, cap0: true, cap1: true,
    color: (p, i, th) => {
      const s = HS[i][0], up = Math.cos(th);
      let c = mixc(C.coat, C.back, sm(0.4, 1, up) * 0.4);
      c = mixc(c, C.muzzle, sm(0.62, 0.8, s) * 0.7);
      c = mixc(c, C.belly, sm(-0.5, -0.9, up) * 0.7);
      if (s > 0.9) c = mixc(c, C.nose, sm(-0.6, 0.2, up));
      c = mixc(c, C.white, sm(-0.8, -1, up) * sm(0.85, 0.95, s));
      if (stag) c = mixc(c, C.mane, 0.25);
      return scale(c, fur(p));
    },
  });
  for (const sx of [1, -1]) {
    const e = add(lerp3(h0, h1, 0.3), [sx * 0.05, 0.022, 0]);
    ellipsoid(B, e, [0.012, 0.012, 0.016], () => C.eye, headSkin, 4, 6);
  }
  // ---- ears: big ovals held out to the sides, pale inside with dark rims
  for (const [sx, n] of [[1, 'earL'], [-1, 'earR']]) {
    const base = [sx * P.ear[0], P.ear[1], P.ear[2]], tip = [sx * P.earTip[0], P.earTip[1], P.earTip[2]];
    ear(B, base, tip, sx, 0.075, { front: (p, t) => mixc(C.white, C.belly, 0.4), back: (p, t) => mixc(C.coat, C.black, sm(0.85, 1, t) * 0.5), skin: rigid(body, n), cup: 0.55, thick: 0.008 });
  }
  // ---- legs: long and thin, the coat paling down to the hooves; the thighs (hams) big
  for (let l = 0; l < 4; l++) {
    const leg = body.legs[l];
    const J = legPts(body, l);
    let pts, radii;
    // sections [across, fore-aft]: shoulder and ham flat against the trunk, the forearm and the gaskin muscled, the
    // cannons thin
    if (leg.fore) {
      pts = [lerp3(J[0], J[1], 0.7), J[1], lerp3(J[1], J[2], 0.5), J[2], lerp3(J[2], J[3], 0.5), J[3], lerp3(J[3], J[4], 0.5), J[4], lerp3(J[4], J[5], 0.45)];
      radii = [[0.034, 0.07], [0.04, 0.07], [0.042, 0.06], [0.04, 0.047], [0.03, 0.034], [0.021, 0.024], [0.016, 0.017], [0.019, 0.02], [0.016, 0.015]];
    } else {
      pts = [lerp3(J[0], J[1], 0.1), lerp3(J[0], J[1], 0.55), J[1], lerp3(J[1], J[2], 0.5), J[2], lerp3(J[2], J[3], 0.5), J[3], lerp3(J[3], J[4], 0.45)];
      radii = [[0.05, 0.11], [0.055, 0.1], [0.05, 0.065], [0.034, 0.045], [0.024, 0.03], [0.017, 0.019], [0.019, 0.02], [0.016, 0.015]];
    }
    const kneeY = leg.fore ? J[3][1] : J[2][1];
    legTube(B, body, l, pts, radii, (p) => scale(mixc(mixc(C.coat, C.leg, sm(kneeY + 0.15, kneeY, p[1])), C.belly, sm(kneeY + 0.1, kneeY - 0.15, p[1]) * 0.35 * (p[2] < J[J.length - 2][2] ? 1 : 0)), fur(p)), 8);
    // hoof: a dark cleft wedge from the pastern to the toe
    const toe = J[J.length - 1], fet = J[J.length - 2];
    const toeName = body.bones[leg.bones[leg.bones.length - 1]].name;
    B.tube([lerp3(fet, toe, 0.45), lerp3(fet, toe, 0.8), toe], [[0.018, 0.02], [0.02, 0.022], [0.015, 0.012]], { seg: 7, up: [0, 0, 1], skin: rigid(body, toeName), color: () => C.hoof, cap0: false, cap1: true });
  }
  // ---- tail: short, white beneath, a dark line down its top
  const tp = P.tail;
  const tailSkin = skinBy(body, ['pelvis', 'tail1', 'tail2'], 4, { pelvis: 0.3 });
  B.tube([tp[0], lerp3(tp[0], tp[1], 0.5), tp[1], lerp3(tp[1], tp[2], 0.6), tp[2]], [[0.026, 0.014], [0.03, 0.014], [0.029, 0.013], [0.023, 0.011], [0.01, 0.007]], {
    seg: 8, up: [0, 0, -1], skin: tailSkin, cap0: false, cap1: true,
    // white, a thin brownish line down its top
    color: (p, i, th) => mixc(C.white, C.coat, sm(0.86, 0.98, Math.cos(th)) * (1 - sm(0.003, 0.007, Math.abs(p[0]))) * 0.7),
  });
  // ---- the rump patch: a white heart-shaped shell over the buttocks, edged in black, on its own bone (it flares)
  {
    const c0 = P.rump, rumpSkin = rigid(body, 'rump');
    // the trunk's rear surface behind (x, y): the first section (from the back) that contains the point
    const shapeK = (th) => {
      const c = Math.abs(Math.cos(th)), s = Math.abs(Math.sin(th)), n = Math.cos(th) > 0 ? 2.3 : 2.1;
      return Math.pow(Math.pow(c, n) + Math.pow(s, n), -1 / n);
    };
    // (a point above or beside every section: where it comes nearest to one)
    const surfZ = (x, y) => {
      let best = T[0][0], bq = Infinity;
      for (let z = T[0][0]; z < -0.25; z += 0.002) {
        const top = prof(T, z, 1), bot = prof(T, z, 2), hw = prof(T, z, 3);
        const cy = (top + bot) / 2, ry = (top - bot) / 2;
        const th = Math.atan2(Math.abs(x) / hw, (y - cy) / ry);
        const q = Math.hypot(x / hw, (y - cy) / ry) / shapeK(th);
        if (q <= 1) return z;
        if (q < bq) (bq = q), (best = z);
      }
      return best;
    };
    const rows = 5, cols = 14;
    const ring = [];
    const cy0 = c0[1] + 0.005;
    // a point of the patch at (r, a) with the hair lying flat (k = 0) or flared (k = 1: the white spreads into a broad
    // chrysanthemum over the buttocks, the long hairs standing out from the skin)
    const at = (r, a, k) => {
      const heart = 1 + 0.12 * Math.sin(a) - 0.2 * Math.pow(Math.max(0, Math.sin(a)), 8) - 0.18 * Math.pow(Math.max(0, -Math.sin(a)), 2) * (1 - 0.6 * k);
      const sx = 0.075 * (1 + 0.6 * k), sy = 0.085 * (1 + 0.45 * k);
      const x = Math.cos(a) * sx * r * heart, y = cy0 + 0.01 + Math.sin(a) * sy * r * heart;
      // over the buttocks' surface, thicker at the middle (the long hairs), much more so flared
      const z = surfZ(x, y) - 0.005 - (0.014 + 0.02 * k) * (1 - r * r) - 0.006 * k;
      return [x, y, z];
    };
    const p0 = at(0, 0, 0), p1 = at(0, 0, 1);
    const center = B.vert(p0, C.white, rumpSkin(), sub(p1, p0));
    for (let i = 1; i <= rows; i++) {
      const r = i / rows;
      const row = [];
      for (let j = 0; j < cols; j++) {
        const a = (j / cols) * Math.PI * 2;
        const q0 = at(r, a, 0), q1 = at(r, a, 1);
        // the black edge along the top and the sides (it fades out under the patch)
        const col = r > 0.8 && Math.sin(a) > -0.55 ? C.black : C.white;
        row.push(B.vert(q0, col, rumpSkin(), sub(q1, q0)));
      }
      ring.push(row);
    }
    const back = [0, 0, -1];
    for (let j = 0; j < cols; j++) B.triOut(center, ring[0][(j + 1) % cols], ring[0][j], back);
    for (let i = 0; i < rows - 1; i++)
      for (let j = 0; j < cols; j++) {
        const j1 = (j + 1) % cols;
        B.triOut(ring[i][j], ring[i][j1], ring[i + 1][j], back);
        B.triOut(ring[i][j1], ring[i + 1][j1], ring[i + 1][j], back);
      }
  }
  // ---- antlers (stag): four points each, a brow tine, a middle tine and the forked top, on the head bone
  if (stag) {
    for (const sx of [1, -1]) {
      const X = (p) => [sx * p[0], p[1], p[2]];
      const base = X([0.045, 1.03, 0.53]);
      const beam = [base, X([0.075, 1.11, 0.5]), X([0.105, 1.22, 0.46]), X([0.12, 1.31, 0.435]), X([0.112, 1.4, 0.445])];
      const brow = [X([0.06, 1.07, 0.515]), X([0.068, 1.105, 0.575]), X([0.072, 1.13, 0.635])];
      const trez = [X([0.108, 1.23, 0.456]), X([0.12, 1.265, 0.515]), X([0.125, 1.29, 0.56])];
      const fork = [X([0.118, 1.31, 0.435]), X([0.142, 1.36, 0.385]), X([0.152, 1.39, 0.35])];
      const col = (p, i, th, n) => mixc(C.antler, C.tip, sm(n - 2, n - 1, i));
      const sk = rigid(body, 'head');
      B.tube(beam, [[0.024, 0.024], [0.021, 0.021], [0.018, 0.018], [0.015, 0.015], [0.008, 0.008]], { seg: 6, up: [0, 0, 1], skin: sk, color: (p, i, th) => col(p, i, th, 5), cap0: true, cap1: true });
      for (const t of [brow, trez, fork]) B.tube(t, [[0.013, 0.013], [0.01, 0.01], [0.005, 0.005]], { seg: 5, up: [0, 0, 1], skin: sk, color: (p, i, th) => col(p, i, th, 3), cap0: false, cap1: true });
      // the burr (coronet) at the base
      B.tube([sub(base, [0, 0.01, 0]), add(base, [0, 0.01, 0])], [[0.03, 0.03], [0.028, 0.028]], { seg: 7, up: [0, 0, 1], skin: sk, color: () => scale(C.antler, 0.7), cap0: true, cap1: true });
    }
  }
  return B.build();
}

export function buildBeast(form) {
  if (form === 'fox') return buildFox();
  return buildDeer(form === 'stag');
}

// ------------------------------------------------------------------------------------------------ material + mesh
const VERT_PARS = /* glsl */ `
attribute vec4 aKzSkin;
attribute vec4 aKzWeight;
attribute vec3 aKzAlt;   // the vertex's offset at full flare (the rump patch)
attribute float aKzFlare; // per instance: 0 the hair lying flat .. 1 flared
uniform highp sampler2D uKzBones;
mat4 kzBone(float b) {
  int i = int(b + 0.5) * 3;
  vec4 r0 = texelFetch(uKzBones, ivec2(i, gl_InstanceID), 0);
  vec4 r1 = texelFetch(uKzBones, ivec2(i + 1, gl_InstanceID), 0);
  vec4 r2 = texelFetch(uKzBones, ivec2(i + 2, gl_InstanceID), 0);
  return mat4(r0.x, r1.x, r2.x, 0.0, r0.y, r1.y, r2.y, 0.0, r0.z, r1.z, r2.z, 0.0, r0.w, r1.w, r2.w, 1.0);
}
mat4 kzSkinMat() {
  return kzBone(aKzSkin.x) * aKzWeight.x + kzBone(aKzSkin.y) * aKzWeight.y + kzBone(aKzSkin.z) * aKzWeight.z + kzBone(aKzSkin.w) * aKzWeight.w;
}
`;

function inject(shader, uniforms, depth) {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\n' + VERT_PARS);
  const pos = 'vec3 kzPos = position + aKzAlt * aKzFlare;';
  if (depth) shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `mat4 kzSk = kzSkinMat();\n${pos}\nvec3 transformed = (kzSk * vec4(kzPos, 1.0)).xyz;`);
  else
    shader.vertexShader = shader.vertexShader
      .replace('#include <beginnormal_vertex>', 'mat4 kzSk = kzSkinMat();\nvec3 objectNormal = normalize(mat3(kzSk) * normal);')
      .replace('#include <begin_vertex>', `${pos}\nvec3 transformed = (kzSk * vec4(kzPos, 1.0)).xyz;`);
}

// the fur's backlit rim (rim, its tint by the coat) and a trace of light through it (trans): the bodies are no thin
// cloth, only their edges glow
// (fill: the characters' sky fill, halved: a coat has no ambient occlusion of its own, at full fill an animal in the
// shade of the wood glows against the darkened ground)
const FORMS = {
  fox: { body: 'fox', rough: 0.86, rim: 0.7, rimTint: 0.65, trans: 0.06, fill: 0.5 },
  deer: { body: 'deer', rough: 0.9, rim: 0.5, rimTint: 0.45, trans: 0.03, fill: 0.45 },
  stag: { body: 'deer', rough: 0.9, rim: 0.5, rimTint: 0.45, trans: 0.03, fill: 0.45 },
};

export class BeastMesh {
  constructor(form, max) {
    const F = FORMS[form];
    this.form = form;
    this.body = BODIES[F.body];
    this.max = max;
    const nb = this.body.nb;
    const geo = buildBeast(form);
    this.tris = geo.index.count / 3;
    // bone matrices: one row per instance, three RGBA32F texels per bone
    this.data = new Float32Array(nb * 3 * 4 * max);
    const tex = new THREE.DataTexture(this.data, nb * 3, max, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.tex = tex;
    this.uniforms = { uKzBones: { value: tex } };
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: F.rough, metalness: 0 });
    characterShading(mat, { rim: F.rim, fill: F.fill, rimTint: F.rimTint, trans: F.trans });
    const charHook = mat.userData.onBeforeCompile;
    mat.userData.shaderKey = 'wildlife-beast|' + mat.userData.shaderKey;
    mat.userData.onBeforeCompile = (shader, renderer) => {
      inject(shader, this.uniforms, false);
      charHook(shader, renderer);
    };
    const depth = new THREE.MeshDepthMaterial();
    depth.onBeforeCompile = (shader) => inject(shader, this.uniforms, true);
    depth.customProgramCacheKey = () => 'kaze|wildlife-beast-depth';
    this.flare = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
    this.flare.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aKzFlare', this.flare);
    const mesh = new THREE.InstancedMesh(geo, mat, max);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.customDepthMaterial = depth;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.name = 'wildlife-' + form;
    mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh = mesh;
    this.shadows = true;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  // write these animals (each with .out = its poseBones() output, and .tint) into the instance buffers; the form
  // casts shadows only while one of its animals is near the camera
  sync(animals, cam, far = 260, shadowNear = 55) {
    const mesh = this.mesh, nb = this.body.nb, row = nb * 12;
    let n = 0, near = Infinity;
    for (const a of animals) {
      if (n >= this.max) break;
      const P = a.out && a.out.place;
      if (!P) continue;
      const d2 = cam ? (P.x - cam.x) ** 2 + (P.z - cam.z) ** 2 : 0;
      if (d2 > far * far) continue;
      if (d2 < near) near = d2;
      this._q.setFromAxisAngle(this._up, P.yaw);
      this._m.compose(this._p.set(P.x, P.y, P.z), this._q, this._s.setScalar(P.scale));
      this._m.toArray(mesh.instanceMatrix.array, n * 16);
      this.data.set(a.out.bones, n * row);
      this.flare.array[n] = a.pose ? a.pose.flare || 0 : 0;
      mesh.setColorAt(n, this._c.setScalar(a.tint || 1));
      n++;
    }
    mesh.count = n;
    mesh.castShadow = this.shadows && near < shadowNear * shadowNear;
    if (n) {
      this.flare.clearUpdateRanges();
      this.flare.addUpdateRange(0, n);
      this.flare.needsUpdate = true;
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, n * 16);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.clearUpdateRanges();
      mesh.instanceColor.addUpdateRange(0, n * 3);
      mesh.instanceColor.needsUpdate = true;
      this.tex.needsUpdate = true;
    }
    return n;
  }
}
