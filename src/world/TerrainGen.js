import { Simplex, clamp, lerp, saturate, smoothstep } from '../core/math.js';
import { POI, PATHS, PATH_INFO, WORLD } from './Layout.js';

// CPU generation of Hoshigashima: height function, masks and baked lighting (heightfield sun
// visibility + horizon AO). Grid: GRID_N × GRID_N samples every CELL meters, sample (i, j) at
// world (-1024 + i*CELL, -1024 + j*CELL). Mesh vertices, CPU queries and GPU textures all use it.

export const CELL = 2;
export const GRID_N = WORLD.size / CELL + 1; // 1025

const F = POI.field, C = POI.camp, P = POI.pagoda, SH = POI.shrine, CL = POI.cliff;
const BASIN_Y = 18;

export class TerrainGen {
  constructor(seed = 1234) {
    this.s1 = new Simplex(seed);
    this.s2 = new Simplex(seed + 101);
    this.s3 = new Simplex(seed + 202);
    this.shrineTopY = BASIN_Y + SH.rise;
    this._noStairs = true;
    this.pagodaY = null;
    this.pagodaY = this._pagodaTop();
    // height of the stairs foot computed without the stair carve
    this.stairsBaseY = this.height(SH.stairsBase.x, SH.stairsBase.z);
    this._noStairs = false;
  }

  _pagodaTop() {
    const save = this.pagodaY;
    this.pagodaY = null;
    let m = -Infinity;
    for (let a = 0; a < 8; a++) {
      const x = P.x + Math.cos(a) * 6, z = P.z + Math.sin(a) * 6;
      m = Math.max(m, this.height(x, z));
    }
    this.pagodaY = save;
    return m + 1.0;
  }

