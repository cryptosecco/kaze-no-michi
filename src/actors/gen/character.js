import * as THREE from 'three';
import { buildRig } from '../rig/skeleton.js';
import { autoSkin, rigidSkin, gradientSkin, paint, shadeVerts } from '../rig/skin.js';
import { loft, thickSurface, lathe, ellipsoid, box, mergeParts, place, remapUV, flatUV } from './shapes.js';
import { fabricDetail, lamellarAtlas, straw, faceMap, raggedFabric } from './textures.js';
import { characterShading } from './charShading.js';

// Procedural character: one skeleton, a handful of skinned meshes grouped by material.
//   buildCharacter(spec) → { root, rig, meshes, mats, spec }
// spec: see SAMURAI / BANDITS below. Geometry is built in the rest T-pose (model space, facing +Z).

export const SAMURAI = {
  kind: 'samurai',
  scale: 1,
  colors: {
    kimono: '#27324c', sleeve: '#28334e', hakama: '#22232b', obi: '#d4c9b0', kote: '#17171b', glove: '#2a2019',
    tabi: '#1f1d1b', legwrap: '#262420', hair: '#0e0c0b',
  },
  armor: { do: true, sode: true, kusazuri: true, kote: true },
  hat: 'kasa',
  hair: 'bun',
  face: { skin: '#b07c58', masked: true, maskColor: '#1a1f2c', brows: 1 },
  sleeves: 'full',
  lower: 'hakama',
};

// The camp's five. Swords for the four that close in on the samurai at sunset (S3); the one under the jingasa
// keeps the camp's spear (its unblockable sweep).
export const BANDITS = [
  {
    kind: 'bandit', variant: 0, scale: 1.01, shoulders: 1.06, rag: '#8a6a24', ragSeed: 3,
    colors: { hakama: '#5b4a33', legwrap: '#6b5d48', hair: '#141110', band: '#7a2a1c', obi: '#3b2f22' },
    armor: {}, hat: null, hair: 'topknot', headband: true,
    face: { skin: '#a8714c', beard: 0.85, brows: 1.4, hair: '#141110' }, sleeves: 'full', lower: 'short', weapon: 'katana',
  },
  {
    kind: 'bandit', variant: 1, scale: 0.98, shoulders: 1.0, rag: '#6b4a2e', ragSeed: 7,
    colors: { hakama: '#4a4640', legwrap: '#5c5245', hair: '#1a1512', obi: '#2c241c' },
    armor: {}, hat: 'jingasa', hair: 'topknot', headband: false,
    face: { skin: '#b07a52', beard: 0.35, brows: 1, scar: true, hair: '#1a1512' }, sleeves: 'rolled', lower: 'short', weapon: 'spear',
  },
  {
    kind: 'bandit', variant: 2, scale: 1.03, shoulders: 1.1, rag: '#5e5040', ragSeed: 11,
    colors: { hakama: '#3d3a2f', legwrap: '#5a5040', hair: '#100e0d', obi: '#2a2119' },
    armor: { do: true }, hat: null, hair: 'long', headband: false,
    face: { skin: '#9c6848', beard: 1.0, brows: 1.6, hair: '#100e0d' }, sleeves: 'rolled', lower: 'short', weapon: 'katana',
  },
  {
    kind: 'bandit', variant: 3, scale: 0.99, shoulders: 1.04, rag: '#3f3a2b', ragSeed: 17,
    colors: { hakama: '#3a3326', legwrap: '#6a5a42', hair: '#15120f', band: '#d8d0bc', obi: '#2e261c' },
    armor: {}, hat: null, hair: 'topknot', headband: true,
    face: { skin: '#ad7751', beard: 0.6, brows: 1.2, hair: '#15120f' }, sleeves: 'full', lower: 'short', weapon: 'katana',
  },
];
// the fifth of the camp: the first one's build in a rust-brown kimono, a pale headband, a thinner beard
BANDITS.push({
  ...BANDITS[0], variant: 4, rag: '#5c2d1c', ragSeed: 23, scale: 0.97, sleeves: 'rolled',
  colors: { ...BANDITS[0].colors, band: '#d8d0bc' }, face: { ...BANDITS[0].face, beard: 0.4 },
});

const matCache = new Map();
function cachedMat(key, make) {
  if (!matCache.has(key)) matCache.set(key, make());
  return matCache.get(key);
}

