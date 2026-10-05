// Tests for the menu navigation (run: npm test): the gamepad polling of the real Nav class: Start opens the pause once and a
// second Start closes it, a button or a direction that is already held when a menu appears is not a fresh press, and a held
// direction repeats after 420 ms and then every 120 ms. The keyboard path is pinned too. Stand-ins for window and the pad.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = new EventTarget(); // Nav listens for keydown on it
const { Nav } = await import('../src/ui/menu.js');

// pad buttons: A is `select`, B `back`, Start (9) is `back` for a screen and opens the pause when none has the pad
const A = 0, B = 1, START = 9, UP = 12;

function rig(step = 16) {
  const input = { pad: { connected: true, lx: 0, ly: 0 }, padButtons: new Set() };
  const nav = new Nav({ emit() {} });
  const r = { input, nav, now: 0, open: false, log: [] };
  // what src/ui/Pause.js keeps on the stack while the pause is up: back (Esc, B, Start) closes it, and so does select on
  // the entry that is focused when it opens, Resume
  r.pause = {
    nav: (a) => {
      r.log.push(a);
      if (a === 'back' || a === 'select') r.close();
    },
  };
  r.openPause = () => {
    r.open = true;
    nav.push(r.pause);
  };
  r.close = () => {
    r.open = false;
    nav.pop(r.pause);
  };
  // one rendered frame, as UI.frame() runs it (src/ui/index.js): Nav polls the pad for the screens, and a Start that no
  // screen had the pad for opens the pause (the game's own checks, in play and not busy, need no stand-in here)
  r.frame = (...held) => {
    input.padButtons = new Set(held);
    r.now += step;
    if (nav.poll(input, r.now)) r.openPause();
  };
  r.frames = (n, ...held) => {
    for (let i = 0; i < n; i++) r.frame(...held);
  };
  return r;
}

// ---------------------------------------------------------------------------------------------------- Start
test('Start opens the pause once, and it stays open while Start is held and after it is let go', () => {
  const r = rig();
  r.frames(2);
  r.frames(8, START); // a press lasts ~100 ms
  assert.equal(r.open, true, 'the pause is open while Start is still down');
  assert.deepEqual(r.log, [], 'and nothing read the press as back');
  r.frames(3);
  assert.equal(r.open, true, 'and after it is let go');
});

test('Start with the pause open closes it; it stays closed while Start is held, and the next press opens it', () => {
  const r = rig();
  r.frames(1, START);
  r.frames(5, START);
  r.frames(3);
  assert.equal(r.open, true);
  r.frames(1, START);
  assert.equal(r.open, false, 'the second press closes it');
  r.frames(12, START);
  assert.equal(r.open, false, 'it does not open again while Start is held');
  assert.deepEqual(r.log, ['back'], 'one back for the press');
  r.frames(3);
  assert.equal(r.open, false);
  r.frames(1, START);
  assert.equal(r.open, true, 'the next press opens it');
  r.frames(6, START);
  r.frames(3);
  assert.equal(r.open, true);
  r.frames(1, START);
  assert.equal(r.open, false, 'and the one after closes it again');
});

test('B inside the pause goes back, once per press, and does not open it again', () => {
  const r = rig();
  r.frames(1, START);
  r.frames(3);
  assert.equal(r.open, true);
  r.frames(8, B);
  assert.equal(r.open, false, 'B closes it');
  assert.deepEqual(r.log, ['back']);
  assert.equal(r.nav.top(), null);
  r.frames(3);
  assert.equal(r.open, false, 'and B opens nothing');
});

test('Start still held when the pause is closed another way (A on Resume) does not open it again', () => {
  const r = rig();
  r.frames(1, START);
  r.frames(2, START);
  assert.equal(r.open, true);
  r.frames(1, START, A); // A goes down while Start is still down
  assert.equal(r.open, false, 'Resume closed it');
  assert.deepEqual(r.log, ['select']);
  r.frames(6, START);
  assert.equal(r.open, false, 'Start was held, not pressed: no new pause');
  r.frames(3);
  r.frames(1, START);
  assert.equal(r.open, true, 'a press opens it');
});

