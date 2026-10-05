import * as I from './instruments.js';
import { Music } from './music.js';
import { Ambience } from './ambience.js';
import { impulseResponse, gainNode } from './dsp.js';

// Offline audio self-test: renders every patch with OfflineAudioContext and reports peak / RMS / NaN, so the
// mix can be checked for clipping and silence without listening. Run in a page served by Vite:
//   const { audioSelfTest } = await import('/src/audio/selftest.js'); await audioSelfTest();

const SR = 44100;

async function render(name, dur, build, { limiter = false } = {}) {
  const ctx = new OfflineAudioContext(2, Math.ceil(SR * dur), SR);
  let dest = ctx.destination;
  if (limiter) {
    const l = ctx.createDynamicsCompressor();
    l.threshold.value = -9;
    l.knee.value = 6;
    l.ratio.value = 14;
    l.attack.value = 0.003;
    l.release.value = 0.22;
    l.connect(ctx.destination);
    dest = l;
  }
  const out = gainNode(ctx, 1);
  out.connect(dest);
  const rev = ctx.createConvolver();
  rev.buffer = impulseResponse(ctx);
  rev.connect(gainNode(ctx, 0.85)).connect(dest);
  const t0 = performance.now();
  build(ctx, out, rev);
  const buf = await ctx.startRendering();
  let peak = 0;
  let sum = 0;
  let n = 0;
  let nan = false;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      if (v !== v) nan = true;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sum += v * v;
      n++;
    }
  }
  const rms = Math.sqrt(sum / Math.max(1, n));
  const db = (x) => (x > 0 ? Math.round(20 * Math.log10(x) * 10) / 10 : -Infinity);
  return { name, dur, peak: Math.round(peak * 1000) / 1000, peakDb: db(peak), rmsDb: db(rms), nan, ms: Math.round(performance.now() - t0), ok: !nan && peak < 1 && db(rms) > -62 };
}

