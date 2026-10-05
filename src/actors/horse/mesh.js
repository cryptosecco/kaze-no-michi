import * as THREE from 'three';
import { loft, thickSurface, lathe, ellipsoid, mergeParts } from '../gen/shapes.js';
import { autoSkin, rigidSkin, paint } from '../rig/skin.js';
import { characterShading } from '../gen/charShading.js';
import { fabricDetail } from '../gen/textures.js';
import { coatMap, hairMap } from './textures.js';
import { buildHorseRig } from './rig.js';
import { SEAT as SEAT_P, STIRRUP as STIRRUP_P } from './seat.js';

// Procedural horse: a bay Japanese native horse (black mane, tail and lower legs) in late-13th-century tack —
// a black-lacquered wooden saddle (kura) on its pad with leather side flaps (aori), slipper-shaped stirrups (abumi),
// a red-corded bridle, breast strap (munagai) and crupper (shirigai) hung with tassels. Built in the rest pose
// (model space of rig.js: facing +Z, left = +X, hooves on y = 0) and merged per material into four skinned meshes
// (coat, hair, lacquer, cloth); the reins are a separate dynamic mesh (Horse updates them each frame).
//   buildHorse() → { root, rig, meshes, mats, seat, stirrups: [L, R], bits: [L, R], pommel, hair, reins }
// Profiles (top line, belly line, widths) are tables in metres; the cross-sections are superellipses: a sharp
// withers ridge, a broad flat back over the loins and croup, a round barrel.

// tack anchor points (model space, seat.js): the seat under the rider's pelvis, the left stirrup's tread centre
const SEAT = new THREE.Vector3(SEAT_P.x, SEAT_P.y, SEAT_P.z);
const STIRRUP = new THREE.Vector3(STIRRUP_P.x, STIRRUP_P.y, STIRRUP_P.z);

const C = {
  bay: '#4f2611', bayDark: '#2f1609', bayLight: '#64331a', points: '#15110f', muzzle: '#2b1a12', hoof: '#2e2722', eye: '#080605',
  hair: '#110d0b', lacquer: '#141110', gold: '#a8843c', vermilion: '#9a2b18', cord: '#8a2015', pad: '#2a211c', aori: '#3a2416',
  aoriRim: '#6b4626', seat: '#5a3320', iron: '#2b2a2a', girth: '#2e2620',
};

// ---- profiles ---------------------------------------------------------------------------------------------
const TOP = [[-0.84, 1.1], [-0.8, 1.165], [-0.76, 1.2], [-0.66, 1.27], [-0.52, 1.315], [-0.38, 1.33], [-0.24, 1.315], [-0.1, 1.29], [0.04, 1.275], [0.18, 1.285], [0.3, 1.32], [0.4, 1.35], [0.5, 1.34], [0.6, 1.3], [0.68, 1.24], [0.76, 1.13]];
const BOT = [[-0.84, 1.01], [-0.8, 0.965], [-0.76, 0.94], [-0.64, 0.89], [-0.5, 0.85], [-0.36, 0.825], [-0.22, 0.8], [-0.08, 0.775], [0.06, 0.76], [0.2, 0.758], [0.32, 0.765], [0.42, 0.78], [0.52, 0.815], [0.6, 0.86], [0.68, 0.92], [0.76, 0.99]];
const WID = [[-0.84, 0.08], [-0.8, 0.15], [-0.76, 0.19], [-0.64, 0.225], [-0.5, 0.245], [-0.36, 0.25], [-0.22, 0.242], [-0.08, 0.25], [0.06, 0.258], [0.2, 0.254], [0.32, 0.24], [0.42, 0.222], [0.52, 0.208], [0.6, 0.196], [0.68, 0.172], [0.76, 0.11]];
// superellipse exponents of the upper half: a ridge at the withers, a broad back over the loins and croup
const NTOP = [[-0.84, 2.2], [-0.6, 2.7], [-0.3, 2.8], [-0.05, 2.5], [0.2, 2.2], [0.34, 1.7], [0.46, 1.6], [0.6, 1.9], [0.76, 2.0]];

function table(T, x) {
  if (x <= T[0][0]) return T[0][1];
  for (let i = 0; i < T.length - 1; i++)
    if (x <= T[i + 1][0]) {
      const t = (x - T[i][0]) / (T[i + 1][0] - T[i][0]);
      return T[i][1] + (T[i + 1][1] - T[i][1]) * t;
    }
  return T[T.length - 1][1];
}

// radius multiplier of a superellipse with exponent nTop above the side line and nBot below it
function superR(th, nTop, nBot) {
  const n = Math.sin(th) >= 0 ? nTop : nBot;
  const c = Math.abs(Math.cos(th)), s = Math.abs(Math.sin(th));
  return Math.pow(Math.pow(c, n) + Math.pow(s, n), -1 / n);
}

// barrel surface point at (z, theta): theta 0 = left side, π/2 = top; `off` pushes it out along the radius
function bodyAt(z, th, off, out) {
  const top = table(TOP, z), bot = table(BOT, z), w = table(WID, z);
  const cy = (top + bot) / 2, ry = (top - bot) / 2;
  const m = superR(th, table(NTOP, z), 2.15);
  return out.set(Math.cos(th) * (w * m + off), cy + Math.sin(th) * (ry * m + off), z);
}

