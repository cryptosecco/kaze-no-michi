// Tests for the player settings (src/ui/settings.js): the film letterbox on by default and written as the base, the
// one-time migration that brings the new default to players who saved before, and captures ignoring what is stored
// (run: npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- a minimal localStorage (this file runs in its own process) ---------------------------------------------------
const KEY = 'kaze.settings.v1';
const store = new Map();
let denied = false; // a private window: every access throws
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem(k) {
      if (denied) throw new Error('storage denied');
      return store.has(k) ? store.get(k) : null;
    },
    setItem(k, v) {
      if (denied) throw new Error('storage denied');
      store.set(k, String(v));
    },
  },
  configurable: true,
});
const { Settings, DEFAULTS, VERSION } = await import('../src/ui/settings.js');

const reset = () => {
  store.clear();
  denied = false;
};
const stored = () => JSON.parse(store.get(KEY));
// the parts of Game that Settings touches (the letterbox base in post.params and post.defaults, both off at boot)
const fakeGame = () => ({
  post: { params: { grain: 0.028, bw: 0, letterbox: 0 }, defaults: { letterbox: 0 } },
  input: { lookSensitivity: 1, look: () => ({ x: 0, y: 0 }) },
  quality: { name: 'low', renderScale: 1 },
  emit() {},
});
const base = (g) => [g.post.params.letterbox, g.post.defaults.letterbox];

test('the film letterbox is on by default, and the setting writes the base to the param and the defaults', () => {
  reset();
  const g = fakeGame();
  const s = new Settings(g);
  assert.equal(DEFAULTS.letterbox, true);
  assert.equal(s.get('letterbox'), true);
  s.apply('letterbox');
  assert.deepEqual(base(g), [1, 1]);
  s.set('letterbox', false);
  assert.deepEqual(base(g), [0, 0], 'the toggle in Settings still turns it off');
  s.set('letterbox', true);
  assert.deepEqual(base(g), [1, 1]);
});

test('settings saved before the change lose their letterbox once, keep everything else, and carry a version', () => {
  reset();
  store.set(KEY, JSON.stringify({ letterbox: false, grain: 1.4, master: 0.5, invertY: true, sprintMode: 'toggle' }));
  const s = new Settings(fakeGame());
  assert.equal(s.get('letterbox'), true, 'the new default applies');
  assert.deepEqual(
    [s.get('grain'), s.get('master'), s.get('invertY'), s.get('sprintMode')],
    [1.4, 0.5, true, 'toggle'],
    'the others survive'
  );
  assert.ok(!('version' in s.v), 'the version is not a setting');
  // written back at once, under the same key: no letterbox, the version, the rest
  assert.deepEqual(stored(), { grain: 1.4, master: 0.5, invertY: true, sprintMode: 'toggle', version: VERSION });
});

test('after the migration the player\'s own choice is respected, across reloads', () => {
  reset();
  store.set(KEY, JSON.stringify({ letterbox: false, master: 0.5 }));
  new Settings(fakeGame()).set('letterbox', false); // the player turns it off in Settings
  assert.deepEqual(stored(), { ...DEFAULTS, master: 0.5, letterbox: false, version: VERSION });
  for (let reload = 0; reload < 2; reload++) {
    const g = fakeGame();
    const s = new Settings(g);
    assert.equal(s.get('letterbox'), false, `still off at reload ${reload + 1}`);
    assert.equal(s.get('master'), 0.5);
    s.apply('letterbox');
    assert.deepEqual(base(g), [0, 0]);
  }
  // and a choice of "on" stays on
  const s = new Settings(fakeGame());
  s.set('letterbox', true);
  assert.equal(new Settings(fakeGame()).get('letterbox'), true);
});

test('settings stored with the version are read as they are, a saved "off" included', () => {
  reset();
  store.set(KEY, JSON.stringify({ version: VERSION, letterbox: false, grain: 0.5 }));
  const before = store.get(KEY);
  const s = new Settings(fakeGame());
  assert.equal(s.get('letterbox'), false);
  assert.equal(s.get('grain'), 0.5);
  assert.equal(store.get(KEY), before, 'nothing to migrate, nothing written');
});

test('a first run starts with the letterbox on, and its first save writes the version', () => {
  reset();
  const s = new Settings(fakeGame());
  assert.equal(s.get('letterbox'), true);
  assert.equal(store.has(KEY), false, 'loading writes nothing when nothing is stored');
  s.set('master', 0.3);
  assert.deepEqual(stored(), { ...DEFAULTS, master: 0.3, version: VERSION });
});

test('captures ignore the storage: nothing read, migrated or written, and no letterbox applied', () => {
  reset();
  store.set(KEY, JSON.stringify({ letterbox: false, master: 0.1, grain: 2 })); // an old, unversioned save
  const before = store.get(KEY);
  const g = fakeGame();
  const s = new Settings(g, { capture: true });
  assert.deepEqual(s.v, DEFAULTS, 'the defaults, whatever is stored');
  s.apply('letterbox');
  assert.deepEqual(base(g), [0, 0], 'a capture keeps the letterbox off in the param and in the defaults');
  s.set('master', 0.2);
  assert.equal(store.get(KEY), before, 'a capture never saves');
  assert.deepEqual(base(g), [0, 0]);
});

test('missing, unreadable or foreign storage falls back to the defaults, and a denied one is survivable', () => {
  for (const raw of ['{not json', 'null', '5', '"letterbox"', '']) {
    reset();
    store.set(KEY, raw);
    const s = new Settings(fakeGame());
    assert.equal(s.get('letterbox'), true, `default for ${JSON.stringify(raw)}`);
    assert.equal(s.get('master'), DEFAULTS.master);
  }
  reset();
  denied = true;
  const g = fakeGame();
  const s = new Settings(g);
  assert.equal(s.get('letterbox'), true);
  s.set('letterbox', false); // cannot be saved: the session still has it
  assert.equal(s.get('letterbox'), false);
  assert.deepEqual(base(g), [0, 0]);
});