  // Raw analytic height (meters). Valid everywhere, including far outside the playable square.
  height(x, z) {
    const s1 = this.s1, s2 = this.s2, s3 = this.s3;
    // rolling hills
    let h = 22 + s1.fbm(x * 0.0023, z * 0.0023, 5) * 17;
    h += s2.fbm(x * 0.011 + 5.1, z * 0.011 - 2.3, 3) * 2.6;
    // micro-relief: hummocks and swales that catch the low sun (kept everywhere, incl. the basin)
    const micro = s3.fbm(x * 0.021 + 3.7, z * 0.021 - 8.1, 3) * 1.25 + s1.noise(x * 0.063 + 1.1, z * 0.063 + 4.4) * 0.32;

    // broad field basin around spawn
    const df = Math.hypot(x - F.x, z - F.z);
    const wf = 1 - smoothstep(F.r * 0.5, F.r * 1.08, df);
    if (wf > 0) {
      const basin = BASIN_Y + s2.fbm(x * 0.0052 + 3.3, z * 0.0052 - 1.1, 4) * 4.6;
      h = lerp(h, basin, wf * 0.93);
    }
    h += micro;
    // rolling rim of hills around the basin (encloses the field, gives layered silhouettes)
    const rim = smoothstep(F.r * 0.9, F.r * 1.6, df) * (1 - smoothstep(F.r * 2.6, F.r * 3.6, df));
    // (rounded, wooded rises — mostly fbm, only a hint of ridging so crests stay soft)
    if (rim > 0) h += rim * (6 + (s1.ridged(x * 0.0065 + 2.2, z * 0.0065 - 5.5, 4) * 0.18 + (s2.fbm(x * 0.005, z * 0.005, 3) * 0.5 + 0.5) * 0.82) * 32);

    // small eastern valley for the camp
    const dc = Math.hypot(x - C.x, z - C.z);
    const wc = 1 - smoothstep(45, 150, dc);
    if (wc > 0) h = lerp(h, 15 + s2.fbm(x * 0.012, z * 0.012, 2) * 1.4, wc * 0.85);

    // pagoda ridge (runs east–west through the pagoda)
    const rx = x - P.x, rz = z - P.z;
    const ridgeW = Math.exp(-(rz * rz) / (2 * 60 * 60)) * smoothstep(560, 140, Math.abs(rx));
    if (ridgeW > 0.002) {
      const ridgeH = 60 + s1.ridged(x * 0.0042 + 1.7, z * 0.0042, 4) * 26;
      h = Math.max(h, lerp(h, ridgeH, ridgeW));
    }
    if (this.pagodaY !== null) {
      const dp = Math.hypot(rx, rz);
      const wp = 1 - smoothstep(15, 32, dp);
      if (wp > 0) h = lerp(h, this.pagodaY, wp);
    }

    // mountains to the north and east (and beyond the world edge)
    const mN = smoothstep(640, 1050, -z + s3.noise(x * 0.0025, 7.7) * 110);
    const mE = smoothstep(640, 1050, x + s3.noise(3.3, z * 0.0025) * 110);
    const m = Math.max(mN, mE);
    if (m > 0) {
      // rounded, forested island ranges (not alpine spikes): fbm body + gentle ridging
      const r = Math.hypot(x, z);
      const grand = smoothstep(1300, 4200, r);
      const body = s1.fbm(x * 0.0015 + 3.1, z * 0.0015 - 1.7, 5) * 0.5 + 0.5;
      const ridge = s1.ridged(x * 0.0021, z * 0.0021, 4);
      const hm = Math.pow(Math.max(0, 0.86 * body + 0.14 * ridge), 1.35);
      h += m * (45 + hm * (170 + 260 * grand));
    }
    // distant southern ranges (horizon interest), kept away from the western sea
    if (z > 1150 && x > -900) {
      const ms = smoothstep(1300, 2600, z) * smoothstep(-900, -300, x);
      h += ms * (50 + Math.pow(s2.fbm(x * 0.0014 + 4.1, z * 0.0014, 5) * 0.5 + 0.5, 1.2) * 360);
    }

    // shrine hill: S-curve profile, flat summit, noisy flanks
    const ds = Math.hypot(x - SH.x, z - SH.z);
    if (ds < SH.footRadius) {
      const t = saturate((SH.footRadius - ds) / (SH.footRadius - SH.topRadius));
      const prof = t * t * (3 - 2 * t);
      const flank = s1.fbm(x * 0.021, z * 0.021, 3) * 3.2 * Math.sin(Math.PI * t);
      const hillY = this.shrineTopY + flank;
      h = h + (hillY - h) * prof;
      if (ds < SH.topRadius) h = this.shrineTopY + s2.noise(x * 0.05, z * 0.05) * 0.12;
    }

    // straight stair corridor on the NE flank, climbing SW to the summit
    if (!this._noStairs) {
      const bx = SH.stairsBase.x, bz = SH.stairsBase.z;
      const ux = SH.stairDir.x, uz = SH.stairDir.z;
      const px = x - bx, pz = z - bz;
      const L = Math.hypot(SH.stairsTop.x - bx, SH.stairsTop.z - bz);
      const s = px * ux + pz * uz;
      const lat = Math.abs(-px * uz + pz * ux);
      // flat under the stone steps and their curb walls (props/shrine.js), banks easing back to the hill flank
      // over 10 m (steep banks stretched the ground textures and stood bare against the sky in S2)
      const half = SH.stairHalf + 1.1, bank = 10;
      if (s > -8 && s < L + 6 && lat < half + bank) {
        const tt = clamp(s / L, 0, 1);
        const rampY = lerp(this.stairsBaseY, this.shrineTopY, tt);
        const wl = 1 - smoothstep(half, half + bank, lat);
        const ws = smoothstep(-8, 0, s) * (1 - smoothstep(L, L + 6, s));
        h = lerp(h, rampY, wl * ws);
      }
    }

    // western coast: beaches, and cliffs around the cliff point; sea beyond x ≈ -700
    if (x < -420) {
      const seaward = -700 - x + s2.fbm(z * 0.0042 + 9.1, x * 0.0042, 4) * 70;
      if (seaward > -140) {
        const dcl = Math.hypot(x - CL.x, z - CL.z);
        const cliffness = 1 - smoothstep(70, 280, dcl);
        // headland rising to a cliff top near the cliff point
        const land = 1 - smoothstep(-60, -4, seaward);
        h = lerp(h, Math.max(h, 34 + s1.fbm(x * 0.02, z * 0.02, 2) * 3), cliffness * land);
        const dropW = lerp(80, 9, cliffness);
        const k1 = smoothstep(-dropW, 0, seaward);
        const coastH = lerp(h, 1.0, k1);
        const k2 = smoothstep(0, lerp(110, 30, cliffness), seaward);
        h = lerp(coastH, -26, k2);
      }
    }

    // distant islands in the western sea (sunset silhouettes)
    if (x < -2000) {
      const i1 = Math.hypot(x + 3300, z - 1500), i2 = Math.hypot(x + 2800, z + 1300), i3 = Math.hypot(x + 5200, z - 300);
      const isl = (d, r, hgt) => (d < r ? (1 - smoothstep(0, r, d)) ** 1.5 * hgt : 0);
      const add = isl(i1, 700, 190) + isl(i2, 520, 120) + isl(i3, 1100, 340);
      if (add > 0) h = Math.max(h, -26 + add + s1.fbm(x * 0.003, z * 0.003, 4) * 30 * (add > 20 ? 1 : 0));
    }
    return h;
  }