// neck: crest line T, throat line B (side view, [z, y]) and half width, along t 0 (in the chest) .. 1 (the poll)
const NECK_T = [[0, 0.4, 1.345], [0.2, 0.56, 1.425], [0.4, 0.7, 1.525], [0.6, 0.82, 1.625], [0.8, 0.92, 1.715], [1, 0.99, 1.77]];
const NECK_B = [[0, 0.76, 0.98], [0.2, 0.87, 1.11], [0.4, 0.96, 1.25], [0.6, 1.03, 1.38], [0.8, 1.08, 1.49], [1, 1.1, 1.565]];
const NECK_W = [[0, 0.205], [0.2, 0.17], [0.4, 0.138], [0.6, 0.116], [0.8, 0.103], [1, 0.096]];
const lerpTab = (T, t, k) => table(T.map((r) => [r[0], r[k]]), t);

function neckRing(t, out) {
  const tz = lerpTab(NECK_T, t, 1), ty = lerpTab(NECK_T, t, 2), bz = lerpTab(NECK_B, t, 1), by = lerpTab(NECK_B, t, 2);
  out.cz = (tz + bz) / 2;
  out.cy = (ty + by) / 2;
  out.ry = Math.hypot(tz - bz, ty - by) / 2;
  out.ayz = (tz - bz) / (2 * out.ry);
  out.ayy = (ty - by) / (2 * out.ry);
  out.rx = table(NECK_W, t);
  return out;
}
const NECK_N = [1.65, 1.85]; // crest ridge, throat

function neckAt(t, th, off, out) {
  const r = neckRing(t, {});
  const m = superR(th, NECK_N[0], NECK_N[1]);
  const a = Math.cos(th) * (r.rx * m + off), b = Math.sin(th) * (r.ry * m + off);
  return out.set(a, r.cy + r.ayy * b, r.cz + r.ayz * b);
}

// head: along the axis from the poll A to the muzzle B; per station s (0..1) the face side (toward P, forward-up),
// the jaw side and the half width
const HEAD_A = new THREE.Vector3(0, 1.705, 1.015), HEAD_B = new THREE.Vector3(0, 1.2, 1.385);
const HEAD_AX = HEAD_B.clone().sub(HEAD_A).normalize();
const HEAD_P = new THREE.Vector3(0, -HEAD_AX.z, HEAD_AX.y).negate(); // perpendicular, toward the face
if (HEAD_P.z < 0) HEAD_P.negate();
const HEAD_L = HEAD_A.distanceTo(HEAD_B);
const HEAD = [
  // s, face, jaw, half width
  [0, 0.068, 0.08, 0.084],
  [0.08, 0.085, 0.15, 0.112],
  [0.2, 0.092, 0.19, 0.12],
  [0.33, 0.084, 0.168, 0.11],
  [0.48, 0.071, 0.116, 0.091],
  [0.62, 0.064, 0.09, 0.08],
  [0.76, 0.062, 0.081, 0.078],
  [0.88, 0.064, 0.078, 0.083],
  [0.96, 0.053, 0.069, 0.075],
  [1.0, 0.028, 0.039, 0.046],
];
const headTab = (s, k) => table(HEAD.map((r) => [r[0], r[k]]), s);

function headAt(s, th, off, out) {
  const f = headTab(s, 1), j = headTab(s, 2), w = headTab(s, 3);
  const half = (f + j) / 2, shift = (f - j) / 2;
  const m = superR(th, 2.3, 2.0);
  const a = Math.cos(th) * (w * m + off), b = Math.sin(th) * (half * m + off) + shift;
  return out.copy(HEAD_A).addScaledVector(HEAD_AX, s * HEAD_L).addScaledVector(HEAD_P, b).setX(a);
}

// ---- helpers ----------------------------------------------------------------------------------------------
const _v = new THREE.Vector3();

function colorize(geo, fn) {
  const pos = geo.attributes.position;
  const arr = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    _v.fromBufferAttribute(pos, i);
    fn(_v, c);
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  return geo;
}

const col = (hex) => new THREE.Color(hex);
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// tube through 3D points (cords, straps), uniform radius
function tube(pts, r, seg = 6, opts = {}) {
  const rings = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const t = new THREE.Vector3().subVectors(b, a).normalize();
    let ax = new THREE.Vector3(0, 1, 0);
    if (Math.abs(t.dot(ax)) > 0.9) ax.set(1, 0, 0);
    ax.addScaledVector(t, -ax.dot(t)).normalize();
    const ay = new THREE.Vector3().crossVectors(t, ax);
    rings.push({ c: pts[i].toArray(), ax: ax.toArray(), ay: ay.toArray(), rx: opts.rx ?? r, ry: opts.ry ?? r });
  }
  return loft(rings, { seg, tile: 0.05, capStart: !!opts.caps, capEnd: !!opts.caps });
}

// ring frame perpendicular to a chain at point i (legs): ax lateral, ay in the sagittal plane
function chainRings(pts, prof) {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const t = new THREE.Vector3().subVectors(b, a).normalize();
    const ax = new THREE.Vector3(1, 0, 0).addScaledVector(t, -t.x).normalize();
    const ay = new THREE.Vector3().crossVectors(t, ax).normalize();
    const pr = prof[i];
    const c = p.clone().addScaledVector(ay, pr[2] || 0);
    return { c: c.toArray(), ax: ax.toArray(), ay: ay.toArray(), rx: pr[0], ry: pr[1], fn: pr[3] };
  });
}

