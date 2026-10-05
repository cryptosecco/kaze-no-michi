import { rand, rrange, pick, mtof, kotoPluck, perc, noiseSource, filter, gainNode, spatialOut, cleanup } from './dsp.js';

// Procedural instruments and sound effects. Signature: fn(ctx, out, t, opts) → end time.
// `out` is any AudioNode; `opts.rev` (optional) is a reverb send input. Works on AudioContext and
// OfflineAudioContext alike (the self-test renders every patch offline).

function sendTo(ctx, from, rev, amt, nodes) {
  if (!rev || amt <= 0) return;
  const s = gainNode(ctx, amt);
  from.connect(s).connect(rev);
  nodes.push(s);
}

function osc(ctx, type, f, t, stop) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  o.start(t);
  o.stop(stop);
  return o;
}

// ================================================================================================ music
// Koto: Karplus-Strong string through a paulownia-body resonance. bend (semitones) = oshi-de press.
export function koto(ctx, out, t, midi, { gain = 0.5, pan = 0, bend = 0, bendAt = 0.3, rev = null, revAmt = 0.35 } = {}) {
  const { buffer, rate } = kotoPluck(ctx, midi);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.setValueAtTime(rate, t);
  if (bend) {
    const k = Math.pow(2, bend / 12);
    src.playbackRate.setValueAtTime(rate, t + bendAt);
    src.playbackRate.linearRampToValueAtTime(rate * k, t + bendAt + 0.16);
    src.playbackRate.setValueAtTime(rate * k, t + bendAt + 0.55);
    src.playbackRate.linearRampToValueAtTime(rate, t + bendAt + 0.85);
  }
  const hp = filter(ctx, 'highpass', 70);
  const b1 = filter(ctx, 'peaking', 230, 1.1, 4);
  const b2 = filter(ctx, 'peaking', 1180, 1.4, 2.5);
  const lp = filter(ctx, 'lowpass', 5200, 0.6);
  const g = gainNode(ctx, gain);
  const o = spatialOut(ctx, out, pan);
  src.connect(hp).connect(b1).connect(b2).connect(lp).connect(g).connect(o);
  const nodes = [src, hp, b1, b2, lp, g, o];
  sendTo(ctx, g, rev, revAmt, nodes);
  src.start(t);
  const end = t + buffer.duration / rate + 0.05;
  cleanup(nodes, end, ctx);
  return end;
}

// Shakuhachi: breathy bamboo flute — meri scoop into the note, delayed vibrato, breath noise, swell.
export function shakuhachi(ctx, out, t, midi, dur, { gain = 0.26, pan = 0, rev = null, revAmt = 0.7, scoop = true, muraiki = false } = {}) {
  const f = mtof(midi);
  const stop = t + dur + 0.15;
  const o1 = osc(ctx, 'sine', f, t, stop);
  const o2 = osc(ctx, 'triangle', f, t, stop);
  const o3 = osc(ctx, 'sine', f * 2, t, stop);
  if (scoop) {
    for (const [o, m] of [[o1, 1], [o2, 1], [o3, 2]]) {
      o.frequency.setValueAtTime(f * m * 0.935, t);
      o.frequency.exponentialRampToValueAtTime(f * m, t + 0.24);
    }
  }
  const lfo = osc(ctx, 'sine', rrange(4.6, 5.5), t, stop);
  const vib = gainNode(ctx, 0);
  const vib2 = gainNode(ctx, 0);
  const vd = Math.min(dur * 0.65, 1.0);
  vib.gain.setValueAtTime(0, t);
  vib.gain.linearRampToValueAtTime(f * 0.0065, t + vd);
  vib2.gain.setValueAtTime(0, t);
  vib2.gain.linearRampToValueAtTime(f * 0.013, t + vd);
  lfo.connect(vib);
  lfo.connect(vib2);
  vib.connect(o1.frequency);
  vib.connect(o2.frequency);
  vib2.connect(o3.frequency);
  const tone = gainNode(ctx, 0);
  const g1 = gainNode(ctx, 0.8);
  const g2 = gainNode(ctx, 0.12);
  const g3 = gainNode(ctx, 0.06);
  o1.connect(g1).connect(tone);
  o2.connect(g2).connect(tone);
  o3.connect(g3).connect(tone);
  const ns = noiseSource(ctx, t, dur + 0.2);
  const nbp = filter(ctx, 'bandpass', f * 2.1, 1.3);
  const nhp = filter(ctx, 'highpass', 700);
  const breath = gainNode(ctx, 0);
  ns.connect(nbp).connect(nhp).connect(breath);
  const A = Math.min(0.2, dur * 0.3);
  const R = Math.min(0.6, dur * 0.35);
  tone.gain.setValueAtTime(0.0001, t);
  tone.gain.linearRampToValueAtTime(0.72, t + A);
  tone.gain.linearRampToValueAtTime(1.0, t + Math.max(A + 0.01, dur * 0.62));
  tone.gain.linearRampToValueAtTime(0.0001, t + dur);
  breath.gain.setValueAtTime(0.0001, t);
  breath.gain.linearRampToValueAtTime(muraiki ? 1.1 : 0.4, t + 0.05);
  breath.gain.linearRampToValueAtTime(0.11, t + A + 0.12);
  breath.gain.setValueAtTime(0.11, t + Math.max(A + 0.13, dur - R));
  breath.gain.linearRampToValueAtTime(0.0001, t + dur);
  const lp = filter(ctx, 'lowpass', 3600, 0.5);
  const g = gainNode(ctx, gain);
  const o = spatialOut(ctx, out, pan);
  tone.connect(lp);
  breath.connect(lp);
  lp.connect(g).connect(o);
  const nodes = [o1, o2, o3, lfo, vib, vib2, tone, g1, g2, g3, ns, nbp, nhp, breath, lp, g, o];
  sendTo(ctx, g, rev, revAmt, nodes);
  cleanup(nodes, stop, ctx);
  return stop;
}

// Taiko (ō-daiko): pitch-dropping membrane + skin slap, softly saturated.
export function taiko(ctx, out, t, { gain = 0.8, size = 1, pan = 0, rev = null, revAmt = 0.22 } = {}) {
  const f0 = 150 / size;
  const f1 = 52 / Math.sqrt(size);
  const dec = 1.0 * size;
  const stop = t + dec + 0.2;
  const o1 = osc(ctx, 'sine', f0, t, stop);
  o1.frequency.exponentialRampToValueAtTime(f1, t + 0.11);
  const g1 = gainNode(ctx, 0);
  perc(g1.gain, t, 1, 0.002, dec);
  const o2 = osc(ctx, 'sine', f0 * 1.58, t, stop);
  o2.frequency.exponentialRampToValueAtTime(f1 * 1.52, t + 0.09);
  const g2 = gainNode(ctx, 0);
  perc(g2.gain, t, 0.32, 0.002, dec * 0.35);
  const n = noiseSource(ctx, t, 0.14);
  const nlp = filter(ctx, 'lowpass', 1200, 0.8);
  const ng = gainNode(ctx, 0);
  perc(ng.gain, t, 0.6, 0.001, 0.07);
  const sat = ctx.createWaveShaper();
  sat.curve = tanhCurve(1.6);
  const g = gainNode(ctx, gain * 0.9);
  const o = spatialOut(ctx, out, pan);
  o1.connect(g1).connect(sat);
  o2.connect(g2).connect(sat);
  n.connect(nlp).connect(ng).connect(sat);
  sat.connect(g).connect(o);
  const nodes = [o1, o2, g1, g2, n, nlp, ng, sat, g, o];
  sendTo(ctx, g, rev, revAmt, nodes);
  cleanup(nodes, stop, ctx);
  return stop;
}