// The cloth's contre-jour rim fades in between these rest-pose heights (m above the feet): full from the obi up,
// none on the shins. Lit by a low sun behind them, the hakama's leg tubes read as two pale sticks (S1).
const CLOTH_RIM_FADE = [0.55, 1.05];

function fabricMaterial(spec) {
  if (spec.rag) {
    const t = raggedFabric(spec.rag, spec.ragSeed || 1);
    return cachedMat('rag' + spec.rag + spec.ragSeed, () =>
      characterShading(
        new THREE.MeshPhysicalMaterial({
          vertexColors: true, map: t.map, normalMap: t.normalMap, normalScale: new THREE.Vector2(0.7, 0.7),
          roughness: 0.94, sheen: 0.3, sheenRoughness: 0.6, sheenColor: new THREE.Color(0x6a5a44), side: THREE.DoubleSide,
        }),
        { rim: 0.5, fill: 0.35, rimTint: 0.6, rimFade: CLOTH_RIM_FADE }
      )
    );
  }
  const t = fabricDetail();
  return cachedMat('fabric', () =>
    characterShading(
      new THREE.MeshPhysicalMaterial({
        vertexColors: true, map: t.map, normalMap: t.normalMap, normalScale: new THREE.Vector2(0.55, 0.55),
        roughness: 0.9, sheen: 0.75, sheenRoughness: 0.45, sheenColor: new THREE.Color(0x6f7c98), side: THREE.DoubleSide,
      }),
      { rim: 0.36, fill: 0.9, rimTint: 0.45, rimFade: CLOTH_RIM_FADE }
    )
  );
}

function lacquerMaterial() {
  const t = lamellarAtlas();
  return cachedMat('lacquer', () =>
    characterShading(
      new THREE.MeshPhysicalMaterial({
        vertexColors: true, map: t.map, normalMap: t.normalMap, roughnessMap: t.roughnessMap, roughness: 1, metalness: 0,
        clearcoat: 0.55, clearcoatRoughness: 0.32, side: THREE.DoubleSide,
      }),
      { rim: 0.42, fill: 0.5, rimTint: 0.35 }
    )
  );
}

function strawMaterial() {
  const t = straw();
  return cachedMat('straw', () =>
    characterShading(new THREE.MeshStandardMaterial({ vertexColors: true, map: t.map, normalMap: t.normalMap, roughness: 0.92, side: THREE.DoubleSide }), {
      rim: 0.5, fill: 0.6, rimTint: 0.7, trans: 0.12,
    })
  );
}

function headMaterial(face) {
  const t = faceMap(face);
  return cachedMat('head' + JSON.stringify(face), () =>
    characterShading(new THREE.MeshStandardMaterial({ map: t.map, roughness: 0.62, vertexColors: true }), { rim: 0.3, fill: 0.45, rimTint: 0.7, trans: 0.05 })
  );
}

const SKIN_UV = [0.25, 1 - 0.37]; // forehead of the face map: pure skin
const HAIR_UV = [0.75, 1 - 0.2]; // back of the head: pure hair