  // Seaward signed distance (for coast shading); positive = sea side.
  seaward(x, z) {
    return -700 - x + this.s2.fbm(z * 0.0042 + 9.1, x * 0.0042, 4) * 70;
  }

  generate() {
    const N = GRID_N;
    const H = new Float32Array(N * N);
    for (let j = 0; j < N; j++) {
      const z = -WORLD.half + j * CELL;
      for (let i = 0; i < N; i++) {
        H[j * N + i] = this.height(-WORLD.half + i * CELL, z);
      }
    }
    this.H = H;
    this.pathD = this._pathDistance();
    this._smoothPaths();
    this._masks();
    return this;
  }

  // Worn tracks: blur the micro-relief out of path corridors and sink them slightly.
  _smoothPaths() {
    const N = GRID_N, H = this.H, D = this.pathD;
    const src = new Float32Array(H);
    const R = 3;
    for (let j = R; j < N - R; j++) {
      for (let i = R; i < N - R; i++) {
        const d = D[j * N + i];
        if (d > 2.4) continue;
        let acc = 0, w = 0;
        for (let b = -R; b <= R; b++) {
          for (let a = -R; a <= R; a++) {
            const ww = 1 / (1 + a * a + b * b);
            acc += src[(j + b) * N + (i + a)] * ww;
            w += ww;
          }
        }
        const k = 1 - smoothstep(1.0, 2.4, d);
        H[j * N + i] = src[j * N + i] + (acc / w - 0.14 - src[j * N + i]) * k;
      }
    }
  }

  _pathDistance() {
    const N = GRID_N;
    const pathD = new Float32Array(N * N).fill(1e9);
    const raster = (pts, halfW) => {
      const pad = halfW + 5;
      for (let k = 0; k < pts.length - 1; k++) {
        const a = pts[k], b = pts[k + 1];
        const minx = Math.min(a.x, b.x) - pad, maxx = Math.max(a.x, b.x) + pad;
        const minz = Math.min(a.z, b.z) - pad, maxz = Math.max(a.z, b.z) + pad;
        const i0 = Math.max(0, Math.floor((minx + WORLD.half) / CELL)), i1 = Math.min(N - 1, Math.ceil((maxx + WORLD.half) / CELL));
        const j0 = Math.max(0, Math.floor((minz + WORLD.half) / CELL)), j1 = Math.min(N - 1, Math.ceil((maxz + WORLD.half) / CELL));
        const abx = b.x - a.x, abz = b.z - a.z, l2 = abx * abx + abz * abz || 1;
        for (let j = j0; j <= j1; j++) {
          const z = -WORLD.half + j * CELL;
          for (let i = i0; i <= i1; i++) {
            const x = -WORLD.half + i * CELL;
            const t = saturate(((x - a.x) * abx + (z - a.z) * abz) / l2);
            const d = Math.hypot(x - (a.x + abx * t), z - (a.z + abz * t)) / halfW;
            const idx = j * N + i;
            if (d < pathD[idx]) pathD[idx] = d;
          }
        }
      }
    };
    PATHS.forEach((pts, k) => raster(pts, PATH_INFO[k].width * 0.5));
    // stair corridor counts as path (stone steps are placed there)
    raster([SH.stairsBase, SH.stairsTop], SH.stairWidth * 0.5 + 0.8);
    return pathD;
  }

  // Grid queries
  hAt(i, j) {
    const N = GRID_N;
    i = i < 0 ? 0 : i >= N ? N - 1 : i;
    j = j < 0 ? 0 : j >= N ? N - 1 : j;
    return this.H[j * N + i];
  }

