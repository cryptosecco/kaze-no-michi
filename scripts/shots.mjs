#!/usr/bin/env node
// Canonical-shot capture harness.
//   npm run shots -- --label my-run [--shots S1_field,S2_shrine] [--quality high] [--width 1920 --height 1080]
//                    [--fps-ms 3000] [--no-fps] [--url http://localhost:5173/] [--params only=trees]
//                    [--seq 6 --seq-ms 120]   (frame sequence + contact sheet seq_<shot>.png to look at the wind)
// Starts Vite (unless --url), opens each canonical shot in headless Chrome (hardware WebGL2 via ANGLE/Metal),
// waits for window.kaze.ready, measures fps (loop running) and captures out/shots/<label>/<shot>.png; report.json
// beside the PNGs holds, per shot, the fps, load time, render stats, GPU and the console errors and warnings.
// Every render screenshot (the still and each --seq frame) is taken with game.loop frozen, in a state that is an
// exact number of fixed steps after kaze.setShot() (see advance() / snap() below). In shot mode the loop advances one
// step per unpaused frame, so the frames to let through and the freeze that follows them run inside ONE evaluate: the
// freeze lands before the next frame ticks (a freeze sent as its own command would let 0..n more steps of wind, leaves
// and cape slip in, depending on CDP latency). The film grain runs on the wind clock, which setShot re-anchors
// (Game.frame), so two captures of the same code give byte-identical PNGs, with or without the fps measurement (that
// one runs with the loop live, before setShot). The one exception is S4_title's DOM overlay (the calligraphy's
// SVG-filtered ink): launches in a different order can differ by a few pixels of one level there; the 3D scene is identical.
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};

const ALL = ['S1_field', 'S2_shrine', 'S3_standoff', 'S4_title', 'S5_ginkgo'];
const label = String(arg('label', new Date().toISOString().replace(/[:.]/g, '-')));
const shots = String(arg('shots', ALL.join(','))).split(',').filter(Boolean);
const quality = String(arg('quality', 'high'));
const width = Number(arg('width', 1920));
const height = Number(arg('height', 1080));
const fpsMs = Number(arg('fps-ms', 3000));
const noFps = !!arg('no-fps', false);
// --seq N: N consecutive frames --seq-ms apart, the first on the still's own state (wind motion) + a contact sheet
// seq_<shot>.png
const seqN = Number(arg('seq', 0)) || 0;
const seqMs = Number(arg('seq-ms', 120));
const extUrl = arg('url', null);
const extra = arg('params', ''); // extra URL params, e.g. --params only=trees,props

const outDir = path.join(root, 'out', 'shots', label);
fs.mkdirSync(outDir, { recursive: true });

let server = null;
let url = extUrl;
if (!url) {
  server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false } });
  await server.listen();
  url = server.resolvedUrls.local[0];
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [
    '--use-angle=metal',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    // unthrottled rAF so fps measures real GPU/CPU headroom instead of the 60 Hz vsync cap
    '--disable-gpu-vsync',
    '--disable-frame-rate-limit',
  ],
});

// Runs the loop for exactly `frames` frames, then freezes it — one evaluate, so the freeze lands before the next frame
// ticks. With `shot`, kaze.setShot(shot) runs first in the same evaluate (it re-anchors the wind clock and restages the
// actors, so the frames count from it). The loop may be frozen or running when this starts.
function advance(page, frames, shot = null) {
  return page.evaluate(
    async ({ n, sid }) => {
      const k = window.kaze;
      k.game.loop.paused = false;
      if (sid) k.setShot(sid);
      await k.waitFrames(n);
      k.game.loop.paused = true;
    },
    { n: frames, sid: shot }
  );
}

// Screenshot of the frozen state: 2 frozen frames are let through (so the frozen state is what's actually on screen),
// then the PNG. The single choke point every render screenshot goes through.
async function snap(page, file) {
  await page.evaluate(() => window.kaze.waitFrames(2));
  await page.screenshot({ path: file });
}

