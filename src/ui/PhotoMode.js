import * as THREE from 'three';
import { t } from './i18n.js';
import { OptionList } from './menu.js';

// Photo mode (O in play, or from the pause menu). The simulation stays frozen; a free camera roams within
// RADIUS metres of where the photo began. Time of day re-bakes terrain lighting, so it is debounced.
// Everything touched (camera, fov, post params, time of day, camera controller) is restored on exit.

const RADIUS = 30;
const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight']);

const FILTERS = {
  none: null,
  bw: { bw: 1 },
  warm: {
    saturation: 1.22,
    splitStrength: 0.38,
    highlightTint: [0.67, 0.52, 0.37],
    shadowTint: [0.5, 0.45, 0.5],
  },
  cool: {
    saturation: 0.82,
    splitStrength: 0.32,
    highlightTint: [0.5, 0.53, 0.57],
    shadowTint: [0.4, 0.5, 0.62],
  },
};

export class PhotoMode {
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
    this.active = false;
    this.keys = new Set();
    const el = (this.el = document.createElement('div'));
    el.className = 'kz-layer kz-photo';
    el.innerHTML = `
      <div class="kz-drag"></div>
      <div class="kz-photo-panel kz-interactive">
        <div class="kz-photo-title" lang="ja">写真</div>
        <div class="kz-photo-sub"></div>
        <div class="kz-photo-opts"></div>
        <div class="kz-photo-keys"></div>
      </div>
      <div class="kz-flash"></div>`;
    this.drag = el.querySelector('.kz-drag');
    this.flash = el.querySelector('.kz-flash');
    this.state = { time: 17.7, exposure: 1, fov: 50, filter: 'none', letterbox: false, grain: 0.03 };
    this.cam = { yaw: 0, pitch: 0, origin: new THREE.Vector3(), last: 0 };
    this._v = new THREE.Vector3();
    this._bindPointer();
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    this.ctl = { frame: () => this.frameCamera() };
    this.handler = {
      ownsSticks: true,
      onAnyKey: (e) => this.onKey(e),
      nav: (a) => this.options && this.options.nav(a),
    };
  }

  build() {
    const s = this.state;
    const hhmm = (h) => {
      const H = Math.floor(h);
      const M = Math.round((h - H) * 60);
      return `${String(H).padStart(2, '0')}:${String(M === 60 ? 0 : M).padStart(2, '0')}`;
    };
    this.options = new OptionList({
      sound: this.ui.sound,
      onBack: () => this.close(),
      rows: [
        { type: 'slider', key: 'timeOfDay', min: 5.5, max: 20, step: 0.1, get: () => s.time, set: (v) => this.setTime(v), format: hhmm },
        {
          type: 'slider',
          key: 'exposure',
          min: 0.4,
          max: 1.8,
          step: 0.02,
          get: () => s.exposure,
          set: (v) => {
            s.exposure = v;
            this.game.post.params.exposure = v;
          },
          format: (v) => v.toFixed(2),
        },
        {
          type: 'slider',
          key: 'fov',
          min: 20,
          max: 90,
          step: 1,
          get: () => s.fov,
          set: (v) => {
            s.fov = v;
            this.game.camera.fov = v;
            this.game.camera.updateProjectionMatrix();
          },
          format: (v) => `${Math.round(v)}°`,
        },
        {
          type: 'choice',
          key: 'filter',
          options: ['none', 'bw', 'warm', 'cool'].map((f) => ({ value: f, labelKey: 'f_' + f })),
          get: () => s.filter,
          set: (v) => this.setFilter(v),
        },
        {
          type: 'toggle',
          key: 'letterbox',
          get: () => s.letterbox,
          set: (v) => {
            s.letterbox = v;
            this.game.post.params.letterbox = v ? 1 : 0;
          },
        },
        {
          type: 'slider',
          key: 'grain',
          min: 0,
          max: 0.12,
          step: 0.004,
          get: () => s.grain,
          set: (v) => {
            s.grain = v;
            this.game.post.params.grain = v;
          },
          format: (v) => `${Math.round((v / 0.12) * 100)}%`,
        },
        { type: 'action', key: 'hideUi', run: () => this.toggleUi(), hint: () => 'H' },
        { type: 'action', key: 'capture', run: () => this.capture(), hint: () => '␣' },
        { type: 'action', key: 'exit', run: () => this.close(), hint: () => 'Esc' },
      ],
    });
    const box = this.el.querySelector('.kz-photo-opts');
    box.innerHTML = '';
    box.appendChild(this.options.el);
    this.el.querySelector('.kz-photo-sub').textContent = t('photoTitle');
    this.el.querySelector('.kz-photo-keys').innerHTML =
      `<span><b>WASD · QE</b>${t('photoMove')}</span><span><b>⟲</b>${t('photoLook')}</span><span><b>⇕</b>${t('fov')}</span>`;
  }

  _bindPointer() {
    let drag = null;
    this.drag.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
      this.drag.setPointerCapture(e.pointerId);
    });
    this.drag.addEventListener('pointermove', (e) => {
      if (!drag || !this.active) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      const sens = 0.0032 * (this.ui.settings.get('sensitivity') || 1);
      this.cam.yaw -= dx * sens;
      this.cam.pitch = THREE.MathUtils.clamp(this.cam.pitch - dy * sens * (this.ui.settings.get('invertY') ? -1 : 1), -1.45, 1.45);
    });
    const end = () => (drag = null);
    this.drag.addEventListener('pointerup', end);
    this.drag.addEventListener('pointercancel', end);
    this.drag.addEventListener(
      'wheel',
      (e) => {
        if (!this.active) return;
        e.preventDefault();
        const s = this.state;
        s.fov = THREE.MathUtils.clamp(s.fov + Math.sign(e.deltaY) * 2, 20, 90);
        this.game.camera.fov = s.fov;
        this.game.camera.updateProjectionMatrix();
        this.options && this.options.refresh();
      },
      { passive: false }
    );
  }

  open({ from = 'play' } = {}) {
    if (this.active) return;
    const g = this.game;
    this.from = from;
    if (from === 'play') {
      if (g.state !== 'play') return;
      g.loop.paused = true;
      g.setState('paused');
      g.input.exitPointerLock();
    }
    this.active = true;
    const p = g.post.params;
    this.saved = {
      post: {
        exposure: p.exposure,
        bw: p.bw,
        letterbox: p.letterbox,
        grain: p.grain,
        saturation: p.saturation,
        splitStrength: p.splitStrength,
        highlightTint: p.highlightTint.clone(),
        shadowTint: p.shadowTint.clone(),
      },
      time: g.timeOfDay,
      fov: g.camera.fov,
      pos: g.camera.position.clone(),
      quat: g.camera.quaternion.clone(),
      ctl: g.cameraController,
      free: g.freeCam ? g.freeCam.enabled : false,
    };
    Object.assign(this.state, {
      time: g.timeOfDay,
      exposure: p.exposure,
      fov: g.camera.fov,
      filter: p.bw > 0.5 ? 'bw' : 'none',
      letterbox: p.letterbox > 0.5,
      grain: p.grain,
    });
    const e = new THREE.Euler().setFromQuaternion(g.camera.quaternion, 'YXZ');
    this.cam.yaw = e.y;
    this.cam.pitch = e.x;
    this.cam.origin.copy(g.camera.position);
    this.cam.last = performance.now();
    if (g.freeCam) g.freeCam.enabled = false;
    g.cameraController = this.ctl;
    this.build();
    this.el.classList.remove('hide-ui');
    this.el.classList.add('show', 'kz-interactive');
    this.ui.hud.hide();
    this.ui.nav.push(this.handler);
    this.ui.sound('open');
  }

  close() {
    if (!this.active) return;
    const g = this.game;
    this.active = false;
    this.keys.clear();
    clearTimeout(this._timeTimer);
    const sv = this.saved;
    Object.assign(g.post.params, {
      exposure: sv.post.exposure,
      bw: sv.post.bw,
      letterbox: sv.post.letterbox,
      grain: sv.post.grain,
      saturation: sv.post.saturation,
      splitStrength: sv.post.splitStrength,
    });
    g.post.params.highlightTint.copy(sv.post.highlightTint);
    g.post.params.shadowTint.copy(sv.post.shadowTint);
    if (Math.abs(g.timeOfDay - sv.time) > 1e-3) g.setTimeOfDay(sv.time);
    g.camera.position.copy(sv.pos);
    g.camera.quaternion.copy(sv.quat);
    g.camera.fov = sv.fov;
    g.camera.updateProjectionMatrix();
    if (g.cameraController === this.ctl) g.cameraController = sv.ctl;
    if (g.freeCam) g.freeCam.enabled = sv.free;
    this.ui.nav.pop(this.handler);
    this.el.classList.remove('show', 'kz-interactive');
    this.ui.sound('close');
    if (this.from === 'pause') this.ui.pause.reopen();
    else {
      g.loop.paused = false;
      g.setState('play');
      g.input.requestPointerLock();
    }
  }

  onKey(e) {
    if (MOVE_KEYS.has(e.code)) {
      this.keys.add(e.code);
      return true;
    }
    if (e.code === 'KeyH') {
      this.toggleUi();
      return true;
    }
    if (e.code === 'Space' || e.code === 'F12') {
      this.capture();
      return true;
    }
    if (e.code === 'KeyO') {
      this.close();
      return true;
    }
    return false;
  }

  toggleUi() {
    this.el.classList.toggle('hide-ui');
  }

  setTime(v) {
    this.state.time = v;
    clearTimeout(this._timeTimer);
    this._timeTimer = setTimeout(() => this.game.setTimeOfDay(v), 300);
  }

  setFilter(name) {
    const p = this.game.post.params;
    const sv = this.saved.post;
    this.state.filter = name;
    p.bw = sv.bw > 0.5 && name === 'none' ? sv.bw : 0;
    p.saturation = sv.saturation;
    p.splitStrength = sv.splitStrength;
    p.highlightTint.copy(sv.highlightTint);
    p.shadowTint.copy(sv.shadowTint);
    const f = FILTERS[name];
    if (!f) return;
    if (f.bw) p.bw = f.bw;
    if (f.saturation) p.saturation = f.saturation;
    if (f.splitStrength) p.splitStrength = f.splitStrength;
    if (f.highlightTint) p.highlightTint.set(...f.highlightTint);
    if (f.shadowTint) p.shadowTint.set(...f.shadowTint);
  }

  frameCamera() {
    if (!this.active) return;
    const g = this.game;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.cam.last) / 1000);
    this.cam.last = now;
    const inp = g.input;
    // right stick looks, left stick moves (the menu uses the d-pad while photo mode is open)
    if (inp.pad.connected) {
      this.cam.yaw -= inp.pad.rx * 1.8 * dt;
      this.cam.pitch = THREE.MathUtils.clamp(this.cam.pitch - inp.pad.ry * 1.8 * dt, -1.45, 1.45);
    }
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.cam.pitch, this.cam.yaw, 0, 'YXZ'));
    g.camera.quaternion.copy(q);
    const k = this.keys;
    const f = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0) - (inp.pad.connected ? inp.pad.ly : 0);
    const r = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0) + (inp.pad.connected ? inp.pad.lx : 0);
    const u = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
    if (f || r || u) {
      const sp = (k.has('ShiftLeft') || k.has('ShiftRight') ? 9 : 3.2) * dt;
      const fwd = this._v.set(0, 0, -1).applyQuaternion(q);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
      g.camera.position.addScaledVector(fwd, f * sp).addScaledVector(right, r * sp);
      g.camera.position.y += u * sp;
      const o = this.cam.origin;
      const d = this._v.copy(g.camera.position).sub(o);
      if (d.length() > RADIUS) g.camera.position.copy(o).addScaledVector(d.normalize(), RADIUS);
      if (g.terrain) {
        const ground = (g.groundAt ? g.groundAt(g.camera.position.x, g.camera.position.z) : g.terrain.heightAt(g.camera.position.x, g.camera.position.z)) + 0.35;
        if (g.camera.position.y < ground) g.camera.position.y = ground;
      }
    }
  }

  capture() {
    const g = this.game;
    try {
      g.post.render(g.scene, g.camera, g.wind.time); // the wind clock seeds the grain (Game.frame)
      const url = g.renderer.canvas.toDataURL('image/png');
      const a = document.createElement('a');
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
      a.href = url;
      a.download = `kaze-no-michi-${stamp}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      this.flash.classList.remove('go');
      void this.flash.offsetWidth;
      this.flash.classList.add('go');
      this.ui.sound('shutter');
      this.ui.cards.toast(t('photoSaved'));
    } catch (err) {
      console.error('[kaze] photo capture failed:', err);
    }
  }
}
