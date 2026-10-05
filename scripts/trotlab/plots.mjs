// Trot lab — plots as SVG strings (report.mjs rasterizes them in headless Chrome). Four figures for a steady run:
//   gaitDiagram   (a) Hildebrand diagram: geometric contact bars per hoof over 2 strides, suspensions shaded, the
//                 internal stance (label) as a thin line under each bar
//   verticals     (b) vertical displacement of withers, sacrum and poll vs stride phase, contact bars below
//   hoofPaths     (c) sole-centre paths, side view: body frame (1 stride), world frame (2 strides), slip during contact
//   jointAngles   (d) carpus, fore fetlock, elbow (LF); hock, hind fetlock, stifle (LH) vs stride phase
// Reference bands are drawn where scripts/trotlab/reference.json has a range for a related key.

const FONT = 'font-family="Helvetica, Arial, sans-serif"';
export const COL = {
  LF: '#c0392b', RF: '#e67e22', LH: '#2471a3', RH: '#17a589',
  withers: '#c0392b', sacrum: '#2471a3', poll: '#7d3c98',
  ref: '#27ae60', susp: '#f4d03f', grid: '#e3e3e3', axis: '#444', label: '#888',
};
const LEGC = [COL.LF, COL.RF, COL.LH, COL.RH];
const LEGN = ['LF', 'RF', 'LH', 'RH'];
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const it = (v, d = 1) => f(v, d).replace('-', '−');

export function niceTicks(lo, hi, n = 6) {
  const span = hi - lo || 1;
  const raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => span / s <= n) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

