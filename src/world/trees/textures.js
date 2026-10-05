import * as THREE from 'three';
import { Simplex, rng, clamp } from '../../core/math.js';

// Procedural textures for the forests, painted on canvases at load time:
//   leaf atlas (2048², 4×4 cells of 512): foliage clusters per species, fallen-leaf litter sheets and single leaves,
//     + a half-resolution normal atlas (packed RG) with a tilt and a midrib fold per broadleaf leaf
//   bark (256×512 per species, tileable) + matching normal maps derived from the painted height
// The atlas is un-premultiplied and colour-dilated (transparent texels carry nearby leaf colours) so mipmaps
// and alpha-to-coverage never produce dark fringes around the foliage.

export const ATLAS_GRID = 4;
const CELL = 512;
const SIZE = CELL * ATLAS_GRID;
const NRM_SCALE = 0.5; // normal atlas resolution relative to the colour atlas

export const CELLS = {
  mapleA: 0, mapleB: 1, mapleC: 2, mapleLeaf: 3,
  ginkgoA: 4, ginkgoB: 5, pinePad: 6, pineSpray: 7,
  cedarA: 8, cedarB: 9, bamboo: 10, shrub: 11,
  litterGinkgo: 12, litterMaple: 13, ginkgoLeaf: 14, shrubB: 15,
};

// UV rect of an atlas cell. The atlas is uploaded without flipY, so the top of a painted cell is at the
// smaller v: the twig base of a cluster (painted at the bottom of the cell) is at vBottom.
export function cellUV(i) {
  const cx = i % ATLAS_GRID, cy = Math.floor(i / ATLAS_GRID);
  const pad = 1.5 / SIZE;
  return {
    u0: cx / ATLAS_GRID + pad,
    u1: (cx + 1) / ATLAS_GRID - pad,
    vTop: cy / ATLAS_GRID + pad,
    vBottom: (cy + 1) / ATLAS_GRID - pad,
  };
}

const wrapH = (h) => ((h % 360) + 360) % 360;
const hsl = (h, s, l, a = 1) => `hsla(${wrapH(h).toFixed(1)},${clamp(s, 0, 100).toFixed(1)}%,${clamp(l, 0, 100).toFixed(1)}%,${a})`;

// Leaf normals. The normal atlas gets the same outlines as the colour atlas: every broadleaf leaf is tilted at
// random and folded along its midrib (the two halves face slightly apart), so the sun breaks a crown into single
// leaves; mipmapping averages the tilts away with distance, leaving the soft crown normal. Canvas axes are the
// texture axes (+x = +u, +y = +v: the atlas is uploaded without flipY). `N` = { ctx, rand } or null.
function tiltColor(nx, ny) {
  const l = Math.hypot(nx, ny, 1);
  return `rgb(${Math.round((0.5 + (0.5 * nx) / l) * 255)},${Math.round((0.5 + (0.5 * ny) / l) * 255)},255)`;
}

function leafTilt(N, path, x, y, rot, s, fold = 0.4) {
  if (!N) return;
  const ta = N.rand() * Math.PI * 2, tm = 0.12 + N.rand() * 0.5;
  const tx = Math.cos(ta) * tm, ty = Math.sin(ta) * tm;
  const fx = Math.cos(rot) * fold, fy = Math.sin(rot) * fold; // leaf-space +x in canvas space
  const ctx = N.ctx;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.clip(path);
  ctx.fillStyle = tiltColor(tx + fx, ty + fy);
  ctx.fillRect(-2 * s, -2 * s, 2 * s, 3 * s);
  ctx.fillStyle = tiltColor(tx - fx, ty - fy);
  ctx.fillRect(0, -2 * s, 2 * s, 3 * s);
  ctx.restore();
}

// A few soft darker spots (autumn blotches) inside the current clip.
function blotches(ctx, rand, s, c, n) {
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = hsl(c.h + 8 - rand() * 16, c.s - 10, c.l - 7 - rand() * 9, 0.32);
    ctx.beginPath();
    ctx.arc((rand() - 0.5) * s, -rand() * s * 0.9, s * (0.1 + rand() * 0.18), 0, Math.PI * 2);
    ctx.fill();
  }
}

