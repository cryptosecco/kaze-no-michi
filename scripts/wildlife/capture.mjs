#!/usr/bin/env node
// Frame sequences of the birds (contact sheets you look at): the game boots in play (?nointro&nohud&no=ui,audio), the
// loop is frozen and the wildlife simulation stepped by hand (game.modules.wildlife.debug), the camera placed here.
// Every screenshot follows the shots harness pattern: state set → 2 frozen frames → screenshot.
//   node scripts/wildlife/capture.mjs [--only crowland,shadow,torii,crowground,sparrows,turn,kite,play,lineup,foxtrot,
//   deergait,foxpounce,foxflee,deer,perf] [--out out/shots/wildlife]
//   [--width 1600 --height 900] [--quality high] [--params grass=none]
// The mammals: lineup (the fox, a hind, a calf and a stag beside the samurai), foxtrot (12 frames over one trotting
// stride, side-on, then its gallop), deergait (walk, trot, gallop, bounds, stott), foxpounce (the mousing leap),
// foxflee (alert, the bolt, the look back, off at a trot), deer (grazing at a sunlit forest edge, the alert, the alarm,
// the flight with the rumps flared, from behind).
// Writes <out>/<scenario>.png (sheet of full frames, time-stamped) and <out>/<scenario>_zoom.png (crops around the
// subject), the frames in <out>/frames/, and <out>/report.json (console errors, timings, the CPU cost in play).
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const ALL = ['crowland', 'shadow', 'torii', 'crowground', 'sparrows', 'turn', 'kite', 'play', 'lineup', 'foxtrot', 'deergait', 'foxpounce', 'foxflee', 'deer', 'perf'];
const only = String(arg('only', ALL.join(','))).split(',').filter(Boolean);
const outDir = path.resolve(root, String(arg('out', 'out/shots/wildlife')));
const W = Number(arg('width', 1600)), H = Number(arg('height', 900));
const quality = String(arg('quality', 'high'));
// extra URL parameters, e.g. --params grass=none (the grass hidden: the animals' legs and feet in plain view)
const extra = arg('params', '');
fs.mkdirSync(path.join(outDir, 'frames'), { recursive: true });

const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-gpu-vsync', '--disable-frame-rate-limit'],
});
const report = { url, quality, width: W, height: H, errors: [], scenarios: {} };
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('console', (m) => m.type() === 'error' && report.errors.push(m.text()));
page.on('pageerror', (e) => report.errors.push(String(e)));

async function boot() {
  await page.goto(`${url}?nointro&nohud&no=ui,audio&quality=${quality}${extra ? '&' + extra : ''}`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => window.kaze && window.kaze.ready, null, { timeout: 240000, polling: 250 });
  await page.evaluate(() => window.kaze.waitFrames(30));
}

// freeze the game, take the wildlife and the camera into our hands
async function stage() {
  await page.evaluate(() => {
    const g = window.kaze.game, D = g.modules.wildlife.debug;
    g.loop.paused = true;
    D.manual(true);
    D.auto(false);
    D.clear();
    D.show(true);
    g.cameraController = null;
    if (g.freeCam) g.freeCam.enabled = false;
    if (D.calm) D.calm(false);
    window.__wl = {
      cam(p, t, fov = 50) {
        const c = g.camera;
        c.fov = fov;
        c.updateProjectionMatrix();
        c.position.set(p[0], p[1], p[2]);
        c.lookAt(t[0], t[1], t[2]);
        c.updateMatrixWorld();
      },
      // screen position of a world point (px), and whether it is in front of the camera
      project(x, y, z) {
        const v = new g.camera.position.constructor(x, y, z).project(g.camera);
        return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight, front: v.z < 1 };
      },
    };
  });
}

async function snap(name, clipAt = null, zoom = 300) {
  await page.evaluate(() => window.kaze.waitFrames(2));
  const file = path.join(outDir, 'frames', name + '.png');
  await page.screenshot({ path: file });
  let crop = null;
  if (clipAt) {
    const w = zoom * 16 / 9, h = zoom;
    const x = Math.max(0, Math.min(W - w, clipAt.x - w / 2)), y = Math.max(0, Math.min(H - h, clipAt.y - h / 2));
    crop = path.join(outDir, 'frames', name + '_zoom.png');
    await page.screenshot({ path: crop, clip: { x, y, width: w, height: h } });
  }
  return { file, crop };
}

async function sheet(name, frames, key = 'file', cols = 3) {
  const b64 = (p) => `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;
  const tw = 640, th = 360, rows = Math.ceil(frames.length / cols);
  const s = await browser.newPage({ viewport: { width: cols * tw, height: rows * th } });
  await s.setContent(
    `<html><body style="margin:0;background:#000;display:flex;flex-wrap:wrap;width:${cols * tw}px">` +
      frames.map((f) => `<div style="position:relative;width:${tw}px;height:${th}px"><img src="${b64(f[key])}" style="width:${tw}px;height:${th}px"><span style="position:absolute;left:8px;top:6px;font:bold 20px sans-serif;color:#fff;text-shadow:0 0 4px #000">${f.label}</span></div>`).join('') +
      '</body></html>'
  );
  await s.waitForTimeout(150);
  const out = path.join(outDir, `${name}.png`);
  await s.screenshot({ path: out });
  await s.close();
  return path.relative(root, out);
}

// |a − b| × gain as a PNG: what a change does to the frame, made visible
async function diff(a, b, out, gain = 6) {
  const b64 = (p) => `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;
  const s = await browser.newPage();
  const url = await s.evaluate(
    async ({ a, b, gain }) => {
      const load = (src) => new Promise((res) => {
        const i = new Image();
        i.onload = () => res(i);
        i.src = src;
      });
      const [A, B] = await Promise.all([load(a), load(b)]);
      const c = document.createElement('canvas');
      c.width = A.width;
      c.height = A.height;
      const x = c.getContext('2d');
      x.drawImage(A, 0, 0);
      const da = x.getImageData(0, 0, c.width, c.height);
      x.drawImage(B, 0, 0);
      const db = x.getImageData(0, 0, c.width, c.height);
      for (let i = 0; i < da.data.length; i += 4) for (let k = 0; k < 3; k++) da.data[i + k] = Math.min(255, Math.abs(da.data[i + k] - db.data[i + k]) * gain);
      x.putImageData(da, 0, 0);
      return c.toDataURL('image/png');
    },
    { a: b64(a), b: b64(b), gain }
  );
  await s.close();
  fs.writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
  return out;
}

const ev = (fn, a) => page.evaluate(fn, a);

// ---- mammal helpers ---------------------------------------------------------------------------------------------
// a straight stretch of the spawn → shrine path (no grass on it: the feet in view), its direction
const PATH_RUN = { x: -40, z: 23.5, dx: -46 / 58.4, dz: 36 / 58.4 };

