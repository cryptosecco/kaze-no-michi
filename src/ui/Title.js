import * as THREE from 'three';
import { SHOTS } from '../core/shots.js';
import { strokeSVG, inkText } from './brush.js';
import { t } from './i18n.js';
import { Menu } from './menu.js';

// Title screen: the live island behind an ink wash, brush-calligraphy logo with a red seal, a minimal menu.
// Phase 1 "press any key" (also unlocks audio), phase 2 menu. The camera drifts slowly around the S4 pose, under the
// S4 hour, sky and grade (TitleLook).

const SAVE_KEY = 'kaze.save.v1';

export function hasSave(game) {
  try {
    if (game.save && typeof game.save.exists === 'function') return !!game.save.exists();
    return localStorage.getItem(SAVE_KEY) != null;
  } catch {
    return false;
  }
}

class TitleCamera {
  constructor(game) {
    this.game = game;
    this.pos = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.right = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._t = new THREE.Vector3();
    this.t0 = performance.now();
    this.fov = 44;
    this.reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  setup() {
    const s = SHOTS.S4_title;
    if (!s || !this.game.terrain) return false;
    const { pos, target } = s.pose(this.game.terrain);
    this.pos.set(pos[0], pos[1], pos[2]);
    this.target.set(target[0], target[1], target[2]);
    this.fov = s.fov || 44;
    const dir = this._t.copy(this.target).sub(this.pos).normalize();
    this.right.crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
    this.t0 = performance.now();
    this.frame();
    return true;
  }

  frame() {
    const cam = this.game.camera;
    const t = this.reduced ? 0 : (performance.now() - this.t0) / 1000;
    // slow, seamless lateral drift (period ~84 s) with a breath of height: a crane shot that never ends
    const k = Math.sin((t * Math.PI * 2) / 84);
    const lift = Math.sin((t * Math.PI * 2) / 61) * 0.7;
    this._p.copy(this.pos).addScaledVector(this.right, k * 9);
    this._p.y += lift;
    this._t.copy(this.target).addScaledVector(this.right, k * 3.5);
    cam.position.copy(this._p);
    cam.lookAt(this._t);
    if (Math.abs(cam.fov - this.fov) > 1e-3) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }
}

// The title backdrop is the S4 shot as the player sees it: its hour, weather (sky) and grade while the title shows.
// Closing it brings back the time of day, the gameplay sky (Sky.applyShot() = the defaults) and the grade the game had.
// Only the grade values the shot sets are touched (the options screen, open over the title, owns grain, B&W, letterbox).
export class TitleLook {
  constructor(game) {
    this.game = game;
    this.saved = null;
  }

  apply() {
    const g = this.game, s = SHOTS.S4_title;
    if (!s || this.saved || !g.post) return;
    const p = g.post.params, grade = s.post || {};
    this.saved = { hours: g.timeOfDay, post: Object.fromEntries(Object.keys(grade).map((k) => [k, p[k]])) };
    if (Math.abs(g.timeOfDay - s.hours) > 1e-4) g.setTimeOfDay(s.hours);
    g.sky.applyShot(s.sky);
    Object.assign(p, grade);
  }

  restore() {
    const g = this.game, sv = this.saved;
    if (!sv) return;
    this.saved = null;
    if (Math.abs(g.timeOfDay - sv.hours) > 1e-4) g.setTimeOfDay(sv.hours);
    g.sky.applyShot();
    Object.assign(g.post.params, sv.post);
  }

