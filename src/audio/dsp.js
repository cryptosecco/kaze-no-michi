// DSP building blocks shared by the live engine and OfflineAudioContext self-tests. Every buffer is cached per
// BaseAudioContext (sample rates may differ) and generated procedurally: no audio files ship with the game.

const caches = new WeakMap();

function cache(ctx) {
  let c = caches.get(ctx);
  if (!c) caches.set(ctx, (c = { plucks: new Map() }));
  return c;
}

let seed = 0x9e3779b9;
export function rand() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return ((seed >>> 0) % 1000000) / 1000000;
}
export const rrange = (a, b) => a + (b - a) * rand();
export const pick = (arr) => arr[Math.floor(rand() * arr.length) % arr.length];

// ------------------------------------------------------------------------------------------------ noise
export function whiteNoise(ctx) {
  const c = cache(ctx);
  if (c.white) return c.white;
  const len = Math.floor(ctx.sampleRate * 2);
  const b = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return (c.white = b);
}

// Stereo pink noise (Paul Kellet's filter), channels decorrelated — the base of wind and surf beds.
export function pinkNoise(ctx) {
  const c = cache(ctx);
  if (c.pink) return c.pink;
  const len = Math.floor(ctx.sampleRate * 6);
  const n = Math.floor(ctx.sampleRate * 0.25);
  const b = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const raw = new Float32Array(len + n);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < raw.length; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      raw[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    loopable(raw, b.getChannelData(ch), n);
  }
  return (c.pink = b);
}

// Brown (red) noise: deep rumble for surf, fire roar and the wind's body.
export function brownNoise(ctx) {
  const c = cache(ctx);
  if (c.brown) return c.brown;
  const len = Math.floor(ctx.sampleRate * 5);
  const n = Math.floor(ctx.sampleRate * 0.3);
  const b = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const raw = new Float32Array(len + n);
    let last = 0;
    for (let i = 0; i < raw.length; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      raw[i] = last * 3.2;
    }
    loopable(raw, b.getChannelData(ch), n);
  }
  return (c.brown = b);
}

// Seamless loop: out = raw[0 .. len) with the head crossfaded from raw's extra n-sample tail, so that
// out[len-1] → out[0] continues exactly like raw[len-1] → raw[len].
function loopable(raw, out, n) {
  const len = out.length;
  for (let i = 0; i < len; i++) {
    if (i < n) {
      const t = i / n;
      out[i] = raw[i] * t + raw[len + i] * (1 - t);
    } else out[i] = raw[i];
  }
}

// ------------------------------------------------------------------------------------------------ reverb
// Stereo impulse response of a wooden hall / open valley: early reflections, then a decaying tail whose
// high frequencies die faster (air absorption).
export function impulseResponse(ctx, seconds = 3.2) {
  const c = cache(ctx);
  if (c.ir) return c.ir;
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const b = ctx.createBuffer(2, len, sr);
  const taps = [0.011, 0.019, 0.027, 0.041, 0.053, 0.067, 0.083];
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    let y = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const env = Math.exp(-t / (seconds * 0.24));
      const a = 0.62 * Math.exp(-t * 2.2) + 0.05; // one-pole lowpass coefficient closing over time
      y += a * ((Math.random() * 2 - 1) - y);
      d[i] = y * env * (t < 0.008 ? t / 0.008 : 1);
    }
    for (const tp of taps) {
      const i = Math.floor((tp + (ch ? 0.0031 : 0)) * sr);
      if (i < len) d[i] += (ch ? -1 : 1) * 0.5 * Math.exp(-tp * 30);
    }
    // normalise energy so the send level means the same on every sample rate
    let e = 0;
    for (let i = 0; i < len; i++) e += d[i] * d[i];
    const k = 1 / Math.sqrt(e / sr) * 0.36;
    for (let i = 0; i < len; i++) d[i] *= k;
  }
  return (c.ir = b);
}

