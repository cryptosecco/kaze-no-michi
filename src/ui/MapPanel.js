import { t } from './i18n.js';
import { ensoSVG, rng } from './brush.js';
import { PATHS } from '../world/Layout.js';
import { PLACES, TITLE_MAX, mapPoints, mapFrame, projection, scaleBar, layoutPage, rasterJob, waveMarks, nextObjective, baseKey, inlineBox, pinInset, splitTitle } from './mapModel.js';

// The map of the pause screen. It shows:
//   - the land, the places and the paths;
//   - where the samurai stands and which way he faces;
//   - the horse and the current objective.
// It is north-up and sits in the room right of the menu and below the objective (mapModel.inlineBox). Its edges fade
// into the blurred scene. The terrain is painted on a canvas: the base, which never changes. The base is cached per
// size and painted in slices as the pause opens. Everything that moves is DOM/SVG above it. The geometry, the label
// layout and the raster are in mapModel.js. Pause.js shows and hides the map with the pause menu.
//   host   the .kz-panel-map element Pause.js put in the pause layer. Its pointer-events are off: the map takes no input.
//   avoid  { menu, side, legend }: the elements of the pause screen the map keeps clear of (the logo and menu column,
//          the objective, the controls hint)
// It reads only the event bus and fields on game:
//   - the quest events (the target of the objective);
//   - game.player;
//   - game.modules.actors.horse (absent without the actors module, null in shot mode);
//   - --kz-bar on the UI root (the letterbox, src/ui/bars.js).