// leaf shapes (drawn pointing "up" = -y, attach point at the origin). `detail` adds the per-leaf shading: a darker
// half along the midribs, blotches, veins; the dark inner-mass leaves skip it.
function mapleLeaf(ctx, x, y, s, rot, c, rand, N = null, detail = true) {
  const A = [-2.05, -1.38, -0.7, 0, 0.7, 1.38, 2.05];
  const L = [0.42, 0.74, 0.96, 1.0, 0.96, 0.74, 0.42];
  const P = (ang, r) => [Math.sin(ang) * r, -Math.cos(ang) * r];
  const vr = 0.24 * s;
  const path = new Path2D();
  path.moveTo(0, 0.04 * s);
  for (let i = 0; i < 7; i++) {
    const a = A[i] + (rand() - 0.5) * 0.1;
    const len = L[i] * s * (0.9 + rand() * 0.18);
    const aPrev = i === 0 ? a - 0.5 : (A[i - 1] + A[i]) / 2;
    const aNext = i === 6 ? a + 0.5 : (A[i] + A[i + 1]) / 2;
    const [px, py] = P(aPrev, i === 0 ? vr * 0.45 : vr);
    if (i === 0) path.lineTo(px, py);
    const hw = 0.2;
    const [c1x, c1y] = P(a - hw, len * 0.58);
    const [tx, ty] = P(a, len);
    const [c2x, c2y] = P(a + hw, len * 0.58);
    const [nx, ny] = P(aNext, i === 6 ? vr * 0.45 : vr);
    path.quadraticCurveTo(c1x, c1y, tx, ty);
    path.quadraticCurveTo(c2x, c2y, nx, ny);
  }
  path.closePath();
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  const g = ctx.createRadialGradient(0, -s * 0.1, s * 0.04, 0, -s * 0.25, s * 1.05);
  g.addColorStop(0, hsl(c.h + 14, c.s - 4, c.l + 12));
  g.addColorStop(0.5, hsl(c.h, c.s, c.l));
  g.addColorStop(1, hsl(c.h - 5, c.s, c.l - 9));
  ctx.fillStyle = g;
  ctx.fill(path);
  if (detail) {
    ctx.save();
    ctx.clip(path);
    // every lobe folds along its vein: its right half is a shade darker
    ctx.fillStyle = hsl(c.h - 6, c.s, c.l - 13, 0.5);
    ctx.beginPath();
    for (let i = 0; i < 7; i++) {
      const [x0, y0] = P(A[i], s * 1.3), [x1, y1] = P(i === 6 ? A[i] + 0.5 : (A[i] + A[i + 1]) / 2, s * 1.3);
      ctx.moveTo(0, 0);
      ctx.lineTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.closePath();
    }
    ctx.fill();
    blotches(ctx, rand, s, c, 2);
    ctx.restore();
    ctx.strokeStyle = hsl(c.h + 10, c.s - 15, c.l + 14, 0.32);
    ctx.lineWidth = Math.max(0.8, s * 0.022);
    for (let i = 0; i < 7; i++) {
      const [tx, ty] = P(A[i], L[i] * s * 0.84);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(tx, ty);
      ctx.stroke();
    }
  }
  ctx.strokeStyle = hsl(c.h, c.s - 25, c.l - 12);
  ctx.lineWidth = Math.max(1, s * 0.035);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, s * 0.42);
  ctx.stroke();
  ctx.restore();
  leafTilt(N, path, x, y, rot, s);
}

function ginkgoLeaf(ctx, x, y, s, rot, c, rand, N = null, detail = true) {
  const a = 0.82 + rand() * 0.3;
  const notch = rand() < 0.65;
  const up = -Math.PI / 2;
  const path = new Path2D();
  path.moveTo(0, 0);
  path.lineTo(-Math.sin(a) * s * 0.96, -Math.cos(a) * s * 0.96);
  if (notch) {
    path.arc(0, 0, s, up - a, up - 0.07);
    path.lineTo(0, -s * 0.72);
    path.lineTo(Math.sin(0.07) * s, -Math.cos(0.07) * s);
    path.arc(0, 0, s, up + 0.07, up + a);
  } else path.arc(0, 0, s, up - a, up + a);
  path.closePath();
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  const g = ctx.createRadialGradient(0, 0, s * 0.05, 0, 0, s);
  g.addColorStop(0, hsl(c.h + 10, c.s - 20, c.l + 8));
  g.addColorStop(0.45, hsl(c.h, c.s, c.l));
  g.addColorStop(1, hsl(c.h - 4, c.s, c.l - 6));
  ctx.fillStyle = g;
  ctx.fill(path);
  if (detail) {
    ctx.save();
    ctx.clip(path);
    // the fan folds along its notch: the left lobe is a shade darker; a thin darker rim outlines the leaf (both
    // light: in a crown they add up to a dark speckle)
    ctx.fillStyle = hsl(c.h - 5, c.s, c.l - 12, 0.3);
    ctx.fillRect(-s * 1.2, -s * 1.2, s * 1.2, s * 1.4);
    blotches(ctx, rand, s, c, 1);
    ctx.strokeStyle = hsl(c.h - 8, c.s, c.l - 16, 0.26);
    ctx.lineWidth = Math.max(1, s * 0.1);
    ctx.stroke(path);
    ctx.restore();
    ctx.strokeStyle = hsl(c.h - 6, c.s - 20, c.l - 14, 0.22);
    ctx.lineWidth = Math.max(0.6, s * 0.012);
    for (let k = -5; k <= 5; k++) {
      const ang = (k / 5) * a * 0.92;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.sin(ang) * s * 0.95, -Math.cos(ang) * s * 0.95);
      ctx.stroke();
    }
  }
  ctx.strokeStyle = hsl(c.h - 8, c.s - 30, c.l - 20);
  ctx.lineWidth = Math.max(1, s * 0.03);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, s * 0.6);
  ctx.stroke();
  ctx.restore();
  leafTilt(N, path, x, y, rot, s);
}

