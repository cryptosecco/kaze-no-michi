import * as THREE from 'three';
import { POI } from '../Layout.js';
import { Builder, box, rbox, cylinder, sweep, boulder, mat, mul, rng, setFlag, shadeLocal } from './geom.js';
import { addTorii, addLantern } from './torii.js';
import { buildRoof } from './roof.js';
import { buildGateHall } from './gatehall.js';

// Shrine hill (S2_shrine, and the summit silhouette of S1_field):
//   entrance plaza with a great torii → four broad flights of weathered stone steps with landings, framed by
//   mossy curb walls carrying small votive torii and stone lanterns → summit: a dark-timber gate hall with a
//   karahafu gable and a shimenawa right at the top of the stairs, a vermilion nagare-zukuri honden,
//   a purification pavilion, and a lone "sky torii" on the north-west rim facing the field.

const STEP_R = 0.19; // nominal riser (m)
const HALF_W = POI.shrine.stairHalf; // half width of the steps (a broad flight; the terrain carves for it)
const WALL_W = 0.62; // curb wall width
const WALL_H = 0.55; // curb height above the nosing line
const LANDING = 2.4;

// Where the sky torii stands: on the summit rim beside the setting sun as seen from the field
// shot. Stand beside the sun disc (the glare swallows anything on it) and away from the approach axis where the gate
// hall and honden stand: try bearings a few degrees off the sun, keep the first rim point that is clear of the
// approach, placed where the bearing enters the plateau (the whole torii on the skyline). Pure: the S2 hero test
// (scripts/shrine.test.mjs) checks the trees against the sight line to this spot.
export function skyToriiSpot({ viewer = { x: 150, z: 90 }, sunAz = 255, sunOffsets = [6, 6.5, 5.5, 7, 5, -5, -6] } = {}) {
  const SH = POI.shrine, u = SH.stairDir;
  const rimR = SH.topRadius - 3;
  const axisDist = (p) => Math.abs((p.x - SH.x) * u.z - (p.z - SH.z) * u.x);
  const rimPoint = (az) => {
    const ray = { x: Math.sin((az * Math.PI) / 180), z: -Math.cos((az * Math.PI) / 180) };
    const tC = (SH.x - viewer.x) * ray.x + (SH.z - viewer.z) * ray.z;
    const foot = { x: viewer.x + ray.x * tC, z: viewer.z + ray.z * tC };
    const perp = Math.hypot(foot.x - SH.x, foot.z - SH.z);
    if (perp < rimR) {
      const tIn = tC - Math.sqrt(rimR * rimR - perp * perp);
      return { x: viewer.x + ray.x * tIn, z: viewer.z + ray.z * tIn };
    }
    const ol = perp || 1;
    return { x: SH.x + ((foot.x - SH.x) / ol) * rimR, z: SH.z + ((foot.z - SH.z) / ol) * rimR };
  };
  for (const off of sunOffsets) {
    const p = rimPoint(sunAz + off);
    if (axisDist(p) > 13) return p;
  }
  return rimPoint(sunAz + 6);
}

