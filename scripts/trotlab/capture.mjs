#!/usr/bin/env node
// Trot lab — browser capture: the real game in headless Chrome (hardware WebGL), the horse trotting on the flattest
// straight run near the spawn over a lab grid, photographed with the simulation frozen (one Chrome at a time).
//   npm run trotlab:capture -- --label <name> [--url http://localhost:5173/] [--hours 13] [--speed 4.0] [--no-rider]
//                                [--width 1440 --height 960] [--quality high] [--radius auto|<m>]
// Writes out/trotlab/<label>/:
//   side_left_sheet.png    12 frames over ONE stride (Muybridge), camera square to the heading at ~1 m, 21° lens
//   side_right_sheet.png, front34_sheet.png, rear34_sheet.png   6 frames each, the same stride
//   legs_closeup_sheet.png the LF/RH diagonal at touchdown, mid-stance, breakover, lift-off, mid-swing, terminal swing
//   rider_side_sheet.png   6 frames with the samurai seated (Riding api)
//   frames/<sheet>_<k>.png every frame; capture.json (run, light, times, phases and contacts of every frame)
// Every tile is labelled with the stride phase (0 = LF touchdown, from geometry) and the hooves in contact (markers.mjs:
// the lowest point of the hoof within 4 mm of the ground). Boot: ?deterministic&nointro&nohud&only=actors&grass=none —
// without the ui module the state goes straight to 'play' and the horse is installed; deterministic turns the dynamic
// resolution off; grass=none hides every grass layer so the hooves and the grid are visible; no trees or props.
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const label = String(arg('label', 'run-' + new Date().toISOString().replace(/[:.]/g, '-')));
const width = Number(arg('width', 1440)), height = Number(arg('height', 960));
const hours = Number(arg('hours', 13));
const speed = Number(arg('speed', 4.0));
const quality = String(arg('quality', 'high'));
const radius = String(arg('radius', 'auto')); // search radius of the run around the spawn (m), or auto (200, then 400 m)
const withRider = !arg('no-rider', false);
const extUrl = arg('url', null);
const outDir = path.join(root, 'out', 'trotlab', label);
const frameDir = path.join(outDir, 'frames');
fs.mkdirSync(frameDir, { recursive: true });
const T0 = Date.now();
const log = (s) => console.log(`[capture ${((Date.now() - T0) / 1000).toFixed(0)}s] ${s}`);

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
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});
const report = { label, date: new Date().toISOString(), url, width, height, quality, hours, speed, sheets: {}, errors: [] };

const num = (v, d) => (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d);
const fmtPhase = (p) => num(p, 2);
const legsDown = (c) => {
  const n = ['LF', 'RF', 'LH', 'RH'].filter((_, i) => c[i]);
  return n.length ? `on the ground: ${n.join(' ')}` : 'no hoof on the ground';
};

