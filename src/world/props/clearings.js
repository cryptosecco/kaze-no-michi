// Clearings around architecture. The trees module installs before the props, so any tree standing inside
// a building footprint is removed at runtime: its forest cell entry, its far impostor (scale → 0) and its
// trunk collider. Defensive by design: if the trees module's internals differ, nothing happens.
//   clearTrees(game, [{ x, z, r }, ...]) → number of trees removed

// shapes: circles { x, z, r } or capsules { x, z, x2, z2, r } (view corridors)
export function clearTrees(game, circles) {
  const T = game.modules && game.modules.trees;
  if (!T || !circles.length) return 0;
  // preferred: the trees module's own API (also removes leaf litter from building floors)
  if (typeof T.clear === 'function') {
    try {
      return T.clear(circles);
    } catch (err) {
      console.warn('[props] trees.clear failed, falling back:', err);
    }
  }
  const inside = (x, z) =>
    circles.some((c) => {
      if (c.x2 === undefined) return (x - c.x) ** 2 + (z - c.z) ** 2 < c.r * c.r;
      const ax = c.x2 - c.x, az = c.z2 - c.z;
      const t = Math.max(0, Math.min(1, ((x - c.x) * ax + (z - c.z) * az) / (ax * ax + az * az || 1)));
      return (x - c.x - ax * t) ** 2 + (z - c.z - az * t) ** 2 < c.r * c.r;
    });
  let removed = 0;
  try {
    const f = T.forest;
    if (f && f.cells && f.x && f.z) {
      for (const [k, cell] of f.cells) {
        const keep = [];
        for (const i of cell) {
          if (inside(f.x[i], f.z[i])) removed++;
          else keep.push(i);
        }
        if (keep.length !== cell.length) f.cells.set(k, Int32Array.from(keep));
      }
      if (f._lastPos) f._lastPos.set(1e9, 1e9, 1e9); // force a rebuild on the next update
    }
  } catch (err) {
    console.warn('[props] forest clearing skipped:', err);
  }
  try {
    const imp = T.impostors;
    const attr = imp && imp.geometry && imp.geometry.getAttribute('aImpPos');
    if (attr) {
      const a = attr.array;
      for (let i = 0; i < attr.count; i++) if (inside(a[i * 4], a[i * 4 + 2])) a[i * 4 + 3] = 0;
      attr.needsUpdate = true;
    }
  } catch (err) {
    console.warn('[props] impostor clearing skipped:', err);
  }
  try {
    const C = game.colliders;
    const dead = new Set(C.items.filter((c) => c.tag === 'tree' && inside(c.x, c.z)));
    if (dead.size) {
      C.items = C.items.filter((c) => !dead.has(c));
      for (const [k, cell] of C.grid) C.grid.set(k, cell.filter((c) => !dead.has(c)));
    }
  } catch (err) {
    console.warn('[props] collider clearing skipped:', err);
  }
  return removed;
}

// Is (x, z) free of tree trunks within r (uses the trees module's public API when present)?
export function freeOfTrees(game, x, z, r) {
  const T = game.modules && game.modules.trees;
  if (!T || typeof T.nearest !== 'function') return true;
  return T.nearest(x, z, r + 1.5).every((t) => t.d > r + Math.min(t.radius * 0.35, 1.2));
}
