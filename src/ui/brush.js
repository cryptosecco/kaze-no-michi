// Procedural sumi-e brush marks as SVG path data. Strokes land with a pressure blob, swell, then thin into a
// dry-brush tail of broken bristle streaks. Deterministic per seed: every mark looks hand-painted but stable.

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Smooth 1D random function on [0, 1] from n control points.
function smoothNoise(r, n) {
  const pts = Array.from({ length: n }, () => r() * 2 - 1);
  return (t) => {
    const x = Math.min(0.9999, Math.max(0, t)) * (n - 1);
    const i = Math.floor(x);
    const f = x - i;
    const s = f * f * (3 - 2 * f);
    return pts[i] * (1 - s) + pts[i + 1] * s;
  };
}

const f1 = (v) => (Math.round(v * 10) / 10).toString();

function ribbon(center, halfW, steps) {
  const up = [];
  const lo = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const [x, y, nx, ny] = center(t);
    const [hu, hl] = halfW(t);
    up.push([x + nx * hu, y + ny * hu]);
    lo.push([x - nx * hl, y - ny * hl]);
  }
  let d = `M${f1(up[0][0])},${f1(up[0][1])}`;
  for (let i = 1; i < up.length; i++) d += `L${f1(up[i][0])},${f1(up[i][1])}`;
  for (let i = lo.length - 1; i >= 0; i--) d += `L${f1(lo[i][0])},${f1(lo[i][1])}`;
  return d + 'Z';
}

// Horizontal stroke inside a w×h box. Returns { d, streaks: [d…] } — draw both with the same fill.
export function stroke({
  w = 240,
  h = 14,
  seed = 1,
  landing = 0.07, // fraction of length for the brush to land
  tail = 0.42, // fraction of length that thins out
  head = 1.18, // extra pressure at the landing point
  wobble = 0.1, // centerline waviness (fraction of h)
  rough = 0.14, // edge raggedness
  dry = 5, // bristle streaks continuing into the tail
  lift = 0.0, // centerline rises toward the tail (fraction of h)
} = {}) {
  const r = rng(seed);
  const pad = h * 0.35;
  const cy = h / 2;
  const nc = smoothNoise(r, 5);
  const nu = smoothNoise(r, 17);
  const nl = smoothNoise(r, 17);
  const len = w - pad * 2;
  const thick = (t) => {
    let a = Math.min(1, t / landing);
    a = Math.sin((a * Math.PI) / 2);
    const tt = t > 1 - tail ? 1 - (t - (1 - tail)) / tail : 1;
    a *= Math.pow(Math.max(0, tt), 0.75);
    a *= 1 + (head - 1) * Math.exp(-((t - landing * 1.2) ** 2) / 0.006);
    return a;
  };
  const center = (t) => [pad + t * len, cy + nc(t) * h * wobble - lift * h * t * t, 0, -1];
  // keep the painted body inside the box even at peak pressure + wobble + ragged edges
  const half = Math.max(0.5, (h / 2 - 0.5 - wobble * h * 0.9) / (head * (1 + rough * 0.85)));
  const d = ribbon(
    center,
    (t) => [half * thick(t) * (1 + nu(t) * rough), half * thick(t) * (1 + nl(t) * rough)],
    72
  );
  // dry-brush bristles: thin broken streaks that start inside the body and run past the solid tail
  const streaks = [];
  for (let k = 0; k < dry; k++) {
    const off = (r() * 2 - 1) * half * 0.8;
    const t0 = 1 - tail * (0.9 + r() * 0.4);
    const t1 = Math.min(1.02, 1 - tail * 0.1 + r() * 0.12);
    const tw = half * (0.1 + r() * 0.16);
    const gap = r() < 0.6 ? t0 + (t1 - t0) * (0.35 + r() * 0.3) : -1;
    const seg = (a, b) =>
      ribbon(
        (s) => {
          const t = a + (b - a) * s;
          const [x, y] = center(t);
          return [x, y + off * (1 - t * 0.2), 0, -1];
        },
        (s) => {
          const e = Math.sin(Math.PI * Math.min(1, s * 1.15)) * tw;
          return [e, e];
        },
        14
      );
    if (gap > 0) {
      streaks.push(seg(t0, gap - 0.015));
      streaks.push(seg(gap + 0.02, t1));
    } else streaks.push(seg(t0, t1));
  }
  return { d, streaks, w, h };
}

