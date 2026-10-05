// Trot lab — the Node run: every scenario of sim.mjs, the metrics (metrics.mjs), the reference check and the report.
//   node scripts/trotlab/sim.mjs --label <name> [--no-plots] [--hz 240] [--ref scripts/trotlab/reference.json]
// Writes out/trotlab/<label>/:
//   metrics.json          flat `metrics` map (4.0 m/s steady trot + robust.<scenario>.* + v3.2.* / v5.0.*), units, the
//                         other speeds, robustness, the 60 Hz verification, the square stand, details, reference rows
//   metrics.md            the same as a table (value, unit, reference range and ok / OUT when a reference file exists)
//   trace_steady_4.0.json per-sample markers of the main run (240 Hz), for independent checks
//   plots/a_gait.png      Hildebrand gait diagram (2 strides, suspensions shaded) — and .svg
//   plots/b_vertical.png  withers / sacrum / poll vertical displacement vs stride phase, contact bars
//   plots/c_hoof_paths.png sole paths in the body frame and the world frame, slip during contact
//   plots/d_joint_angles.png carpus, fore fetlock, elbow; hock, hind fetlock, stifle vs stride phase
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { simulate, scenarios, TROT_SPEEDS, MAIN_SPEED, ROOT } from './sim.mjs';
import { analyze, robust, standAngles, evaluate, LEG_NAMES } from './metrics.mjs';
import { INFO, ROBUST_KEYS, ROBUST_SCENARIOS, infoOf } from './catalog.mjs';
import * as P from './plots.mjs';

const argOf = (argv) => (name, def) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};

export function loadReference(file) {
  if (!file || !fs.existsSync(file)) return { file: null, ref: {} };
  try {
    const ref = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const k of Object.keys(ref)) if (k.startsWith('_') || typeof ref[k] !== 'object' || ref[k] === null) delete ref[k];
    return { file, ref };
  } catch (e) {
    console.warn(`trotlab: ${file} is not valid JSON (${e.message}): no reference check`);
    return { file: null, ref: {} };
  }
}

function git() {
  try {
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    // uncommitted changes under src/ (the horse's code lives in src/actors/horse): listed, so a run says what it measured
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd: ROOT, encoding: 'utf8' }).split('\n').map((l) => l.slice(3).trim()).filter(Boolean);
    return { commit, dirtySrc: dirty.length > 0, dirtyFiles: dirty, dirtyHorse: dirty.some((f) => f.startsWith('src/actors/horse')) };
  } catch {
    return { commit: null, dirtySrc: null, dirtyFiles: [], dirtyHorse: null };
  }
}

// a few context numbers for a robustness scenario (speeds from the labels, the turn radius and the grade from geometry)
function scenarioContext(run) {
  const S = run.samples;
  const sp = S.map((s) => s.lab.speed);
  const r = S.map((s) => s.geo.root);
  const ctx = { duration_s: +(S.length * run.dt).toFixed(3), speed_label_mps: [Math.min(...sp), Math.max(...sp)].map((v) => +v.toFixed(3)), gaits: [...new Set(S.map((s) => s.lab.gait))] };
  if (run.kind === 'turn') {
    // circle through three points of the root's path
    const [a, b, c] = [r[0], r[Math.floor(r.length / 2)], r[r.length - 1]];
    const ax = a[0], az = a[2], bx = b[0], bz = b[2], cx = c[0], cz = c[2];
    const d = 2 * (ax * (bz - cz) + bx * (cz - az) + cx * (az - bz));
    const ux = ((ax * ax + az * az) * (bz - cz) + (bx * bx + bz * bz) * (cz - az) + (cx * cx + cz * cz) * (az - bz)) / d;
    const uz = ((ax * ax + az * az) * (cx - bx) + (bx * bx + bz * bz) * (ax - cx) + (cx * cx + cz * cz) * (bx - ax)) / d;
    ctx.radius_m = +Math.hypot(ax - ux, az - uz).toFixed(3);
  }
  if (run.kind === 'slope') {
    const a = r[0], b = r[r.length - 1];
    ctx.grade = +((b[1] - a[1]) / Math.hypot(b[0] - a[0], b[2] - a[2])).toFixed(4);
  }
  return ctx;
}

