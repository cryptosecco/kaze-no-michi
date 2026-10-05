import * as THREE from 'three';

// Distant mountain ranges beyond the sea (other islands / the mainland), 3–15 km away in the sunset sector.
// They exist to be dissolved by the atmosphere into layered silhouettes: each range
// is hazier than the one in front of it (brown → blue-violet away from the sun, gold toward it) and every
// base sinks into the low sea mist, so the crests stand out as separate planes. Pure silhouettes: unlit, no
// shadows, one shared material.
//   r = distance (m), depth = front-to-back width, peak = highest crest (m), from/to = compass sector (deg),
//   freq = ridge frequency across the sector, round = crest shape (1 = sharp ridges, 2 = rounded forested
//   hills), cols = columns (finer for the near, forested crests)

export const LAYERS = [
  { r: 3300, depth: 1500, peak: 350, from: 205, to: 322, seed: 5.3, freq: 14, round: 2, cols: 720 },
  { r: 5700, depth: 2300, peak: 670, from: 200, to: 330, seed: 3.1, freq: 10, round: 1.8, cols: 540 },
  { r: 9300, depth: 3200, peak: 1180, from: 195, to: 336, seed: 7.7, freq: 7, round: 1.4, cols: 420 },
  { r: 14500, depth: 4200, peak: 1980, from: 190, to: 342, seed: 1.9, freq: 5, round: 1.1, cols: 360 },
];

// Under the setting sun (az 249–271°) the ranges drop to low islands (a strait onto the open sea), so S3's giant
// disc sets on the near hills instead of on a mountain wall; from S1 that bearing is behind the shrine hill.
// az = centre (deg), half = half-width (deg), floor = crest scale at the centre.
export const STRAIT = { az: 260, half: 11, floor: 0.12 };

// deterministic 1D ridged noise from a few sines with irrational frequency ratios; round > 1 softens the
// cusp of every ridge into a rounded crest (1 - |s|^round is smooth at s = 0 for round > 1)
function ridge1(x, seed, round = 1) {
  let v = 0, amp = 1, f = 1, norm = 0;
  for (let o = 0; o < 5; o++) {
    const s = Math.sin(x * f + seed * (o + 1) * 1.7) * 0.6 + Math.sin(x * f * 1.618 + seed * 3.3 + o) * 0.4;
    v += (1 - Math.pow(Math.abs(s), round)) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.13;
  }
  return v / norm;
}

function buildLayer(L, strait, rows = 10) {
  const cols = L.cols || 360;
  const pos = new Float32Array((cols + 1) * (rows + 1) * 3);
  const d2r = Math.PI / 180;
  let i = 0;
  for (let c = 0; c <= cols; c++) {
    const azDeg = L.from + ((L.to - L.from) * c) / cols;
    const az = azDeg * d2r;
    const u = c / cols;
    // fade the range out at both ends of the sector, and down to low islands across the strait
    const ends = Math.min(1, u * 6, (1 - u) * 6);
    const gap = strait ? strait.floor + (1 - strait.floor) * THREE.MathUtils.smoothstep(Math.abs(azDeg - strait.az), 0, strait.half) : 1;
    const n = ridge1(u * L.freq, L.seed, L.round || 1);
    const crest = L.peak * (0.3 + 0.7 * Math.pow(n, 1.6)) * (0.35 + 0.65 * ends) * gap;
    const sx = Math.sin(az), sz = -Math.cos(az);
    for (let r = 0; r <= rows; r++) {
      const t = r / rows;
      const dist = L.r + (t - 0.5) * L.depth;
      // asymmetric cross-section: steeper toward the viewer, long back slope
      const prof = t < 0.45 ? Math.pow(Math.sin((t / 0.45) * Math.PI * 0.5), 0.9) : Math.pow(Math.cos(((t - 0.45) / 0.55) * Math.PI * 0.5), 1.3);
      const wob = ridge1(u * L.freq * 3.1 + t * 2.0, L.seed + 5) * 0.22;
      pos[i++] = sx * dist;
      pos[i++] = -30 + crest * prof * (0.85 + wob);
      pos[i++] = sz * dist;
    }
  }
  const idx = [];
  for (let c = 0; c < cols; c++)
    for (let r = 0; r < rows; r++) {
      const a = c * (rows + 1) + r, b = a + rows + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1); // counter-clockwise seen from above → normals point up/out
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

export class Backdrop {
  constructor(layers = LAYERS, strait = STRAIT) {
    this.group = new THREE.Group();
    this.group.name = 'backdrop';
    // forested far ranges: unlit dark silhouettes, the haze does the colouring (lit, the low sun drew hard vertical
    // terminators down the sun-facing flanks of these coarse 10-row meshes: seams in the haze bands)
    this.material = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.035, 0.04, 0.05) });
    for (const L of layers) {
      const m = new THREE.Mesh(buildLayer(L, strait), this.material);
      m.castShadow = false;
      m.receiveShadow = false;
      m.matrixAutoUpdate = false;
      this.group.add(m);
    }
  }
}