// put one animal of `name` (role) on the path, calm, heading along it; returns its index in the mammal list
async function placeOnPath(name, role = null, along = 0) {
  return ev(({ name, role, along, P }) => {
    const g = window.kaze.game, D = g.modules.wildlife.debug;
    D.calm(true);
    const x = P.x + P.dx * along, z = P.z + P.dz * along;
    D.spawnHerd(name, x, z, 1, 0, [{ x, z, yaw: Math.atan2(P.dx, P.dz) }], role ? [role] : null);
    g.player.place(x - P.dx * 60 + P.dz * 30, z - P.dz * 60 - P.dx * 30, 0);
    const ms = D.sim.mammals;
    return ms.length - 1;
  }, { name, role, along, P: PATH_RUN });
}

// A side-on strip of an animal running along the path at given speeds: for each phase, settle into the gait, then
// `frames` frames spread evenly over exactly one stride (stepping the simulation by T/frames between them), the camera
// tracking it from the side at its height
async function gaitStrip(name, phases, { role = null, dist = null, fov = 30 } = {}) {
  const i = await placeOnPath(name, role);
  const frames = [];
  const stats = [];
  let n = 0;
  for (const ph of phases) {
    // run up to speed in the gait (the goal far ahead along the path)
    await ev(({ i, v, P, mode, pose }) => {
      const D = window.kaze.game.modules.wildlife.debug, m = D.sim.mammals[i];
      D.drive(i, { v, mode, pose, goal: { x: m.x + P.dx * 400, z: m.z + P.dz * 400 } });
      D.step(1 / 60, 150);
    }, { i, v: ph.v, P: PATH_RUN, mode: ph.mode, pose: ph.pose || null });
    const info = await ev(({ i }) => {
      const D = window.kaze.game.modules.wildlife.debug, m = D.sim.mammals[i], L = m.loco;
      return { f: L.g.freq, gait: L.g.name, duty: L.g.duty, stride: L.g.stride, v: L.v, scale: m.scale };
    }, { i });
    stats.push(info);
    const T = 1 / Math.max(0.2, info.f);
    const sub = Math.max(1, Math.ceil((T / ph.frames) * 240));
    for (let k = 0; k < ph.frames; k++) {
      const st = await ev(({ i, dt, sub }) => {
        const D = window.kaze.game.modules.wildlife.debug, m = D.sim.mammals[i];
        D.step(dt, sub);
        const L = m.loco;
        return { x: m.x, y: L.gy, z: m.z, yaw: L.yaw, phase: L.phase, legs: L.legs.map((g) => g.st), body: L.bodyY };
      }, { i, dt: T / ph.frames / sub, sub });
      const d = dist || (name === 'fox' ? 2.8 : 5.2) * info.scale;
      const nx = Math.cos(st.yaw), nz = -Math.sin(st.yaw); // the animal's left
      // level with the body, wherever it is (a stott's apex included)
      const h = st.body * (name === 'fox' ? 0.85 : 0.9);
      await ev(({ st, nx, nz, d, h, fov }) => window.__wl.cam([st.x + nx * d, st.y + h + 0.05, st.z + nz * d], [st.x, st.y + h, st.z], fov), { st, nx, nz, d, h, fov });
      const at = await ev(({ st, h }) => window.__wl.project(st.x, st.y + h, st.z), { st, h });
      const feet = st.legs.map((g, l) => (g ? '·' : ['LF', 'RF', 'LH', 'RH'][l])).filter((x) => x !== '·').join('+') || 'flight';
      frames.push({ ...(await snap(`${name}gait_${String(n++).padStart(2, '0')}`, at, 300)), label: `${ph.label} ${(k / ph.frames).toFixed(2)} · ${feet}` });
    }
  }
  const tag = name + 'gait';
  return { sheet: await sheet(tag, frames), zoom: await sheet(tag + '_zoom', frames, 'crop'), stats };
}