// Shime-daiko: small, tight, high — the ticking pulse under the taiko.
export function shime(ctx, out, t, { gain = 0.35, pan = 0 } = {}) {
  const stop = t + 0.25;
  const o1 = osc(ctx, 'sine', 430, t, stop);
  o1.frequency.exponentialRampToValueAtTime(300, t + 0.03);
  const g1 = gainNode(ctx, 0);
  perc(g1.gain, t, 1, 0.001, 0.13);
  const n = noiseSource(ctx, t, 0.05);
  const nbp = filter(ctx, 'bandpass', 2600, 1.2);
  const ng = gainNode(ctx, 0);
  perc(ng.gain, t, 0.5, 0.001, 0.03);
  const g = gainNode(ctx, gain);
  const o = spatialOut(ctx, out, pan);
  o1.connect(g1).connect(g);
  n.connect(nbp).connect(ng).connect(g);
  g.connect(o);
  cleanup([o1, g1, n, nbp, ng, g, o], stop, ctx);
  return stop;
}

// Soft sustained pad (shō-like cluster) for the drone bed.
export function pad(ctx, out, t, dur, midis, { gain = 0.08, attack = 3, release = 4, cutoff = 900, rev = null, revAmt = 0.5 } = {}) {
  const stop = t + dur + release + 0.1;
  const env = gainNode(ctx, 0);
  env.gain.setValueAtTime(0.0001, t);
  env.gain.linearRampToValueAtTime(1, t + attack);
  env.gain.setValueAtTime(1, t + Math.max(attack, dur));
  env.gain.linearRampToValueAtTime(0.0001, t + Math.max(attack, dur) + release);
  const lp = filter(ctx, 'lowpass', cutoff, 0.4);
  const g = gainNode(ctx, gain / Math.max(1, midis.length * 0.7));
  const nodes = [env, lp, g];
  for (const m of midis) {
    const f = mtof(m);
    for (const det of [-3.5, 3.5]) {
      const o = osc(ctx, 'triangle', f, t, stop);
      o.detune.value = det + rrange(-1, 1);
      o.connect(env);
      nodes.push(o);
    }
  }
  env.connect(lp).connect(g).connect(out);
  sendTo(ctx, g, rev, revAmt, nodes);
  cleanup(nodes, stop, ctx);
  return stop;
}

// Struck metal bar / small bell: inharmonic partials with individual decays.
export function bell(ctx, out, t, f, { gain = 0.2, decay = 1.6, pan = 0, rev = null, revAmt = 0.5, ratios = [1, 2.76, 5.4, 8.93], amps = [1, 0.45, 0.25, 0.12] } = {}) {
  const stop = t + decay + 0.2;
  const g = gainNode(ctx, gain);
  const o = spatialOut(ctx, out, pan);
  const nodes = [g, o];
  ratios.forEach((r, i) => {
    if (f * r >= ctx.sampleRate * 0.5) return; // past Nyquist (the draw's 2920 Hz × 8.93): inaudible, and WebAudio warns
    const p = osc(ctx, 'sine', f * r, t, stop);
    const pg = gainNode(ctx, 0);
    perc(pg.gain, t, amps[i] ?? 0.1, 0.001, decay / (1 + i * 0.6));
    p.connect(pg).connect(g);
    nodes.push(p, pg);
  });
  g.connect(o);
  sendTo(ctx, g, rev, revAmt, nodes);
  cleanup(nodes, stop, ctx);
  return stop;
}

// ================================================================================================ combat
export function swing(ctx, out, t, { heavy = false, gain = 0.5, pan = 0 } = {}) {
  const dur = heavy ? 0.42 : 0.25;
  const stop = t + dur + 0.1;
  const n = noiseSource(ctx, t, dur + 0.05);
  const bp = filter(ctx, 'bandpass', heavy ? 900 : 3400, 1.1);
  bp.frequency.setValueAtTime(heavy ? 900 : 3400, t);
  bp.frequency.exponentialRampToValueAtTime(heavy ? 380 : 700, t + dur);
  const env = gainNode(ctx, 0);
  env.gain.setValueAtTime(0.0001, t);
  env.gain.linearRampToValueAtTime(1, t + dur * 0.38);
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  const w = osc(ctx, 'sine', heavy ? 820 : 1500, t, stop);
  w.frequency.exponentialRampToValueAtTime(heavy ? 300 : 560, t + dur);
  const wg = gainNode(ctx, heavy ? 0.05 : 0.07);
  const g = gainNode(ctx, gain);
  const o = spatialOut(ctx, out, pan);
  n.connect(bp).connect(env);
  w.connect(wg).connect(env);
  env.connect(g).connect(o);
  const nodes = [n, bp, env, w, wg, g, o];
  if (heavy) {
    const b = noiseSource(ctx, t, dur, { type: 'brown' });
    const blp = filter(ctx, 'lowpass', 420);
    const bg = gainNode(ctx, 0);
    bg.gain.setValueAtTime(0.0001, t);
    bg.gain.linearRampToValueAtTime(0.9, t + dur * 0.4);
    bg.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.05);
    b.connect(blp).connect(bg).connect(g);
    nodes.push(b, blp, bg);
  }
  cleanup(nodes, stop, ctx);
  return stop;
}

