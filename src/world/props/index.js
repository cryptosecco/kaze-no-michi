// Architecture & props module: shrine hill (stairs, torii, lanterns, gate hall, honden, sky torii),
// five-storey pagoda, farmhouse + bandit camp, cliff shrine, and scattered roadside detail.
// Everything is merged per material and site (few draw calls), weathered in vertex colours and in
// world-space shaders, and registered with game.colliders / game.addGroundOverride.
//
// Returned API (game.modules.props):
//   sites.shrine  { steps, landings, torii[], lanterns[], gate, honden, prayer{x,y,z,facing}, skyTorii,
//                   meditation{x,y,z,facing}, stairsTopY, plazaY, frame{base,u,X} }
//   sites.pagoda  { x, y, z, height, radius }
//   sites.camp    { house{x,y,z,yaw}, fire{x,y,z}, yard{x,z,r}, tents[], banners[] }
//   sites.cliff   { torii, bench{x,y,z,facing}, edge }
//   sites.roadside{ jizo[], hokora[], rocks, fences }
import { SHOTS } from '../../core/shots.js';
import { getMaterials } from './materials.js';
import { buildShrineHill } from './shrine.js';
import { sunDirection } from '../Lighting.js';
import { buildPagoda } from './pagoda.js';
import { buildCamp, CAMP_VIEW } from './camp.js';
import { buildCliff, buildRoadside } from './details.js';
import { clearTrees } from './clearings.js';
import { CAMP_CLEARINGS } from '../Layout.js';

export async function install(game, ctx) {
  const t0 = performance.now();
  const mats = getMaterials();
  const sites = {};
  const add = (name, group) => {
    game.add(group);
    sites[name] = group.userData.info;
    return group;
  };

  // the sky torii sits under the setting sun as seen from the canonical field shot
  const s1 = SHOTS.S1_field;
  const s1Pos = s1.pose(game.terrain).pos;
  const sun = sunDirection(s1.hours);
  const sunAz = (Math.atan2(sun.x, -sun.z) * 180) / Math.PI;
  add('shrine', buildShrineHill(game, mats, { viewer: { x: s1Pos[0], z: s1Pos[2] }, sunAz }));
  add('pagoda', buildPagoda(game, mats));
  add('camp', buildCamp(game, mats));
  add('cliff', buildCliff(game, mats));

  // clear trees that stand inside building footprints / sight lines (the trees module installs first)
  const sh = sites.shrine, st = sh.skyTorii;
  const cleared = clearTrees(game, [
    { x: sites.pagoda.x, z: sites.pagoda.z, r: sites.pagoda.radius + 9 },
    { x: sh.gate.x, z: sh.gate.z, r: 11 },
    { x: sh.honden.x, z: sh.honden.z, r: 8.5 },
    { x: st.x, z: st.z, r: 12 }, // no tree crowns behind or beside the silhouette
    { x: sh.meditation.x, z: sh.meditation.z, r: 3 },
    ...skyToriiSightLines(s1Pos, st),
    ...CAMP_CLEARINGS, // farmhouse, fire and S5 view line (the S5 hero ginkgos are planted outside them)
    { x: sites.cliff.torii.x, z: sites.cliff.torii.z, r: 7 },
  ]);
  // roadside detail last: it avoids trees and the other sites
  add('roadside', buildRoadside(game, mats));

  registerShots(game, sites);
  const ms = performance.now() - t0;
  console.info(`[props] built in ${ms.toFixed(0)} ms (cleared ${cleared} trees, ${sites.roadside.features} roadside features)`);
  return { sites, buildMs: ms };
}

// The sky torii must stand clear against the sun from the field: 3D sight lines { x, y, z, x2, y2, z2, r } from the
// S1 camera to its mid-height (continued 80 m beyond it, the sky behind) and to its crossbeams, for trees.clear().
// Only crowns that really cut the view go, so the canopy along the shrine stairs (well below the line) stays.
// Exported for scripts/shrine.test.mjs (the S2 heroes must stay clear of them).
export function skyToriiSightLines(s1Pos, st) {
  const k = 80 / Math.hypot(st.x - s1Pos[0], st.z - s1Pos[2]);
  return [
    { x: s1Pos[0], y: s1Pos[1], z: s1Pos[2], x2: st.x + (st.x - s1Pos[0]) * k, y2: st.y + 5.3 + (st.y + 5.3 - s1Pos[1]) * k, z2: st.z + (st.z - s1Pos[2]) * k, r: 6 },
    { x: s1Pos[0], y: s1Pos[1], z: s1Pos[2], x2: st.x, y2: st.y + 11, z2: st.z, r: 4 },
  ];
}

