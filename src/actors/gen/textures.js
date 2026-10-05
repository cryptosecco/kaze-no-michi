import * as THREE from 'three';

// Procedural canvas textures for characters and weapons (generated once, cached).
// Every generator returns { map, normalMap?, roughnessMap? } as THREE.CanvasTexture (map in sRGB).

const cache = new Map();
const cached = (key, fn) => {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
};

// seeded rng + tileable value noise
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

function hash2(ix, iy, seed) {
  let h = (ix * 374761393 + iy * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// value noise tileable with integer period p (in lattice cells)
function vnoise(x, y, p, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const w = (i) => ((i % p) + p) % p;
  const a = hash2(w(ix), w(iy), seed), b = hash2(w(ix + 1), w(iy), seed);
  const c = hash2(w(ix), w(iy + 1), seed), d = hash2(w(ix + 1), w(iy + 1), seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

// fbm over the unit square (u, v in [0,1)), tileable; base = lattice cells at octave 0
export function fbm(u, v, base = 4, oct = 4, seed = 1) {
  let s = 0, amp = 0.5, norm = 0, f = base;
  for (let o = 0; o < oct; o++) {
    s += vnoise(u * f, v * f, f, seed + o * 31) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return s / norm;
}

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function tex(c, { srgb = true, repeat = [1, 1], wrap = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (wrap) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

// height field (Float32Array, w*h, 0..1) → tangent-space normal map canvas (wrapping)
function normalFromHeight(H, w, h, strength = 2) {
  const c = canvas(w, h);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const at = (x, y) => H[((y + h) % h) * w + ((x + w) % w)];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = (at(x - 1, y) - at(x + 1, y)) * strength;
      const dy = (at(x, y - 1) - at(x, y + 1)) * strength;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      img.data[i] = ((dx / l) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((-dy / l) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  return c;
}

function fillPixels(w, h, fn) {
  const c = canvas(w, h);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const out = [0, 0, 0, 255];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      out[3] = 255;
      fn(x, y, out);
      const i = (y * w + x) * 4;
      img.data[i] = out[0];
      img.data[i + 1] = out[1];
      img.data[i + 2] = out[2];
      img.data[i + 3] = out[3];
    }
  ctx.putImageData(img, 0, 0);
  return c;
}

const TAU = Math.PI * 2;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const hex = (s) => {
  const n = parseInt(s.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

// Fabric detail: light grey plain weave with slubs, multiplied by vertex colors. Tile ≈ 0.12 m.
export function fabricDetail() {
  return cached('fabric', () => {
    const W = 256, Hh = 256;
    const H = new Float32Array(W * Hh);
    const threads = 64;
    const c = fillPixels(W, Hh, (x, y, o) => {
      const u = x / W, v = y / Hh;
      const tu = (u * threads) % 1, tv = (v * threads) % 1;
      const over = (Math.floor(u * threads) + Math.floor(v * threads)) % 2;
      const warp = Math.sin(tu * Math.PI), weft = Math.sin(tv * Math.PI);
      const bump = over ? warp * (0.6 + 0.4 * weft) : weft * (0.6 + 0.4 * warp);
      const slub = fbm(u, v * 0.25 + 0.3, 8, 3, 7);
      const mott = fbm(u, v, 3, 4, 11);
      H[y * W + x] = bump * 0.6 + slub * 0.4;
      const val = 0.8 + bump * 0.1 + (mott - 0.5) * 0.22 + (slub - 0.5) * 0.12;
      const g = clamp01(val) * 255;
      o[0] = g;
      o[1] = g * 0.99;
      o[2] = g * 0.97;
    });
    return { map: tex(c), normalMap: tex(normalFromHeight(H, W, Hh, 1.6), { srgb: false }) };
  });
}

// Lamellar armor atlas 1024×512. Left half: red lacquer bands + navy silk lacing (sode).
// Right half: black lacquer bands + crimson lacing (dō, kusazuri, kote).
// UV: each part maps u∈[0,.5] or [.5,1] across its width, v∈[0,1] top→bottom (7 bands).
export function lamellarAtlas() {
  return cached('lamellar', () => {
    const W = 1024, Hh = 512;
    const H = new Float32Array(W * Hh);
    const R = new Float32Array(W * Hh);
    const rows = 7;
    const variants = [
      { plate: hex('#561109'), plateHi: hex('#86281b'), lace: hex('#4a0c08'), laceHi: hex('#7e1d12'), cols: 11, thin: true },
      { plate: hex('#16120f'), plateHi: hex('#3f332c'), lace: hex('#4e1410'), laceHi: hex('#86281c'), cols: 9, thin: true },
    ];
    const c = fillPixels(W, Hh, (x, y, o) => {
      const half = x < W / 2 ? 0 : 1;
      const V = variants[half];
      const u = (x % (W / 2)) / (W / 2), v = y / Hh;
      const rv = v * rows, row = Math.floor(rv), fr = rv - row;
      // band profile: rounded top edge, slight convexity, dark groove at the bottom
      const band = Math.sin(clamp01(fr * 1.05) * Math.PI * 0.92 + 0.12);
      const groove = smooth(0.9, 1.0, fr);
      // small plate notches along the band top (kozane heads)
      const pu = u * V.cols * 4 + row * 0.5;
      const notch = Math.abs(((pu % 1) + 1) % 1 - 0.5) * 2;
      const head = fr < 0.12 ? smooth(0.0, 0.12, fr) * (0.75 + 0.25 * notch) : 1;
      // lacing: vertical cord pairs per column crossing each band
      const cu = u * V.cols;
      const cf = cu - Math.floor(cu);
      const cw = V.thin ? 0.022 : 0.035;
      const cordA = 1 - smooth(cw, cw * 2, Math.abs(cf - (V.thin ? 0.45 : 0.4)));
      const cordB = 1 - smooth(cw, cw * 2, Math.abs(cf - (V.thin ? 0.55 : 0.6)));
      const cord = Math.max(cordA, cordB) * (fr > 0.08 && fr < 0.97 ? 1 : 0.0);
      const strand = 0.75 + 0.25 * Math.sin((v * rows * 16 + (cf > 0.5 ? 1 : 0) * 0.5) * Math.PI * 2);
      const n = fbm(u, v, 6, 4, 3 + half * 17);
      const wear = smooth(0.62, 0.8, fbm(u * 1.3, v * 1.3, 5, 3, 9 + half));
      let col = mixc(V.plate, V.plateHi, clamp01(band * 0.55 + (1 - fr) * 0.15 + (n - 0.5) * 0.3));
      col = mixc(col, V.plateHi, wear * 0.35 * (1 - groove));
      col = mixc(col, [12, 9, 8], groove * 0.8 + (1 - head) * 0.4);
      if (cord > 0.02) col = mixc(col, mixc(V.lace, V.laceHi, strand * 0.6 + (n - 0.5) * 0.4), cord);
      H[y * W + x] = band * 0.55 * head * (1 - groove) + cord * 0.45 * strand;
      R[y * W + x] = cord > 0.4 ? 0.85 : 0.32 + wear * 0.25 + groove * 0.3;
      o[0] = col[0];
      o[1] = col[1];
      o[2] = col[2];
    });
    const rough = fillPixels(W, Hh, (x, y, o) => {
      const r = R[y * W + x] * 255;
      o[0] = 255;
      o[1] = r;
      o[2] = 0;
    });
    return {
      map: tex(c, { wrap: false }),
      normalMap: tex(normalFromHeight(H, W, Hh, 3.2), { srgb: false, wrap: false }),
      roughnessMap: tex(rough, { srgb: false, wrap: false }),
    };
  });
}

// Woven straw (kasa hats, sandals, mino). u → around (ribs), v → along the profile (weave rows).
export function straw() {
  return cached('straw', () => {
    const W = 512, Hh = 512;
    const H = new Float32Array(W * Hh);
    const base = hex('#b58f55'), light = hex('#dcc08a'), dark = hex('#6e5230');
    const c = fillPixels(W, Hh, (x, y, o) => {
      const u = x / W, v = y / Hh;
      const ribs = 16, rows = 40;
      const ru = (u * ribs) % 1, rv = (v * rows + (Math.floor(u * ribs) % 2) * 0.5) % 1;
      const rib = 1 - smooth(0.0, 0.08, Math.min(ru, 1 - ru));
      const strip = Math.sin(rv * Math.PI);
      const fib = fbm(u * 4, v * 0.5, 32, 2, 5);
      const n = fbm(u, v, 4, 4, 8);
      let col = mixc(base, light, clamp01(strip * 0.6 + (fib - 0.5) * 0.8 + (n - 0.5) * 0.4));
      col = mixc(col, dark, rib * 0.7 + (1 - strip) * 0.35);
      H[y * W + x] = strip * 0.7 + fib * 0.3 - rib * 0.5;
      o[0] = col[0];
      o[1] = col[1];
      o[2] = col[2];
    });
    return { map: tex(c), normalMap: tex(normalFromHeight(H, W, Hh, 2.5), { srgb: false }) };
  });
}

// Tsuka (katana handle): black silk ito wrapped in diamonds over white rayskin. u around, v along.
export function tsukaWrap(silk = '#15171d') {
  return cached('tsuka' + silk, () => {
    const W = 128, Hh = 512;
    const S = hex(silk), same = hex('#d8d0bd');
    const H = new Float32Array(W * Hh);
    const c = fillPixels(W, Hh, (x, y, o) => {
      const u = x / W, v = y / Hh;
      const k = 9; // diamonds along the handle
      const a = (u * 2 + v * k) % 1, b = (u * 2 - v * k + 10) % 1;
      const silkA = Math.abs(a - 0.5) < 0.22, silkB = Math.abs(b - 0.5) < 0.22;
      const s = silkA || silkB;
      const n = fbm(u, v, 8, 3, 21);
      const bead = fbm(u * 8, v * 8, 64, 1, 4);
      const col = s ? mixc(S, [60, 62, 72], (n - 0.3) * 0.5 + 0.1) : mixc(same, [180, 170, 150], bead * 0.6);
      H[y * W + x] = s ? 0.8 + 0.2 * Math.sin((silkA ? a : b) * Math.PI) : 0.2 + bead * 0.2;
      o[0] = col[0];
      o[1] = col[1];
      o[2] = col[2];
    });
    return { map: tex(c), normalMap: tex(normalFromHeight(H, W, Hh, 2.5), { srgb: false }) };
  });
}

// Blade: u along the blade (0 = habaki, 1 = tip), v across (0 = edge, 1 = spine). Misty hamon line.
export function bladeMap(rusty = false) {
  return cached('blade' + rusty, () => {
    const W = 512, Hh = 64;
    const edge = hex(rusty ? '#9a938a' : '#e4e8ec'), body = hex(rusty ? '#5c5046' : '#8d949c'), spine = hex(rusty ? '#3a2f28' : '#5d646c');
    const rust = hex('#6b3a1e');
    const c = fillPixels(W, Hh, (x, y, o) => {
      const u = x / W, v = y / Hh;
      const wave = 0.3 + 0.07 * Math.sin(u * 60) + 0.04 * Math.sin(u * 23 + 1.3) + (fbm(u, 0.5, 16, 2, 2) - 0.5) * 0.1;
      const hamon = smooth(wave + 0.06, wave - 0.04, v);
      let col = mixc(body, edge, hamon);
      col = mixc(col, spine, smooth(0.78, 0.9, v));
      const n = fbm(u, v, 12, 4, 5);
      col = mixc(col, [255, 255, 255], smooth(0.6, 0.9, n) * 0.15 * hamon);
      if (rusty) col = mixc(col, rust, smooth(0.55, 0.8, fbm(u * 2, v, 8, 4, 12)) * 0.8);
      o[0] = col[0];
      o[1] = col[1];
      o[2] = col[2];
    });
    return { map: tex(c, { wrap: false }) };
  });
}

// Face for a head built from SphereGeometry (u = 0.25 is the front, v = 0 at the crown).
// variant: { skin, beard (0..1), brows, scar, masked (cloth mask over mouth & nose) }
export function faceMap(variant = {}) {
  const key = 'face' + JSON.stringify(variant);
  return cached(key, () => {
    const W = 512, Hh = 256;
    const skin = hex(variant.skin || '#b98661');
    const hair = hex(variant.hair || '#141110');
    const mask = hex(variant.maskColor || '#1d2230');
    const c = fillPixels(W, Hh, (x, y, o) => {
      const u = x / W, v = y / Hh;
      // face-local coords: fx across (−1..1 over ±0.14 u), fy down (0 at eye line)
      const fx = (u - 0.25) / 0.14, fy = (v - 0.47) / 0.12;
      const n = fbm(u, v, 8, 4, 33);
      let col = mixc(skin, [skin[0] * 0.8, skin[1] * 0.72, skin[2] * 0.68], (n - 0.4) * 0.8);
      // cheek warmth, darker jaw
      col = mixc(col, [skin[0] * 1.05, skin[1] * 0.85, skin[2] * 0.8], smooth(0.9, 0.2, Math.hypot(Math.abs(fx) - 0.6, fy - 0.9)) * 0.25);
      // hairline: above v 0.33 and all the back of the head
      const back = Math.abs(((u - 0.25 + 1.5) % 1) - 0.5) < 0.3; // far from the face center
      const hairLine = v < 0.32 + 0.04 * Math.cos(fx * 1.2) || (back && v < 0.72) || Math.abs(fx) > 1.25 && v < 0.62;
      if (hairLine) col = mixc(hair, [40, 34, 30], n * 0.5);
      const brow = Math.abs(fy + 0.62) < 0.1 + 0.03 * variant.brows && Math.abs(Math.abs(fx) - 0.42) < 0.3;
      if (!hairLine && brow) col = mixc(col, hair, 0.85);
      // eyes: dark sockets + eye whites + iris
      const ex = Math.abs(fx) - 0.4, ey = fy + 0.18;
      const eye = (ex * ex) / 0.045 + (ey * ey) / 0.012;
      if (!hairLine && eye < 1.0) {
        col = mixc(col, [30, 20, 18], 0.55);
        const white = (ex * ex) / 0.03 + (ey * ey) / 0.006;
        if (white < 1) col = mixc([170, 160, 150], [20, 14, 12], smooth(0.02, 0.012, ex * ex + ey * ey));
      } else if (!hairLine && eye < 2.2) col = mixc(col, [skin[0] * 0.62, skin[1] * 0.5, skin[2] * 0.46], 0.35 * (2.2 - eye));
      // nose shadow + mouth
      if (!hairLine && Math.abs(fx) < 0.12 && fy > 0.05 && fy < 0.55) col = mixc(col, [skin[0] * 0.75, skin[1] * 0.62, skin[2] * 0.58], 0.3);
      if (!hairLine && Math.abs(fx) < 0.3 && Math.abs(fy - 0.95) < 0.05) col = mixc(col, [110, 50, 45], 0.7);
      // beard / stubble
      const beardZone = fy > 0.55 && Math.abs(fx) < 1.1 - (fy - 0.55) * 0.3 && fy < 1.9;
      const mustache = Math.abs(fy - 0.78) < 0.08 && Math.abs(fx) < 0.45;
      if (!hairLine && variant.beard && (beardZone || mustache)) {
        const d = fbm(u * 4, v * 4, 64, 2, 9);
        col = mixc(col, hair, clamp01(variant.beard * (0.55 + d * 0.6)));
      }
      if (!hairLine && variant.scar && Math.abs(fx - 0.25 - fy * 0.2) < 0.03 && fy > -0.5 && fy < 0.6) col = mixc(col, [150, 80, 70], 0.7);
      // cloth mask over nose & mouth (samurai)
      if (variant.masked && fy > 0.1 && Math.abs(fx) < 1.6) {
        const m2 = fbm(u * 3, v * 3, 24, 3, 13);
        col = mixc(mask, [mask[0] * 1.6, mask[1] * 1.6, mask[2] * 1.6], m2 * 0.5);
      }
      o[0] = col[0];
      o[1] = col[1];
      o[2] = col[2];
    });
    return { map: tex(c, { wrap: false }) };
  });
}

// Ragged patched fabric (bandits): base color, patches, stitches, dirt and sweat stains. Tile ≈ 0.6 m.
export function raggedFabric(base = '#8a6a2a', seed = 1) {
  return cached('rag' + base + seed, () => {
    const W = 512, Hh = 512;
    const B = hex(base);
    const r = rng(seed * 97 + 3);
    const patches = [];
    for (let i = 0; i < 7; i++)
      patches.push({
        x: r(), y: r(), w: 0.08 + r() * 0.12, h: 0.08 + r() * 0.14,
        c: mixc(B, r() < 0.5 ? [60, 45, 30] : [170, 150, 110], 0.3 + r() * 0.4),
      });
    const H = new Float32Array(W * Hh);
    const c = fillPixels(W, Hh, (x, y, o) => {
      const u = x / W, v = y / Hh;
      const n = fbm(u, v, 4, 5, seed);
      const weave = 0.5 + 0.5 * Math.sin(u * W * 0.9) * Math.sin(v * Hh * 0.9);
      let col = mixc(B, [B[0] * 0.55, B[1] * 0.5, B[2] * 0.45], clamp01((n - 0.35) * 1.4));
      let h = weave * 0.3 + n * 0.4;
      for (const p of patches) {
        const dx = Math.abs(((u - p.x + 1.5) % 1) - 0.5), dy = Math.abs(((v - p.y + 1.5) % 1) - 0.5);
        if (dx < p.w / 2 && dy < p.h / 2) {
          col = mixc(p.c, [p.c[0] * 0.7, p.c[1] * 0.7, p.c[2] * 0.7], n * 0.6);
          const edge = Math.min(p.w / 2 - dx, p.h / 2 - dy);
          if (edge < 0.008) {
            const st = Math.sin((dx + dy) * 900) > 0.2;
            if (st) col = mixc(col, [200, 190, 160], 0.6);
            h += 0.4;
          }
        }
      }
      const dirt = smooth(0.55, 0.85, fbm(u * 1.7, v * 1.7, 3, 4, seed + 5));
      col = mixc(col, [58, 44, 32], dirt * 0.45);
      const g = 0.92 + weave * 0.08;
      H[y * W + x] = h;
      o[0] = col[0] * g;
      o[1] = col[1] * g;
      o[2] = col[2] * g;
    });
    return { map: tex(c), normalMap: tex(normalFromHeight(H, W, Hh, 1.8), { srgb: false }) };
  });
}

// Cape: dark cloth with worn edges (u across, v top→bottom). Vertical folds run from the gathered shoulders to
// the hem, meandering and fanning out: baked into the normal map, with occlusion darkening their valleys. A
// dusty, lighter band wears along the hem; alpha frays the hem and tears the sides. `hem` = sRGB hex of the dust.
export function capeMap(color = '#1d2636', seed = 3, fray = 1, hem = '#6d665a') {
  return cached('cape' + color + seed + fray + hem, () => {
    const W = 512, Hh = 512;
    const C = hex(color), E = hex(hem);
    const r = rng(seed * 131 + 17);
    // three fold trains across the width (irregular spacing from incommensurate frequencies)
    const F = [
      [4.2 + r() * 1.0, r(), 0.62],
      [7.3 + r() * 1.5, r(), 0.26],
      [12.5 + r() * 2.0, r(), 0.1],
    ];
    const H = new Float32Array(W * Hh);
    const c = fillPixels(W, Hh, (x, y, o) => {
      const u = x / W, v = y / Hh;
      const n = fbm(u, v, 4, 5, seed);
      const weave = 0.5 + 0.5 * Math.sin(u * W * 1.4) * Math.sin(v * Hh * 1.4);
      // folds: denser under the shoulders, drifting sideways as they fall
      const drift = (fbm(0.37, v, 3, 3, seed + 21) - 0.5) * 0.14;
      const uu = (u - 0.5) * (1.1 - 0.22 * v) + drift;
      let fold = 0;
      for (let k = 0; k < 3; k++) fold += F[k][2] * Math.sin(TAU * (F[k][0] * uu + F[k][1] + (k - 1) * 0.25 * v));
      // variations are centred on the chosen colour (its average stays `color`): valleys darker, ridges lighter
      const ao = 0.8 + 0.26 * smooth(-0.85, 0.6, fold);
      let col = mixc([C[0] * 1.18, C[1] * 1.16, C[2] * 1.12], [C[0] * 0.82, C[1] * 0.82, C[2] * 0.84], n);
      // sun-faded top, worn dusty hem (lighter than the cloth)
      col = mixc(col, [C[0] * 1.5 + 18, C[1] * 1.4 + 14, C[2] * 1.25 + 10], smooth(0.4, 0.0, v) * 0.18);
      col = mixc(col, E, smooth(0.8, 0.97, v) * (0.42 + 0.2 * (n - 0.5)));
      col = [col[0] * ao, col[1] * ao, col[2] * ao];
      const g = 0.95 + weave * 0.1;
      // frayed hem: ragged cut + thin threads. The hem's corners are rounded off (~15 cm): the square corner of the
      // cloth, stretched out sideways by the wind, read as a black claw at the cape's tip (S1)
      const e = Math.min(u, 1 - u);
      const corner = e < 0.14 ? 0.12 * (1 - Math.sqrt(1 - ((0.14 - e) / 0.14) ** 2)) : 0;
      const cut = 0.965 - corner - fray * (0.03 + 0.05 * fbm(u * 3, 0.5, 12, 3, seed + 3) + 0.03 * Math.abs(Math.sin(u * 37)));
      let a = v < cut ? 1 : 0;
      if (v >= cut && v < cut + 0.05 * fray && Math.sin(u * 900) > 0.55) a = 1;
      // a couple of tears on the sides
      if ((u < 0.02 || u > 0.98) && fbm(0.5, v, 16, 2, seed + 8) > 0.62) a = 0;
      H[y * W + x] = weave * 0.5 + n * 0.5 + fold * 4.2;
      o[0] = col[0] * g;
      o[1] = col[1] * g;
      o[2] = col[2] * g;
      o[3] = a * 255;
    });
    return { map: tex(c, { wrap: false }), normalMap: tex(normalFromHeight(H, W, Hh, 1.2), { srgb: false, wrap: false }) };
  });
}

// Plain color swatch helper for tiny props.
export function colorTex(hexColor) {
  return cached('col' + hexColor, () => {
    const c = canvas(4, 4);
    const ctx = c.getContext('2d');
    ctx.fillStyle = hexColor;
    ctx.fillRect(0, 0, 4, 4);
    return tex(c);
  });
}
