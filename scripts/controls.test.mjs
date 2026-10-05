// Tests for the controls (run: npm test): the input layer (stuck keys, auto-repeat, browser keys, devices), the action
// buffer, the cancel windows, the sprint intent, the locomotion speeds and the gamepad rumble wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionBuffer } from '../src/core/ActionBuffer.js';
import { SprintControl, SPEED, topSpeed, slopeFactor } from '../src/actors/locomotion.js';
import { canAct } from '../src/actors/combat/windows.js';
import { installRumble, RUMBLE } from '../src/actors/rumble.js';

// ---- a minimal DOM for Input (this file runs in its own process) ---------------------------------------------------
const pads = [];
globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { hidden: false, pointerLockElement: null, exitPointerLock() {} });
Object.defineProperty(globalThis, 'navigator', { value: { getGamepads: () => pads }, configurable: true });
const { Input, ACTIONS } = await import('../src/core/Input.js');

const canvas = Object.assign(new EventTarget(), { requestPointerLock() {} });
const input = new Input(canvas);
const ev = (type, props) => Object.assign(new Event(type, { cancelable: true }), props);
const key = (type, code, extra = {}) => {
  const e = ev(type, { code, repeat: false, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...extra });
  window.dispatchEvent(e);
  return e;
};
const mouse = (type, button) => (type === 'mousedown' ? canvas : window).dispatchEvent(ev(type, { button, shiftKey: false }));
const reset = () => {
  input.enabled = true;
  input.clear();
  pads.length = 0;
  input.update();
  input.update();
};

test('five simultaneous inputs all register (W, A, Shift, Space, LMB)', () => {
  reset();
  key('keydown', 'KeyW');
  key('keydown', 'KeyA');
  key('keydown', 'ShiftLeft', { shiftKey: true });
  key('keydown', 'Space', { shiftKey: true });
  mouse('mousedown', 0);
  input.update();
  assert.ok(input.down('forward') && input.down('left') && input.down('sprint'));
  assert.ok(input.pressed('dodge') && input.pressed('attack'));
  const m = input.move();
  assert.ok(m.x < 0 && m.y > 0 && Math.abs(Math.hypot(m.x, m.y) - 1) < 1e-9);
});

test('a key released while ⌘ is held does not stay stuck, and ⌘ chords are not game input', () => {
  reset();
  key('keydown', 'KeyW');
  input.update();
  assert.ok(input.down('forward'));
  key('keydown', 'MetaLeft', { metaKey: true });
  key('keydown', 'KeyQ', { metaKey: true }); // ⌘Q: the system's
  key('keyup', 'MetaLeft'); // macOS never sends W's keyup
  input.update();
  assert.equal(input.down('forward'), false);
  assert.equal(input.down('block'), false);
});

test('blur, a hidden tab and a lost pointer lock drop every held key and button', () => {
  for (const drop of [
    () => window.dispatchEvent(new Event('blur')),
    () => {
      document.hidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
      document.hidden = false;
    },
    () => {
      document.pointerLockElement = canvas;
      document.dispatchEvent(new Event('pointerlockchange'));
      document.pointerLockElement = null;
      document.dispatchEvent(new Event('pointerlockchange'));
    },
  ]) {
    reset();
    key('keydown', 'KeyW');
    key('keydown', 'ShiftLeft', { shiftKey: true });
    mouse('mousedown', 2);
    input.update();
    assert.ok(input.down('forward') && input.down('sprint') && input.down('heavy'));
    drop();
    input.update();
    assert.ok(!input.down('forward') && !input.down('sprint') && !input.down('heavy'));
  }
});

test('auto-repeat keeps a key held but is never a new press; a fresh keydown always is', () => {
  reset();
  key('keydown', 'Space');
  input.update();
  assert.ok(input.pressed('dodge'));
  window.dispatchEvent(new Event('blur'));
  key('keydown', 'Space', { repeat: true }); // still physically held after the blur
  input.update();
  assert.ok(input.down('dodge'));
  assert.equal(input.pressed('dodge'), false);
  key('keydown', 'Space'); // a real press whose previous keyup was lost
  input.update();
  assert.ok(input.pressed('dodge'));
});

