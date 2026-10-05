import './styles.css';
import { SVG_DEFS } from './brush.js';
import { setLang, defaultLang, t } from './i18n.js';
import { Settings } from './settings.js';
import { loadFonts } from './fonts.js';
import { Nav } from './menu.js';
import { Title } from './Title.js';
import { HUD } from './HUD.js';
import { Cards } from './Cards.js';
import { Pause } from './Pause.js';
import { PhotoMode } from './PhotoMode.js';
import { InkTransition } from './ink.js';
import { trackBars } from './bars.js';

// UI module. Screens: loading card (index.html #boot), title, HUD, quest/death/ending cards, pause (with the
// map) + settings, photo mode, credits. Game states drive it:
//   'title'  → title screen + slow cinematic camera (takes game.cameraController, restores it on 'play') under the
//              S4 shot's hour, sky and grade (restored when the title closes)
//   'play'   → HUD; Esc/P/Start pause, O photo mode, M mute
//   'shot'   → nothing, except canonical shot S4_title which renders the full title screen
// Emits: 'ui:newgame', 'ui:continue', 'ui:revealed' (the ink of a new game has dissolved), 'ui:retry', 'ui:quit',
//        'ui:title-menu', 'ui:sound' {kind}, 'settings' {settings,key}, 'audio:mute-toggle'.  game.ui = this,
//        game.settings = live values.

export async function install(game, ctx) {
  const ui = new UI(game, ctx);
  await ui.init();
  game.ui = ui;
  return ui;
}

class UI {
  constructor(game, ctx) {
    this.game = game;
    this.ctx = ctx;
    this.capture = !!ctx.shot;
    this.sound = (kind) => game.emit('ui:sound', { kind });
    this._busy = false;
    this._lockLostPauses = false;
  }

  async init() {
    const game = this.game;
    this.settings = new Settings(game, { capture: this.capture });
    setLang(this.settings.get('lang') || defaultLang());
    if (!this.capture) this.settings.applyAll();

    let root = document.getElementById('ui');
    if (!root) {
      root = document.createElement('div');
      root.id = 'ui';
      document.body.appendChild(root);
    }
    this.root = root;
    root.insertAdjacentHTML('beforeend', SVG_DEFS);
    trackBars(game, root); // --kz-bar: the in-play HUD keeps to the picture between the film letterbox's bars

    this.nav = new Nav(game);
    this.hud = new HUD(this);
    this.cards = new Cards(this);
    this.title = new Title(this);
    this.pause = new Pause(this);
    this.photo = new PhotoMode(this);
    root.append(this.hud.el, ...this.cards.layers, this.title.el, this.pause.el, this.photo.el);
    this.ink = new InkTransition(root);

    await loadFonts(this.capture ? 5000 : 2500);

    game.on('state', (e) => this.onState(e.detail || {}));
    game.onShot((id) => this.onShot(id));
    game.on('audio:muted', (e) => this.cards.toast(t(e.detail && e.detail.muted ? 'muted' : 'unmuted')));
    game.addSystem({ frame: () => this.frame() });
    window.addEventListener('keydown', (e) => this.onKey(e));
    document.addEventListener('pointerlockchange', () => this.onLockChange());
    return this;
  }

  refreshText() {
    this.title.refreshText();
    this.pause.refreshText();
  }

  // ------------------------------------------------------------------------------------------ states
  onState({ state, prev }) {
    const g = this.game;
    if (state === 'title') {
      this.hud.hide();
      this.setInput(false);
      this.enterTitleCamera();
      if (!this.capture) this.title.show();
    } else if (state === 'play') {
      if (prev === 'title') {
        this.title.hide();
        this.exitTitleCamera();
      }
      this.setInput(true);
      this.hud.show();
    } else if (state === 'paused') {
      this.setInput(false);
    } else if (state === 'cutscene') {
      this.hud.hide();
    } else if (state === 'shot') {
      this.hud.hide();
      this.title.hide();
    }
    void g;
  }