// ------------------------------------------------------------------------------------------------ scenarios
const scenarios = {
  // a crow flying in to a treetop: the approach, the flare, the braking strokes, the touch-down and the wings folding
  async crowland() {
    const setup = await ev(() => {
      const D = window.kaze.game.modules.wildlife.debug, g = window.kaze.game;
      const list = D.trees(0, 0, 160, (c) => !c.shrub && c.top - c.y > 8 && c.top - c.y < 24 && c.kind !== 'bamboo');
      for (const t of list) {
        const tops = D.perches(t.i, ['top']);
        if (!tops.length) continue;
        const top = tops[0];
        // fly in from ~45 m away (it turns into the wind for the approach)
        D.spawnFlying('crow', 1, top.x - 35, top.y + 8, top.z - 25, 9, 6);
        const p = D.sim.flocks[D.sim.flocks.length - 1].members[0];
        const perch = D.island.treePerches(D.island.crown(t.i), ['top'])[0];
        if (!p.setDest(perch)) {
          D.clear();
          continue;
        }
        // a camera beside the approach line, level with the top, in the open
        const pl = p.plan;
        for (const side of [1, -1]) {
          const px = -pl.dz * side, pz = pl.dx * side;
          const cp = [top.x + px * 11 - pl.dx * 2.5, top.y + 0.4, top.z + pz * 11 - pl.dz * 2.5];
          if (D.island.obstacleTop(cp[0], cp[2]) < cp[1] - 1 && g.groundAt(cp[0], cp[2]) < cp[1] - 1.5) return { top, cp, look: [top.x - pl.dx * 2.5, top.y + 0.5, top.z - pl.dz * 2.5] };
        }
        D.clear();
      }
      return null;
    });
    if (!setup) return { error: 'no tree' };
    const { top, cp, look } = setup;
    await ev(({ cp, look }) => window.__wl.cam(cp, look, 38), { cp, look });
    const frames = [];
    let t = 0, n = 0, landed = -1, finalAt = -1;
    for (let i = 0; i < 60 * 60 && frames.length < 30; i++) {
      const st = await ev(() => {
        const D = window.kaze.game.modules.wildlife.debug;
        D.step(1 / 60, 1);
        return D.birds()[0];
      });
      t += 1 / 60;
      const d = Math.hypot(st.x - top.x, st.y - top.y, st.z - top.z);
      if (st.mode === 'perch' && landed < 0) landed = t;
      if (st.stage === 'final' && d < 7 && finalAt < 0) finalAt = i;
      const after = landed >= 0 ? t - landed : -1;
      const capture = (landed < 0 && finalAt >= 0 && (i - finalAt) % 6 === 0) || (landed >= 0 && [0, 0.15, 0.3, 0.5, 0.8, 1.4].some((a) => Math.abs(after - a) < 1 / 120));
      if (capture) {
        // the camera pans with the bird, a long lens (wildlife footage), the perch in the lower part of the frame
        await ev(({ cp, st, top }) => window.__wl.cam(cp, [st.x * 0.7 + top.x * 0.3, st.y * 0.7 + top.y * 0.3, st.z * 0.7 + top.z * 0.3], 20), { cp, st, top });
        const at = await ev(({ x, y, z }) => window.__wl.project(x, y, z), st);
        const f = await snap(`crowland_${String(n).padStart(2, '0')}`, at, 420);
        frames.push({ ...f, label: `${landed < 0 ? (d).toFixed(1) + ' m out' : 'landed +' + after.toFixed(2) + ' s'} · ${st.mode}${st.stage ? ':' + st.stage : ''} · pitch ${(st.pitch * 57.3).toFixed(0)}° · ${Math.hypot(st.vx, st.vy, st.vz).toFixed(1)} m/s` });
        n++;
      }
      if (after > 1.45) break;
    }
    // the approach thinned to every other frame, every frame of the flare and the landing
    const pick = frames.filter((f, k) => k >= frames.length - 12 || k % 2 === 0).slice(-15);
    return { sheet: await sheet('crowland', pick), zoom: await sheet('crowland_zoom', pick, 'crop'), frames: frames.length, landedAt: landed };
  },

  // the birds' shadows: the same frame with and without shadow casting, the sun from the side
  async shadow() {
    const setup = await ev(() => {
      const g = window.kaze.game, D = g.modules.wildlife.debug;
      for (const [x, z] of [[-30, 18], [40, -6], [-60, 40]]) {
        const f = D.spawnGround('crow', x, z, 3, 10);
        if (f) {
          f.restT = 1e9;
          D.step(1 / 60, 30);
          const m = f.members;
          const c = m.reduce((a, b) => ({ x: a.x + b.fx / m.length, y: a.y + b.fy / m.length, z: a.z + b.fz / m.length }), { x: 0, y: 0, z: 0 });
          const s = g.lighting.sunDir;
          // from above and across the sun: the long shadows fall sideways over the open path
          const h = Math.hypot(s.x, s.z), px = -s.z / h, pz = s.x / h;
          g.player.place(c.x + 40, c.z + 40, 0);
          return { c, cp: [c.x + px * 2.5, c.y + 4.5, c.z + pz * 2.5] };
        }
      }
      return null;
    });
    if (!setup) return { error: 'no ground' };
    const frames = [];
    // BirdMesh.shadows: every sync (each frame) sets castShadow from it and from the camera's distance. The golden-
    // hour sun grazes the ground, so a shadow is faint: the third column is the difference between the two, ×6.
    const pair = async (name, label, place) => {
      const shots = [];
      for (const on of [true, false]) {
        await ev(({ on, setup, place }) => {
          const W = window.kaze.game.modules.wildlife;
          for (const k in W.meshes) W.meshes[k].shadows = on;
          W.debug.sim.flocks[0].members[0].scale = place.scale;
          window.__wl.cam(place.cp, [setup.c.x, setup.c.y, setup.c.z], place.fov);
          W.debug.sync();
        }, { on, setup, place });
        shots.push({ ...(await snap(`${name}_${on ? 'on' : 'off'}`)), label: `${label}, shadows ${on ? 'on' : 'off'}` });
      }
      shots.push({ file: await diff(shots[0].file, shots[1].file, path.join(outDir, 'frames', `${name}_diff.png`)), label: `${label}: difference ×6` });
      frames.push(...shots);
    };
    await pair('shadow', 'three crows', { cp: setup.cp, fov: 35, scale: 1 });
    // a giant crow (×12): the long shadow down the path
    const far = [setup.cp[0] + (setup.cp[0] - setup.c.x) * 6, setup.c.y + 14, setup.cp[2] + (setup.cp[2] - setup.c.z) * 6];
    await pair('shadow_big', 'giant crow', { cp: far, fov: 50, scale: 12 });
    await ev(() => {
      const W = window.kaze.game.modules.wildlife;
      for (const k in W.meshes) W.meshes[k].shadows = true;
      W.debug.sim.flocks[0].members[0].scale = 1;
    });
    return { sheet: await sheet('shadow', frames, 'file', 3) };
  },

  // two crows coming down onto the kasagi of the sky torii on the shrine summit
  async torii() {
    const setup = await ev(() => {
      const D = window.kaze.game.modules.wildlife.debug, g = window.kaze.game;
      const T = D.island.props[0];
      if (!T) return null;
      const ps = [T.perches[1], T.perches[3]];
      const f = D.spawnFlying('crow', 2, T.x - 30, T.perches[2].y + 6, T.z + 20, 8, -6);
      f.restT = 1e9;
      const ok = D.land(f, ps);
      const b = f.members[0];
      const pl = b.plan;
      // beside the beam, level with it, 14 m off
      const ax = ps[1].x - ps[0].x, az = ps[1].z - ps[0].z, al = Math.hypot(ax, az) || 1;
      const nx = -az / al, nz = ax / al;
      const mid = T.perches[2];
      const cp = [mid.x + nx * 14 + (ax / al) * 4, mid.y - 0.5, mid.z + nz * 14 + (az / al) * 4];
      return { ok, mid: { x: mid.x, y: mid.y, z: mid.z }, cp, beam: T.perches.map((p) => ({ x: p.x, y: p.y, z: p.z })) };
    });
    if (!setup || !setup.ok) return { error: 'no torii approach', setup };
    const { mid, cp } = setup;
    const frames = [];
    let n = 0, landed = -1, t = 0;
    for (let i = 0; i < 60 * 60 && frames.length < 16; i++) {
      const st = await ev(() => {
        const D = window.kaze.game.modules.wildlife.debug;
        D.step(1 / 60, 1);
        return D.birds();
      });
      t += 1 / 60;
      const flying = st.filter((b) => b.mode !== 'perch');
      if (!flying.length && landed < 0) landed = t;
      const c = st.reduce((a, b) => ({ x: a.x + b.x / st.length, y: a.y + b.y / st.length, z: a.z + b.z / st.length }), { x: 0, y: 0, z: 0 });
      const dmin = Math.min(...st.map((b) => (b.dest ? Math.hypot(b.x - b.dest.x, b.y - b.dest.y, b.z - b.dest.z) : 0)));
      const capture = (landed < 0 && st.some((b) => b.stage === 'final') && dmin < 6 && i % 10 === 0) || (landed >= 0 && [0.3, 1.5].some((a) => Math.abs(t - landed - a) < 1 / 120));
      if (capture) {
        await ev(({ cp, c, mid }) => window.__wl.cam(cp, [c.x * 0.5 + mid.x * 0.5, c.y * 0.5 + mid.y * 0.5 + 0.3, c.z * 0.5 + mid.z * 0.5], 16), { cp, c, mid });
        const at = await ev(({ x, y, z }) => window.__wl.project(x, y, z), c);
        frames.push({ ...(await snap(`torii_${String(n++).padStart(2, '0')}`, at, 420)), label: landed < 0 ? `${st.map((b) => b.stage).join(' / ')} · ${dmin.toFixed(1)} m` : `on the kasagi +${(t - landed).toFixed(1)} s` });
      }
      if (landed >= 0 && t - landed > 1.55) break;
    }
    return { sheet: await sheet('torii', frames), zoom: await sheet('torii_zoom', frames, 'crop'), landedAt: landed };
  },

  // crows on the ground: walking, pecking; the samurai walks up the path, they take off
  async crowground() {
    const setup = await ev(() => {
      const g = window.kaze.game, D = g.modules.wildlife.debug;
      for (const [x, z] of [[-30, 18], [-60, 40], [40, -6], [-90, 62], [70, -18]]) {
        const f = D.spawnGround('crow', x, z, 3, 10);
        if (f) {
          f.restT = 1e9; // no move of their own accord while staged: only the samurai sends them off
          const m = f.members.map((b) => ({ x: b.fx, y: b.fy, z: b.fz }));
          return { m, area: f.area };
        }
      }
      return null;
    });
    if (!setup) return { error: 'no ground' };
    const c = setup.m.reduce((a, b) => ({ x: a.x + b.x / setup.m.length, y: a.y + b.y / setup.m.length, z: a.z + b.z / setup.m.length }), { x: 0, y: 0, z: 0 });
    // along the path: the camera low on it, the samurai coming down it from the far side
    const tx = setup.area.tx ?? 1, tz = setup.area.tz ?? 0;
    const sx = c.x + tx * 24, sz = c.z + tz * 24;
    await ev(({ sx, sz, c }) => window.kaze.game.player.place(sx, sz, Math.atan2(c.x - sx, c.z - sz)), { sx, sz, c });
    const cp = await ev(({ c, tx, tz }) => {
      const g = window.kaze.game, x = c.x - tx * 7 - tz * 0.5, z = c.z - tz * 7 + tx * 0.5;
      return [x, g.groundAt(x, z) + 0.9, z];
    }, { c, tx, tz });
    await ev(({ cp, c }) => window.__wl.cam(cp, [c.x, c.y + 0.35, c.z], 30), { cp, c });
    const frames = [];
    let n = 0;
    const shot = async (label) => {
      const at = await ev(({ x, y, z }) => window.__wl.project(x, y + 0.3, z), c);
      frames.push({ ...(await snap(`crowground_${String(n++).padStart(2, '0')}`, at, 300)), label });
    };
    // their life on the ground: 6 frames over 6 s
    for (let k = 0; k < 6; k++) {
      await ev(() => window.kaze.game.modules.wildlife.debug.step(1 / 60, 60));
      await shot(`${k + 1} s · foraging`);
    }
    // the samurai walks toward them at 1.6 m/s
    let first = null;
    for (let i = 0; i < 60 * 20; i++) {
      const s = await ev(({ c }) => {
        const g = window.kaze.game, D = g.modules.wildlife.debug, p = g.player.position;
        const dx = c.x - p.x, dz = c.z - p.z, l = Math.hypot(dx, dz);
        if (l > 1) g.player.place(p.x + (dx / l) * 1.6 / 60, p.z + (dz / l) * 1.6 / 60, Math.atan2(dx, dz));
        D.step(1 / 60, 1);
        const birds = D.birds();
        return { d: l, modes: birds.map((b) => b.mode), stages: birds.map((b) => b.stage) };
      }, { c });
      if (!first && s.modes.some((m) => m !== 'perch')) first = { i, d: s.d };
      if (first && (i - first.i) % 6 === 0 && i - first.i <= 60) await shot(`take-off +${((i - first.i) / 60).toFixed(2)} s · samurai ${s.d.toFixed(1)} m`);
      if (first && i - first.i > 60) break;
    }
    return { sheet: await sheet('crowground', frames), zoom: await sheet('crowground_zoom', frames, 'crop'), flushDistance: first && first.d };
  },

  // a sparrow flock foraging on a path, flushed by the samurai: the burst, the flight into cover
  async sparrows() {
    const setup = await ev(() => {
      const g = window.kaze.game, D = g.modules.wildlife.debug;
      for (const [x, z] of [[-20, 12], [-45, 30], [30, -5], [-70, 48], [55, -12]]) {
        const f = D.spawnGround('sparrow', x, z, 16, 10);
        if (f) {
          f.restT = 1e9;
          return { m: f.members.map((b) => ({ x: b.fx, y: b.fy, z: b.fz })), area: f.area };
        }
      }
      return null;
    });
    if (!setup) return { error: 'no ground' };
    const m = setup.m;
    const c = m.reduce((a, b) => ({ x: a.x + b.x / m.length, y: a.y + b.y / m.length, z: a.z + b.z / m.length }), { x: 0, y: 0, z: 0 });
    // the camera low on the path, the samurai coming down it from the far side
    const tx = setup.area.tx ?? 1, tz = setup.area.tz ?? 0;
    const sx = c.x + tx * 15, sz = c.z + tz * 15;
    await ev(({ sx, sz, c }) => window.kaze.game.player.place(sx, sz, Math.atan2(c.x - sx, c.z - sz)), { sx, sz, c });
    const cp = await ev(({ c, tx, tz }) => {
      const g = window.kaze.game, x = c.x - tx * 4.8 - tz * 0.3, z = c.z - tz * 4.8 + tx * 0.3;
      return [x, g.groundAt(x, z) + 0.4, z];
    }, { c, tx, tz });
    await ev(({ cp, c }) => window.__wl.cam(cp, [c.x, c.y + 0.12, c.z], 26), { cp, c });
    const frames = [];
    let n = 0;
    const shot = async (label, at = c) => {
      const p = await ev(({ x, y, z }) => window.__wl.project(x, y + 0.1, z), at);
      frames.push({ ...(await snap(`sparrows_${String(n++).padStart(2, '0')}`, p, 220)), label });
    };
    for (let k = 0; k < 3; k++) {
      await ev(() => window.kaze.game.modules.wildlife.debug.step(1 / 60, 45));
      await shot(`${((k + 1) * 0.75).toFixed(2)} s · foraging`);
    }
    let first = null;
    for (let i = 0; i < 60 * 20; i++) {
      const s = await ev(({ c }) => {
        const g = window.kaze.game, D = g.modules.wildlife.debug, p = g.player.position;
        const dx = c.x - p.x, dz = c.z - p.z, l = Math.hypot(dx, dz);
        if (l > 1) g.player.place(p.x + (dx / l) * 1.6 / 60, p.z + (dz / l) * 1.6 / 60, Math.atan2(dx, dz));
        D.step(1 / 60, 1);
        const birds = D.birds();
        const fl = birds.filter((b) => b.mode !== 'perch');
        const mx = fl.length ? fl.reduce((a, b) => ({ x: a.x + b.x / fl.length, y: a.y + b.y / fl.length, z: a.z + b.z / fl.length }), { x: 0, y: 0, z: 0 }) : null;
        return { d: l, gone: fl.length, n: birds.length, mx };
      }, { c });
      if (!first && s.gone) {
        first = { i, d: s.d };
        await ev(() => (window.__wlT0 = window.kaze.game.modules.wildlife.debug.sim.time));
      }
      if (first && (i - first.i) % 4 === 0 && i - first.i <= 48) await shot(`flush +${((i - first.i) / 60).toFixed(2)} s · ${s.gone}/${s.n} up · samurai ${s.d.toFixed(1)} m`, s.mx || c);
      if (first && i - first.i > 48) break;
    }
    // where they went: into cover; seen from the samurai's side a few seconds later
    const late = [];
    for (const secs of [3, 6, 12]) {
      const where = await ev((secs) => {
        const D = window.kaze.game.modules.wildlife.debug;
        while (D.sim.time < secs + window.__wlT0) D.step(1 / 60, 30);
        const b = D.birds();
        return { modes: b.map((x) => x.mode + (x.perch ? ':' + x.perch : '')), c: b.reduce((a, q) => ({ x: a.x + q.x / b.length, y: a.y + q.y / b.length, z: a.z + q.z / b.length }), { x: 0, y: 0, z: 0 }) };
      }, secs);
      await ev(({ w, c }) => {
        const p = window.kaze.game.player.position;
        const dx = w.c.x - p.x, dz = w.c.z - p.z, l = Math.hypot(dx, dz) || 1;
        window.__wl.cam([w.c.x - (dx / l) * 6, w.c.y + 1, w.c.z - (dz / l) * 6], [w.c.x, w.c.y, w.c.z], 40);
      }, { w: where, c });
      const at = await ev(({ x, y, z }) => window.__wl.project(x, y, z), where.c);
      frames.push({ ...(await snap(`sparrows_${String(n++).padStart(2, '0')}`, at, 300)), label: `+${secs} s · ${where.modes.filter((m) => m !== 'fly').length}/${where.modes.length} settled (${[...new Set(where.modes)].join(', ')})` });
      late.push(where.modes);
    }
    return { sheet: await sheet('sparrows', frames), zoom: await sheet('sparrows_zoom', frames, 'crop'), flushDistance: first && first.d, after: late };
  },

  // a crow circling: the bank of a coordinated turn
  async turn() {
    const p0 = await ev(() => {
      const g = window.kaze.game, D = g.modules.wildlife.debug;
      const x = -40, z = 30, gy = g.groundAt(x, z);
      const f = D.spawnFlying('crow', 1, x + 16, gy + 14, z, 0, 11);
      f.circle = { x, z, r: 16, agl: 14, dir: 1 };
      f.members[0].stage = 'circle';
      D.step(1 / 60, 240);
      return { x, z, y: gy + 14 };
    });
    // camera outside the circle, a little below it, a long lens panning with the bird: the wings tilt toward the
    // centre of the turn
    const frames = [];
    for (let k = 0; k < 9; k++) {
      const b = await ev(() => {
        const D = window.kaze.game.modules.wildlife.debug;
        D.step(1 / 60, 9);
        return D.birds()[0];
      });
      await ev(({ p, b }) => window.__wl.cam([p.x + 26, p.y - 2.5, p.z + 6], [b.x, b.y, b.z], 9), { p: p0, b });
      const at = await ev(({ x, y, z }) => window.__wl.project(x, y, z), b);
      const cam = await ev(() => {
        const c = window.kaze.game.camera;
        return { fov: c.fov, x: c.position.x, y: c.position.y, z: c.position.z };
      });
      const dist = Math.hypot(b.x - cam.x, b.y - cam.y, b.z - cam.z);
      frames.push({ ...(await snap(`turn_${k}`, at, 220)), label: `bank ${(b.roll * 57.3).toFixed(0)}° · ${Math.hypot(b.vx, b.vz).toFixed(1)} m/s · pitch ${(b.pitch * 57.3).toFixed(0)}° · ${dist.toFixed(0)} m, fov ${cam.fov}` });
    }
    return { sheet: await sheet('turn', frames), zoom: await sheet('turn_zoom', frames, 'crop') };
  },

  // the kite soaring high over the field on fixed wings
  async kite() {
    const p0 = await ev(() => {
      const g = window.kaze.game, D = g.modules.wildlife.debug;
      const x = 20, z = -30, gy = g.groundAt(x, z);
      const f = D.sim.addFlock('kite', 1);
      const b = f.members[0];
      f.circle = { x, z, r: 32, agl: 40, dir: -1 };
      Object.assign(b, { mode: 'fly', stage: 'circle', x: x + 32, y: gy + 40, z, vx: 0, vy: 0, vz: -9.5, fold: 0, legs: 0, flapOn: false });
      f.state = 'moving';
      D.step(1 / 60, 300);
      return { x, z, y: gy + 40, gy };
    });
    const frames = [];
    for (let k = 0; k < 6; k++) {
      const b = await ev(() => {
        const D = window.kaze.game.modules.wildlife.debug;
        D.step(1 / 60, 40);
        return D.birds()[0];
      });
      // from the field below, a long lens following it
      await ev(({ p, b }) => window.__wl.cam([p.x - 10, p.gy + 1.7, p.z + 60], [b.x, b.y, b.z], 5), { p: p0, b });
      const at = await ev(({ x, y, z }) => window.__wl.project(x, y, z), b);
      frames.push({ ...(await snap(`kite_${k}`, at, 180)), label: `kite · bank ${(b.roll * 57.3).toFixed(0)}° · ${(b.y - p0.gy).toFixed(0)} m up` });
    }
    return { sheet: await sheet('kite', frames), zoom: await sheet('kite_zoom', frames, 'crop') };
  },

  // the population in normal play, seen from the play camera: the auto spawn around the samurai
  async play() {
    await ev(() => {
      const g = window.kaze.game, D = g.modules.wildlife.debug;
      D.auto(true);
      D.clear();
      g.player.place(0, 0, Math.atan2(-260, 180));
      D.step(1 / 60, 60 * 20);
    });
    const frames = [];
    const views = await ev(() => {
      const D = window.kaze.game.modules.wildlife.debug;
      return D.sim.flocks.map((f) => {
        const b = f.members[0], a = f.area || {};
        return { sp: f.sp.name, x: b.x, y: b.y, z: b.z, n: f.members.length, mode: b.mode + (b.perch ? ':' + b.perch.kind : ''), tx: a.tx, tz: a.tz };
      });
    });
    let k = 0;
    for (const v of views.slice(0, 6)) {
      const dist = v.sp === 'sparrow' ? 6 : v.sp === 'kite' ? 70 : 14;
      await ev(({ v, dist }) => {
        const g = window.kaze.game;
        if (v.mode === 'perch:ground' && v.tx !== undefined) {
          // a flock on the ground: from along the path it forages on and a little above it (the susuki beside the
          // path out of the way)
          const d = v.sp === 'sparrow' ? 4.5 : 9;
          const x = v.x - v.tx * d, z = v.z - v.tz * d;
          window.__wl.cam([x, g.groundAt(x, z) + (v.sp === 'sparrow' ? 1.4 : 2.6), z], [v.x, v.y + 0.15, v.z], 40);
          return;
        }
        const gy = g.groundAt(v.x + dist * 0.8, v.z + dist * 0.6);
        window.__wl.cam([v.x + dist * 0.8, Math.max(gy + 1.6, v.y - (v.sp === 'kite' ? 40 : 1)), v.z + dist * 0.6], [v.x, v.y + 0.2, v.z], v.sp === 'kite' ? 35 : 45);
      }, { v, dist });
      const at = await ev(({ x, y, z }) => window.__wl.project(x, y, z), v);
      frames.push({ ...(await snap(`play_${k++}`, at, 260)), label: `${v.sp} ×${v.n} · ${v.mode}` });
    }
    return { sheet: await sheet('play', frames), zoom: await sheet('play_zoom', frames, 'crop'), flocks: views };
  },

  // ---- the mammals ------------------------------------------------------------------------------------------------
  // the fox, a hind, a calf and a stag standing side-on on open ground, the samurai beside them for scale
  async lineup() {
    const setup = await ev(() => {
      const g = window.kaze.game, D = g.modules.wildlife.debug, I = D.island;
      D.calm(true);
      // a flat open spot by the path out of the spawn
      const sp = { name: 'deer', clearance: 0.35 };
      for (const [x, z] of [[-24, 30], [-60, 40], [20, -20], [-30, 0], [10, 10]]) {
        const ok = [0, 1.5, 3, 4.5, 6, 7.5].every((u) => I.walkable(x + u, z, sp) && I.walkable(x + u, z + 1.5, sp));
        if (!ok) continue;
        D.spawnHerd('fox', x, z, 1, 0, [{ x, z, yaw: Math.PI / 2 }]);
        D.spawnHerd('deer', x + 3, z, 3, 0, [{ x: x + 7.2, z, yaw: Math.PI / 2 }, { x: x + 3.2, z, yaw: Math.PI / 2 }, { x: x + 5.0, z: z + 0.2, yaw: Math.PI / 2 }], ['stag', 'hind', 'calf']);
        const ms = D.sim.mammals;
        ms.forEach((m, i) => {
          D.drive(i, { state: m.sp.name === 'fox' ? 'pause' : 'scan', dur: 1e9 });
          m.goal = null;
        });
        g.player.place(x - 1.6, z + 0.2, Math.PI / 2);
        return { x, z, y: g.groundAt(x + 3, z), roles: ms.map((m) => m.role) };
      }
      return null;
    });
    if (!setup) return { error: 'no flat spot' };
    const frames = [];
    const { x, y, z } = setup;
    // [name, camera, target, fov, crop centre]
    const views = [
      ['side', [x + 3, y + 0.9, z - 9.5], [x + 3, y + 0.6, z], 36, [x + 3, y + 0.5, z]],
      ['fox, side', [x, y + 0.35, z - 2.2], [x, y + 0.28, z], 30, [x, y + 0.28, z]],
      ['hind, side', [x + 3.2, y + 0.75, z - 3.6], [x + 3.2, y + 0.6, z], 32, [x + 3.2, y + 0.6, z]],
      ['stag, three-quarter', [x + 9.5, y + 1.0, z - 2.6], [x + 7.2, y + 0.85, z], 34, [x + 7.2, y + 0.85, z]],
      ['front', [x + 13, y + 0.9, z - 1.5], [x + 3, y + 0.6, z], 32, [x + 3, y + 0.5, z]],
      ['behind', [x - 5, y + 1.2, z + 4], [x + 3, y + 0.5, z], 40, [x + 3, y + 0.5, z]],
    ];
    for (const [name, cp, look, fov, c] of views) {
      await ev(() => window.kaze.game.modules.wildlife.debug.step(1 / 60, 30));
      await ev(({ cp, look, fov }) => window.__wl.cam(cp, look, fov), { cp, look, fov });
      const at = await ev(({ c }) => window.__wl.project(c[0], c[1], c[2]), { c });
      frames.push({ ...(await snap(`lineup_${name.replace(/[^a-z]+/g, '_')}`, at, 360)), label: `${name}` });
    }
    return { sheet: await sheet('lineup', frames, 'file', 2), zoom: await sheet('lineup_zoom', frames, 'crop', 2), setup };
  },

  // the fox trotting along the path, side-on, 12 frames over one stride (then 6 of its gallop)
  async foxtrot() {
    const run = await gaitStrip('fox', [{ v: 2.6, frames: 12, label: 'trot' }, { v: 9, frames: 6, label: 'gallop' }]);
    return run;
  },

  // the deer's gaits side-on: the walk over one stride (8), the trot (4), the gallop (6), the bounds (6) with the rump
  // flared, the stott (6)
  async deergait() {
    const flee = { flare: 1, tail: 0.95, earBack: 0.5, prick: 0.2, neck: 0.15 };
    return gaitStrip('deer', [
      { v: 1.1, frames: 8, label: 'walk' },
      { v: 3.2, frames: 4, label: 'trot' },
      { v: 11, frames: 6, label: 'gallop', pose: flee },
      { v: 10, frames: 6, label: 'bound', mode: 'bound', pose: flee },
      { v: 2.4, frames: 6, label: 'stott', mode: 'stott', pose: flee },
    ], { role: 'hind' });
  },

  // the mousing pounce: the fox listens with its head cocked, crouches, leaps high toward the north-north-east, comes
  // down fore feet first, nose into the grass
  async foxpounce() {
    const i = await placeOnPath('fox', null, 6);
    const p = await ev(({ i }) => {
      const D = window.kaze.game.modules.wildlife.debug, m = D.sim.mammals[i];
      D.step(1 / 60, 30);
      m.startMouse();
      m.dur = 1.6;
      // the vole ~1.5 m ahead in the pounce's direction
      return { x: m.x, y: m.loco.gy, z: m.z, prey: m.prey };
    }, { i });
    // the camera side-on to the leap, a little back
    const dx = p.prey.x - p.x, dz = p.prey.z - p.z, l = Math.hypot(dx, dz) || 1;
    const ux = dx / l, uz = dz / l;
    const mid = { x: p.x + ux * l * 0.5, z: p.z + uz * l * 0.5 };
    const cp = [mid.x - uz * 3.6, p.y + 0.55, mid.z + ux * 3.6];
    await ev(({ cp, mid, y }) => window.__wl.cam(cp, [mid.x, y + 0.4, mid.z], 32), { cp, mid, y: p.y });
    const frames = [];
    let n = 0, t = 0, last = -1;
    const times = [0.4, 1.2, 1.9];
    for (let k = 0; k < 60 * 7 && frames.length < 18; k++) {
      const st = await ev(({ i }) => {
        const D = window.kaze.game.modules.wildlife.debug, m = D.sim.mammals[i];
        D.step(1 / 60, 1);
        const L = m.loco;
        return { sub: m.sub, air: L.air ? L.air.t : null, T: L.air ? L.air.T : 0, y: L.gy + L.bodyY, gy: L.gy, pitch: L.pitch, x: m.x, z: m.z };
      }, { i });
      t += 1 / 60;
      let cap = false, label = st.sub;
      if (st.sub === 'listen' && times.some((a) => Math.abs(t - a) < 1 / 120)) cap = true;
      if (st.air !== null && st.air < 0 && (k - last) >= 12) (cap = true), (label = 'crouch');
      if (st.air !== null && st.air >= 0 && st.air < st.T && (k - last) >= 5) (cap = true), (label = `leap ${(st.air / st.T).toFixed(2)} · ${(st.y - st.gy).toFixed(2)} m`);
      if (st.sub === 'leap' && st.air !== null && st.air >= st.T && (k - last) >= 5) (cap = true), (label = `landing +${(st.air - st.T).toFixed(2)} s`);
      if (st.sub === 'pinned' && (k - last) >= 25) (cap = true), (label = 'nose in the grass');
      if (!cap) continue;
      last = k;
      const at = await ev(({ mid, y }) => window.__wl.project(mid.x, y + 0.4, mid.z), { mid, y: p.y });
      frames.push({ ...(await snap(`foxpounce_${String(n++).padStart(2, '0')}`, at, 330)), label: `${label} · pitch ${(st.pitch * 57.3).toFixed(0)}°` });
      if (st.sub === 'pinned' && frames.filter((f) => f.label.startsWith('nose')).length >= 2) break;
    }
    return { sheet: await sheet('foxpounce', frames), zoom: await sheet('foxpounce_zoom', frames, 'crop'), azimuth: (Math.atan2(ux, -uz) * 57.3).toFixed(0) + '° from north' };
  },

  // the samurai walks up the path at the fox: it stops and watches, bolts at a gallop, stops at a distance to look back,
  // then trots off into the woods
  async foxflee() {
    const i = await placeOnPath('fox', null, 0);
    const P = PATH_RUN;
    const s0 = await ev(({ i, P }) => {
      const g = window.kaze.game, D = g.modules.wildlife.debug, m = D.sim.mammals[i];
      D.calm(false);
      m.set('pause', 1e9);
      m.goal = null;
      m.slipAway = false; // (this one bolts: no slipping away at a trot before the flight distance)
      // the samurai 60 m down the path, walking at the fox
      const sx = m.x + P.dx * 60, sz = m.z + P.dz * 60;
      g.player.place(sx, sz, Math.atan2(-P.dx, -P.dz));
      return { x: m.x, z: m.z };
    }, { i, P });
    const frames = [];
    let n = 0, prev = '', lastShot = -99;
    for (let k = 0; k < 60 * 40 && frames.length < 21; k++) {
      const st = await ev(({ i, s0 }) => {
        const g = window.kaze.game, D = g.modules.wildlife.debug, m = D.sim.mammals[i], p = g.player.position;
        // walking at 1.6 m/s toward where the fox is
        const dx = m.x - p.x, dz = m.z - p.z, l = Math.hypot(dx, dz);
        if (l > 2 && m.state !== 'leave') g.player.place(p.x + (dx / l) * 1.6 / 60, p.z + (dz / l) * 1.6 / 60, Math.atan2(dx, dz));
        D.step(1 / 60, 1);
        return { state: m.state, d: l, x: m.x, y: m.y, z: m.z, gy: m.loco.gy, yaw: m.loco.yaw, v: m.loco.v, gait: m.loco.g.name, px: p.x, pz: p.z };
      }, { i, s0 });
      const change = st.state !== prev;
      prev = st.state;
      const every = st.state === 'flee' ? 45 : st.state === 'leave' ? 40 : st.state === 'lookback' ? 50 : 420;
      if (!change && k - lastShot < every) continue;
      lastShot = k;
      // the camera: a fixed spot beside the path, 14 m off the fox's first place and high over the susuki, panning
      // with it (a long lens)
      const cp = await ev(({ s0, P }) => {
        const g = window.kaze.game;
        const x = s0.x - P.dz * 14 + P.dx * 8, z = s0.z + P.dx * 14 + P.dz * 8;
        return [x, g.groundAt(x, z) + 6.5, z];
      }, { s0, P });
      const d = Math.hypot(st.x - cp[0], st.z - cp[2]);
      await ev(({ cp, st, fov }) => window.__wl.cam(cp, [st.x, st.gy + 0.3, st.z], fov), { cp, st, fov: Math.max(8, Math.min(30, 300 / Math.max(1, d))) });
      const at = await ev(({ st }) => window.__wl.project(st.x, st.gy + 0.3, st.z), { st });
      frames.push({ ...(await snap(`foxflee_${String(n++).padStart(2, '0')}`, at, 260)), label: `${st.state} · ${st.gait} ${st.v.toFixed(1)} m/s · samurai ${st.d.toFixed(0)} m` });
      if (st.state === 'leave' && frames.filter((f) => f.label.startsWith('leave')).length >= 3) break;
    }
    return { sheet: await sheet('foxflee', frames), zoom: await sheet('foxflee_zoom', frames, 'crop') };
  },

  // a group of sika grazing at a forest edge, seen from the field; then the samurai walks at them: heads up, the alert
  // (ears forward, a stamp), the alarm whistle, the flight with the rump patches flared, into the forest
  async deer() {
    const setup = await ev(() => {
      const g = window.kaze.game, D = g.modules.wildlife.debug, I = D.island;
      D.calm(true);
      const sp = D.sim.species.deer;
      // an edge of the wood around the field whose open side faces the low sun (the deer lit from the camera's side)
      const sun = g.lighting.sunDir, sl = Math.hypot(sun.x, sun.z) || 1;
      let pick = null;
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2, r = 170 + (k % 3) * 40;
        const t = I.findHabitat(sp, Math.sin(a) * r, Math.cos(a) * r, { rMin: 0, rMax: 60, away: null, count: 5 });
        if (!t || t.kind !== 'edge') continue;
        // the open side: the direction from the wood toward the field (the fewest trunks along it)
        let best = 0, bf = Infinity;
        for (let q = 0; q < 24; q++) {
          const ang = (q / 24) * Math.PI * 2;
          let f = 0;
          for (const d of [8, 16, 24, 32]) f += I.treesAround(t.x + Math.sin(ang) * d, t.z + Math.cos(ang) * d, 5).n;
          if (f < bf && I.walkable(t.x + Math.sin(ang) * 25, t.z + Math.cos(ang) * 25, sp)) (bf = f), (best = ang);
        }
        const lit = (Math.sin(best) * sun.x + Math.cos(best) * sun.z) / sl - bf * 0.05;
        if (!pick || lit > pick.lit) pick = { t, best, lit };
      }
      if (!pick) return null;
      const { t, best } = pick;
      D.spawnHerd('deer', t.x, t.z, 5, 0, t.spots, ['stag', 'hind', 'hind', 'calf', 'hind']);
      g.player.place(t.x + Math.sin(best) * 90, t.z + Math.cos(best) * 90, best + Math.PI);
      return { x: t.x, z: t.z, kind: t.kind, open: best, y: g.groundAt(t.x, t.z), lit: pick.lit };
    });
    if (!setup) return { error: 'no deer habitat' };
    const frames = [];
    let n = 0;
    const view = async (label, d = 22, fov = 30, h = 3.2) => {
      const c = await ev(() => {
        const ms = window.kaze.game.modules.wildlife.debug.mammals();
        return ms.reduce((a, m) => ({ x: a.x + m.x / ms.length, y: a.y + m.gy / ms.length, z: a.z + m.z / ms.length }), { x: 0, y: 0, z: 0 });
      });
      const cp = await ev(({ c, s, d, h }) => {
        const g = window.kaze.game, x = c.x + Math.sin(s.open) * d, z = c.z + Math.cos(s.open) * d;
        return [x, g.groundAt(x, z) + h, z];
      }, { c, s: setup, d, h });
      await ev(({ cp, c, fov }) => window.__wl.cam(cp, [c.x, c.y + 0.7, c.z], fov), { cp, c, fov });
      const at = await ev(({ c }) => window.__wl.project(c.x, c.y + 0.7, c.z), { c });
      frames.push({ ...(await snap(`deer_${String(n++).padStart(2, '0')}`, at, 300)), label });
    };
    // grazing: 6 frames over 12 s (from over the grass)
    for (let k = 0; k < 6; k++) {
      await ev(() => window.kaze.game.modules.wildlife.debug.step(1 / 60, 120));
      const s = await ev(() => window.kaze.game.modules.wildlife.debug.mammals().map((m) => m.state));
      await view(`${(k + 1) * 2} s · ${[...new Set(s)].join(', ')}`, 15, 30, 5.5);
    }
    // the samurai walks out of the field at them
    await ev(() => window.kaze.game.modules.wildlife.debug.calm(false));
    let alarmAt = null, alertAt = null;
    for (let k = 0; k < 60 * 60 && n < 18; k++) {
      const st = await ev(() => {
        const g = window.kaze.game, D = g.modules.wildlife.debug, ms = D.mammals(), p = g.player.position;
        const c = ms.reduce((a, m) => ({ x: a.x + m.x / ms.length, z: a.z + m.z / ms.length }), { x: 0, z: 0 });
        const dx = c.x - p.x, dz = c.z - p.z, l = Math.hypot(dx, dz);
        if (!ms.some((m) => m.state === 'flee')) g.player.place(p.x + (dx / l) * 1.6 / 60, p.z + (dz / l) * 1.6 / 60, Math.atan2(dx, dz));
        D.step(1 / 60, 1);
        return { d: l, states: ms.map((m) => m.state) };
      });
      if (!alertAt && st.states.includes('alert')) {
        alertAt = k;
        await view(`alert · samurai ${st.d.toFixed(0)} m`, 14, 22, 4.2);
      }
      if (alertAt && !alarmAt && k - alertAt === 40) await view(`alert +0.7 s · ${st.states.join(' ')}`, 14, 22, 4.2);
      if (!alarmAt && st.states.includes('flee')) {
        alarmAt = k;
        await view(`alarm · samurai ${st.d.toFixed(0)} m`, 15, 26, 4.2);
      }
      if (alarmAt && [10, 25, 45, 100].includes(k - alarmAt)) await view(`flight +${((k - alarmAt) / 60).toFixed(2)} s`, 20, 36, 3.2);
      // from behind the group as it runs: the white rumps flared, the tails up
      if (alarmAt && [55, 75].includes(k - alarmAt)) {
        const r = await ev(() => {
          const ms = window.kaze.game.modules.wildlife.debug.mammals().filter((m) => m.state === 'flee');
          if (!ms.length) return null;
          const c = ms.reduce((a, m) => ({ x: a.x + m.x / ms.length, y: a.y + m.gy / ms.length, z: a.z + m.z / ms.length, yaw: m.yaw }), { x: 0, y: 0, z: 0, yaw: 0 });
          return c;
        });
        if (r) {
          await ev(({ r }) => {
            const g = window.kaze.game, x = r.x - Math.sin(r.yaw) * 12, z = r.z - Math.cos(r.yaw) * 12;
            window.__wl.cam([x, g.groundAt(x, z) + 3.4, z], [r.x, r.y + 0.75, r.z], 26);
          }, { r });
          const at = await ev(({ r }) => window.__wl.project(r.x, r.y + 0.75, r.z), { r });
          frames.push({ ...(await snap(`deer_${String(n++).padStart(2, '0')}`, at, 300)), label: `flight from behind +${((k - alarmAt) / 60).toFixed(2)} s` });
        }
      }
      if (alarmAt && k - alarmAt > 100) break;
    }
    return { sheet: await sheet('deer', frames), zoom: await sheet('deer_zoom', frames, 'crop'), setup };
  },

  // CPU cost in normal play: the loop running, the population managed, the samurai standing at the spawn
  async perf() {
    await ev(() => {
      const g = window.kaze.game, D = g.modules.wildlife.debug;
      D.manual(false);
      D.auto(true);
      D.clear();
      g.player.place(0, 0, 0);
      g.loop.paused = false;
    });
    await page.waitForTimeout(4000);
    const sample = async (n) => {
      const out = [];
      for (let k = 0; k < n; k++) {
        await page.waitForTimeout(1000);
        out.push(await ev(() => {
          const s = window.kaze.stats(), D = window.kaze.game.modules.wildlife.debug;
          return { wildlifeMs: s.wildlifeMs, wildlifeMsMax: s.wildlifeMsMax, birds: s.birds, mammals: s.mammals, alive: D.sim.mammals.length, fps: +s.fps.toFixed(1) };
        }));
      }
      return out;
    };
    const samples = await sample(8);
    // the worst case: a group of six deer and two foxes right in front of the camera, every one of them posed at full
    // detail every frame, the birds still about
    await ev(() => {
      const g = window.kaze.game, D = g.modules.wildlife.debug, I = D.island;
      D.calm(true);
      const p = { x: -24, z: 30 }, sp = D.sim.species.deer;
      const spots = [];
      for (let k = 0; spots.length < 8 && k < 400; k++) {
        const x = p.x + 6 + Math.random() * 18, z = p.z - 10 + Math.random() * 20;
        if (I.walkable(x, z, sp) && !spots.some((s) => Math.hypot(s.x - x, s.z - z) < 2.2)) spots.push({ x, z, yaw: Math.random() * 6.28 });
      }
      D.spawnHerd('deer', 0, 0, 6, 0, spots.slice(0, 6), ['stag', 'hind', 'hind', 'hind', 'calf', 'calf']);
      D.spawnHerd('fox', 0, 0, 1, 0, [spots[6]]);
      D.spawnHerd('fox', 0, 0, 1, 0, [spots[7]]);
      g.player.place(p.x - 4, p.z, Math.PI / 2);
      window.__wl.cam([p.x - 6, g.groundAt(p.x - 6, p.z) + 2.5, p.z], [p.x + 15, g.groundAt(p.x + 15, p.z) + 0.5, p.z], 50);
    });
    await page.waitForTimeout(3000);
    const near = await sample(6);
    const mean = (a) => +(a.reduce((s, x) => s + x.wildlifeMs, 0) / a.length).toFixed(3);
    return { samples, meanMs: mean(samples), near, nearMeanMs: mean(near), nearMaxMs: Math.max(...near.map((s) => s.wildlifeMsMax)) };
  },
};

try {
  await boot();
  for (const name of only) {
    const t0 = Date.now();
    await stage();
    try {
      report.scenarios[name] = { ...(await scenarios[name]()), ms: Date.now() - t0 };
    } catch (e) {
      report.scenarios[name] = { error: String(e && e.stack ? e.stack : e) };
    }
    console.log(name, JSON.stringify(report.scenarios[name]).slice(0, 400));
  }
} finally {
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log('errors:', report.errors.length, report.errors.slice(0, 5));
  await browser.close();
  await server.close();
}