test('Start inside a panel of the pause goes back one level; the next Start closes the pause', () => {
  const r = rig();
  r.frames(1, START);
  r.frames(3);
  const panel = { nav: (a) => a === 'back' && r.nav.pop(panel) }; // the settings: back closes the panel
  r.nav.push(panel);
  r.frames(1, START);
  assert.equal(r.nav.top(), r.pause, 'the panel is closed');
  assert.equal(r.open, true, 'the pause is still up');
  r.frames(6, START);
  r.frames(3);
  r.frames(1, START);
  assert.equal(r.open, false, 'the next press closes the pause');
  r.frames(5, START);
  assert.equal(r.open, false);
});

test('a Start that a screen took (a card that closes itself on back) does not open the pause on the same press', () => {
  const r = rig();
  const card = { nav: (a) => a === 'back' && r.nav.pop(card) };
  r.nav.push(card);
  r.frames(1, START);
  assert.equal(r.nav.top(), null, 'the card read it as back and closed');
  r.frames(8, START);
  assert.equal(r.open, false, 'no pause from that press');
  r.frames(3);
  r.frames(1, START);
  assert.equal(r.open, true, 'the next one opens it');
});

test('without a pad nothing is read and nothing opens', () => {
  const r = rig();
  r.input.pad.connected = false;
  const seen = [];
  r.nav.push({ nav: (a) => seen.push(a) });
  r.frames(5, START, A);
  assert.deepEqual(seen, []);
  assert.equal(r.open, false);
});

// ---------------------------------------------------------------------------------------------------- held when a menu appears
test('a button held down when a handler is pushed is not a press (A held while a card appears does not pick its first entry)', () => {
  const r = rig();
  const seen = [];
  r.frames(5, A); // played with A down, nothing on the stack
  r.nav.push({ nav: (a) => seen.push(a) }); // a menu appears under the thumb
  r.frames(5, A);
  assert.deepEqual(seen, [], 'the held A did not select');
  r.frames(2);
  r.frames(1, A);
  assert.deepEqual(seen, ['select'], 'a new press does');
});

test('a direction held when a menu appears is not a press: it does not move the focus or repeat, with no repeat time yet', () => {
  const r = rig(1);
  const seen = [];
  r.input.pad.ly = -1; // the stick forward, walking
  r.frames(100);
  r.nav.push({ nav: (a) => seen.push([a, r.now]) });
  r.frames(2000);
  assert.deepEqual(seen, [], 'held since before: nothing, however long');
  r.input.pad.ly = 0;
  r.frames(20);
  r.input.pad.ly = -1;
  r.frames(5);
  assert.deepEqual(seen.map(([a]) => a), ['up'], 'let go and pushed again it is a press');
});

test('a direction held when a menu appears is not a press either when an earlier menu left a repeat time behind', () => {
  const r = rig(1);
  const seen = [];
  const menu = { nav: (a) => seen.push([a, r.now]) };
  // a d-pad up pressed in an earlier menu: its repeat time stays
  r.nav.push(menu);
  r.frames(50, UP);
  r.frames(20);
  assert.deepEqual(seen.map(([a]) => a), ['up'], 'one press, let go before it could repeat');
  r.frames(1500); // long past the repeat time
  r.nav.pop(menu);
  seen.length = 0;
  // the stick forward held while the next menu appears (the live case: Start opens the pause with the stick pushed)
  r.input.pad.ly = -1;
  r.frames(1, START);
  assert.equal(r.open, true, 'Start opened the pause');
  r.frames(2000);
  assert.deepEqual(r.log, [], 'the held stick did not move the pause menu, now or later');
  r.input.pad.ly = 0;
  r.frames(20);
  r.input.pad.ly = -1;
  r.frames(5);
  assert.deepEqual(r.log, ['up'], 'let go and pushed again: one press');
});