// ---- materials --------------------------------------------------------------------------------------------
let MATS = null;
function materials() {
  if (MATS) return MATS;
  const coat = coatMap(), hair = hairMap(), fab = fabricDetail();
  MATS = {
    // a groomed summer coat: a soft sheen that catches the low sun along the barrel
    coat: characterShading(
      new THREE.MeshPhysicalMaterial({
        vertexColors: true, map: coat.map, normalMap: coat.normalMap, normalScale: new THREE.Vector2(0.14, 0.14), roughness: 0.55,
        sheen: 0.35, sheenRoughness: 0.45, sheenColor: new THREE.Color(0x7a4a2c),
      }),
      { rim: 0.45, fill: 0.6, rimTint: 0.55 }
    ),
    hair: hairSway(
      characterShading(
        new THREE.MeshStandardMaterial({ vertexColors: true, map: hair.map, normalMap: hair.normalMap, roughness: 0.62, alphaTest: 0.5, side: THREE.DoubleSide }),
        { rim: 0.12, fill: 0.45, rimTint: 0.9, trans: 0.15 }
      )
    ),
    lacquer: characterShading(
      new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.5, clearcoat: 0.45, clearcoatRoughness: 0.32, side: THREE.DoubleSide }),
      { rim: 0.35, fill: 0.45, rimTint: 0.3 }
    ),
    cloth: characterShading(
      new THREE.MeshPhysicalMaterial({
        vertexColors: true, map: fab.map, normalMap: fab.normalMap, normalScale: new THREE.Vector2(0.5, 0.5), roughness: 0.82,
        sheen: 0.4, sheenRoughness: 0.5, sheenColor: new THREE.Color(0x8a4a3a), side: THREE.DoubleSide,
      }),
      { rim: 0.4, fill: 0.55, rimTint: 0.5 }
    ),
  };
  return MATS;
}

// Reins: thin dyed cords; a trace of rim only (a fresnel rim lights a thin tube along its whole length)
export function reinsMaterial() {
  return characterShading(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }), { rim: 0.05, fill: 0.5, rimTint: 0.9 });
}

// Hair sway: the mane, forelock and tail locks bend toward their tips (uv.y runs from the root, 0, to the tip, 1)
// with the shared wind and flap with the gait. uniforms: uHairWind (model-space push, m), uHairFlap (m), uHairTime.
export const HAIR_UNIFORMS = { uHairWind: { value: new THREE.Vector3() }, uHairFlap: { value: 0 }, uHairTime: { value: 0 } };
function hairSway(material) {
  const shade = material.userData.onBeforeCompile;
  material.userData.shaderKey += '-horsehair';
  material.userData.onBeforeCompile = (shader) => {
    shade(shader);
    Object.assign(shader.uniforms, HAIR_UNIFORMS);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uHairWind;\nuniform float uHairFlap;\nuniform float uHairTime;')
      .replace(
        '#include <skinning_vertex>',
        `#include <skinning_vertex>
{
  float kzW = uv.y * uv.y;
  float kzPh = dot(position, vec3(7.1, 5.3, 9.7));
  vec3 kzFlut = vec3(sin(uHairTime * 9.1 + kzPh), 0.6 * sin(uHairTime * 7.3 + kzPh * 1.3), cos(uHairTime * 8.3 + kzPh));
  transformed += (uHairWind * (1.0 + 0.25 * sin(uHairTime * 3.1 + kzPh)) + kzFlut * uHairFlap) * kzW;
}`
      );
  };
  return material;
}