// Lets the loop run again (the page may already be gone: never throws).
const unfreeze = (page) => page.evaluate(() => { window.kaze.game.loop.paused = false; }).catch(() => {});

const report = { label, date: new Date().toISOString(), url, quality, width, height, shots: [] };

for (const id of shots) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  const warnings = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    else if (m.type() === 'warning') warnings.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`);
  });
  const t0 = Date.now();
  let entry = { id, errors, warnings };
  for (let attempt = 0; attempt < 2; attempt++) {
  try {
    if (attempt > 0) errors.length = 0;
    await page.goto(`${url}?shot=${id}&quality=${quality}&nohud${extra ? '&' + extra : ''}`, { waitUntil: 'load', timeout: 180000 });
    await page.waitForFunction(() => window.kaze && window.kaze.ready, null, { timeout: 240000, polling: 250 });
    entry.loadMs = Date.now() - t0;
    await page.evaluate(() => window.kaze.waitFrames(60));
    if (!noFps) entry.perf = await page.evaluate((ms) => window.kaze.measureFps(ms), fpsMs);
    const file = path.join(outDir, `${id}.png`);
    // frames are paced in game frames (the loop is deterministic in shot mode), ~60 per second of wind time
    const frames = Math.max(1, Math.round(seqMs / 16.7));
    const seq = [];
    try {
      await advance(page, 45, id); // setShot, then 45 steps, then frozen: all in one evaluate
      await snap(page, file);
      entry.file = path.relative(root, file);
      // frame 0 is the still's own state (the loop stays frozen), every next one `frames` steps after the previous
      for (let k = 0; k < seqN; k++) {
        if (k > 0) await advance(page, frames);
        const sf = path.join(outDir, `seq_${id}_${k}.png`);
        await snap(page, sf);
        seq.push(sf);
      }
    } finally {
      await unfreeze(page);
    }
    if (seqN > 0) {
      const b64p = (p) => `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;
      const cols = 3, tw = 640, th = 360, rows = Math.ceil(seq.length / cols);
      const sheet = await ctx.newPage();
      await sheet.setViewportSize({ width: cols * tw, height: rows * th });
      await sheet.setContent(
        `<html><body style="margin:0;background:#000;display:flex;flex-wrap:wrap;width:${cols * tw}px">` +
          seq.map((p, k) => `<div style="position:relative;width:${tw}px;height:${th}px"><img src="${b64p(p)}" style="width:${tw}px;height:${th}px"><span style="position:absolute;left:8px;top:6px;font:bold 22px sans-serif;color:#fff;text-shadow:0 0 4px #000">${k} · +${k * seqMs} ms</span></div>`).join('') +
          '</body></html>'
      );
      await sheet.waitForTimeout(150);
      await sheet.screenshot({ path: path.join(outDir, `seq_${id}.png`) });
      await sheet.close();
      entry.seq = seq.map((p) => path.relative(root, p));
    }
    entry.stats = await page.evaluate(() => window.kaze.stats());
    entry.gpu = await page.evaluate(() => {
      const gl = document.getElementById('kaze-canvas').getContext('webgl2');
      const e = gl.getExtension('WEBGL_debug_renderer_info');
      return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    });
    break;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (attempt === 0 && /context was destroyed|navigation/i.test(msg)) continue; // vite reload: retry once
    errors.push('HARNESS: ' + msg);
    break;
  }
  }
  report.shots.push(entry);
  const p = entry.perf;
  console.log(
    `${id.padEnd(12)} ${p ? p.fps.toFixed(1).padStart(6) + ' fps (p95 ' + p.p95.toFixed(1) + ' ms)' : '   -   '}  ` +
      `load ${((entry.loadMs || 0) / 1000).toFixed(1)}s  errors ${errors.length}  ${entry.file || ''}`
  );
  for (const e of errors.slice(0, 6)) console.log('   ! ' + e.slice(0, 400));
  await ctx.close();
}

fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
console.log('report →', path.relative(root, path.join(outDir, 'report.json')));
await browser.close();
if (server) await server.close();
