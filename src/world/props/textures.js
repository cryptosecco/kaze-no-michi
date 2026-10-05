import * as THREE from 'three';

// Procedural, tileable material textures painted on canvases at startup (no downloads).
// Every texture tiles seamlessly: noise lattices are periodic in both axes.
//   albedo (sRGB) + normal map (from a height field) per material family.

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Periodic value noise with independent periods on x and y (anisotropic noise for grain/strands).
class TileNoise {
  constructor(px, py, seed) {
    this.px = px;
    this.py = py;
    const r = rng(seed);
    this.v = new Float32Array(px * py);
    for (let i = 0; i < this.v.length; i++) this.v[i] = r() * 2 - 1;
  }
  at(x, y) {
    const px = this.px, py = this.py;
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const u = fx * fx * (3 - 2 * fx), w = fy * fy * (3 - 2 * fy);
    const x0 = ((xi % px) + px) % px, y0 = ((yi % py) + py) % py;
    const x1 = (x0 + 1) % px, y1 = (y0 + 1) % py;
    const a = this.v[y0 * px + x0], b = this.v[y0 * px + x1], c = this.v[y1 * px + x0], d = this.v[y1 * px + x1];
    return a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w;
  }
}

// fbm on texture coordinates s,t ∈ [0,1): base frequency fx×fy (integers → tileable), octaves.
function makeFbm(fx, fy, octaves, seed, gain = 0.5) {
  const layers = [];
  let amp = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    layers.push({ n: new TileNoise(fx << o, fy << o, seed + o * 7919), fx: fx << o, fy: fy << o, amp });
    norm += amp;
    amp *= gain;
  }
  return (s, t) => {
    let v = 0;
    for (const l of layers) v += l.n.at(s * l.fx, t * l.fy) * l.amp;
    return v / norm;
  };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, v) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;

// Paint a texture: fn(s, t, out) fills out = [r, g, b, height, alpha?] with 0..1 values.
function paint(size, fn, { normalStrength = 2, alpha = false } = {}) {
  const w = size, h = size;
  const col = new Uint8ClampedArray(w * h * 4);
  const hgt = new Float32Array(w * h);
  const out = [0, 0, 0, 0, 1];
  for (let y = 0; y < h; y++) {
    const t = y / h;
    for (let x = 0; x < w; x++) {
      const s = x / w;
      out[4] = 1;
      fn(s, t, out);
      const i = y * w + x;
      col[i * 4] = out[0] * 255;
      col[i * 4 + 1] = out[1] * 255;
      col[i * 4 + 2] = out[2] * 255;
      col[i * 4 + 3] = alpha ? out[4] * 255 : 255;
      hgt[i] = out[3];
    }
  }
  const albedo = toCanvasTexture(col, w, h, true);
  const nrm = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const yu = (y - 1 + h) % h, yd = (y + 1) % h;
    for (let x = 0; x < w; x++) {
      const xl = (x - 1 + w) % w, xr = (x + 1) % w;
      // canvas row 0 is the top of the texture (v = 1 after flipY): +v = row - 1
      let nx = (hgt[y * w + xl] - hgt[y * w + xr]) * normalStrength;
      let ny = (hgt[yd * w + x] - hgt[yu * w + x]) * normalStrength;
      const l = Math.hypot(nx, ny, 1);
      const i = (y * w + x) * 4;
      nrm[i] = ((nx / l) * 0.5 + 0.5) * 255;
      nrm[i + 1] = ((ny / l) * 0.5 + 0.5) * 255;
      nrm[i + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      nrm[i + 3] = 255;
    }
  }
  const normal = toCanvasTexture(nrm, w, h, false);
  return { albedo, normal };
}

function toCanvasTexture(data, w, h, srgb) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').putImageData(new ImageData(data, w, h), 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

// Families

