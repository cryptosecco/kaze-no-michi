import { t, getLang } from './i18n.js';
import { Menu, OptionList } from './menu.js';
import { MapPanel } from './MapPanel.js';

// Pause (Esc / P / Start): the world freezes behind a blurred ink veil. Resume · Settings · Photo · Title.
// The map (MapPanel) is part of the screen: it shows whenever the menu does, on the right below the objective.
// The settings open as a panel on the right, over the objective and the map, with the menu staying underneath: back
// (Esc / B) closes the panel, the menu entry stays focused; a click on another entry closes the open panel first.
// The same settings panel serves "Options" on the title screen (fromTitle: no pause menu, no map, back → title).

export class Pause {
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
    const el = (this.el = document.createElement('div'));
    el.className = 'kz-layer kz-pause';
    el.innerHTML = `
      <div class="kz-col">
        <div class="kz-small-logo" lang="ja">風の道</div>
        <div class="kz-small-romaji">KAZE NO MICHI</div>
        <div class="kz-pause-menu"></div>
      </div>
      <div class="kz-side">
        <div class="kz-sub"></div>
        <div class="kz-quest-name"></div>
        <div class="kz-quest-obj"></div>
      </div>
      <div class="kz-panel-settings"></div>
      <div class="kz-panel-map"></div>
      <div class="kz-legend"></div>`;
    this.menuWrap = el.querySelector('.kz-pause-menu');
    this.side = el.querySelector('.kz-side');
    this.panel = el.querySelector('.kz-panel-settings');
    this.legend = el.querySelector('.kz-legend');
    this.open_ = false;
    this.fromTitle = false;
    // the map keeps clear of the logo and the menu, the objective and the controls hint
    this.mapPanel = new MapPanel(ui, el.querySelector('.kz-panel-map'), {
      avoid: { menu: el.querySelector('.kz-col'), side: this.side, legend: this.legend },
    });
    this.build();
  }

  build() {
    this.menu = new Menu({
      items: [
        { id: 'resume', key: 'resume' },
        { id: 'settings', key: 'settings' },
        { id: 'photo', key: 'photo' },
        { id: 'title', key: 'quitTitle' },
      ],
      seed: 57,
      sound: this.ui.sound,
      onSelect: (it) => this.onSelect(it.id),
      onBack: () => this.close(),
    });
    this.menuWrap.innerHTML = '';
    this.menuWrap.appendChild(this.menu.el);
    this.options = new OptionList({ rows: this.rows(), sound: this.ui.sound, onBack: () => this.closeSettings() });
    this.panel.innerHTML = '';
    this.panel.appendChild(this.options.el);
    this.legend.innerHTML = t('controlsLegend')
      .map(([k, v]) => `<span><b>${k}</b>${v}</span>`)
      .join('');
  }

  rows() {
    const s = this.ui.settings;
    const g = this.game;
    const pct = (v) => `${Math.round(v * 100)}%`;
    return [
      { type: 'header', key: 'graphics' },
      {
        type: 'choice',
        key: 'quality',
        options: ['low', 'medium', 'high', 'ultra'].map((q) => ({ value: q, labelKey: 'q_' + q })),
        get: () => g.quality.name,
        set: (v) => s.set('quality', v),
      },
      { type: 'slider', key: 'renderScale', min: 0.5, max: 1, step: 0.05, get: () => s.get('renderScale'), set: (v) => s.set('renderScale', v), format: pct },
      { type: 'toggle', key: 'cinema', get: () => s.get('cinema'), set: (v) => s.set('cinema', v) },
      { type: 'toggle', key: 'letterbox', get: () => s.get('letterbox'), set: (v) => s.set('letterbox', v) },
      { type: 'slider', key: 'grain', min: 0, max: 2, step: 0.1, get: () => s.get('grain'), set: (v) => s.set('grain', v), format: pct },
      { type: 'header', key: 'controls' },
      {
        type: 'slider',
        key: 'sensitivity',
        min: 0.3,
        max: 2.5,
        step: 0.1,
        get: () => s.get('sensitivity'),
        set: (v) => s.set('sensitivity', v),
        format: (v) => `${v.toFixed(1)}×`,
      },
      { type: 'toggle', key: 'invertY', get: () => s.get('invertY'), set: (v) => s.set('invertY', v) },
      {
        type: 'choice',
        key: 'sprintMode',
        options: ['hold', 'toggle'].map((m) => ({ value: m, labelKey: 'sm_' + m })),
        get: () => s.get('sprintMode'),
        set: (v) => s.set('sprintMode', v),
      },
      { type: 'toggle', key: 'vibration', get: () => s.get('vibration'), set: (v) => s.set('vibration', v) },
      { type: 'header', key: 'audio' },
      { type: 'slider', key: 'master', min: 0, max: 1, step: 0.05, get: () => s.get('master'), set: (v) => s.set('master', v), format: pct },
      { type: 'slider', key: 'music', min: 0, max: 1, step: 0.05, get: () => s.get('music'), set: (v) => s.set('music', v), format: pct },
      { type: 'slider', key: 'sfx', min: 0, max: 1, step: 0.05, get: () => s.get('sfx'), set: (v) => s.set('sfx', v), format: pct },
      { type: 'header', key: 'language' },
      {
        type: 'choice',
        key: 'language',
        options: [
          { value: 'it', label: 'Italiano' },
          { value: 'en', label: 'English' },
        ],
        get: () => getLang(),
        set: (v) => {
          s.set('lang', v);
          this.ui.refreshText();
        },
      },
      { type: 'note', key: 'reloadNote' },
    ];
  }

  refreshText() {
    const idx = this.menu.index;
    const oidx = this.options.index;
    const old = [this.menu, this.options];
    this.build();
    // build() made new lists: where the old ones sit on the nav stack the new ones take their place. Left there, a stale
    // handler would keep the keys and outlive the pause (Esc could no longer close it, WASD would stay swallowed in play)
    const stack = this.ui.nav.stack;
    stack.forEach((h, i) => {
      if (h === old[0]) stack[i] = this.menu;
      else if (h === old[1]) stack[i] = this.options;
    });
    this.menu.focus(idx, false, true);
    this.options.focus(oidx, false, true);
    this.updateSide();
    this.mapPanel.refreshText();
  }

  updateSide() {
    const q = this.ui.hud.quest;
    this.side.querySelector('.kz-sub').textContent = t('objective');
    this.side.querySelector('.kz-quest-name').textContent = q ? q.title : '';
    this.side.querySelector('.kz-quest-obj').textContent = q ? q.objective : t('noObjective');
  }

  get isOpen() {
    return this.open_;
  }

  open() {
    if (this.open_ || this.game.state !== 'play') return;
    this.open_ = true;
    this.fromTitle = false;
    this.updateSide();
    this.game.loop.paused = true;
    this.game.setState('paused');
    this.game.input.exitPointerLock();
    this.el.classList.remove('settings-open', 'from-title');
    this.el.classList.add('show', 'kz-interactive');
    this.menu.focus(0, false, true);
    this.ui.nav.push(this.menu);
    this.ui.sound('open');
    this.ui.hud.hide();
    this.mapPanel.show();
  }

  close() {
    if (!this.open_) return;
    this.open_ = false;
    this.ui.nav.pop(this.menu);
    this.ui.nav.pop(this.options);
    this.mapPanel.hide();
    this.el.classList.remove('show', 'kz-interactive', 'settings-open');
    this.game.loop.paused = false;
    this.game.setState('play');
    this.game.input.requestPointerLock();
    this.ui.sound('close');
  }

  onSelect(id) {
    this.closePanels();
    if (id === 'resume') this.close();
    else if (id === 'settings') this.openSettings();
    else if (id === 'photo') {
      this.ui.nav.pop(this.menu);
      this.el.classList.remove('show', 'kz-interactive');
      this.ui.photo.open({ from: 'pause' });
    } else if (id === 'title') {
      this.open_ = false;
      this.ui.nav.pop(this.menu);
      this.mapPanel.hide();
      this.el.classList.remove('show', 'kz-interactive');
      this.game.loop.paused = false;
      this.ui.quitToTitle();
    }
  }

  // The open settings panel gives way: a click on another entry of the menu, which stays clickable under it.
  closePanels() {
    if (this.fromTitle) return;
    if (this.el.classList.contains('settings-open')) this.closeSettings();
  }

  // back from photo mode
  reopen() {
    this.el.classList.add('show', 'kz-interactive');
    this.ui.nav.push(this.menu);
  }

  openSettings({ fromTitle = false } = {}) {
    this.fromTitle = fromTitle;
    this.options.refresh();
    if (fromTitle) {
      this.el.classList.add('show', 'kz-interactive', 'from-title', 'settings-open');
      this.el.querySelector('.kz-col').style.visibility = 'hidden';
      this.legend.style.visibility = 'hidden';
    } else {
      this.el.classList.add('settings-open');
      this.el.querySelector('.kz-col').style.visibility = '';
      this.legend.style.visibility = '';
    }
    this.ui.nav.push(this.options);
  }

  closeSettings() {
    this.ui.nav.pop(this.options);
    this.el.classList.remove('settings-open');
    // the map comes back where the settings may have moved its room (the letterbox's bars)
    if (this.open_ && !this.fromTitle) this.mapPanel.layout();
    if (this.fromTitle) {
      this.el.classList.remove('show', 'kz-interactive', 'from-title');
      this.el.querySelector('.kz-col').style.visibility = '';
      this.legend.style.visibility = '';
      this.fromTitle = false;
      this.ui.title.resume();
    }
  }
}
