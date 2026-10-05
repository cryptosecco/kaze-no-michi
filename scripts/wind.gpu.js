// GPU parity check of the wind field: a probe snippet, not a test (`npm test` only runs scripts/*.test.mjs). Run it
// by hand after changing the kaze_wind chunk, or the CPU mirror next to it, in src/world/Wind.js:
//   node scripts/probe.mjs --file scripts/wind.gpu.js
// scripts/wind.test.mjs pins the CPU mirror (wind.sample / gust / dir / gustPeak) and that the chunk takes its
// constants from the same exports, but GLSL does not run in node. This snippet renders the real `kaze_wind` chunk
// (kazeWindBend, kazeGust, kazeWindDir, kazeGustPeak) over a 64 x 64 grid, 6.25 m apart, in the running game, through
// the states of a T press:
//   - the ambient wind, at three clocks;
//   - the ramp-in, the plateau and the ramp-out of a guide;
//   - a guide whose player has moved round the objective (the guided pattern pivots about him);
//   - a second press while a guide blows (it continues from the level it had and re-aims), through its own ramps;
// and compares every cell with wind.sample / gust / dir. It throws, so probe.mjs exits with 1, when a value is not a
// number or differs by more than a tolerance. The noise texture is half-float on the GPU and float32 on the CPU, and
// the GPU filters it in hardware: the two agree to ~5e-3 in |bend| at the sharp edges of a front and to ~1e-5
// elsewhere (measured on Apple silicon through ANGLE/Metal). So the largest difference of a state may be 1e-2, but
// the median, which the lulls and the saturated cores of the fronts decide and which carry no texture noise, only
// 2e-4: a formula changed in the GLSL and not in the mirror (or the other way round) is off by 2e-3 or more over whole
// areas. What this cannot see is the CPU's own logic (the heading, the pivot, the ramps: the shader reads what
// update() writes), which npm test holds. The probe leaves the wind at the clock it found, with no guide.
const MAX_TOLERANCE = 1e-2; // |bend| and gust: the largest difference of any cell
const MEDIAN_TOLERANCE = 2e-4; // |bend| and gust: the median over the cells
const DIR_TOLERANCE = 1e-4; // kazeWindDir()
const PEAK_TOLERANCE = 1e-5; // kazeGustPeak()
const wind = game.wind, U = wind.uniforms;
const { GLOBAL_UNIFORMS } = await import('/src/render/globals.js');
// THREE's classes, taken from the game's own objects (this snippet has no bare 'three' import)
const SM = game.grass.layers[0].prepass.constructor; // THREE.ShaderMaterial
const RT = game.grass.layers[0].instRT.constructor; // THREE.WebGLRenderTarget
const V2 = wind.origin.constructor; // THREE.Vector2
const gl = game.gl;
const N = 64, ORIGIN = [-200, -200], STEP = 6.25;
const FLOAT_TYPE = 1015, RGBA_FORMAT = 1023, NEAREST_FILTER = 1003; // THREE.FloatType, RGBAFormat, NearestFilter
const rt = new RT(N, N, {
  type: FLOAT_TYPE,
  format: RGBA_FORMAT,
  minFilter: NEAREST_FILTER,
  magFilter: NEAREST_FILTER,
  depthBuffer: false,
  stencilBuffer: false,
  generateMipmaps: false,
});
// the game's own uniforms (the wind's among them: wind.update moves what the shader reads), and where the grid starts
const uniforms = { ...GLOBAL_UNIFORMS };
uniforms.uProbeOrigin = { value: new V2(ORIGIN[0], ORIGIN[1]) };
uniforms.uProbeStep = { value: STEP };
const material = (body) =>
  new SM({
    glslVersion: '300 es',
    uniforms,
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `
    precision highp float;
    #include <kaze_wind>
    uniform vec2 uProbeOrigin;
    uniform float uProbeStep;
    layout(location = 0) out highp vec4 o;
    void main() {
      vec2 p = uProbeOrigin + (gl_FragCoord.xy - 0.5) * uProbeStep;
      ${body}
    }`,
    depthTest: false,
    depthWrite: false,
  });
