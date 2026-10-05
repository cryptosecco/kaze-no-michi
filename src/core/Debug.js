import * as THREE from 'three';
import { SHOTS } from './shots.js';
import { wind } from '../world/Wind.js';

// window.kaze — debug + automation API (used by scripts/shots.mjs).
//   kaze.game, kaze.ready, kaze.setShot(id), kaze.setTime(h), kaze.stats(), kaze.waitFrames(n), kaze.measureFps(ms)

export function installDebug(game, params) {
  const api = {
    game,
    ready: false,
    shot: null,
    setShot(id) {
      const s = SHOTS[id];
      if (!s) throw new Error('unknown shot ' + id);
      api.shot = id;
      if (Math.abs(game.timeOfDay - s.hours) > 1e-4) game.setTimeOfDay(s.hours);
      const { pos, target } = s.pose(game.terrain);
      const cam = game.camera;
      cam.fov = s.fov;
      cam.updateProjectionMatrix();
      cam.position.set(pos[0], pos[1], pos[2]);
      cam.lookAt(new THREE.Vector3(target[0], target[1], target[2]));
      if (game.freeCam) {
        game.freeCam.syncFromCamera();
        game.freeCam.enabled = false;
      }
      wind.setTime(s.t0 || 0); // re-anchors the integrated wind state too: a capture must not depend on what ran before
      Object.assign(game.post.params, game.post.defaults);
      if (s.post) Object.assign(game.post.params, s.post);
      game.sky.applyShot(s.sky); // overrides, or the defaults (cloud field position included)
      game._runShotHooks(id, s); // modules stage actors/props/UI for this shot
      return api;
    },
    setTime(h) {
      game.setTimeOfDay(h);
      return api;
    },
    stats() {
      return game.stats();
    },
    waitFrames(n = 1) {
      return game.loop.waitFrames(n);
    },
    measureFps(ms = 3000) {
      return new Promise((resolve) => {
        const samples = [];
        let last = performance.now();
        const start = last;
        const tick = (now) => {
          samples.push(now - last);
          last = now;
          if (now - start < ms) requestAnimationFrame(tick);
          else {
            samples.shift();
            const sorted = [...samples].sort((a, b) => a - b);
            const avg = samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length);
            resolve({
              fps: 1000 / avg,
              avgMs: avg,
              p50: sorted[Math.floor(sorted.length * 0.5)] || 0,
              p95: sorted[Math.floor(sorted.length * 0.95)] || 0,
              frames: samples.length,
            });
          }
        };
        requestAnimationFrame(tick);
      });
    },
  };
  window.kaze = api;
  if (params && params.has('debug')) {
    const el = document.createElement('div');
    el.id = 'kaze-debug';
    el.style.cssText =
      'position:fixed;left:8px;top:8px;font:12px/1.4 ui-monospace,monospace;color:#fff;background:rgba(0,0,0,.45);padding:6px 8px;border-radius:4px;z-index:50;pointer-events:none;white-space:pre';
    document.body.appendChild(el);
    let acc = 0, n = 0;
    game.addSystem({
      frame(dt) {
        acc += game.loop.lastFrameMs;
        n++;
        if (n >= 30) {
          const s = game.stats();
          const p = game.camera.position;
          el.textContent = `${(1000 / (acc / n)).toFixed(0)} fps  ${(acc / n).toFixed(1)} ms  scale ${s.renderScale.toFixed(2)}\n` +
            `calls ${s.calls}  tris ${(s.triangles / 1e6).toFixed(2)}M\npos ${p.x.toFixed(0)} ${p.y.toFixed(1)} ${p.z.toFixed(0)}  t ${game.timeOfDay.toFixed(2)}h`;
          acc = n = 0;
        }
      },
    });
  }
  return api;
}
