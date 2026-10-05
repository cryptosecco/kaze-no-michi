// Quality presets. Every system reads its budget from here; the pause menu can switch preset at runtime
// (systems that cannot rebuild live pick up the change on reload).

export const PRESETS = {
  low: {
    name: 'low',
    maxDpr: 1,
    renderScale: 0.72,
    msaa: 0,
    shadowMapSize: 1024,
    shadowFar: 140,
    grassDensity: 0.4,
    grassNear: 32,
    grassMid: false,
    pampasDensity: 0.45,
    terrainLodDist: 260,
    bloom: true,
    dynamicResolution: true,
  },
  medium: {
    name: 'medium',
    maxDpr: 1,
    renderScale: 0.88,
    msaa: 2,
    shadowMapSize: 2048,
    shadowFar: 200,
    grassDensity: 0.65,
    grassNear: 40,
    grassMid: true,
    pampasDensity: 0.7,
    terrainLodDist: 340,
    bloom: true,
    dynamicResolution: true,
  },
  high: {
    name: 'high',
    maxDpr: 1.25,
    renderScale: 1.0,
    msaa: 4,
    shadowMapSize: 2048,
    shadowFar: 260,
    grassDensity: 1.0,
    grassNear: 46,
    grassMid: true,
    pampasDensity: 1.0,
    terrainLodDist: 420,
    bloom: true,
    dynamicResolution: true,
  },
  ultra: {
    name: 'ultra',
    maxDpr: 2,
    renderScale: 1.0,
    msaa: 4,
    shadowMapSize: 4096,
    shadowFar: 360,
    grassDensity: 1.35,
    grassNear: 52,
    grassMid: true,
    pampasDensity: 1.3,
    terrainLodDist: 560,
    bloom: true,
    dynamicResolution: false,
  },
};

export function getPreset(name) {
  return { ...(PRESETS[name] || PRESETS.high) };
}