// ---- formatting -------------------------------------------------------------------------------------------------------
const DEC = { Hz: 3, m: 3, s: 3, fraction: 3, '/stride': 2, ms: 1, mm: 1, '°': 1, 'm/s': 2, 'm/s²': 2, '%': 1, frame: 0 };
export function fmt(v, unit) {
  if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return '—';
  if (typeof v !== 'number') return String(v);
  let d = DEC[unit] ?? 3;
  if (unit === '°' && Math.abs(v) < 10) d = 2; // small angles (trunk pitch / roll) need the extra digit
  const s = v.toFixed(d);
  return (Number(s) === 0 ? (0).toFixed(d) : s).replace('-', '−');
}
const rangeStr = (r, unit) => (r ? `${r.lo != null ? fmt(r.lo, unit) : '−∞'} … ${r.hi != null ? fmt(r.hi, unit) : '+∞'}` : '');
const passStr = (p) => (p === null || p === undefined ? '' : p ? 'ok' : 'OUT');

function trace(run, A) {
  const S = run.samples, r4 = (v) => +v.toFixed(5);
  const v3 = (p) => p.map(r4);
  const points = (l) => Object.keys(S[0].geo.legs[l]).filter((k) => Array.isArray(S[0].geo.legs[l][k]));
  return {
    name: run.name, dt: run.dt, contact_m: run.contactM,
    note: 'world metres (y up); angles in degrees, flexion +; phase = geometric stride phase (0 = LF touchdown, null outside the analysed strides); lab_* are the horse\'s internal labels (phase, gait, blend [index, w], speed, stance, IK reach), never contact truth',
    t: S.map((s) => +s.t.toFixed(6)),
    phase: S.map((s) => {
      const k = A.strides.findIndex((x) => s.t >= x.t0 && s.t < x.t1);
      return k < 0 ? null : r4(k + (s.t - A.strides[k].t0) / A.strides[k].T);
    }),
    lab_phase: S.map((s) => r4(s.lab.phase)),
    lab_gait: S.map((s) => s.lab.gait),
    lab_blend: S.map((s) => [s.lab.gi, r4(s.lab.gw)]),
    lab_speed: S.map((s) => r4(s.lab.speed)),
    lab_stance: S.map((s) => s.lab.stance.map((x) => (x ? 1 : 0))),
    lab_reach: S.map((s) => s.lab.reach.map((x) => (x ? 1 : 0))),
    root: S.map((s) => v3(s.geo.root)),
    body: S.map((s) => v3(s.geo.body)),
    withers: S.map((s) => v3(s.geo.withers)),
    sacrum: S.map((s) => v3(s.geo.sacrum)),
    poll: S.map((s) => v3(s.geo.poll)),
    muzzle: S.map((s) => v3(s.geo.muzzle)),
    // trunk pitch (nose up +), trunk roll (left side up +), pelvis roll
    pitch_roll_pelvisroll: S.map((s) => [r4(Math.asin(s.geo.bodyAx.f[1]) * 57.29578), r4(Math.atan2(s.geo.bodyAx.l[1], s.geo.bodyAx.u[1]) * 57.29578), r4(Math.atan2(s.geo.pelvisAx.l[1], s.geo.pelvisAx.u[1]) * 57.29578)]),
    legs: LEG_NAMES.map((name, l) => ({
      name,
      contact: S.map((s) => (s.geo.legs[l].contact ? 1 : 0)),
      lowH: S.map((s) => r4(s.geo.legs[l].lowH)),
      soleH: S.map((s) => r4(s.geo.legs[l].soleH)),
      toeH: S.map((s) => r4(s.geo.legs[l].toeH)),
      heelH: S.map((s) => r4(s.geo.legs[l].heelH)),
      // sole, toe, heel, low (lowest capsule vertex), coronet, fetlock, carpus|hock, elbow|stifle, shoulder|hip, scapTop
      ...Object.fromEntries(points(l).map((k) => [k, S.map((s) => v3(s.geo.legs[l][k]))])),
      angles: Object.fromEntries(Object.keys(A.D.legs[l].ang[0]).map((k) => [k, A.D.legs[l].ang.map((a) => r4(a[k]))])),
    })),
  };
}

