// Tests for the procedural tree variants (run: npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree } from '../src/world/trees/generator.js';

const VARIANTS = [
  ['maple', 1, {}], ['maple', 1.4, {}], ['ginkgo', 1, {}], ['ginkgo', 1.25, { shape: 'columnar' }],
  ['pine', 1, {}], ['cedar', 1, {}],
];
const SEEDS = [11, 23, 37];
function foliage(t) {
  const lp = t.lod0.leaves.getAttribute('position');
  const sizes = [];
  let leafTop = -Infinity;
  for (let i = 0; i + 3 < lp.count; i += 4) sizes.push(Math.hypot(lp.getX(i + 1) - lp.getX(i), lp.getY(i + 1) - lp.getY(i), lp.getZ(i + 1) - lp.getZ(i)));
  for (let i = 0; i < lp.count; i++) leafTop = Math.max(leafTop, lp.getY(i));
  const bp = t.lod0.bark.getAttribute('position');
  let barkTop = -Infinity;
  for (let i = 0; i < bp.count; i++) barkTop = Math.max(barkTop, bp.getY(i));
  return { cards: sizes.length, mean: sizes.reduce((a, b) => a + b, 0) / sizes.length, leafTop, barkTop };
}

// no bare leader or twig sticks out above the foliage (the "antenna" twigs of S5)
test('no bark above the top of the crown', () => {
  for (const [kind, big, opts] of VARIANTS)
    for (const seed of SEEDS) {
      const f = foliage(buildTree(kind, seed, big, opts));
      assert.ok(f.barkTop <= f.leafTop, `${kind} ${JSON.stringify(opts)} seed ${seed}: bark top ${f.barkTop.toFixed(2)} > leaves ${f.leafTop.toFixed(2)}`);
    }
});

// broadleaf crowns are built from many small cards (a leaf mass up close, not clumps of paper). Measured at
// generator scale 1: `big` and the instance scale enlarge the whole tree, cards included.
test('maple and ginkgo crowns use many small cards', () => {
  const CASES = [['maple', {}, 500], ['ginkgo', {}, 1500], ['ginkgo', { shape: 'columnar' }, 1500]];
  for (const [kind, opts, minCards] of CASES)
    for (const seed of SEEDS) {
      const f = foliage(buildTree(kind, seed, 1, opts));
      assert.ok(f.cards >= minCards, `${kind} ${JSON.stringify(opts)} seed ${seed}: ${f.cards} cards < ${minCards}`);
      assert.ok(f.mean <= 0.85, `${kind} ${JSON.stringify(opts)} seed ${seed}: mean card ${f.mean.toFixed(2)} m > 0.85`);
    }
});
