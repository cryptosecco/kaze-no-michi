import { setLang, defaultLang } from './i18n.js';

// Player settings: persisted in localStorage (every access guarded — private windows may throw), applied to
// the renderer/post/input, and broadcast as game event 'settings' { settings, key } for other modules
// (the audio module reads master/music/sfx). game.settings is the live values object.

const KEY = 'kaze.settings.v1';

// save() writes every key, so a default that changes later would never reach a player who saved before: the old value
// stays stored. Such a change is a migration, run once as the settings load; the stored object carries the version it
// has been brought to (none: saved before versions, read as 1).
//   2: the film letterbox (2.39:1) became the default and stays in play: the stored 'letterbox' is dropped, once
export const VERSION = 2;

export const DEFAULTS = {
  lang: null, // null → Italian (defaultLang in i18n.js)
  quality: null, // null → preset chosen at boot (URL or default)
  renderScale: 1, // multiplier of the preset's render scale (0.5 … 1)
  cinema: false, // black & white cinema mode
  letterbox: true, // the film letterbox (2.39:1), in play too: the base that the stand-off and the kill cam give back
  grain: 1, // multiplier of the base film grain (0 … 2)
  sensitivity: 1, // multiplier of the base mouse look sensitivity
  invertY: false,
  sprintMode: 'hold', // Shift: 'hold' or 'toggle' (read live by the player controller)
  vibration: true, // gamepad rumble (read live by actors/rumble.js)
  master: 0.9,
  music: 0.7,
  sfx: 0.85,
};

// The stored settings (without their version), brought up to VERSION.
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    const stored = raw ? JSON.parse(raw) : null;
    if (!stored || typeof stored !== 'object') return {};
    const { version = 1, ...v } = stored;
    if (version < 2) delete v.letterbox; // see VERSION
    if (version < VERSION) save(v); // written back at once: a migration never runs twice
    return v;
  } catch {
    return {};
  }
}

function save(v) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...v, version: VERSION }));
  } catch {
    /* storage unavailable: settings last for this session only */
  }
}

export class Settings {
  constructor(game, { capture = false } = {}) {
    this.game = game;
    this.capture = capture; // automated captures never apply persisted visual settings
    this.v = { ...DEFAULTS, ...(capture ? {} : load()) };
    this.base = {
      grain: game.post.params.grain,
      sensitivity: game.input.lookSensitivity,
      presetScale: game.quality.renderScale,
    };
    game.settings = this.v;
    this._wrapInvertY();
  }

  // Invert-Y is applied at the input layer so every camera (free, third-person, photo) honours it.
  _wrapInvertY() {
    const input = this.game.input;
    if (input._kzLookWrapped) return;
    const orig = input.look.bind(input);
    input.look = (dt) => {
      const l = orig(dt);
      if (this.v.invertY) l.y = -l.y;
      return l;
    };
    input._kzLookWrapped = true;
  }

  get(k) {
    return this.v[k];
  }

  set(k, value) {
    this.v[k] = value;
    this.apply(k);
    if (!this.capture) save(this.v);
    this.game.emit('settings', { settings: this.v, key: k });
  }

  applyAll() {
    for (const k of Object.keys(DEFAULTS)) this.apply(k);
  }

  apply(k) {
    const g = this.game;
    const v = this.v;
    switch (k) {
      case 'lang':
        setLang(v.lang || defaultLang());
        break;
      case 'quality':
        if (this.capture || !v.quality || v.quality === g.quality.name) break;
        g.setQuality(v.quality);
        this.base.presetScale = g.quality.renderScale;
        this.apply('renderScale');
        break;
      case 'renderScale': {
        if (this.capture) break;
        const r = g.renderer;
        const s = Math.max(0.4, Math.min(1, this.base.presetScale * v.renderScale));
        r.quality.renderScale = s;
        r.renderScale = s;
        for (const fn of r.listeners) fn(r);
        break;
      }
      case 'cinema':
        if (!this.capture) g.post.params.bw = v.cinema ? 1 : 0;
        break;
      case 'letterbox':
        // the base, written once to the live param and to the defaults that what borrows the letterbox (stand-off, kill
        // cam) and kaze.setShot restore from
        if (!this.capture) g.post.params.letterbox = g.post.defaults.letterbox = v.letterbox ? 1 : 0;
        break;
      case 'grain':
        if (!this.capture) g.post.params.grain = this.base.grain * v.grain;
        break;
      case 'sensitivity':
        g.input.lookSensitivity = this.base.sensitivity * v.sensitivity;
        break;
      default:
        break;
    }
  }
}