function lanceLeaf(ctx, x, y, len, rot, c) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  const w = len * 0.11;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(-w * 1.4, -len * 0.35, 0, -len);
  ctx.quadraticCurveTo(w * 1.4, -len * 0.35, 0, 0);
  ctx.fillStyle = hsl(c.h, c.s, c.l);
  ctx.fill();
  ctx.strokeStyle = hsl(c.h + 10, c.s - 10, c.l + 12, 0.45);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -len * 0.95);
  ctx.stroke();
  ctx.restore();
}

function ovalLeaf(ctx, x, y, s, rot, l) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.beginPath();
  ctx.ellipse(0, -s * 0.5, s * 0.32, s * 0.55, 0, 0, Math.PI * 2);
  ctx.fillStyle = hsl(40, 8, l);
  ctx.fill();
  ctx.strokeStyle = hsl(40, 8, l - 14, 0.35);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -s * 0.95);
  ctx.stroke();
  ctx.restore();
}

function twig(ctx, x0, y0, x1, y1, w, rand, color = '#35231a') {
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.quadraticCurveTo((x0 + x1) / 2 + (rand() - 0.5) * 50, (y0 + y1) / 2 + (rand() - 0.5) * 20, x1, y1);
  ctx.stroke();
}

// point inside a soft blob (ellipse), biased to the middle
function blobPoint(rand, cx, cy, rx, ry, bias = 0.6) {
  for (;;) {
    const x = rand() * 2 - 1, y = rand() * 2 - 1;
    const r2 = x * x + y * y;
    if (r2 > 1) continue;
    if (rand() > 1 - bias * r2) continue;
    return [cx + x * rx, cy + y * ry, Math.sqrt(r2)];
  }
}

// Dark inner mass under a cluster: the shaded inside of the crown seen through the front leaves. It also
// raises the card coverage, so crowns read as solid masses with leaf-shaped edges instead of lace.
// `draw(x, y, rand)` paints one small dark element (leaf / needle tuft) of the mass.
function innerMass(ctx, rand, cx, cy, rx, ry, n, draw) {
  for (let i = 0; i < n; i++) {
    const [x, y] = blobPoint(rand, cx, cy, rx, ry, 0.15);
    draw(x, y, rand);
  }
}

// Fade alpha to zero over the last `m` px of the cell, so nothing ends in a hard clipped edge.
function fadeCellBorder(ctx, m = 22) {
  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  for (const horizontal of [true, false]) {
    const g = horizontal ? ctx.createLinearGradient(0, 0, CELL, 0) : ctx.createLinearGradient(0, 0, 0, CELL);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(m / CELL, 'rgba(0,0,0,1)');
    g.addColorStop(1 - m / CELL, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, CELL, CELL);
  }
  ctx.restore();
}

// clusters (cell-local coordinates 0..512; twig base at the bottom centre). Many small leaves over a dark inner
// mass; `depth` (0 = back, 1 = front) darkens the leaves further back, so a card reads as a leaf mass with depth.
function mapleCluster(ctx, rand, pal, count, N) {
  const core = pal(rand, 0);
  innerMass(ctx, rand, 256, 252, 180, 166, 250, (x, y, r) =>
    mapleLeaf(ctx, x, y, 16 + r() * 14, r() * Math.PI * 2, { h: core.h - 4 + r() * 8, s: core.s - 14, l: core.l * (0.3 + r() * 0.16) }, r, null, false)
  );
  twig(ctx, 256, 500, 250 + (rand() - 0.5) * 40, 200, 5, rand);
  for (let k = 0; k < 7; k++) {
    const y0 = 482 - k * 40, d = k % 2 ? 1 : -1;
    twig(ctx, 253, y0, 256 + d * (70 + rand() * 120), y0 - 50 - rand() * 80, 2.4, rand);
  }
  const leaves = [];
  for (let i = 0; i < count; i++) {
    const [px, py, r] = blobPoint(rand, 256, 246, 220, 206, 0.3);
    const depth = rand() * 0.6 + 0.4 * r; // outer leaves sit in front
    leaves.push({
      px, py, depth,
      size: (17 + rand() * 13) * (1 - 0.15 * r),
      rot: Math.atan2(px - 256, 470 - py) + (rand() - 0.5) * 1.6,
      c: pal(rand, depth),
    });
  }
  leaves.sort((a, b) => a.depth - b.depth);
  for (const L of leaves) mapleLeaf(ctx, L.px, L.py, L.size, L.rot, L.c, rand, N);
}

