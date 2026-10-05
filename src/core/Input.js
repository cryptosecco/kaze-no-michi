// Keyboard + mouse (pointer lock) + gamepad input with named actions.
// Per-frame usage:  input.update() at the start of the frame, then query:
//   input.down('attack'), input.pressed('dodge'), input.released('block')
//   input.down('sprint', 'key'), input.pressed('sprint', 'pad')   the same, read from one device ('key' | 'mouse' | 'pad')
//   input.move()  → {x, y} in [-1,1] (WASD / left stick, y forward)
//   input.look()  → {x, y} radians-ish delta this frame (mouse / right stick)
//   input.wheel   → wheel delta this frame (one per event, by sign)
//   input.wheelSteps → the same scroll in wheel notches, normalized across mice and trackpads (wheelNotches)
//   input.rumble(strong, weak, ms)   gamepad rumble (Gamepad API 'dual-rumble'); a no-op without a pad that has one
// Nothing stays stuck down: held keys and buttons are dropped when the window loses focus, the tab is hidden or the
// pointer lock is lost, and the other keys when ⌘ is released (macOS never sends the keyup of a key let go while ⌘ is
// down); Shift follows the shiftKey flag that every event carries. Auto-repeat is never a new press. While playing
// (input.enabled) the game keys don't reach the browser (no scrolling on Space, no menu bar on Alt, no back-navigation),
// while its Ctrl / ⌘ shortcuts still do. No game action sits on Ctrl or Alt: Ctrl+W closes the tab, Alt opens menus.

const ACTIONS = {
  forward: { keys: ['KeyW', 'ArrowUp'] },
  back: { keys: ['KeyS', 'ArrowDown'] },
  left: { keys: ['KeyA', 'ArrowLeft'] },
  right: { keys: ['KeyD', 'ArrowRight'] },
  sprint: { keys: ['ShiftLeft', 'ShiftRight'], pad: [10] }, // L3 (a click toggles the sprint)
  walk: { keys: ['KeyZ'] }, // walk toggle
  dodge: { keys: ['Space', 'KeyC'], pad: [1] }, // B / Circle (tap: dodge, hold: sprint)
  attack: { mouse: [0], pad: [2] }, // LMB, X / Square
  heavy: { keys: ['KeyF'], mouse: [2], pad: [3] }, // RMB, Y / Triangle
  block: { keys: ['KeyQ'], pad: [4] }, // L1 (tap on impact = parry)
  interact: { keys: ['KeyE'], pad: [5] }, // R1
  guide: { keys: ['KeyT', 'Tab'], pad: [8] }, // Share/Back → guiding wind
  heal: { keys: ['KeyR'], pad: [12] }, // d-pad up
  pause: { keys: ['Escape', 'KeyP'], pad: [9] }, // Start
  photo: { keys: ['KeyO'], pad: [13] },
  freecam: { keys: ['F1'] }, // dev free camera
  up: { keys: ['KeyE'] }, // free camera
  down: { keys: ['KeyQ'] },
  fast: { keys: ['ShiftLeft', 'ShiftRight'] },
  horse: { keys: ['KeyH'], pad: [14] }, // whistle for the horse (d-pad left)
  zoomReset: { mouse: [1] }, // wheel click: the panorama zoom back to the rig's own lens
};

// One wheel event in notches, signed like deltaY (+ = toward the user). A mouse notch is ~100 px on Windows, a few px
// per event on macOS (accelerated with speed) and one line in Firefox; a trackpad sends many small events. Every event
// counts at least a quarter notch (a slow macOS notch still moves) and at most one and a half (a fast flick or a big
// Windows notch does not leap).
export function wheelNotches(deltaY, deltaMode = 0) {
  const px = deltaMode === 1 ? deltaY * 33 : deltaMode === 2 ? deltaY * 800 : deltaY;
  if (!px) return 0;
  return Math.sign(px) * Math.min(1.5, Math.max(0.25, Math.abs(px) / 60));
}

