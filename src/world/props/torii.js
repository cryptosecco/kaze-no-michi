import * as THREE from 'three';
import { box, cylinder, bentBeam, sweep, mat, mul } from './geom.js';

// Myōjin torii in a local frame: origin on the ground midway between the pillars, x = crossbeam axis,
// z = walking (through) direction, y up. `M` places it in the world. Proportions follow classic shrines:
// inward-leaning pillars (uchikorobi), black kasagi with upswept ends over a vermilion shimaki, nuki tie
// beam passing through the pillars with wedges, central gakuzuka strut with a plaque, black kamaki
// sleeves and stone daiishi bases.
export function addTorii(b, M, { span = 5.4, height = 6.2, groundY = 0, seed = 1, baseDepth = 0.35, plaque = true, pillarR = null } = {}) {
  const S = span, H = height;
  // pillarR: thin pillars for small votive torii (the default suits gate-sized ones)
  const r = pillarR ?? Math.min(0.46, Math.max(0.2, S * 0.05));
  const kasH = H * 0.055, kasD = r * 1.75;
  const shiH = H * 0.045, shiD = r * 1.3;
  const hp = H - kasH - shiH; // pillar height up to the shimaki underside
  const lean = H * 0.018;
  const theta = Math.atan2(lean, hp);
  const w = { ground: groundY, seed, grimeH: 1.4 };

  for (const sx of [-1, 1]) {
    const x0 = (sx * S) / 2;
    // pillar (slightly tapered, leaning inward), extends a little into the shimaki
    const pil = cylinder(r * 0.88, r, hp + 0.12, 16, 6, { uv: 1 });
    b.add('lacquer', pil, mul(M, mat(x0 - sx * lean * 0.5, (hp + 0.12) / 2, 0, 0, 0, sx * theta)), w);
    // kamaki (black sleeve) + ring
    const km = cylinder(r * 1.1, r * 1.12, H * 0.085, 16, 1);
    b.add('black', km, mul(M, mat(x0, H * 0.0425 + 0.02, 0, 0, 0, sx * theta)), w);
    const ring = cylinder(r * 1.14, r * 1.14, 0.05, 16, 1);
    b.add('black', ring, mul(M, mat(x0 - sx * lean * (H * 0.085) / hp, H * 0.085 + 0.02, 0, 0, 0, sx * theta)), w);
    // daiishi: stone plinth, partly buried
    const base = cylinder(r * 1.55, r * 1.75, baseDepth + 0.25, 12, 1, { uv: 0.8 });
    b.add('stone', base, mul(M, mat(x0, (baseDepth + 0.25) / 2 - baseDepth, 0)), { ...w, grimeH: 0.4 });
  }

  // nuki (tie beam) through the pillars, projecting past them
  const yN = H * 0.72;
  const nukiL = S + r * 5.2;
  const nuki = box(nukiL, H * 0.05, r * 0.95, { grain: 'x', uv: 1 });
  b.add('lacquer', nuki, mul(M, mat(0, yN, 0)), w);
  // wedges (kusabi) outside each pillar
  for (const sx of [-1, 1]) {
    const k = box(0.1, H * 0.05 + 0.08, r * 1.05, { grain: 'y' });
    b.add('black', k, mul(M, mat(sx * (S / 2 - lean * (yN / hp) + r * 1.25), yN, 0)), w);
  }
  // gakuzuka: central strut + plaque
  const yTopN = yN + H * 0.025;
  const gH = hp - yTopN;
  if (gH > 0.2) {
    const g = box(r * 1.15, gH, r * 0.8, { grain: 'y' });
    b.add('lacquer', g, mul(M, mat(0, yTopN + gH / 2, 0)), w);
    if (plaque) {
      const pw = Math.min(r * 2.4, 0.9), ph = Math.min(gH * 0.8, pw * 1.35);
      const p = box(pw, ph, 0.08, { grain: 'y' });
      b.add('black', p, mul(M, mat(0, yTopN + gH / 2, r * 0.45)), w);
      const pr = box(pw * 1.12, ph * 1.08, 0.05, { grain: 'y' });
      b.add('lacquer', pr, mul(M, mat(0, yTopN + gH / 2, r * 0.4)), w);
    }
  }
  // shimaki (vermilion) and kasagi (black) with upswept ends
  const lenK = S + r * 10.5;
  const shi = bentBeam(lenK - 0.35, shiH, shiD, { segs: 28, lift: H * 0.045, pow: 2.4 });
  b.add('lacquer', shi, mul(M, mat(0, hp + shiH / 2, 0)), w);
  const kas = bentBeam(lenK, kasH, kasD, { segs: 32, lift: H * 0.07, pow: 2.3, taperTop: H * 0.012 });
  b.add('black', kas, mul(M, mat(0, hp + shiH + kasH / 2, 0)), w);
  // tip caps: slanted end cuts read as a slightly wider cap at each end
  for (const sx of [-1, 1]) {
    const cap = box(0.08, kasH * 1.25, kasD * 1.05, { grain: 'y' });
    b.add('black', cap, mul(M, mat((sx * lenK) / 2, hp + shiH + kasH / 2 + H * 0.07, 0, 0, 0, sx * 0.25)), w);
  }
  return { span: S, height: H, pillarR: r, pillars: [-S / 2, S / 2] };
}