let clipN = 0;
// A plot panel in pixel box (x, y, w, h) with data ranges xr, yr
export class Chart {
  constructor({ x, y, w, h, xr, yr, title = '', xlabel = '', ylabel = '' }) {
    Object.assign(this, { x, y, w, h, xr, yr, title, xlabel, ylabel });
    this.parts = [];
    this.clipId = 'clip' + ++clipN;
  }
  sx(v) {
    return this.x + ((v - this.xr[0]) / (this.xr[1] - this.xr[0])) * this.w;
  }
  sy(v) {
    return this.y + this.h - ((v - this.yr[0]) / (this.yr[1] - this.yr[0])) * this.h;
  }
  axes({ xticks, yticks, fx = (v) => it(v, 1), fy = (v) => it(v, 0) } = {}) {
    const P = this.parts;
    const xt = xticks || niceTicks(this.xr[0], this.xr[1], 8), yt = yticks || niceTicks(this.yr[0], this.yr[1], 6);
    P.unshift(`<rect x="${this.x}" y="${this.y}" width="${this.w}" height="${this.h}" fill="#fff" stroke="${COL.axis}" stroke-width="1"/>`);
    for (const v of xt) {
      const X = this.sx(v);
      P.splice(1, 0, `<line x1="${X}" y1="${this.y}" x2="${X}" y2="${this.y + this.h}" stroke="${COL.grid}"/>`);
      P.push(`<text x="${X}" y="${this.y + this.h + 16}" font-size="12" text-anchor="middle" fill="${COL.axis}" ${FONT}>${esc(fx(v))}</text>`);
    }
    for (const v of yt) {
      const Y = this.sy(v);
      P.splice(1, 0, `<line x1="${this.x}" y1="${Y}" x2="${this.x + this.w}" y2="${Y}" stroke="${COL.grid}"/>`);
      P.push(`<text x="${this.x - 6}" y="${Y + 4}" font-size="12" text-anchor="end" fill="${COL.axis}" ${FONT}>${esc(fy(v))}</text>`);
    }
    if (this.title) P.push(`<text x="${this.x}" y="${this.y - 8}" font-size="15" font-weight="bold" fill="#222" ${FONT}>${esc(this.title)}</text>`);
    if (this.xlabel) P.push(`<text x="${this.x + this.w / 2}" y="${this.y + this.h + 34}" font-size="13" text-anchor="middle" fill="#333" ${FONT}>${esc(this.xlabel)}</text>`);
    if (this.ylabel) P.push(`<text transform="translate(${this.x - 44},${this.y + this.h / 2}) rotate(-90)" font-size="13" text-anchor="middle" fill="#333" ${FONT}>${esc(this.ylabel)}</text>`);
    return this;
  }
  line(xs, ys, { color = '#000', width = 1.5, dash = '', opacity = 1 } = {}) {
    let d = '';
    let pen = false;
    for (let i = 0; i < xs.length; i++) {
      if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) {
        pen = false;
        continue;
      }
      d += `${pen ? 'L' : 'M'}${this.sx(xs[i]).toFixed(1)},${this.sy(ys[i]).toFixed(1)}`;
      pen = true;
    }
    if (d) this.parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-opacity="${opacity}" ${dash ? `stroke-dasharray="${dash}"` : ''} clip-path="url(#${this.clipId})"/>`);
    return this;
  }
  rect(x0, x1, y0, y1, { color = '#000', opacity = 1, stroke = '', sw = 1 } = {}) {
    const X0 = this.sx(Math.min(x0, x1)), X1 = this.sx(Math.max(x0, x1)), Y0 = this.sy(Math.max(y0, y1)), Y1 = this.sy(Math.min(y0, y1));
    this.parts.push(`<rect x="${X0.toFixed(1)}" y="${Y0.toFixed(1)}" width="${(X1 - X0).toFixed(1)}" height="${(Y1 - Y0).toFixed(1)}" fill="${color}" fill-opacity="${opacity}" ${stroke ? `stroke="${stroke}" stroke-width="${sw}"` : ''} clip-path="url(#${this.clipId})"/>`);
    return this;
  }
  dot(x, y, { color = '#000', r = 3.5, open = false } = {}) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return this;
    this.parts.push(`<circle cx="${this.sx(x).toFixed(1)}" cy="${this.sy(y).toFixed(1)}" r="${r}" fill="${open ? '#fff' : color}" stroke="${color}" stroke-width="1.5" clip-path="url(#${this.clipId})"/>`);
    return this;
  }
  text(x, y, s, { size = 12, color = '#333', anchor = 'start', bold = false, px = false } = {}) {
    const X = px ? x : this.sx(x), Y = px ? y : this.sy(y);
    this.parts.push(`<text x="${X.toFixed(1)}" y="${Y.toFixed(1)}" font-size="${size}" text-anchor="${anchor}" fill="${color}" ${bold ? 'font-weight="bold"' : ''} ${FONT}>${esc(s)}</text>`);
    return this;
  }
  hband(y0, y1, opts = {}) {
    return this.rect(this.xr[0], this.xr[1], y0, y1, { color: COL.ref, opacity: 0.16, ...opts });
  }
  vband(x0, x1, opts = {}) {
    return this.rect(x0, x1, this.yr[0], this.yr[1], { color: COL.ref, opacity: 0.16, ...opts });
  }
  toString() {
    return `<defs><clipPath id="${this.clipId}"><rect x="${this.x}" y="${this.y}" width="${this.w}" height="${this.h}"/></clipPath></defs><g>${this.parts.join('')}</g>`;
  }
}

export function svgDoc(w, h, body, title = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#fafafa"/>${title ? `<text x="20" y="30" font-size="19" font-weight="bold" fill="#111" ${FONT}>${esc(title)}</text>` : ''}${body}</svg>`;
}

// a vertical legend at (x, y): [label, colour, dash?] per row
function legend(items, x, y) {
  return items
    .map(([label, color, dash], i) => {
      const Y = y + i * 20;
      return `<line x1="${x}" y1="${Y - 4}" x2="${x + 26}" y2="${Y - 4}" stroke="${color}" stroke-width="3" ${dash ? `stroke-dasharray="${dash}"` : ''}/><text x="${x + 32}" y="${Y}" font-size="13" fill="#333" ${FONT}>${esc(label)}</text>`;
    })
    .join('');
}

// ---- per-stride helpers ---------------------------------------------------------------------------------------------
// stride phase of time t: k + (t − t0_k) / T_k over the strides (NaN outside)
export function phaseOf(strides, t) {
  for (let k = 0; k < strides.length; k++) if (t >= strides[k].t0 && t < strides[k].t1) return k + (t - strides[k].t0) / strides[k].T;
  return NaN;
}