test('a tap between two frames still counts once, then releases', () => {
  reset();
  key('keydown', 'KeyC');
  key('keyup', 'KeyC');
  input.update();
  assert.ok(input.pressed('dodge'));
  input.update();
  assert.ok(input.released('dodge') && !input.down('dodge'));
});

test('game keys never reach the browser while playing; Ctrl/⌘ shortcuts and menus keep theirs', () => {
  reset();
  for (const code of ['Space', 'Tab', 'AltLeft', 'ArrowLeft', 'F1', 'KeyW', 'Backspace']) assert.ok(key('keydown', code).defaultPrevented, code);
  assert.ok(key('keyup', 'AltLeft').defaultPrevented);
  assert.equal(key('keydown', 'KeyR', { ctrlKey: true }).defaultPrevented, false);
  assert.equal(key('keydown', 'Digit5').defaultPrevented, false);
  reset();
  input.enabled = false; // a menu is open: its own handler decides
  assert.equal(key('keydown', 'Space').defaultPrevented, false);
  input.update();
  assert.equal(input.down('dodge'), false);
});

test('no action is bound to Ctrl or Alt', () => {
  const keys = Object.values(ACTIONS).flatMap((a) => a.keys || []);
  for (const k of ['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']) assert.ok(!keys.includes(k), k);
  assert.deepEqual(ACTIONS.dodge.keys, ['Space', 'KeyC']);
  assert.deepEqual(ACTIONS.block.keys, ['KeyQ']);
});

test('Shift follows the shiftKey flag of other events', () => {
  reset();
  key('keydown', 'KeyW', { shiftKey: true }); // Shift went down while a menu was open
  input.update();
  assert.ok(input.down('sprint'));
  input._syncShift({ code: 'KeyW', shiftKey: false, isTrusted: true }); // a real event says Shift is up: its keyup was lost
  input.update();
  assert.equal(input.down('sprint'), false);
  input._syncShift({ code: 'KeyW', shiftKey: true });
  input._syncShift({ code: 'KeyW', shiftKey: false, isTrusted: false }); // synthetic events never drop it
  input.update();
  assert.ok(input.down('sprint'));
});

test('actions can be read from one device: Shift and the pad L3 apart', () => {
  reset();
  const button = (on) => ({ pressed: on, value: on ? 1 : 0 });
  pads.push({ connected: true, axes: [0, -1, 0, 0], buttons: Array.from({ length: 17 }, (_, i) => button(i === 10)) });
  input.update();
  assert.ok(input.pressed('sprint', 'pad'));
  assert.ok(input.pressed('sprint')); // any device
  assert.equal(input.pressed('sprint', 'key'), false);
  assert.equal(input.down('sprint', 'mouse'), false);
  assert.ok(input.move().y > 0.99);
});

test('rumble plays a dual-rumble effect on the pad, and does nothing without one', () => {
  reset();
  assert.equal(input.rumble(0.5, 0.5, 100), false);
  const calls = [];
  pads.push({ connected: true, axes: [0, 0, 0, 0], buttons: [], vibrationActuator: { playEffect: (...a) => (calls.push(a), Promise.resolve('complete')) } });
  assert.ok(input.rumble(0.2, 0.4, 90));
  assert.deepEqual(calls[0], ['dual-rumble', { startDelay: 0, duration: 90, strongMagnitude: 0.2, weakMagnitude: 0.4 }]);
});

// ---- action buffer ------------------------------------------------------------------------------------------------
test('the action buffer keeps a press for its window, and the newest press wins', () => {
  const b = new ActionBuffer(0.2);
  b.press('light', 1.0);
  assert.ok(b.has('light', 1.15));
  assert.equal(b.has('light', 1.21), false);
  b.press('light', 2.0);
  b.press('dodge', 2.05);
  assert.equal(b.newest(['light', 'dodge'], 2.1), 'dodge');
  assert.equal(b.newest(['light'], 2.1), 'light');
  assert.ok(b.take('dodge', 2.1));
  assert.equal(b.has('dodge', 2.1), false);
  b.clear();
  assert.equal(b.newest(['light', 'dodge'], 2.1), null);
});