// Weathered timber: long grain along u (s), growth lines, checks (cracks), soft irregular tone.
function wood(size = 512) {
  // straight, fine grain along s (planks and posts are quarter-sawn, weathered): many thin lines,
  // gentle tonal drift, sparse drying checks
  const grain = makeFbm(1, 64, 3, 11);
  const fine = makeFbm(2, 160, 2, 15);
  const warp = makeFbm(2, 3, 3, 12);
  const tone = makeFbm(3, 8, 4, 13);
  const crack = makeFbm(2, 96, 2, 14);
  return paint(
    size,
    (s, t, o) => {
      const wv = warp(s, t) * 0.02;
      const g = grain(s, t + wv) * 0.5 + 0.5;
      const f = fine(s, t + wv) * 0.5 + 0.5;
      const lines = Math.pow(Math.abs(Math.sin((t + wv) * Math.PI * 120 + g * 2.0)), 8);
      const chk = smooth(0.66, 0.72, crack(s, t) * 0.5 + 0.5) * 0.8;
      const tn = tone(s, t) * 0.5 + 0.5;
      let v = 0.56 + (g - 0.5) * 0.16 + (f - 0.5) * 0.1 - lines * 0.07 + (tn - 0.5) * 0.14;
      v *= 1 - chk * 0.5;
      o[0] = clamp01(v * 1.0);
      o[1] = clamp01(v * 0.94);
      o[2] = clamp01(v * 0.87);
      o[3] = g * 0.25 + f * 0.2 - lines * 0.12 - chk * 0.8;
    },
    { normalStrength: 2.2 }
  );
}

// Vermilion lacquer (shu-urushi): sun-faded patches, fine brush mottle, chips down to dark wood,
// dirt streaks running down (t axis = down the member when mapped along it).
function lacquer(size = 512, base = [0.62, 0.2, 0.1], faded = [0.72, 0.38, 0.25], under = [0.34, 0.15, 0.09]) {
  const patch = makeFbm(3, 3, 5, 21);
  const mottle = makeFbm(24, 24, 2, 22);
  const chip = makeFbm(22, 22, 3, 23);
  const streak = makeFbm(2, 28, 3, 24);
  return paint(
    size,
    (s, t, o) => {
      const p = patch(s, t) * 0.5 + 0.5;
      const m = mottle(s, t) * 0.5 + 0.5;
      // sparse, small flakes where the paint has lifted (mostly inside worn patches)
      const ch = smooth(0.8, 0.84, chip(s, t) * 0.5 + 0.5 + (p - 0.5) * 0.18) * 0.85;
      const st = smooth(0.35, 0.9, streak(s, t) * 0.5 + 0.5) * 0.4;
      const fade = smooth(0.4, 0.85, p) * 0.8;
      let r = mix(base[0], faded[0], fade), g = mix(base[1], faded[1], fade), b = mix(base[2], faded[2], fade);
      const k = 0.9 + m * 0.18 - st * 0.35;
      r *= k;
      g *= k;
      b *= k;
      r = mix(r, under[0], ch);
      g = mix(g, under[1], ch);
      b = mix(b, under[2], ch);
      o[0] = clamp01(r);
      o[1] = clamp01(g);
      o[2] = clamp01(b);
      o[3] = m * 0.06 - ch * 0.5 - st * 0.08;
    },
    { normalStrength: 2.2 }
  );
}

// Granite / weathered stone: speckles, lichen blots, pitted relief.
function granite(size = 512) {
  const big = makeFbm(4, 4, 5, 31);
  const speck = makeFbm(64, 64, 2, 32);
  const speck2 = makeFbm(96, 96, 1, 33);
  const lich = makeFbm(6, 6, 4, 34);
  const pit = makeFbm(20, 20, 3, 35);
  return paint(
    size,
    (s, t, o) => {
      const b = big(s, t) * 0.5 + 0.5;
      const sp = speck(s, t);
      const sp2 = speck2(s, t);
      let v = 0.5 + (b - 0.5) * 0.2 + sp * 0.05;
      const dark = smooth(0.45, 0.6, sp2) * 0.09;
      const light = smooth(0.5, 0.65, -sp2) * 0.06;
      v = v - dark + light;
      let r = v * 1.0, g = v * 0.975, bl = v * 0.93;
      const l = smooth(0.55, 0.68, lich(s, t) * 0.5 + 0.5);
      // pale grey-green lichen blots
      r = mix(r, 0.64, l * 0.35);
      g = mix(g, 0.65, l * 0.35);
      bl = mix(bl, 0.58, l * 0.35);
      const pt = pit(s, t);
      o[0] = clamp01(r);
      o[1] = clamp01(g);
      o[2] = clamp01(bl);
      o[3] = b * 0.6 + pt * 0.25 + sp * 0.05;
    },
    { normalStrength: 2.6 }
  );
}