  // A canonical shot (kaze.setShot, over the title in a normal session) has just set its own hour, sky and grade over
  // the title's: the saved look is stale, so forget it instead of putting it back over the shot.
  discard() {
    this.saved = null;
  }
}

export class Title {
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
    this.cam = new TitleCamera(this.game);
    this.look = new TitleLook(this.game);
    this.phase = 'hidden';
    const el = (this.el = document.createElement('div'));
    el.className = 'kz-layer kz-title';
    el.innerHTML = `
      <div class="kz-veil"></div>
      <div class="kz-block">
        <div class="kz-logo-wrap">
          <div class="kz-logo kz-inkwrap" aria-label="Kaze no Michi">${inkText('風の道')}</div>
          <div class="kz-seal">${sealSVG('旅')}</div>
        </div>
        <div class="kz-romaji">KAZE NO MICHI</div>
        ${strokeSVG({ w: 210, h: 9, seed: 42, tail: 0.62, dry: 6, head: 1.3 }, { cls: 'kz-rule' })}
        <div class="kz-menu-wrap"></div>
      </div>
      <div class="kz-press"></div>
      <div class="kz-hints"></div>`;
    this.menuWrap = el.querySelector('.kz-menu-wrap');
    this.press = el.querySelector('.kz-press');
    this.hints = el.querySelector('.kz-hints');
    this.buildMenu();
    // phase 1: any key / click / pad button opens the menu
    this.pressHandler = {
      onAnyKey: () => {
        this.openMenu();
        return true;
      },
      nav: () => this.openMenu(),
    };
    el.addEventListener('pointerdown', () => {
      if (this.phase === 'press') this.openMenu();
    });
  }

  buildMenu() {
    const items = [
      { id: 'continue', key: 'continue', hidden: !hasSave(this.game) },
      { id: 'new', key: 'newJourney' },
      { id: 'options', key: 'options' },
      { id: 'credits', key: 'credits' },
    ];
    this.menu = new Menu({
      items,
      seed: 31,
      cls: 'kz-title-menu',
      sound: this.ui.sound,
      onSelect: (it) => this.ui.onTitleSelect(it.id),
    });
    this.menuWrap.innerHTML = '';
    this.menuWrap.appendChild(this.menu.el);
  }

  refreshText() {
    this.press.textContent = t('pressAny');
    this.hints.innerHTML = `<span><kbd>↑ ↓</kbd>${t('hintChoose')}</span><span><kbd>⏎</kbd>${t('hintConfirm')}</span>`;
    const idx = this.menu.index;
    this.buildMenu();
    this.menu.focus(idx, false, true);
  }

  show({ capture = false } = {}) {
    this.refreshText();
    const el = this.el;
    el.classList.toggle('instant', capture);
    el.classList.remove('menu-open');
    el.classList.add('show');
    el.classList.toggle('kz-interactive', !capture);
    if (capture) {
      // a canonical capture: the shot already set the hour, the sky and the grade
      this.phase = 'menu';
      el.classList.add('menu-open');
      return;
    }
    this.look.apply();
    this.phase = 'press';
    this.ui.nav.push(this.pressHandler);
  }

  openMenu() {
    if (this.phase !== 'press') return;
    this.phase = 'menu';
    this.ui.nav.pop(this.pressHandler);
    this.el.classList.add('menu-open');
    this.ui.nav.push(this.menu);
    this.ui.sound('open');
    this.game.emit('ui:title-menu');
  }

  // returning from Options/Credits
  resume() {
    if (this.phase === 'menu') this.ui.nav.push(this.menu);
  }

  hide() {
    this.phase = 'hidden';
    this.ui.nav.pop(this.pressHandler);
    this.ui.nav.pop(this.menu);
    this.el.classList.remove('show', 'kz-interactive');
    this.look.restore();
  }

  // Menu anchor for the ink transition (CSS px).
  anchor() {
    const li = this.menu.el.querySelector('.kz-item.on') || this.menu.el;
    const r = li.getBoundingClientRect();
    return { x: r.left + 30, y: r.top + r.height / 2 };
  }
}

export function sealSVG(ch) {
  return `<svg viewBox="0 0 100 100" aria-hidden="true">
    <rect x="5" y="5" width="90" height="90" rx="9" fill="#b83a22"/>
    <rect x="12" y="12" width="76" height="76" rx="5" fill="none" stroke="#f2e2c8" stroke-width="2.4" opacity="0.8"/>
    <text x="50" y="71" text-anchor="middle" font-family="Yuji Boku, Hiragino Mincho ProN, serif" font-size="58" fill="#f4e7d2">${ch}</text>
  </svg>`;
}