export function buildShrineHill(game, mats, opts = {}) {
  const terrain = game.terrain;
  const SH = POI.shrine;
  const u = { x: SH.stairDir.x, z: SH.stairDir.z }; // uphill
  const X = { x: u.z, z: -u.x }; // local +x of frame() for forward u
  const B = SH.stairsBase;
  const L = Math.hypot(SH.stairsTop.x - B.x, SH.stairsTop.z - B.z);
  const P = (s, lat) => ({ x: B.x + u.x * s + X.x * lat, z: B.z + u.z * s + X.z * lat });
  const H = (s, lat = 0) => {
    const p = P(s, lat);
    return terrain.heightAt(p.x, p.z);
  };
  const ramp = (s) => H(s, 0);
  const summitY = terrain.heightAt(SH.x, SH.z);
  const yawFrame = (s, lat, y) => {
    const p = P(s, lat);
    return new THREE.Matrix4().multiplyMatrices(
      new THREE.Matrix4().makeTranslation(p.x, y, p.z),
      new THREE.Matrix4().makeRotationY(Math.atan2(u.x, u.z))
    );
  };

  const b = new Builder('shrine-hill');
  const rnd = rng(4242);
  const info = { steps: [], torii: [], lanterns: [] };

  // Stair profile: 4 flights, 3 landings. Each flight+landing cycle climbs exactly what the terrain ramp
  // climbs over the same run, so the stone profile never dips under the ground; +lift covers the gently
  // raised corridor sides.
  const s0 = -0.6;
  const sTop = L + 0.4;
  const plazaY = ramp(-0.6) + 0.06; // foot of the first step
  const lift = 0.42;
  const topY = summitY + 0.3;
  const land = [];
  const flights = 4;
  const flightRun = (sTop - s0 - LANDING * (flights - 1)) / flights;
  let s = s0;
  let y = plazaY;
  const steps = []; // { s0, s1, y }
  const wallSegs = []; // { s0, y0, s1, y1 }
  for (let f = 0; f < flights; f++) {
    const sa = s, sb = s + flightRun;
    const last = f === flights - 1;
    const yb = last ? topY : ramp(sb + LANDING) + lift;
    const n = Math.max(4, Math.round((yb - y) / STEP_R));
    const t = (sb - sa) / n;
    const r = (yb - y) / n;
    const ya = y;
    for (let k = 0; k < n; k++) {
      const jitter = (rnd() - 0.5) * 0.02;
      steps.push({ s0: sa + k * t, s1: sa + (k + 1) * t + (k === n - 1 && !last ? 0 : 0.02), y: ya + (k + 1) * r + (k < n - 1 ? jitter : 0), riser: r });
    }
    wallSegs.push({ s0: sa, y0: ya, s1: sb, y1: yb });
    y = yb;
    s = sb;
    if (!last) {
      land.push({ s0: s, s1: s + LANDING, y });
      wallSegs.push({ s0: s, y0: y, s1: s + LANDING, y1: y });
      s += LANDING;
    }
  }
  info.steps = steps;
  info.landings = land;

  // fallen maple/ginkgo leaves lying on the stone (4-cell atlas, flat quads)
  const leafAt = (ss, lat, yy) => {
    const cell = Math.floor(rnd() * 4);
    const sz = 0.09 + rnd() * 0.07;
    const g = new THREE.PlaneGeometry(sz, sz);
    const uv = g.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (cell % 2 + uv.getX(i)) / 2, (Math.floor(cell / 2) + uv.getY(i)) / 2);
    b.add('leaves', g, mul(yawFrame(ss, lat, yy), mat(0, 0, 0, -Math.PI / 2 + (rnd() - 0.5) * 0.3, rnd() * 6.28, (rnd() - 0.5) * 0.3)), {});
  };

  // stone treads: 3–5 stones per step, block reaching into the ground below the nosing
  const stoneGround = (sa, sb) => Math.min(ramp(sa), ramp(sb), H(sa, -HALF_W), H(sa, HALF_W));
  for (const st of steps) {
    const depth = st.y - stoneGround(st.s0, st.s1) + 0.35;
    let x = -HALF_W;
    const cuts = 3 + Math.floor(rnd() * 3);
    const widths = [];
    for (let k = 0; k < cuts; k++) widths.push(0.6 + rnd());
    const sum = widths.reduce((a, c) => a + c, 0);
    for (const wv of widths) {
      const wd = (wv / sum) * HALF_W * 2;
      const tilt = (rnd() - 0.5) * 0.012;
      const zh = (st.s1 - st.s0 + 0.04) / 2;
      const g = rbox(wd - 0.03, depth, zh * 2, { r: 0.045, grain: 'x', uv: 1 });
      // baked AO: shaded riser, dark crevice at the back of the tread, worn bright nosing, buried body
      const top = depth / 2;
      shadeLocal(g, (lx, ly, lz, nx, ny, nz) => {
        if (ly < top - 0.4) return 0.4;
        if (ny > 0.6) {
          if (lz > zh - 0.07) return 0.5;
          if (lz < -zh + 0.12) return 1.14;
          return 1.0 + 0.06 * Math.cos((lx / (wd * 0.5)) * 1.4); // worn, paler centre line
        }
        if (nz < -0.6) return 0.62 - 0.18 * Math.min(1, (top - ly) / 0.35);
        if (Math.abs(nx) > 0.6) return 0.55;
        return 0.8;
      });
      const Mw = mul(yawFrame((st.s0 + st.s1) / 2 - 0.02, x + wd / 2, st.y - depth / 2 + (rnd() - 0.5) * 0.012), mat(0, 0, 0, tilt, 0, (rnd() - 0.5) * 0.01));
      b.add(rnd() < 0.1 ? 'stoneMossy' : 'stoneStep', g, Mw, { ground: st.y - 3, grimeH: 0.3, jitter: 0.2, seed: rnd() * 1e5 });
      x += wd;
    }
    // a few fallen leaves on the tread (denser toward the curbs, where they gather)
    const nLeaves = rnd() < 0.55 ? 1 + Math.floor(rnd() * 3) : 0;
    for (let k = 0; k < nLeaves; k++) {
      const side = rnd() < 0.5 ? -1 : 1;
      const lat = side * HALF_W * Math.pow(rnd(), 0.45) * 0.95;
      const ss = st.s0 + (st.s1 - st.s0) * (0.25 + rnd() * 0.6);
      leafAt(ss, lat, st.y + 0.008 + rnd() * 0.004);
    }
  }
  // landings: large flagstones, three across
  for (const l of land) {
    const depth = l.y - stoneGround(l.s0, l.s1) + 0.5;
    const n = 3;
    const fw = (HALF_W * 2) / 3;
    for (let k = 0; k < n; k++) {
      const len = (l.s1 - l.s0) / n;
      for (const col of [-1, 0, 1]) {
        const g = rbox(fw - 0.03, depth, len - 0.03, { r: 0.05, grain: 'z', uv: 1 });
        shadeLocal(g, (lx, ly, lz, nx, ny) => (ly < depth / 2 - 0.3 ? 0.45 : ny > 0.6 ? 1 : 0.6));
        b.add('stoneStep', g, yawFrame(l.s0 + len * (k + 0.5), col * fw, l.y - depth / 2 + (rnd() - 0.5) * 0.01), { ground: l.y - 3, grimeH: 0.3, jitter: 0.16, seed: k * 7 + col });
      }
    }
    for (let k = 0; k < 7; k++) leafAt(l.s0 + rnd() * (l.s1 - l.s0), (rnd() < 0.5 ? -1 : 1) * HALF_W * Math.pow(rnd(), 0.4) * 0.95, l.y + 0.008 + rnd() * 0.004);
  }

  // curb walls: sloped slabs following each flight / flat on landings, with coping stones
  const wallLat = HALF_W + WALL_W / 2;
  for (const seg of wallSegs) {
    const len = seg.s1 - seg.s0;
    const ang = Math.atan2(seg.y1 - seg.y0, len);
    const midS = (seg.s0 + seg.s1) / 2;
    const midY = (seg.y0 + seg.y1) / 2 + WALL_H;
    for (const side of [-1, 1]) {
      const lat = side * wallLat;
      const low = Math.min(H(seg.s0, lat), H(seg.s1, lat), seg.y0) - 0.6;
      const hgt = midY - low + 0.2;
      const g = box(WALL_W, hgt, Math.hypot(len, seg.y1 - seg.y0) + 0.1, { grain: 'z', uv: 1 });
      // shear the slab into a parallelogram so its top follows the flight and its bottom stays level-ish
      const p = g.getAttribute('position');
      for (let i = 0; i < p.count; i++) {
        const zz = p.getZ(i);
        p.setY(i, p.getY(i) + Math.tan(ang) * zz);
      }
      g.computeVertexNormals();
      b.add('stoneMossy', g, yawFrame(midS, lat, midY - hgt / 2 + 0.1), { ground: low + 0.6, grimeH: 1.2, seed: seg.s0 * 13 + side });
      // coping stones every ~1.6 m
      const nC = Math.max(1, Math.round(len / 1.6));
      for (let k = 0; k < nC; k++) {
        const ss = seg.s0 + (len * (k + 0.5)) / nC;
        const yy = seg.y0 + ((seg.y1 - seg.y0) * (ss - seg.s0)) / len + WALL_H + 0.1;
        const c = rbox(WALL_W + 0.1, 0.18, len / nC - 0.05, { r: 0.04, grain: 'z' });
        b.add('stone', c, mul(yawFrame(ss, lat, yy + 0.02), mat(0, 0, 0, -ang, 0, 0)), { ground: yy - 1, seed: k + side * 100 });
      }
      game.colliders.addBox(P(midS, lat).x, P(midS, lat).z, WALL_W / 2, len / 2, Math.atan2(u.x, u.z), { tag: 'wall', top: Math.max(seg.y0, seg.y1) + WALL_H });
    }
  }
  // mossy boulders half sunk into the banks beside the middle flights (dark, rocky slopes under the forest)
  const brnd = rng(777);
  for (let k = 0; k < 14; k++) {
    const side = k % 2 ? 1 : -1;
    const ss = 16 + brnd() * 40;
    const lat = side * (HALF_W + WALL_W + 1.4 + brnd() * 6.5);
    const bp = P(ss, lat);
    const gy = terrain.heightAt(bp.x, bp.z);
    const r = 0.5 + brnd() * 0.9;
    b.add('stoneMossy', boulder(r, 900 + k, { squash: 0.6 }), mul(new THREE.Matrix4().makeTranslation(bp.x, gy - r * 0.25, bp.z), mat(0, 0, 0, 0, brnd() * 6.28, 0)), { ground: gy, grimeH: 0.3, seed: 900 + k });
    game.colliders.addCircle(bp.x, bp.z, r * 0.8, { tag: 'rock', top: gy + r * 0.45 });
  }
  const wallTopAt = (ss) => {
    for (const seg of wallSegs) if (ss >= seg.s0 && ss <= seg.s1) return seg.y0 + ((seg.y1 - seg.y0) * (ss - seg.s0)) / (seg.s1 - seg.s0) + WALL_H + 0.18;
    return ss < s0 ? plazaY + WALL_H : topY + WALL_H;
  };

  // entrance plaza paving: flagstones laid on the (sloping) ground
  const plazaHalf = Math.round((HALF_W + WALL_W) / 1.6);
  for (let k = 0; k < 5; k++) {
    for (let j = -plazaHalf; j <= plazaHalf; j++) {
      const ss = -7.2 + k * 1.3;
      const g = box(1.55, 0.5, 1.26, { grain: 'x' });
      const gy = Math.max(H(ss - 0.6, j * 1.6), H(ss + 0.6, j * 1.6));
      b.add('stone', g, yawFrame(ss, j * 1.6, gy + 0.05 - 0.25 + (rnd() - 0.5) * 0.02), { ground: gy - 1, grimeH: 0.2, seed: k * 5 + j });
    }
  }

  // torii: the great entrance torii at the plaza, its pillars outside the curbs; then small votive torii and
  // stone lanterns standing on the curbs, alternating along every flight and staggered between the two sides, so
  // that seen up the stairs they rise one above the other instead of piling up in a tangle
  const bigLat = wallLat + WALL_W / 2 + 0.5;
  const bigY = Math.min(H(-4.4, -bigLat), H(-4.4, bigLat)) + 0.02;
  const bigT = addTorii(b, yawFrame(-4.4, 0, bigY), { span: bigLat * 2, height: 10.2, groundY: bigY, seed: 1, baseDepth: 0.6 });
  info.torii.push({ s: -4.4, ...P(-4.4, 0), span: bigT.span, lat: 0, y: bigY, height: bigT.height, pillarR: bigT.pillarR });
  let vi = 0;
  const curbLantern = (ss, lat) => {
    const gy = wallTopAt(ss) - 0.05;
    const lt = addLantern(b, yawFrame(ss, lat, gy), { scale: 0.62, groundY: gy, seed: Math.round(ss * 10 + lat) });
    info.lanterns.push({ ...P(ss, lat), y: gy, top: gy + lt.height });
  };
  for (let f = 0; f < flights; f++) {
    const seg = wallSegs[f * 2];
    for (const sd of [-1, 1]) {
      const off = sd > 0 ? 0 : 0.12; // the right curb's rhythm is shifted a little up the flight
      for (const k of [0.3, 0.78]) {
        const ss = seg.s0 + (seg.s1 - seg.s0) * (k + off);
        const gy = wallTopAt(ss) - 0.04;
        const t = addTorii(b, yawFrame(ss, sd * wallLat, gy), { span: 0.6, height: 1.7 - (vi % 3) * 0.08, groundY: gy, seed: 10 + vi, baseDepth: 0.05, plaque: false, pillarR: 0.055 });
        info.torii.push({ s: ss, ...P(ss, sd * wallLat), span: t.span, lat: sd * wallLat });
        vi++;
      }
      for (const k of [0.08, 0.54]) curbLantern(seg.s0 + (seg.s1 - seg.s0) * (k + off), sd * wallLat);
    }
  }
  for (const t of info.torii) {
    for (const sd of [-1, 1]) {
      const pp = P(t.s, t.lat + (sd * t.span) / 2);
      // votive torii stand on the curbs: a pillar-sized collider, so the tread next to them stays walkable
      game.colliders.addCircle(pp.x, pp.z, t.span > 3 ? 0.42 : 0.07, { tag: 'torii' });
    }
  }

  // lanterns: plaza pair outside the curbs (the curb lanterns above need no collider: the walls block)
  const lanternAt = (ss, lat, scale = 1, ry = 0) => {
    const p = P(ss, lat);
    const gy = terrain.heightAt(p.x, p.z);
    const lt = addLantern(b, mul(yawFrame(ss, lat, gy), mat(0, 0, 0, 0, ry, 0)), { scale, groundY: gy, seed: Math.round(ss * 10 + lat) });
    game.colliders.addCircle(p.x, p.z, 0.45 * scale, { tag: 'lantern', top: gy + lt.height });
    info.lanterns.push({ ...p, y: gy });
  };
  for (const sd of [-1, 1]) lanternAt(-6.4, sd * (bigLat + 1.4), 1.05);

  // summit: top platform, gate hall (rōmon), honden, chōzuya, sky torii
  const platLen = 3.6;
  const platHalf = Math.round((HALF_W + WALL_W) / 1.5);
  for (let k = 0; k < 3; k++)
    for (let j = -platHalf; j <= platHalf; j++) {
      const ss = sTop + 0.6 + k * 1.2;
      const g = box(1.48, 0.9, 1.18, { grain: 'x' });
      b.add('stone', g, yawFrame(ss, j * 1.5, topY - 0.45 + (rnd() - 0.5) * 0.01), { ground: topY - 0.3, grimeH: 0.3, seed: 300 + k * 5 + j });
    }
  const gateS = sTop + 5.6;
  const gateC = P(gateS, 0);
  const gateM = yawFrame(gateS, 0, summitY);
  const gate = buildGateHall(b, gateM, { groundY: summitY, rnd });
  // gate hall colliders: side bays blocked, central passage open
  for (const sx of [-1, 1]) {
    const p = P(gateS, sx * 3.5);
    game.colliders.addBox(p.x, p.z, 1.7, 3.1, Math.atan2(u.x, u.z), { tag: 'gate' });
  }
  for (const lat of [-5.2, -1.8, 1.8, 5.2]) for (const dz of [-3, 3]) {
    const p = P(gateS + dz, lat);
    game.colliders.addCircle(p.x, p.z, 0.26, { tag: 'post' });
  }
  // top platform lanterns flanking the gate
  for (const sd of [-1, 1]) {
    const ss = sTop + 1.2, lat = sd * (HALF_W + 2.6);
    const p = P(ss, lat);
    const lt = addLantern(b, yawFrame(ss, lat, summitY), { scale: 1.15, groundY: summitY, seed: 77 + sd });
    game.colliders.addCircle(p.x, p.z, 0.55, { tag: 'lantern', top: summitY + lt.height });
  }

  // honden beyond the gate, facing it
  const hondenS = gateS + 15.5;
  const hondenM = yawFrame(hondenS, 0, summitY); // front (local −z) faces the gate
  buildHonden(b, hondenM, { groundY: summitY, rnd });
  const hp = P(hondenS, 0);
  game.colliders.addBox(hp.x, hp.z, 4.2, 3.4, Math.atan2(u.x, u.z), { tag: 'honden' });
  // approach path (sandō) flagstones between gate and honden + lantern pairs
  for (let k = 0; k < 7; k++) {
    const ss = gateS + 3.6 + k * 1.3;
    const g = box(2.2, 0.3, 1.1, { grain: 'x' });
    b.add('stone', g, yawFrame(ss, 0, summitY - 0.12 + (rnd() - 0.5) * 0.02), { ground: summitY, grimeH: 0.2, seed: 500 + k });
  }
  for (const ss of [gateS + 6, gateS + 11]) for (const sd of [-1, 1]) {
    const p = P(ss, sd * 2.6);
    const gy = terrain.heightAt(p.x, p.z);
    const lt = addLantern(b, yawFrame(ss, sd * 2.6, gy), { scale: 0.85, groundY: gy, seed: Math.round(ss) + sd });
    game.colliders.addCircle(p.x, p.z, 0.4, { tag: 'lantern', top: gy + lt.height });
  }
  // chōzuya (purification basin pavilion) to the side of the approach
  const chozuS = gateS + 7.5, chozuLat = -6.2;
  buildChozuya(b, yawFrame(chozuS, chozuLat, terrain.heightAt(P(chozuS, chozuLat).x, P(chozuS, chozuLat).z)), { groundY: summitY });
  const cp = P(chozuS, chozuLat);
  game.colliders.addBox(cp.x, cp.z, 1.3, 1.0, Math.atan2(u.x, u.z), { tag: 'chozuya' });

  // sky torii on the summit rim where the setting sun stands behind it as seen from the field shot
  const viewer = opts.viewer || { x: 150, z: 90 };
  const skyP = skyToriiSpot(opts);
  const toV = { x: skyP.x - viewer.x, z: skyP.z - viewer.z };
  const lv = Math.hypot(toV.x, toV.z);
  const f = { x: toV.x / lv, z: toV.z / lv }; // through-axis: from the viewer toward the torii
  const right = { x: -f.z, z: f.x };
  const skyY = terrain.heightAt(skyP.x, skyP.z);
  const skyM = new THREE.Matrix4().multiplyMatrices(
    new THREE.Matrix4().makeTranslation(skyP.x, skyY, skyP.z),
    new THREE.Matrix4().makeRotationY(Math.atan2(f.x, f.z))
  );
  const sky = addTorii(b, skyM, { span: 7.4, height: 10.6, groundY: skyY, seed: 99, baseDepth: 0.5 });
  for (const sd of [-1, 1]) game.colliders.addCircle(skyP.x + right.x * sd * 3.7, skyP.z + right.z * sd * 3.7, 0.5, { tag: 'torii' });
  info.skyTorii = { ...skyP, y: skyY, facing: f, span: sky.span, height: sky.height, pillarR: sky.pillarR };
  // a mossy lantern and a flat meditation stone beside it (quest: contemplation spot)
  const lp = { x: skyP.x + right.x * 5.6 + f.x * 2.5, z: skyP.z + right.z * 5.6 + f.z * 2.5 };
  const lgy = terrain.heightAt(lp.x, lp.z);
  addLantern(b, new THREE.Matrix4().makeTranslation(lp.x, lgy, lp.z), { scale: 1.05, groundY: lgy, seed: 5 });
  game.colliders.addCircle(lp.x, lp.z, 0.45, { tag: 'lantern' });
  const sp = { x: skyP.x + f.x * 4.2, z: skyP.z + f.z * 4.2 };
  const sgy = terrain.heightAt(sp.x, sp.z);
  b.add('stoneMossy', box(1.6, 0.7, 0.9, { grain: 'x' }), mul(new THREE.Matrix4().makeTranslation(sp.x, sgy - 0.1, sp.z), mat(0, 0, 0, 0.03, Math.atan2(f.x, f.z), 0.02)), { ground: sgy, grimeH: 0.3, seed: 8 });
  // sitting on the stone, looking out through the sky torii over the field (sun behind the shoulder)
  info.meditation = { x: sp.x, y: sgy + 0.25, z: sp.z, facing: { x: -f.x, z: -f.z } };

  // walkable ground: stairs (smooth line through the tread centres), landings, plaza, top platform
  const treadS = steps.map((st) => (st.s0 + st.s1) / 2);
  const treadY = steps.map((st) => st.y);
  const inv = (x, z) => {
    const dx = x - B.x, dz = z - B.z;
    return { s: dx * u.x + dz * u.z, lat: dx * X.x + dz * X.z };
  };
  game.addGroundOverride((x, z) => {
    const { s: ss, lat } = inv(x, z);
    if (Math.abs(lat) > HALF_W + 0.05) {
      // gate hall platform
      if (ss > gateS - 4.1 && ss < gateS + 4.1 && Math.abs(lat) < 6.2) return summitY + 0.45;
      return null;
    }
    if (ss < -8.6 || ss > sTop + platLen + 8) return null;
    if (ss < s0) return null; // plaza flagstones lie on the ground
    if (ss >= sTop) {
      if (ss > gateS - 4.1 && ss < gateS + 4.1) return summitY + 0.45;
      return ss < sTop + platLen + 0.2 ? topY : null;
    }
    for (const l of land) if (ss >= l.s0 && ss <= l.s1) return l.y;
    // linear between tread centres
    let lo = 0, hi = treadS.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (treadS[mid] <= ss) lo = mid;
      else hi = mid;
    }
    const t = Math.max(0, Math.min(1, (ss - treadS[lo]) / Math.max(1e-4, treadS[hi] - treadS[lo])));
    return treadY[lo] + (treadY[hi] - treadY[lo]) * t;
  });

  info.gate = { ...gateC, y: summitY, s: gateS, ...gate };
  info.honden = { ...hp, y: summitY };
  info.prayer = { ...P(hondenS - 5.6, 0), y: summitY, facing: { x: u.x, z: u.z } };
  info.stairsTopY = topY;
  info.plazaY = plazaY;
  info.frame = { base: B, u, X };
  const group = b.build(mats);
  group.userData.info = info;
  return group;
}

