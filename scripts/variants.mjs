#!/usr/bin/env node
// Look-dev helper: open one shot once, apply N variants and screenshot each (+ a labelled contact sheet).
//   node scripts/variants.mjs --shot S5_ginkgo --file variants.json [--label X] [--quality high]
//        [--width 1920 --height 1080] [--params only=trees,props] [--frames 30]
// variants.json: [{ "name": "a", "js": "kaze.game.sky.uniforms.uCloudCover.value = 0.8" }, ...]
// Each snippet runs after kaze.setShot(<shot>) (so shot overrides are reset per variant) with `kaze`, `game`
// in scope and may be async. Output: out/shots/<label>/<name>.png and sheet.png (2 columns).
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
const shot = arg('shot', null);
const file = arg('file', null);
if (!shot || !file) {
  console.error('usage: node scripts/variants.mjs --shot <id> --file variants.json [--label X]');
  process.exit(2);
}
const variants = JSON.parse(fs.readFileSync(file, 'utf8'));
const label = String(arg('label', 'var-' + new Date().toISOString().replace(/[:.]/g, '-')));
const quality = String(arg('quality', 'high'));
const width = Number(arg('width', 1920)), height = Number(arg('height', 1080));
const extra = arg('params', '');
const frames = Number(arg('frames', 30));
const outDir = path.join(root, 'out', 'shots', label);
fs.mkdirSync(outDir, { recursive: true });

const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width, height } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const shotsOut = [];
// setShot, the variant's snippet, `frames` frames and the freeze (game.loop.paused) run inside ONE evaluate: the freeze
// lands before the next frame ticks, so the PNG is the state after exactly that many fixed steps, whatever the CDP
// latency (a pause sent as its own command would let 0..n more steps slip in). The loop is deterministic in shot mode
// and the film grain runs on the wind clock that setShot re-anchors (Game.frame), so two captures of the same code give
// byte-identical PNGs (see the scripts/shots.mjs header). The loop is let run first, whatever the last capture left.
function advance(page, sid, js, n) {
  return page.evaluate(
    async (a) => {
      const kaze = window.kaze, game = kaze.game;
      game.loop.paused = false;
      kaze.setShot(a.sid);
      await new Function('kaze', 'game', `return (async () => { ${a.js || ''} })();`)(kaze, game);
      await kaze.waitFrames(a.n);
      game.loop.paused = true;
    },
    { sid, js, n }
  );
}
try {
  await page.goto(`${url}?shot=${shot}&quality=${quality}&nohud${extra ? '&' + extra : ''}`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => window.kaze && window.kaze.ready, null, { timeout: 240000, polling: 250 });
  for (const v of variants) {
    await advance(page, shot, v.js, frames);
    const out = path.join(outDir, `${v.name}.png`);
    try {
      await page.evaluate(() => window.kaze.waitFrames(2)); // 2 frozen frames: the frozen state is what's on screen
      await page.screenshot({ path: out });
    } finally {
      await page.evaluate(() => { window.kaze.game.loop.paused = false; }).catch(() => {});
    }
    shotsOut.push({ name: v.name, file: out });
    console.log(`${v.name.padEnd(16)} → ${path.relative(root, out)}`);
  }
  // contact sheet: 2 columns of 960×540 thumbnails with the variant name
  const b64 = (p) => `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;
  const cells = shotsOut
    .map((s) => `<div style="position:relative;width:960px;height:540px"><img src="${b64(s.file)}" style="width:960px;height:540px"><span style="position:absolute;left:10px;top:8px;font:bold 28px sans-serif;color:#fff;text-shadow:0 0 4px #000">${s.name}</span></div>`)
    .join('');
  const rows = Math.ceil(shotsOut.length / 2);
  const sheet = await browser.newPage({ viewport: { width: 1920, height: rows * 540 } });
  await sheet.setContent(`<html><body style="margin:0;background:#000;display:flex;flex-wrap:wrap;width:1920px">${cells}</body></html>`);
  await sheet.waitForTimeout(200);
  await sheet.screenshot({ path: path.join(outDir, 'sheet.png') });
  console.log('sheet → ' + path.relative(root, path.join(outDir, 'sheet.png')));
} catch (e) {
  console.error('variants failed:', e.message || e);
  process.exitCode = 1;
}
if (errors.length) {
  console.error('page errors:\n  ' + errors.slice(0, 8).join('\n  '));
  process.exitCode = 1;
}
await browser.close();
await server.close();