// samples of each stride: [{ idx: [...], u: [...] }]
function strideSamples(run, strides) {
  const t = run.samples.map((s) => s.t);
  return strides.map((s) => {
    const idx = [], u = [];
    for (let i = 0; i < t.length; i++)
      if (t[i] >= s.t0 && t[i] <= s.t1) {
        idx.push(i);
        u.push((t[i] - s.t0) / s.T);
      }
    return { idx, u };
  });
}

// mean curve over strides of a per-sample quantity, on `bins` phase bins
function meanCurve(per, get, bins = 100) {
  const sum = new Float64Array(bins), n = new Float64Array(bins);
  for (const s of per)
    s.idx.forEach((i, k) => {
      const b = Math.min(bins - 1, Math.floor(s.u[k] * bins));
      const v = get(i);
      if (Number.isFinite(v)) (sum[b] += v), n[b]++;
    });
  const u = [], y = [];
  for (let b = 0; b < bins; b++) (u.push((b + 0.5) / bins), y.push(n[b] ? sum[b] / n[b] : NaN));
  return { u, y };
}

// mean contact phases of a leg relative to the stride its touchdown falls in: [{ a, b }] (b may exceed 1)
function meanContactPhase(A, l) {
  const cs = A.details.contacts[l];
  if (!cs.length) return null;
  const rel = cs.map((c) => {
    const s = A.strides.find((x) => c.td >= x.t0 && c.td < x.t1);
    return s ? { a: (c.td - s.t0) / s.T, b: (c.lo - s.t0) / s.T } : null;
  }).filter(Boolean);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  return { a: mean(rel.map((r) => r.a)), b: mean(rel.map((r) => r.b)) };
}

// contact bars of the 4 legs under a phase axis [0, 1] (wrapping)
function contactStrip(A, x, y, w, rowH = 18, legs = [0, 1, 2, 3]) {
  const C = new Chart({ x, y, w, h: rowH * legs.length, xr: [0, 1], yr: [0, legs.length] });
  C.parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${rowH * legs.length}" fill="#fff" stroke="#bbb"/>`);
  legs.forEach((l, r) => {
    const p = meanContactPhase(A, l);
    const y0 = legs.length - r - 0.85, y1 = legs.length - r - 0.15;
    if (p) {
      const segs = p.b <= 1 ? [[p.a, p.b]] : [[p.a, 1], [0, p.b - 1]];
      for (const [a, b] of segs) C.rect(a, b, y0, y1, { color: LEGC[l], opacity: 0.85 });
    }
    C.text(x - 6, C.sy((y0 + y1) / 2) + 4, LEGN[l], { px: true, anchor: 'end', size: 11, color: LEGC[l], bold: true });
  });
  return C.toString();
}