// Vermilion nagare-zukuri honden on a raised floor, bark roof with chigi and katsuogi.
function buildHonden(b, M, { groundY, rnd }) {
  const w = { ground: groundY, grimeH: 1.0 };
  const floor = 1.15;
  const bw = 5.4, bd = 4.2;
  b.add('stone', box(bw + 2.8, 0.5, bd + 2.6, { grain: 'x' }), mul(M, mat(0, 0.1, 0.5)), { ...w, grimeH: 0.3 });
  // posts (under floor + walls)
  const xs = [-bw / 2, -bw / 6, bw / 6, bw / 2];
  const zs = [-bd / 2, bd / 2];
  for (const x of xs)
    for (const z of zs) {
      b.add('lacquer', cylinder(0.14, 0.15, floor + 2.5, 10, 3), mul(M, mat(x, (floor + 2.5) / 2 + 0.35, z)), w);
    }
  // floor + veranda with railing
  b.add('woodDark', box(bw + 1.8, 0.14, bd + 1.8, { grain: 'x' }), mul(M, mat(0, floor + 0.35, 0)), w);
  for (const sx of [-1, 1]) {
    b.add('lacquer', box(0.08, 0.08, bd + 1.8, { grain: 'z' }), mul(M, mat(sx * (bw / 2 + 0.85), floor + 1.05, 0)), w);
    for (let k = 0; k < 6; k++) b.add('lacquer', box(0.07, 0.7, 0.07, { grain: 'y' }), mul(M, mat(sx * (bw / 2 + 0.85), floor + 0.7, -bd / 2 - 0.8 + (k * (bd + 1.6)) / 5)), w);
  }
  b.add('lacquer', box(bw + 1.8, 0.08, 0.08, { grain: 'x' }), mul(M, mat(0, floor + 1.05, bd / 2 + 0.85)), w);
  // walls: white plaster panels between vermilion posts, dark doors in the middle front bay
  for (const z of zs) {
    b.add('plaster', box(bw, 2.2, 0.1, { grain: 'x' }), mul(M, mat(0, floor + 0.35 + 1.15, z)), w);
    b.add('lacquer', box(bw + 0.2, 0.18, 0.16, { grain: 'x' }), mul(M, mat(0, floor + 0.35 + 2.3, z)), w);
    b.add('lacquer', box(bw + 0.2, 0.12, 0.16, { grain: 'x' }), mul(M, mat(0, floor + 0.45, z)), w);
  }
  for (const sx of [-1, 1]) b.add('plaster', box(0.1, 2.2, bd, { grain: 'z' }), mul(M, mat(sx * bw / 2, floor + 0.35 + 1.15, 0)), w);
  b.add('woodDark', box(1.6, 2.0, 0.08, { grain: 'y' }), mul(M, mat(0, floor + 0.35 + 1.05, -bd / 2 - 0.06)), { ...w, tint: [0.7, 0.6, 0.55] });
  // front steps under the long front roof
  for (let k = 0; k < 6; k++) b.add('woodDark', box(2.2, 0.18, 0.34, { grain: 'x' }), mul(M, mat(0, 0.35 + (k + 0.5) * (floor / 6), -bd / 2 - 1.0 - (5 - k) * 0.3)), w);
  // nagare roof: long front slope over the steps
  const ro = { W: bw + 2.2, D: bd + 1.6, H: 2.5, type: 'gable', pow: 1.5, lift: 0.28, thick: 0.28, frontExt: 2.3, segE: 14, segS: 10, seed: 11 };
  const roof = buildRoof(ro);
  const RM = mul(M, mat(0, floor + 0.35 + 2.45, 0, 0, Math.PI, 0));
  b.add('bark', roof.top, RM, w);
  b.add('woodDark', roof.under, RM, { ...w, tint: [0.7, 0.66, 0.62] });
  b.add('lacquer', roof.fascia, RM, w);
  b.add('lacquer', roof.hafu, RM, w);
  b.add('black', roof.ridge, RM, w);
  // katsuogi logs across the ridge + chigi (crossed finials) at both gable ends
  for (let k = 0; k < 4; k++) {
    const x = -1.9 + (k * 3.8) / 3;
    b.add('black', cylinder(0.13, 0.13, 1.0, 10, 1), mul(RM, mat(x, ro.H + 0.42, 0, Math.PI / 2, 0, 0)), w);
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const g = box(0.1, 1.6, 0.24, { grain: 'y' });
      b.add('black', g, mul(RM, mat(sx * (ro.W / 2 - 0.1), ro.H + 0.35, sz * 0.32, sz * 0.6, 0, 0)), w);
    }
  }
  // shimenawa on the front with shide
  const pts = [];
  for (let k = 0; k <= 16; k++) {
    const t = k / 16;
    pts.push(new THREE.Vector3(-bw / 2 + bw * t, floor + 0.35 + 2.15 - Math.sin(Math.PI * t) * 0.25, -bd / 2 - 0.35));
  }
  b.add('straw', sweep(pts, { radius: 0.1, radial: 10 }), mul(M, mat(0, 0, 0)), { ...w, grimeH: 0 });
  for (const t of [0.25, 0.5, 0.75]) {
    const pg = new THREE.PlaneGeometry(0.18, 0.5, 1, 4);
    setFlag(pg, (px, py) => Math.min(1, (0.25 - py) / 0.5), t * 5);
    b.add('paper', pg, mul(M, mat(-bw / 2 + bw * t, floor + 0.35 + 2.15 - Math.sin(Math.PI * t) * 0.25 - 0.4, -bd / 2 - 0.42)), { flag: true });
  }
  // offering box
  b.add('woodDark', box(1.2, 0.6, 0.6, { grain: 'x' }), mul(M, mat(0, 0.65, -bd / 2 - 3.2)), w);
  void rnd;
}

