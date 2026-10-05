import { aero, stallSpeed } from './flight.js';

// The birds of Hoshigashima in autumn, with the numbers their flight and their behaviour are built from (SI units).
// Sources for the orders of magnitude: body masses, wing spans and areas from field guides and flight-morphology
// tables (Rayner, Pennycuick); flight speeds from radar / video studies (crows cruise 10–14 m/s, sparrows 8–10 m/s);
// wingbeat frequencies (crows ~3–4 Hz, sparrows 12–15 Hz); flight-initiation distances from urban / rural studies
// (crows ~8–12 m from a walker, small passerines ~5–8 m, farther from a runner, a horse or a fight).
//
//   flock      [min, max] members              hipH        feet → hip joint, standing (m)
//   cruise     airspeed in transit (m/s)        cruiseAGL   transit height over the ground (m)
//   clear      margin kept over crowns / roofs   flapHz      wingbeat [cruise, full effort] (Hz)
//   flapAmp    stroke half-amplitude [cruise, full effort] (rad)
//   upFlex     how far the hand flexes back at the wrist in the upstroke [cruise, full effort] (rad)
//   pattern    'flapglide' (crow), 'bound' (passerine: bursts of beats with the wings shut between), 'soar' (kite)
//   approach   landing: glide slope (rad), gate distance (m), deceleration (m/s²), flare distance (m)
//   leap       take-off jump speed (m/s) and angle above the horizontal (rad) from the ground / from a perch
//   fid        flight-initiation distance from a calm walker (m): on the ground, in a tree (cover), on a roof / torii
//   walk       ground locomotion: 'walk' (crow: steps, head bobbing) or 'hop' (sparrow: two-footed hops)

export const SPECIES = {
  crow: {
    name: 'crow',
    label: 'jungle crow (hashibuto-garasu)',
    // Corvus macrorhynchos japonensis: ~0.55 m bill to tail, ~1 m span
    mass: 0.65,
    span: 1.0,
    S: 0.135,
    CD0: 0.028,
    e: 0.75,
    CLmax: 1.3,
    flapLift: 1.7,
    flapPower: 24,
    brakeG: 0.55,
    flareCD: 1.1,
    length: 0.56,
    hipH: 0.155,
    flock: [2, 6],
    cruise: 11.5,
    cruiseAGL: 14,
    clear: 3,
    accel: 6,
    flapHz: [3.2, 4.8],
    flapAmp: [0.55, 1.1],
    upFlex: [0.95, 1.3],
    pattern: 'flapglide',
    flapTime: [1.6, 4],
    glideTime: [0.8, 2.2],
    approach: { slope: 0.33, gate: 16, decel: 3.6, flare: 2.4, look: 9 },
    leap: { ground: [2.6, 0.95], perch: [1.6, 0.25] },
    crouch: 0.18,
    fid: { ground: 8.5, tree: 6, prop: 7 },
    alertK: 2.0,
    walk: 'walk',
    walkSpeed: 0.42,
    stepHz: 2.3,
    patch: 4,
    spacing: 0.7,
    restTime: [25, 80],
    perchTiers: ['top', 'outer'],
    scaleVar: 0.07,
  },
  sparrow: {
    name: 'sparrow',
    label: 'Eurasian tree sparrow (suzume)',
    // Passer montanus: ~14 cm, ~21 cm span, ~22 g
    mass: 0.022,
    span: 0.21,
    S: 0.0085,
    CD0: 0.035,
    e: 0.72,
    CLmax: 1.4,
    flapLift: 2.4,
    flapPower: 1.4,
    brakeG: 0.8,
    flareCD: 1.2,
    length: 0.14,
    hipH: 0.042,
    flock: [8, 25],
    cruise: 9,
    cruiseAGL: 4.5,
    clear: 1.5,
    accel: 12,
    flapHz: [13, 16],
    flapAmp: [0.8, 1.15],
    upFlex: [1.05, 1.4],
    pattern: 'bound',
    burstBeats: [3, 5],
    boundTime: [0.12, 0.26],
    approach: { slope: 0.36, gate: 6, decel: 6.5, flare: 0.75, look: 3 },
    leap: { ground: [1.7, 1.05], perch: [1.2, 0.5] },
    crouch: 0.06,
    fid: { ground: 5.2, tree: 2.5, prop: 3 },
    alertK: 1.8,
    walk: 'hop',
    hopLen: [0.06, 0.13],
    hopTime: 0.11,
    patch: 3,
    spacing: 0.16,
    restTime: [15, 50],
    perchTiers: ['inner', 'outer'],
    scaleVar: 0.06,
  },
  kite: {
    name: 'kite',
    label: 'black kite (tobi)',
    // Milvus migrans lineatus: ~0.6 m, ~1.55 m span; soars on fixed wings, steering with its twisting, notched tail
    mass: 0.85,
    span: 1.55,
    S: 0.32,
    CD0: 0.022,
    e: 0.8,
    CLmax: 1.5,
    flapLift: 1.3,
    flapPower: 20,
    brakeG: 0.45,
    flareCD: 1.0,
    length: 0.6,
    hipH: 0.15,
    flock: [1, 1],
    cruise: 9.5,
    cruiseAGL: 70,
    clear: 10,
    accel: 4,
    flapHz: [2.2, 3],
    flapAmp: [0.35, 0.6],
    upFlex: [0.5, 0.75],
    pattern: 'soar',
    approach: { slope: 0.3, gate: 20, decel: 3, flare: 2.5, look: 10 },
    leap: { ground: [2, 0.8], perch: [1.5, 0.2] },
    crouch: 0.2,
    fid: { ground: 20, tree: 12, prop: 14 },
    alertK: 1.6,
    walk: 'walk',
    walkSpeed: 0.3,
    stepHz: 1.6,
    patch: 4,
    spacing: 2,
    restTime: [60, 120],
    perchTiers: ['top'],
    scaleVar: 0.05,
  },
};