export function buildHorse() {
  const rig = buildHorseRig();
  const R = rig.rest;
  const coat = [], hair = [], lacquer = [], cloth = [];
  const tmp = new THREE.Vector3();

  // ---- coat colour: bay, darker along the top line, black points below the knees and hocks, dark muzzle ------
  const bay = col(C.bay), bayDark = col(C.bayDark), bayLight = col(C.bayLight), points = col(C.points);
  const coatColor = (p, c) => {
    c.copy(bay);
    // shading of the coat: the top line darker, the flanks a little lighter
    const top = table(TOP, p.z), bot = table(BOT, p.z);
    const h = (p.y - bot) / Math.max(0.05, top - bot);
    if (p.y > 0.75) c.lerp(bayDark, smooth(0.7, 1.0, h) * 0.55).lerp(bayLight, smooth(0.15, 0.45, h) * (1 - smooth(0.55, 0.8, h)) * 0.35);
    // black points: lower legs, from just above the knees and hocks
    const legTop = p.z > 0 ? 0.5 : 0.54;
    if (Math.abs(p.x) > 0.05 && p.y < 0.75) c.lerp(points, smooth(legTop + 0.06, legTop - 0.08, p.y));
  };

  // ---- barrel ---------------------------------------------------------------------------------------------
  {
    const zs = [];
    for (let z = -0.84; z <= 0.761; z += 0.06) zs.push(Math.min(0.76, z));
    const rings = zs.map((z) => {
      const top = table(TOP, z), bot = table(BOT, z), w = table(WID, z), nt = table(NTOP, z);
      return { c: [0, (top + bot) / 2, z], ax: [1, 0, 0], ay: [0, 1, 0], rx: w, ry: (top - bot) / 2, fn: (th) => superR(th, nt, 2.15) };
    });
    const g = loft(rings, { seg: 30, tile: 0.3, capStart: true, capEnd: true });
    colorize(g, coatColor);
    autoSkin(g, rig, ['Body', 'Chest', 'Pelvis', 'Neck1', 'ScapL', 'ScapR', 'HumL', 'HumR', 'FemL', 'FemR', 'Tail1'], {
      power: 4, bias: { Body: 1.1, Chest: 1, Pelvis: 1, ScapL: 0.45, ScapR: 0.45, HumL: 0.22, HumR: 0.22, FemL: 0.32, FemR: 0.32, Tail1: 0.2, Neck1: 0.5 },
    });
    coat.push(g);
  }

  // ---- neck -----------------------------------------------------------------------------------------------
  {
    const rings = [];
    for (let i = 0; i <= 14; i++) {
      const t = i / 14;
      const r = neckRing(t, {});
      rings.push({ c: [0, r.cy, r.cz], ax: [1, 0, 0], ay: [0, r.ayy, r.ayz], rx: r.rx, ry: r.ry, fn: (th) => superR(th, NECK_N[0], NECK_N[1]) });
    }
    const g = loft(rings, { seg: 26, tile: 0.3 });
    colorize(g, (p, c) => c.copy(bay).lerp(bayDark, smooth(1.3, 1.75, p.y) * 0.35));
    autoSkin(g, rig, ['Chest', 'Neck1', 'Neck2', 'Neck3', 'Head'], { power: 4, bias: { Chest: 0.7, Head: 0.6 } });
    coat.push(g);
  }

  // ---- head -----------------------------------------------------------------------------------------------
  {
    const rings = HEAD.map(([s]) => {
      const f = headTab(s, 1), j = headTab(s, 2), w = headTab(s, 3);
      const c = HEAD_A.clone().addScaledVector(HEAD_AX, s * HEAD_L).addScaledVector(HEAD_P, (f - j) / 2);
      return { c: c.toArray(), ax: [1, 0, 0], ay: HEAD_P.toArray(), rx: w, ry: (f + j) / 2, fn: (th) => superR(th, 2.3, 2.0) };
    });
    const g = loft(rings, { seg: 26, tile: 0.25, capEnd: true });
    const muzzle = col(C.muzzle);
    colorize(g, (p, c) => {
      const s = _v2.copy(p).sub(HEAD_A).dot(HEAD_AX) / HEAD_L;
      c.copy(bay).lerp(bayDark, 0.25).lerp(muzzle, smooth(0.68, 0.9, s));
    });
    autoSkin(g, rig, ['Neck3', 'Head'], { power: 4, bias: { Head: 2.2 } });
    coat.push(g);
    // eyes, nostrils
    for (const sx of [1, -1]) {
      headAt(0.235, 0.5, 0.0, tmp);
      const eye = ellipsoid([sx * (Math.abs(tmp.x) - 0.004), tmp.y, tmp.z], [0.012, 0.02, 0.021], 10, 8);
      paint(eye, col(C.eye));
      rigidSkin(eye, rig, 'Head');
      coat.push(eye);
      headAt(0.9, 0.35, -0.004, tmp);
      const nos = ellipsoid([sx * (Math.abs(tmp.x) - 0.006), tmp.y, tmp.z], [0.008, 0.02, 0.013], 8, 6);
      paint(nos, col('#050404'));
      rigidSkin(nos, rig, 'Head');
      coat.push(nos);
    }
  }

  // ---- ears -----------------------------------------------------------------------------------------------
  for (const side of ['L', 'R']) {
    const a = R['Ear' + side], b = R['Ear' + side + 'End'];
    const axis = b.clone().sub(a).normalize();
    const rings = [0, 0.3, 0.65, 0.9, 1].map((t, i) => {
      const r = [0.03, 0.03, 0.022, 0.012, 0.002][i], rz = [0.022, 0.022, 0.017, 0.01, 0.002][i];
      return {
        c: a.clone().addScaledVector(axis, t * a.distanceTo(b) * 1.0).toArray(), ax: [1, 0, 0], ay: [0, 0, 1], rx: r, ry: rz,
        // the opening faces forward and a little out: dent the front
        fn: (th) => 1 - 0.45 * Math.max(0, Math.sin(th)) * (t > 0.15 && t < 0.95 ? 1 : 0),
      };
    });
    const g = loft(rings, { seg: 10, tile: 0.1, capStart: true });
    colorize(g, (p, c) => c.copy(bay).lerp(bayDark, 0.4).lerp(points, smooth(1.8, 1.87, p.y)));
    rigidSkin(g, rig, 'Ear' + side);
    coat.push(g);
  }

  // ---- legs -----------------------------------------------------------------------------------------------
  const P = (n) => R[n].clone();
  for (const s of ['L', 'R']) {
    // fore: from inside the chest (the arm under the shoulder) down to the coronet; [rx, ry (fore-aft), shift]
    const hum = P('Hum' + s), fore = P('Fore' + s), can = P('CanF' + s), pas = P('PasF' + s), hoof = P('HoofF' + s);
    const pts = [
      hum.clone().lerp(fore, 0.25).add(new THREE.Vector3(0, 0, -0.02)),
      fore.clone().lerp(hum, 0.25),
      fore.clone().add(new THREE.Vector3(0, -0.03, 0.02)),
      fore.clone().lerp(can, 0.3),
      fore.clone().lerp(can, 0.6),
      fore.clone().lerp(can, 0.88),
      can.clone(),
      can.clone().lerp(pas, 0.16),
      can.clone().lerp(pas, 0.55),
      can.clone().lerp(pas, 0.88),
      pas.clone(),
      pas.clone().lerp(hoof, 0.55),
      hoof.clone(),
    ];
    const prof = [
      [0.07, 0.11], [0.072, 0.1], [0.066, 0.088, -0.012], [0.058, 0.07, -0.004], [0.048, 0.056], [0.042, 0.047], [0.046, 0.05], [0.034, 0.04, -0.004],
      [0.028, 0.039, -0.008], [0.031, 0.044, -0.008], [0.039, 0.05, -0.008], [0.033, 0.036], [0.042, 0.044],
    ];
    const g = loft(chainRings(pts, prof), { seg: 14, tile: 0.25 });
    colorize(g, coatColor);
    autoSkin(g, rig, ['Scap' + s, 'Hum' + s, 'Fore' + s, 'CanF' + s, 'PasF' + s, 'HoofF' + s], { power: 5, bias: { ['Scap' + s]: 0.6 } });
    coat.push(g);
    coat.push(hoofMesh(rig, 'HoofF' + s, hoof, P('SoleF' + s)));
  }
  for (const s of ['L', 'R']) {
    // hind: the thigh mass behind the femur, the stifle, the gaskin, the hock with its point behind, the cannon
    const fem = P('Fem' + s), tib = P('Tib' + s), can = P('CanH' + s), pas = P('PasH' + s), hoof = P('HoofH' + s);
    const pts = [
      fem.clone().add(new THREE.Vector3(0, 0.04, -0.02)),
      fem.clone().lerp(tib, 0.45),
      tib.clone().add(new THREE.Vector3(0, -0.02, -0.02)),
      tib.clone().lerp(can, 0.3),
      tib.clone().lerp(can, 0.62),
      tib.clone().lerp(can, 0.88),
      can.clone(),
      can.clone().lerp(pas, 0.14),
      can.clone().lerp(pas, 0.55),
      can.clone().lerp(pas, 0.88),
      pas.clone(),
      pas.clone().lerp(hoof, 0.55),
      hoof.clone(),
    ];
    const prof = [
      [0.1, 0.15, -0.06], [0.11, 0.16, -0.08], [0.09, 0.115, -0.045], [0.066, 0.092, -0.02], [0.05, 0.072, -0.01], [0.044, 0.06, -0.006], [0.045, 0.064, -0.014],
      [0.034, 0.045, -0.004], [0.029, 0.042, 0.0], [0.031, 0.045, 0.0], [0.039, 0.051, 0.0], [0.033, 0.036], [0.042, 0.044],
    ];
    const g = loft(chainRings(pts, prof), { seg: 14, tile: 0.25 });
    colorize(g, coatColor);
    autoSkin(g, rig, ['Pelvis', 'Fem' + s, 'Tib' + s, 'CanH' + s, 'PasH' + s, 'HoofH' + s], { power: 5, bias: { Pelvis: 0.35 } });
    coat.push(g);
    coat.push(hoofMesh(rig, 'HoofH' + s, hoof, P('SoleH' + s)));
  }

  // ---- tail: the dock in coat, then the long black hair ----------------------------------------------------
  {
    const dock = tube([R.Tail1.clone().add(new THREE.Vector3(0, 0.02, 0.04)), R.Tail1.clone(), R.Tail1.clone().lerp(R.Tail2, 0.6)], 0.042, 10, { caps: true });
    colorize(dock, (p, c) => c.copy(bayDark).lerp(points, 0.5));
    autoSkin(dock, rig, ['Pelvis', 'Tail1', 'Tail2'], { power: 4 });
    coat.push(dock);
    const chain = ['Tail1', 'Tail2', 'Tail3', 'Tail4', 'Tail5', 'TailEnd'].map((n) => R[n]);
    const rings = [];
    const radii = [[0.05, 0.05], [0.066, 0.062], [0.078, 0.072], [0.084, 0.074], [0.08, 0.068], [0.066, 0.055]];
    for (let i = 0; i < chain.length; i++) {
      const a = chain[Math.max(0, i - 1)], b = chain[Math.min(chain.length - 1, i + 1)];
      const t = b.clone().sub(a).normalize();
      const ay = new THREE.Vector3(0, 0, 1).addScaledVector(t, -t.z).normalize();
      rings.push({ c: chain[i].toArray(), ax: [1, 0, 0], ay: ay.toArray(), rx: radii[i][0], ry: radii[i][1] });
    }
    const g = loft(rings, { seg: 12, uRange: [0, 2], vRange: [0.02, 0.98] });
    paint(g, col(C.hair));
    autoSkin(g, rig, ['Tail1', 'Tail2', 'Tail3', 'Tail4', 'Tail5'], { power: 3 });
    hair.push(g);
  }

  // ---- mane: thick, falling on the right side of the neck; a shorter lock spills to the left; forelock --------
  {
    const strip = (side, len, t0, t1, thick) =>
      thickSurface(
        (u, v, o) => {
          const t = t0 + (t1 - t0) * u;
          const reach = len * (0.75 + 0.35 * Math.sin(u * Math.PI)) * (0.9 + 0.1 * Math.sin(u * 37));
          const r = neckRing(t, {});
          // around the crest toward the side, lifting off the skin toward the tips, then hanging
          const arc = Math.min(1.25, (v * reach) / Math.max(0.05, r.ry * 0.9));
          const th = Math.PI / 2 + side * arc;
          const m = superR(th, NECK_N[0], NECK_N[1]);
          const lift = 0.012 + 0.03 * v;
          const a = Math.cos(th) * (r.rx * m + lift), b = Math.sin(th) * (r.ry * m + lift);
          o.set(a, r.cy + r.ayy * b - 0.03 * v * v, r.cz + r.ayz * b - 0.012 * v);
        },
        14, 5, { thickness: thick, flipNormal: side > 0 }
      );
    const right = strip(-1, 0.2, 0.06, 1.0, 0.03);
    const left = strip(1, 0.09, 0.15, 0.95, 0.02);
    for (const g of [right, left]) {
      paint(g, col(C.hair));
      autoSkin(g, rig, ['Chest', 'Neck1', 'Neck2', 'Neck3', 'Head'], { power: 4, bias: { Chest: 0.5, Head: 0.5 } });
      hair.push(g);
    }
    // forelock over the forehead between the ears
    const fl = thickSurface(
      (u, v, o) => {
        const s = 0.0 + 0.2 * v;
        headAt(s, Math.PI / 2 + (u - 0.5) * 0.9 * (1 - 0.5 * v), 0.012 + 0.008 * v, o);
        o.y += 0.05 * (1 - v) * (1 - v);
      },
      6, 5, { thickness: 0.016 }
    );
    paint(fl, col(C.hair));
    rigidSkin(fl, rig, 'Head');
    hair.push(fl);
  }

  // ---- tack -----------------------------------------------------------------------------------------------
  const red = col(C.cord), lac = col(C.lacquer), gold = col(C.gold);
  // pad under the saddle (shitagura), conforming to the back
  {
    const g = thickSurface((u, v, o) => bodyAt(-0.13 + 0.48 * u, Math.PI / 2 + (v - 0.5) * 2.1, 0.012, o), 10, 10, { thickness: 0.018, flipNormal: true });
    paint(g, col(C.pad));
    rigidSkin(g, rig, 'Body');
    cloth.push(g);
  }
  // side flaps (aori): rounded leather flaps hanging under the stirrup leathers, a lighter border
  for (const sx of [1, -1]) {
    const z0 = -0.07, z1 = 0.31;
    const g = thickSurface(
      (u, v, o) => {
        const th = 0.62 - 1.0 * v;
        // round the lower corners
        const k = Math.pow(Math.max(0, v - 0.55) / 0.45, 2);
        const zz = z0 + (z1 - z0) * (0.5 + (u - 0.5) * (1 - 0.35 * k));
        bodyAt(zz, th, 0.032 + 0.008 * v, o);
        o.x *= sx;
      },
      10, 8, { thickness: 0.01, flipNormal: sx < 0 }
    );
    const aori = col(C.aori), rim = col(C.aoriRim);
    const uv = g.attributes.uv;
    const cc = new Float32Array(uv.count * 3), cc2 = new THREE.Color();
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i), v = uv.getY(i);
      const e = Math.min(u, 1 - u, v * 1.5, 1 - v);
      cc2.copy(aori).lerp(rim, e < 0.08 ? 1 : 0);
      if (Math.abs(u - 0.5) < 0.12 && Math.abs(v - 0.5) < 0.16) cc2.lerp(gold, 0.55); // a crest roundel
      cc.set([cc2.r, cc2.g, cc2.b], i * 3);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(cc, 3));
    rigidSkin(g, rig, 'Body');
    cloth.push(g);
  }
  // girth
  {
    const g = thickSurface((u, v, o) => bodyAt(0.24 + 0.05 * v, -Math.PI / 2 + (u - 0.5) * 2.3, 0.018, o), 16, 1, { thickness: 0.008, flipNormal: true });
    paint(g, col(C.girth));
    rigidSkin(g, rig, 'Body');
    cloth.push(g);
  }
  // saddle: the seat (igi), the tall front arch (maegwa) and the rear arch (shizugwa), black lacquer, gilt rims
  {
    const seat = thickSurface(
      (u, v, o) => {
        const z = -0.05 + 0.33 * v, x = (u - 0.5) * 0.3;
        const back = bodyAt(z, Math.PI / 2, 0, tmp).y;
        o.set(x, Math.max(back + 0.055, SEAT.y - 0.03 + 0.05 * Math.pow(Math.abs(v - 0.45) * 2, 2)) + 0.03 * Math.pow(Math.abs(u - 0.5) * 2, 2), z);
      },
      6, 8, { thickness: 0.035, flipNormal: true }
    );
    paint(seat, col(C.seat));
    rigidSkin(seat, rig, 'Body');
    cloth.push(seat);
    const arch = (z, peak, lean, w) =>
      thickSurface(
        (u, v, o) => {
          const th = Math.PI / 2 + (u - 0.5) * 2.2;
          bodyAt(z, th, 0.03, o);
          const bottom = o.y;
          const x = o.x;
          const top = Math.max(bottom + 0.05, peak - 0.1 * Math.pow(Math.abs(x) / w, 2.2));
          o.y = bottom + (top - bottom) * v;
          o.z = z + lean * (o.y - bottom);
        },
        14, 4, { thickness: 0.045 }
      );
    for (const [g, top] of [[arch(0.3, 1.49, 0.42, 0.24), 1.49], [arch(-0.07, 1.455, -0.75, 0.24), 1.455]]) {
      colorize(g, (p, c) => c.copy(lac).lerp(gold, p.y > top - 0.012 ? 0.8 : 0));
      rigidSkin(g, rig, 'Body');
      lacquer.push(g);
    }
  }
  // stirrup leathers and the stirrups (abumi): a long tread under the whole foot, the front curled up over the
  // toes into a swan neck that hangs from the leather; black lacquer outside, vermilion in the tread
  for (const sx of [1, -1]) {
    const top = new THREE.Vector3(sx * 0.215, 1.31, 0.13), hang = new THREE.Vector3(sx * STIRRUP.x, STIRRUP.y + 0.2, STIRRUP.z + 0.06);
    const strap = tube([top, top.clone().lerp(hang, 0.5).add(new THREE.Vector3(sx * 0.012, 0, 0)), hang], 0.01, 4, { rx: 0.017, ry: 0.005 });
    paint(strap, col(C.aori));
    rigidSkin(strap, rig, 'Body');
    cloth.push(strap);
    lacquer.push(...stirrupMesh(rig, sx));
  }
  // breast strap (munagai) and crupper (shirigai): red cords, the crupper with cords over the croup; tassels
  {
    const cord = (pts, bones) => {
      const g = tube(pts, 0.012, 6);
      paint(g, red);
      autoSkin(g, rig, bones, { power: 4 });
      cloth.push(g);
    };
    const surf = (z, th, off) => bodyAt(z, th, off, new THREE.Vector3());
    const breast = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10; // left saddle → chest front → right saddle
      const th = 0.75 - 1.05 * Math.sin(t * Math.PI) * 0.4;
      const z = 0.3 + 0.44 * Math.sin(t * Math.PI);
      const p = surf(Math.min(0.735, z), th, 0.016);
      if (t > 0.5) p.x = -Math.abs(p.x);
      else p.x = Math.abs(p.x);
      if (i === 5) p.set(0, 1.03, 0.785);
      breast.push(p);
    }
    cord(breast, ['Body', 'Chest', 'Neck1', 'ScapL', 'ScapR']);
    const crupLoop = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12; // left saddle → under the tail → right saddle
      const z = -0.07 - 0.76 * Math.sin((t * Math.PI) / 1);
      const th = 0.85 - 0.25 * Math.sin(t * Math.PI);
      const p = surf(Math.max(-0.82, z), th, 0.016);
      p.x = t > 0.5 ? -Math.abs(p.x) : Math.abs(p.x);
      if (i === 6) p.set(0, 1.17, -0.85);
      crupLoop.push(p);
    }
    cord(crupLoop, ['Body', 'Pelvis', 'Tail1']);
    // cords across the croup, from one side of the loop to the other
    for (const z of [-0.3, -0.56]) {
      const pts = [];
      for (let i = 0; i <= 8; i++) pts.push(surf(z, 0.95 + (Math.PI - 1.9) * (i / 8), 0.017));
      cord(pts, ['Body', 'Pelvis']);
      // tassels (fusa) hanging from the cord ends on both flanks
      for (const p of [pts[0], pts[8]]) cloth.push(tassel(rig, p, 0.13, 'Pelvis'));
    }
    cloth.push(tassel(rig, new THREE.Vector3(0, 1.02, 0.8), 0.15, 'Chest'));
    for (const sx of [1, -1]) cloth.push(tassel(rig, surf(0.62, 0.15, 0.03).setX(sx * Math.abs(surf(0.62, 0.15, 0.03).x)), 0.1, 'Chest'));
  }
  // bridle: crownpiece behind the ears, browband, cheek pieces down to the bit, noseband, throatlash; iron bit rings
  const bits = [];
  {
    const head = (s, th, off) => headAt(s, th, off, new THREE.Vector3());
    const cords = [];
    const ring = (s, off, th0 = 0, th1 = Math.PI * 2, n = 16) => {
      const pts = [];
      for (let i = 0; i <= n; i++) pts.push(head(s, th0 + (th1 - th0) * (i / n), off));
      return pts;
    };
    cords.push(ring(0.045, 0.012));
    cords.push(ring(0.11, 0.012, Math.PI * 0.2, Math.PI * 0.8, 8));
    cords.push(ring(0.6, 0.01));
    for (const sx of [1, -1]) {
      const pts = [];
      for (let i = 0; i <= 8; i++) {
        const s = 0.045 + (0.78 - 0.045) * (i / 8);
        const th = sx > 0 ? -0.15 - 0.25 * (i / 8) : Math.PI + 0.15 + 0.25 * (i / 8);
        pts.push(head(s, th, 0.012));
      }
      cords.push(pts);
      const bp = head(0.8, sx > 0 ? -0.45 : Math.PI + 0.45, 0.014);
      bits.push(bp.clone());
      const g = new THREE.TorusGeometry(0.026, 0.0045, 6, 16);
      g.rotateY(Math.PI / 2);
      g.translate(bp.x, bp.y, bp.z);
      paint(g, col(C.iron));
      rigidSkin(g, rig, 'Head');
      lacquer.push(g);
    }
    for (const pts of cords) {
      const g = tube(pts, 0.008, 5);
      paint(g, red);
      rigidSkin(g, rig, 'Head');
      cloth.push(g);
    }
  }

  // ---- assemble ---------------------------------------------------------------------------------------------
  const mats = materials();
  const root = new THREE.Group();
  root.name = 'horse';
  root.add(rig.root);
  const meshes = [];
  const make = (parts, m, name) => {
    const geo = mergeParts(parts);
    geo.computeBoundingSphere();
    const mesh = new THREE.SkinnedMesh(geo, m);
    mesh.name = 'horse-' + name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    root.add(mesh);
    mesh.bind(rig.skeleton);
    meshes.push(mesh);
    return mesh;
  };
  make(coat, mats.coat, 'coat');
  make(hair, mats.hair, 'hair');
  make(lacquer, mats.lacquer, 'lacquer');
  make(cloth, mats.cloth, 'cloth');

  // seat frame on the Body bone: the rider's pelvis rests here
  const seat = new THREE.Object3D();
  seat.name = 'horse-seat';
  seat.position.copy(SEAT).sub(R.Body);
  rig.bones.Body.add(seat);
  const stirrups = [1, -1].map((sx) => {
    const o = new THREE.Object3D();
    o.position.set(sx * STIRRUP.x, STIRRUP.y, STIRRUP.z).sub(R.Body);
    rig.bones.Body.add(o);
    return o;
  });
  const bitObjs = bits.map((p) => {
    const o = new THREE.Object3D();
    o.position.copy(p).sub(R.Head);
    rig.bones.Head.add(o);
    return o;
  });
  const pommel = new THREE.Object3D();
  pommel.position.set(0, 1.47, 0.36).sub(R.Body);
  rig.bones.Body.add(pommel);
  return { root, rig, meshes, mats, seat, stirrups, bits: bitObjs, pommel };
}

