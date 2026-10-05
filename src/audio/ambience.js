import { pinkNoise, brownNoise, whiteNoise, filter, gainNode, rand, rrange, pick } from './dsp.js';
import { bird, cricket, crow, crackle } from './instruments.js';

// Continuous soundscape. Beds (wind, grass, surf, fire) are looping noise through filters whose levels follow
// the world; discrete voices (birds, insects, crows, crackles) are scheduled with a lookahead.
// set(state) → targets; update(now, horizon) → schedules voices.
//   state = { wind: 0..~1.7, guide: 0..1, grass: 0..1, sea: 0..1, fire: 0..1, firePan, windPan, hour, standoff }

const smooth = (p, v, now, tc = 0.35) => p.setTargetAtTime(v, now, tc);
const sstep = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function loop(ctx, buffer, rate = 1) {
  const s = ctx.createBufferSource();
  s.buffer = buffer;
  s.loop = true;
  s.playbackRate.value = rate;
  s.start(0, rand() * buffer.duration);
  return s;
}

export class Ambience {
  constructor(ctx, out, rev) {
    this.ctx = ctx;
    this.out = out;
    this.rev = rev;
    // ---- wind: body (low), air (mid band), whistle (narrow, only in strong gusts / guided wind)
    this.windPan = ctx.createStereoPanner ? ctx.createStereoPanner() : gainNode(ctx, 1);
    this.windPan.connect(out);
    const w = loop(ctx, pinkNoise(ctx));
    this.wLow = filter(ctx, 'lowpass', 300, 0.4);
    this.gLow = gainNode(ctx, 0);
    this.wAir = filter(ctx, 'bandpass', 900, 0.8);
    this.gAir = gainNode(ctx, 0);
    this.wWhistle = filter(ctx, 'bandpass', 1800, 13);
    this.gWhistle = gainNode(ctx, 0);
    w.connect(this.wLow).connect(this.gLow).connect(this.windPan);
    w.connect(this.wAir).connect(this.gAir).connect(this.windPan);
    w.connect(this.wWhistle).connect(this.gWhistle).connect(this.windPan);
    const wb = loop(ctx, brownNoise(ctx), 0.8);
    this.gRumble = gainNode(ctx, 0);
    wb.connect(filter(ctx, 'lowpass', 140, 0.5)).connect(this.gRumble).connect(this.windPan);
    // ---- grass rustle (high, airy)
    const gsrc = loop(ctx, whiteNoise(ctx));
    this.gGrass = gainNode(ctx, 0);
    gsrc.connect(filter(ctx, 'highpass', 2600)).connect(filter(ctx, 'bandpass', 5200, 0.55)).connect(this.gGrass).connect(out);
    // ---- surf: deep wash + hiss, swelling with each wave
    const sb = loop(ctx, brownNoise(ctx), 0.6);
    this.gSurf = gainNode(ctx, 0);
    this.gWave = gainNode(ctx, 0);
    sb.connect(filter(ctx, 'lowpass', 650, 0.5)).connect(this.gWave).connect(this.gSurf).connect(out);
    const sh = loop(ctx, pinkNoise(ctx), 0.9);
    this.gHiss = gainNode(ctx, 0);
    sh.connect(filter(ctx, 'highpass', 2800)).connect(this.gHiss).connect(this.gWave);
    // ---- camp fire: low roar (crackles are scheduled)
    this.firePan = ctx.createStereoPanner ? ctx.createStereoPanner() : gainNode(ctx, 1);
    this.firePan.connect(out);
    const fb = loop(ctx, brownNoise(ctx), 1.3);
    this.gFire = gainNode(ctx, 0);
    fb.connect(filter(ctx, 'lowpass', 320, 0.6)).connect(this.gFire).connect(this.firePan);

    this.state = { wind: 0.6, guide: 0, grass: 0.5, sea: 0, fire: 0, firePan: 0, windPan: 0, hour: 17.7, standoff: false, active: true };
    this.next = { bird: 0, cricket: [], crow: 0, wave: 0, crackle: 0 };
    for (let i = 0; i < 5; i++) this.next.cricket.push(0);
  }