  // Height with the same triangulation as the terrain mesh (diagonal v01–v10).
  heightAt(x, z) {
    const fx = (x + WORLD.half) / CELL, fz = (z + WORLD.half) / CELL;
    if (fx < 0 || fz < 0 || fx >= GRID_N - 1 || fz >= GRID_N - 1) return this.height(x, z);
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const N = GRID_N, H = this.H;
    const h00 = H[j * N + i], h10 = H[j * N + i + 1], h01 = H[(j + 1) * N + i], h11 = H[(j + 1) * N + i + 1];
    if (tx + tz <= 1) return h00 + (h10 - h00) * tx + (h01 - h00) * tz;
    return h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
  }

  // Grid-only height (coordinates clamped to the playable square) — cheap, used by the bakers.
  heightAtGrid(x, z) {
    const lim = WORLD.half - 0.01;
    return this.heightAt(x < -lim ? -lim : x > lim ? lim : x, z < -lim ? -lim : z > lim ? lim : z);
  }

  normalAt(x, z, out) {
    const e = CELL;
    const hl = this.heightAt(x - e, z), hr = this.heightAt(x + e, z);
    const hd = this.heightAt(x, z - e), hu = this.heightAt(x, z + e);
    let nx = hl - hr, ny = 2 * e, nz = hd - hu;
    const l = Math.hypot(nx, ny, nz);
    nx /= l;
    ny /= l;
    nz /= l;
    if (out) {
      out.x = nx;
      out.y = ny;
      out.z = nz;
      return out;
    }
    return { x: nx, y: ny, z: nz };
  }