// ---- metrics.md -------------------------------------------------------------------------------------------------------
function markdown(J, refInfo) {
  const M = J.metrics, ref = refInfo.ref;
  const has = !!refInfo.file;
  const L = [];
  L.push(`# Trot lab — \`${J.label}\``, '');
  const dirty = J.git.dirtySrc ? ` (with local changes in \`src/\`${J.git.dirtyHorse ? ', including the horse' : ', not in the horse'}: ${J.git.dirtyFiles.slice(0, 6).map((f) => `\`${f}\``).join(', ')}${J.git.dirtyFiles.length > 6 ? '…' : ''})` : '';
  L.push(`Generated ${J.date} · commit \`${J.git.commit ?? '?'}\`${dirty} · simulation step 1/${Math.round(1 / J.config.dt)} s · contact threshold ${J.config.contact_mm} mm.`);
  L.push(`Values of the straight trot at ${fmt(J.config.main_speed, 'm/s')} m/s on flat ground (${J.details.strides} complete strides); for comparison, the values at 3.2 and 5.0 m/s.`);
  L.push(has ? `Literature-derived reference ranges: \`${path.relative(ROOT, refInfo.file)}\` (${Object.keys(ref).length} keys; ok = inside the range, OUT = outside).` : 'Literature-derived reference ranges: `scripts/trotlab/reference.json` not found — no ok / OUT column.');
  L.push('Definitions and conventions: `docs/trot-lab.md`. Keys marked *(extra)* are extra diagnostics.', '');
  if (has) {
    const rows = evaluate(M, ref);
    const fails = rows.filter((r) => r.pass === false).length, oks = rows.filter((r) => r.pass === true).length, nd = rows.filter((r) => r.pass === null).length;
    L.push(`**Result: ${oks} ok · ${fails} OUT · ${nd} not measurable** (of ${rows.length} reference keys).`, '');
  }
  L.push('## Main metrics (trot at 4.0 m/s)', '');
  L.push(`| key | value | unit | 3.2 m/s | 5.0 m/s |${has ? ' reference | result |' : ''} description |`);
  L.push(`|---|---:|---|---:|---:|${has ? '---|---|' : ''}---|`);
  const by = J.by_speed;
  for (const key of Object.keys(INFO)) {
    if (!(key in M)) continue;
    const I = INFO[key];
    const r = ref[key];
    L.push(`| \`${key}\` | ${fmt(M[key], I.unit)} | ${I.unit} | ${fmt(by['3.2']?.[key], I.unit)} | ${fmt(by['5.0']?.[key], I.unit)} |${has ? ` ${rangeStr(r, I.unit)} | ${r ? passStr(evaluate(M, { [key]: r })[0].pass) : ''} |` : ''} ${I.extra ? '*(extra)* ' : ''}${I.desc} |`);
  }
  L.push('', '## Robustness (scenarios)', '');
  const rk = Object.keys(ROBUST_KEYS);
  L.push(`| scenario | ${rk.map((k) => `${k} (${ROBUST_KEYS[k].unit})`).join(' | ')} | max-step bone | frames | context |`);
  L.push(`|---|${rk.map(() => '---:').join('|')}|---|---:|---|`);
  for (const name of ROBUST_SCENARIOS) {
    const R = J.robust[name];
    const cells = rk.map((k) => {
      const key = `robust.${name}.${k}`;
      const v = fmt(M[key], ROBUST_KEYS[k].unit);
      return has && ref[key] ? `${v} (${passStr(evaluate(M, { [key]: ref[key] })[0].pass)})` : v;
    });
    const c = R.context;
    const ctx = [`${fmt(c.duration_s, 's')} s`, `gaits: ${c.gaits.join(', ')}`, c.radius_m ? `radius ${fmt(c.radius_m, 'm')} m` : '', c.grade != null ? `grade ${fmt(c.grade * 100, '%')} %` : ''].filter(Boolean).join(' · ');
    L.push(`| ${name} | ${cells.join(' | ')} | ${R.max_bone_step_bone || ''} | ${R.frames} | ${ctx} |`);
  }
  if (has) {
    const extraRef = Object.keys(ref).filter((k) => !(k in INFO) && !k.startsWith('robust.'));
    if (extraRef.length) {
      L.push('', '## Other reference keys', '');
      L.push('| key | value | reference | result |', '|---|---:|---|---|');
      for (const k of extraRef) {
        const I = infoOf(k);
        L.push(`| \`${k}\` | ${fmt(M[k], I.unit)} | ${rangeStr(ref[k], I.unit)} | ${passStr(evaluate(M, { [k]: ref[k] })[0].pass) || 'unknown key'} |`);
      }
    }
  }
  L.push('', '## 60 Hz verification (the game\'s fixed step)', '');
  L.push('The same 4.0 m/s trot simulated and sampled at 1/60 s. The differences come from the sampling (contact instants within ±8 ms, peaks between two samples), not from the horse.', '');
  L.push('| key | 240 Hz | 60 Hz | difference |', '|---|---:|---:|---:|');
  for (const [k, v] of Object.entries(J.verify_60hz)) {
    const u = infoOf(k).unit;
    L.push(`| \`${k}\` | ${fmt(v.hz240, u)} | ${fmt(v.hz60, u)} | ${fmt(v.diff, u)} |`);
  }
  L.push('', '## Square stand (reference angles, °)', '');
  L.push('| limb | angles |', '|---|---|');
  J.stand.legs.forEach((a, l) => L.push(`| ${LEG_NAMES[l]} | ${Object.entries(a).map(([k, v]) => `${k} ${fmt(v, '°')}`).join(' · ')} |`));
  const D = J.details;
  L.push('', '## Details', '');
  if (D.error) {
    L.push(`- **The 4.0 m/s trot analysis failed:** ${D.error}. The main metrics are missing (—); robustness is measured all the same.`);
    return L.join('\n') + '\n';
  }
  L.push(`- Analysed window: ${fmt(D.window_s[0], 's')}–${fmt(D.window_s[1], 's')} s after settling, ${D.strides} strides from LF touchdown to LF touchdown.`);
  L.push(`- Duty factor per limb (fraction of the stride in contact): ${D.duty_by_leg.map((v, l) => `${LEG_NAMES[l]} ${fmt(v, 'fraction')}`).join(' · ')}; per flat plant: ${D.plant_duty_by_leg.map((v, l) => `${LEG_NAMES[l]} ${fmt(v, 'fraction')}`).join(' · ')}.`);
  L.push(`- Contacts per stride: ${D.contacts_per_stride.map((v, l) => `${LEG_NAMES[l]} ${fmt(v, '/stride')}`).join(' · ')}; of which flat plants: ${D.plants_per_stride.map((v, l) => `${LEG_NAMES[l]} ${fmt(v, '/stride')}`).join(' · ')}.`);
  L.push(`- Sensitivity to the contact threshold: ${Object.entries(D.duty_by_threshold_mm).map(([mm, d]) => `${mm} mm → duty ${fmt(d.fore, 'fraction')} / ${fmt(d.hind, 'fraction')}, contacts per stride ${fmt(d.per_stride, '/stride')}`).join(' · ')}.`);
  L.push(`- Print-to-print stride length (per limb): ${D.print_stride_m.map((v, l) => `${LEG_NAMES[l]} ${fmt(v, 'm')} m`).join(' · ')}.`);
  L.push(`- Maximum penetration per limb: ${D.penetration_mm_by_leg.map((v, l) => `${LEG_NAMES[l]} ${fmt(v, 'mm')} mm`).join(' · ')}.`);
  L.push(`- Largest bone step (60 Hz): ${fmt(M['smooth.max_bone_step_deg'], '°')}° on \`${D.smooth.max_bone_step_bone}\`; counting the ears and tail too, ${fmt(D.smooth.max_bone_step_all_deg, '°')}° on \`${D.smooth.max_bone_step_all_bone}\`.`);
  L.push(`- 60 Hz frames with the IK out of reach, per limb: ${D.smooth.ik_unreached_by_leg.map((v, l) => `${LEG_NAMES[l]} ${v}`).join(' · ')} (of ${D.smooth.frames}).`);
  L.push(`- Mean duration of the diagonal stance (union of the pair): ${fmt(D.diagonal_stance_s * 1000, 'ms')} ms; suspension samples used for the acceleration: ${D.flight_samples}.`);
  L.push(`- Hoof geometry (from the mesh, model space): sole centre, toe and heel of the ground ring = ${J.hoof.map((h, l) => `${LEG_NAMES[l]} z ${fmt(h.heel[2], 'm')}…${fmt(h.toe[2], 'm')} m`).join(' · ')}; ${J.hoof[0].count} vertices per capsule.`);
  L.push('', '## Plots', '');
  for (const [f, cap] of [['a_gait', 'Hildebrand gait diagram'], ['b_vertical', 'Vertical displacements'], ['c_hoof_paths', 'Hoof paths'], ['d_joint_angles', 'Joint angles']]) L.push(`![${cap}](plots/${f}.png)`, '');
  return L.join('\n') + '\n';
}

