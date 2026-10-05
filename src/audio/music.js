import { koto, shakuhachi, taiko, shime, pad } from './instruments.js';
import { rand, rrange, pick, gainNode } from './dsp.js';

// Generative score in the miyako-bushi ("in") scale on D: D Eb G A Bb. Silence (ma) is part of the music.
// Moods: 'silent' | 'title' | 'explore' | 'combat' | 'standoff' | 'death' | 'ending'.
// update(now, horizon) schedules every event that starts before now + horizon — the live engine calls it
// ~20×/s with a short lookahead; the offline self-test calls it once with a long horizon.

const ROOT = 50; // D3
const IN = [0, 1, 5, 7, 8];
const inScale = (m) => IN.includes((((m - ROOT) % 12) + 12) % 12);
const range = (lo, hi) => {
  const a = [];
  for (let m = lo; m <= hi; m++) if (inScale(m)) a.push(m);
  return a;
};
const KOTO = range(50, 81); // D3 .. A5
const SHAKU = range(62, 86); // D4 .. D6
const STABLE = new Set([50, 57, 62, 69, 74, 81]); // D and A

// Main theme (koto): [midi, beats, bend?]  — answered by the shakuhachi.
const THEME = [
  [69, 1], [70, 0.5], [69, 0.5], [67, 1], [62, 2],
  [67, 0.5], [69, 0.5], [70, 1], [74, 1.5], [75, 0.5], [74, 2.5, 1],
];
const ANSWER = [
  [74, 3.2], [70, 1.4], [69, 3.6],
];

const RHYTHMS = [
  [1, 1, 2],
  [0.5, 0.5, 1, 2],
  [1, 0.5, 0.5, 1, 2.5],
  [1.5, 0.5, 2],
  [0.5, 0.5, 0.5, 0.5, 1, 3],
  [2, 1, 1, 3],
];

const MOODS = {
  silent: { melody: 0, drone: 0, drums: 0, tempo: 64 },
  title: { melody: 1, drone: 0.9, drums: 0, tempo: 64 },
  explore: { melody: 0.8, drone: 0.75, drums: 0, tempo: 60 },
  combat: { melody: 0.55, drone: 0.4, drums: 1, tempo: 96 },
  standoff: { melody: 0, drone: 0.22, drums: 0, tempo: 60 },
  death: { melody: 0.5, drone: 1, drums: 0, tempo: 50 },
  ending: { melody: 1, drone: 1, drums: 0, tempo: 60 },
};

export class Music {
  constructor(ctx, out, rev) {
    this.ctx = ctx;
    this.rev = rev;
    this.layers = { melody: gainNode(ctx, 0), drone: gainNode(ctx, 0), drums: gainNode(ctx, 0) };
    for (const k in this.layers) this.layers[k].connect(out);
    this.mood = 'silent';
    this.nextKoto = Infinity;
    this.nextShaku = Infinity;
    this.padUntil = 0;
    this.nextStep = Infinity;
    this.step = 0;
    this.phrases = 0;
    this.themePending = false;
  }

  setMood(mood, now = this.ctx.currentTime) {
    if (!MOODS[mood] || mood === this.mood) return;
    const prev = this.mood;
    this.mood = mood;
    const m = MOODS[mood];
    const tc = mood === 'standoff' ? 0.35 : mood === 'combat' ? 0.5 : 1.4;
    for (const k of ['melody', 'drone', 'drums']) this.layers[k].gain.setTargetAtTime(m[k] * LEVEL[k], now, tc);
    // restart the voices that belong to this mood
    if (mood === 'title' || mood === 'ending') {
      this.themePending = true;
      this.nextKoto = now + (prev === 'silent' ? 0.4 : 1.2);
      this.nextShaku = Infinity;
    } else if (mood === 'explore') {
      this.nextKoto = now + rrange(5, 10);
      this.nextShaku = now + rrange(14, 26);
    } else if (mood === 'combat') {
      this.nextStep = now + 0.05;
      this.step = 0;
      this.nextKoto = Infinity;
      this.nextShaku = Infinity;
    } else if (mood === 'death') {
      this.nextKoto = now + 1.2;
      this.nextShaku = Infinity;
      this.padUntil = 0; // swell a new low cluster right away
    } else {
      this.nextKoto = Infinity;
      this.nextShaku = Infinity;
    }
    if (mood !== 'combat') this.nextStep = Infinity;
  }

  beat() {
    return 60 / MOODS[this.mood].tempo;
  }