// Old thatch, meant to read from ~40 m: bundles of straw running down the slope (s across, t up the slope) with
// dark grooves between them, laid in courses whose butt ends catch the light over the shadowed start of the next
// course, grey weathered patches and darker rain streaks. Shaggy rather than combed: the bundles wander, short loose
// straws lie askew across them, and the old roof has blackened, rotting patches and a mossy tint (straight even
// bundles read as the grain of planks). One tile ≈ 2.5 m (materials: repeat 0.4 on metric UVs).
function thatch(size = 512) {
  const N = 26; // bundles across a tile (~10 cm)
  const C = 2; // courses down a tile (~1.25 m), staggered bundle by bundle
  const warp = makeFbm(8, 3, 3, 41);
  const clump = makeFbm(7, 3, 3, 42);
  const tone = makeFbm(2, 2, 4, 43);
  const fine = makeFbm(128, 4, 2, 44);
  const wav = makeFbm(5, 1, 2, 45);
  const streak = makeFbm(20, 1, 3, 46);
  const strand = makeFbm(64, 8, 3, 47); // straws (~4 cm × 30 cm), independent of the bundles: no long grain lines
  // short straws lying askew (~27° either side of the slope line): sampled on slanted axes (2s ∓ t, t), integer
  // combinations, so the tile still repeats
  const shag = makeFbm(36, 9, 2, 48);
  const rot = makeFbm(3, 3, 3, 49); // blackened, rotting patches
  const moss = makeFbm(4, 4, 3, 50);
  const hash = (k) => {
    let h = Math.imul(k + 1013, 0x9e3779b1);
    h ^= h >>> 15;
    h = Math.imul(h, 0x85ebca77);
    h ^= h >>> 13;
    return (h >>> 0) / 4294967296;
  };
  return paint(
    size,
    (s, t, o) => {
      const d = 1 - t; // down the slope
      const x = s * N + warp(s, t) * 3.2;
      const k = Math.floor(x);
      const kr = hash(((k % N) + N) % N);
      const prof = Math.sin(Math.PI * (x - k)); // 0 in the grooves, 1 on a bundle's crown
      const groove = smooth(0.36, 0.0, prof) * (0.45 + 0.55 * kr);
      const cl = clump(s, t) * 0.5 + 0.5;
      const fi = fine(s, t) * 0.5 + 0.5;
      const tn = tone(s, t) * 0.5 + 0.5;
      const st = streak(s, t) * 0.5 + 0.5;
      const cy = d * C + wav(s, t) * 0.6 + (kr - 0.5) * 0.7;
      const cf = cy - Math.floor(cy); // 0 where a course comes out from under the one above → 1 at its butt ends
      const tip = smooth(0.86, 0.98, cf) * (0.4 + 0.6 * kr);
      const shade = smooth(0.07, 0.0, cf) * (0.5 + 0.5 * kr);
      const sd = strand(s, t) * 0.5 + 0.5;
      const sh = Math.max(shag(2 * s - t, t), shag(2 * s + t + 0.5, t)) * 0.5 + 0.5;
      // tone patches stay soft (strong ones read as camouflage blotches from the yard)
      let v = 0.34 + prof * 0.05 + (kr - 0.5) * 0.12 + (cl - 0.5) * 0.22 + (sd - 0.5) * 0.12 + (sh - 0.5) * 0.36 + (fi - 0.5) * 0.14 + tip * 0.08 - shade * 0.16;
      v *= 1 - groove * 0.24;
      v *= 1 - smooth(0.6, 0.9, st) * 0.18;
      const rk = smooth(0.15, 0.6, rot(s, t));
      v *= 1 - rk * 0.32;
      const grey = smooth(0.3, 0.65, tn);
      const mo = smooth(0.2, 0.7, moss(s, t)) * (1 - rk) * 0.4;
      o[0] = clamp01(v * mix(mix(1.0, 0.95, grey), 0.8, mo));
      o[1] = clamp01(v * mix(mix(0.9, 0.93, grey), 0.9, mo));
      o[2] = clamp01(v * mix(mix(0.74, 0.86, grey), 0.62, mo));
      o[3] = prof * 0.25 + sd * 0.15 + sh * 0.3 + cl * 0.3 + fi * 0.12 + cf * 0.2 - shade * 0.2 - rk * 0.15;
    },
    { normalStrength: 3.6 }
  );
}