// ---- (a) Hildebrand gait diagram ------------------------------------------------------------------------------------
export function gaitDiagram(run, A, ref = {}, title = '') {
  const W = 1600, H = 560;
  const nS = Math.min(2, A.strides.length);
  const st = A.strides.slice(0, nS);
  const t0 = st[0].t0, t1 = st[nS - 1].t1;
  const C = new Chart({ x: 90, y: 70, w: W - 130, h: 330, xr: [0, nS], yr: [0, 4], title: 'Hildebrand gait diagram (geometric contact)', xlabel: 'stride phase (0 = LF touchdown)' });
  C.axes({ xticks: niceTicks(0, nS, 8), yticks: [], fx: (v) => it(v, 2) });
  // the suspensions (no hoof down) shaded behind the bars
  for (const [a, b] of A.susp.gaps) {
    if (b <= t0 || a >= t1) continue;
    C.rect(phaseOf(st, Math.max(a, t0)), phaseOf(st, Math.min(b, t1 - 1e-9)), 0, 4, { color: COL.susp, opacity: 0.45 });
  }
  const rows = [0, 1, 2, 3];
  const S = run.samples;
  rows.forEach((l, r) => {
    const yTop = 4 - r - 0.15, yBot = 4 - r - 0.7;
    for (const c of A.iv[l]) {
      if (c.lo <= t0 || c.td >= t1) continue;
      const a = phaseOf(st, Math.max(c.td, t0)), b = phaseOf(st, Math.min(c.lo, t1 - 1e-9));
      // a plant in full colour, a scrape (never flat) pale and outlined
      const flat = !c.win || c.win.flat;
      C.rect(a, b, yBot, yTop, flat ? { color: LEGC[l], opacity: 0.85 } : { color: LEGC[l], opacity: 0.3, stroke: LEGC[l], sw: 1.5 });
      // reference band for the lift-off of this contact (duty factor range)
      const key = l < 2 ? 'duty.fore' : 'duty.hind';
      if (ref[key] && c.td >= t0) {
        const s = st.find((x) => c.td >= x.t0 && c.td < x.t1);
        if (s) {
          const lo = ref[key].lo != null ? c.td + ref[key].lo * s.T : c.td, hi = ref[key].hi != null ? c.td + ref[key].hi * s.T : c.lo;
          C.rect(phaseOf(st, lo), phaseOf(st, Math.min(hi, t1 - 1e-9)), yTop, yTop + 0.1, { color: COL.ref, opacity: 0.9 });
        }
      }
    }
    // internal stance (label) under the bar
    let on = null;
    for (let i = 0; i < S.length; i++) {
      const t = S[i].t;
      if (t < t0 || t > t1) continue;
      const st_ = S[i].lab.stance[l];
      if (st_ && on === null) on = t;
      if ((!st_ || t >= t1 - 1e-9) && on !== null) {
        C.rect(phaseOf(st, on), phaseOf(st, Math.min(t, t1 - 1e-9)), yBot - 0.12, yBot - 0.05, { color: '#333', opacity: 0.7 });
        on = null;
      }
    }
    C.text(C.x - 10, C.sy((yTop + yBot) / 2) + 5, LEGN[l], { px: true, anchor: 'end', size: 15, bold: true, color: LEGC[l] });
  });
  const M = A.metrics;
  const notes = [
    `duty factor fore ${it(M['duty.fore'], 3)} · hind ${it(M['duty.hind'], 3)}`,
    `suspension ${it(M['suspension.frac'] * 100, 1)} % of the stride, ${it(M['suspension.count'], 1)} phases per stride`,
    `diagonal dissociation at touchdown ${it(M['diag.dap_td_ms'], 1)} ms, at lift-off ${it(M['diag.dap_lo_ms'], 1)} ms (+ = hind first)`,
    `stride ${it(M['stride.period_s'] * 1000, 0)} ms · ${it(M['stride.length_m'], 2)} m · ${it(M['stride.freq_hz'], 2)} Hz`,
  ];
  let body = C.toString();
  body += notes.map((s, i) => `<text x="90" y="${460 + i * 20}" font-size="14" fill="#222" ${FONT}>${esc(s)}</text>`).join('');
  body += legend([['geometric contact (lowest hoof point ≤ 4 mm); pale = scrape, never flat', '#666'], ['internal stance of the code (label only)', '#333', ''], ['suspension: no hoof on the ground', COL.susp], ...(ref['duty.fore'] || ref['duty.hind'] ? [['reference: expected lift-off (duty factor)', COL.ref]] : [])], 900, 460);
  return svgDoc(W, H, body, title);
}