export function buildCharacter(spec) {
  const rig = buildRig({ scale: spec.scale || 1, shoulders: spec.shoulders || 1, hips: spec.hips || 1 });
  const R = rig.rest;
  const s = rig.scale;
  const C = spec.colors || {};
  const col = (k, fallback) => new THREE.Color(C[k] || fallback);

  const fabric = [], lacquer = [], strawParts = [], head = [];

  // ---- torso (kimono) ------------------------------------------------------------------------------
  {
    const y = (k) => R[k].y;
    const rings = [
      [y('Hips') - 0.08 * s, 0.158, 0.112, 0.0],
      [y('Hips') + 0.03 * s, 0.155, 0.11, 0.0],
      [y('Spine') + 0.03 * s, 0.152, 0.106, -0.004],
      [y('Spine1') + 0.03 * s, 0.168, 0.114, -0.01],
      [y('Spine2') + 0.02 * s, 0.183, 0.121, -0.014],
      [y('Spine2') + 0.08 * s, 0.186, 0.116, -0.016],
      [y('Neck') - 0.035 * s, 0.163, 0.1, -0.016],
      [y('Neck') - 0.005 * s, 0.1, 0.08, -0.014],
      [y('Neck') + 0.025 * s, 0.06, 0.058, -0.01],
      [y('Head') + 0.01 * s, 0.05, 0.052, 0.0],
    ].map(([yy, rx, ry, z]) => ({ c: [0, yy, z * s], ax: [1, 0, 0], ay: [0, 0, 1], rx: rx * s * (spec.shoulders || 1) ** 0.5, ry: ry * s }));
    const g = loft(rings, { seg: 20, tile: 0.14 });
    paint(g, col('kimono', spec.rag ? '#ffffff' : '#27324c'));
    // chest skin for rolled-sleeve bandits: open collar V shows skin — shade the neck ring toward skin
    autoSkin(g, rig, ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftShoulder', 'RightShoulder'], {
      power: 4, bias: { LeftShoulder: 0.35, RightShoulder: 0.35, Head: 0.5 },
    });
    fabric.push(g);
  }

  // ---- obi --------------------------------------------------------------------------------------------
  {
    const yb = R.Hips.y + 0.01 * s, yt = R.Hips.y + 0.1 * s;
    const g = loft(
      [
        { c: [0, yb, 0], ax: [1, 0, 0], ay: [0, 0, 1], rx: 0.166 * s, ry: 0.121 * s },
        { c: [0, (yb + yt) / 2, -0.002], ax: [1, 0, 0], ay: [0, 0, 1], rx: 0.169 * s, ry: 0.123 * s },
        { c: [0, yt, -0.004], ax: [1, 0, 0], ay: [0, 0, 1], rx: 0.164 * s, ry: 0.119 * s },
      ],
      { seg: 20, tile: 0.1 }
    );
    const knot = box([0, R.Hips.y + 0.055 * s, -0.128 * s], [0.11 * s, 0.07 * s, 0.035 * s]);
    for (const p of [g, knot]) {
      paint(p, col('obi', '#d4c9b0'));
      autoSkin(p, rig, ['Hips', 'Spine'], { power: 4 });
      fabric.push(p);
    }
  }

  // ---- arms -------------------------------------------------------------------------------------------
  for (const side of [1, -1]) {
    const L = side > 0 ? 'Left' : 'Right';
    const sh = R[L + 'Arm'], el = R[L + 'ForeArm'], wr = R[L + 'Hand'];
    const ax = (x) => ({ c: [x, sh.y - 0.005 * s, sh.z], ax: [0, 1, 0], ay: [0, 0, 1] });
    const rolled = spec.sleeves === 'rolled';
    const pts = [
      [sh.x - side * 0.06 * s, 0.072, 0.07],
      [sh.x + side * 0.03 * s, 0.07, 0.068],
      [sh.x + (el.x - sh.x) * 0.55, 0.064, 0.062],
      [el.x, 0.056, 0.056],
      [el.x + (wr.x - el.x) * 0.4, 0.052, 0.05],
      [el.x + (wr.x - el.x) * 0.82, 0.045, 0.043],
      [wr.x + side * 0.005 * s, 0.041, 0.039],
    ];
    const rings = pts.map(([x, ry, rz]) => ({ ...ax(x), rx: ry * s, ry: rz * s }));
    // sleeve fabric (upper arm); forearm = armored kote (samurai) or bare skin (bandits)
    const sleeve = loft(rings.slice(0, rolled ? 4 : 7), { seg: 14, tile: 0.14 });
    paint(sleeve, col('sleeve', spec.rag ? '#ffffff' : '#28334e'));
    if (!rolled && spec.armor && spec.armor.kote) {
      const k = col('kote', '#17171b');
      const kSplit = el.x - side * 0.02 * s;
      const pos = sleeve.attributes.position, c = sleeve.attributes.color;
      for (let i = 0; i < pos.count; i++)
        if ((pos.getX(i) - kSplit) * side > 0) c.setXYZ(i, k.r, k.g, k.b);
    }
    autoSkin(sleeve, rig, ['Spine2', L + 'Shoulder', L + 'Arm', L + 'ForeArm', L + 'Hand'], { power: 4, bias: { Spine2: 0.3 } });
    fabric.push(sleeve);
    if (rolled) {
      // rolled cuff + bare forearm (skin, sampled from the face map)
      const cuff = loft(
        [
          { ...ax(el.x - side * 0.035 * s), rx: 0.066 * s, ry: 0.064 * s },
          { ...ax(el.x + side * 0.01 * s), rx: 0.064 * s, ry: 0.062 * s },
        ],
        { seg: 14, tile: 0.1 }
      );
      paint(cuff, new THREE.Color('#e8dccb'));
      autoSkin(cuff, rig, [L + 'Arm', L + 'ForeArm'], { power: 4 });
      fabric.push(cuff);
      const fore = loft(rings.slice(3), { seg: 12, tile: 0.1 });
      flatUV(fore, SKIN_UV[0], SKIN_UV[1]);
      paint(fore, new THREE.Color(0xffffff));
      autoSkin(fore, rig, [L + 'Arm', L + 'ForeArm', L + 'Hand'], { power: 4 });
      head.push(fore);
    }
    // kote plates on the forearm (samurai)
    if (!rolled && spec.armor && spec.armor.kote) {
      const x0 = el.x + side * 0.03 * s, x1 = wr.x - side * 0.02 * s;
      const plate = thickSurface(
        (u, v, o) => {
          const x = x0 + (x1 - x0) * u;
          const a = (-0.95 + 1.9 * v) * 1.0;
          const r = (0.058 - 0.014 * u) * s;
          o.set(x, sh.y - 0.005 * s + Math.cos(a) * r, sh.z + Math.sin(a) * r);
        },
        6, 6, { thickness: 0.004 * s, flipNormal: side < 0 }
      );
      remapUV(plate, (u, v) => [0.5 + 0.18 * v, 0.55 + 0.4 * u]);
      paint(plate, new THREE.Color(0xffffff));
      rigidSkin(plate, rig, L + 'ForeArm');
      lacquer.push(plate);
    }
    // hand (glove or skin fist)
    const hx = wr.x + side * 0.055 * s;
    const fist = ellipsoid([hx, sh.y - 0.01 * s, sh.z + 0.005], [0.052 * s, 0.043 * s, 0.04 * s], 12, 10);
    const fingers = ellipsoid([hx + side * 0.03 * s, sh.y - 0.03 * s, sh.z + 0.012], [0.03 * s, 0.028 * s, 0.045 * s], 10, 8);
    const thumb = ellipsoid([hx - side * 0.015 * s, sh.y - 0.005 * s, sh.z + 0.045 * s], [0.032 * s, 0.018 * s, 0.018 * s], 8, 6);
    for (const p of [fist, fingers, thumb]) {
      if (spec.kind === 'samurai') {
        paint(p, col('glove', '#2a2019'));
        rigidSkin(p, rig, L + 'Hand');
        fabric.push(p);
      } else {
        flatUV(p, SKIN_UV[0], SKIN_UV[1]);
        paint(p, new THREE.Color(0xf2e6dc));
        rigidSkin(p, rig, L + 'Hand');
        head.push(p);
      }
    }
  }

  // ---- lower body: hakama (wide) or short trousers + wraps ---------------------------------------------
  for (const side of [1, -1]) {
    const L = side > 0 ? 'Left' : 'Right';
    const up = R[L + 'UpLeg'], kn = R[L + 'Leg'], an = R[L + 'Foot'];
    const short = spec.lower === 'short';
    const defs = short
      ? [
          [R.Hips.y + 0.05 * s, 0.07, 0.15, 0.14],
          [up.y - 0.08 * s, 0.088, 0.14, 0.14],
          [(up.y + kn.y) / 2, 0.098, 0.128, 0.126],
          [kn.y + 0.02 * s, 0.1, 0.112, 0.11],
          [kn.y - 0.1 * s, 0.1, 0.1, 0.098],
        ]
      : [
          [R.Hips.y + 0.06 * s, 0.072, 0.152, 0.148],
          [up.y - 0.08 * s, 0.088, 0.16, 0.158],
          [(up.y + kn.y) / 2, 0.1, 0.168, 0.166],
          [kn.y, 0.106, 0.176, 0.172],
          [kn.y - 0.18 * s, 0.11, 0.186, 0.18],
          [an.y + 0.1 * s, 0.112, 0.19, 0.184],
          // the hem falls just below the ankle: a heel showing under it catches the backlight as a detached shape
          [an.y - 0.025 * s, 0.112, 0.194, 0.188],
        ];
    const rings = defs.map(([yy, cx, rx, rz]) => ({
      c: [side * cx * s, yy, 0.0],
      ax: [1, 0, 0],
      ay: [0, 0, 1],
      rx: rx * s,
      ry: rz * s,
      fn: (th) => 1 + 0.035 * Math.sin(6 * th + side) + 0.015 * Math.sin(13 * th + 2),
    }));
    const g = loft(rings, { seg: 22, tile: 0.2 });
    paint(g, col('hakama', '#191a20'));
    shadeVerts(g, (p) => 0.75 + 0.25 * Math.min(1, (p.y - an.y) / 0.5)); // dusty, darker hem
    autoSkin(g, rig, ['Hips', L + 'UpLeg', L + 'Leg'], { power: 3, bias: { Hips: 0.55 } });
    if (!short) {
      // the hem ring (below the ankle) follows the foot half-way: at a foot strike the foot is flat while the shin
      // leans back, and a hem stuck to the shin would tip into the ground
      const pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
      for (let i = 0; i < pos.count; i++)
        if (pos.getY(i) < an.y) {
          si.setXYZW(i, rig.index[L + 'Leg'], rig.index[L + 'Foot'], 0, 0);
          sw.setXYZW(i, 0.5, 0.5, 0, 0);
        }
    }
    fabric.push(g);
    // bandits: the kimono's tail over the trousers, flared to mid-thigh and torn into strips of uneven length
    if (short && spec.rag) {
      const seg = 24, hemY = up.y - 0.27 * s;
      const ring = (x, yy, rx, rz) => ({ c: [side * x * s, yy, 0], ax: [1, 0, 0], ay: [0, 0, 1], rx: rx * s, ry: rz * s });
      const tail = loft([ring(0.05, R.Hips.y, 0.12, 0.13), ring(0.085, up.y - 0.1 * s, 0.16, 0.155), ring(0.1, hemY, 0.172, 0.166)], { seg, tile: 0.2 });
      const tp = tail.attributes.position;
      for (let j = 0; j <= seg; j++) {
        const h = Math.abs(Math.sin(((j % seg) + 1) * 12.9898 + (spec.ragSeed || 1) * 78.233 + side) * 43758.5453) % 1;
        tp.setY(2 * (seg + 1) + j, hemY - (0.015 + 0.08 * h) * s);
      }
      tail.computeVertexNormals();
      paint(tail, col('kimono', '#ffffff'));
      autoSkin(tail, rig, ['Hips', L + 'UpLeg', L + 'Leg'], { power: 3, bias: { Hips: 0.55 } });
      fabric.push(tail);
    }
    // leg wraps (kyahan) from below the hem to the ankle
    const topW = short ? kn.y - 0.06 * s : an.y + 0.2 * s;
    const wrap = loft(
      [
        { c: [side * 0.102 * s, topW, 0.005], ax: [1, 0, 0], ay: [0, 0, 1], rx: 0.062 * s, ry: 0.06 * s },
        { c: [side * 0.103 * s, (topW + an.y) / 2, 0.0], ax: [1, 0, 0], ay: [0, 0, 1], rx: 0.052 * s, ry: 0.05 * s },
        { c: [side * 0.104 * s, an.y + 0.01 * s, -0.012], ax: [1, 0, 0], ay: [0, 0, 1], rx: 0.047 * s, ry: 0.047 * s },
      ],
      { seg: 12, tile: 0.08 }
    );
    paint(wrap, col('legwrap', '#34312c'));
    autoSkin(wrap, rig, [L + 'Leg', L + 'Foot'], { power: 4 });
    fabric.push(wrap);
    // foot (tabi) + straw sandal sole
    const fx = side * 0.104 * s;
    const foot = loft(
      [
        [-0.078, 0.05, 0.028, 0.03],
        [-0.055, 0.052, 0.042, 0.044],
        [0.0, 0.047, 0.046, 0.044],
        [0.06, 0.036, 0.048, 0.034],
        [0.12, 0.028, 0.046, 0.025],
        [0.172, 0.022, 0.03, 0.017],
      ].map(([z, yy, rx, ry]) => ({ c: [fx, yy * s, z * s], ax: [1, 0, 0], ay: [0, 1, 0], rx: rx * s, ry: ry * s })),
      { seg: 12, tile: 0.1, capStart: true, capEnd: true }
    );
    paint(foot, col('tabi', spec.kind === 'samurai' ? '#24211f' : '#3b3129'));
    autoSkin(foot, rig, [L + 'Foot', L + 'ToeBase'], { power: 4 });
    fabric.push(foot);
    // worn, dark straw sole kept within the foot's outline: a pale sole lit from behind reads as a detached shape
    const sole = box([fx, 0.005 * s, 0.045 * s], [0.084 * s, 0.008 * s, 0.25 * s]);
    remapUV(sole, (u, v) => [u * 0.4, v * 0.3]);
    paint(sole, new THREE.Color(0x2e271e));
    autoSkin(sole, rig, [L + 'Foot', L + 'ToeBase'], { power: 4 });
    strawParts.push(sole);
  }

  // ---- armor --------------------------------------------------------------------------------------------
  const A = spec.armor || {};
  if (A.do) {
    const y0 = R.Spine.y - 0.012 * s, y1 = R.Spine2.y + 0.1 * s;
    const rings = [
      [y0, 0.178, 0.13, 0.0],
      [y0 + (y1 - y0) * 0.28, 0.181, 0.132, -0.004],
      [y0 + (y1 - y0) * 0.55, 0.193, 0.138, -0.01],
      [y0 + (y1 - y0) * 0.8, 0.204, 0.142, -0.014],
      [y1, 0.199, 0.132, -0.016],
    ].map(([yy, rx, rz, z]) => ({ c: [0, yy, z * s], ax: [1, 0, 0], ay: [0, 0, 1], rx: rx * s * (spec.shoulders || 1) ** 0.5, ry: rz * s }));
    const g = loft(rings, { seg: 24, uRange: [0.5, 1.0], vRange: [0.02, 0.98], phase: -Math.PI / 2 });
    paint(g, spec.kind === 'bandit' ? new THREE.Color(0x9a7e66) : new THREE.Color(0xffffff));
    autoSkin(g, rig, ['Hips', 'Spine', 'Spine1', 'Spine2'], { power: 4, bias: { Hips: 0.3 } });
    lacquer.push(g);
    // shoulder straps (watagami)
    for (const side of [1, -1]) {
      const strap = thickSurface(
        (u, v, o) => {
          const z = (-0.13 + 0.26 * u) * s;
          const x = side * (0.1 + 0.03 * v) * s;
          o.set(x, R.Spine2.y + 0.13 * s - Math.abs(z) * 0.25 + 0.015 * Math.cos(u * Math.PI) * s, z);
        },
        6, 2, { thickness: 0.008 * s, flipNormal: side > 0 }
      );
      remapUV(strap, (u, v) => [0.5 + 0.1 * v, 0.1 + 0.2 * u]);
      paint(strap, new THREE.Color(0xffffff));
      autoSkin(strap, rig, ['Spine2', 'Neck'], { power: 4 });
      lacquer.push(strap);
    }
  }
  if (A.kusazuri) {
    const yTop = R.Hips.y + 0.08 * s;
    const plates = [
      [8, 62, 'LeftKusazuri'], [-62, -8, 'RightKusazuri'], [66, 120, 'LeftKusazuri'], [-120, -66, 'RightKusazuri'],
      [124, 178, 'BackKusazuri'], [-178, -124, 'BackKusazuri'],
    ];
    for (const [a0, a1, bone] of plates) {
      const g = thickSurface(
        (u, v, o) => {
          const phi = THREE.MathUtils.degToRad(a0 + (a1 - a0) * u);
          const r = (0.2 + 0.055 * v) * s;
          o.set(Math.sin(phi) * r, yTop - v * 0.3 * s, Math.cos(phi) * r - 0.005);
        },
        6, 6, { thickness: 0.006 * s, flipNormal: true }
      );
      remapUV(g, (u, v) => [0.5 + 0.5 * u, 1 - v]);
      paint(g, new THREE.Color(0xffffff));
      gradientSkin(g, rig, 'Hips', bone, (p) => Math.min(1, (yTop - p.y) / (0.18 * s)));
      lacquer.push(g);
    }
  }
  if (A.sode) {
    // ō-sode: large shoulder guards of seven lacquered rows (the atlas bands), each row flaring out over the next,
    // under a black crown plate. They wrap from behind the shoulder round to its front, so they read from the back
    // (where the cape is tied under them) as well as in profile.
    const ROWS = 7, SUB = 4;
    const psiAt = (u) => THREE.MathUtils.degToRad(-100 + 150 * u);
    for (const side of [1, -1]) {
      const L = side > 0 ? 'Left' : 'Right';
      const yTop = R[L + 'Arm'].y + 0.105 * s, hS = 0.33 * s;
      const g = thickSurface(
        (u, v, o) => {
          const k = Math.round(v * ROWS * SUB);
          const row = Math.min(ROWS - 1, Math.floor(k / SUB));
          const t = (k - row * SUB) / SUB; // 0 at a row's top, 1 at its lower edge
          const psi = psiAt(u);
          const r = (0.125 + 0.075 * v + 0.013 * t) * s;
          o.set((0.14 * s + Math.cos(psi) * r + 0.05 * v * s) * side, yTop - hS * v, -0.02 * s + Math.sin(psi) * r);
        },
        12, ROWS * SUB, { thickness: 0.008 * s, flipNormal: side < 0 }
      );
      remapUV(g, (u, v) => [0.5 * u, 1 - v]);
      const crown = thickSurface(
        (u, v, o) => {
          const psi = psiAt(u);
          const r = 0.121 * s;
          o.set((0.14 * s + Math.cos(psi) * r) * side, yTop + 0.03 * s * (1 - v), -0.02 * s + Math.sin(psi) * r);
        },
        12, 1, { thickness: 0.014 * s, flipNormal: side < 0 }
      );
      remapUV(crown, (u, v) => [0.5 + 0.5 * u, 0.99 - 0.1 * v]); // black-lacquer half, top band
      for (const p of [g, crown]) {
        paint(p, new THREE.Color(0xffffff));
        rigidSkin(p, rig, L + 'Sode');
        lacquer.push(p);
      }
    }
  }

  // ---- head, hair, face -----------------------------------------------------------------------------------
  const hy = R.Head.y + 0.065 * s;
  {
    const skull = ellipsoid([0, hy, 0.012 * s], [0.087 * s, 0.108 * s, 0.1 * s], 28, 20);
    paint(skull, new THREE.Color(0xffffff));
    rigidSkin(skull, rig, 'Head');
    head.push(skull);
    const nose = ellipsoid([0, hy - 0.02 * s, 0.104 * s], [0.013 * s, 0.024 * s, 0.018 * s], 8, 6);
    const earL = ellipsoid([0.086 * s, hy - 0.005 * s, 0.0], [0.012 * s, 0.024 * s, 0.016 * s], 8, 6);
    const earR = ellipsoid([-0.086 * s, hy - 0.005 * s, 0.0], [0.012 * s, 0.024 * s, 0.016 * s], 8, 6);
    for (const p of spec.face && spec.face.masked ? [earL, earR] : [nose, earL, earR]) {
      flatUV(p, SKIN_UV[0], SKIN_UV[1]);
      paint(p, new THREE.Color(0xf0e4da));
      rigidSkin(p, rig, 'Head');
      head.push(p);
    }
    if (spec.face && spec.face.masked) {
      // cloth mask wrapped over nose & mouth: a slightly larger shell on the lower front of the face
      const mask = thickSurface(
        (u, v, o) => {
          const a = THREE.MathUtils.degToRad(-100 + 200 * u);
          const yy = hy - 0.005 * s - v * 0.1 * s;
          const r = (0.094 - 0.012 * v) * s;
          o.set(Math.sin(a) * r * 0.95, yy, Math.cos(a) * r * 1.07 + 0.012 * s);
        },
        12, 4, { thickness: 0.003 * s, flipNormal: true }
      );
      paint(mask, col('mask', spec.face.maskColor || '#1a1f2c'));
      autoSkin(mask, rig, ['Head'], {});
      fabric.push(mask);
    }
    // hair
    const hairCol = col('hair', '#0e0c0b');
    const hairPart = (g) => {
      flatUV(g, HAIR_UV[0], HAIR_UV[1]);
      paint(g, new THREE.Color(0xffffff));
      rigidSkin(g, rig, 'Head');
      head.push(g);
    };
    if (spec.hair === 'bun' || spec.hair === 'topknot') {
      const bun = ellipsoid(spec.hair === 'bun' ? [0, hy + 0.045 * s, -0.09 * s] : [0, hy + 0.105 * s, -0.02 * s], [0.032 * s, 0.03 * s, 0.045 * s], 10, 8);
      if (spec.hair === 'topknot') place(bun, [0, 0, 0], [0, 0, 0]);
      hairPart(bun);
      const tie = ellipsoid(spec.hair === 'bun' ? [0, hy + 0.04 * s, -0.068 * s] : [0, hy + 0.098 * s, 0.01 * s], [0.018 * s, 0.018 * s, 0.012 * s], 8, 6);
      hairPart(tie);
    }
    if (spec.hair === 'long') {
      // loose hair falling to the shoulders: a curved sheet behind the head
      const sheet = thickSurface(
        (u, v, o) => {
          const a = THREE.MathUtils.degToRad(100 + 160 * u);
          const r = (0.1 + 0.03 * v) * s;
          o.set(Math.sin(a) * r, hy + 0.06 * s - v * 0.28 * s, Math.cos(a) * r - 0.01 * s - v * 0.03 * s);
        },
        10, 6, { thickness: 0.012 * s }
      );
      hairPart(sheet);
      autoSkin(sheet, rig, ['Head', 'Neck', 'Spine2'], { power: 3 });
    }
    void hairCol;
    if (spec.headband) {
      const band = loft(
        [
          { c: [0, hy + 0.03 * s, 0.01 * s], ax: [1, 0, 0], ay: [0, 0, 1], rx: 0.091 * s, ry: 0.104 * s },
          { c: [0, hy + 0.055 * s, 0.008 * s], ax: [1, 0, 0], ay: [0, 0, 1], rx: 0.088 * s, ry: 0.1 * s },
        ],
        { seg: 20, tile: 0.1 }
      );
      paint(band, col('band', '#7a2a1c'));
      rigidSkin(band, rig, 'Head');
      fabric.push(band);
      for (const k of [0, 1]) {
        const tail = box([0.02 * s * (k ? 1 : -1), hy + 0.01 * s - k * 0.02 * s, -0.11 * s], [0.025 * s, 0.09 * s, 0.006 * s]);
        paint(tail, col('band', '#7a2a1c'));
        rigidSkin(tail, rig, 'Head');
        fabric.push(tail);
      }
    }
  }

  // ---- hats ----------------------------------------------------------------------------------------------
  if (spec.hat) {
    const kasa = spec.hat === 'kasa';
    const top = hy + (kasa ? 0.22 : 0.2) * s;
    const prof = kasa
      ? [[0.0, 0.0], [0.04, -0.016], [0.14, -0.06], [0.25, -0.108], [0.35, -0.152], [0.41, -0.178], [0.43, -0.186]]
      : [[0.0, 0.0], [0.03, -0.01], [0.1, -0.05], [0.19, -0.1], [0.26, -0.135], [0.3, -0.15]];
    const g = lathe(prof.map(([r, yy]) => [r * s, top + yy * s]), 40, { uRepeat: kasa ? 2 : 1.5, vRepeat: 1 });
    paint(g, new THREE.Color(0xffffff));
    shadeVerts(g, (p) => {
      const r = Math.hypot(p.x, p.z) / s;
      return 0.9 + 0.1 * Math.cos(r * 40) * 0.2 - (r > (kasa ? 0.41 : 0.285) ? 0.45 : 0);
    });
    const rim = new THREE.TorusGeometry((kasa ? 0.43 : 0.3) * s, 0.006 * s, 6, 56);
    rim.rotateX(Math.PI / 2);
    rim.translate(0, top + (kasa ? -0.186 : -0.15) * s, 0);
    paint(rim, new THREE.Color(0x4a3420));
    const knob = ellipsoid([0, top + 0.004 * s, 0], [0.014 * s, 0.012 * s, 0.014 * s], 8, 6);
    paint(knob, new THREE.Color(0x6a4a28));
    const parts = [g, rim, knob];
    // chin cords
    for (const side of [1, -1]) {
      const cord = loft(
        [0, 0.25, 0.5, 0.75, 1].map((t) => ({
          c: [side * (0.075 - 0.07 * t) * s, hy + (0.03 - 0.16 * t) * s, (0.0 + 0.07 * t) * s],
          ax: [1, 0, 0],
          ay: [0, 0, 1],
          rx: 0.003 * s,
          ry: 0.003 * s,
        })),
        { seg: 5, tile: 0.05 }
      );
      paint(cord, new THREE.Color(0x2a1d14));
      parts.push(cord);
    }
    for (const p of parts) {
      // tilt the hat slightly forward over the eyes
      p.translate(0, -hy, 0);
      p.rotateX(THREE.MathUtils.degToRad(kasa ? 7 : 5));
      p.translate(0, hy, 0);
      rigidSkin(p, rig, 'Head');
      strawParts.push(p);
    }
  }

  // ---- assemble skinned meshes --------------------------------------------------------------------------
  const mats = {
    fabric: fabricMaterial(spec),
    lacquer: lacquerMaterial(),
    straw: strawMaterial(),
    head: headMaterial(spec.face || {}),
  };
  const root = new THREE.Group();
  root.name = spec.kind;
  root.add(rig.root);
  const meshes = [];
  const make = (parts, m, name) => {
    if (!parts.length) return;
    const geo = mergeParts(parts);
    geo.computeBoundingSphere();
    const mesh = new THREE.SkinnedMesh(geo, m);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    root.add(mesh);
    mesh.bind(rig.skeleton);
    meshes.push(mesh);
  };
  make(fabric, mats.fabric, 'fabric');
  make(lacquer, mats.lacquer, 'armor');
  make(strawParts, mats.straw, 'straw');
  make(head, mats.head, 'head');
  return { root, rig, meshes, mats, spec };
}