// ---- cancel windows (clip meta of light1 and the dodge) ---------------------------------------------------------------
const LIGHT1 = { hit: [0.13, 0.23], combo: 0.28 };
const DODGE = { cancel: 0.3, chain: 0.42 };
const st = (o = {}) => ({ stagger: 0, hitT: -1, blocking: false, attack: null, dodge: null, ...o });
const atk = (t, m = LIGHT1) => ({ t, ...m });
const ddg = (t) => ({ t, ...DODGE });

test('a dodge cancels an attack in its wind-up or recovery, never during the strike', () => {
  assert.ok(canAct('dodge', st({ attack: atk(0.05) })));
  assert.equal(canAct('dodge', st({ attack: atk(0.18) })), false);
  assert.ok(canAct('dodge', st({ attack: atk(0.24) })));
});

test('block cancels an attack only once its hit window is over', () => {
  assert.equal(canAct('block', st({ attack: atk(0.1) })), false);
  assert.equal(canAct('block', st({ attack: atk(0.2) })), false);
  assert.ok(canAct('block', st({ attack: atk(0.3) })));
});

test('a light attack comes straight out of a dodge after its travel, and chains at combo time', () => {
  assert.equal(canAct('light', st({ dodge: ddg(0.2) })), false);
  assert.ok(canAct('light', st({ dodge: ddg(0.3) })));
  assert.ok(canAct('block', st({ dodge: ddg(0.31) })));
  assert.equal(canAct('light', st({ attack: atk(0.2) })), false);
  assert.ok(canAct('light', st({ attack: atk(0.28) })));
  assert.equal(canAct('heavy', st({ attack: atk(0.5, { hit: [0.2, 0.32], combo: 0 }) })), false); // a finisher doesn't chain
  assert.equal(canAct('light', st({ blocking: true })), false);
});

test('dodges chain late, a broken guard allows nothing and a hit reaction holds briefly', () => {
  assert.equal(canAct('dodge', st({ dodge: ddg(0.35) })), false);
  assert.ok(canAct('dodge', st({ dodge: ddg(0.42) })));
  for (const k of ['dodge', 'block', 'light', 'heavy']) assert.equal(canAct(k, st({ stagger: 0.4 })), false, k);
  assert.equal(canAct('dodge', st({ hitT: 0.05 })), false);
  assert.ok(canAct('dodge', st({ hitT: 0.15 })));
  assert.equal(canAct('light', st({ hitT: 0.15 })), false);
  assert.ok(canAct('light', st({ hitT: 0.25 })));
});

// ---- sprint intent --------------------------------------------------------------------------------------------------
const run = (s, frames, input, dt = 1 / 60) => {
  let out;
  for (let i = 0; i < frames; i++) out = s.update(dt, input(i));
  return out;
};

test('hold mode: sprint while Shift is held and the player moves', () => {
  const s = new SprintControl();
  assert.ok(s.update(1 / 60, { key: true, moving: true }).sprint);
  assert.equal(s.update(1 / 60, { key: true, moving: false }).sprint, false);
  assert.equal(s.update(1 / 60, { key: false, moving: true }).sprint, false);
});

test('toggle mode: a press latches the sprint until the movement stops or Shift is pressed again', () => {
  const s = new SprintControl();
  s.mode = 'toggle';
  assert.ok(s.update(1 / 60, { keyPressed: true, key: true, moving: true }).sprint);
  assert.ok(run(s, 60, () => ({ moving: true })).sprint); // Shift released: still sprinting
  assert.ok(run(s, 6, () => ({ moving: false })).sprint === false && s.keyOn); // a reversal through neutral keeps it
  assert.ok(s.update(1 / 60, { moving: true }).sprint);
  run(s, 20, () => ({ moving: false })); // stopped
  assert.equal(s.update(1 / 60, { moving: true }).sprint, false);
  s.update(1 / 60, { keyPressed: true, moving: false }); // pressed just before moving: armed
  assert.ok(run(s, 3, () => ({ moving: true })).sprint);
  assert.equal(s.update(1 / 60, { keyPressed: true, moving: true }).sprint, false); // pressed again: off
});

test('pad L3 click toggles the sprint until the stick returns to neutral', () => {
  const s = new SprintControl();
  assert.ok(s.update(1 / 60, { padClick: true, moving: true }).sprint);
  assert.ok(run(s, 90, () => ({ moving: true })).sprint);
  run(s, 20, () => ({ moving: false }));
  assert.equal(s.update(1 / 60, { moving: true }).sprint, false);
});