  set(s, now = this.ctx.currentTime) {
    Object.assign(this.state, s);
    const st = this.state;
    const W = Math.max(0, st.wind) * (st.standoff ? 1.35 : 1);
    const G = st.guide;
    const on = st.active ? 1 : 0;
    smooth(this.gLow.gain, on * (0.07 + 0.13 * W + 0.14 * G), now);
    smooth(this.wLow.frequency, 220 + 240 * W + 320 * G, now);
    smooth(this.gAir.gain, on * (0.012 + 0.05 * Math.pow(W, 1.5) + 0.09 * G), now);
    smooth(this.wAir.frequency, 650 + 850 * W + 900 * G, now);
    smooth(this.gWhistle.gain, on * (Math.max(0, W - 0.85) * 0.05 + G * 0.045), now, 0.6);
    smooth(this.wWhistle.frequency, 1500 + 700 * W + 800 * G + Math.sin(now * 0.37) * 180, now, 0.6);
    smooth(this.gRumble.gain, on * (0.04 + 0.05 * W + 0.06 * G), now);
    smooth(this.gGrass.gain, on * st.grass * (0.012 + 0.03 * W + 0.03 * G), now);
    smooth(this.gSurf.gain, on * st.sea * 0.5, now, 0.8);
    smooth(this.gHiss.gain, 0.25, now);
    smooth(this.gFire.gain, on * st.fire * 0.35, now, 0.5);
    if (this.windPan.pan) smooth(this.windPan.pan, st.windPan, now, 0.8);
    if (this.firePan.pan) smooth(this.firePan.pan, st.firePan, now, 0.3);
  }

  update(now = this.ctx.currentTime, horizon = 0.4) {
    const st = this.state;
    if (!st.active) return;
    const H = now + horizon;
    const h = st.hour;
    const day = sstep(6, 8, h) * (1 - sstep(17.9, 19.2, h));
    const dusk = sstep(16.9, 18.3, h) + (h > 19 || h < 5 ? 1 : 0);
    const calm = st.standoff ? 0.15 : 1;
    const ctx = this.ctx;
    let guard = 0;
    // birds (day)
    while (this.next.bird < H && guard++ < 8) {
      const t = Math.max(now, this.next.bird);
      if (day * calm > 0.05) bird(ctx, this.out, t, { type: pick(['tsee', 'tsee', 'warble', 'hiyodori']), gain: 0.07 * day * calm, pan: rrange(-0.8, 0.8), rev: this.rev });
      this.next.bird = t + rrange(2.5, 9) / Math.max(0.3, day);
    }
    // insects (dusk / night): a chorus of 5 independent voices
    this.next.cricket.forEach((nt, i) => {
      let g2 = 0;
      while (this.next.cricket[i] < H && g2++ < 8) {
        const t = Math.max(now, this.next.cricket[i]);
        if (dusk * calm > 0.05) {
          const kind = i === 4 ? 'matsu' : 'suzu';
          cricket(ctx, this.out, t, { kind, freq: 4300 + i * 110 + rrange(-30, 30), dur: rrange(0.28, 0.6), gain: 0.03 * Math.min(1, dusk) * calm, pan: rrange(-0.9, 0.9) });
        }
        this.next.cricket[i] = t + (i === 4 ? rrange(2.5, 5) : rrange(0.7, 1.6));
      }
      void nt;
    });
    // distant crows at dusk
    guard = 0;
    while (this.next.crow < H && guard++ < 4) {
      const t = Math.max(now, this.next.crow);
      if (dusk > 0.2 && h < 19.5 && calm > 0.5) crow(ctx, this.out, t, { gain: 0.035, pan: rrange(-0.9, 0.9), rev: this.rev });
      this.next.crow = t + rrange(25, 60);
    }
    // waves (surf swells)
    guard = 0;
    while (this.next.wave < H && guard++ < 4) {
      const t = Math.max(now, this.next.wave);
      const per = rrange(5.5, 8.5);
      const g = this.gWave.gain;
      g.setTargetAtTime(1, t, per * 0.18);
      g.setTargetAtTime(0.25, t + per * 0.45, per * 0.22);
      this.next.wave = t + per;
    }
    // fire crackles
    guard = 0;
    while (this.next.crackle < H && guard++ < 24) {
      const t = Math.max(now, this.next.crackle);
      if (st.fire > 0.02) crackle(ctx, this.out, t, { gain: 0.16 * st.fire, pan: st.firePan + rrange(-0.1, 0.1) });
      this.next.crackle = t + rrange(0.04, 0.5);
    }
  }
}