function registerShots(game, sites) {
  const sh = sites.shrine;
  const B = sh.frame.base, u = sh.frame.u;
  // mid-stairs, looking up at the torii rhythm and the gate hall
  SHOTS.T6_stairs = {
    hours: 16.55,
    fov: 50,
    t0: 9,
    pose() {
      const s = 24;
      const x = B.x + u.x * s, z = B.z + u.z * s;
      return { pos: [x, game.groundAt(x, z) + 1.7, z], target: [sh.gate.x, sh.gate.y + 6, sh.gate.z] };
    },
  };
  // S2 framing: a raised view from the right half of the second flight up the broad stairs, turned left of their
  // axis: the gate hall in the upper right third with the low sun behind it, the golden and crimson crowns of the
  // left flank over the left curb, dark pines rising at the right edge. The right flank higher up stays low (the
  // S1 → sky torii sight line runs over it), so the right-edge pines stand near the camera.
  SHOTS.T6_S2 = {
    hours: 16.3,
    fov: 42,
    t0: 9,
    pose() {
      const s = 20, lat = -3.2, h = 4.6, yaw = 12, pitch = 18; // stair coords, metres above the steps, degrees
      const X = sh.frame.X;
      const x = B.x + u.x * s + X.x * lat, z = B.z + u.z * s + X.z * lat;
      const y = game.groundAt(x, z) + h;
      const az = Math.atan2(u.x, -u.z) - (yaw * Math.PI) / 180, p = (pitch * Math.PI) / 180;
      const d = [Math.sin(az) * Math.cos(p), Math.sin(p), -Math.cos(az) * Math.cos(p)];
      return { pos: [x, y, z], target: [x + d[0] * 100, y + d[1] * 100, z + d[2] * 100] };
    },
  };
  // summit: from beside the approach toward the gate hall
  SHOTS.T6_summit = {
    hours: 17.4,
    fov: 55,
    t0: 3,
    pose(terrain) {
      const p = { x: sh.gate.x + u.x * 11 - sh.frame.X.x * 9, z: sh.gate.z + u.z * 11 - sh.frame.X.z * 9 };
      return { pos: [p.x, terrain.heightAt(p.x, p.z) + 1.7, p.z], target: [sh.gate.x, sh.gate.y + 4, sh.gate.z] };
    },
  };
  // the sky torii against the low sun: the canonical field camera, zoomed in on the summit
  SHOTS.T6_skytorii = {
    hours: SHOTS.S1_field.hours,
    fov: 7,
    t0: 14,
    pose(terrain) {
      const st = sh.skyTorii;
      return { pos: SHOTS.S1_field.pose(terrain).pos, target: [st.x, st.y + 5, st.z] };
    },
  };
  // pagoda on the ridge, from the path below
  SHOTS.T6_pagoda = {
    hours: 17.5,
    fov: 45,
    t0: 6,
    pose(terrain) {
      const pg = sites.pagoda;
      const px = 36.5, pz = pg.z + 90;
      return { pos: [px, terrain.heightAt(px, pz) + 1.7, pz], target: [pg.x, pg.y + 17, pg.z] };
    },
  };
  // an alternative S5 framing (the canonical S5_ginkgo is built from Layout): on the path at the camp entrance, the
  // thatched farmhouse centre frame
  const cp = sites.camp;
  SHOTS.T6_S5 = {
    hours: 17.3,
    fov: 52,
    t0: 17,
    pose(terrain) {
      const p = CAMP_VIEW;
      return { pos: [p.x, terrain.heightAt(p.x, p.z) + 1.7, p.z], target: [cp.house.x, cp.house.y + 4.2, cp.house.z] };
    },
  };
  // the ending: the cliff torii against the sea at sunset
  const cl = sites.cliff;
  SHOTS.T6_cliff = {
    hours: 18.0,
    fov: 50,
    t0: 4,
    pose(terrain) {
      const px = cl.torii.x + 16, pz = cl.torii.z + 5;
      return { pos: [px, terrain.heightAt(px, pz) + 1.7, pz], target: [cl.torii.x - 30, cl.torii.y + 2, cl.torii.z - 3] };
    },
  };
}