// Ginkgo: fans in whorls of 4–7 on short spurs along dark twigs.
function ginkgoCluster(ctx, rand, pal, spurs, N) {
  const core = pal(rand, 0);
  // amber (not olive) shade inside the cluster, lit through: a backlit crown glows into its depth
  innerMass(ctx, rand, 256, 258, 172, 172, 230, (x, y, r) =>
    ginkgoLeaf(ctx, x, y, 14 + r() * 12, r() * Math.PI * 2, { h: core.h - 8 + r() * 4, s: core.s - 15, l: core.l * (0.6 + r() * 0.16) }, r, null, false)
  );
  twig(ctx, 256, 500, 262 + (rand() - 0.5) * 30, 150, 4.5, rand, '#3b3129');
  const items = [];
  for (let k = 0; k < spurs; k++) {
    const [sx, sy, r] = blobPoint(rand, 256, 258, 196, 192, 0.25);
    twig(ctx, 256 + (sy - 250) * 0.05, Math.max(sy + 40, 150), sx, sy, 1.8, rand, '#3b3129');
    const n = 4 + Math.floor(rand() * 4);
    const depth = rand() * 0.6 + 0.4 * r;
    for (let i = 0; i < n; i++) {
      const ang = -Math.PI / 2 + (i / Math.max(1, n - 1) - 0.5) * 2.6 + (rand() - 0.5) * 0.5 + (sx - 256) * 0.002;
      const pet = 9 + rand() * 9;
      items.push({
        x: sx + Math.cos(ang) * pet, y: sy + Math.sin(ang) * pet,
        s: 17 + rand() * 12, rot: ang + Math.PI / 2 + (rand() - 0.5) * 0.4, depth: depth + rand() * 0.05, c: pal(rand, depth),
      });
    }
  }
  items.sort((a, b) => a.depth - b.depth);
  for (const it of items) ginkgoLeaf(ctx, it.x, it.y, it.s, it.rot, it.c, rand, N);
}

function needleTuft(ctx, x, y, dirAng, spread, len, n, rand, c) {
  for (let i = 0; i < n; i++) {
    const a = dirAng + (rand() - 0.5) * spread;
    const l = len * (0.55 + rand() * 0.45);
    const tipL = c.l + 8 + rand() * 8;
    const g = ctx.createLinearGradient(x, y, x + Math.cos(a) * l, y + Math.sin(a) * l);
    g.addColorStop(0, hsl(c.h, c.s, c.l - 4));
    g.addColorStop(1, hsl(c.h - 6, c.s + 5, tipL));
    ctx.strokeStyle = g;
    ctx.lineWidth = 1.6 + rand() * 1.2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + Math.cos(a) * l * 0.5 + (rand() - 0.5) * 6, y + Math.sin(a) * l * 0.5 + (rand() - 0.5) * 6, x + Math.cos(a) * l, y + Math.sin(a) * l);
    ctx.stroke();
  }
}

function pinePad(ctx, rand) {
  // top view of a cloud pad: a dense dark needle mass with brush tufts radiating over an ellipse
  innerMass(ctx, rand, 256, 262, 165, 125, 60, (x, y, r) =>
    needleTuft(ctx, x, y, r() * Math.PI * 2, Math.PI * 2, 40 + r() * 20, 30, r, { h: 100, s: 30, l: 6 + r() * 3 })
  );
  for (let i = 0; i < 120; i++) {
    const [x, y, r] = blobPoint(rand, 256, 262, 205, 160, 0.2);
    const c = { h: 94 + rand() * 20, s: 30 + rand() * 18, l: 12 + rand() * 10 - r * 3 };
    needleTuft(ctx, x, y, rand() * Math.PI * 2, Math.PI * 2, 42 + rand() * 24, 34, rand, c);
  }
}

function pineSpray(ctx, rand) {
  // side view: a twisting twig with upturned brush tufts
  const pts = [];
  let x = 40, y = 330;
  for (let i = 0; i < 9; i++) {
    const nx = x + 50 + rand() * 10, ny = y - 18 + (rand() - 0.5) * 30;
    twig(ctx, x, y, nx, ny, 5 - i * 0.35, rand, '#3a2a20');
    pts.push([nx, ny]);
    x = nx;
    y = ny;
  }
  for (const [px, py] of pts) {
    for (let k = 0; k < 3; k++) {
      const c = { h: 98 + rand() * 14, s: 32 + rand() * 14, l: 14 + rand() * 9 };
      needleTuft(ctx, px + (rand() - 0.5) * 30, py + (rand() - 0.5) * 20, -Math.PI / 2 + (rand() - 0.5) * 1.3, 1.6, 70 + rand() * 40, 30, rand, c);
    }
  }
}

function cedarFrond(ctx, x, y, ang, len, depth, rand) {
  const steps = Math.max(4, Math.floor(len / 9));
  let px = x, py = y, a = ang;
  for (let i = 0; i < steps; i++) {
    a += (rand() - 0.5) * 0.12;
    const nx = px + Math.cos(a) * (len / steps), ny = py + Math.sin(a) * (len / steps);
    // scale-like needles on both sides
    for (const side of [-1, 1]) {
      const na = a + side * (0.55 + rand() * 0.3);
      const nl = 7 + rand() * 7 * (1 - i / steps * 0.4);
      const young = i > steps * 0.7 ? 8 : 0;
      ctx.strokeStyle = rand() < 0.08 ? hsl(28, 38, 26) : hsl(118 + rand() * 18, 32 + rand() * 12, 14 + rand() * 8 + young);
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + Math.cos(na) * nl, py + Math.sin(na) * nl);
      ctx.stroke();
    }
    ctx.strokeStyle = hsl(110, 30, 16);
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(nx, ny);
    ctx.stroke();
    if (depth > 0 && i > 1 && i % 3 === 0 && rand() < 0.85) {
      const side = (i / 3) % 2 ? 1 : -1;
      cedarFrond(ctx, px, py, a + side * (0.7 + rand() * 0.3), len * (0.45 + rand() * 0.2) * (1 - i / steps * 0.5), depth - 1, rand);
    }
    px = nx;
    py = ny;
  }
}