const NONE = new Set();
const SHIFT = new Set(['ShiftLeft', 'ShiftRight']);
const META = new Set(['MetaLeft', 'MetaRight', 'OSLeft', 'OSRight']);
const MODIFIERS = new Set([...SHIFT, ...META, 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'CapsLock']);
// keys the browser acts on by itself (scroll, focus, menu bar, quick find, help, back), kept from it while playing
const RESERVED = new Set(['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'AltLeft', 'AltRight', 'F1', 'Backspace', 'Slash', 'Quote', 'ContextMenu']);

export class Input {
  constructor(target) {
    this.target = target;
    this.keys = new Set();
    this._taps = new Set(); // keys/buttons pressed since the last update (pressed and released in between still count once)
    this.prevKeys = new Set();
    this.mouseButtons = new Set();
    this.prevMouse = new Set();
    this.padButtons = new Set();
    this.prevPad = new Set();
    this._mdx = 0;
    this._mdy = 0;
    this._wheel = 0;
    this._wheelSteps = 0;
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.wheelSteps = 0;
    this.pad = { lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, connected: false };
    this.pointerLocked = false;
    this.enabled = true;
    this.lookSensitivity = 0.0022;
    this.padLookSpeed = 2.6;

    window.addEventListener('keydown', (e) => this._keyDown(e));
    window.addEventListener('keyup', (e) => this._keyUp(e));
    window.addEventListener('blur', () => this.clear());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.clear();
    });
    target.addEventListener('mousedown', (e) => {
      this._syncShift(e);
      if (!this.enabled) return;
      this.mouseButtons.add(e.button);
      this._taps.add('mouse' + e.button);
      if (e.button === 1 || e.button > 2) e.preventDefault(); // no autoscroll, no history navigation
    });
    window.addEventListener('mouseup', (e) => {
      this.mouseButtons.delete(e.button);
      if (this.enabled && e.button > 2) e.preventDefault();
    });
    target.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('contextmenu', (e) => {
      if (this.enabled) e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      this._syncShift(e);
      if (!this.pointerLocked) return;
      this._mdx += e.movementX;
      this._mdy += e.movementY;
    });
    window.addEventListener(
      'wheel',
      (e) => {
        this._wheel += Math.sign(e.deltaY);
        if (this.enabled) this._wheelSteps += wheelNotches(e.deltaY, e.deltaMode);
      },
      { passive: true }
    );
    document.addEventListener('pointerlockchange', () => {
      const was = this.pointerLocked;
      this.pointerLocked = document.pointerLockElement === target;
      if (was && !this.pointerLocked) this.clear();
    });
  }

  _keyDown(e) {
    if (!this.enabled) return;
    const code = e.code;
    if (e.metaKey && !MODIFIERS.has(code)) return; // a ⌘ chord is the system's, and its keyup may never arrive
    this._syncShift(e);
    if (e.repeat) {
      // auto-repeat keeps a held key alive (it comes back after a clear) but is never a new press
      if (!this.keys.has(code)) {
        this.keys.add(code);
        if (this.keysFrame) this.keysFrame.add(code);
      }
    } else {
      this.keys.add(code);
      this._taps.add(code);
    }
    if (this._isGameKey(e)) e.preventDefault();
  }

  _keyUp(e) {
    this.keys.delete(e.code);
    if (META.has(e.code)) this.clear({ keepModifiers: true });
    else this._syncShift(e);
    if (this.enabled && this._isGameKey(e)) e.preventDefault();
  }

  // Shift's real state rides on every key and mouse event: a Shift pressed while the game wasn't listening (a menu,
  // another window) is picked up at the next event, and a real event that says it is up drops a Shift whose keyup was
  // lost. The Shift keys' own events speak for themselves.
  _syncShift(e) {
    if (typeof e.shiftKey !== 'boolean' || SHIFT.has(e.code)) return;
    const held = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    if (e.shiftKey && !held && this.enabled) this.keys.add('ShiftLeft');
    else if (!e.shiftKey && held && e.isTrusted) {
      this.keys.delete('ShiftLeft');
      this.keys.delete('ShiftRight');
    }
  }

  _isGameKey(e) {
    if (e.ctrlKey || e.metaKey) return false; // reload, close, devtools… stay the browser's
    return RESERVED.has(e.code) || Object.values(ACTIONS).some((a) => a.keys && a.keys.includes(e.code));
  }

  // Drop every held key and mouse button (or, with keepModifiers, the non-modifier keys only).
  clear({ keepModifiers = false } = {}) {
    for (const k of [...this.keys]) if (!keepModifiers || !MODIFIERS.has(k)) this.keys.delete(k);
    if (keepModifiers) return;
    this.mouseButtons.clear();
    this._taps.clear();
  }

  requestPointerLock() {
    if (!this.pointerLocked && this.target.requestPointerLock) {
      const p = this.target.requestPointerLock();
      if (p && p.catch) p.catch(() => {});
    }
  }

  exitPointerLock() {
    if (document.exitPointerLock) document.exitPointerLock();
  }

  update() {
    this.prevKeys = new Set(this.keysFrame || []);
    this.keysFrame = new Set(this.keys);
    this.prevMouse = new Set(this.mouseFrame || []);
    this.mouseFrame = new Set(this.mouseButtons);
    // a fresh keydown / mousedown is a press even when the key looked held (its release was lost)
    for (const t of this._taps) {
      if (t.startsWith('mouse')) {
        const b = Number(t.slice(5));
        this.mouseFrame.add(b);
        this.prevMouse.delete(b);
      } else {
        this.keysFrame.add(t);
        this.prevKeys.delete(t);
      }
    }
    this._taps.clear();
    this.mouseDX = this._mdx;
    this.mouseDY = this._mdy;
    this.wheel = this._wheel;
    this.wheelSteps = this._wheelSteps;
    this._mdx = this._mdy = this._wheel = this._wheelSteps = 0;

    this.prevPad = this.padButtons;
    this.padButtons = new Set();
    const gp = this._gamepad();
    const dz = (v) => (Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85);
    if (gp) {
      this.pad.connected = true;
      this.pad.lx = dz(gp.axes[0] || 0);
      this.pad.ly = dz(gp.axes[1] || 0);
      this.pad.rx = dz(gp.axes[2] || 0);
      this.pad.ry = dz(gp.axes[3] || 0);
      this.pad.lt = gp.buttons[6] ? gp.buttons[6].value : 0;
      this.pad.rt = gp.buttons[7] ? gp.buttons[7].value : 0;
      gp.buttons.forEach((b, i) => {
        if (b.pressed) this.padButtons.add(i);
      });
    } else {
      this.pad.connected = false;
      this.pad.lx = this.pad.ly = this.pad.rx = this.pad.ry = this.pad.lt = this.pad.rt = 0;
    }
  }

  _gamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    return (pads && Array.from(pads).find((p) => p && p.connected)) || null;
  }

  // Gamepad rumble: strong (low) and weak (high frequency) motor magnitudes in [0, 1] for `ms` milliseconds.
  rumble(strong, weak, ms) {
    const gp = this._gamepad();
    if (!gp) return false;
    try {
      const va = gp.vibrationActuator;
      const h = gp.hapticActuators && gp.hapticActuators[0];
      let p = null;
      if (va && va.playEffect) p = va.playEffect('dual-rumble', { startDelay: 0, duration: ms, strongMagnitude: strong, weakMagnitude: weak });
      else if (h && h.pulse) p = h.pulse(Math.max(strong, weak), ms);
      else return false;
      if (p && p.catch) p.catch(() => {});
      return true;
    } catch {
      return false; // the pad refused the effect
    }
  }

  _state(name, set, mouseSet, padSet) {
    const a = ACTIONS[name];
    if (!a) return set.has(name); // raw key code
    if (a.keys && a.keys.some((k) => set.has(k))) return true;
    if (a.mouse && a.mouse.some((b) => mouseSet.has(b))) return true;
    if (a.pad && a.pad.some((b) => padSet.has(b))) return true;
    return false;
  }

  // this frame's (or the previous frame's) key, mouse and pad sets, restricted to one device if asked
  _sets(device, prev) {
    const k = prev ? this.prevKeys : this.keysFrame || this.keys;
    const m = prev ? this.prevMouse : this.mouseFrame || this.mouseButtons;
    const p = prev ? this.prevPad : this.padButtons;
    return [!device || device === 'key' ? k : NONE, !device || device === 'mouse' ? m : NONE, !device || device === 'pad' ? p : NONE];
  }

  down(name, device) {
    return this._state(name, ...this._sets(device, false));
  }
  pressed(name, device) {
    return this.down(name, device) && !this._state(name, ...this._sets(device, true));
  }
  released(name, device) {
    return !this.down(name, device) && this._state(name, ...this._sets(device, true));
  }

  move() {
    let x = 0, y = 0;
    if (this.down('left')) x -= 1;
    if (this.down('right')) x += 1;
    if (this.down('forward')) y += 1;
    if (this.down('back')) y -= 1;
    x += this.pad.lx;
    y -= this.pad.ly;
    const l = Math.hypot(x, y);
    if (l > 1) {
      x /= l;
      y /= l;
    }
    return { x, y };
  }

  // Look delta for this frame (dt needed for stick integration).
  look(dt = 1 / 60) {
    return {
      x: this.mouseDX * this.lookSensitivity + this.pad.rx * this.padLookSpeed * dt,
      y: this.mouseDY * this.lookSensitivity + this.pad.ry * this.padLookSpeed * dt,
    };
  }
}

export { ACTIONS };