const passes = {
  bend: material('o = vec4(kazeWindBend(p), kazeGust(p), kazeGustPeak());'),
  dir: material('o = vec4(kazeWindDir(), 0.0, 0.0);'),
};
const previous = gl.getRenderTarget();
const run = (mat, out) => {
  game.grass.quad.material = mat;
  gl.setRenderTarget(rt);
  game.grass.quad.render(gl);
  gl.readRenderTargetPixels(rt, 0, 0, N, N, out);
};
const gpuBend = new Float32Array(N * N * 4);
const gpuDir = new Float32Array(N * N * 4);
const v = new V2();
const quantile = (a, q) => [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * q)];
const exp = (x) => +x.toExponential(1);
const states = [];
const bad = [];
// One state: the grid through the shader and through the mirror. `level` is the range the guide envelope must be in:
// the states are what their names say, or the probe has drifted from the game.
const snap = (name, [lo, hi]) => {
  const level = U.uGuide.value;
  if (!(level >= lo && level <= hi)) bad.push(`${name}: the guide is at ${level}, expected ${lo} .. ${hi}`);
  run(passes.bend, gpuBend);
  run(passes.dir, gpuDir);
  const eb = [], eg = [];
  let cpuMax = 0, nonFinite = 0, peak = 0, dirErr = 0;
  const d = wind.dir(new V2());
  const cpuPeak = wind.gustPeak();
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const o = (j * N + i) * 4, x = ORIGIN[0] + i * STEP, z = ORIGIN[1] + j * STEP;
      const s = wind.sample(x, z, v);
      const finite = [0, 1, 2, 3].every((k) => Number.isFinite(gpuBend[o + k])) && Number.isFinite(gpuDir[o]);
      if (!finite || !Number.isFinite(gpuDir[o + 1])) nonFinite++;
      eb.push(Math.max(Math.abs(gpuBend[o] - s.x), Math.abs(gpuBend[o + 1] - s.y)));
      eg.push(Math.abs(gpuBend[o + 2] - wind.gust(x, z)));
      cpuMax = Math.max(cpuMax, Math.hypot(s.x, s.y));
      peak = Math.max(peak, Math.abs(gpuBend[o + 3] - cpuPeak));
      dirErr = Math.max(dirErr, Math.abs(gpuDir[o] - d.x), Math.abs(gpuDir[o + 1] - d.y));
    }
  }
  const medB = quantile(eb, 0.5), maxB = Math.max(...eb), medG = quantile(eg, 0.5), maxG = Math.max(...eg);
  states.push({
    state: name,
    level: +level.toFixed(4),
    cpuMaxBend: +cpuMax.toFixed(3),
    bend: { median: exp(medB), p99: exp(quantile(eb, 0.99)), max: exp(maxB) },
    gust: { median: exp(medG), max: exp(maxG) },
    dir: exp(dirErr),
    peak: exp(peak),
  });
  const over = (what, got, limit) => got > limit && bad.push(`${name}: ${what} ${got} > ${limit}`);
  if (nonFinite) bad.push(`${name}: ${nonFinite} cells are not numbers`);
  over('median |bend| difference', medB, MEDIAN_TOLERANCE);
  over('largest |bend| difference', maxB, MAX_TOLERANCE);
  over('median gust difference', medG, MEDIAN_TOLERANCE);
  over('largest gust difference', maxG, MAX_TOLERANCE);
  over('heading difference', dirErr, DIR_TOLERANCE);
  over('gust peak difference', peak, PEAK_TOLERANCE);
};
// the game's order within a step: the wind updates, then the origin follows the player
const step = (frames, ox = 0, oz = 0) => {
  for (let f = 0; f < frames; f++) {
    wind.update(1 / 60);
    wind.setOrigin(ox, oz);
  }
};
const clock = wind.time;
game.loop.paused = true; // the wind moves only by what this snippet does to it
try {
  await kaze.waitFrames(2);
  // the ambient wind
  for (const t of [2, 90, 600]) {
    wind.setTime(t);
    wind.setOrigin(0, 0);
    snap(`ambient, clock ${t} s`, [0, 0]);
  }
  // a T press at the spawn, clock 90 s, toward the first objective: ramp-in (1.6 s), plateau, ramp-out (2.5 s)
  wind.setTime(90);
  wind.setOrigin(0, 0);
  wind.guideTo(-260, 180, 9);
  let at = 0;
  for (const [t, name, range] of [
    [0.1, 'ramp-in, 0.1 s', [0.0001, 0.2]],
    [0.4, 'ramp-in, 0.4 s', [0.05, 0.5]],
    [1.0, 'ramp-in, 1.0 s', [0.4, 0.95]],
    [1.4, 'ramp-in, 1.4 s', [0.8, 1]],
    [1.7, 'full, 1.7 s', [0.999, 1]],
    [4.1, 'plateau, 4.1 s', [1, 1]],
    [6.9, 'ramp-out, 6.9 s', [0.5, 1]],
    [7.6, 'ramp-out, 7.6 s', [0.1, 0.9]],
    [8.4, 'ramp-out, 8.4 s', [0.0001, 0.4]],
    [8.9, 'ramp-out, 8.9 s', [0.0001, 0.05]],
    [13, 'after the guide, 13 s', [0, 0]],
  ]) {
    step(Math.round((t - at) * 60));
    at = t;
    snap(name, range);
  }
  // the player moves round the objective: the guided heading turns at 0.6 rad/s and the pattern pivots about him
  wind.setTime(600);
  wind.setOrigin(0, 0);
  wind.guideTo(300, 0, 30);
  step(180);
  snap('plateau before the pivot', [1, 1]);
  wind.setOrigin(300, -150);
  step(30, 300, -150);
  snap('pivot, 0.5 s in', [1, 1]);
  step(90, 300, -150);
  snap('pivot, 2 s in', [1, 1]);
  step(120, 300, -150);
  snap('pivot, 4 s in', [1, 1]);
  // a second press while the first blows: from the level it had, toward another objective
  wind.setTime(90);
  wind.setOrigin(0, 0);
  wind.guideTo(-260, 180, 9);
  step(50);
  wind.guideTo(400, 400, 9);
  step(20);
  snap('second press, ramp-in +20 frames', [0.5, 1]);
  step(300);
  snap('second press, plateau', [1, 1]);
  step(180);
  snap('second press, ramp-out', [0.0001, 0.9]);
  // the guided field must really be what the shader was asked about
  const plateau = states.find((s) => s.state === 'plateau, 4.1 s');
  if (!(plateau.cpuMaxBend > 1.5)) bad.push(`the plateau is too weak to test the guided field: ${plateau.cpuMaxBend}`);
} finally {
  wind.setTime(clock);
  gl.setRenderTarget(previous);
  rt.dispose();
  for (const m of Object.values(passes)) m.dispose();
  game.loop.paused = false;
}
const context = gl.getContext();
const debugInfo = context.getExtension('WEBGL_debug_renderer_info');
const worst = (key, sub) => exp(Math.max(...states.map((s) => (sub ? s[key][sub] : s[key]))));
const summary = {
  ok: bad.length === 0,
  tolerance: { max: MAX_TOLERANCE, median: MEDIAN_TOLERANCE, dir: DIR_TOLERANCE, peak: PEAK_TOLERANCE },
  grid: `${N} x ${N}`,
  gpu: debugInfo ? context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : 'unknown',
  worst: {
    bendMedian: worst('bend', 'median'),
    bendMax: worst('bend', 'max'),
    gustMedian: worst('gust', 'median'),
    gustMax: worst('gust', 'max'),
    dir: worst('dir'),
    peak: worst('peak'),
  },
  states,
};
if (bad.length) {
  const first = `${bad.length} findings, first: ${bad[0]}`;
  throw new Error(`the GLSL and its JS mirror disagree (${first}): ${JSON.stringify(summary)}`);
}
return summary;