// Sugi spray mass: overlapping fronds fanning up from the base over a dark core (dense, spiky edges).
function cedarSpray(ctx, rand, fronds) {
  innerMass(ctx, rand, 256, 285, 140, 165, 70, (x, y, r) =>
    needleTuft(ctx, x, y, r() * Math.PI * 2, Math.PI * 2, 34 + r() * 18, 26, r, { h: 125, s: 34, l: 5 + r() * 3 })
  );
  for (let f = 0; f < fronds; f++) {
    const x = 256 + (rand() - 0.5) * 110;
    const ang = -Math.PI / 2 + (f / Math.max(1, fronds - 1) - 0.5) * 1.1 + (rand() - 0.5) * 0.25;
    cedarFrond(ctx, x, 492, ang, 230 + rand() * 110, 2, rand);
  }
}

function bambooCluster(ctx, rand) {
  for (let t = 0; t < 3; t++) {
    const bx = 150 + t * 105 + (rand() - 0.5) * 40;
    twig(ctx, bx, 512, bx + (rand() - 0.5) * 80, 120 + rand() * 60, 3, rand, '#6d7a3a');
    for (let f = 0; f < 3; f++) {
      const fx = bx + (rand() - 0.5) * 90, fy = 140 + f * 110 + rand() * 40;
      const n = 4 + Math.floor(rand() * 4);
      for (let i = 0; i < n; i++) {
        const c = { h: 72 + rand() * 20, s: 40 + rand() * 22, l: 28 + rand() * 16 };
        const a = Math.PI * 0.5 + (i / (n - 1) - 0.5) * 2.4 + (rand() - 0.5) * 0.3; // hanging fan
        lanceLeaf(ctx, fx, fy, 90 + rand() * 50, a + Math.PI, c);
      }
    }
  }
}

function shrubCluster(ctx, rand, count, pointed) {
  for (let i = 0; i < 9; i++) twig(ctx, 256, 512, 256 + (rand() - 0.5) * 420, 120 + rand() * 280, 3, rand, '#3b2c22');
  for (let i = 0; i < count; i++) {
    const [x, y, r] = blobPoint(rand, 256, 262, 225, 215, 0.3);
    const l = 62 + rand() * 26 - r * 12;
    if (pointed) lanceLeaf(ctx, x, y, 26 + rand() * 16, rand() * Math.PI * 2, { h: 40, s: 6, l });
    else ovalLeaf(ctx, x, y, 22 + rand() * 14, rand() * Math.PI * 2, l);
  }
}

// Litter sheet: leaves spread edge to edge, thinning toward the borders with noise, so overlapping,
// randomly rotated cards merge into a continuous carpet instead of reading as separate patches.
function litterSheet(ctx, rand, kind) {
  const n = kind === 'ginkgo' ? 560 : 440;
  for (let i = 0; i < n; i++) {
    const x = 18 + rand() * 476, y = 18 + rand() * 476;
    const e = Math.min(x, y, 512 - x, 512 - y) / 120;
    if (rand() > Math.min(1, 0.12 + e * 1.1)) continue;
    const brown = rand() < 0.3;
    if (kind === 'ginkgo') {
      const c = brown ? { h: 34 + rand() * 8, s: 55, l: 34 + rand() * 10 } : { h: 44 + rand() * 9, s: 82 + rand() * 12, l: 46 + rand() * 12 };
      ginkgoLeaf(ctx, x, y, 17 + rand() * 15, rand() * Math.PI * 2, c, rand);
    } else {
      const c = brown ? { h: 14 + rand() * 14, s: 45, l: 22 + rand() * 8 } : { h: -4 + rand() * 24, s: 78 + rand() * 14, l: 30 + rand() * 12 };
      mapleLeaf(ctx, x, y, 19 + rand() * 15, rand() * Math.PI * 2, c, rand);
    }
  }
}