// Blade on blade. kind: 'block' (short, dull), 'parry' (bright ringing — the satisfying one),
// 'guardbreak' (crunchy, distorted, heavy).
export function clash(ctx, out, t, { kind = 'block', gain = 0.5, pan = 0, rev = null } = {}) {
  const f0 = kind === 'parry' ? rrange(900, 1060) : kind === 'guardbreak' ? rrange(420, 520) : rrange(560, 700);
  const base = kind === 'parry' ? 1.35 : kind === 'guardbreak' ? 0.6 : 0.34;
  const ratios = [1, 2.02, 2.76, 3.91, 5.4, 6.79, 8.93];
  const amps = [1, 0.5, 0.7, 0.35, 0.45, 0.2, 0.25];
  const stop = t + base + 0.3;
  const sum = gainNode(ctx, 0.22);
  const nodes = [sum];
  ratios.forEach((r, i) => {
    const p = osc(ctx, 'sine', f0 * r, t, stop);
    const pg = gainNode(ctx, 0);
    perc(pg.gain, t, amps[i], 0.0008, base / (1 + i * 0.35));
    p.connect(pg).connect(sum);
    nodes.push(p, pg);
    if (kind === 'parry' && i < 4) {
      const q = osc(ctx, 'sine', f0 * r * 1.004, t, stop);
      const qg = gainNode(ctx, 0);
      perc(qg.gain, t, amps[i] * 0.35, 0.0008, base / (1 + i * 0.35));
      q.connect(qg).connect(sum);
      nodes.push(q, qg);
    }
  });
  const click = noiseSource(ctx, t, 0.03);
  const chp = filter(ctx, 'highpass', 2500);
  const cg = gainNode(ctx, 0);
  perc(cg.gain, t, kind === 'parry' ? 0.6 : 0.42, 0.0005, 0.018);
  click.connect(chp).connect(cg);
  const g = gainNode(ctx, gain);
  const o = spatialOut(ctx, out, pan);
  let head = sum;
  if (kind === 'guardbreak') {
    // saturate for crunch, then trim: tanh output sits at full scale
    const sh = ctx.createWaveShaper();
    sh.curve = tanhCurve(5);
    const trim = gainNode(ctx, 0.42);
    sum.connect(sh).connect(trim);
    head = trim;
    nodes.push(sh, trim);
  }
  head.connect(g);
  cg.connect(g);
  nodes.push(click, chp, cg, g, o);
  if (kind !== 'parry') {
    const th = osc(ctx, 'sine', 150, t, t + 0.2);
    th.frequency.exponentialRampToValueAtTime(85, t + 0.08);
    const thg = gainNode(ctx, 0);
    perc(thg.gain, t, kind === 'guardbreak' ? 0.55 : 0.34, 0.001, 0.09);
    th.connect(thg).connect(g);
    nodes.push(th, thg);
  }
  g.connect(o);
  sendTo(ctx, g, rev, kind === 'parry' ? 0.7 : 0.3, nodes);
  cleanup(nodes, stop, ctx);
  return stop;
}

// Blade into cloth and flesh. kill = heavier, with a sub-boom and a ringing tail.
export function slash(ctx, out, t, { kill = false, gain = 0.55, pan = 0, rev = null } = {}) {
  const stop = t + (kill ? 1.0 : 0.3);
  const n = noiseSource(ctx, t, 0.16);
  const lp = filter(ctx, 'lowpass', 2600, 0.9);
  lp.frequency.setValueAtTime(2600, t);
  lp.frequency.exponentialRampToValueAtTime(600, t + 0.1);
  const ng = gainNode(ctx, 0);
  perc(ng.gain, t, 0.7, 0.002, 0.12);
  const th = osc(ctx, 'sine', 110, t, stop);
  th.frequency.exponentialRampToValueAtTime(48, t + 0.14);
  const tg = gainNode(ctx, 0);
  perc(tg.gain, t, kill ? 0.6 : 0.75, 0.002, 0.15);
  const wet = noiseSource(ctx, t + 0.01, 0.2);
  const wbp = filter(ctx, 'bandpass', 460, 2.2);
  const wg = gainNode(ctx, 0);
  perc(wg.gain, t + 0.01, 0.4, 0.004, 0.18);
  const g = gainNode(ctx, gain);
  const o = spatialOut(ctx, out, pan);
  n.connect(lp).connect(ng).connect(g);
  th.connect(tg).connect(g);
  wet.connect(wbp).connect(wg).connect(g);
  g.connect(o);
  const nodes = [n, lp, ng, th, tg, wet, wbp, wg, g, o];
  if (kill) {
    const sub = osc(ctx, 'sine', 62, t, stop);
    sub.frequency.exponentialRampToValueAtTime(36, t + 0.6);
    const sg = gainNode(ctx, 0);
    perc(sg.gain, t + 0.02, 0.55, 0.01, 0.75);
    sub.connect(sg).connect(g);
    nodes.push(sub, sg);
    bell(ctx, out, t + 0.02, 3050, { gain: gain * 0.1, decay: 0.7, pan, rev, revAmt: 0.6 });
  }
  sendTo(ctx, g, rev, kill ? 0.35 : 0.12, nodes);
  cleanup(nodes, stop, ctx);
  return stop;
}

// Enemy telegraph: a bright metallic glint.
export function glint(ctx, out, t, { gain = 0.28, pan = 0, rev = null } = {}) {
  return bell(ctx, out, t, 2637, { gain, pan, rev, revAmt: 0.6, decay: 0.9, ratios: [1, 1.0035, 1.5, 2.0], amps: [1, 0.6, 0.35, 0.25] });
}

// Katana drawn from / returned to the saya.
export function draw(ctx, out, t, { gain = 0.35, pan = 0, rev = null } = {}) {
  const dur = 0.34;
  const n = noiseSource(ctx, t, dur);
  const bp = filter(ctx, 'bandpass', 1800, 5);
  bp.frequency.setValueAtTime(1800, t);
  bp.frequency.exponentialRampToValueAtTime(6200, t + dur);
  const env = gainNode(ctx, 0);
  env.gain.setValueAtTime(0.0001, t);
  env.gain.linearRampToValueAtTime(1, t + dur * 0.7);
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  const g = gainNode(ctx, gain);
  const o = spatialOut(ctx, out, pan);
  n.connect(bp).connect(env).connect(g).connect(o);
  bell(ctx, out, t + dur * 0.8, 2920, { gain: gain * 0.16, decay: 0.8, pan, rev, revAmt: 0.5 });
  cleanup([n, bp, env, g, o], t + dur + 0.1, ctx);
  return t + dur + 0.9;
}

export function sheathe(ctx, out, t, { gain = 0.35, pan = 0 } = {}) {
  const dur = 0.28;
  const n = noiseSource(ctx, t, dur);
  const bp = filter(ctx, 'bandpass', 5200, 4);
  bp.frequency.setValueAtTime(5200, t);
  bp.frequency.exponentialRampToValueAtTime(1800, t + dur);
  const env = gainNode(ctx, 0);
  env.gain.setValueAtTime(0.0001, t);
  env.gain.linearRampToValueAtTime(0.8, t + 0.05);
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  // the tsuba meets the saya: click + wooden knock
  const tc = t + dur + 0.02;
  const c = noiseSource(ctx, tc, 0.03);
  const chp = filter(ctx, 'highpass', 1800);
  const cg = gainNode(ctx, 0);
  perc(cg.gain, tc, 0.9, 0.0005, 0.012);
  const k = osc(ctx, 'sine', 900, tc, tc + 0.12);
  const kg = gainNode(ctx, 0);
  perc(kg.gain, tc, 0.35, 0.001, 0.06);
  const g = gainNode(ctx, gain);
  const o = spatialOut(ctx, out, pan);
  n.connect(bp).connect(env).connect(g);
  c.connect(chp).connect(cg).connect(g);
  k.connect(kg).connect(g);
  g.connect(o);
  const stop = tc + 0.15;
  cleanup([n, bp, env, c, chp, cg, k, kg, g, o], stop, ctx);
  return stop;
}