// ---- (b) vertical displacements -------------------------------------------------------------------------------------
export function verticals(run, A, ref = {}, title = '') {
  const W = 1600, H = 900;
  const S = run.samples;
  const per = strideSamples(run, A.strides);
  const sig = [
    ['withers', 'withers', COL.withers, 'trunk.withers_dy_mm'],
    ['sacrum', 'sacrum (croup)', COL.sacrum, 'trunk.sacrum_dy_mm'],
    ['poll', 'poll', COL.poll, 'head.poll_dy_mm'],
  ];
  const [w0, w1] = A.details.window_s;
  const means = {};
  for (const [k] of sig) {
    const v = S.filter((s) => s.t >= w0 && s.t <= w1).map((s) => s.geo[k][1]);
    means[k] = v.reduce((a, b) => a + b, 0) / v.length;
  }
  let lo = Infinity, hi = -Infinity;
  for (const [k] of sig) for (const p of per) for (const i of p.idx) (lo = Math.min(lo, (S[i].geo[k][1] - means[k]) * 1000)), (hi = Math.max(hi, (S[i].geo[k][1] - means[k]) * 1000));
  const pad = (hi - lo) * 0.12 + 2;
  const C = new Chart({ x: 90, y: 70, w: W - 130, h: 520, xr: [0, 1], yr: [lo - pad, hi + pad], title: 'Vertical displacement (from the mean) by stride phase', xlabel: 'stride phase (0 = LF touchdown)', ylabel: 'mm' });
  C.axes({ xticks: niceTicks(0, 1, 10), fx: (v) => it(v, 1) });
  // diagonal stances (mean phases) shaded lightly, and the reference window of the minima
  for (const [k, name, color, key] of sig) {
    for (const p of per) C.line(p.u, p.idx.map((i) => (S[i].geo[k][1] - means[k]) * 1000), { color, width: 1, opacity: 0.22 });
    const m = meanCurve(per, (i) => (S[i].geo[k][1] - means[k]) * 1000);
    C.line(m.u, m.y, { color, width: 3 });
    const r = ref[key];
    if (r) {
      const ymin = Math.min(...m.y.filter(Number.isFinite));
      C.hband(ymin + (r.lo ?? 0), ymin + (r.hi ?? r.lo ?? 0), { color, opacity: 0.1 });
    }
  }
  // where the withers' minimum should fall in each diagonal stance overlapping the first stride (phases of that stride)
  const rmin = ref['trunk.withers_min_at_stance'];
  if (rmin) {
    const s = A.strides[0];
    for (const d of A.diag) {
      if (d.end <= s.t0 || d.start >= s.t1) continue;
      const span = d.end - d.start;
      const a = (d.start + (rmin.lo ?? 0) * span - s.t0) / s.T, b = (d.start + (rmin.hi ?? 1) * span - s.t0) / s.T;
      if (b > 0 && a < 1) C.vband(Math.max(0, a), Math.min(1, b), { opacity: 0.12 });
    }
  }
  let body = C.toString();
  body += contactStrip(A, 90, 640, W - 130);
  body += `<text x="90" y="632" font-size="13" fill="#333" ${FONT}>mean contacts by phase (geometric)</text>`;
  const M = A.metrics;
  const notes = [
    `withers: ${it(M['trunk.withers_dy_mm'], 1)} mm peak-to-peak, minimum at ${it(M['trunk.withers_min_at_stance'], 2)} of the diagonal stance`,
    `sacrum: ${it(M['trunk.sacrum_dy_mm'], 1)} mm, minimum at ${it(M['trunk.sacrum_min_at_stance'], 2)}`,
    `poll: ${it(M['head.poll_dy_mm'], 1)} mm, lag ${it(M['head.lag_ms'], 0)} ms behind the withers`,
    `muzzle: ${it(M['head.muzzle_dy_mm'], 1)} mm`,
    `vertical acceleration in suspension: ${it(M['trunk.flight_accel_mps2'], 2)} m/s² (physics: −9.81)`,
    `pitch ${it(M['trunk.pitch_deg'], 2)}° · roll ${it(M['trunk.roll_deg'], 2)}° p-p`,
  ];
  const y0 = 740;
  body += legend(sig.map(([, n, c]) => [n, c]), 90, y0);
  body += `<text x="90" y="${y0 + 70}" font-size="12" fill="#777" ${FONT}>thin lines: each stride · thick: mean</text>`;
  if (Object.keys(ref).some((k) => /dy_mm|min_at_stance/.test(k))) body += `<text x="90" y="${y0 + 90}" font-size="12" fill="${COL.ref}" ${FONT}>bands: reference (p-p from the minimum; window of the minimum)</text>`;
  body += notes.map((s, i) => `<text x="${i < 3 ? 420 : 1000}" y="${y0 + (i % 3) * 24}" font-size="14" fill="#222" ${FONT}>${esc(s)}</text>`).join('');
  return svgDoc(W, H, body, title);
}