  update(now = this.ctx.currentTime, horizon = 0.35) {
    const H = now + horizon;
    const mood = this.mood;
    if (mood === 'silent') return;
    // drone bed: overlapping 16 s clusters
    let guard = 0;
    while (this.padUntil < H && guard++ < 16) {
      const start = Math.max(now, this.padUntil);
      const cluster =
        mood === 'death' ? [38, 45, 51] : mood === 'combat' ? [38, 45] : mood === 'standoff' ? [38] : pick([[50, 57, 62], [50, 57, 63], [50, 55, 62], [45, 50, 57]]);
      pad(this.ctx, this.layers.drone, start, 14, cluster, { gain: 0.1, attack: 4, release: 5, cutoff: mood === 'death' ? 500 : 800, rev: this.rev, revAmt: 0.4 });
      this.padUntil = start + 13;
    }
    // koto
    guard = 0;
    while (this.nextKoto < H && guard++ < 32) {
      const t = this.nextKoto;
      let end;
      if (mood === 'death') {
        end = this._note(t, 50, 0.4, 0) + 30;
      } else if (this.themePending) {
        end = this._theme(t);
        this.themePending = false;
        this.nextShaku = end - this.beat() * 0.5;
      } else {
        end = this._phrase(t);
      }
      this.phrases++;
      const rest = mood === 'explore' ? rrange(8, 18) : mood === 'title' || mood === 'ending' ? rrange(2.5, 5) : 30;
      this.nextKoto = end + rest;
      if ((mood === 'title' || mood === 'ending') && this.phrases % 4 === 0) this.themePending = true;
    }
    // shakuhachi
    guard = 0;
    while (this.nextShaku < H && guard++ < 16) {
      const t = this.nextShaku;
      const end = this.themeAnswerDue ? this._answer(t) : this._shakuPhrase(t);
      this.nextShaku = end + (mood === 'explore' ? rrange(20, 42) : rrange(6, 12));
    }
    // combat drums + low ostinato
    guard = 0;
    while (this.nextStep < H && guard++ < 64) {
      this._drumStep(this.nextStep, this.step);
      this.step = (this.step + 1) % 16;
      this.nextStep += this.beat() / 2; // eighth notes
    }
  }

  get themeAnswerDue() {
    return this.mood === 'title' || this.mood === 'ending' ? this.phrases % 4 === 1 : false;
  }

  _note(t, midi, gain, pan = rrange(-0.25, 0.25), bend = 0) {
    return koto(this.ctx, this.layers.melody, t, midi, { gain, pan, bend, bendAt: 0.35, rev: this.rev, revAmt: 0.38 });
  }

  _theme(t) {
    const b = this.beat();
    let tt = t;
    for (const [m, beats, bend] of THEME) {
      this._note(tt, m, 0.36, rrange(-0.15, 0.15), bend ? 1 : 0);
      tt += beats * b * rrange(0.97, 1.05);
    }
    return tt;
  }

  _answer(t) {
    const b = this.beat();
    let tt = t;
    for (const [m, beats] of ANSWER) {
      const d = beats * b;
      shakuhachi(this.ctx, this.layers.melody, tt, m, d * 0.96, { gain: 0.2, rev: this.rev, muraiki: tt === t });
      tt += d;
    }
    return tt;
  }

  _phrase(t) {
    const b = this.beat() * rrange(0.95, 1.08);
    const rh = pick(RHYTHMS);
    let i = KOTO.indexOf(pick([62, 67, 69, 70, 74]));
    if (i < 0) i = 8;
    let tt = t;
    rh.forEach((beats, k) => {
      const last = k === rh.length - 1;
      if (last) {
        // resolve to the nearest stable tone
        let best = i;
        for (let d = 0; d < 4; d++) {
          if (KOTO[i - d] && STABLE.has(KOTO[i - d])) { best = i - d; break; }
          if (KOTO[i + d] && STABLE.has(KOTO[i + d])) { best = i + d; break; }
        }
        i = best;
      } else {
        const step = pick([-2, -1, -1, 1, 1, 2, 0]);
        i = Math.max(2, Math.min(KOTO.length - 1, i + step));
      }
      const m = KOTO[i];
      const long = beats >= 2;
      this._note(tt, m, rrange(0.24, 0.36), undefined, long && rand() < 0.3 ? 1 : 0);
      if (last && rand() < 0.5) this._note(tt + 0.012, m - 12, 0.2); // awase: octave doubling at the cadence
      tt += beats * b;
    });
    return tt;
  }

  _shakuPhrase(t) {
    const n = 1 + Math.floor(rand() * 3);
    let tt = t;
    let i = SHAKU.indexOf(pick([69, 70, 74]));
    if (i < 0) i = 5;
    for (let k = 0; k < n; k++) {
      const d = rrange(1.8, 4.6);
      shakuhachi(this.ctx, this.layers.melody, tt, SHAKU[i], d, { gain: 0.17, pan: rrange(-0.2, 0.2), rev: this.rev, muraiki: k === 0 && rand() < 0.5 });
      tt += d + rrange(0.1, 0.5);
      i = Math.max(0, Math.min(SHAKU.length - 1, i + pick([-2, -1, 1])));
    }
    return tt;
  }

  _drumStep(t, s) {
    const L = this.layers.drums;
    // don . . don | don . don . || don . . don | . don don don
    const big = [0, 3, 4, 6, 8, 11, 13, 14, 15];
    if (big.includes(s)) taiko(this.ctx, L, t, { gain: s === 0 || s === 8 ? 0.8 : 0.5, size: s === 0 ? 1.25 : 1, pan: rrange(-0.1, 0.1), rev: this.rev });
    if (s % 2 === 1) shime(this.ctx, L, t, { gain: s % 4 === 3 ? 0.22 : 0.14, pan: 0.25 });
    // low koto ostinato on the beat
    if (s % 2 === 0) {
      const osti = [50, 57, 58, 57, 50, 57, 55, 57];
      koto(this.ctx, this.layers.melody, t, osti[(s / 2) % 8], { gain: 0.26, pan: -0.15, rev: this.rev, revAmt: 0.15 });
    }
  }
}

// relative loudness of each layer at mood level 1
const LEVEL = { melody: 1, drone: 0.8, drums: 0.9 };