export function dodge(ctx, out, t, { gain = 0.35, pan = 0 } = {}) {
  const dur = 0.24;
  const n = noiseSource(ctx, t, dur, { type: 'pink' });
  const lp = filter(ctx, 'lowpass', 1100, 0.7);
  lp.frequency.setValueAtTime(1500, t);
  lp.frequency.exponentialRampToValueAtTime(500, t + dur);
  const env = gainNode(ctx, 0);
  env.gain.setValueAtTime(0.0001, t);
  env.gain.linearRampToValueAtTime(1, t + dur * 0.3);
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  const g = gainNode(ctx, gain * 1.4);
  const o = spatialOut(ctx, out, pan);
  n.connect(lp).connect(env).connect(g).connect(o);
  cleanup([n, lp, env, g, o], t + dur + 0.1, ctx);
  footstep(ctx, out, t + dur * 0.8, { surface: 'dirt', speed: 5, gain: gain * 0.9, pan });
  return t + dur + 0.2;
}

export function footstep(ctx, out, t, { surface = 'grass', speed = 1.5, gain = 0.4, pan = 0 } = {}) {
  const k = gain * Math.max(0.28, Math.min(0.85, 0.24 + speed * 0.1));
  const g = gainNode(ctx, k);
  const o = spatialOut(ctx, out, pan);
  const nodes = [g, o];
  const n = noiseSource(ctx, t, 0.2);
  let stop = t + 0.2;
  if (surface === 'stone') {
    const hp = filter(ctx, 'highpass', 2500);
    const ng = gainNode(ctx, 0);
    perc(ng.gain, t, 0.8, 0.001, 0.025);
    const ping = filter(ctx, 'bandpass', rrange(1300, 1700), 9);
    const pg = gainNode(ctx, 0);
    perc(pg.gain, t, 2.2, 0.001, 0.05);
    n.connect(hp).connect(ng).connect(g);
    n.connect(ping).connect(pg).connect(g);
    nodes.push(n, hp, ng, ping, pg);
  } else if (surface === 'dirt') {
    const bp = filter(ctx, 'bandpass', rrange(850, 1300), 1.1);
    const ng = gainNode(ctx, 0);
    perc(ng.gain, t, 0.9, 0.003, 0.07);
    n.connect(bp).connect(ng).connect(g);
    const grit = noiseSource(ctx, t + 0.012, 0.05);
    const ghp = filter(ctx, 'highpass', 3200);
    const gg = gainNode(ctx, 0);
    perc(gg.gain, t + 0.012, 0.4, 0.001, 0.02);
    grit.connect(ghp).connect(gg).connect(g);
    nodes.push(n, bp, ng, grit, ghp, gg);
  } else {
    const bp = filter(ctx, 'bandpass', rrange(1800, 2600), 0.7);
    const ng = gainNode(ctx, 0);
    perc(ng.gain, t, 0.75, 0.005, 0.11);
    n.connect(bp).connect(ng).connect(g);
    nodes.push(n, bp, ng);
    if (speed > 3) {
      const sw = noiseSource(ctx, t, 0.22);
      const shp = filter(ctx, 'highpass', 4200);
      const sg = gainNode(ctx, 0);
      sg.gain.setValueAtTime(0.0001, t);
      sg.gain.linearRampToValueAtTime(0.35, t + 0.05);
      sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      sw.connect(shp).connect(sg).connect(g);
      nodes.push(sw, shp, sg);
      stop = t + 0.25;
    }
  }
  const th = osc(ctx, 'sine', 78, t, t + 0.1);
  const tg = gainNode(ctx, 0);
  perc(tg.gain, t, 0.3, 0.002, 0.05);
  th.connect(tg).connect(g);
  nodes.push(th, tg);
  g.connect(o);
  cleanup(nodes, stop, ctx);
  return stop;
}

// ================================================================================================ world & UI
export function uiClick(ctx, out, t, { gain = 0.22, freq = 1900 } = {}) {
  const n = noiseSource(ctx, t, 0.02);
  const bp = filter(ctx, 'bandpass', freq, 4);
  const ng = gainNode(ctx, 0);
  perc(ng.gain, t, 1, 0.0008, 0.012);
  const s = osc(ctx, 'sine', freq * 1.1, t, t + 0.05);
  s.frequency.exponentialRampToValueAtTime(freq * 0.94, t + 0.015);
  const sg = gainNode(ctx, 0);
  perc(sg.gain, t, 0.35, 0.0008, 0.02);
  const g = gainNode(ctx, gain);
  n.connect(bp).connect(ng).connect(g);
  s.connect(sg).connect(g);
  g.connect(out);
  cleanup([n, bp, ng, s, sg, g], t + 0.08, ctx);
  return t + 0.08;
}

export function shutter(ctx, out, t, { gain = 0.4 } = {}) {
  uiClick(ctx, out, t, { gain, freq: 1400 });
  uiClick(ctx, out, t + 0.07, { gain: gain * 0.8, freq: 900 });
  return t + 0.2;
}

export function whoosh(ctx, out, t, { dur = 0.6, from = 400, to = 1600, gain = 0.3, pan = 0 } = {}) {
  const n = noiseSource(ctx, t, dur, { type: 'pink' });
  const bp = filter(ctx, 'bandpass', from, 0.9);
  bp.frequency.setValueAtTime(from, t);
  bp.frequency.exponentialRampToValueAtTime(to, t + dur);
  const env = gainNode(ctx, 0);
  env.gain.setValueAtTime(0.0001, t);
  env.gain.linearRampToValueAtTime(1, t + dur * 0.55);
  env.gain.linearRampToValueAtTime(0.0001, t + dur);
  const g = gainNode(ctx, gain);
  const o = spatialOut(ctx, out, pan);
  n.connect(bp).connect(env).connect(g).connect(o);
  cleanup([n, bp, env, g, o], t + dur + 0.1, ctx);
  return t + dur;
}

// The guiding wind rising: a long swelling gust with a whistle riding on top.
export function gust(ctx, out, t, { gain = 0.45, pan = 0 } = {}) {
  const dur = 2.8;
  const n = noiseSource(ctx, t, dur, { type: 'pink' });
  const bp = filter(ctx, 'bandpass', 380, 0.8);
  bp.frequency.setValueAtTime(380, t);
  bp.frequency.exponentialRampToValueAtTime(1500, t + dur * 0.45);
  bp.frequency.exponentialRampToValueAtTime(650, t + dur);
  const wh = filter(ctx, 'bandpass', 1400, 11);
  wh.frequency.setValueAtTime(1400, t);
  wh.frequency.exponentialRampToValueAtTime(2600, t + dur * 0.5);
  wh.frequency.exponentialRampToValueAtTime(1700, t + dur);
  const whg = gainNode(ctx, 1.4);
  const env = gainNode(ctx, 0);
  env.gain.setValueAtTime(0.0001, t);
  env.gain.linearRampToValueAtTime(1, t + dur * 0.45);
  env.gain.linearRampToValueAtTime(0.0001, t + dur);
  const g = gainNode(ctx, gain);
  const o = spatialOut(ctx, out, pan);
  n.connect(bp).connect(env);
  n.connect(wh).connect(whg).connect(env);
  env.connect(g).connect(o);
  cleanup([n, bp, wh, whg, env, g, o], t + dur + 0.1, ctx);
  return t + dur;
}

