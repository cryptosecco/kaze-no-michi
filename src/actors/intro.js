import * as THREE from 'three';
import { POI } from '../world/Layout.js';
import { filmBars } from '../render/PostFX.js';
import { t as tr } from '../ui/i18n.js';

// Opening cinematic, rendered by the engine: the first time a session goes from the title into play the frame is black,
// the bars open slowly onto a wide golden-hour view of the field and settle on the film letterbox (2.39:1), and the
// camera glides and cranes down toward the samurai, coming in on his left, while the wind turns toward the shrine. His
// horse grazes a few metres off, ahead of him and to his right (HORSE_SPAWN, actors/horse/index.js), and stands still
// until the hand-over: the camera never passes it, and it is beside him in the last frames. The shot lands on the
// third-person camera's own live pose behind him (CameraRig.basePos): the hand-over has no cut.
// The film letterbox is what play shows too (the player's setting 'letterbox', on by default; post.defaults.letterbox
// is its base): with it on the bars simply stay, with it off they withdraw before the hand-over. Control, the HUD
// vitals and the first quest begin then (onDone).
//   new Intro(game, { player, pc, camRig, prompts, onDone })
//   intro.start({ waitReveal })   take the camera (a CameraRig override) and lock control; with waitReveal the clock
//                                 starts on 'ui:revealed' (the title's ink has dissolved over the black frame)
//   intro.update(dt)              game seconds, every rendered frame before the camera (pause and photo mode freeze it)
// Holding E, Space or Enter (pad A or B) for SKIP_HOLD seconds skips it: a dip to black, up again on the final framing.
// Emits 'intro:start', 'intro:open' (the bars begin to open), 'intro:end' { skipped }, and 'guide' with the gust.

export const INTRO = {
  duration: 13.5, // s from the clock's start to the hand-over
  open: [0.6, 5.6], // the bars open slowly from black (0.5 of the frame each) to the film letterbox, easing in and out
  retract: [9.4, 12.4], // film letterbox → the play letterbox: no move with it on, a withdrawal to nothing with it off
  converge: [11.6, 13.5], // the path settles onto the camera rig's live pose
  gust: 6.2, // the guiding wind turns toward the shrine, once the bars have settled
  v0: 0.7, // the camera already glides when the bars open: start speed of the time warp (1 = the mean speed)
};
export const SKIP_HOLD = 0.7; // s
const SKIP_FADE = [0.3, 0.45]; // s: down to black, then up on the final framing

// Camera keys in the samurai's frame (he faces the shrine and the low sun): metres behind him and to his left, height
// above the ground under the key, the point looked at — metres ahead of him and above his feet — and the lens (degrees).
// The rig's own pose behind his shoulder is the last key. High over the field onto the shrine hill, down over the
// susuki on his left, then across his back to the shoulder. His horse grazes on his right (2.5 m ahead of him, 3.2 m to
// the side: HORSE_SPAWN), so the keys never pass it, and it stands beside him in the frame of the last one.
export const KEYS = [
  { back: 95, left: 35, h: 28, ahead: 260, lookH: 18, fov: 38 },
  { back: 56, left: 22, h: 15, ahead: 170, lookH: 9, fov: 40 },
  { back: 16, left: 11, h: 5.2, ahead: 16, lookH: 1.0, fov: 42 },
  { back: 6.5, left: 2.5, h: 2.2, ahead: 8, lookH: 1.5, fov: 49 },
];
// depth of field on the samurai while the camera comes down to him (the plumes by the lens go soft): in, held, out
// before the hand-over (no depth of field in play)
const DOF = { in: [8.4, 10.2], out: [11.6, 13.0], aperture: 0.45, maxBlur: 7 };

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (x) => {
  x = clamp01(x);
  return x * x * (3 - 2 * x);
};
const smoother = (x) => {
  x = clamp01(x);
  return x * x * x * (x * (x * 6 - 15) + 10); // no speed and no acceleration at either end
};

