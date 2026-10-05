import * as THREE from 'three';
import { fbm } from '../gen/textures.js';

// Canvas textures for the horse (generated once, cached), in the manner of gen/textures.js:
//   coatMap()   short summer coat: light grey (tinted by vertex colours), hair lying along v, faint dapples
//   hairMap()   mane, forelock and tail: strands along v with ragged, thinning tips in alpha (alpha-tested)

const cache = new Map();
const cached = (key, fn) => {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
};

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function tex(c, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

function fill(w, h, fn) {
  const c = canvas(w, h);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const o = [0, 0, 0, 255];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      o[3] = 255;
      fn(x, y, o);
      const i = (y * w + x) * 4;
      img.data[i] = o[0];
      img.data[i + 1] = o[1];
      img.data[i + 2] = o[2];
      img.data[i + 3] = o[3];
    }
  ctx.putImageData(img, 0, 0);
  return c;
}

function normalFromHeight(H, w, h, k) {
  const at = (x, y) => H[((y + h) % h) * w + ((x + w) % w)];
  return fill(w, h, (x, y, o) => {
    const dx = (at(x - 1, y) - at(x + 1, y)) * k, dy = (at(x, y - 1) - at(x, y + 1)) * k;
    const l = Math.hypot(dx, dy, 1);
    o[0] = ((dx / l) * 0.5 + 0.5) * 255;
    o[1] = ((-dy / l) * 0.5 + 0.5) * 255;
    o[2] = ((1 / l) * 0.5 + 0.5) * 255;
  });
}

// Coat: tile ≈ 0.3 m. The hair lies along v (the loft direction: along the body, down the legs and the neck).
export function coatMap() {
  return cached('coat', () => {
    const W = 256, Hh = 256;
    const H = new Float32Array(W * Hh);
    const c = fill(W, Hh, (x, y, o) => {
      const u = x / W, v = y / Hh;
      // fine hair: streaks along v (a 1D noise across u, tileable), broken a little along their length
      const hair = 0.7 * fbm(u, 0.5, 64, 2, 41) + 0.3 * fbm(u, v, 16, 2, 42);
      const lay = fbm(u, v, 6, 3, 43);
      // dapples: soft rings of lighter coat (a well-fed horse at summer's end)
      const d = fbm(u, v, 5, 3, 47);
      const dap = Math.max(0, 1 - Math.abs(d - 0.55) * 9) * 0.5;
      H[y * W + x] = hair * 0.8 + lay * 0.2;
      const g = Math.max(0, Math.min(255, (0.88 + (hair - 0.5) * 0.06 + (lay - 0.5) * 0.08 + dap * 0.04) * 255));
      o[0] = g;
      o[1] = g * 0.985;
      o[2] = g * 0.97;
    });
    return { map: tex(c), normalMap: tex(normalFromHeight(H, W, Hh, 1.4), false) };
  });
}

// Hair: u across the lock, v from the root (0) to the tip (1). Alpha thins the strands toward ragged tips.
export function hairMap() {
  return cached('hair', () => {
    const W = 256, Hh = 256;
    const H = new Float32Array(W * Hh);
    const c = fill(W, Hh, (x, y, o) => {
      const u = x / W, v = y / Hh;
      const strand = 0.8 * fbm(u, 0.5, 96, 2, 51) + 0.2 * fbm(u, v, 24, 2, 52);
      const clump = fbm(u, v * 0.25, 12, 3, 53);
      H[y * W + x] = strand;
      const g = 0.55 + strand * 0.5 + (clump - 0.5) * 0.3;
      o[0] = Math.min(255, g * 255);
      o[1] = Math.min(255, g * 0.94 * 255);
      o[2] = Math.min(255, g * 0.9 * 255);
      // ragged ends: each clump of strands stops at its own length
      const len = 0.62 + 0.3 * fbm(u, 0.5, 24, 3, 57) + 0.3 * (fbm(u, 0.5, 96, 2, 59) - 0.5);
      const edge = (len - v) / 0.12;
      o[3] = Math.max(0, Math.min(1, edge)) * (0.45 + 0.9 * (strand - 0.35)) > 0.42 ? 255 : 0;
    });
    return { map: tex(c), normalMap: tex(normalFromHeight(H, W, Hh, 2.2), false) };
  });
}