// Small purification pavilion: four posts, gable roof, stone basin.
function buildChozuya(b, M, { groundY }) {
  const w = { ground: groundY, grimeH: 0.8 };
  for (const x of [-1.1, 1.1]) for (const z of [-0.8, 0.8]) b.add('woodAged', cylinder(0.09, 0.1, 2.3, 8, 2), mul(M, mat(x, 1.15, z)), w);
  const ro = { W: 3.3, D: 2.6, H: 0.95, type: 'gable', pow: 1.4, lift: 0.14, thick: 0.16, segE: 8, segS: 6, seed: 21 };
  const roof = buildRoof(ro);
  const RM = mul(M, mat(0, 2.3, 0));
  b.add('bark', roof.top, RM, w);
  b.add('woodAged', roof.under, RM, w);
  b.add('woodAged', roof.fascia, RM, w);
  b.add('woodAged', roof.hafu, RM, w);
  b.add('black', roof.ridge, RM, w);
  b.add('stoneMossy', box(1.5, 0.7, 0.8, { grain: 'x' }), mul(M, mat(0, 0.3, 0)), { ...w, grimeH: 0.5 });
  b.add('black', box(1.3, 0.02, 0.6, { grain: 'x' }), mul(M, mat(0, 0.66, 0)), w);
}