// Loose straw hanging below a thatch eave (alpha): strands of uneven length from a dense top edge.
// flipY off: v = 0 is the top edge (where the strip hangs from the eave), v = 1 the tips.
function thatchFringe(w = 256, h = 128) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const r = rng(515);
  ctx.fillStyle = '#4a4034';
  ctx.fillRect(0, 0, w, h * 0.1);
  ctx.lineCap = 'round';
  for (let i = 0; i < 900; i++) {
    const x = r() * w, len = h * (0.2 + 0.8 * Math.pow(r(), 0.8)), sl = (r() - 0.5) * 14;
    const g = 60 + r() * 85;
    ctx.strokeStyle = `rgb(${(g * 1.06) | 0},${(g * 0.9) | 0},${(g * 0.68) | 0})`;
    ctx.lineWidth = 1 + r() * 1.8;
    for (const ox of [-w, 0, w]) {
      ctx.beginPath();
      ctx.moveTo(x + ox, 0);
      ctx.lineTo(x + ox + sl, len);
      ctx.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// Cypress-bark shingles (hiwadabuki): thin courses stacked along t, fibrous along t.
function barkRoof(size = 512) {
  const fib = makeFbm(90, 4, 2, 51);
  const var1 = makeFbm(6, 12, 4, 52);
  const edge = makeFbm(12, 2, 3, 53);
  return paint(
    size,
    (s, t, o) => {
      const course = (t * 22 + edge(s, t) * 0.25) % 1;
      const lip = smooth(0.0, 0.08, course) * (1 - smooth(0.85, 1.0, course));
      const f = fib(s, t) * 0.5 + 0.5;
      const vv = var1(s, t) * 0.5 + 0.5;
      let v = 0.2 + f * 0.12 + vv * 0.1 + course * 0.06;
      v *= 0.6 + lip * 0.4;
      o[0] = clamp01(v * 1.05);
      o[1] = clamp01(v * 0.86);
      o[2] = clamp01(v * 0.74);
      o[3] = course * 0.8 + f * 0.15;
    },
    { normalStrength: 3.0 }
  );
}

// Grey kawara tiles: round cover-tile ribs along t, courses along t.
function tileRoof(size = 512) {
  const var1 = makeFbm(8, 8, 4, 61);
  const dirt = makeFbm(4, 16, 3, 62);
  return paint(
    size,
    (s, t, o) => {
      const rib = Math.abs(Math.sin(s * Math.PI * 8)); // 8 rows of tiles per tile unit
      const cover = Math.pow(rib, 0.35);
      const course = (t * 7) % 1;
      const step = smooth(0.0, 0.06, course);
      const vv = var1(s, t) * 0.5 + 0.5;
      const d = smooth(0.3, 0.8, dirt(s, t) * 0.5 + 0.5);
      let v = 0.2 + vv * 0.07 + cover * 0.06 - (1 - step) * 0.08 - d * 0.06;
      o[0] = clamp01(v * 0.92);
      o[1] = clamp01(v * 0.95);
      o[2] = clamp01(v * 1.02);
      o[3] = cover * 0.9 + course * 0.35;
    },
    { normalStrength: 3.2 }
  );
}

// Lime/earth plaster: off-white with rain streaks and soot.
function plaster(size = 256) {
  const n = makeFbm(4, 4, 5, 71);
  const streak = makeFbm(30, 2, 3, 72);
  return paint(
    size,
    (s, t, o) => {
      const a = n(s, t) * 0.5 + 0.5;
      const st = smooth(0.45, 0.9, streak(s, t) * 0.5 + 0.5) * 0.18;
      const v = 0.8 + (a - 0.5) * 0.12 - st;
      o[0] = clamp01(v);
      o[1] = clamp01(v * 0.96);
      o[2] = clamp01(v * 0.88);
      o[3] = a * 0.2;
    },
    { normalStrength: 1.2 }
  );
}

// Cloth (hemp/cotton): weave + dirt; tinted per material.
function cloth(size = 256) {
  const dirt = makeFbm(4, 4, 4, 81);
  const slub = makeFbm(64, 8, 2, 82);
  return paint(
    size,
    (s, t, o) => {
      const wx = Math.abs(Math.sin(s * Math.PI * 128)), wy = Math.abs(Math.sin(t * Math.PI * 128));
      const weave = (wx * 0.5 + wy * 0.5);
      const d = smooth(0.4, 0.9, dirt(s, t) * 0.5 + 0.5) * 0.3;
      const sl = slub(s, t) * 0.06;
      const v = 0.82 + weave * 0.1 + sl - d;
      o[0] = clamp01(v);
      o[1] = clamp01(v * 0.97);
      o[2] = clamp01(v * 0.92);
      o[3] = weave * 0.3;
    },
    { normalStrength: 1.0 }
  );
}

// Straw (rope, bales): fibres along s.
function straw(size = 256) {
  const fib = makeFbm(3, 90, 2, 91);
  const tn = makeFbm(4, 4, 3, 92);
  return paint(
    size,
    (s, t, o) => {
      const f = fib(s, t) * 0.5 + 0.5;
      const k = tn(s, t) * 0.5 + 0.5;
      const v = 0.45 + f * 0.35 + (k - 0.5) * 0.15;
      o[0] = clamp01(v * 0.95);
      o[1] = clamp01(v * 0.8);
      o[2] = clamp01(v * 0.48);
      o[3] = f * 0.6;
    },
    { normalStrength: 2.2 }
  );
}

// Soft smoke puff (alpha in the alpha channel), used by the camp fire.
function smokePuff(size = 128) {
  const n = makeFbm(4, 4, 4, 101);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = x / size - 0.5, dy = y / size - 0.5;
      const r = Math.hypot(dx, dy) * 2;
      const v = n(x / size, y / size) * 0.5 + 0.5;
      const a = clamp01((1 - smooth(0.25, 1.0, r + (v - 0.5) * 0.55)) * (0.55 + v * 0.6));
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255 * (0.75 + v * 0.25);
      img.data[i + 3] = a * 255;
    }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

// Banner prints: crests on old cloth, faded, stained and worn, with a torn hem, holes and frayed sides in alpha.
function bannerPrint(kind, w = 256, h = 512) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  // faded field colours: slate indigo that reads blue-grey in shade, bleached hemp, sun-greyed ash
  const palettes = {
    indigo: { field: '#4c5a70', ink: '#cfc7b3', edge: '#2e384a' },
    white: { field: '#cfc6b0', ink: '#57514a', edge: '#8f846f' },
    rust: { field: '#9d9582', ink: '#3f3a33', edge: '#5d564a' },
  };
  const p = palettes[kind] || palettes.indigo;
  const seed = kind.length * 31 + kind.charCodeAt(0);
  ctx.fillStyle = p.field;
  ctx.fillRect(0, 0, w, h);
  // band at the top where the loops (chi) hold the cloth on the rope
  ctx.fillStyle = p.edge;
  ctx.fillRect(0, 0, w, h * 0.075);
  ctx.fillStyle = p.ink;
  ctx.strokeStyle = p.ink;
  const cx = w / 2, cy = h * 0.33, R = w * 0.34;
  if (kind === 'white') {
    // nine-star crest: a ring of eight discs around a larger one, inside a ring
    ctx.lineWidth = R * 0.08;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.02, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.3, 0, Math.PI * 2);
    ctx.fill();
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * R * 0.67, cy + Math.sin(a) * R * 0.67, R * 0.19, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    // five-petal blossom crest in a double ring, with leaf strokes between the petals
    ctx.lineWidth = R * 0.07;
    for (const rr of [1.04, 0.9]) {
      ctx.beginPath();
      ctx.arc(cx, cy, R * rr, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2 - Math.PI / 2;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * R * 0.46, cy + Math.sin(a) * R * 0.46, R * 0.3, 0, Math.PI * 2);
      ctx.fill();
      const b2 = a + Math.PI / 5;
      ctx.beginPath();
      ctx.ellipse(cx + Math.cos(b2) * R * 0.66, cy + Math.sin(b2) * R * 0.66, R * 0.14, R * 0.05, b2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = p.field;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.18, 0, Math.PI * 2);
    ctx.fill();
  }
  // vertical brush-stroke marks below the crest (unreadable, calligraphic rhythm)
  ctx.fillStyle = p.ink;
  const r = rng(seed);
  for (let k = 0; k < 5; k++) {
    const y0 = h * (0.6 + k * 0.065);
    const len = w * (0.12 + r() * 0.18);
    ctx.fillRect(cx - len / 2, y0, len, h * 0.02 + r() * h * 0.012);
    if (r() > 0.4) ctx.fillRect(cx - w * 0.02, y0 - h * 0.02, w * 0.04, h * 0.055);
  }
  // wear: sun-bleached top, rain streaks from the rope, mud toward the hem, worn-off ink; a ragged torn hem with
  // long tears, a few holes, frayed sides and the loops at the top
  const img = ctx.getImageData(0, 0, w, h);
  const n = makeFbm(4, 8, 4, seed + 5);
  const streak = makeFbm(18, 1, 3, seed + 6);
  const wear = makeFbm(12, 24, 3, seed + 7);
  const fray = makeFbm(24, 1, 2, seed + 3);
  const side = makeFbm(1, 40, 2, seed + 9);
  const tears = [];
  for (let k = 0; k < 3; k++) tears.push({ x: (0.15 + r() * 0.7) * w, top: 0.62 + r() * 0.18, wd: 2 + r() * 3 });
  const holes = [];
  for (let k = 0; k < 4; k++) holes.push({ x: (0.12 + r() * 0.76) * w, y: (0.45 + r() * 0.4) * h, r: 2.5 + r() * 5 });
  const fr = parseInt(p.field.slice(1, 3), 16), fg = parseInt(p.field.slice(3, 5), 16), fb = parseInt(p.field.slice(5, 7), 16);
  const loops = 7;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const u = x / w, v = y / h;
      const blot = n(u, v) * 0.5 + 0.5;
      const st = smooth(0.55, 0.85, streak(u, v) * 0.5 + 0.5) * (1 - v * 0.6);
      const wr = smooth(0.45, 0.8, wear(u, v) * 0.5 + 0.5) * 0.7;
      const R0 = mix(img.data[i], fr, wr), G0 = mix(img.data[i + 1], fg, wr), B0 = mix(img.data[i + 2], fb, wr);
      const k = (0.76 + blot * 0.34) * (1 + (1 - v) * 0.1) * (1 - st * 0.3);
      const mud = smooth(0.62, 1.0, v) * 0.35;
      img.data[i] = mix(R0 * k, 78, mud);
      img.data[i + 1] = mix(G0 * k, 62, mud);
      img.data[i + 2] = mix(B0 * k, 46, mud);
      let a = 255;
      if (v > 0.86 + fray(u, 0.5) * 0.09) a = 0;
      for (const t of tears) if (v > t.top && Math.abs(x - t.x) < t.wd * (0.4 + (v - t.top) * 4)) a = 0;
      for (const o of holes) if ((x - o.x) ** 2 + (y - o.y) ** 2 < o.r * o.r) a = 0;
      const sd = 2 + (side(0.5, v) * 0.5 + 0.5) * 6;
      if (x < sd * (0.3 + v) || w - 1 - x < sd * (0.3 + v)) a = 0;
      if (v < 0.04 && (u * loops) % 1 > 0.55) a = 0;
      img.data[i + 3] = a;
    }
  ctx.putImageData(img, 0, 0);
  return c;
}