try {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => report.errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && report.errors.push(m.text()));
  await page.goto(`${url}?deterministic&nointro&nohud&only=actors&grass=none&quality=${quality}`, { waitUntil: 'load', timeout: 240000 });
  await page.waitForFunction(() => window.kaze && window.kaze.ready, null, { timeout: 300000, polling: 250 });
  await page.evaluate(() => window.kaze.waitFrames(20));
  log('game ready');
  const info = await page.evaluate(async (opts) => {
    const P = await import('/scripts/trotlab/page.mjs');
    window.__lab = await P.setup(window.kaze, opts);
    await window.kaze.waitFrames(3);
    return window.__lab.info;
  }, { hours, speed, radius });
  report.run = info;
  const R = info.run;
  log(`run: start (${R.x0}, ${R.z0}), heading ${((R.yaw * 180) / Math.PI).toFixed(1)}°, ${R.fromSpawn.toFixed(0)} m from the spawn; the ground strays ${(R.zoneResidual * 100).toFixed(1)} cm from a plane where the stride is photographed, ${(R.residual * 100).toFixed(1)} cm over the 40 m, grade ${(R.grade * 100).toFixed(2)} %`);
  if (R.nearBest) log(`(within 200 m of the spawn the flattest stretch strays ${(R.nearBest.zoneResidual * 100).toFixed(1)} cm: rolling ground, so the search went further)`);

  // one frame: step the horse to time t, then each requested view: camera, 2 frozen frames, the PNG
  const shoot = async (t, views, meta) => {
    const st = await page.evaluate((x) => window.__lab.stepTo(x), t);
    for (const [view, file] of views) {
      await page.evaluate((v) => window.__lab.view(v), view);
      await page.evaluate(() => window.kaze.waitFrames(2));
      await page.screenshot({ path: path.join(frameDir, file) });
    }
    return { ...meta, ...st, files: views.map(([, f]) => 'frames/' + f) };
  };

  // ---- pass 1: riderless. The stride is measured first (LF touchdown to LF touchdown, from geometry), then the run is
  // replayed from the same start with the same seed and that very stride is photographed: on real ground no two strides
  // are quite alike, so a stride predicted from the one before would put the events a few ms off
  await page.evaluate(() => window.__lab.reset({ rider: false }));
  const pr = await page.evaluate(() => window.__lab.probe(3));
  await page.evaluate(() => window.__lab.reset({ rider: false }));
  const tref = pr.last.td, T = pr.last.nextTd - pr.last.td;
  const dur = pr.last.lo - pr.last.td, swing = T - dur;
  log(`stride ${(T * 1000).toFixed(0)} ms, LF contact ${(dur * 1000).toFixed(0)} ms, breakover ${pr.last.flat ? ((pr.last.bo - pr.last.td) / dur).toFixed(2) : 'n/a'} of the contact`);
  const shots = [];
  for (let k = 0; k < 12; k++) {
    const v = [['side_left', `side_left_${String(k).padStart(2, '0')}.png`]];
    if (k % 2 === 0) for (const s of ['side_right', 'front34', 'rear34']) v.push([s, `${s}_${k / 2}.png`]);
    shots.push({ t: tref + (k * T) / 12, views: v, meta: { k, phase: k / 12 } });
  }
  const boFlat = pr.last.flat && pr.last.bo < pr.last.lo - 1e-6;
  const events = [
    ['touchdown', 0],
    ['mid-stance', dur / 2],
    [boFlat ? 'breakover (the heel lifts)' : 'breakover: none, flat lift-off (85 % of the contact)', boFlat ? pr.last.bo - pr.last.td : 0.85 * dur],
    ['lift-off', dur],
    ['mid-swing', dur + swing / 2],
    ['terminal swing', dur + 0.9 * swing],
  ];
  events.forEach(([name, dt], k) => shots.push({ t: tref + dt, views: [['legs', `legs_closeup_${k}.png`]], meta: { k, event: name, phase: dt / T } }));
  shots.sort((a, b) => a.t - b.t);
  const done = [];
  for (const s of shots) done.push(await shoot(s.t, s.views, { ...s.meta, views: s.views.map(([v]) => v) }));
  // the replay is the measured stride: at its first frame LF's lowest point sits on the 4 mm contact threshold
  report.replayCheck = { lfLowAtTouchdown_mm: done.find((d) => d.views.includes('side_left') && d.k === 0).lowH[0] };
  log(`riderless pass: ${done.length} instants; replay check: LF lowest point ${report.replayCheck.lfLowAtTouchdown_mm} mm at the touchdown (threshold 4 mm)`);

  // ---- pass 2: the samurai seated ----
  const riderFrames = [];
  if (withRider) {
    try {
      await page.evaluate(() => window.__lab.reset({ rider: true }));
      const p2 = await page.evaluate(() => window.__lab.probe(2));
      await page.evaluate(() => window.__lab.reset({ rider: true }));
      const tr = p2.last.td, T2 = p2.last.nextTd - p2.last.td;
      for (let k = 0; k < 6; k++) riderFrames.push(await shoot(tr + (k * T2) / 6, [['rider', `rider_side_${k}.png`]], { k, phase: k / 6, views: ['rider'] }));
      log('rider pass done');
    } catch (e) {
      report.errors.push('rider pass: ' + (e.message || e));
      log('rider pass FAILED: ' + (e.message || e));
    }
  }
  await page.evaluate(() => window.__lab.teardown());

  // ---- sheets ----
  const b64 = (f) => `data:image/png;base64,${fs.readFileSync(path.join(outDir, f)).toString('base64')}`;
  const sheet = async (name, title, tiles, cols) => {
    const tw = Math.round(width / 2), th = Math.round(height / 2), rows = Math.ceil(tiles.length / cols);
    const p = await ctx.newPage();
    await p.setViewportSize({ width: cols * tw, height: rows * th + 44 });
    await p.setContent(
      `<html><body style="margin:0;background:#111;width:${cols * tw}px;font-family:Helvetica,Arial,sans-serif">` +
        `<div style="height:44px;line-height:44px;color:#eee;font-size:20px;padding-left:12px">${title}</div>` +
        `<div style="display:flex;flex-wrap:wrap;width:${cols * tw}px">` +
        tiles
          .map(
            (t) =>
              `<div style="position:relative;width:${tw}px;height:${th}px"><img src="${b64(t.file)}" style="width:${tw}px;height:${th}px;display:block">` +
              `<div style="position:absolute;left:8px;top:6px;font-size:19px;font-weight:bold;color:#fff;text-shadow:0 0 4px #000,0 0 2px #000">${t.top}</div>` +
              `<div style="position:absolute;left:8px;bottom:8px;font-size:18px;color:#fff;text-shadow:0 0 4px #000,0 0 2px #000">${t.bottom}</div></div>`
          )
          .join('') +
        '</div></body></html>'
    );
    await p.waitForTimeout(200);
    await p.screenshot({ path: path.join(outDir, name) });
    await p.close();
    report.sheets[name] = tiles.map((t) => t.file);
  };
  const pick = (view) => done.filter((d) => d.views.includes(view)).sort((a, b) => a.t - b.t);
  const spd = speed.toFixed(1);
  const head = (what) => `Trot lab ${label} — ${what} · trot at ${spd} m/s · time of day ${hours} h · grid 10 cm (yellow 50 cm, white 1 m)`;
  const tileOf = (d, view, extra = '') => ({
    file: d.files[d.views.indexOf(view)],
    top: `${extra}phase ${fmtPhase((d.t - tref) / T)} · t ${num(d.t - tref, 3)} s`,
    bottom: legsDown(d.contact),
  });
  await sheet('side_left_sheet.png', head('left side, one stride in 12 frames'), pick('side_left').map((d) => tileOf(d, 'side_left', `${d.k + 1}/12 · `)), 4);
  await sheet('side_right_sheet.png', head('right side, 6 frames'), pick('side_right').map((d) => tileOf(d, 'side_right')), 3);
  await sheet('front34_sheet.png', head('front left three-quarter view, 6 frames'), pick('front34').map((d) => tileOf(d, 'front34')), 3);
  await sheet('rear34_sheet.png', head('rear left three-quarter view, 6 frames'), pick('rear34').map((d) => tileOf(d, 'rear34')), 3);
  // (at a touchdown or a lift-off LF's lowest point sits on the 4 mm threshold: its height says which side it is on)
  const mm = (v) => `${num(v, 1)} mm`;
  await sheet('legs_closeup_sheet.png', head('limbs, LF/RH diagonal: events of the LF contact'), pick('legs').map((d) => ({ ...tileOf(d, 'legs'), top: `${d.event} · phase ${fmtPhase((d.t - tref) / T)}`, bottom: `${legsDown(d.contact)} · lowest point: LF ${mm(d.lowH[0])}, RH ${mm(d.lowH[3])}` })), 3);
  if (riderFrames.length === 6) {
    const r0 = riderFrames[0].t;
    await sheet('rider_side_sheet.png', head('with the samurai in the saddle, left side, 6 frames'), riderFrames.map((d) => ({ file: d.files[0], top: `phase ${fmtPhase(d.phase)} · t ${num(d.t - r0, 3)} s`, bottom: legsDown(d.contact) })), 3);
  }
  report.stride = { T, tref, lfContact: pr.last, frames: done, rider: riderFrames };
  log('sheets written');
  await ctx.close();
} catch (e) {
  report.errors.push('HARNESS: ' + (e.stack || e.message || e));
  console.error(e);
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(outDir, 'capture.json'), JSON.stringify(report, null, 1));
  await browser.close();
  if (server) await server.close();
}
for (const e of report.errors.slice(0, 8)) console.log('   ! ' + String(e).slice(0, 300));
log(`→ ${path.relative(root, outDir)}`);