const _v2 = new THREE.Vector3();

// hoof capsule: horizontal rings from the coronet down to the sole, the toe wall sloping at ~52°. Each ring is
// [height above the coronet (m), half-width, half-length, forward shift of its centre from the coronet] in the hoof
// bone's frame (the coronet 0.072 m above the sole); scripts/horse.test.mjs measures the hooves' clearance from it.
export const HOOF_RINGS = [
  [0.004, 0.044, 0.046, 0],
  [-0.01, 0.047, 0.05, 0.008],
  [-0.042, 0.052, 0.056, 0.022],
  [-0.064, 0.055, 0.06, 0.03],
  [-0.072, 0.054, 0.058, 0.03],
];
function hoofMesh(rig, bone, coronet, sole) {
  const rings = HOOF_RINGS.map(([y, rx, rz, dz]) => ({ c: [coronet.x, coronet.y + y, coronet.z + dz], ax: [1, 0, 0], ay: [0, 0, 1], rx, ry: rz }));
  const g = loft(rings, { seg: 14, tile: 0.1, capEnd: true });
  colorize(g, (p, c) => c.set(C.hoof).lerp(new THREE.Color('#4a3e34'), smooth(0.07, 0.02, p.y) * 0.4));
  rigidSkin(g, rig, bone);
  void sole;
  return g;
}