// Banner atlas: the three prints side by side (u ∈ [i/3, (i+1)/3]) → one material for every banner.
export const BANNER_KINDS = 3;
function bannerAtlas() {
  const prints = [bannerPrint('indigo'), bannerPrint('white'), bannerPrint('rust')];
  const c = document.createElement('canvas');
  c.width = prints[0].width * prints.length;
  c.height = prints[0].height;
  const ctx = c.getContext('2d');
  prints.forEach((p, i) => ctx.drawImage(p, i * p.width, 0));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// Shide paper zig-zag streamer (alpha).
function shide(w = 64, h = 128) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f2efe6';
  const segs = 4;
  const bw = w * 0.42;
  // folded paper: blocks alternating left/right down the strip
  for (let k = 0; k < segs; k++) {
    const off = k % 2 === 0 ? w * 0.46 : w * 0.04;
    ctx.fillRect(off, (k / segs) * h, bw, h / segs + 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Fallen-leaf atlas 2×2: two maples (crimson, orange), a ginkgo fan (gold), a browned maple.
function leafAtlas(size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const cell = size / 2;
  const maple = (cx, cy, R, col, vein) => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = col;
    ctx.beginPath();
    const lobes = 7;
    for (let k = 0; k <= lobes * 2; k++) {
      // lobes fan around from the stem gap (bottom) through the top; the middle lobe points up
      const a = Math.PI / 2 + 0.44 + (k / (lobes * 2)) * (Math.PI * 2 - 0.88);
      const tip = k % 2 === 0;
      const lobeScale = 1 - Math.abs(k / (lobes * 2) - 0.5) * 0.9;
      const r = tip ? R * (0.55 + 0.45 * lobeScale) : R * 0.28;
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = vein;
    ctx.lineWidth = R * 0.05;
    for (let k = 0; k < 5; k++) {
      const a = -Math.PI / 2 + (k - 2) * 0.62;
      ctx.beginPath();
      ctx.moveTo(0, R * 0.12);
      ctx.lineTo(Math.cos(a) * R * 0.8, Math.sin(a) * R * 0.8);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(0, R * 0.1);
    ctx.lineTo(R * 0.08, R * 0.72);
    ctx.stroke();
    ctx.restore();
  };
  const ginkgo = (cx, cy, R, col) => {
    ctx.save();
    ctx.translate(cx, cy + R * 0.35);
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, R, -Math.PI / 2 - 1.05, -Math.PI / 2 - 0.08);
    ctx.lineTo(0, -R * 0.62);
    ctx.arc(0, 0, R, -Math.PI / 2 + 0.08, -Math.PI / 2 + 1.05);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = R * 0.06;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, R * 0.5);
    ctx.stroke();
    ctx.restore();
  };
  maple(cell * 0.5, cell * 0.5, cell * 0.44, '#b0170c', '#7a0c06');
  maple(cell * 1.5, cell * 0.5, cell * 0.44, '#d4520f', '#8e2c07');
  ginkgo(cell * 0.5, cell * 1.5, cell * 0.46, '#e0a912');
  maple(cell * 1.5, cell * 1.5, cell * 0.44, '#6e2a10', '#4a1a08');
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

let cache = null;

export function getTextures() {
  if (cache) return cache;
  cache = {
    wood: wood(512),
    lacquer: lacquer(512),
    black: lacquer(256, [0.035, 0.032, 0.03], [0.1, 0.09, 0.085], [0.14, 0.08, 0.05]),
    granite: granite(512),
    thatch: thatch(512),
    thatchFringe: thatchFringe(),
    bark: barkRoof(512),
    tile: tileRoof(256),
    plaster: plaster(256),
    cloth: cloth(256),
    straw: straw(256),
    smoke: smokePuff(128),
    banners: bannerAtlas(),
    leaves: leafAtlas(),
    shide: shide(),
  };
  return cache;
}
