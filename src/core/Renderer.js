import * as THREE from 'three';

// WebGL2 renderer wrapper: HDR-friendly defaults, reversed-Z when available (huge view distances without
// z-fighting), resize handling and dynamic resolution. The scene itself is rendered by PostFX into an
// HDR multisampled target; the canvas only receives the final tonemapped image.

export class Renderer {
  constructor(container, quality) {
    this.quality = quality;
    const canvas = document.createElement('canvas');
    canvas.id = 'kaze-canvas';
    container.appendChild(canvas);
    this.canvas = canvas;

    const probe = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: true,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    if (!probe) throw new Error('WebGL2 is required');
    const clipControl = !!(probe && probe.getExtension('EXT_clip_control'));

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      context: probe,
      antialias: false,
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      reversedDepthBuffer: clipControl,
      preserveDrawingBuffer: false,
    });
    const r = this.renderer;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NoToneMapping; // tonemapping happens in PostFX final pass
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.shadowMap.autoUpdate = true;
    r.info.autoReset = false;
    this.reversedDepth = clipControl;

    this.pixelRatio = 1;
    this.renderScale = quality.renderScale;
    this.width = 1;
    this.height = 1;
    this.listeners = [];

    this.dyn = { enabled: quality.dynamicResolution, ema: 16.7, t: 0, min: 0.6, target: 1000 / 58 };

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  onResize(fn) {
    this.listeners.push(fn);
  }

  get drawingWidth() {
    return Math.max(1, Math.floor(this.width * this.pixelRatio));
  }
  get drawingHeight() {
    return Math.max(1, Math.floor(this.height * this.pixelRatio));
  }
  // internal HDR render resolution
  get renderWidth() {
    return Math.max(1, Math.floor(this.drawingWidth * this.renderScale));
  }
  get renderHeight() {
    return Math.max(1, Math.floor(this.drawingHeight * this.renderScale));
  }

  resize() {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, this.quality.maxDpr);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(this.width, this.height, true);
    for (const fn of this.listeners) fn(this);
  }

  setQuality(q) {
    this.quality = q;
    this.renderScale = q.renderScale;
    this.dyn.enabled = q.dynamicResolution;
    this.resize();
  }

  // Called once per rendered frame with the real frame time (ms). Adjusts renderScale with hysteresis.
  updateDynamicResolution(frameMs) {
    const d = this.dyn;
    if (!d.enabled) return;
    d.ema += (frameMs - d.ema) * 0.05;
    d.t += frameMs;
    if (d.t < 1200) return;
    d.t = 0;
    const maxScale = this.quality.renderScale;
    let s = this.renderScale;
    if (d.ema > d.target * 1.12 && s > d.min) s = Math.max(d.min, s - 0.08);
    else if (d.ema < d.target * 0.8 && s < maxScale) s = Math.min(maxScale, s + 0.05);
    if (s !== this.renderScale) {
      this.renderScale = s;
      for (const fn of this.listeners) fn(this);
    }
  }
}