// Slow-motion impact under the kill-cam.
export function boom(ctx, out, t, { gain = 0.6, rev = null } = {}) {
  const stop = t + 1.8;
  const s = osc(ctx, 'sine', 58, t, stop);
  s.frequency.exponentialRampToValueAtTime(30, t + 1.4);
  const sg = gainNode(ctx, 0);
  perc(sg.gain, t, 1, 0.01, 1.5);
  const n = noiseSource(ctx, t, 1.3, { type: 'brown' });
  const lp = filter(ctx, 'lowpass', 220);
  const ng = gainNode(ctx, 0);
  perc(ng.gain, t, 0.9, 0.02, 1.1);
  const g = gainNode(ctx, gain);
  s.connect(sg).connect(g);
  n.connect(lp).connect(ng).connect(g);
  g.connect(out);
  const nodes = [s, sg, n, lp, ng, g];
  sendTo(ctx, g, rev, 0.3, nodes);
  cleanup(nodes, stop, ctx);
  return stop;
}

// A sharp intake of breath (standoff: the instant before the strike).
export function inhale(ctx, out, t, { gain = 0.16 } = {}) {
  return whoosh(ctx, out, t, { dur: 0.32, from: 900, to: 1900, gain });
}

export function heal(ctx, out, t, { gain = 0.3, rev = null } = {}) {
  whoosh(ctx, out, t, { dur: 0.9, from: 500, to: 900, gain: gain * 0.5 });
  [880, 1318.5, 1760].forEach((f, i) => bell(ctx, out, t + 0.25 + i * 0.12, f, { gain: gain * 0.28, decay: 2.0, rev, revAmt: 0.6, ratios: [1, 2.0, 3.01], amps: [1, 0.25, 0.1] }));
  return t + 2.6;
}

// Shrine prayer: shaking the suzu bells, then two claps (kashiwade).
export function suzu(ctx, out, t, { gain = 0.22, rev = null } = {}) {
  const shakes = 14;
  for (let i = 0; i < shakes; i++) {
    const tt = t + i * 0.045 + rrange(0, 0.02);
    const f = rrange(4200, 6200);
    bell(ctx, out, tt, f, { gain: gain * rrange(0.4, 1) * (1 - i / shakes * 0.5), decay: 0.22, rev, revAmt: 0.4, ratios: [1, 1.52, 2.1], amps: [1, 0.4, 0.2], pan: rrange(-0.2, 0.2) });
  }
  return t + shakes * 0.045 + 0.4;
}

export function clap(ctx, out, t, { gain = 0.5, rev = null } = {}) {
  const n = noiseSource(ctx, t, 0.1);
  const bp = filter(ctx, 'bandpass', 1300, 0.9);
  const ng = gainNode(ctx, 0);
  perc(ng.gain, t, 1, 0.001, 0.06);
  const g = gainNode(ctx, gain);
  n.connect(bp).connect(ng).connect(g).connect(out);
  const nodes = [n, bp, ng, g];
  sendTo(ctx, g, rev, 0.55, nodes);
  cleanup(nodes, t + 0.2, ctx);
  return t + 0.2;
}

// ================================================================================================ nature
// Birds: 'tsee' (high thin sweeps), 'warble' (chattering trill), 'hiyodori' (brown-eared bulbul, loud two-note).
export function bird(ctx, out, t, { type = 'tsee', gain = 0.12, pan = 0, rev = null } = {}) {
  const g = gainNode(ctx, gain);
  const o = spatialOut(ctx, out, pan);
  const lp = filter(ctx, 'lowpass', 9000);
  g.connect(lp).connect(o);
  const nodes = [g, lp, o];
  let tt = t;
  const note = (f0, f1, dur, amp = 1, vib = 0) => {
    const s = osc(ctx, 'sine', f0, tt, tt + dur + 0.02);
    s.frequency.exponentialRampToValueAtTime(f1, tt + dur);
    const sg = gainNode(ctx, 0);
    sg.gain.setValueAtTime(0.0001, tt);
    sg.gain.linearRampToValueAtTime(amp, tt + Math.min(0.012, dur * 0.3));
    sg.gain.linearRampToValueAtTime(0.0001, tt + dur);
    if (vib) {
      const l = osc(ctx, 'sine', vib, tt, tt + dur + 0.02);
      const lg = gainNode(ctx, f0 * 0.05);
      l.connect(lg).connect(s.frequency);
      nodes.push(l, lg);
    }
    s.connect(sg).connect(g);
    nodes.push(s, sg);
  };
  if (type === 'tsee') {
    const k = 2 + Math.floor(rand() * 3);
    for (let i = 0; i < k; i++) {
      const f = rrange(6400, 7600);
      note(f, f * 0.8, rrange(0.06, 0.09), 0.8);
      tt += rrange(0.12, 0.18);
    }
  } else if (type === 'warble') {
    const k = 6 + Math.floor(rand() * 6);
    for (let i = 0; i < k; i++) {
      const f = rrange(2400, 4300);
      note(f, f * rrange(0.85, 1.2), rrange(0.05, 0.1), rrange(0.5, 1), rrange(25, 45));
      tt += rrange(0.06, 0.12);
    }
  } else {
    note(3300, 2200, 0.26, 1);
    tt += 0.3;
    note(2750, 2900, 0.2, 0.8);
    tt += 0.24;
  }
  sendTo(ctx, g, rev, 0.25, nodes);
  cleanup(nodes, tt + 0.1, ctx);
  return tt + 0.1;
}

// Autumn insects: suzumushi (bell cricket, sustained ringing trill) and matsumushi ("chin-chirorin").
export function cricket(ctx, out, t, { kind = 'suzu', freq = 4500, dur = 0.5, gain = 0.05, pan = 0 } = {}) {
  const g = gainNode(ctx, gain);
  const o = spatialOut(ctx, out, pan);
  g.connect(o);
  const nodes = [g, o];
  const voice = (t0, d, f, rate) => {
    const s = osc(ctx, 'sine', f, t0, t0 + d + 0.05);
    const am = gainNode(ctx, 0.5);
    const l = osc(ctx, 'triangle', rate, t0, t0 + d + 0.05);
    const lg = gainNode(ctx, 0.5);
    l.connect(lg).connect(am.gain);
    const env = gainNode(ctx, 0);
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(1, t0 + 0.02);
    env.gain.setValueAtTime(1, t0 + Math.max(0.02, d - 0.05));
    env.gain.linearRampToValueAtTime(0.0001, t0 + d);
    s.connect(am).connect(env).connect(g);
    nodes.push(s, am, l, lg, env);
  };
  let end = t + dur;
  if (kind === 'matsu') {
    voice(t, 0.07, freq * 0.9, 60);
    voice(t + 0.13, 0.07, freq * 0.9, 60);
    voice(t + 0.28, 0.22, freq, 80);
    end = t + 0.52;
  } else voice(t, dur, freq, rrange(62, 82));
  cleanup(nodes, end + 0.1, ctx);
  return end;
}

