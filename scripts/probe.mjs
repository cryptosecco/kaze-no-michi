#!/usr/bin/env node
// Evaluate JavaScript inside the running game (headless Chrome, hardware WebGL) and print the JSON result.
//   node scripts/probe.mjs --eval "kaze.game.terrain.heightAt(0, 0)" [--params only=none] [--shot S1_field]
//   node scripts/probe.mjs --file path/to/snippet.js      (snippet body may use `kaze`, `game`, `THREE`-free math)
//   [--screenshot out.png] [--quality high] [--width 1920 --height 1080]   capture/measure at a given size
// The expression/snippet runs after window.kaze.ready; an async snippet may `return` a value. --screenshot together
// with --shot gives a PNG that repeats byte for byte (see the comment above the evaluate below).
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
const expr = arg('eval', null);
const file = arg('file', null);
const extra = arg('params', 'only=none');
const shot = arg('shot', null);
const shotOut = arg('screenshot', null); // save a screenshot after the snippet ran
const quality = arg('quality', 'low');
const width = Number(arg('width', 960)), height = Number(arg('height', 540));
if (!expr && !file) {
  console.error('usage: node scripts/probe.mjs --eval "<js expression>" | --file snippet.js [--params k=v] [--shot id]');
  process.exit(2);
}
const body = file ? fs.readFileSync(file, 'utf8') : `return (${expr});`;

const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width, height } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
// With --screenshot the snippet's own evaluate lets 20 frames through and freezes game.loop before it returns: the freeze
// lands before the next frame ticks, so the PNG is the state after the snippet plus exactly 20 fixed steps, whatever the
// CDP latency (a pause sent as its own command would let 0..n more steps slip in). With --shot the loop is deterministic
// and the same evaluate first re-applies the shot: kaze.setShot re-anchors the wind clock (the film grain runs on it
// too), the sky and the actors, so how many frames the page rendered since boot no longer shows. Two captures of the
// same code then give byte-identical PNGs (see the scripts/shots.mjs header); without --shot the loop follows the real clock.
try {
  await page.goto(`${url}?quality=${quality}&nohud${shot ? '&shot=' + shot : ''}${extra ? '&' + extra : ''}`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => window.kaze && window.kaze.ready, null, { timeout: 240000, polling: 250 });
  const result = await page.evaluate(async ({ src, n, sid }) => {
    const kaze = window.kaze, game = kaze.game;
    if (sid) kaze.setShot(sid);
    const fn = new Function('kaze', 'game', `return (async () => { ${src} })();`);
    const value = await fn(kaze, game);
    if (n > 0) {
      await kaze.waitFrames(n);
      game.loop.paused = true;
    }
    return value;
  }, { src: body, n: shotOut ? 20 : 0, sid: shotOut && shot ? shot : null });
  console.log(JSON.stringify(result, null, 1));
  if (shotOut) {
    try {
      await page.evaluate(() => window.kaze.waitFrames(2)); // 2 frozen frames: the frozen state is what's on screen
      await page.screenshot({ path: shotOut });
    } finally {
      await page.evaluate(() => { window.kaze.game.loop.paused = false; }).catch(() => {});
    }
    console.log('screenshot → ' + shotOut);
  }
} catch (e) {
  console.error('probe failed:', e.message || e);
  process.exitCode = 1;
}
if (errors.length) console.error('page errors:\n  ' + errors.slice(0, 8).join('\n  '));
await browser.close();
await server.close();