function paintAtlas(seed) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // normal atlas: flat (0, 0, 1) wherever no broadleaf leaf is painted; its own random stream, so the colour
  // atlas is the same with or without it
  const ncanvas = document.createElement('canvas');
  ncanvas.width = ncanvas.height = SIZE * NRM_SCALE;
  const nctx = ncanvas.getContext('2d', { willReadFrequently: true });
  nctx.fillStyle = 'rgb(128,128,255)';
  nctx.fillRect(0, 0, ncanvas.width, ncanvas.height);
  const N = { ctx: nctx, rand: rng(seed * 31 + 7) };
  const rand = rng(seed);
  const cell = (i, fn) => {
    const cx = i % ATLAS_GRID, cy = Math.floor(i / ATLAS_GRID);
    for (const [c, k] of [[ctx, 1], [nctx, NRM_SCALE]]) {
      c.save();
      c.scale(k, k);
      c.beginPath();
      c.rect(cx * CELL, cy * CELL, CELL, CELL);
      c.clip();
      c.translate(cx * CELL, cy * CELL);
    }
    fn();
    fadeCellBorder(ctx);
    ctx.restore();
    nctx.restore();
  };
  // maple palettes: crimson to wine red (muted reds; the golden-hour light warms them by ~15° of hue),
  // a few red-orange accents; `d` (depth: 0 back … 1 front) darkens the leaves at the back of the cluster
  const crimson = (r, d = 1) => ({ h: -16 + r() * 14, s: 52 + r() * 16, l: 22 + r() * 13 + d * 7 });
  const scarlet = (r, d = 1) => (r() < 0.06 ? { h: 8 + r() * 8, s: 70, l: 34 + r() * 8 + d * 4 } : { h: -12 + r() * 14, s: 60 + r() * 16, l: 27 + r() * 14 + d * 7 });
  const deep = (r, d = 1) => ({ h: -18 + r() * 12, s: 48 + r() * 16, l: 16 + r() * 10 + d * 6 });
  // ginkgo: amber-gold in the depth, lemon-gold on the lit front leaves (hue follows lightness); rare late greens
  const gold = (r, d = 1) => {
    if (r() < 0.04) return { h: 56 + r() * 8, s: 54, l: 42 + r() * 8 };
    const l = 45 + r() * 14 + d * 10;
    return { h: 40 + (l - 45) * 0.5 + r() * 4, s: 74 + r() * 14, l };
  };

  cell(CELLS.mapleA, () => mapleCluster(ctx, rand, crimson, 290, N));
  cell(CELLS.mapleB, () => mapleCluster(ctx, rand, scarlet, 290, N));
  cell(CELLS.mapleC, () => mapleCluster(ctx, rand, deep, 310, N));
  cell(CELLS.mapleLeaf, () => mapleLeaf(ctx, 256, 330, 205, 0, { h: -2, s: 86, l: 40 }, rand));
  cell(CELLS.ginkgoA, () => ginkgoCluster(ctx, rand, gold, 80, N));
  cell(CELLS.ginkgoB, () => ginkgoCluster(ctx, rand, gold, 90, N));
  cell(CELLS.pinePad, () => pinePad(ctx, rand));
  cell(CELLS.pineSpray, () => pineSpray(ctx, rand));
  cell(CELLS.cedarA, () => cedarSpray(ctx, rand, 5));
  cell(CELLS.cedarB, () => cedarSpray(ctx, rand, 7));
  cell(CELLS.bamboo, () => bambooCluster(ctx, rand));
  cell(CELLS.shrub, () => shrubCluster(ctx, rand, 190, false));
  cell(CELLS.litterGinkgo, () => litterSheet(ctx, rand, 'ginkgo'));
  cell(CELLS.litterMaple, () => litterSheet(ctx, rand, 'maple'));
  cell(CELLS.ginkgoLeaf, () => ginkgoLeaf(ctx, 256, 400, 230, 0, { h: 47, s: 90, l: 52 }, rand));
  cell(CELLS.shrubB, () => shrubCluster(ctx, rand, 170, true));
  return { canvas, ncanvas };
}

// Fill transparent texels with the colour of nearby leaves (blurred copy) → no dark halos after filtering.
function dilatedData(canvas) {
  const w = canvas.width, h = canvas.height;
  const src = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const blurC = document.createElement('canvas');
  blurC.width = w;
  blurC.height = h;
  const bctx = blurC.getContext('2d', { willReadFrequently: true });
  bctx.filter = 'blur(10px)';
  bctx.drawImage(canvas, 0, 0);
  bctx.filter = 'blur(28px)';
  bctx.globalCompositeOperation = 'destination-over';
  bctx.drawImage(canvas, 0, 0);
  const blur = bctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h * 4; i += 4) {
    const a = src[i + 3];
    if (a >= 250) {
      out[i] = src[i];
      out[i + 1] = src[i + 1];
      out[i + 2] = src[i + 2];
    } else {
      const t = a / 255;
      const ba = blur[i + 3];
      const br = ba > 0 ? blur[i] : 60, bg = ba > 0 ? blur[i + 1] : 40, bb = ba > 0 ? blur[i + 2] : 25;
      out[i] = Math.round(src[i] * t + br * (1 - t));
      out[i + 1] = Math.round(src[i + 1] * t + bg * (1 - t));
      out[i + 2] = Math.round(src[i + 2] * t + bb * (1 - t));
    }
    out[i + 3] = a;
  }
  return out;
}

// Debug: the painted atlas canvas, or its normal atlas with which = 'normal' (inspect with scripts or devtools).
export function debugAtlasCanvas(seed = 71, which = 'color') {
  const { canvas, ncanvas } = paintAtlas(seed);
  return which === 'normal' ? ncanvas : canvas;
}