export async function audioSelfTest() {
  const T = [];
  const add = (name, dur, fn, o) => T.push([name, dur, fn, o]);
  add('koto D4', 4, (c, o, r) => I.koto(c, o, 0.05, 62, { gain: 0.5, rev: r }));
  add('koto A5 bend', 3, (c, o, r) => I.koto(c, o, 0.05, 81, { gain: 0.36, bend: 1, rev: r }));
  add('shakuhachi A4', 4, (c, o, r) => I.shakuhachi(c, o, 0.05, 69, 3, { rev: r, muraiki: true }));
  add('taiko', 2, (c, o, r) => I.taiko(c, o, 0.05, { gain: 0.8, size: 1.3, rev: r }));
  add('shime', 1, (c, o) => I.shime(c, o, 0.05));
  add('pad D cluster', 10, (c, o, r) => I.pad(c, o, 0, 5, [50, 57, 62], { gain: 0.1, rev: r }));
  add('swing', 1, (c, o) => I.swing(c, o, 0.05, { gain: 0.5 }));
  add('swing heavy', 1, (c, o) => I.swing(c, o, 0.05, { heavy: true, gain: 0.5 }));
  add('clash block', 1.2, (c, o, r) => I.clash(c, o, 0.05, { kind: 'block', gain: 0.5, rev: r }));
  add('clash parry', 2.5, (c, o, r) => I.clash(c, o, 0.05, { kind: 'parry', gain: 0.55, rev: r }));
  add('clash guardbreak', 1.5, (c, o, r) => I.clash(c, o, 0.05, { kind: 'guardbreak', gain: 0.55, rev: r }));
  add('slash', 0.8, (c, o, r) => I.slash(c, o, 0.05, { gain: 0.55, rev: r }));
  add('slash kill', 2, (c, o, r) => I.slash(c, o, 0.05, { kill: true, gain: 0.62, rev: r }));
  add('glint', 1.5, (c, o, r) => I.glint(c, o, 0.05, { gain: 0.3, rev: r }));
  add('draw + sheathe', 2.2, (c, o, r) => {
    I.draw(c, o, 0.05, { gain: 0.34, rev: r });
    I.sheathe(c, o, 1.3, { gain: 0.34 });
  });
  add('dodge', 1, (c, o) => I.dodge(c, o, 0.05, { gain: 0.36 }));
  add('footsteps grass/dirt/stone run', 1.6, (c, o) => {
    ['grass', 'dirt', 'stone'].forEach((s, i) => I.footstep(c, o, 0.05 + i * 0.35, { surface: s, speed: 5, gain: 0.42 }));
  });
  add('ui click/tick/shutter', 0.8, (c, o) => {
    I.uiClick(c, o, 0.05, { gain: 0.1 });
    I.uiClick(c, o, 0.2, { gain: 0.07, freq: 3000 });
    I.shutter(c, o, 0.4, { gain: 0.35 });
  });
  add('gust (guide)', 3.2, (c, o) => I.gust(c, o, 0.05, { gain: 0.42 }));
  add('boom (killcam)', 2.2, (c, o, r) => I.boom(c, o, 0.05, { gain: 0.5, rev: r }));
  add('heal', 3, (c, o, r) => I.heal(c, o, 0.05, { gain: 0.32, rev: r }));
  add('prayer: suzu + kashiwade', 3, (c, o, r) => {
    I.suzu(c, o, 0.05, { gain: 0.2, rev: r });
    I.clap(c, o, 1.4, { gain: 0.45, rev: r });
    I.clap(c, o, 1.75, { gain: 0.45, rev: r });
  });
  add('birds', 4, (c, o, r) => {
    I.bird(c, o, 0.05, { type: 'tsee', gain: 0.07, rev: r });
    I.bird(c, o, 1.2, { type: 'warble', gain: 0.07, rev: r });
    I.bird(c, o, 2.6, { type: 'hiyodori', gain: 0.07, rev: r });
  });
  add('crickets', 3, (c, o) => {
    for (let i = 0; i < 4; i++) I.cricket(c, o, 0.05 + i * 0.5, { freq: 4300 + i * 110, dur: 0.45, gain: 0.03 });
    I.cricket(c, o, 2.2, { kind: 'matsu', freq: 4100, gain: 0.03 });
  });
  add('crow + crackles', 2.2, (c, o, r) => {
    I.crow(c, o, 0.05, { gain: 0.035, rev: r });
    for (let i = 0; i < 12; i++) I.crackle(c, o, 0.1 + i * 0.15, { gain: 0.16 });
  });
  add('wildlife: sparrows flush, crows take off cawing', 3.4, (c, o, r) => {
    I.wingFlutter(c, o, 0.05, { birds: 16, rate: 14, dur: 0.6, freq: 2600, gain: 0.26 });
    I.wingFlutter(c, o, 1.0, { birds: 3, rate: 4.4, dur: 0.9, freq: 650, gain: 0.34 });
    I.caw(c, o, 1.12, { n: 3, gain: 0.2, rev: r });
  });
  add('wildlife: a sika stamps and whistles, a fox barks', 3.2, (c, o, r) => {
    I.stamp(c, o, 0.05, { gain: 0.3 });
    I.sikaWhistle(c, o, 0.35, { n: 2, gain: 0.26, rev: r });
    I.foxBark(c, o, 1.6, { n: 3, gain: 0.2, rev: r });
  });
  add('horse: hoofbeats grass/dirt/stone gallop', 2, (c, o) => {
    ['grass', 'dirt', 'stone'].forEach((s, i) => [0, 0.09, 0.27, 0.36].forEach((d) => I.hoof(c, o, 0.05 + i * 0.6 + d, { surface: s, speed: 13, gain: 0.5 })));
  });
  add('horse: walk on stone', 1.6, (c, o) => [0, 0.26, 0.52, 0.78].forEach((d) => I.hoof(c, o, 0.05 + d, { surface: 'stone', speed: 1.8, gain: 0.5 })));
  add('horse: snort + breath', 1.6, (c, o) => {
    I.snort(c, o, 0.05, { gain: 0.3 });
    [0.8, 1.2].forEach((d) => I.horseBreath(c, o, d, { gain: 0.22, k: 1 }));
  });
  add('horse: whistle + neigh', 2.4, (c, o, r) => {
    I.whistle(c, o, 0.05, { gain: 0.2, rev: r });
    I.neigh(c, o, 0.9, { gain: 0.26, rev: r });
  });
  add('ambience: golden hour field', 6, (c, o, r) => {
    const a = new Ambience(c, o, r);
    a.set({ wind: 0.9, guide: 0, grass: 0.8, sea: 0, fire: 0, hour: 17.7, active: true }, 0);
    a.update(0, 5.8);
  });
  add('ambience: guided wind + sea + fire', 6, (c, o, r) => {
    const a = new Ambience(c, o, r);
    a.set({ wind: 1.6, guide: 1, grass: 1, sea: 1, fire: 1, hour: 18.2, active: true }, 0);
    a.update(0, 5.8);
  });
  add('music: title', 20, (c, o, r) => {
    const m = new Music(c, o, r);
    m.setMood('title', 0);
    m.update(0, 19);
  });
  add('music: explore', 30, (c, o, r) => {
    const m = new Music(c, o, r);
    m.setMood('explore', 0);
    m.update(0, 29);
  });
  add('music: combat', 10, (c, o, r) => {
    const m = new Music(c, o, r);
    m.setMood('combat', 0);
    m.update(0, 9.5);
  });
  add(
    'FULL MIX (limiter): combat + storm + sfx',
    8,
    (c, o, r) => {
      const m = new Music(c, o, r);
      m.setMood('combat', 0);
      m.update(0, 7.5);
      const a = new Ambience(c, o, r);
      a.set({ wind: 1.7, guide: 1, grass: 1, sea: 1, fire: 1, hour: 18, active: true }, 0);
      a.update(0, 7.5);
      for (let i = 0; i < 14; i++) {
        const t = 0.3 + i * 0.5;
        I.swing(c, o, t, { heavy: i % 3 === 0, gain: 0.5 });
        if (i % 2) I.clash(c, o, t + 0.15, { kind: i % 4 === 1 ? 'parry' : 'block', gain: 0.55, rev: r });
        else I.slash(c, o, t + 0.15, { kill: i % 6 === 0, gain: 0.6, rev: r });
        I.footstep(c, o, t + 0.25, { surface: 'dirt', speed: 5, gain: 0.42 });
      }
    },
    { limiter: true }
  );
  const results = [];
  for (const [name, dur, fn, o] of T) {
    try {
      results.push(await render(name, dur, fn, o));
    } catch (err) {
      results.push({ name, error: String(err && err.stack ? err.stack : err), ok: false });
    }
  }
  return results;
}