// Distant crow at dusk (kept far and soft).
export function crow(ctx, out, t, { gain = 0.05, pan = 0, rev = null } = {}) {
  const g = gainNode(ctx, gain);
  const o = spatialOut(ctx, out, pan);
  const lp = filter(ctx, 'lowpass', 2200);
  g.connect(lp).connect(o);
  const nodes = [g, lp, o];
  const k = 2 + Math.floor(rand() * 2);
  let tt = t;
  for (let i = 0; i < k; i++) {
    const s = osc(ctx, 'sawtooth', rrange(500, 560), tt, tt + 0.34);
    s.frequency.exponentialRampToValueAtTime(420, tt + 0.3);
    const bp = filter(ctx, 'bandpass', 1150, 3);
    const sg = gainNode(ctx, 0);
    sg.gain.setValueAtTime(0.0001, tt);
    sg.gain.linearRampToValueAtTime(1, tt + 0.03);
    sg.gain.linearRampToValueAtTime(0.0001, tt + 0.3);
    s.connect(bp).connect(sg).connect(g);
    nodes.push(s, bp, sg);
    tt += rrange(0.42, 0.55);
  }
  sendTo(ctx, g, rev, 0.6, nodes);
  cleanup(nodes, tt + 0.1, ctx);
  return tt;
}

// A crow close by (the wildlife module's crows: a call from a treetop, the alarm at a take-off): the jungle crow's
// clear, nasal "kaa", a sawtooth through three formants with a little rasp, the pitch rising then falling, 2–4 calls.
export function caw(ctx, out, t, { n = 3, gain = 0.2, pan = 0, rev = null, pitch = 1 } = {}) {
  const g = gainNode(ctx, gain);
  const o = spatialOut(ctx, out, pan);
  g.connect(o);
  const nodes = [g, o];
  let tt = t;
  for (let i = 0; i < n; i++) {
    const d = rrange(0.26, 0.38);
    const f0 = rrange(470, 540) * pitch;
    const s = osc(ctx, 'sawtooth', f0, tt, tt + d + 0.05);
    s.frequency.linearRampToValueAtTime(f0 * 1.12, tt + d * 0.25);
    s.frequency.exponentialRampToValueAtTime(f0 * 0.8, tt + d);
    // rasp: a fast tremolo of the voice
    const am = gainNode(ctx, 0.75);
    const lfo = osc(ctx, 'square', rrange(55, 80), tt, tt + d + 0.05);
    const lg = gainNode(ctx, 0.25);
    lfo.connect(lg).connect(am.gain);
    const env = gainNode(ctx, 0);
    env.gain.setValueAtTime(0.0001, tt);
    env.gain.linearRampToValueAtTime(1, tt + 0.025);
    env.gain.setValueAtTime(1, tt + d - 0.08);
    env.gain.linearRampToValueAtTime(0.0001, tt + d);
    s.connect(am);
    for (const [f, q, k] of [[950, 2.5, 1], [1700, 3.5, 0.6], [2600, 4, 0.25]]) {
      const bp = filter(ctx, 'bandpass', f * rrange(0.95, 1.05), q);
      const bg = gainNode(ctx, k);
      am.connect(bp).connect(bg).connect(env);
      nodes.push(bp, bg);
    }
    env.connect(g);
    nodes.push(s, am, lfo, lg, env);
    tt += d + rrange(0.18, 0.3);
  }
  sendTo(ctx, g, rev, 0.4, nodes);
  cleanup(nodes, tt + 0.2, ctx);
  return tt;
}

// Wings bursting up: a flock of small birds (many fast beats overlapping: a "frrrt") or one big bird's heavy strokes
// (rate ~4 Hz, low: a crow's "whoomph"). Each voice stands for a few birds; its beats are short band-passed puffs of
// noise at the wingbeat rate, every bird at its own phase, fading as they climb away.
export function wingFlutter(ctx, out, t, { birds = 8, rate = 13, dur = 0.7, freq = 2400, gain = 0.3, pan = 0 } = {}) {
  const g = gainNode(ctx, gain);
  const o = spatialOut(ctx, out, pan);
  g.connect(o);
  const nodes = [g, o];
  const voices = Math.max(1, Math.min(4, birds));
  const beat = Math.min(0.07, 0.55 / rate);
  for (let v = 0; v < voices; v++) {
    const n = noiseSource(ctx, t, dur + 0.15, { type: 'pink' });
    const bp = filter(ctx, 'bandpass', freq * rrange(0.8, 1.25), 1.1);
    const env = gainNode(ctx, 0);
    n.connect(bp).connect(env).connect(g);
    nodes.push(n, bp, env);
    // the beats of this voice's birds, in time order, none overlapping the previous one
    const times = [];
    const per = Math.max(1, Math.round(birds / voices));
    for (let b = 0; b < per; b++) for (let tt = t + rrange(0, 0.15) + rand() / rate; tt < t + dur; tt += 1 / (rate * rrange(0.9, 1.1))) times.push(tt);
    times.sort((a, b) => a - b);
    let last = -1;
    env.gain.setValueAtTime(0.0001, t);
    for (const tt of times) {
      if (tt < last + beat) continue;
      const a = Math.pow(1 - (tt - t) / dur, 1.5) * rrange(0.6, 1);
      env.gain.setValueAtTime(0.0001, tt);
      env.gain.linearRampToValueAtTime(a, tt + beat * 0.25);
      env.gain.exponentialRampToValueAtTime(0.0001, tt + beat);
      last = tt;
    }
  }
  cleanup(nodes, t + dur + 0.2, ctx);
  return t + dur;
}