test('the d-pad held when a menu appears is not a press either', () => {
  const r = rig(1);
  const seen = [];
  const early = { nav: (a) => seen.push(a) };
  r.nav.push(early);
  r.frames(30, UP);
  r.frames(1500);
  r.nav.pop(early);
  seen.length = 0;
  r.frames(40, UP); // held with nothing listening
  r.nav.push(early);
  r.frames(2000, UP);
  assert.deepEqual(seen, []);
});

// ---------------------------------------------------------------------------------------------------- repeat
test('a direction held in a menu moves at once, repeats after 420 ms and then every 120 ms', () => {
  const cases = {
    'the stick': (r) => {
      r.input.pad.ly = 1; // pushed down and held
      r.frames(1600);
    },
    'the d-pad': (r) => r.frames(1600, 13), // down
  };
  for (const [what, hold] of Object.entries(cases)) {
    const r = rig(1); // frames of 1 ms: the times are exact to the millisecond
    const moves = [];
    r.nav.push({ nav: (a) => moves.push([a, r.now]) });
    r.frames(5);
    hold(r);
    assert.ok(moves.length >= 10, `${what}: ${moves.length} moves`);
    assert.ok(moves.every(([a]) => a === 'down'), `${what}: always down`);
    const at = moves.map(([, t]) => t);
    assert.equal(at[0], 6, `${what}: the first move is on the frame of the press`);
    const gaps = at.slice(1).map((t, i) => t - at[i]);
    assert.ok(gaps[0] >= 420 && gaps[0] <= 421, `${what}: the first repeat comes after the 420 ms delay (${gaps[0]})`);
    for (const g of gaps.slice(1)) assert.ok(g >= 120 && g <= 121, `${what}: then every 120 ms (${g})`);
  }
});

test('a direction let go before the delay does not repeat, and left/right repeat like up/down while select and back never do', () => {
  const r = rig(1);
  const moves = [];
  r.nav.push({ nav: (a) => moves.push(a) });
  r.frames(5);
  r.frames(400, 14); // the d-pad left, let go at 400 ms
  r.frames(600);
  assert.deepEqual(moves, ['left']);
  moves.length = 0;
  r.frames(1000, A);
  assert.deepEqual(moves, ['select'], 'a held A is one select');
  moves.length = 0;
  r.frames(1000, B);
  assert.deepEqual(moves, ['back'], 'a held B is one back');
  moves.length = 0;
  r.frames(1000, 15); // right
  assert.ok(moves.length > 5 && moves.every((a) => a === 'right'));
});

// ---------------------------------------------------------------------------------------------------- keyboard
test('the keyboard: Esc, Backspace and the arrows go to the top screen, held Esc or Enter is one press, no screen no swallow', () => {
  globalThis.window = new EventTarget(); // a window of this test's own: Nav listens on it from here on
  const nav = new Nav({ emit() {} });
  const seen = [];
  const key = (code, extra = {}) => {
    const e = Object.assign(new Event('keydown', { cancelable: true }), { code, repeat: false, ...extra });
    window.dispatchEvent(e);
    return e;
  };
  let e = key('Escape');
  assert.equal(e.defaultPrevented, false, 'with no screen the key is left to the game');
  nav.push({ nav: (a) => seen.push(a) });
  e = key('Escape');
  assert.equal(e.defaultPrevented, true);
  key('Backspace');
  key('ArrowUp');
  key('KeyS');
  key('ArrowLeft');
  key('Enter');
  key('Space');
  assert.deepEqual(seen, ['back', 'back', 'up', 'down', 'left', 'select', 'select']);
  seen.length = 0;
  key('Escape', { repeat: true });
  key('Enter', { repeat: true });
  assert.deepEqual(seen, [], 'a held Esc or Enter is one press');
  key('ArrowDown', { repeat: true });
  assert.deepEqual(seen, ['down'], 'a held arrow repeats');
  e = key('KeyQ');
  assert.equal(e.defaultPrevented, false, 'a key that means nothing to a screen goes on to the game');
});
