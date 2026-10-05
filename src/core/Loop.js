// Fixed-step simulation + per-frame rendering.
//   update(dt, t)          at a fixed 60 Hz (gameplay, physics, AI)
//   frame(dt, t, alpha)    once per displayed frame (camera smoothing, visuals, render)
// timeScale enables slow motion (kill-cams); deterministic mode advances exactly one step per frame
// so automated screenshots are reproducible.

export class Loop {
  constructor({ update, frame, fixedDt = 1 / 60, maxSteps = 6, deterministic = false }) {
    this.update = update;
    this.frame = frame;
    this.fixedDt = fixedDt;
    this.maxSteps = maxSteps;
    this.deterministic = deterministic;
    this.timeScale = 1;
    this.paused = false;
    this.time = 0; // simulated seconds
    this.frameCount = 0;
    this.acc = 0;
    this.last = 0;
    this.running = false;
    this.lastFrameMs = 16.7;
    this._frameWaiters = [];
    this._tick = this._tick.bind(this);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this._tick);
  }

  stop() {
    this.running = false;
  }

  // Resolves after n more frames have been rendered.
  waitFrames(n) {
    return new Promise((resolve) => this._frameWaiters.push({ n: this.frameCount + n, resolve }));
  }

  _tick(now) {
    if (!this.running) return;
    requestAnimationFrame(this._tick);
    const realMs = Math.min(250, Math.max(0, now - this.last));
    this.last = now;
    this.lastFrameMs = realMs;

    let frameDt;
    if (this.deterministic) {
      frameDt = this.paused ? 0 : this.fixedDt * this.timeScale;
      if (!this.paused) {
        this.time += frameDt;
        this.update(frameDt, this.time);
      }
    } else {
      frameDt = this.paused ? 0 : Math.min(0.1, realMs / 1000) * this.timeScale;
      this.acc += frameDt;
      let steps = 0;
      const step = this.fixedDt * Math.min(1, this.timeScale || 1);
      while (this.acc >= step && steps < this.maxSteps) {
        this.time += step;
        this.update(step, this.time);
        this.acc -= step;
        steps++;
      }
      if (steps === this.maxSteps) this.acc = 0;
    }

    const alpha = this.deterministic ? 1 : this.acc / this.fixedDt;
    this.frame(frameDt, this.time, alpha, realMs);
    this.frameCount++;

    if (this._frameWaiters.length) {
      const still = [];
      for (const w of this._frameWaiters) {
        if (this.frameCount >= w.n) w.resolve();
        else still.push(w);
      }
      this._frameWaiters = still;
    }
  }
}