  // Masks: mask RGBA  (R grass density, G pampas, B flowers, A path)
  //        surf RGBA  (R rock, G forest, B sand, A shore wetness)
  _masks() {
    const N = GRID_N, H = this.H;
    const mask = new Uint8Array(N * N * 4);
    const surf = new Uint8Array(N * N * 4);
    const pathD = this.pathD;
    const stairL = Math.hypot(SH.stairsTop.x - SH.stairsBase.x, SH.stairsTop.z - SH.stairsBase.z);

    const s1 = this.s1, s2 = this.s2, s3 = this.s3;
    for (let j = 0; j < N; j++) {
      const z = -WORLD.half + j * CELL;
      for (let i = 0; i < N; i++) {
        const x = -WORLD.half + i * CELL;
        const idx = j * N + i;
        const h = H[idx];
        // slope from central differences
        const hl = H[j * N + Math.max(0, i - 1)], hr = H[j * N + Math.min(N - 1, i + 1)];
        const hd = H[Math.max(0, j - 1) * N + i], hu = H[Math.min(N - 1, j + 1) * N + i];
        const gx = (hr - hl) / (2 * CELL), gz = (hu - hd) / (2 * CELL);
        const ny = 1 / Math.sqrt(1 + gx * gx + gz * gz);

        const n1 = s1.noise(x * 0.004 + 11.1, z * 0.004 - 3.2);
        const n2 = s2.noise(x * 0.011 - 7.3, z * 0.011 + 2.9);
        const n3 = s3.noise(x * 0.03 + 1.9, z * 0.03 + 8.8);

        // rock only on genuine cliffs; the island's mountains are wooded to their tops
        let rock = smoothstep(0.68, 0.52, ny + n3 * 0.04);
        const pd = pathD[idx];
        const path = 1 - smoothstep(0.75, 1.25, pd + n3 * 0.12);
        const seaward = x < -420 ? this.seaward(x, z) : -1e3;
        const sand = x < -420 ? smoothstep(3.2, 1.4, h) * smoothstep(-70, -20, seaward) * (1 - rock) : 0;
        const wet = x < -420 ? smoothstep(1.2, 0.2, h) : 0;
        const underwater = h < 0.4 ? 1 : 0;

        // forest: shrine hill flanks, belts around the basin, ginkgo grove, mountain slopes
        const df = Math.hypot(x - F.x, z - F.z);
        const inField = 1 - smoothstep(F.r * 0.62, F.r * 0.98, df);
        const ds = Math.hypot(x - SH.x, z - SH.z);
        const shrineFlank = smoothstep(SH.topRadius + 3, SH.topRadius + 12, ds) * (1 - smoothstep(SH.footRadius - 20, SH.footRadius + 25, ds));
        const dg = Math.hypot(x - POI.ginkgo.x, z - POI.ginkgo.z);
        const grove = 1 - smoothstep(POI.ginkgo.r * 0.5, POI.ginkgo.r * 1.1, dg);
        const dc = Math.hypot(x - C.x, z - C.z);
        const campClear = smoothstep(C.r * 0.7, C.r * 1.15, dc);
        let forest = smoothstep(0.05, 0.4, n1 + n2 * 0.25) * (1 - inField);
        // wooded slopes outside the open field (rim hills, ridges)
        const slopeWood = smoothstep(0.985, 0.93, ny) * smoothstep(0.78, 0.86, ny) * (1 - inField);
        forest = Math.max(forest, slopeWood * smoothstep(-0.45, 0.1, n2));
        forest = Math.max(forest, smoothstep(30, 60, h) * (1 - inField) * smoothstep(-0.2, 0.3, n1 + 0.2));
        forest = Math.max(forest, smoothstep(70, 140, h) * (1 - inField));
        // forested hills ring the open meadows (grass in the valleys, woods on the rises)
        const outside = smoothstep(F.r * 1.0, F.r * 1.55, df);
        forest = Math.max(forest, outside * smoothstep(-0.35, 0.15, n2 + n1 * 0.4));
        forest = Math.max(forest, shrineFlank * smoothstep(-0.5, 0.2, n2 + 0.3));
        forest = Math.max(forest, grove);
        const cliffClear = smoothstep(55, 110, Math.hypot(x - CL.x, z - CL.z));
        forest *= campClear * cliffClear * (1 - path) * (1 - sand) * (1 - underwater);
        forest *= 1 - smoothstep(0.55, 0.9, rock);
        forest = saturate(forest);

        // grass density
        let grass = (1 - rock * 0.95) * (1 - path) * (1 - sand) * (1 - underwater);
        grass *= 1 - forest * 0.55;
        grass *= smoothstep(0.62, 0.8, ny);
        grass = saturate(grass);

        // susuki pampas: dominant in the field basin, patchy elsewhere
        const np = s2.noise(x * 0.0085 + 2.2, z * 0.0085 - 4.4) * 0.7 + s3.noise(x * 0.03, z * 0.03) * 0.3;
        let pampas = smoothstep(-0.35, 0.15, np + inField * 0.6) * (0.45 + 0.55 * inField);
        pampas *= grass * (1 - forest * 0.8);
        // keep a tidy verge along paths
        pampas *= smoothstep(1.2, 2.6, pd);
        // red spider lilies: clusters + ribbons following path edges
        const nl = s3.noise(x * 0.021 + 5.5, z * 0.021 + 1.1);
        const ribbon = smoothstep(1.35, 1.8, pd) * (1 - smoothstep(2.2, 4.0, pd)) * smoothstep(-0.1, 0.35, n2);
        // (the open susuki basin stays gold/silver; lilies gather at its edges and paths)
        let flowers = Math.max(smoothstep(0.52, 0.72, nl) * smoothstep(-0.2, 0.3, n1 + 0.2) * (1 - inField * 0.75), ribbon);
        flowers *= grass * (1 - pampas * 0.8);

        // shrine stairs: no blades through the stone steps; along the flights the banks keep a dark forest
        // floor, without susuki plumes against the sky and with few lilies (the forest mask is left alone: the
        // tree placement reads it)
        const sx = x - SH.stairsBase.x, sz = z - SH.stairsBase.z;
        const ss = sx * SH.stairDir.x + sz * SH.stairDir.z;
        if (ss > -14 && ss < stairL + 14) {
          const sl = Math.abs(-sx * SH.stairDir.z + sz * SH.stairDir.x);
          if (sl < 30) {
            const along = smoothstep(-14, -4, ss) * (1 - smoothstep(stairL + 4, stairL + 14, ss));
            const onSteps = (1 - smoothstep(SH.stairHalf + 0.7, SH.stairHalf + 1.5, sl)) * along;
            const banks = (1 - smoothstep(16, 30, sl)) * along;
            grass *= (1 - onSteps) * (1 - 0.35 * banks);
            pampas *= (1 - onSteps) * (1 - banks);
            flowers *= (1 - onSteps) * (1 - 0.8 * banks);
          }
        }

        const o = idx * 4;
        mask[o] = Math.round(grass * 255);
        mask[o + 1] = Math.round(saturate(pampas) * 255);
        mask[o + 2] = Math.round(saturate(flowers) * 255);
        mask[o + 3] = Math.round(path * 255);
        surf[o] = Math.round(rock * 255);
        surf[o + 1] = Math.round(forest * 255);
        surf[o + 2] = Math.round(sand * 255);
        surf[o + 3] = Math.round(wet * 255);
      }
    }
    this.mask = mask;
    this.surf = surf;
  }