// Leaf atlas: { map (sRGB colour + alpha), normalMap (tangent-space normals packed in RG, half resolution) }.
export function createLeafAtlas(seed = 71, anisotropy = 8) {
  const { canvas, ncanvas } = paintAtlas(seed);
  const tex = (data, size, format, colorSpace) => {
    const t = new THREE.DataTexture(data, size, size, format, THREE.UnsignedByteType);
    t.colorSpace = colorSpace;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = anisotropy;
    t.flipY = false;
    t.needsUpdate = true;
    return t;
  };
  const map = tex(dilatedData(canvas), SIZE, THREE.RGBAFormat, THREE.SRGBColorSpace);
  map.userData.size = SIZE;
  const NS = ncanvas.width;
  const src = ncanvas.getContext('2d').getImageData(0, 0, NS, NS).data;
  const rg = new Uint8Array(NS * NS * 2);
  for (let i = 0, j = 0; j < rg.length; i += 4, j += 2) {
    rg[j] = src[i];
    rg[j + 1] = src[i + 1];
  }
  return { map, normalMap: tex(rg, NS, THREE.RGFormat, THREE.NoColorSpace) };
}

// Bark: height + colour painted per texel with u-periodic (helix-mapped) noise, v made tileable by folding.
// Linear colours. Maple and ginkgo bark are dark grey-brown (near-black trunks under the golden-hour
// ambient), so limbs read as dark structure inside the lit crowns instead of pale sticks. The ginkgo's corky ridges
// stand out grey-brown from dark furrows, so a trunk near the lens shows its bark instead of a flat black shape.
const BARK = {
  maple: { base: [0.066, 0.054, 0.046], dark: [0.02, 0.017, 0.015], lichen: [0.12, 0.13, 0.1], normal: 2.2 },
  ginkgo: { base: [0.115, 0.098, 0.082], dark: [0.022, 0.019, 0.017], lichen: [0.19, 0.18, 0.15], normal: 4.2 },
  pine: { base: [0.22, 0.19, 0.17], dark: [0.06, 0.05, 0.045], lichen: [0.28, 0.28, 0.26], normal: 3.8 },
  cedar: { base: [0.3, 0.17, 0.11], dark: [0.11, 0.06, 0.04], lichen: [0.36, 0.25, 0.18], normal: 2.8 },
  bamboo: { base: [0.44, 0.52, 0.2], dark: [0.3, 0.36, 0.12], lichen: [0.62, 0.62, 0.34], normal: 1.2 },
};

