import { rng } from './brush.js';

// Sumi-ink transition: ink blooms outward from a point (wet, ragged edges, a few spatters) until the frame is
// covered, then dissolves from the centre outward. Rendered on a half-resolution 2D canvas (soft edges, cheap).

const INK = '#0b0907';

// Band-limited periodic noise on the circle: low lobes for the bloom's outline, high ones for fibre bleed.
function periodicNoise(r) {
  const k = [2, 3, 5, 7, 11, 17, 23, 31, 43].map((f) => ({ f, p: r() * Math.PI * 2, a: (0.5 + r() * 0.5) / Math.pow(f, 0.62) }));
  const norm = k.reduce((s, x) => s + x.a, 0) * 0.55;
  return (a) => k.reduce((s, x) => s + Math.sin(a * x.f + x.p) * x.a, 0) / norm;
}

export class InkTransition {
  constructor(root) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'kz-ink';
    this.canvas.style.display = 'none';
    root.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.covered = false;
  }

  _size() {
    const w = Math.max(2, Math.floor(window.innerWidth / 2));
    const h = Math.max(2, Math.floor(window.innerHeight / 2));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    return [w, h];
  }

  _blob(ctx, x, y, R, noise, spikes = 0.12) {
    ctx.beginPath();
    const n = 160;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rr = R * (1 + noise(a) * spikes);
      const px = x + Math.cos(a) * rr;
      const py = y + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  }

  _run(duration, draw) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - t0) / duration);
        draw(t);
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  // Ink blooms from (x, y) in CSS pixels until the screen is black.
  cover({ x = window.innerWidth * 0.2, y = window.innerHeight * 0.6, duration = 950, seed = 7 } = {}) {
    const [w, h] = this._size();
    const ctx = this.ctx;
    this.canvas.style.display = 'block';
    this.canvas.style.opacity = '1';
    if (this.reduced) {
      ctx.fillStyle = INK;
      return this._run(350, (t) => {
        ctx.clearRect(0, 0, w, h);
        ctx.globalAlpha = t;
        ctx.fillRect(0, 0, w, h);
        ctx.globalAlpha = 1;
      }).then(() => (this.covered = true));
    }
    const r = rng(seed);
    const cx = x / 2;
    const cy = y / 2;
    const maxR = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy)) * 1.25;
    const blobs = [{ x: cx, y: cy, start: 0, scale: 1, noise: periodicNoise(r) }];
    for (let i = 0; i < 6; i++) {
      const a = r() * Math.PI * 2;
      const d = (0.12 + r() * 0.4) * maxR;
      blobs.push({ x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d * 0.7, start: 0.12 + r() * 0.3, scale: 0.35 + r() * 0.4, noise: periodicNoise(r) });
    }
    const spatter = Array.from({ length: 40 }, () => {
      const a = r() * Math.PI * 2;
      return { a, d: 0.1 + r() * 0.9, s: 0.4 + r() * 2.6, t: 0.08 + r() * 0.5 };
    });
    const ease = (t) => t * t * (3 - 2 * t);
    return this._run(duration, (t) => {
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = INK;
      for (const b of blobs) {
        const k = Math.max(0, (t - b.start) / (1 - b.start));
        if (k <= 0) continue;
        const R = ease(k) * maxR * b.scale * (1 + 0.25 * k);
        // wet halo: ink wicking into the paper fibres ahead of the body
        ctx.filter = 'blur(5px)';
        ctx.globalAlpha = 0.42;
        this._blob(ctx, b.x, b.y, R * 1.09, b.noise, 0.2);
        ctx.filter = 'blur(0.8px)';
        ctx.globalAlpha = 1;
        this._blob(ctx, b.x, b.y, R, b.noise);
        ctx.filter = 'none';
      }
      const R0 = ease(t) * maxR;
      for (const s of spatter) {
        if (t < s.t) continue;
        const rr = R0 * (0.9 + s.d * 0.5);
        ctx.beginPath();
        ctx.arc(cx + Math.cos(s.a) * rr, cy + Math.sin(s.a) * rr * 0.85, s.s * (1 + t), 0, Math.PI * 2);
        ctx.fill();
      }
      if (t >= 1) ctx.fillRect(0, 0, w, h);
    }).then(() => (this.covered = true));
  }

  // Ink dissolves outward from the centre, revealing the scene.
  reveal({ duration = 1250, seed = 19 } = {}) {
    const [w, h] = this._size();
    const ctx = this.ctx;
    if (this.reduced) {
      return this._run(400, (t) => {
        ctx.clearRect(0, 0, w, h);
        ctx.globalAlpha = 1 - t;
        ctx.fillStyle = INK;
        ctx.fillRect(0, 0, w, h);
        ctx.globalAlpha = 1;
      }).then(() => this._done());
    }
    const r = rng(seed);
    const holes = Array.from({ length: 7 }, (_, i) => ({
      x: w * (0.5 + (i ? (r() - 0.5) * 0.8 : 0)),
      y: h * (0.5 + (i ? (r() - 0.5) * 0.7 : 0)),
      start: i ? 0.08 + r() * 0.35 : 0,
      scale: i ? 0.4 + r() * 0.5 : 1.25,
      noise: periodicNoise(r),
    }));
    const maxR = Math.hypot(w, h) * 0.62;
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    return this._run(duration, (t) => {
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = INK;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'destination-out';
      for (const b of holes) {
        const k = Math.max(0, (t - b.start) / (1 - b.start));
        if (k <= 0) continue;
        const R = ease(k) * maxR * b.scale;
        ctx.globalAlpha = 0.5;
        this._blob(ctx, b.x, b.y, R * 1.08, b.noise, 0.2);
        ctx.globalAlpha = 1;
        this._blob(ctx, b.x, b.y, R, b.noise);
      }
      ctx.globalCompositeOperation = 'source-over';
      this.canvas.style.opacity = String(1 - Math.max(0, (t - 0.7) / 0.3));
    }).then(() => this._done());
  }

  _done() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.canvas.style.display = 'none';
    this.covered = false;
  }
}