test('pad dodge button: in combat a press dodges at once and holding sprints; out of combat a tap dodges on release', () => {
  const s = new SprintControl();
  let o = s.update(1 / 60, { padDodge: true, padDodgePressed: true, moving: true, combat: true });
  assert.ok(o.dodge);
  o = run(s, 40, () => ({ padDodge: true, moving: true, combat: true }));
  assert.ok(o.sprint && !o.dodge);
  assert.equal(s.update(1 / 60, { padDodge: false, moving: true, combat: true }).dodge, false); // no second dodge
  // out of combat: sprint from the press, a quick tap dodges when let go
  o = s.update(1 / 60, { padDodge: true, padDodgePressed: true, moving: true });
  assert.ok(o.sprint && !o.dodge);
  o = run(s, 5, () => ({ padDodge: true, moving: true }));
  assert.ok(s.update(1 / 60, { padDodge: false, moving: true }).dodge);
  s.update(1 / 60, { padDodge: true, padDodgePressed: true, moving: true });
  run(s, 30, () => ({ padDodge: true, moving: true }));
  assert.equal(s.update(1 / 60, { padDodge: false, moving: true }).dodge, false); // a hold was a sprint, not a dodge
  // a button still down from a menu (no press edge) is ignored
  o = run(s, 10, () => ({ padDodge: true, moving: true, combat: true }));
  assert.ok(!o.dodge && !o.sprint);
});

// ---- speeds ------------------------------------------------------------------------------------------------------
test('top speeds: sprint with the blade drawn is a slower combat sprint, the drawn run is well above the 2.1 guard speed', () => {
  assert.equal(topSpeed({ sprint: true }), SPEED.sprint);
  assert.ok(topSpeed({ drawn: true, sprint: true }) >= 4.6 && topSpeed({ drawn: true, sprint: true }) < SPEED.sprint);
  assert.ok(topSpeed({ drawn: true }) >= 3.5);
  assert.ok(topSpeed({ drawn: true, strafe: true }) > 2.1 && topSpeed({ drawn: true, strafe: 1 }) < topSpeed({ drawn: true, strafe: 0.5 }));
  assert.equal(topSpeed({ drawn: true, sprint: true, guard: true }), 2.1);
  assert.equal(topSpeed({ walk: true }), SPEED.walk);
  assert.ok(topSpeed({ sprint: true }) >= 6);
});

test('slopes: uphill slower (at most 20 %), downhill at most 5 % faster', () => {
  assert.equal(slopeFactor(0), 1);
  assert.ok(slopeFactor(0.2) < 1 && slopeFactor(0.2) > 0.85);
  assert.equal(slopeFactor(2), 0.8);
  assert.ok(slopeFactor(-0.2) > 1 && slopeFactor(-5) <= 1.05);
});

// ---- rumble wiring ------------------------------------------------------------------------------------------------
test('rumble fires on combat events involving the player, and not when vibration is off', () => {
  const calls = [];
  const bus = new EventTarget();
  const player = {}, bandit = {};
  const game = {
    player,
    settings: { vibration: true },
    input: { rumble: (...a) => calls.push(a) },
    on: (t, fn) => bus.addEventListener(t, fn),
  };
  const emit = (t, detail) => bus.dispatchEvent(new CustomEvent(t, { detail }));
  installRumble(game);
  emit('hit', { attacker: player, target: bandit, kind: 'slash' });
  emit('hit', { attacker: bandit, target: player, kind: 'slash' });
  emit('hit', { attacker: bandit, target: player, kind: 'parry' });
  emit('hit', { attacker: player, target: bandit, kind: 'kill' });
  emit('hit', { attacker: bandit, target: {}, kind: 'slash' }); // not the player's business
  emit('perfect-dodge', { actor: player });
  emit('guardbreak', { actor: player });
  assert.deepEqual(calls, [RUMBLE.dealt, RUMBLE.taken, RUMBLE.parry, RUMBLE.kill, RUMBLE.perfect, RUMBLE.guardbreak]);
  for (const [strong, weak] of calls) assert.ok(strong <= 0.7 && weak <= 0.7); // subtle
  game.settings.vibration = false;
  emit('hit', { attacker: player, target: bandit, kind: 'slash' });
  assert.equal(calls.length, 6);
});