export function createBarkTextures(kind, seed = 5, anisotropy = 8) {
  const W = 256, H = 512, M = 48;
  const HE = H + M;
  const S = new Simplex(seed);
  const cfg = BARK[kind];
  const hgt = new Float32Array(W * HE);
  const col = new Float32Array(W * HE * 3);
  const TAU = Math.PI * 2;
  // noise periodic in u: sample on a circle of radius R (u) shifted along the second axis by v
  const nu = (u, v, freqU, freqV, off) => {
    const R = freqU / TAU;
    return S.noise(Math.cos(u * TAU) * R + off, Math.sin(u * TAU) * R + v * freqV + off * 1.7);
  };
  for (let y = 0; y < HE; y++) {
    const v = y / H;
    for (let x = 0; x < W; x++) {
      const u = x / W;
      let h = 0.5, lich = 0;
      if (kind === 'maple') {
        h = 0.55 + 0.22 * nu(u, v, 7, 3, 1) + 0.08 * nu(u, v, 40, 20, 7);
        const dash = Math.pow(Math.max(0, Math.sin(v * H * 0.32 + nu(u, v, 12, 2, 3) * 3)), 24) * (nu(u, v, 18, 6, 9) > 0.1 ? 1 : 0);
        h -= dash * 0.25;
        lich = Math.max(0, nu(u, v, 5, 2.5, 11) - 0.35) * 1.6;
      } else if (kind === 'ginkgo') {
        const r = 1 - Math.abs(nu(u, v, 11, 2.2, 2));
        h = 0.25 + 0.6 * r * r + 0.1 * nu(u, v, 50, 12, 5);
        lich = Math.max(0, nu(u, v, 4, 2, 13) - 0.4) * 1.2;
      } else if (kind === 'pine') {
        const plates = nu(u, v, 9, 4.5, 4) + 0.35 * nu(u, v, 22, 10, 6);
        h = 0.25 + 0.65 * (1 - Math.exp(-Math.abs(plates) * 5)) + 0.06 * nu(u, v, 60, 30, 8);
        lich = Math.max(0, nu(u, v, 4, 2, 15) - 0.5);
      } else if (kind === 'cedar') {
        const strips = Math.sin(u * TAU * 26 + nu(u, v, 4, 1.2, 3) * 5);
        h = 0.5 + 0.3 * strips * (0.6 + 0.4 * nu(u, v, 30, 1.5, 9)) + 0.08 * nu(u, v, 80, 4, 1);
        lich = Math.max(0, nu(u, v, 6, 1.5, 17) - 0.3) * 0.8;
      } else {
        // bamboo culm: fine striations, a node ridge at v = 0 (texture repeats once per internode)
        const vv = y % H / H;
        const node = Math.exp(-Math.pow(vv / 0.012, 2)) + Math.exp(-Math.pow((1 - vv) / 0.012, 2));
        h = 0.5 + 0.06 * nu(u, v, 90, 1, 2) + node * 0.45;
        lich = Math.exp(-Math.pow((vv - 0.03) / 0.03, 2)) * 0.7 + Math.max(0, nu(u, v, 3, 2, 19) - 0.3) * 0.5;
      }
      h = clamp(h, 0, 1);
      const i = y * W + x;
      hgt[i] = h;
      const shade = 0.55 + 0.65 * h;
      const t = clamp(lich, 0, 1);
      for (let c = 0; c < 3; c++) {
        let val = cfg.dark[c] + (cfg.base[c] - cfg.dark[c]) * clamp(h * 1.25 - 0.1, 0, 1);
        val = val * shade;
        val = val + (cfg.lichen[c] - val) * t * 0.6;
        col[i * 3 + c] = val;
      }
    }
  }
  // fold the extra M rows into the top M rows → vertically tileable
  const fold = (arr, ch) => {
    for (let y = 0; y < M; y++) {
      const t = y / M;
      for (let x = 0; x < W; x++)
        for (let c = 0; c < ch; c++) {
          const a = arr[((y + H) * W + x) * ch + c], b = arr[(y * W + x) * ch + c];
          arr[(y * W + x) * ch + c] = a + (b - a) * t;
        }
    }
  };
  if (kind !== 'bamboo') {
    fold(hgt, 1);
    fold(col, 3);
  }
  const colorData = new Uint8Array(W * H * 4);
  const normalData = new Uint8Array(W * H * 4);
  const hAt = (x, y) => hgt[(((y % H) + H) % H) * W + (((x % W) + W) % W)];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      for (let c = 0; c < 3; c++) colorData[i * 4 + c] = Math.round(Math.pow(clamp(col[i * 3 + c], 0, 1), 1 / 2.2) * 255);
      colorData[i * 4 + 3] = 255;
      const dx = (hAt(x + 1, y) - hAt(x - 1, y)) * cfg.normal;
      const dy = (hAt(x, y + 1) - hAt(x, y - 1)) * cfg.normal;
      const nx = -dx, ny = dy, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      normalData[i * 4] = Math.round((nx / l * 0.5 + 0.5) * 255);
      normalData[i * 4 + 1] = Math.round((ny / l * 0.5 + 0.5) * 255);
      normalData[i * 4 + 2] = Math.round((nz / l * 0.5 + 0.5) * 255);
      normalData[i * 4 + 3] = 255;
    }
  const mk = (data, srgb) => {
    const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = anisotropy;
    t.needsUpdate = true;
    return t;
  };
  return { map: mk(colorData, true), normalMap: mk(normalData, false) };
}

// Tileable fallen-leaf textures for the ground carpet (1024², leaves wrap around the edges; gaps are
// transparent so the forest floor shows through). Returns { maple, ginkgo } textures with RepeatWrapping.
export function createLitterTiles(seed = 91, anisotropy = 8) {
  const S = 1024;
  const make = (kind, sd) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = S;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rand = rng(sd);
    const n = kind === 'ginkgo' ? 1500 : 1250;
    for (let i = 0; i < n; i++) {
      const x = rand() * S, y = rand() * S;
      const brown = rand() < (kind === 'ginkgo' ? 0.3 : 0.42);
      const rot = rand() * Math.PI * 2;
      let c, size;
      if (kind === 'ginkgo') {
        c = brown ? { h: 33 + rand() * 8, s: 50, l: 30 + rand() * 10 } : { h: 43 + rand() * 9, s: 80 + rand() * 14, l: 42 + rand() * 14 };
        size = 22 + rand() * 16;
      } else {
        // fallen maple leaves darken and brown quickly: deep crimson, rust and umber
        c = brown ? { h: 14 + rand() * 14, s: 38, l: 16 + rand() * 8 } : { h: -6 + rand() * 24, s: 68 + rand() * 16, l: 21 + rand() * 11 };
        size = 26 + rand() * 18;
      }
      // draw every copy that overlaps the tile (wrap-around)
      for (const ox of [-S, 0, S])
        for (const oy of [-S, 0, S]) {
          const px = x + ox, py = y + oy;
          if (px < -size * 1.2 || px > S + size * 1.2 || py < -size * 1.2 || py > S + size * 1.2) continue;
          const r2 = rng(i * 7 + 1);
          if (kind === 'ginkgo') ginkgoLeaf(ctx, px, py, size, rot, c, r2);
          else mapleLeaf(ctx, px, py, size, rot, c, r2);
        }
    }
    const data = dilatedData(canvas);
    const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = anisotropy;
    tex.flipY = false;
    tex.needsUpdate = true;
    return tex;
  };
  return { maple: make('maple', seed), ginkgo: make('ginkgo', seed + 1) };
}