// ---- (c) hoof paths -------------------------------------------------------------------------------------------------
export function hoofPaths(run, A, ref = {}, title = '') {
  const W = 1800, H = 700;
  const S = run.samples;
  const legs = [0, 2];
  const s0 = A.strides[0];
  const nS = Math.min(2, A.strides.length);
  const tEnd = A.strides[nS - 1].t1;
  const hd = (i) => S[i].geo.heading;
  const fwd = (p, o, i) => (p[0] - o[0]) * hd(i)[0] + (p[2] - o[2]) * hd(i)[1];
  // panel 1: body frame, one stride
  const idx1 = [];
  for (let i = 0; i < S.length; i++) if (S[i].t >= s0.t0 && S[i].t <= s0.t1) idx1.push(i);
  let xmin = Infinity, xmax = -Infinity, ymax = 0;
  for (const l of [0, 1, 2, 3])
    for (const i of idx1) {
      const x = fwd(S[i].geo.legs[l].sole, S[i].geo.body, i);
      (xmin = Math.min(xmin, x)), (xmax = Math.max(xmax, x)), (ymax = Math.max(ymax, S[i].geo.legs[l].soleH * 1000));
    }
  const P1 = new Chart({ x: 80, y: 70, w: 500, h: 420, xr: [xmin - 0.05, xmax + 0.05], yr: [-20, ymax * 1.15 + 10], title: 'Sole-centre path — trunk frame', xlabel: 'forward of the trunk centre (m)', ylabel: 'height above the ground (mm)' });
  P1.axes({ fx: (v) => it(v, 1) });
  for (const [l, key] of [[0, 'fore.hoof_max_h_mm'], [2, 'hind.hoof_max_h_mm']]) if (ref[key]) P1.hband(ref[key].lo ?? 0, ref[key].hi ?? ref[key].lo, { color: LEGC[l], opacity: 0.12 });
  for (const l of [0, 1, 2, 3]) {
    const xs = idx1.map((i) => fwd(S[i].geo.legs[l].sole, S[i].geo.body, i)), ys = idx1.map((i) => S[i].geo.legs[l].soleH * 1000);
    P1.line(xs, ys, { color: LEGC[l], width: legs.includes(l) ? 2.5 : 1.2, dash: legs.includes(l) ? '' : '5 4', opacity: legs.includes(l) ? 1 : 0.6 });
    for (const c of A.iv[l]) {
      if (c.td >= s0.t0 && c.td < s0.t1) {
        const i = c.i0;
        P1.dot(fwd(S[i].geo.legs[l].sole, S[i].geo.body, i), S[i].geo.legs[l].soleH * 1000, { color: LEGC[l] });
      }
      if (c.lo >= s0.t0 && c.lo < s0.t1) {
        const i = c.i1;
        P1.dot(fwd(S[i].geo.legs[l].sole, S[i].geo.body, i), S[i].geo.legs[l].soleH * 1000, { color: LEGC[l], open: true });
      }
    }
  }
  // panel 2: world frame, two strides, along the travel from the start of the window
  const idx2 = [];
  for (let i = 0; i < S.length; i++) if (S[i].t >= s0.t0 && S[i].t <= tEnd) idx2.push(i);
  const o = S[idx2[0]].geo.root;
  let x2min = Infinity, x2max = -Infinity;
  for (const l of legs) for (const i of idx2) {
    const x = fwd(S[i].geo.legs[l].sole, o, i);
    (x2min = Math.min(x2min, x)), (x2max = Math.max(x2max, x));
  }
  const P2 = new Chart({ x: 680, y: 70, w: 560, h: 420, xr: [x2min - 0.1, x2max + 0.1], yr: [-20, ymax * 1.15 + 10], title: 'World frame (2 strides): a stance is a point', xlabel: 'along the travel (m)', ylabel: 'height (mm)' });
  P2.axes({ fx: (v) => it(v, 1) });
  for (const l of legs) {
    P2.line(idx2.map((i) => fwd(S[i].geo.legs[l].sole, o, i)), idx2.map((i) => S[i].geo.legs[l].soleH * 1000), { color: LEGC[l], width: 2 });
    for (const i of idx2) if (S[i].geo.legs[l].contact) P2.dot(fwd(S[i].geo.legs[l].sole, o, i), S[i].geo.legs[l].soleH * 1000, { color: LEGC[l], r: 2 });
    P2.line(idx2.map((i) => fwd(S[i].geo.legs[l].toe, o, i)), idx2.map((i) => S[i].geo.legs[l].toeH * 1000), { color: LEGC[l], width: 1, dash: '3 3', opacity: 0.8 });
  }
  // panel 3: slip during each contact (sole centre along the travel, from its position at the start of the planted window)
  const P3data = [];
  let ylo = -2, yhi = 2;
  for (const l of legs)
    for (const c of A.details.contacts[l]) {
      const ii = [];
      for (let i = 0; i < S.length; i++) if (S[i].t >= c.td && S[i].t <= c.lo) ii.push(i);
      if (!ii.length) continue;
      const k0 = ii.find((i) => S[i].t >= c.td + 0.1 * c.dur) ?? ii[0];
      const ref0 = S[k0].geo.legs[l].sole, toe0 = S[k0].geo.legs[l].toe;
      const xs = ii.map((i) => (S[i].t - c.td) / c.dur);
      const ys = ii.map((i) => fwd(S[i].geo.legs[l].sole, ref0, i) * 1000);
      const yt = ii.map((i) => fwd(S[i].geo.legs[l].toe, toe0, i) * 1000);
      // sideways (toward the horse's left +): the heading (hx, hz) turned a quarter left is (hz, −hx)
      const yl = ii.map((i) => {
        const p = S[i].geo.legs[l].sole, h = hd(i);
        return ((p[0] - ref0[0]) * h[1] - (p[2] - ref0[2]) * h[0]) * 1000;
      });
      for (const v of [...ys, ...yt, ...yl]) (ylo = Math.min(ylo, v)), (yhi = Math.max(yhi, v));
      P3data.push({ l, xs, ys, yt, yl, bo: c.boFrac });
    }
  const P3 = new Chart({ x: 1340, y: 70, w: 420, h: 420, xr: [0, 1], yr: [ylo - 3, yhi + 3], title: 'Slip during the contact', xlabel: 'fraction of the contact', ylabel: 'displacement from 10 % of the contact (mm)' });
  P3.axes({ fx: (v) => it(v, 1) });
  for (const [l, key] of [[0, 'contact.slip_mm.fore'], [2, 'contact.slip_mm.hind']]) if (ref[key]) P3.hband(-(ref[key].hi ?? 0), ref[key].hi ?? 0, { color: LEGC[l], opacity: 0.1 });
  P3.vband(0, 0.1, { color: '#999', opacity: 0.12 });
  for (const d of P3data) {
    P3.line(d.xs, d.ys, { color: LEGC[d.l], width: 1.6, opacity: 0.8 });
    P3.line(d.xs, d.yt, { color: LEGC[d.l], width: 1, dash: '3 3', opacity: 0.6 });
    P3.line(d.xs, d.yl, { color: LEGC[d.l], width: 1.2, dash: '1 3', opacity: 0.9 });
    if (d.bo < 1) P3.line([d.bo, d.bo], [ylo - 3, yhi + 3], { color: LEGC[d.l], width: 0.8, dash: '2 4', opacity: 0.6 });
  }
  let body = P1.toString() + P2.toString() + P3.toString();
  body += legend([['LF (left fore)', COL.LF], ['LH (left hind)', COL.LH], ['RF, RH (dashed, panel 1 only)', '#888', '5 4']], 80, 560);
  const M = A.metrics;
  const notes = [
    `panel 1: filled dots = touchdown, open = lift-off · panel 2: dashed = toe; dots = samples in contact`,
    `panel 3: solid = sole centre along the travel, dotted = sole centre sideways (+ = to the left), dashed = toe; verticals = breakover start; grey = first 10 %`,
    `slip in the planted window: fore ${it(M['contact.slip_mm.fore'], 1)} mm · hind ${it(M['contact.slip_mm.hind'], 1)} mm · over the whole contact ${it(M['contact.slip_full_mm'], 1)} mm · toe at breakover ${it(M['contact.breakover_toe_slip_mm'], 1)} mm`,
    `maximum height in swing: fore ${it(M['fore.hoof_max_h_mm'], 0)} mm · hind ${it(M['hind.hoof_max_h_mm'], 0)} mm · maximum penetration ${it(M['contact.penetration_mm'], 1)} mm`,
  ];
  body += notes.map((s, i) => `<text x="480" y="${560 + i * 22}" font-size="13" fill="#222" ${FONT}>${esc(s)}</text>`).join('');
  return svgDoc(W, H, body, title);
}