// bar height (a fraction of the frame, per bar) at intro time t. `film` is the height of the film letterbox on this
// frame (filmBars of its aspect) and `play` the height play shows once the cinematic is over: the base letterbox ×
// film, so `film` with the letterbox on and 0 with it off. From black the bars open to `film` with a gentle ease at
// both ends (no visible start, no visible stop), hold there while the shot plays, then settle on `play` — which, with
// the letterbox on, is no move at all. `I` is the timeline (INTRO, unless a test brings its own).
export function introBars(t, film, play, I = INTRO) {
  const [o0, o1] = I.open, [r0, r1] = I.retract;
  if (t < o0) return 0.5;
  if (t < o1) return 0.5 + (film - 0.5) * smoother((t - o0) / (o1 - o0));
  if (t < r0) return film;
  if (t < r1) return film + (play - film) * smooth((t - r0) / (r1 - r0));
  return play;
}

// progress along the path (0..1) at intro time t: a cubic that starts at v0 × the mean speed and comes to rest at the end
export function introProgress(t, I = INTRO) {
  const x = clamp01(t / I.duration), v = I.v0;
  return v * (x * x * x - 2 * x * x + x) + (3 * x * x - 2 * x * x * x);
}

export class Intro {
  constructor(game, { player, pc, camRig, prompts, onDone }) {
    this.game = game;
    this.player = player;
    this.pc = pc;
    this.cam = camRig;
    this.prompts = prompts;
    this.onDone = onDone;
    this.active = false;
    this.running = false;
    this.t = 0;
    this.path = null;
    this.pos = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.fov = 50;
    this.evalT = -1;
    this.override = { pos: () => this._eval().pos, target: () => this.target, fov: () => this.fov };
    game.on('ui:revealed', () => {
      if (this.active) this.running = true;
    });
  }

  start({ waitReveal = false } = {}) {
    const g = this.game, cam = this.cam;
    this.active = true;
    this.running = !waitReveal;
    this.t = 0;
    this.path = null; // built on the first frame, once the rig knows its own pose
    this.evalT = -1;
    this.hold = 0;
    this.hinted = false;
    this.skip = null;
    this.opened = false;
    this.gusted = false;
    this.pc.controlLock = Infinity;
    this.pc.vel.set(0, 0, 0);
    cam.snapBehind(this.player);
    cam.lookLocked = true;
    cam.setOverride(this.override, 0.01);
    cam.overrideW = 1;
    g.post.params.bars = 0.5;
    g.emit('intro:start', {});
  }

  update(dt) {
    if (!this.active) return;
    const g = this.game;
    if (this.running && g.state === 'play') this.t += dt;
    if (this.skip) return this._skipping(dt);
    const p = g.post.params, r = g.renderer;
    // the film letterbox of the frame as it is now (the window can be resized): the ratio the final shader uses
    const film = filmBars(r.drawingWidth / r.drawingHeight);
    p.bars = introBars(this.t, film, g.post.defaults.letterbox * film);
    const dk = smooth((this.t - DOF.in[0]) / (DOF.in[1] - DOF.in[0])) * (1 - smooth((this.t - DOF.out[0]) / (DOF.out[1] - DOF.out[0])));
    p.dofAperture = DOF.aperture * dk;
    p.dofMaxBlur = DOF.maxBlur;
    p.dofFocus = Math.max(1, g.camera.position.distanceTo(this.player.position) - 0.2);
    if (!this.opened && this.t >= INTRO.open[0]) {
      this.opened = true;
      g.emit('intro:open', {});
    }
    if (!this.gusted && this.t >= INTRO.gust) {
      this.gusted = true;
      const s = POI.shrine;
      g.wind.guideTo(s.x, s.z, 7);
      g.emit('guide', { x: s.x, z: s.z });
    }
    this._skipInput(dt);
    if (this.t >= INTRO.duration) this._finish(false);
  }

  // ---- the path -------------------------------------------------------------------------------------------
  // World-space keys from the samurai's pose, closed by the rig's own pose (valid once the rig has run this frame).
  _build() {
    const g = this.game, a = this.player, cam = this.cam, P = a.position;
    const fx = Math.sin(a.yaw), fz = Math.cos(a.yaw);
    const lx = fz, lz = -fx; // his left
    const pts = [], looks = [], fovs = [];
    for (const k of KEYS) {
      const x = P.x - fx * k.back + lx * k.left, z = P.z - fz * k.back + lz * k.left;
      pts.push(new THREE.Vector3(x, g.groundAt(x, z) + k.h, z));
      looks.push(new THREE.Vector3(P.x + fx * k.ahead, P.y + k.lookH, P.z + fz * k.ahead));
      fovs.push(k.fov);
    }
    pts.push(cam.basePos.clone());
    looks.push(cam.baseTarget.clone());
    fovs.push(cam.baseFov);
    this.path = {
      pos: new THREE.CatmullRomCurve3(pts, false, 'centripetal'),
      look: new THREE.CatmullRomCurve3(looks, false, 'centripetal'),
      fovs,
    };
  }

