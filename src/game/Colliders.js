// Static 2D colliders on the XZ plane (tree trunks, lantern bases, walls, buildings) plus ground-height
// overrides (stairs, floors, platforms). Props/trees register here; actors use resolve() and groundAt().
//   colliders.addCircle(x, z, r, { tag, top })          top = height of the obstacle top (optional)
//   colliders.addBox(cx, cz, halfW, halfD, rotY, { tag, top })
//   colliders.resolve(pos, radius)  → pushes pos (Vector3-like, uses x/z) out of every overlapping collider
//   colliders.nearby(x, z, range)   → colliders whose bounds come within range (for AI/cameras)

const CELL = 16;

export class Colliders {
  constructor() {
    this.items = [];
    this.grid = new Map();
  }

  _key(ix, iz) {
    return ix * 73856093 ^ iz * 19349663;
  }

  _insert(c) {
    this.items.push(c);
    const x0 = Math.floor((c.x - c.bound) / CELL), x1 = Math.floor((c.x + c.bound) / CELL);
    const z0 = Math.floor((c.z - c.bound) / CELL), z1 = Math.floor((c.z + c.bound) / CELL);
    for (let ix = x0; ix <= x1; ix++)
      for (let iz = z0; iz <= z1; iz++) {
        const k = this._key(ix, iz);
        let cell = this.grid.get(k);
        if (!cell) this.grid.set(k, (cell = []));
        cell.push(c);
      }
    return c;
  }

  addCircle(x, z, r, opts = {}) {
    return this._insert({ type: 'circle', x, z, r, bound: r, tag: opts.tag || '', top: opts.top ?? Infinity });
  }

  addBox(cx, cz, halfW, halfD, rotY = 0, opts = {}) {
    return this._insert({
      type: 'box', x: cx, z: cz, hw: halfW, hd: halfD, cos: Math.cos(rotY), sin: Math.sin(rotY),
      bound: Math.hypot(halfW, halfD), tag: opts.tag || '', top: opts.top ?? Infinity,
    });
  }

  nearby(x, z, range = 0) {
    const out = new Set();
    const x0 = Math.floor((x - range) / CELL), x1 = Math.floor((x + range) / CELL);
    const z0 = Math.floor((z - range) / CELL), z1 = Math.floor((z + range) / CELL);
    for (let ix = x0; ix <= x1; ix++)
      for (let iz = z0; iz <= z1; iz++) {
        const cell = this.grid.get(this._key(ix, iz));
        if (cell) for (const c of cell) out.add(c);
      }
    return [...out];
  }

  // Push a circle of `radius` at pos.x/pos.z out of all colliders. `footY` lets actors step over low obstacles.
  resolve(pos, radius, footY = -Infinity) {
    let hit = false;
    for (const c of this.nearby(pos.x, pos.z, radius + 1)) {
      if (footY >= c.top - 0.35) continue;
      if (c.type === 'circle') {
        const dx = pos.x - c.x, dz = pos.z - c.z;
        const d = Math.hypot(dx, dz), min = c.r + radius;
        if (d < min) {
          if (d > 1e-5) {
            pos.x = c.x + (dx / d) * min;
            pos.z = c.z + (dz / d) * min;
          } else pos.x = c.x + min;
          hit = true;
        }
      } else {
        // box in local space
        const dx = pos.x - c.x, dz = pos.z - c.z;
        const lx = dx * c.cos - dz * c.sin, lz = dx * c.sin + dz * c.cos;
        const qx = Math.max(-c.hw, Math.min(c.hw, lx)), qz = Math.max(-c.hd, Math.min(c.hd, lz));
        let ex = lx - qx, ez = lz - qz;
        let d = Math.hypot(ex, ez);
        if (d < radius) {
          let nlx, nlz;
          if (d > 1e-5) {
            nlx = qx + (ex / d) * radius;
            nlz = qz + (ez / d) * radius;
          } else {
            // center inside the box: exit through the nearest face
            const px = c.hw - Math.abs(lx), pz = c.hd - Math.abs(lz);
            if (px < pz) { nlx = Math.sign(lx || 1) * (c.hw + radius); nlz = lz; }
            else { nlx = lx; nlz = Math.sign(lz || 1) * (c.hd + radius); }
          }
          pos.x = c.x + nlx * c.cos + nlz * c.sin;
          pos.z = c.z - nlx * c.sin + nlz * c.cos;
          hit = true;
        }
      }
    }
    return hit;
  }
}