// The sika deer's alarm (the wildlife module's deer, 'wildlife:alarm'): a short, shrill, squeaky whistle — a pure
// tone around 1.5–2.5 kHz jumping up and falling away, a weaker second harmonic, a breath of noise through it; now
// and then a second, shorter call.
export function sikaWhistle(ctx, out, t, { gain = 0.25, pan = 0, rev = null, pitch = 1, n = 1 } = {}) {
  const g = gainNode(ctx, gain);
  const o = spatialOut(ctx, out, pan);
  g.connect(o);
  const nodes = [g, o];
  let tt = t;
  for (let i = 0; i < n; i++) {
    const d = rrange(0.24, 0.32) * (i ? 0.7 : 1);
    const f0 = rrange(1500, 1750) * pitch;
    const env = gainNode(ctx, 0);
    env.gain.setValueAtTime(0.0001, tt);
    env.gain.linearRampToValueAtTime(1, tt + 0.012);
    env.gain.setValueAtTime(1, tt + d * 0.55);
    env.gain.exponentialRampToValueAtTime(0.0001, tt + d);
    for (const [k, a, type] of [[1, 1, 'sine'], [2, 0.32, 'sine'], [3, 0.08, 'triangle']]) {
      const s = osc(ctx, type, f0 * k, tt, tt + d + 0.05);
      // the squeak: up a fifth in a few milliseconds, then sliding down below where it started
      s.frequency.linearRampToValueAtTime(f0 * k * 1.45, tt + 0.035);
      s.frequency.exponentialRampToValueAtTime(f0 * k * 0.92, tt + d);
      const sg = gainNode(ctx, a);
      s.connect(sg).connect(env);
      nodes.push(s, sg);
    }
    const nz = noiseSource(ctx, tt, d + 0.05);
    const bp = filter(ctx, 'bandpass', f0 * 1.8, 2.5);
    const ng = gainNode(ctx, 0.12);
    nz.connect(bp).connect(ng).connect(env);
    env.connect(g);
    nodes.push(nz, bp, ng, env);
    tt += d + rrange(0.35, 0.6);
  }
  sendTo(ctx, g, rev, 0.45, nodes);
  cleanup(nodes, tt + 0.3, ctx);
  return tt;
}

// The red fox's alarm bark: a short, hoarse "wow" falling in pitch, a buzz in it, through the formants of a small
// throat; one to three barks half a second apart.
export function foxBark(ctx, out, t, { n = 2, gain = 0.2, pan = 0, rev = null, pitch = 1 } = {}) {
  const g = gainNode(ctx, gain);
  const o = spatialOut(ctx, out, pan);
  g.connect(o);
  const nodes = [g, o];
  let tt = t;
  for (let i = 0; i < n; i++) {
    const d = rrange(0.11, 0.16);
    const f0 = rrange(560, 680) * pitch;
    const s = osc(ctx, 'sawtooth', f0, tt, tt + d + 0.05);
    s.frequency.linearRampToValueAtTime(f0 * 1.15, tt + d * 0.2);
    s.frequency.exponentialRampToValueAtTime(f0 * 0.6, tt + d);
    // the hoarse buzz: a fast flutter of the voice
    const am = gainNode(ctx, 0.7);
    const lfo = osc(ctx, 'square', rrange(70, 95), tt, tt + d + 0.05);
    const lg = gainNode(ctx, 0.3);
    lfo.connect(lg).connect(am.gain);
    const env = gainNode(ctx, 0);
    env.gain.setValueAtTime(0.0001, tt);
    env.gain.linearRampToValueAtTime(1, tt + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, tt + d);
    s.connect(am);
    for (const [f, q, k] of [[900, 3, 1], [1600, 4, 0.7], [2900, 5, 0.3]]) {
      const bp = filter(ctx, 'bandpass', f * rrange(0.95, 1.08), q);
      const bg = gainNode(ctx, k);
      am.connect(bp).connect(bg).connect(env);
      nodes.push(bp, bg);
    }
    // breath noise through the bark
    const nz = noiseSource(ctx, tt, d + 0.04);
    const hp = filter(ctx, 'bandpass', 2200, 1.2);
    const ng = gainNode(ctx, 0.22);
    nz.connect(hp).connect(ng).connect(env);
    env.connect(g);
    nodes.push(s, am, lfo, lg, env, nz, hp, ng);
    tt += d + rrange(0.38, 0.6);
  }
  sendTo(ctx, g, rev, 0.35, nodes);
  cleanup(nodes, tt + 0.25, ctx);
  return tt;
}

// A deer's foot stamped in alarm: a dull thump of a hoof on the turf, a little grit.
export function stamp(ctx, out, t, { gain = 0.3, pan = 0 } = {}) {
  const g = gainNode(ctx, gain);
  const o = spatialOut(ctx, out, pan);
  g.connect(o);
  const s = osc(ctx, 'sine', 140, t, t + 0.12);
  s.frequency.exponentialRampToValueAtTime(55, t + 0.08);
  const sg = gainNode(ctx, 0);
  perc(sg.gain, t, 1, 0.002, 0.07);
  s.connect(sg).connect(g);
  const nz = noiseSource(ctx, t, 0.05);
  const lp = filter(ctx, 'lowpass', 1400);
  const ng = gainNode(ctx, 0);
  perc(ng.gain, t, 0.35, 0.001, 0.03);
  nz.connect(lp).connect(ng).connect(g);
  cleanup([g, o, s, sg, nz, lp, ng], t + 0.2, ctx);
  return t + 0.12;
}

// Fire crackle: a single pop.
export function crackle(ctx, out, t, { gain = 0.12, pan = 0 } = {}) {
  const n = noiseSource(ctx, t, 0.03);
  const hp = filter(ctx, 'highpass', rrange(1200, 3500));
  const g = gainNode(ctx, 0);
  perc(g.gain, t, gain, 0.0005, rrange(0.006, 0.02));
  const o = spatialOut(ctx, out, pan);
  n.connect(hp).connect(g).connect(o);
  cleanup([n, hp, g, o], t + 0.05, ctx);
  return t + 0.05;
}

// ================================================================================================ horse
// Hoofbeat: the weight of the strike (a pitch-dropping thump) and the horn on the ground — grass muffled with a swish
// of stems, dirt dull with grit, stone a hard clack that rings. Heavier and lower than a footstep; one per hoof.
export function hoof(ctx, out, t, { surface = 'grass', speed = 2, gain = 0.5, pan = 0 } = {}) {
  const k = gain * Math.max(0.35, Math.min(1, 0.3 + speed * 0.06));
  const g = gainNode(ctx, k);
  const o = spatialOut(ctx, out, pan);
  const nodes = [g, o];
  const th = osc(ctx, 'sine', rrange(105, 130), t, t + 0.2);
  th.frequency.exponentialRampToValueAtTime(50, t + 0.09);
  const tg = gainNode(ctx, 0);
  perc(tg.gain, t, surface === 'stone' ? 0.5 : 0.85, 0.002, 0.11);
  th.connect(tg).connect(g);
  nodes.push(th, tg);
  const n = noiseSource(ctx, t, 0.25);
  if (surface === 'stone') {
    const bp = filter(ctx, 'bandpass', rrange(2200, 3000), 2.5);
    const ng = gainNode(ctx, 0);
    perc(ng.gain, t, 1.0, 0.0008, 0.035);
    const ring = filter(ctx, 'bandpass', rrange(1150, 1450), 14);
    const rg = gainNode(ctx, 0);
    perc(rg.gain, t, 2.4, 0.001, 0.09);
    n.connect(bp).connect(ng).connect(g);
    n.connect(ring).connect(rg).connect(g);
    nodes.push(n, bp, ng, ring, rg);
  } else if (surface === 'dirt') {
    const bp = filter(ctx, 'bandpass', rrange(500, 800), 1.2);
    const ng = gainNode(ctx, 0);
    perc(ng.gain, t, 1.0, 0.002, 0.08);
    n.connect(bp).connect(ng).connect(g);
    const grit = noiseSource(ctx, t + 0.01, 0.08);
    const ghp = filter(ctx, 'highpass', 2600);
    const gg = gainNode(ctx, 0);
    perc(gg.gain, t + 0.01, 0.35, 0.001, 0.04);
    grit.connect(ghp).connect(gg).connect(g);
    nodes.push(n, bp, ng, grit, ghp, gg);
  } else {
    const lp = filter(ctx, 'lowpass', rrange(700, 1000), 0.8);
    const ng = gainNode(ctx, 0);
    perc(ng.gain, t, 0.8, 0.004, 0.09);
    n.connect(lp).connect(ng).connect(g);
    // stems swept aside
    const sw = noiseSource(ctx, t, 0.24);
    const shp = filter(ctx, 'highpass', 3800);
    const sg = gainNode(ctx, 0);
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.linearRampToValueAtTime(0.18 + 0.02 * Math.min(speed, 14), t + 0.04);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    sw.connect(shp).connect(sg).connect(g);
    nodes.push(n, lp, ng, sw, shp, sg);
  }
  g.connect(o);
  cleanup(nodes, t + 0.26, ctx);
  return t + 0.26;
}

