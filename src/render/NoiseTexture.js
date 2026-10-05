import * as THREE from 'three';
import { rng } from '../core/math.js';

// A tileable 4-channel gradient-noise texture (HalfFloat, signed values in ~[-1,1]).
// Channel c has lattice period PERIODS[c] across the tile, so one fetch = 4 octaves of fbm:
//   fbm(uv) = dot(texture(uNoiseTex, uv), vec4(0.5333, 0.2667, 0.1333, 0.0667))
// The same data is kept on the CPU (Float32) so gameplay code can sample exactly what the GPU sees.

export const NOISE_SIZE = 256;
const PERIODS = [4, 8, 16, 32];

function gradNoisePeriodic(size, period, seed) {
  const r = rng(seed);
  const gx = new Float32Array(period * period);
  const gy = new Float32Array(period * period);
  for (let i = 0; i < period * period; i++) {
    const a = r() * Math.PI * 2;
    gx[i] = Math.cos(a);
    gy[i] = Math.sin(a);
  }
  const out = new Float32Array(size * size);
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * period;
      const fy = (y / size) * period;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const x1 = (x0 + 1) % period, y1 = (y0 + 1) % period;
      const i00 = y0 * period + x0, i10 = y0 * period + x1, i01 = y1 * period + x0, i11 = y1 * period + x1;
      const d00 = gx[i00] * tx + gy[i00] * ty;
      const d10 = gx[i10] * (tx - 1) + gy[i10] * ty;
      const d01 = gx[i01] * tx + gy[i01] * (ty - 1);
      const d11 = gx[i11] * (tx - 1) + gy[i11] * (ty - 1);
      const u = fade(tx), v = fade(ty);
      const a = d00 + (d10 - d00) * u;
      const b = d01 + (d11 - d01) * u;
      out[y * size + x] = (a + (b - a) * v) * 1.414;
    }
  }
  return out;
}

export function createNoise(seed = 7) {
  const size = NOISE_SIZE;
  const channels = PERIODS.map((p, i) => gradNoisePeriodic(size, p, seed * 97 + i * 13));
  const cpu = new Float32Array(size * size * 4);
  const half = new Uint16Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    for (let c = 0; c < 4; c++) {
      const v = channels[c][i];
      cpu[i * 4 + c] = v;
      half[i * 4 + c] = THREE.DataUtils.toHalfFloat(v);
    }
  }
  const tex = new THREE.DataTexture(half, size, size, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;

  // Bilinear, wrapped CPU sample of one channel (matches GPU LinearFilter at LOD 0).
  function sample(u, v, c) {
    const x = u * size - 0.5, y = v * size - 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const tx = x - x0, ty = y - y0;
    const m = size - 1;
    const xa = x0 & m, xb = (x0 + 1) & m, ya = y0 & m, yb = (y0 + 1) & m;
    const a = cpu[(ya * size + xa) * 4 + c], b = cpu[(ya * size + xb) * 4 + c];
    const d = cpu[(yb * size + xa) * 4 + c], e = cpu[(yb * size + xb) * 4 + c];
    const top = a + (b - a) * tx, bot = d + (e - d) * tx;
    return top + (bot - top) * ty;
  }

  return { texture: tex, data: cpu, size, sample };
}