  onShot(id) {
    // the shot has just set its own hour, sky and grade (kaze.setShot): drop the look the title saved, or hide() below
    // would restore it over the shot (a debug setShot while the title is up in a normal session)
    this.title.look.discard();
    // captures: only the title shot shows UI (the full title screen, no animation)
    if (id === 'S4_title') this.title.show({ capture: true });
    else this.title.hide();
    this.hud.hide();
  }

  setInput(on) {
    const inp = this.game.input;
    inp.enabled = on;
    if (!on) {
      inp.keys.clear();
      inp.mouseButtons.clear();
    }
  }

  enterTitleCamera() {
    const g = this.game;
    if (!this.titleCtl) this.titleCtl = { frame: () => this.title.cam.frame() };
    if (g.cameraController !== this.titleCtl) {
      this._savedCtl = g.cameraController;
      g.cameraController = this.titleCtl;
    }
    if (g.freeCam) g.freeCam.enabled = false;
    this.title.cam.setup();
  }

  exitTitleCamera() {
    const g = this.game;
    if (g.cameraController === this.titleCtl) g.cameraController = this._savedCtl || null;
    this._savedCtl = null;
    if (g.freeCam && !g.cameraController) {
      g.freeCam.syncFromCamera();
      g.freeCam.enabled = true;
    }
  }

  // ------------------------------------------------------------------------------------------ flow
  onTitleSelect(id) {
    if (id === 'new' || id === 'continue') this.startGame(id);
    else if (id === 'options') {
      this.nav.pop(this.title.menu);
      this.pause.openSettings({ fromTitle: true });
    } else if (id === 'credits') {
      this.nav.pop(this.title.menu);
      this.cards.showCredits(() => this.title.resume());
    }
  }

  async startGame(mode) {
    if (this._busy) return;
    this._busy = true;
    const g = this.game;
    this.nav.pop(this.title.menu);
    this.sound('start');
    g.input.requestPointerLock(); // inside the user gesture
    const a = this.title.anchor();
    await this.ink.cover({ x: a.x, y: a.y });
    this.title.hide();
    g.emit(mode === 'continue' ? 'ui:continue' : 'ui:newgame');
    g.loop.paused = false;
    g.setState('play');
    await g.loop.waitFrames(4);
    await this.ink.reveal();
    g.emit('ui:revealed'); // the opening cinematic starts its clock on it (src/actors/intro.js)
    this._busy = false;
  }

  async quitToTitle() {
    if (this._busy) return;
    this._busy = true;
    const g = this.game;
    g.input.exitPointerLock();
    this.hud.hide();
    await this.ink.cover({ x: window.innerWidth * 0.5, y: window.innerHeight * 0.5, duration: 800 });
    g.emit('ui:quit');
    g.loop.paused = false;
    g.setState('title');
    this.title.buildMenu();
    await g.loop.waitFrames(4);
    await this.ink.reveal();
    this._busy = false;
  }

  // ------------------------------------------------------------------------------------------ input
  onKey(e) {
    const g = this.game;
    if (e.code === 'KeyM' && !e.repeat) {
      g.emit('audio:mute-toggle');
      return;
    }
    if (g.state !== 'play' || this._busy || this.nav.top()) return;
    if ((e.code === 'Escape' || e.code === 'KeyP') && !e.repeat) {
      e.preventDefault();
      this.pause.open();
    } else if (e.code === 'KeyO' && !e.repeat) {
      this.photo.open({ from: 'play' });
    }
  }

  onLockChange() {
    const g = this.game;
    const locked = document.pointerLockElement != null;
    if (locked) this._lockLostPauses = true;
    // Esc while pointer-locked is swallowed by the browser (it only releases the lock): treat it as pause
    else if (this._lockLostPauses && g.state === 'play' && !this._busy && !this.nav.top()) this.pause.open();
    if (!locked && g.state !== 'play') this._lockLostPauses = false;
  }

  frame() {
    const now = performance.now();
    const g = this.game;
    // gamepad Start pauses during play: Nav tells a fresh press that no screen had the pad for from the one a screen took
    // (Start is `back` there, so the press that closes the pause must not open it again in the same frame)
    const startPressed = this.nav.poll(g.input, now);
    this.hud.frame(now);
    if (startPressed && g.state === 'play' && !this._busy) this.pause.open();
  }
}