// ---- rasterize SVGs in headless Chrome ----------------------------------------------------------------------------------
async function rasterize(svgs, dir) {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const [name, svg] of Object.entries(svgs)) {
      fs.writeFileSync(path.join(dir, name + '.svg'), svg);
      await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff">${svg}</body></html>`);
      await page.locator('svg').first().screenshot({ path: path.join(dir, name + '.png') });
    }
  } finally {
    await browser.close();
  }
}

// ---- main ---------------------------------------------------------------------------------------------------------------
export async function main(argv) {
  const arg = argOf(argv);
  const label = String(arg('label', 'run-' + new Date().toISOString().replace(/[:.]/g, '-')));
  const hz = Number(arg('hz', 240));
  const dt = 1 / hz;
  const noPlots = !!arg('no-plots', false);
  const refInfo = loadReference(path.resolve(ROOT, String(arg('ref', 'scripts/trotlab/reference.json'))));
  const outDir = path.join(ROOT, 'out', 'trotlab', label);
  fs.mkdirSync(path.join(outDir, 'plots'), { recursive: true });
  const S = scenarios();
  const T = Date.now();
  const log = (s) => console.log(`[trotlab ${((Date.now() - T) / 1000).toFixed(1)}s] ${s}`);

  const stand = standAngles(simulate('stand', S.stand, { dt }));
  // a run the analysis cannot read (no LF plant, no whole stride...) still gets a report: its metrics are missing (—)
  // and the reason is in details.error
  const tryAnalyze = (run, st) => {
    try {
      return analyze(run, { stand: st });
    } catch (e) {
      console.warn(`trotlab: ${run.name}: ${e.message}`);
      return { metrics: {}, details: { error: e.message, strides: 0, window_s: [NaN, NaN] }, failed: true };
    }
  };
  const steady = {};
  for (const v of TROT_SPEEDS) {
    const key = v.toFixed(1), name = `steady_${key}`;
    const run = simulate(name, S[name], { dt });
    steady[key] = { run, A: tryAnalyze(run, stand) };
    log(`${name}: ${steady[key].A.details.strides} strides`);
  }
  const main = steady[MAIN_SPEED.toFixed(1)];
  const rob = {};
  for (const name of ROBUST_SCENARIOS) {
    const run = simulate(name, S[name], { dt });
    rob[name] = { ...robust(run), context: scenarioContext(run) };
    log(`${name}: slip ${rob[name].slip_mm.toFixed(1)} mm, penetration ${rob[name].penetration_mm.toFixed(1)} mm, step ${rob[name].max_bone_step_deg.toFixed(1)}°, IK ${rob[name].ik_unreached_frames}/${rob[name].frames}`);
  }
  // the same main run at the game's fixed step
  const stand60 = standAngles(simulate('stand', S.stand, { dt: 1 / 60 }));
  const run60 = simulate('steady_4.0', S['steady_4.0'], { dt: 1 / 60 });
  const A60 = tryAnalyze(run60, stand60);
  log('60 Hz verification done');

  const metrics = { ...main.A.metrics };
  for (const name of ROBUST_SCENARIOS) for (const k of Object.keys(ROBUST_KEYS)) metrics[`robust.${name}.${k}`] = rob[name][k];
  for (const v of TROT_SPEEDS) if (v !== MAIN_SPEED) for (const [k, x] of Object.entries(steady[v.toFixed(1)].A.metrics)) metrics[`v${v.toFixed(1)}.${k}`] = x;
  const units = Object.fromEntries(Object.keys(metrics).map((k) => [k, infoOf(k).unit]));
  const verify = {};
  for (const k of Object.keys(main.A.metrics)) verify[k] = { hz240: main.A.metrics[k], hz60: A60.metrics[k], diff: A60.metrics[k] - main.A.metrics[k] };
  const details = { ...main.A.details };
  delete details.contacts;
  delete details.swings;

  const J = {
    label, date: new Date().toISOString(), git: git(),
    config: { dt, hz, contact_mm: main.run.contactM * 1000, main_speed: MAIN_SPEED, trot_speeds: TROT_SPEEDS, scenarios: Object.fromEntries(Object.entries(S).map(([n, s]) => [n, { kind: s.kind, speed: s.speed ?? null, settle_s: s.settle, record_s: s.record }])) },
    metrics, units,
    by_speed: Object.fromEntries(Object.entries(steady).map(([k, x]) => [k, x.A.metrics])),
    robust: rob,
    verify_60hz: verify,
    stand,
    hoof: main.run.hoof,
    details,
    contacts: (main.A.details.contacts || []).map((cs, l) => ({ leg: LEG_NAMES[l], list: cs })),
    reference: { file: refInfo.file ? path.relative(ROOT, refInfo.file) : null, rows: refInfo.file ? evaluate(metrics, refInfo.ref) : [] },
  };
  fs.writeFileSync(path.join(outDir, 'metrics.json'), JSON.stringify(J, (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? +v.toPrecision(7) : v), 1));
  fs.writeFileSync(path.join(outDir, 'metrics.md'), markdown(J, refInfo));
  if (!main.A.failed) fs.writeFileSync(path.join(outDir, 'trace_steady_4.0.json'), JSON.stringify(trace(main.run, main.A)));
  log(`metrics → ${path.relative(ROOT, outDir)}/metrics.{json,md}`);

  if (!noPlots && !main.A.failed) {
    const ref = refInfo.ref;
    const head = `Trot lab ${label} — trot at ${MAIN_SPEED.toFixed(1)} m/s`;
    await rasterize(
      {
        a_gait: P.gaitDiagram(main.run, main.A, ref, head),
        b_vertical: P.verticals(main.run, main.A, ref, head),
        c_hoof_paths: P.hoofPaths(main.run, main.A, ref, head),
        d_joint_angles: P.jointAngles(main.run, main.A, stand, ref, head),
      },
      path.join(outDir, 'plots')
    );
    log(`plots → ${path.relative(ROOT, outDir)}/plots/`);
  }
  // the headline numbers and the reference tally on the console
  const show = ['stride.freq_hz', 'stride.length_m', 'duty.fore', 'duty.hind', 'suspension.frac', 'diag.dap_td_ms', 'contact.slip_mm.fore', 'contact.slip_mm.hind', 'contact.penetration_mm', 'trunk.withers_dy_mm', 'trunk.flight_accel_mps2', 'smooth.max_bone_step_deg', 'smooth.ik_unreached_frames'];
  for (const k of show) console.log(`  ${k.padEnd(28)} ${fmt(metrics[k], units[k])} ${units[k]}`);
  if (refInfo.file) {
    const rows = evaluate(metrics, refInfo.ref);
    console.log(`  reference: ${rows.filter((r) => r.pass).length} ok, ${rows.filter((r) => r.pass === false).length} out, ${rows.filter((r) => r.pass === null).length} n/a`);
  }
  return J;
}