// A snort: air blown hard through the nostrils, fluttering, falling in pitch.
export function snort(ctx, out, t, { gain = 0.3, pan = 0 } = {}) {
  const dur = 0.55;
  const n = noiseSource(ctx, t, dur);
  const bp = filter(ctx, 'bandpass', 700, 1.6);
  bp.frequency.setValueAtTime(700, t);
  bp.frequency.exponentialRampToValueAtTime(380, t + dur);
  const lp = filter(ctx, 'lowpass', 2400);
  const am = gainNode(ctx, 0.6);
  const flut = osc(ctx, 'sine', rrange(26, 34), t, t + dur);
  const fg = gainNode(ctx, 0.4);
  flut.connect(fg).connect(am.gain);
  const env = gainNode(ctx, 0);
  env.gain.setValueAtTime(0.0001, t);
  env.gain.linearRampToValueAtTime(1, t + 0.04);
  env.gain.setTargetAtTime(0.0001, t + 0.12, 0.12);
  const g = gainNode(ctx, gain);
  const o = spatialOut(ctx, out, pan);
  n.connect(bp).connect(lp).connect(am).connect(env).connect(g).connect(o);
  cleanup([n, bp, lp, am, flut, fg, env, g, o], t + dur + 0.1, ctx);
  return t + dur;
}

// The breath of a galloping horse: a short exhale with each stride (k: 0 canter .. 1 full gallop).
export function horseBreath(ctx, out, t, { gain = 0.2, pan = 0, k = 1 } = {}) {
  const dur = 0.2;
  const n = noiseSource(ctx, t, dur, { type: 'pink' });
  const bp = filter(ctx, 'bandpass', 420 + 120 * k, 1.1);
  const env = gainNode(ctx, 0);
  env.gain.setValueAtTime(0.0001, t);
  env.gain.linearRampToValueAtTime(1, t + 0.03);
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  const g = gainNode(ctx, gain * (0.6 + 0.4 * k));
  const o = spatialOut(ctx, out, pan);
  n.connect(bp).connect(env).connect(g).connect(o);
  cleanup([n, bp, env, g, o], t + dur + 0.1, ctx);
  return t + dur;
}

// The samurai's call: a two-note fingers whistle, up then falling away.
export function whistle(ctx, out, t, { gain = 0.22, rev = null } = {}) {
  const g = gainNode(ctx, gain);
  g.connect(out);
  const nodes = [g];
  const tone = (t0, f0, f1, f2, dur) => {
    const o = osc(ctx, 'sine', f0, t0, t0 + dur + 0.02);
    o.frequency.exponentialRampToValueAtTime(f1, t0 + dur * 0.3);
    o.frequency.exponentialRampToValueAtTime(f2, t0 + dur);
    const e = gainNode(ctx, 0);
    e.gain.setValueAtTime(0.0001, t0);
    e.gain.linearRampToValueAtTime(1, t0 + 0.03);
    e.gain.setValueAtTime(1, t0 + dur * 0.7);
    e.gain.linearRampToValueAtTime(0.0001, t0 + dur);
    o.connect(e).connect(g);
    nodes.push(o, e);
  };
  tone(t, 1700, 2500, 2350, 0.22);
  tone(t + 0.28, 2400, 2600, 1650, 0.38);
  const n = noiseSource(ctx, t, 0.7);
  const bp = filter(ctx, 'bandpass', 2300, 3);
  const ng = gainNode(ctx, 0.05);
  n.connect(bp).connect(ng).connect(g);
  nodes.push(n, bp, ng);
  sendTo(ctx, g, rev, 0.35, nodes);
  cleanup(nodes, t + 0.75, ctx);
  return t + 0.7;
}

// A whinny: a bright, shaking cry that climbs, then falls away.
export function neigh(ctx, out, t, { gain = 0.25, pan = 0, rev = null } = {}) {
  const dur = 1.15;
  const stop = t + dur + 0.1;
  const src = osc(ctx, 'sawtooth', 820, t, stop);
  src.frequency.linearRampToValueAtTime(1050, t + 0.12);
  src.frequency.exponentialRampToValueAtTime(700, t + 0.6);
  src.frequency.exponentialRampToValueAtTime(420, t + dur);
  const vib = osc(ctx, 'sine', 11, t, stop);
  const vg = gainNode(ctx, 45);
  vib.connect(vg).connect(src.frequency);
  const f1 = filter(ctx, 'bandpass', 1100, 3);
  const f2 = filter(ctx, 'bandpass', 2400, 4);
  const mix = gainNode(ctx, 1);
  src.connect(f1).connect(mix);
  src.connect(f2).connect(mix);
  // the shake of the voice, then the envelope
  const am = gainNode(ctx, 0.75);
  const trem = osc(ctx, 'sine', 9, t, stop);
  const tg = gainNode(ctx, 0.25);
  trem.connect(tg).connect(am.gain);
  const env = gainNode(ctx, 0);
  env.gain.setValueAtTime(0.0001, t);
  env.gain.linearRampToValueAtTime(0.9, t + 0.08);
  env.gain.linearRampToValueAtTime(0.6, t + 0.7);
  env.gain.linearRampToValueAtTime(0.0001, t + dur);
  const g = gainNode(ctx, gain * 0.5);
  const o = spatialOut(ctx, out, pan);
  mix.connect(am).connect(env).connect(g).connect(o);
  const nodes = [src, vib, vg, f1, f2, mix, am, trem, tg, env, g, o];
  sendTo(ctx, g, rev, 0.3, nodes);
  cleanup(nodes, stop, ctx);
  return stop;
}

// ================================================================================================ util
function tanhCurve(k) {
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * k) / Math.tanh(k);
  }
  return c;
}

export { pick };