// Height above the torii's ground of the top of its kasagi at x along the beam (the bent beam above: lift + taperTop
// at the upswept ends). The wildlife module perches crows on it.
export function kasagiTop({ span, height, pillarR = null }, x) {
  const r = pillarR ?? Math.min(0.46, Math.max(0.2, span * 0.05));
  const half = (span + r * 10.5) / 2;
  return height + height * (0.07 + 0.012) * Math.pow(Math.min(1, Math.abs(x) / half), 2.3);
}

// Kasuga-dōrō stone lantern (≈ 2.3 m at scale 1): hexagonal base, pole with nodes, flared middle
// platform, open fire box (posts + side panels, windows front/back), umbrella roof with curled corners
// and a jewel finial. Local frame: y up, windows face ±z.
export function addLantern(b, M, { scale = 1, groundY = 0, seed = 1, key = 'stone' } = {}) {
  const w = { ground: groundY, seed, grimeH: 0.8 };
  const S = scale;
  const at = (y, rx = 0, ry = 0) => mul(M, mat(0, y * S, 0, rx, ry, 0, S, S, S));
  const put = (geo, y, ry = 0) => b.add(key, geo, at(y, 0, ry), w);
  let y = -0.25;
  // base (buried a little) + lotus step
  put(cylinder(0.4, 0.42, 0.42, 6, 1), y + 0.21, Math.PI / 6);
  y += 0.42;
  put(cylinder(0.27, 0.4, 0.1, 6, 1), y + 0.05, Math.PI / 6);
  y += 0.1;
  put(cylinder(0.29, 0.29, 0.05, 14, 1), y + 0.025);
  y += 0.05;
  // pole with three nodes
  put(cylinder(0.1, 0.115, 0.95, 12, 3), y + 0.475);
  for (const f of [0.28, 0.48, 0.68]) put(cylinder(0.128, 0.128, 0.035, 12, 1), y + 0.95 * f);
  y += 0.95;
  // middle platform (chūdai)
  put(cylinder(0.33, 0.16, 0.13, 6, 1), y + 0.065, Math.PI / 6);
  y += 0.13;
  put(cylinder(0.33, 0.33, 0.09, 6, 1), y + 0.045, Math.PI / 6);
  y += 0.09;
  // fire box: slabs, corner posts, 4 closed panels, windows on ±z
  put(cylinder(0.27, 0.27, 0.035, 6, 1), y + 0.0175, Math.PI / 6);
  const boxH = 0.37;
  const R = 0.235, ap = R * Math.cos(Math.PI / 6);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    const post = box(0.055, boxH, 0.055, { grain: 'y' });
    b.add(key, post, mul(M, mat(Math.cos(a) * R * S, (y + 0.035 + boxH / 2) * S, Math.sin(a) * R * S, 0, -a, 0, S, S, S)), w);
    const fa = a + Math.PI / 6; // face centre angle
    const faceOpen = Math.abs(Math.cos(fa)) < 0.2; // faces pointing ±z
    if (!faceOpen) {
      const pan = box(0.2, boxH * 0.92, 0.03, { grain: 'y' });
      b.add(key, pan, mul(M, mat(Math.cos(fa) * ap * S, (y + 0.035 + boxH / 2) * S, Math.sin(fa) * ap * S, 0, Math.PI / 2 - fa, 0, S, S, S)), w);
    }
  }
  // warm candle glow inside the fire box (seen through the open windows)
  b.add('lanternGlow', box(0.26, boxH * 0.7, 0.26, { grain: 'y' }), at(y + 0.035 + boxH * 0.45), {});
  y += 0.035 + boxH;
  put(cylinder(0.27, 0.27, 0.04, 6, 1), y + 0.02, Math.PI / 6);
  y += 0.04;
  // kasa: a thick hexagonal roof whose faces sweep up concave to the finial, and at each corner a warabite
  // curl turning up and back in (a flat disc with round knobs read as a yoke from below)
  const roof = new THREE.LatheGeometry(
    [[0.001, -0.02], [0.56, -0.02], [0.61, 0.03], [0.59, 0.08], [0.47, 0.11], [0.35, 0.16], [0.25, 0.24], [0.17, 0.34], [0.12, 0.42], [0.001, 0.44]].map((p) => new THREE.Vector2(p[0], p[1])),
    6,
    Math.PI / 6
  );
  put(roof, y + 0.02);
  for (let k = 0; k < 6; k++) {
    const phi = Math.PI / 6 + (k * Math.PI) / 3; // the lathe's corners
    const dx = Math.sin(phi), dz = Math.cos(phi);
    const pts = [[0.55, 0.06], [0.62, 0.1], [0.655, 0.17], [0.64, 0.23], [0.6, 0.25], [0.575, 0.22]].map(
      ([r, yy]) => new THREE.Vector3(dx * r, y + 0.02 + yy, dz * r)
    );
    b.add(key, sweep(pts, { radius: 0.034, radial: 7 }), mul(M, mat(0, 0, 0, 0, 0, 0, S, S, S)), w);
  }
  y += 0.46;
  // lotus cup + jewel
  put(cylinder(0.1, 0.08, 0.06, 10, 1), y + 0.03);
  y += 0.06;
  const jewel = new THREE.LatheGeometry(
    [[0.001, 0], [0.085, 0.02], [0.115, 0.085], [0.09, 0.17], [0.035, 0.23], [0.001, 0.26]].map((p) => new THREE.Vector2(p[0], p[1])),
    10
  );
  put(jewel, y);
  return { height: (y + 0.26) * S, radius: 0.66 * S };
}