  // camera pose at the current time (cached per frame: pos() is read first, then target and fov)
  _eval() {
    if (!this.path) this._build();
    if (this.evalT === this.t && !this.skip) return this;
    this.evalT = this.t;
    const cam = this.cam, g = this.game;
    if (this.skip && this.skip.jumped) {
      // after the dip to black: the final framing, the rig's own pose
      this.pos.copy(cam.basePos);
      this.target.copy(cam.baseTarget);
      this.fov = cam.baseFov;
      return this;
    }
    const { pos, look, fovs } = this.path;
    const u = introProgress(this.t);
    const tp = pos.getUtoTmapping(u); // the keys sit at equal steps of tp on both curves
    pos.getPoint(tp, this.pos);
    look.getPoint(tp, this.target);
    const seg = tp * (fovs.length - 1), i = Math.min(fovs.length - 2, Math.floor(seg));
    this.fov = fovs[i] + (fovs[i + 1] - fovs[i]) * smooth(seg - i);
    // never under the ground (the keys clear it; the curve between them could dip on a crest)
    const gy = g.groundAt(this.pos.x, this.pos.z) + 0.8;
    if (this.pos.y < gy) this.pos.y = gy;
    // land exactly on the rig's live pose
    const k = smooth((this.t - INTRO.converge[0]) / (INTRO.converge[1] - INTRO.converge[0]));
    if (k > 0) {
      this.pos.lerp(cam.basePos, k);
      this.target.lerp(cam.baseTarget, k);
      this.fov += (cam.baseFov - this.fov) * k;
    }
    return this;
  }

  // ---- skipping -------------------------------------------------------------------------------------------
  _skipInput(dt) {
    const inp = this.game.input;
    if (!this.hinted && (inp.keys.size || inp.mouseButtons.size || inp.padButtons.size)) {
      this.hinted = true;
      this.prompts.set('intro', tr('introSkip'), 'E');
    }
    const held = inp.down('interact') || inp.down('dodge') || inp.down('Enter') || inp.padButtons.has(0);
    this.hold = held ? this.hold + dt : 0;
    if (this.hold >= SKIP_HOLD) {
      this.skip = { t: 0, jumped: false };
      this.prompts.clear('intro');
    }
  }

  _skipping(dt) {
    const g = this.game, s = this.skip, [down, up] = SKIP_FADE;
    s.t += dt;
    if (!s.jumped) {
      g.post.params.fade = clamp01(s.t / down);
      if (s.t >= down) {
        s.jumped = true;
        s.t = 0;
        g.post.params.bars = 0;
        g.post.params.dofAperture = g.post.defaults.dofAperture;
        this.cam.snapNext = true; // no glide across the island under the black
      }
      return;
    }
    g.post.params.fade = 1 - clamp01(s.t / up);
    if (s.t >= up) this._finish(true);
  }

  // ---- hand-over ------------------------------------------------------------------------------------------
  _finish(skipped) {
    const g = this.game, cam = this.cam;
    this.active = false;
    this.running = false;
    cam.clearOverride(0.01);
    cam.overrideW = 0;
    cam.lookLocked = false;
    const p = g.post.params, d = g.post.defaults;
    p.bars = 0; // the bars of play are the letterbox (post.params.letterbox, which the cinematic never touches)
    p.fade = 0;
    p.dofAperture = d.dofAperture;
    p.dofFocus = d.dofFocus;
    p.dofMaxBlur = d.dofMaxBlur;
    this.pc.controlLock = 0;
    this.prompts.clear('intro');
    g.emit('intro:end', { skipped });
    if (this.onDone) this.onDone();
  }
}