const SVG = (inner, vb = '0 0 16 16', cls = '') =>
  `<svg class="${cls}" viewBox="${vb}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

// The small marks of the places, hairlines on a 16 px square.
const GLYPH = {
  shrine: SVG('<path d="M1.8 4.7Q8 2.5 14.2 4.7"/><path d="M3.3 7.6H12.7"/><path d="M4.5 4.4V14M11.5 4.4V14"/>'),
  camp: SVG('<path d="M1.8 13.6L8 3.6L14.2 13.6Z"/><path d="M6.3 13.6L8 9.4L9.7 13.6"/>'),
  ginkgo: SVG('<path d="M8 14.6V10.4"/><path d="M8 10.4L2.1 4.9Q4.4 2.4 7.1 3.6L8 5.4L8.9 3.6Q11.6 2.4 13.9 4.9Z"/><path d="M8 10.4L5.2 4.6M8 10.4L10.8 4.6"/>'),
  pagoda: SVG('<path d="M8 1.2V3.2"/><path d="M4.8 6.1L8 3.3L11.2 6.1"/><path d="M3.4 9.7L8 6.3L12.6 9.7"/><path d="M2 13.5L8 9.5L14 13.5"/>'),
  cliff: SVG('<path d="M1.6 4.4H14.4"/><path d="M3.2 4.4V8M5.6 4.4V10.6M8 4.4V8.4M10.4 4.4V11M12.8 4.4V8"/>'),
};

// The samurai's arrowhead, drawn pointing up (headingDeg() turns it): a kite with a notch, its edges bowed and
// jittered a little, like a brush that dropped three times.
function arrowPath(seed = 4) {
  const r = rng(seed);
  const j = (v, a = 0.5) => (v + (r() - 0.5) * a).toFixed(1);
  return (
    `M${j(16)} ${j(3)}Q${j(17.6)} ${j(14)} ${j(27.6)} ${j(29)}Q${j(22)} ${j(25)} ${j(16)} ${j(22.4)}` +
    `Q${j(10)} ${j(25)} ${j(4.4)} ${j(29)}Q${j(14.4)} ${j(14)} ${j(16)} ${j(3)}Z`
  );
}
const ARROW_SVG = `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="${arrowPath()}" style="filter:url(#kz-rough)"/></svg>`;
const HORSE_SVG = ensoSVG({ size: 20, seed: 11, width: 0.2, gapFrac: 0.3 });
const RING_SVG = (size) => ensoSVG({ size, seed: 3, width: 0.1, gapFrac: 0.1 }, { cls: 'kz-map-ring-svg' });

const el = (cls, html = '') => {
  const d = document.createElement('div');
  d.className = cls;
  if (html) d.innerHTML = html;
  return d;
};

export class MapPanel {
  constructor(ui, host, { avoid = {} } = {}) {
    this.ui = ui;
    this.game = ui.game;
    this.host = host;
    this.avoid = avoid;
    this.visible = false;
    this.objective = null; // { id, title, target: { x, z } } from the quest events
    this.geo = null; // what the last layout measured; null while the map has no room
    this.baseKey = ''; // what the canvas shows
    this.job = null; // the base being painted
    this._resizeTimer = 0;
    // a window being dragged to another size places the map again, and repaints its base, once it settles
    this._onResize = () => {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => this.visible && this.layout(), 160);
    };
    this.build();
    const game = this.game;
    for (const type of ['quest:update', 'quest:complete', 'ending']) {
      game.on(type, (e) => {
        this.objective = nextObjective(this.objective, type, e.detail);
        if (this.visible) this.update(); // a quest can be announced while the pause is up (a timer of 2.2 s)
      });
    }
  }

  build() {
    const host = this.host;
    host.innerHTML = `
      <div class="kz-map-view">
        <canvas class="kz-map-canvas"></canvas>
        <div class="kz-map-overlay"></div>
      </div>`;
    this.view = host.querySelector('.kz-map-view');
    this.canvas = host.querySelector('.kz-map-canvas');
    const ov = (this.overlay = host.querySelector('.kz-map-overlay'));

    this.north = el('kz-map-north', `${SVG('<path d="M11 45V9"/><path d="M11 3L6.8 13L11 10.4L15.2 13Z" fill="currentColor" stroke="none"/>', '0 0 22 48')}<span>N</span>`);
    this.scale = el('kz-map-scale', '<i></i><span></span>');
    this.marks = PLACES.map((p) => ({
      p,
      pt: el('kz-map-pt kz-map-place', `<i class="kz-map-mark">${GLYPH[p.id]}</i>`),
      label: el('kz-map-label'),
    }));
    this.horse = { pt: el('kz-map-pt kz-map-horse', `<i class="kz-map-hmark">${HORSE_SVG}</i>`), label: el('kz-map-label kz-map-label-horse') };
    this.obj = {
      pt: el('kz-map-pt kz-map-obj', `<i class="kz-map-ring">${RING_SVG(60)}</i>`),
      label: el('kz-map-objlabel', '<span class="tag"></span><span class="name"></span>'),
    };
    this.you = el('kz-map-pt kz-map-you', `<i class="kz-map-halo"></i><i class="kz-map-arrow">${ARROW_SVG}</i>`);
    ov.append(
      this.north,
      this.scale,
      ...this.marks.flatMap((m) => [m.pt, m.label]),
      this.horse.pt,
      this.horse.label,
      this.obj.pt,
      this.obj.label,
      this.you
    );
    this.refreshText();
  }

  // The language changed: every label of the map again (the quest title is the quest's own text). The menu and the
  // objective beside the map have new words too, so new widths: the map is placed again.
  refreshText() {
    for (const m of this.marks) m.label.textContent = t(m.p.key);
    this.horse.label.textContent = t('mapHorse');
    this.obj.label.querySelector('.tag').textContent = t('objective');
    if (this.visible) this.layout();
  }

  // ------------------------------------------------------------------------------------------ show / hide
  // The pause menu has opened. The map is placed and its markers are set at once. The base is painted in slices,
  // unless the last one is of the same size, and it fades in when done.
  show() {
    this.visible = true;
    window.addEventListener('resize', this._onResize);
    this.layout();
  }

  // The pause menu has closed. A base half painted is dropped: nothing of the map runs in play.
  hide() {
    this.visible = false;
    window.removeEventListener('resize', this._onResize);
    clearTimeout(this._resizeTimer);
    this._dropJob();
  }

  // ------------------------------------------------------------------------------------------ geometry
  // Where the map goes (mapModel.inlineBox), from what the pause screen shows now. The host takes that box, or is
  // hidden (null) when the window leaves no room for a map that can be read.
  place() {
    const layer = (this.host.offsetParent || this.host.parentElement).getBoundingClientRect();
    const rect = (node) => {
      if (!node) return null;
      const r = node.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return null;
      return { x0: r.left - layer.left, y0: r.top - layer.top, x1: r.right - layer.left, y1: r.bottom - layer.top };
    };
    const { menu, side, legend } = this.avoid;
    const box = inlineBox({
      width: layer.width,
      height: layer.height,
      bar: parseFloat(this.ui.root.style.getPropertyValue('--kz-bar')) || 0,
      menu: rect(menu),
      side: rect(side),
      legend: rect(legend),
    });
    const s = this.host.style;
    this.host.classList.toggle('off', !box);
    if (box) {
      s.left = `${box.x}px`;
      s.top = `${box.y}px`;
      s.width = `${box.w}px`;
      s.height = `${box.h}px`;
    }
    return box;
  }

  // The map's size in CSS and device pixels, the frame it shows, the projection, and how far inside its border a
  // marker that is off it is pinned (the edges fade out: a pinned marker stays where the land still shows).
  measure({ w, h }) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const frame = mapFrame(mapPoints(), w / h);
    return { w, h, dpr, W: Math.round(w * dpr), H: Math.round(h * dpr), frame, proj: projection(frame, w, h), inset: pinInset(w, h) };
  }

  layout() {
    const box = this.place();
    this.geo = box ? this.measure(box) : null;
    if (!this.geo) {
      this._dropJob();
      return;
    }
    const sb = scaleBar(this.geo.proj.scale, { maxPx: 0.17 * this.geo.w }); // 200 m, from a small window to a large one
    this.scale.firstElementChild.style.width = `${sb.px.toFixed(1)}px`;
    this.scale.lastElementChild.textContent = `${sb.meters} m`;
    this.ensureBase();
    this.update();
  }

  // ------------------------------------------------------------------------------------------ the base
  terrain() {
    const gen = this.game.terrain && this.game.terrain.gen;
    return gen && gen.H && gen.surf ? gen : null;
  }

  // Make the canvas show the base of the current geometry. A base of another size is not shown stretched while the new
  // one is painted.
  ensureBase() {
    const g = this.geo, gen = this.terrain();
    if (!g || !gen) return;
    const key = baseKey(g.frame, g.W, g.H, g.dpr);
    this.canvas.classList.toggle('ready', key === this.baseKey);
    if (key === this.baseKey || (this.job && this.job.key === key)) return;
    this._dropJob();
    this.job = { key, g, gen: rasterJob(gen, g.frame, g.W, g.H, { dpr: g.dpr }) };
    this._step();
  }

  // A few slices at a time, as many as fit in a few ms, then the frame goes on (the pause menu keeps rendering).
  _step() {
    const job = this.job;
    if (!job) return;
    const t0 = performance.now();
    let r;
    try {
      do r = job.gen.next();
      while (!r.done && performance.now() - t0 < 6);
    } catch (err) {
      console.error('[kaze] map base failed:', err);
      this.job = null;
      // without a base the markers still show; the same size is not tried again at every opening
      this.canvas.width = this.canvas.height = 1;
      this.baseKey = job.key;
      return;
    }
    if (r.done) {
      this.job = null;
      this._paint(r.value, job.g, job.key);
    } else job.timer = setTimeout(() => this._step(), 0);
  }

  _dropJob() {
    if (this.job) clearTimeout(this.job.timer);
    this.job = null;
  }

  _paint(raster, g, key) {
    const cv = this.canvas;
    cv.width = g.W;
    cv.height = g.H;
    const ctx = cv.getContext('2d');
    ctx.putImageData(new ImageData(raster.rgba, g.W, g.H), 0, 0);
    const bone = (a) => `rgba(242, 233, 216, ${a})`;
    // the sea's wave hairlines
    ctx.lineWidth = g.dpr;
    ctx.lineCap = 'round';
    for (const m of waveMarks({ width: g.W, height: g.H, dpr: g.dpr, sea: raster.sea })) {
      ctx.strokeStyle = bone(m.a.toFixed(3));
      ctx.beginPath();
      for (let s = 0; s <= 16; s++) {
        const u = s / 16;
        const x = m.x + u * m.len, y = m.y + Math.sin(u * Math.PI * 3 + m.ph) * m.amp * Math.sin(u * Math.PI);
        if (s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // the paths: fine dots
    ctx.setLineDash([0.01, 5.2 * g.dpr]);
    ctx.lineWidth = 1.8 * g.dpr;
    ctx.strokeStyle = bone(0.8);
    for (const path of PATHS) {
      ctx.beginPath();
      path.forEach((p, i) => {
        const [x, y] = g.proj.toPx(p.x, p.z);
        if (i === 0) ctx.moveTo(x * g.dpr, y * g.dpr);
        else ctx.lineTo(x * g.dpr, y * g.dpr);
      });
      ctx.stroke();
    }
    ctx.setLineDash([]);
    this.baseKey = key;
    cv.classList.add('ready');
  }

  // ------------------------------------------------------------------------------------------ what moves
  // The markers and their labels, from the world as it stands. The world is frozen while the pause is up, so this runs
  // on opening, on a resize, and when a quest is announced. The layout itself is mapModel.layoutPage().
  update() {
    const g = this.geo;
    if (!g) return;
    const game = this.game;
    const at = (node, x, y) => (node.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`);
    const arrow = this.you.querySelector('.kz-map-arrow');

    const pl = game.player;
    const you = pl && pl.position ? { x: pl.position.x, z: pl.position.z, yaw: pl.yaw || 0 } : null;
    // the horse: not while he rides it, nor without one
    const actors = game.modules && game.modules.actors;
    const hs = actors && actors.horse;
    const hz = hs && hs.horse;
    const mounted = !!(hs && hs.riding && hs.riding.mounted);
    const horse = hz && hz.visible && !mounted && hz.position ? { x: hz.position.x, z: hz.position.z } : null;
    const ob = this.objective;
    // shown or hidden before the labels are measured (a hidden one has no size)
    this.you.style.display = you ? '' : 'none';
    this.horse.pt.style.display = this.horse.label.style.display = horse ? '' : 'none';
    this.obj.pt.style.display = this.obj.label.style.display = ob ? '' : 'none';
    if (ob) {
      // the quest's title, on two lines when one would be too wide for the map (mapModel.TITLE_MAX)
      const name = this.obj.label.querySelector('.name');
      name.textContent = ob.title;
      const lines = this.obj.label.offsetWidth > TITLE_MAX * g.w ? splitTitle(ob.title) : [];
      if (lines.length > 1) name.replaceChildren(lines[0], document.createElement('br'), lines[1]);
    }

    const vr = this.view.getBoundingClientRect();
    const box = (node, pad = 4) => {
      const r = node.getBoundingClientRect();
      return { x0: r.left - vr.left - pad, y0: r.top - vr.top - pad, x1: r.right - vr.left + pad, y1: r.bottom - vr.top + pad };
    };
    const dims = (node) => ({ w: node.offsetWidth, h: node.offsetHeight });
    const labels = { obj: dims(this.obj.label), horse: dims(this.horse.label) };
    for (const m of this.marks) labels[m.p.id] = dims(m.label);
    const page = layoutPage({
      proj: g.proj,
      width: g.w,
      height: g.h,
      you,
      horse,
      objective: ob,
      sizes: {
        you: arrow.offsetWidth * 0.5,
        horse: this.horse.pt.firstElementChild.offsetWidth * 0.5,
        ring: this.obj.pt.firstElementChild.offsetWidth * 0.43,
        mark: this.marks[0].pt.firstElementChild.offsetWidth * 0.5,
        labels,
      },
      boxes: [box(this.north), box(this.scale)],
      inset: g.inset,
    });

    if (page.you) {
      at(this.you, page.you.x, page.you.y);
      this.you.classList.toggle('pinned', page.you.pinned);
      arrow.style.transform = `rotate(${page.you.deg.toFixed(1)}deg)`;
    }
    if (page.horse) at(this.horse.pt, page.horse.x, page.horse.y);
    if (page.ring) at(this.obj.pt, page.ring.x, page.ring.y);
    const labelFor = (id) => (id === 'obj' ? this.obj.label : id === 'horse' ? this.horse.label : this.marks.find((m) => m.p.id === id).label);
    for (const m of page.marks) at(this.marks.find((k) => k.p.id === m.id).pt, m.x, m.y);
    for (const id in page.labels) {
      const s = page.labels[id], node = labelFor(id);
      at(node, s.x, s.y);
      node.style.visibility = s.hidden ? 'hidden' : ''; // the horse's label, when a crowded corner leaves it no room
    }
  }
}