// ---- (d) joint angles -------------------------------------------------------------------------------------------------
export function jointAngles(run, A, stand, ref = {}, title = '') {
  const W = 1800, H = 900;
  const per = strideSamples(run, A.strides);
  const panels = [
    [0, 'carpus', 'Carpus (LF)', 'fore.carpus_max_flex_deg', (r) => [r.lo, r.hi]],
    [0, 'fetlock', 'Fore fetlock (LF)', 'fore.fetlock_ext_deg', (r, s) => [s - r.hi, s - r.lo]],
    [0, 'elbow', 'Elbow (LF)', null],
    [2, 'hock', 'Hock (LH)', 'hind.hock_max_flex_deg', (r, s) => [s + r.lo, s + r.hi]],
    [2, 'fetlock', 'Hind fetlock (LH)', 'hind.fetlock_ext_deg', (r, s) => [s - r.hi, s - r.lo]],
    [2, 'stifle', 'Stifle (LH)', null],
  ];
  let body = '';
  panels.forEach(([l, key, name, refKey, band], k) => {
    const col = k % 3, row = Math.floor(k / 3);
    const x = 80 + col * 590, y = 70 + row * 410;
    const vals = [];
    for (const p of per) for (const i of p.idx) vals.push(A.D.legs[l].ang[i][key]);
    const sv = stand.legs[l][key];
    const rb = refKey && ref[refKey] ? band({ lo: ref[refKey].lo ?? ref[refKey].hi, hi: ref[refKey].hi ?? ref[refKey].lo }, sv) : null;
    const lo = Math.min(...vals, sv, ...(rb || [])), hi = Math.max(...vals, sv, ...(rb || []));
    const pad = (hi - lo) * 0.1 + 2;
    const C = new Chart({ x, y, w: 500, h: 300, xr: [0, 1], yr: [lo - pad, hi + pad], title: name, xlabel: 'stride phase', ylabel: 'flexion (°)' });
    C.axes({ fx: (v) => it(v, 1) });
    if (rb) C.hband(rb[0], rb[1]);
    // contact of this leg (mean phases)
    const p = meanContactPhase(A, l);
    if (p) for (const [a, b] of p.b <= 1 ? [[p.a, p.b]] : [[p.a, 1], [0, p.b - 1]]) C.vband(a, b, { color: LEGC[l], opacity: 0.08 });
    for (const q of per) C.line(q.u, q.idx.map((i) => A.D.legs[l].ang[i][key]), { color: LEGC[l], width: 1, opacity: 0.25 });
    const m = meanCurve(per, (i) => A.D.legs[l].ang[i][key]);
    C.line(m.u, m.y, { color: LEGC[l], width: 3 });
    C.line([0, 1], [sv, sv], { color: '#333', width: 1.2, dash: '6 4' });
    body += C.toString();
  });
  body += legend([['each stride (thin) and mean (thick)', '#666'], ['square stand', '#333', '6 4'], ['geometric contact of the limb (band)', '#bbb']], 80, 880 - 40);
  body += `<text x="700" y="852" font-size="13" fill="#222" ${FONT}>${esc('angle between the two segments in the limb plane: 0 = straight, positive = flexion; the standing fetlocks are negative (extended)')}</text>`;
  if (Object.keys(ref).some((k) => /flex_deg|ext_deg/.test(k))) body += `<text x="700" y="874" font-size="13" fill="${COL.ref}" ${FONT}>green bands: reference</text>`;
  return svgDoc(W, H, body, title);
}