// a tassel (fusa): a knot and a flaring skirt of cord, hanging from p
function tassel(rig, p, len, bone) {
  const g = lathe(
    [[0.0, 0], [0.012, -0.006], [0.014, -0.022], [0.009, -0.03], [0.016, -0.045], [0.026, -len * 0.8], [0.03, -len], [0.0, -len]].map(([r, y]) => [r, y]),
    10
  );
  g.translate(p.x, p.y, p.z);
  paint(g, col(C.vermilion));
  rigidSkin(g, rig, bone);
  return g;
}

function stirrupMesh(rig, sx) {
  const S = new THREE.Vector3(sx * STIRRUP.x, STIRRUP.y, STIRRUP.z);
  const L = 0.27, W = 0.058;
  const parts = [];
  const lac = col(C.lacquer), red = col(C.vermilion);
  // tread: a long shallow tray, its back end slightly raised
  const tread = thickSurface(
    (u, v, o) => {
      const z = S.z - L * 0.62 + L * u;
      const x = S.x + (v - 0.5) * 2 * W * (0.85 + 0.15 * Math.sin(u * Math.PI));
      o.set(x, S.y - 0.012 + 0.03 * Math.pow(1 - u, 3) + 0.012 * Math.pow(Math.abs(v - 0.5) * 2, 3), z);
    },
    8, 4, { thickness: 0.012 }
  );
  colorize(tread, (p, c) => c.copy(p.y > S.y - 0.006 ? red : lac));
  parts.push(tread);
  // hood over the toes, curling up into the swan neck under the strap
  const hood = thickSurface(
    (u, v, o) => {
      const a = (u - 0.5) * Math.PI * 0.95;
      const z = S.z + L * 0.38 - 0.1 * v;
      const r = W * (1 - 0.2 * v);
      o.set(S.x + Math.sin(a) * r, S.y + 0.005 + Math.cos(a) * r * 1.1 + 0.07 * v * v, z + 0.03 * Math.cos(a) * (1 - v));
    },
    8, 5, { thickness: 0.01, flipNormal: sx < 0 }
  );
  paint(hood, lac);
  parts.push(hood);
  const neck = tube(
    [new THREE.Vector3(S.x, S.y + 0.1, S.z + L * 0.3), new THREE.Vector3(S.x, S.y + 0.17, S.z + 0.08), new THREE.Vector3(S.x, S.y + 0.205, S.z + 0.06)],
    0.012, 6
  );
  paint(neck, lac);
  parts.push(neck);
  for (const g of parts) rigidSkin(g, rig, 'Body');
  return parts;
}
