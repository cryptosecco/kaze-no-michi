import * as THREE from 'three';
import { wind } from '../world/Wind.js';
import { POI } from '../world/Layout.js';
import { impulseResponse, gainNode, filter } from './dsp.js';
import * as I from './instruments.js';
import { Music } from './music.js';
import { Ambience } from './ambience.js';

// Audio module: fully procedural WebAudio — no audio files. Starts on the first user gesture.
//   graph: music ─┐                      ┌─ ui ─┐
//          sfx ───┼─ mix → muffle(LPF) ──┴──────┴→ master → limiter → out
//          amb → sfx          (reverbs: one for music, one for sfx, so each follows its own volume)
// game.audio = engine. Listens to game events (see wire()); emits 'audio:muted' {muted}.
// Settings (game.settings / 'settings' event): master, music, sfx (0..1). M toggles mute.

export async function install(game, ctx) {
  const engine = new AudioEngine(game, ctx);
  game.audio = engine;
  return engine;
}

const vol = (v) => Math.pow(Math.max(0, Math.min(1, v ?? 1)), 1.6);

class AudioEngine {
  constructor(game, mctx) {
    this.game = game;
    this.capture = !!mctx.shot;
    this.ctx = null;
    this.muted = false;
    this.mood = 'silent';
    this.combat = false;
    this.standoff = false;
    this._cam = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._dir = new THREE.Vector2();
    this._slow = 0;
    this._lastQuest = null;
    this._envT = 0;
    this.stats = { unlocked: false, errors: 0, events: 0 };

    const unlock = () => this.unlock();
    // capture phase + before anything else can stop propagation; also via the UI's gesture signal
    for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, unlock, { capture: true, passive: true });
    game.on('ui:gesture', unlock);
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) this.ctx.suspend().catch(() => {});
      else this.ctx.resume().catch(() => {});
    });
    this.wire();
    game.addSystem({ frame: (dt) => this.frame(dt) });
  }

  // ------------------------------------------------------------------------------------------ graph
  unlock() {
    if (this.capture) return;
    if (this.ctx) {
      if (this.ctx.state === 'suspended' && !document.hidden) this.ctx.resume().catch(() => {});
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    let ctx;
    try {
      ctx = new AC({ latencyHint: 'interactive' });
    } catch (err) {
      console.error('[kaze] audio unavailable:', err);
      return;
    }
    this.ctx = ctx;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -9;
    limiter.knee.value = 6;
    limiter.ratio.value = 14;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.22;
    this.master = gainNode(ctx, 0);
    this.master.connect(limiter).connect(ctx.destination);
    this.muffle = filter(ctx, 'lowpass', 20000, 0.6);
    this.mix = gainNode(ctx, 1);
    this.mix.connect(this.muffle).connect(this.master);
    this.musicBus = gainNode(ctx, 1);
    this.sfxBus = gainNode(ctx, 1);
    this.ambBus = gainNode(ctx, 1);
    this.uiBus = gainNode(ctx, 0.8);
    this.musicBus.connect(this.mix);
    this.sfxBus.connect(this.mix);
    this.ambBus.connect(this.sfxBus);
    this.uiBus.connect(this.master);
    this.musicRev = ctx.createConvolver();
    this.musicRev.buffer = impulseResponse(ctx);
    this.musicRev.connect(gainNode(ctx, 0.9)).connect(this.musicBus);
    this.sfxRev = ctx.createConvolver();
    this.sfxRev.buffer = this.musicRev.buffer;
    this.sfxRev.connect(gainNode(ctx, 0.8)).connect(this.sfxBus);
    this.music = new Music(ctx, this.musicBus, this.musicRev);
    this.amb = new Ambience(ctx, this.ambBus, this.sfxRev);
    this.applyVolumes(true);
    this.master.gain.setTargetAtTime(this.muted ? 0 : vol(this.setting('master')), ctx.currentTime, 0.8);
    this.stats.unlocked = true;
    this.onState(this.game.state);
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  setting(k) {
    const s = this.game.settings;
    return s && s[k] != null ? s[k] : { master: 0.9, music: 0.7, sfx: 0.85 }[k];
  }

  applyVolumes(instant = false) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const tc = instant ? 0.01 : 0.12;
    this.master.gain.setTargetAtTime(this.muted ? 0 : vol(this.setting('master')), now, tc);
    this.musicBus.gain.setTargetAtTime(vol(this.setting('music')), now, tc);
    this.sfxBus.gain.setTargetAtTime(vol(this.setting('sfx')), now, tc);
  }

  toggleMute() {
    this.muted = !this.muted;
    this.applyVolumes();
    this.game.emit('audio:muted', { muted: this.muted });
  }

  setMood(m) {
    this.mood = m;
    if (this.music) this.music.setMood(m);
  }

  setMuffle(freq, tc = 0.25) {
    if (!this.ctx) return;
    this.muffle.frequency.setTargetAtTime(freq, this.ctx.currentTime, tc);
  }

  // ------------------------------------------------------------------------------------------ events
  wire() {
    const g = this.game;
    const on = (type, fn) =>
      g.on(type, (e) => {
        if (!this.ctx) return;
        this.stats.events++;
        try {
          fn(e.detail || {}, this.ctx.currentTime + 0.005);
        } catch (err) {
          this.stats.errors++;
          console.error(`[kaze] audio handler "${type}" failed:`, err);
        }
      });
    g.on('settings', () => this.applyVolumes());
    g.on('audio:mute-toggle', () => this.toggleMute());
    g.on('state', (e) => this.onState(e.detail && e.detail.state));

    on('ui:sound', ({ kind }, t) => this.uiSound(kind, t));
    on('footstep', ({ surface, speed, actor }, t) => {
      const s = this.spatial(actor);
      if (s) I.footstep(this.ctx, this.sfxBus, t, { surface, speed, gain: 0.42 * s.gain, pan: s.pan });
    });
    on('swing', ({ actor, heavy }, t) => {
      const s = this.spatial(actor);
      if (s) I.swing(this.ctx, this.sfxBus, t, { heavy, gain: 0.5 * s.gain, pan: s.pan });
    });
    on('hit', ({ target, kind }, t) => {
      const s = this.spatial(target) || { gain: 1, pan: 0 };
      const rev = this.sfxRev;
      if (kind === 'parry') I.clash(this.ctx, this.sfxBus, t, { kind: 'parry', gain: 0.55 * s.gain, pan: s.pan, rev });
      else if (kind === 'block') I.clash(this.ctx, this.sfxBus, t, { kind: 'block', gain: 0.5 * s.gain, pan: s.pan, rev });
      else if (kind === 'kill') {
        I.slash(this.ctx, this.sfxBus, t, { kill: true, gain: 0.62 * s.gain, pan: s.pan, rev });
        if (this.standoff) I.taiko(this.ctx, this.sfxBus, t + 0.03, { gain: 0.8, size: 1.35, rev });
      } else I.slash(this.ctx, this.sfxBus, t, { gain: 0.55 * s.gain, pan: s.pan, rev });
    });
    on('guardbreak', ({ actor }, t) => {
      const s = this.spatial(actor) || { gain: 1, pan: 0 };
      I.clash(this.ctx, this.sfxBus, t, { kind: 'guardbreak', gain: 0.55 * s.gain, pan: s.pan, rev: this.sfxRev });
    });
    on('glint', ({ actor }, t) => {
      const s = this.spatial(actor, 140) || { gain: 1, pan: 0 };
      I.glint(this.ctx, this.sfxBus, t, { gain: 0.3 * Math.max(0.55, s.gain), pan: s.pan, rev: this.sfxRev });
    });
    on('perfect-dodge', (d, t) => {
      I.whoosh(this.ctx, this.sfxBus, t, { dur: 0.5, from: 1800, to: 500, gain: 0.35 });
      I.bell(this.ctx, this.sfxBus, t + 0.05, 1760, { gain: 0.08, decay: 1.2, rev: this.sfxRev, ratios: [1, 2, 3.01], amps: [1, 0.3, 0.1] });
      this.slowmo(0.7);
    });
    on('dodge', ({ actor }, t) => {
      const s = this.spatial(actor);
      if (s) I.dodge(this.ctx, this.sfxBus, t, { gain: 0.36 * s.gain, pan: s.pan });
    });
    on('draw', ({ actor }, t) => {
      const s = this.spatial(actor);
      if (s) I.draw(this.ctx, this.sfxBus, t, { gain: 0.34 * s.gain, pan: s.pan, rev: this.sfxRev });
    });
    on('sheathe', ({ actor }, t) => {
      const s = this.spatial(actor);
      if (s) I.sheathe(this.ctx, this.sfxBus, t, { gain: 0.34 * s.gain, pan: s.pan });
    });
    on('heal', (d, t) => I.heal(this.ctx, this.sfxBus, t, { gain: 0.32, rev: this.sfxRev }));
    on('enemy:alert', (d, t) => {
      if (this.combat || this.standoff) return;
      I.taiko(this.ctx, this.sfxBus, t, { gain: 0.55, size: 1.3, rev: this.sfxRev });
      I.shime(this.ctx, this.sfxBus, t + 0.22, { gain: 0.2 });
    });
    on('combat:start', () => {
      this.combat = true;
      if (!this.standoff && this.game.state === 'play') this.setMood('combat');
    });
    on('combat:end', () => {
      this.combat = false;
      if (!this.standoff && this.game.state === 'play') this.setMood('explore');
    });
    on('standoff:start', () => {
      this.standoff = true;
      this.setMood('standoff');
    });
    on('standoff:feint', (d, t) => I.footstep(this.ctx, this.sfxBus, t, { surface: 'dirt', speed: 2, gain: 0.35 }));
    on('standoff:lunge', (d, t) => I.inhale(this.ctx, this.sfxBus, t, { gain: 0.2 }));
    on('standoff:end', () => {
      this.standoff = false;
      if (this.game.state === 'play') this.setMood(this.combat ? 'combat' : 'explore');
    });
    on('killcam', (d, t) => {
      I.boom(this.ctx, this.sfxBus, t, { gain: 0.5, rev: this.sfxRev });
      this.slowmo(1.1);
    });
    on('player:death', () => {
      this.setMood('death');
      this.setMuffle(1400, 0.6);
    });
    const respawn = (d, t) => {
      this.setMuffle(20000, 0.8);
      if (this.game.state === 'play') this.setMood(this.combat ? 'combat' : 'explore');
      I.koto(this.ctx, this.musicBus, t + 0.2, 62, { gain: 0.3, rev: this.musicRev });
    };
    on('respawn', respawn);
    on('player:respawn', respawn);
    on('quest:update', ({ id }, t) => {
      if (!id || id === this._lastQuest) return;
      this._lastQuest = id;
      [62, 69, 74].forEach((m, i) => I.koto(this.ctx, this.musicBus, t + 0.4 + i * 0.16, m, { gain: 0.24, rev: this.musicRev }));
    });
    on('quest:complete', (d, t) => {
      [62, 67, 69, 74, 81].forEach((m, i) => I.koto(this.ctx, this.musicBus, t + i * 0.11, m, { gain: 0.26, rev: this.musicRev }));
      I.bell(this.ctx, this.musicBus, t + 0.6, 1174.7, { gain: 0.06, decay: 2.4, rev: this.musicRev, ratios: [1, 2, 3], amps: [1, 0.3, 0.1] });
    });
    on('guide', (d, t) => I.gust(this.ctx, this.ambBus, t, { gain: 0.42, pan: this.amb ? this.amb.state.windPan : 0 }));
    on('pray:start', (d, t) => {
      I.suzu(this.ctx, this.sfxBus, t + 0.2, { gain: 0.2, rev: this.sfxRev });
      I.clap(this.ctx, this.sfxBus, t + 1.5, { gain: 0.45, rev: this.sfxRev });
      I.clap(this.ctx, this.sfxBus, t + 1.85, { gain: 0.45, rev: this.sfxRev });
    });
    on('blessing', (d, t) => {
      [587.3, 880, 1174.7].forEach((f, i) => I.bell(this.ctx, this.musicBus, t + i * 0.18, f, { gain: 0.07, decay: 2.8, rev: this.musicRev, ratios: [1, 2, 3.01], amps: [1, 0.3, 0.12] }));
    });
    on('ending', () => this.setMood('ending'));
    // the opening cinematic (src/actors/intro.js): a long gust and a low temple bell (D3) as the bars open on the field
    on('intro:open', (d, t) => {
      I.gust(this.ctx, this.ambBus, t, { gain: 0.34 });
      I.bell(this.ctx, this.musicBus, t + 0.35, 146.83, { gain: 0.08, decay: 6, rev: this.musicRev, ratios: [1, 2.01, 2.76, 5.4], amps: [1, 0.35, 0.2, 0.07] });
    });
    // ---- the horse (src/actors/horse/) ----
    on('horse:step', ({ surface, speed, actor }, t) => {
      const s = this.spatial(actor, 70);
      if (s) I.hoof(this.ctx, this.sfxBus, t, { surface, speed, gain: 0.5 * s.gain, pan: s.pan });
    });
    on('horse:breath', ({ actor, k }, t) => {
      const s = this.spatial(actor, 40);
      if (s) I.horseBreath(this.ctx, this.sfxBus, t, { k, gain: 0.22 * s.gain, pan: s.pan });
    });
    on('horse:snort', ({ actor }, t) => {
      const s = this.spatial(actor, 50);
      if (s) I.snort(this.ctx, this.sfxBus, t, { gain: 0.3 * s.gain, pan: s.pan });
    });
    on('horse:neigh', ({ actor }, t) => {
      const s = this.spatial(actor, 180) || { gain: 1, pan: 0 };
      I.neigh(this.ctx, this.sfxBus, t, { gain: 0.26 * Math.max(0.35, s.gain), pan: s.pan, rev: this.sfxRev });
    });
    on('horse:whistle', (d, t) => I.whistle(this.ctx, this.sfxBus, t, { gain: 0.2, rev: this.sfxRev }));
    on('horse:throw', ({ actor }, t) => {
      const s = this.spatial(actor) || { gain: 1, pan: 0 };
      I.dodge(this.ctx, this.sfxBus, t, { gain: 0.4 * s.gain, pan: s.pan });
    });
    // ---- the birds (src/world/wildlife/): a flock bursting up, a crow calling ----
    on('wildlife:flush', ({ x, y, z, species, count }, t) => {
      const crow = species === 'crow';
      const s = this.spatial({ position: { x, y, z } }, crow ? 90 : 45);
      if (!s) return;
      if (crow) {
        // heavy strokes, and the alarm "kaa kaa"
        I.wingFlutter(this.ctx, this.sfxBus, t, { birds: Math.min(3, count || 1), rate: 4.4, dur: 0.9, freq: 650, gain: 0.34 * s.gain, pan: s.pan });
        I.caw(this.ctx, this.sfxBus, t + 0.12, { n: 2 + Math.floor(Math.random() * 2), gain: 0.2 * s.gain, pan: s.pan, rev: this.sfxRev });
      } else I.wingFlutter(this.ctx, this.sfxBus, t, { birds: count || 8, rate: 14, dur: 0.6, freq: 2600, gain: 0.26 * s.gain, pan: s.pan });
    });
    on('wildlife:caw', ({ x, y, z }, t) => {
      const s = this.spatial({ position: { x, y, z } }, 140);
      if (s) I.caw(this.ctx, this.sfxBus, t, { n: 2 + (Math.random() < 0.4 ? 1 : 0), gain: 0.16 * Math.max(0.3, s.gain), pan: s.pan, rev: this.sfxRev });
    });
    // ---- the mammals: a sika's alarm whistle (it carries far), a fox's bark, a deer stamping ----
    on('wildlife:alarm', ({ x, y, z, species }, t) => {
      const deer = species === 'deer';
      const s = this.spatial({ position: { x, y, z } }, deer ? 170 : 90);
      if (!s) return;
      if (deer) I.sikaWhistle(this.ctx, this.sfxBus, t, { n: Math.random() < 0.35 ? 2 : 1, gain: 0.26 * Math.max(0.35, s.gain), pan: s.pan, rev: this.sfxRev });
      else I.foxBark(this.ctx, this.sfxBus, t, { n: 1 + Math.floor(Math.random() * 3), gain: 0.2 * s.gain, pan: s.pan, rev: this.sfxRev });
    });
    on('wildlife:stamp', ({ x, y, z }, t) => {
      const s = this.spatial({ position: { x, y, z } }, 35);
      if (s) I.stamp(this.ctx, this.sfxBus, t, { gain: 0.3 * s.gain, pan: s.pan });
    });
  }

  onState(state) {
    if (!this.ctx) return;
    if (state === 'title') {
      this.combat = this.standoff = false;
      this.setMood('title');
      this.setMuffle(20000, 0.4);
    } else if (state === 'play') {
      if (this.mood === 'title' || this.mood === 'silent' || this.mood === 'ending') this.setMood(this.combat ? 'combat' : 'explore');
      this.setMuffle(20000, 0.3);
    } else if (state === 'paused') {
      this.setMuffle(650, 0.15);
    }
  }

  // brief slow-motion colour: dull the world, then let it back in
  slowmo(sec) {
    const now = this.ctx.currentTime;
    const f = this.muffle.frequency;
    f.cancelScheduledValues(now);
    f.setTargetAtTime(900, now, 0.05);
    f.setTargetAtTime(this.game.state === 'paused' ? 650 : 20000, now + sec, 0.35);
  }

  uiSound(kind, t) {
    const c = this.ctx;
    const b = this.uiBus;
    if (kind === 'move') I.uiClick(c, b, t, { gain: 0.1 });
    else if (kind === 'tick') I.uiClick(c, b, t, { gain: 0.07, freq: 3000 });
    else if (kind === 'select') I.koto(c, b, t, 81, { gain: 0.2, rev: this.musicRev, revAmt: 0.25 });
    else if (kind === 'back') I.koto(c, b, t, 74, { gain: 0.16, rev: this.musicRev, revAmt: 0.25 });
    else if (kind === 'open') {
      I.whoosh(c, b, t, { dur: 0.35, from: 500, to: 1500, gain: 0.12 });
      I.koto(c, b, t + 0.05, 69, { gain: 0.14, rev: this.musicRev, revAmt: 0.3 });
    } else if (kind === 'close') I.whoosh(c, b, t, { dur: 0.3, from: 1500, to: 500, gain: 0.1 });
    else if (kind === 'start') {
      I.taiko(c, b, t, { gain: 0.6, size: 1.3, rev: this.musicRev });
      [62, 69, 74, 81].forEach((m, i) => I.koto(c, b, t + 0.1 + i * 0.07, m, { gain: 0.18, rev: this.musicRev }));
    } else if (kind === 'shutter') I.shutter(c, b, t, { gain: 0.35 });
  }

  // gain/pan for a sound at an actor's position (null if too far to hear)
  spatial(actor, maxDist = 90) {
    const cam = this.game.camera;
    if (!actor || !actor.position || !cam) return { gain: 1, pan: 0 };
    const p = actor.position;
    const dx = p.x - cam.position.x;
    const dy = p.y - cam.position.y;
    const dz = p.z - cam.position.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > maxDist) return null;
    this._right.set(1, 0, 0).applyQuaternion(cam.quaternion);
    const pan = d > 0.5 ? Math.max(-1, Math.min(1, (dx * this._right.x + dz * this._right.z) / d)) * 0.75 : 0;
    const gain = 1 / Math.pow(1 + Math.max(0, d - 4) / 10, 1.25);
    return { gain, pan };
  }

  // ------------------------------------------------------------------------------------------ per frame
  frame(dt) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const g = this.game;
    this.music.update(now, 0.35);
    // world sampling for the ambience beds (~6 Hz is plenty; parameters are smoothed)
    this._envT -= dt || 0.016;
    if (this._envT <= 0) {
      this._envT = 0.16;
      const cam = g.camera.position;
      const W = wind.intensity(cam.x, cam.z);
      const G = wind.uniforms.uGuide.value;
      wind.dir(this._dir);
      this._right.set(1, 0, 0).applyQuaternion(g.camera.quaternion);
      const windPan = Math.max(-1, Math.min(1, this._dir.x * this._right.x + this._dir.y * this._right.z)) * 0.35;
      let grass = 0.6;
      let sea = 0;
      if (g.terrain) {
        const s = g.terrain.surfaceAt(cam.x, cam.z);
        grass = Math.min(1, (s.grass || 0) + (s.pampas || 0) * 0.8);
        let n = 0;
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          if (g.terrain.heightAt(cam.x + Math.cos(a) * 90, cam.z + Math.sin(a) * 90) < 0.4) n++;
        }
        sea = n / 8;
      }
      const fx = POI.camp.fire.x - cam.x;
      const fz = POI.camp.fire.z - cam.z;
      const fd = Math.hypot(fx, fz);
      const fire = Math.max(0, 1 - fd / 45);
      const firePan = fd > 0.5 ? Math.max(-1, Math.min(1, (fx * this._right.x + fz * this._right.z) / fd)) * 0.7 : 0;
      this.amb.set({ wind: W, guide: G, grass, sea, fire, firePan, windPan, hour: g.timeOfDay, standoff: this.standoff, active: g.state !== 'shot' }, now);
    }
    this.amb.update(now, 0.4);
  }
}