// Ensō-like ring (open circle painted in one breath) inside a size×size box.
export function enso({ size = 20, seed = 3, width = 0.16, gapFrac = 0.12, rough = 0.12 } = {}) {
  const r = rng(seed);
  const cx = size / 2;
  const cy = size / 2;
  const rad = size * 0.36;
  const start = r() * Math.PI * 2;
  const sweep = Math.PI * 2 * (1 - gapFrac);
  const nw = smoothNoise(r, 9);
  const nr = smoothNoise(r, 7);
  const w = size * width;
  return ribbon(
    (t) => {
      const a = start + t * sweep;
      const rr = rad * (1 + nr(t) * 0.05);
      return [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, Math.cos(a), Math.sin(a)];
    },
    (t) => {
      const land = Math.sin(Math.min(1, t / 0.08) * Math.PI * 0.5);
      const tail = Math.pow(1 - t, 0.55);
      const e = w * 0.5 * land * (0.45 + 0.75 * tail) * (1 + nw(t) * rough);
      return [e, e];
    },
    60
  );
}

// Build an <svg> string for a stroke (optionally with an id'd clip for progress reveals).
export function strokeSVG(opts = {}, { fill = 'currentColor', filter = 'url(#kz-rough)', cls = '' } = {}) {
  const s = stroke(opts);
  const paths = [s.d, ...s.streaks].map((d) => `<path d="${d}"/>`).join('');
  return `<svg class="${cls}" viewBox="0 0 ${s.w} ${s.h}" width="${s.w}" height="${s.h}" preserveAspectRatio="none" aria-hidden="true"><g fill="${fill}" style="filter:${filter}">${paths}</g></svg>`;
}

export function ensoSVG(opts = {}, { fill = 'currentColor', cls = '' } = {}) {
  const size = opts.size || 20;
  return `<svg class="${cls}" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true"><path fill="${fill}" d="${enso(opts)}" style="filter:url(#kz-rough)"/></svg>`;
}

// Calligraphy text with its shadow on a separate layer. (An SVG ink filter chained with drop-shadow or fed a
// text-shadow turns the blurred shadow into a streaky rectangle, so the glow never passes through the filter.)
export function inkText(text, lang = 'ja') {
  return `<span class="g" aria-hidden="true">${text}</span><span class="i" lang="${lang}">${text}</span>`;
}

// Shared SVG filters: rough ink edges, the calligraphy logo treatment and the hanko seal.
export const SVG_DEFS = `
<svg width="0" height="0" style="position:absolute;width:0;height:0" aria-hidden="true" focusable="false">
  <defs>
    <filter id="kz-rough" x="-10%" y="-40%" width="120%" height="180%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="4" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="1.8" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    <filter id="kz-logo" x="-8%" y="-12%" width="116%" height="124%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.012 0.03" numOctaves="3" seed="7" result="warp"/>
      <feDisplacementMap in="SourceGraphic" in2="warp" scale="6" xChannelSelector="R" yChannelSelector="G" result="shape"/>
      <feMorphology in="shape" operator="erode" radius="2.6" result="core"/>
      <feTurbulence type="fractalNoise" baseFrequency="0.5 0.045" numOctaves="2" seed="12" result="fiber"/>
      <feColorMatrix in="fiber" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -3.2 0 0 0 2.25" result="fiberMask"/>
      <feComposite in="shape" in2="fiberMask" operator="in" result="dry"/>
      <!-- ink load: where the brush was loaded the stroke is full, where it ran dry only the fibres show -->
      <feTurbulence type="fractalNoise" baseFrequency="0.005 0.014" numOctaves="2" seed="3" result="load"/>
      <feColorMatrix in="load" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  3.4 0 0 0 -1.25" result="wetMask"/>
      <feComposite in="shape" in2="wetMask" operator="in" result="wet"/>
      <feGaussianBlur in="shape" stdDeviation="1.8" result="soft"/>
      <feComponentTransfer in="soft" result="bleed"><feFuncA type="linear" slope="0.32"/></feComponentTransfer>
      <feMerge><feMergeNode in="bleed"/><feMergeNode in="dry"/><feMergeNode in="wet"/><feMergeNode in="core"/></feMerge>
    </filter>
    <filter id="kz-kanji" x="-8%" y="-12%" width="116%" height="124%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.03 0.06" numOctaves="3" seed="21" result="warp"/>
      <feDisplacementMap in="SourceGraphic" in2="warp" scale="5" xChannelSelector="R" yChannelSelector="G" result="shape"/>
      <feMorphology in="shape" operator="erode" radius="1.4" result="core"/>
      <feTurbulence type="fractalNoise" baseFrequency="0.6 0.06" numOctaves="2" seed="5" result="fiber"/>
      <feColorMatrix in="fiber" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -3.2 0 0 0 2.3" result="fiberMask"/>
      <feComposite in="shape" in2="fiberMask" operator="in" result="dry"/>
      <feMerge><feMergeNode in="dry"/><feMergeNode in="core"/></feMerge>
    </filter>
    <filter id="kz-seal" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.18" numOctaves="3" seed="9" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="2.6" xChannelSelector="R" yChannelSelector="G" result="shape"/>
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="1" seed="15" result="pits"/>
      <feColorMatrix in="pits" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -3.2 0 0 0 2.35" result="pitMask"/>
      <feComposite in="shape" in2="pitMask" operator="in"/>
    </filter>
  </defs>
</svg>`;
