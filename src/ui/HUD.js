import { strokeSVG, ensoSVG } from './brush.js';
import { t } from './i18n.js';

// In-game HUD. Nearly invisible: everything fades out when nothing changes and comes back on events.
//   'player:health' {hp, max}      brush-line health (lag stroke in vermilion shows the damage taken)
//   'player:resolve' {value, max}  ensō pips
//   'quest:update' {id, title, objective}   objective line (top-left)
//   'prompt' {text, key} / 'prompt:clear'  contextual prompt (bottom-centre)
//   'combat:start' / 'combat:end'  keep vitals visible while fighting
//   'guide'                        (guiding wind used) → show the objective again
//   'intro:start' / 'intro:end'    the opening cinematic: only the prompt line shows (its skip hint)

const VITALS_IDLE_MS = 4800;
const OBJECTIVE_IDLE_MS = 9000;

export class HUD {
  constructor(ui) {
    this.ui = ui;
    const game = (this.game = ui.game);
    const el = (this.el = document.createElement('div'));
    el.className = 'kz-layer kz-hud';
    const hpStroke = { w: 300, h: 16, seed: 77, tail: 0.3, landing: 0.04, head: 1.12, dry: 5, rough: 0.12 };
    el.innerHTML = `
      <div class="kz-dmg"></div>
      <div class="kz-objective idle">
        <div class="kz-qt"></div>
        ${strokeSVG({ w: 150, h: 7, seed: 9, tail: 0.6, dry: 4 }, { cls: 'kz-qt-rule' })}
        <div class="kz-qo"></div>
      </div>
      <div class="kz-vitals idle">
        <div class="kz-health">
          <div class="kz-hp-bg">${strokeSVG(hpStroke)}</div>
          <div class="kz-hp-lag">${strokeSVG(hpStroke)}</div>
          <div class="kz-hp">${strokeSVG(hpStroke)}</div>
        </div>
        <div class="kz-resolve"></div>
      </div>
      <div class="kz-prompt"><span class="kz-key"></span><span class="kz-ptext"></span></div>`;
    this.q = {
      dmg: el.querySelector('.kz-dmg'),
      obj: el.querySelector('.kz-objective'),
      qt: el.querySelector('.kz-qt'),
      qo: el.querySelector('.kz-qo'),
      vitals: el.querySelector('.kz-vitals'),
      health: el.querySelector('.kz-health'),
      hp: el.querySelector('.kz-hp'),
      lag: el.querySelector('.kz-hp-lag'),
      resolve: el.querySelector('.kz-resolve'),
      prompt: el.querySelector('.kz-prompt'),
      key: el.querySelector('.kz-prompt .kz-key'),
      ptext: el.querySelector('.kz-ptext'),
    };
    this.hp = 1;
    this.resolve = { value: 0, max: 3 };
    this.quest = null;
    this.combat = false;
    this.vitalsAt = -1e9;
    this.objAt = -1e9;
    this.setResolve(0, 3);
    this.setHealth(100, 100, true);

    game.on('player:health', (e) => {
      const { hp, max } = e.detail || {};
      if (typeof hp === 'number') this.setHealth(hp, max || 100);
    });
    game.on('player:resolve', (e) => {
      const { value, max } = e.detail || {};
      if (typeof value === 'number') this.setResolve(value, max || this.resolve.max);
    });
    game.on('quest:update', (e) => this.setQuest(e.detail || {}));
    game.on('prompt', (e) => this.showPrompt(e.detail || {}));
    game.on('prompt:clear', () => this.clearPrompt());
    game.on('combat:start', () => {
      this.combat = true;
      this.pokeVitals();
    });
    game.on('combat:end', () => {
      this.combat = false;
      this.pokeVitals();
    });
    game.on('guide', () => this.pokeObjective());
    game.on('standoff:start', () => this.el.classList.add('standoff'));
    game.on('standoff:end', () => this.el.classList.remove('standoff'));
    // prayer at the shrine is a quiet moment: the HUD steps aside
    game.on('pray:start', () => this.el.classList.add('standoff'));
    game.on('pray:end', () => this.el.classList.remove('standoff'));
    // the opening cinematic: no vitals or objective over the film, the skip hint alone
    game.on('intro:start', () => this.el.classList.add('cinema'));
    game.on('intro:end', () => this.el.classList.remove('cinema'));
    const revive = () => {
      this.q.dmg.classList.remove('low', 'flash');
      this.q.health.classList.remove('low');
      this.pokeVitals();
    };
    game.on('respawn', revive);
    game.on('player:respawn', revive);
  }

  show() {
    this.el.classList.add('show');
    this.pokeVitals();
    this.pokeObjective();
  }

  hide() {
    this.el.classList.remove('show');
  }

  pokeVitals() {
    this.vitalsAt = performance.now();
    this.q.vitals.classList.remove('idle');
  }

  pokeObjective() {
    if (!this.quest) return;
    this.objAt = performance.now();
    this.q.obj.classList.remove('idle');
  }

  setHealth(hp, max, silent = false) {
    const f = Math.max(0, Math.min(1, hp / max));
    const prev = this.hp;
    this.hp = f;
    const clip = `inset(0 ${((1 - f) * 100).toFixed(2)}% 0 0)`;
    this.q.hp.style.clipPath = clip;
    this.q.lag.style.clipPath = clip; // CSS delays the lag stroke, so the lost chunk lingers in vermilion
    const low = f > 0 && f < 0.3;
    this.q.health.classList.toggle('low', low);
    this.q.dmg.classList.toggle('low', low);
    if (!silent && f < prev - 1e-4) {
      const d = this.q.dmg;
      d.classList.remove('flash');
      void d.offsetWidth;
      d.classList.add('flash');
      setTimeout(() => d.classList.remove('flash'), 120);
    }
    if (!silent) this.pokeVitals();
  }

  setResolve(value, max) {
    const changed = max !== this.resolve.max;
    this.resolve = { value, max };
    if (changed || !this.q.resolve.children.length) {
      this.q.resolve.innerHTML = '';
      for (let i = 0; i < max; i++) {
        const pip = document.createElement('span');
        pip.className = 'kz-pip';
        pip.innerHTML = ensoSVG({ size: 20, seed: 50 + i * 13, width: 0.14 });
        this.q.resolve.appendChild(pip);
      }
    }
    [...this.q.resolve.children].forEach((p, i) => p.classList.toggle('full', i < Math.floor(value + 1e-6)));
    this.pokeVitals();
  }

  setQuest({ id, title, objective }) {
    const isNew = !this.quest || this.quest.id !== id;
    this.quest = { id, title: title || '', objective: objective || t('noObjective') };
    this.q.qt.textContent = this.quest.title;
    this.q.qo.textContent = this.quest.objective;
    this.pokeObjective();
    return isNew;
  }

  showPrompt({ text, key }) {
    if (!text) return this.clearPrompt();
    const k = key ? String(key) : '';
    this.q.key.textContent = k;
    this.q.key.style.display = k ? '' : 'none';
    this.q.key.classList.toggle('wide', k.length > 1);
    this.q.ptext.textContent = text;
    this.q.prompt.classList.add('show');
  }

  clearPrompt() {
    this.q.prompt.classList.remove('show');
  }

  frame(now) {
    const low = this.hp > 0 && this.hp < 0.3;
    if (!this.combat && !low && now - this.vitalsAt > VITALS_IDLE_MS) this.q.vitals.classList.add('idle');
    if (now - this.objAt > OBJECTIVE_IDLE_MS) this.q.obj.classList.add('idle');
  }
}