for (const sp of Object.values(SPECIES)) {
  sp.aero = aero(sp);
  sp.vStall = stallSpeed(sp.aero);
}

// The ground mammals (mammals.js: behaviour; quad.js: bodies, gaits, legs; beasts.js: meshes). Numbers in SI units.
// Sources for the orders of magnitude: red fox 5–7 kg, 0.35–0.4 m at the withers, trots at 2–3 m/s (its travelling
// gait), gallops at 8–13 m/s (~14 m/s flat out); sika deer hinds 30–45 kg and 0.75–0.85 m, stags 50–70 kg and
// 0.9–1.0 m, groups of hinds and young of 2–8 in autumn with a stag at the rut, flight ~11–14 m/s; flight-initiation
// distances from walkers in rural studies: foxes ~20–30 m, deer ~30–50 m (more from a runner, a rider, dogs).
//
//   ground     true: a mammal (WildlifeSim dispatches it to a Herd; no flight model)
//   body       the skeleton in quad.js; forms: the meshes of beasts.js (a calf is a scaled hind)
//   group      [min, max] animals in a group
//   speeds     m/s of its gaits as the brain uses them: walk (grazing steps are slower), trot, run (flight)
//   accel      m/s² starting / braking
//   fid        flight-initiation distance from a calm walker (m); alertK: alert within alertK × fid
//   safe       a fleeing animal stops (and looks back) beyond safe × fid from the threat
//   hear       noises carry this much farther for it (×)
export const MAMMALS = {
  fox: {
    name: 'fox',
    label: 'red fox (kitsune)',
    ground: true,
    body: 'fox',
    mass: 6,
    group: [1, 1],
    speeds: { walk: 0.8, sniff: 0.35, trot: 2.6, run: 10.5 },
    accel: 9,
    decel: 12,
    fid: { ground: 22 },
    alertK: 2.2,
    safe: 2.4,
    hear: 1.3,
    scaleVar: 0.05,
    clearance: 0.18, // m kept from trunks, walls, rocks
  },
  deer: {
    name: 'deer',
    label: 'sika deer (shika)',
    ground: true,
    body: 'deer',
    mass: 40,
    group: [3, 6],
    speeds: { walk: 1.1, graze: 0.35, trot: 3.2, run: 11.5 },
    accel: 7,
    decel: 9,
    fid: { ground: 32 },
    alertK: 2.0,
    safe: 2.6,
    hear: 1.6,
    scaleVar: 0.04,
    clearance: 0.35,
  },
};

// every animal of the module by name (the population and the spawner look them up here)
export const ANIMALS = { ...SPECIES, ...MAMMALS };

// Flocks / groups per species by quality preset (the population around the player, within ~150 m for the birds and
// ~180 m for the mammals)
export const POPULATION = {
  low: { crow: 1, sparrow: 1, kite: 0, fox: 1, deer: 1 },
  medium: { crow: 2, sparrow: 1, kite: 1, fox: 1, deer: 1 },
  high: { crow: 3, sparrow: 2, kite: 1, fox: 1, deer: 2 },
  ultra: { crow: 4, sparrow: 3, kite: 1, fox: 2, deer: 2 },
};