// ------------------------------------------------------------------------------------------------ koto
export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// Karplus-Strong plucked string with pick-position comb and a bright pick transient. The delay length is an
// integer; the caller corrects the pitch exactly with playbackRate (returned as `rate`).
export function kotoPluck(ctx, midi) {
  const c = cache(ctx);
  const key = midi;
  if (c.plucks.has(key)) return c.plucks.get(key);
  const sr = ctx.sampleRate;
  const f = mtof(midi);
  const N = Math.max(2, Math.round(sr / f));
  const rate = (f * N) / sr;
  const t60 = Math.max(1.1, 4.2 - (midi - 50) * 0.075); // low strings ring longer
  const dur = Math.min(5, t60 + 0.3);
  const len = Math.floor(sr * dur);
  const buf = ctx.createBuffer(1, len, sr);
  const out = buf.getChannelData(0);
  // excitation: noise lowpassed a little, pick-position comb (plucked near the bridge → brighter)
  const ex = new Float32Array(N);
  let lp = 0;
  for (let i = 0; i < N; i++) {
    lp += 0.72 * ((Math.random() * 2 - 1) - lp);
    ex[i] = lp;
  }
  const pp = Math.max(1, Math.floor(N * 0.13));
  const line = new Float32Array(N);
  for (let i = 0; i < N; i++) line[i] = ex[i] - 0.85 * ex[(i + N - pp) % N];
  // per-period loss for the target decay time
  const loss = Math.pow(0.001, 1 / (t60 * f));
  let idx = 0;
  for (let i = 0; i < len; i++) {
    const cur = line[idx];
    const nxt = line[(idx + 1) % N];
    // averaging filter weighted toward brightness (0.5 = classic KS; less averaging keeps upper partials)
    line[idx] = loss * (0.62 * cur + 0.38 * nxt);
    out[i] = cur;
    idx = (idx + 1) % N;
  }
  // pick click: a few ms of bright noise at the attack
  const clickLen = Math.floor(sr * 0.006);
  for (let i = 0; i < clickLen && i < len; i++) out[i] += (Math.random() * 2 - 1) * 0.35 * (1 - i / clickLen);
  // normalise peak and fade the tail
  let peak = 1e-6;
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(out[i]));
  const fade = Math.floor(sr * 0.25);
  for (let i = 0; i < len; i++) {
    out[i] /= peak;
    if (i > len - fade) out[i] *= (len - i) / fade;
  }
  const res = { buffer: buf, rate };
  c.plucks.set(key, res);
  return res;
}

// ------------------------------------------------------------------------------------------------ helpers
// Exponential percussive envelope on a GainNode's gain. Returns end time.
export function perc(param, t, peak, attack, decay) {
  param.cancelScheduledValues(t);
  param.setValueAtTime(0.0001, t);
  param.linearRampToValueAtTime(peak, t + attack);
  param.setTargetAtTime(0.0001, t + attack, decay / 4.6);
  return t + attack + decay;
}

export function noiseSource(ctx, t, dur, { type = 'white', rate = 1, offset } = {}) {
  const src = ctx.createBufferSource();
  src.buffer = type === 'pink' ? pinkNoise(ctx) : type === 'brown' ? brownNoise(ctx) : whiteNoise(ctx);
  src.playbackRate.value = rate;
  const off = offset ?? rand() * (src.buffer.duration - dur - 0.05);
  src.start(t, Math.max(0, off), dur + 0.05);
  return src;
}

export function filter(ctx, type, freq, Q = 0.707, gain = 0) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = Q;
  if (gain) f.gain.value = gain;
  return f;
}

export function gainNode(ctx, v = 1) {
  const g = ctx.createGain();
  g.gain.value = v;
  return g;
}

// Pan + distance attenuation feeding `dest`.
export function spatialOut(ctx, dest, pan = 0, gain = 1) {
  const g = gainNode(ctx, gain);
  if (ctx.createStereoPanner && Math.abs(pan) > 0.01) {
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    g.connect(p).connect(dest);
  } else g.connect(dest);
  return g;
}

// Disconnect a set of nodes once the sound has ended (keeps the graph from growing).
export function cleanup(nodes, endTime, ctx) {
  const ms = Math.max(0, (endTime - ctx.currentTime) * 1000) + 200;
  const offline = typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;
  if (!offline) {
    setTimeout(() => {
      for (const n of nodes) {
        try {
          n.disconnect();
        } catch {
          /* already gone */
        }
      }
    }, ms);
  }
}