  // Bilinear sample of a mask channel set at world (x, z), values 0..1.
  surfaceAt(x, z) {
    const N = GRID_N;
    const fx = clamp((x + WORLD.half) / CELL, 0, N - 1.001), fz = clamp((z + WORLD.half) / CELL, 0, N - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const m = this.mask, s = this.surf;
    const o00 = (j * N + i) * 4, o10 = o00 + 4, o01 = o00 + N * 4, o11 = o01 + 4;
    const b = (arr, c) => {
      const a = arr[o00 + c] + (arr[o10 + c] - arr[o00 + c]) * tx;
      const d = arr[o01 + c] + (arr[o11 + c] - arr[o01 + c]) * tx;
      return (a + (d - a) * tz) / 255;
    };
    return {
      grass: b(m, 0),
      pampas: b(m, 1),
      flowers: b(m, 2),
      path: b(m, 3),
      rock: b(s, 0),
      forest: b(s, 1),
      sand: b(s, 2),
      wet: b(s, 3),
    };
  }

  // Baked lighting at LIGHT_N² over the world: R = soft sun visibility (heightfield shadows, long
  // golden-hour shadows of hills and mountains far beyond the shadow-map range), G = horizon AO.
  bakeLighting(sunDir, res = 512) {
    const out = new Uint8Array(res * res * 4);
    const cellL = WORLD.size / res;
    const elev = Math.asin(clamp(sunDir.y, -1, 1));
    const tanE = Math.tan(Math.max(elev, 0.005));
    const hx = sunDir.x, hz = sunDir.z;
    const hl = Math.hypot(hx, hz) || 1;
    const dx = hx / hl, dz = hz / hl;
    const aoDirs = [];
    for (let a = 0; a < 8; a++) aoDirs.push([Math.cos((a / 8) * Math.PI * 2), Math.sin((a / 8) * Math.PI * 2)]);
    const aoSteps = [10, 22, 45, 90, 180];
    const needAO = !this._ao;
    const ao = needAO ? new Uint8Array(res * res) : this._ao;
    for (let j = 0; j < res; j++) {
      const z = -WORLD.half + (j + 0.5) * cellL;
      for (let i = 0; i < res; i++) {
        const x = -WORLD.half + (i + 0.5) * cellL;
        const h0 = this.heightAtGrid(x, z) + 0.6;
        // soft shadow march toward the sun
        let vis = 1;
        if (elev <= 0) vis = 0;
        else {
          let t = 3, minR = 1e9;
          for (let s = 0; s < 64 && t < 3200; s++) {
            const px = x + dx * t, pz = z + dz * t;
            const th = this.heightAtGrid(px, pz);
            const ray = h0 + t * tanE;
            const r = (ray - th) / (t * 0.035 + 0.6);
            if (r < minR) minR = r;
            if (minR < -1.5) break;
            t *= 1.075;
            t += 1.5;
          }
          vis = saturate(0.5 + minR * 0.5);
          vis = vis * vis * (3 - 2 * vis);
        }
        const o = (j * res + i) * 4;
        out[o] = Math.round(vis * 255);
        if (needAO) {
          let occ = 0;
          for (const [ax, az] of aoDirs) {
            let maxS = 0;
            for (const st of aoSteps) {
              const th = this.heightAtGrid(x + ax * st, z + az * st);
              const sl = (th - h0 + 0.6) / st;
              if (sl > maxS) maxS = sl;
            }
            occ += maxS / Math.sqrt(1 + maxS * maxS);
          }
          ao[j * res + i] = Math.round(saturate(1 - (occ / aoDirs.length) * 1.1) * 255);
        }
        out[o + 1] = ao[j * res + i];
        out[o + 2] = 0;
        out[o + 3] = 255;
      }
    }
    this._ao = ao;
    return { data: out, res };
  }
}
