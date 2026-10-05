// GPU parity check of the grass bend: a probe snippet, not a test (`npm test` only runs scripts/*.test.mjs). Run it by
// hand after changing src/world/grassBend.js or the shaders that use it:
//   node scripts/probe.mjs --file scripts/grassbend.gpu.js
// scripts/grassbend.test.mjs pins the JS mirror in src/world/grassBend.js and checks that every shader Grass.js
// assembles carries the same constants and the very same GLSL text, but GLSL does not run in node. This snippet runs
// that exported GLSL (BLADE_ARC_GLSL, STALK_BEND_GLSL, PLUME_LENS_GLSL) on the GPU, in the running game, over grids of
// inputs, and compares what it computes with the mirror:
//   - the blade arc (reach, rise, direction) for bends 0 … 3 and blade fractions 0 … 1;
//   - the stalk's response for bends 0 … 3;
//   - the dissolve of a plant near the lens (the fade of its parts, the span of its plume, and the two together) for
//     distances 0 … 6 m and plume directions.
// It throws, so probe.mjs exits with 1, when a value differs by more than TOLERANCE or is not a number: a formula
// changed in the GLSL and not in the mirror (or the other way round) is off by 1e-2 or more, where the GPU's own
// rounding is ~1e-6 (measured on Apple silicon through ANGLE/Metal).
const TOLERANCE = 1e-4;
const m = await import('/src/world/grassBend.js');
// THREE's classes, taken from the game's own objects (this snippet has no bare 'three' import)
const SM = game.grass.layers[0].prepass.constructor; // THREE.ShaderMaterial
const RT = game.grass.layers[0].instRT.constructor; // THREE.WebGLRenderTarget
const gl = game.gl;
// columns: bends 0 … 3 / plant distances 0 … 6 m; rows: blade fractions 0 … 1 / plume directions 0 … π
const W = 126, H = 41;
const FLOAT_TYPE = 1015, RGBA_FORMAT = 1023, NEAREST_FILTER = 1003; // THREE.FloatType, RGBAFormat, NearestFilter
const rt = new RT(W, H, {
  type: FLOAT_TYPE,
  format: RGBA_FORMAT,
  minFilter: NEAREST_FILTER,
  magFilter: NEAREST_FILTER,
  depthBuffer: false,
  stencilBuffer: false,
  generateMipmaps: false,
});
const fx = `(gl_FragCoord.x - 0.5) / ${(W - 1).toFixed(1)}`;
const fy = `(gl_FragCoord.y - 0.5) / ${(H - 1).toFixed(1)}`;
const bodies = {
  blade: `float bend = ${fx} * 3.0; float t = ${fy}; float reach, rise; vec2 dir;
    kzBladeArc(bend, t, reach, rise, dir);
    o = vec4(reach, rise, dir.x, dir.y);`,
  stalk: `o = vec4(kzStalkBend(${fx} * 3.0), 0.0, 0.0, 0.0);`,
  // a plant whose stalk ends d m from the camera, below it, and whose plume end turns by `ang` about the vertical; the
  // last channel is the projection matrix's [1][1] the GPU used (that of the quad's own camera), so the mirror gets the
  // same one
  plant: `float d = ${fx} * 6.0; float ang = ${fy} * 3.14159265;
    vec3 c0 = vec3(0.8 * d, -0.3 * d - 0.2, 0.6 * d);
    vec3 C = vec3(0.0, 0.4, 0.0);
    vec3 E = vec3(cos(ang) * 0.4, 0.3, sin(ang) * 0.4);
    o = vec4(kzPlantLens(c0, C, E, 0.8), kzPlumeLens(c0), kzPlumeSpan(0.8, d), projectionMatrix[1][1]);`,
};
const material = (mode) =>
  new SM({
    glslVersion: '300 es',
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `
    precision highp float;
    uniform mat4 projectionMatrix;
    ${m.BLADE_ARC_GLSL}
    ${m.STALK_BEND_GLSL}
    ${m.PLUME_LENS_GLSL}
    layout(location = 0) out highp vec4 o;
    void main() { ${bodies[mode]} }`,
    depthTest: false,
    depthWrite: false,
  });
const previous = gl.getRenderTarget();
const run = (mode) => {
  const mat = material(mode);
  const quad = game.grass.quad;
  quad.material = mat;
  gl.setRenderTarget(rt);
  quad.render(gl);
  const out = new Float32Array(W * H * 4);
  gl.readRenderTargetPixels(rt, 0, 0, W, H, out);
  mat.dispose();
  return out;
};
const blade = run('blade');
const stalk = run('stalk');
const plant = run('plant');
gl.setRenderTarget(previous);
rt.dispose();

const worst = { reach: 0, rise: 0, sin: 0, cos: 0, stalk: 0, plantLens: 0, partLens: 0, plumeSpan: 0 };
const bad = [];
const compare = (name, gpu, js) => {
  const d = Math.abs(gpu - js);
  if (!(d <= TOLERANCE)) bad.push(`${name}: GPU ${gpu}, mirror ${js}`); // this also catches NaN
  worst[name] = Math.max(worst[name], d);
};
for (let j = 0; j < H; j++) {
  for (let i = 0; i < W; i++) {
    const u = i / (W - 1), v = j / (H - 1), o = (j * W + i) * 4;
    const arc = m.bladeArc(u * 3, v);
    compare('reach', blade[o], arc.reach);
    compare('rise', blade[o + 1], arc.rise);
    compare('sin', blade[o + 2], arc.sin);
    compare('cos', blade[o + 3], arc.cos);
    if (j === 0) compare('stalk', stalk[o], m.stalkBend(u * 3));
    const d = u * 6, ang = v * Math.PI;
    const c0 = [0.8 * d, -0.3 * d - 0.2, 0.6 * d];
    const C = [0, 0.4, 0];
    const E = [Math.cos(ang) * 0.4, 0.3, Math.sin(ang) * 0.4];
    compare('plantLens', plant[o], m.plantLens(c0, C, E, 0.8, plant[o + 3]));
    compare('partLens', plant[o + 1], m.plumeLens(c0));
    compare('plumeSpan', plant[o + 2], m.plumeSpan(0.8, d, plant[o + 3]));
  }
}
const context = gl.getContext();
const debugInfo = context.getExtension('WEBGL_debug_renderer_info');
const summary = {
  ok: bad.length === 0,
  tolerance: TOLERANCE,
  grid: `${W} x ${H}`,
  gpu: debugInfo ? context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : 'unknown',
  maxAbsDiff: worst,
};
if (bad.length) {
  const first = `${bad.length} values, first ${bad[0]}`;
  throw new Error(`the GLSL and its JS mirror disagree (${first}): ${JSON.stringify(summary)}`);
}
return summary;
