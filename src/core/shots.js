import { POI } from '../world/Layout.js';

// Canonical shots (npm run shots). Each resolves camera pose from the terrain
// so the framing survives terrain tweaks. `t0` = wind time at capture (deterministic), hours = time of day.

const lerp = (a, b, t) => a + (b - a) * t;
const D2R = Math.PI / 180;

// Camera aimed by compass azimuth (degrees clockwise from north = -Z) and pitch (degrees, + up).
export function aim(pos, azDeg, pitchDeg) {
  const az = azDeg * D2R, p = pitchDeg * D2R;
  const d = [Math.sin(az) * Math.cos(p), Math.sin(p), -Math.cos(az) * Math.cos(p)];
  return { pos, target: [pos[0] + d[0] * 100, pos[1] + d[1] * 100, pos[2] + d[2] * 100] };
}

// Optional per-shot `sky` overrides (weather; every field left out goes back to Sky.defaults):
// { sunSize (cinematic sun disc scale), sunLift (degrees the drawn disc, its glow and the light shafts' origin sit
// above the true sun, whose light, haze and shadows are kept: a giant disc resting above the hills instead of
// sinking behind them; render/drawnSun.js),
// sunDisc (disc brightness, 1 = palette; a giant disc needs less to read
// as a disc instead of a clipped blob), sunHalo (aureole around the sun, shared with the atmosphere's glow;
// > 1 = hazy milky sky, < 1 = clean disc on a clear sky), cloudCover (0..1), cloudDark (1 = palette, lower =
// storm: dark grey deck overhead, pale air between, lit masses low), cloudGlow (1 = palette, > 1 = the sunlit cloud
// sides brighten and, under a storm deck, so does the pale air low in the sky: the breaks glow, the deck stays dark),
// cloudScale (< 1 = bigger masses), cloudSoft (edge ramp, default 0.12), cloudOffset [x, y] (which part of the
// cloud field is overhead) }.
export const SHOTS = {
  S1_field: {
    hours: 18.0,
    fov: 50,
    // the moment a gust front rolls in: in the still it shines across the field behind the samurai; in the frame
    // sequence it sweeps over the field toward the camera and through the near susuki, the plumes swinging in a wave
    // and the cape filling out (16.35 kept the near field in the lull for the whole sequence: it read as still)
    t0: 17.0,
    // scattered soft cumulus, frayed, lit from the sun side, with teal gaps between the masses; the low sun a
    // glowing disc above the crest beside the torii: drawn 0.8° above the true sun, so it clears the stair canopy
    // (trees/placement.js keeps the random crowns out of it); a mild aureole (a stronger one turns the teal milky)
    sky: { cloudCover: 0.4, cloudSoft: 0.1, cloudScale: 1.2, cloudOffset: [1.4, 0.2], sunHalo: 1.3, sunSize: 1.4, sunLift: 0.8 },
    // backlit golden hour: under the default exposure, a lighter warm split (it crushed the blue out of the field's
    // shadows), a touch cooler (teal sky, amber rather than red field) and a moderate vignette
    post: { exposure: 0.74, contrast: 1.15, saturation: 1.1, vignette: 0.42, splitStrength: 0.12, warmth: -0.2 },
    pose(terrain) {
      // from a rise on the east side of the basin, looking west across the susuki toward the shrine hill
      // (420 m, centre-left) with the low sun (az ≈ 255°, el ≈ 6.5°) just above-left of it; camera a little above
      // the samurai's hat (looking down on the kasa), pitched down so the glowing field fills the lower two thirds
      const px = 150, pz = 90;
      return aim([px, terrain.heightAt(px, pz) + 3.1, pz], 265, -7);
    },
  },
  S2_shrine: {
    // the broad flights climbing to the gate hall in a warm low key, the steps and the flanking canopy in shade, the
    // low sun (az ≈ 233°, el ≈ 23.4°) burning behind the roof with shafts pouring down the stairs. The true sun sits
    // behind the hall (its light keeps the steps in the hall's shade); the drawn disc, its glow and the shafts' origin are
    // lifted 5.5° onto the crest of the roof, right above the gate passage. The shafts are the sky smeared away from the
    // drawn sun, so they fall where sky shows between the sun and the stairs: through the passage, which stands in the
    // sun's aureole. With the sun at the roof's right shoulder (16.6 h, lift 7) the hall stood between it and the steps:
    // what reached them was a small fraction of the haze the same shafts threw over the right pine
    hours: 16.3,
    // a hazy golden afternoon: at 23° the palette's own sky is cool grey-lilac, so the aureole is set to its ceiling
    // (sunHalo 3.5: the weather mixes 75 % of the forward-scattered cream-gold into the whole sky; 2.2 left the sky
    // away from the sun lilac-grey), a larger disc so the sun reads as a burning disc at the roof's crest, few clouds
    sky: { sunHalo: 3.5, sunLift: 5.5, sunSize: 1.6, cloudCover: 0.2 },
    // warm low key: an amber grade (warmth 0.8: the steps turn warm brown, the sky peach-cream instead of grey) at a low
    // exposure, no contrast crush of the dark channels (the dark steps stay brown stone, not red-black); the shafts are
    // back (0.8; at 0.15 they were gone and the steps flat grey), strong enough to read as beams on the dark steps while
    // the right pine keeps its needles readable under a light golden haze; a heavy vignette (the flanks fall into
    // silhouette) and a graduated shade that sinks the foreground steps so the shafts stand out
    post: { warmth: 0.8, splitStrength: 0.04, godRays: 0.8, exposure: 0.68, contrast: 1.0, saturation: 0.95, vignette: 0.7, groundShade: 0.3 },
    fov: 38,
    t0: 9,
    pose(terrain) {
      // the props module registers the S2 framing (last landing → gate hall) once the stairs exist
      let p;
      if (SHOTS.T6_S2) p = SHOTS.T6_S2.pose(terrain);
      else {
        const s = POI.shrine;
        const px = s.stairsBase.x - s.stairDir.x * 9, pz = s.stairsBase.z - s.stairDir.z * 9;
        const tx = s.stairsTop.x, tz = s.stairsTop.z;
        p = { pos: [px, terrain.heightAt(px, pz) + 1.7, pz], target: [tx, terrain.heightAt(tx, tz) + 7, tz] };
      }
      // turned 3° left and 2° up, through a slightly longer lens: the hall right of centre and larger, the
      // torii at the foot of the right flank (cut by the frame's corner) out of the frame
      const d = [p.target[0] - p.pos[0], p.target[1] - p.pos[1], p.target[2] - p.pos[2]];
      const az = Math.atan2(d[0], -d[2]) / D2R, pitch = Math.atan2(d[1], Math.hypot(d[0], d[2])) / D2R;
      return aim(p.pos, az - 3, pitch + 2);
    },
  },
  S3_standoff: {
    // el ≈ 2.9°, between the crimson 1.5° key and the orange 4° key: crimson-orange light instead of pure red
    hours: 18.33,
    fov: 38,
    // a giant pale disc, whole above the hills, crossed by thin cloud streaks, under a streaky crimson-orange
    // deck that darkens overhead. Centred on the true sun (el ≈ 2.9°) a disc this size (radius 4.2°) would sink half
    // behind the island's western hills (2–3.3° high within ±4° of the sun from here): it is drawn 4° higher, the
    // lowest it sits whole, resting on the hills (the light keeps the true sun)
    sky: { sunSize: 9, sunLift: 4.0, sunDisc: 0.15, sunHalo: 0.6, cloudCover: 0.6, cloudScale: 2.2, cloudSoft: 0.18, cloudDark: 0.7 },
    // a red grade that keeps the local colours: less saturation, and no split-tone or contrast crush of the dark
    // channels (both drove the figures and the grass to pure red); a heavier vignette darkens the top of the sky;
    // a graduated shade sinks the field in front of the duel into a dark foreground (the backlit plumes on
    // the horizon and the figures above it keep their light)
    post: {
      exposure: 0.52, saturation: 1.05, warmth: 1.1, contrast: 1, splitStrength: 0.05, vignette: 0.45, bloomStrength: 0.3,
      groundShade: 0.55,
      // focus on the duel (the samurai at 7 m, the bandits at 6.4–8.8 m)
      dofAperture: 0.5, dofFocus: 7.2, dofMaxBlur: 7,
    },
    t0: 21,
    pose(terrain) {
      // telephoto, low in the grass, the huge sun (az ≈ 259°, el ≈ 3°) setting over low hills ~12° left
      const px = 40, pz = -20;
      return aim([px, terrain.heightAt(px, pz) + 1.45, pz], 272, 1.2);
    },
  },
  S4_title: {
    hours: 17.95,
    // a long lens: the shrine hill and its torii large on the right, in silhouette against the low sun just above-left
    // of the torii; the title calligraphy and menu sit on the left third, over a full maple at the frame's edge
    fov: 24,
    t0: 5,
    // soft golden cumulus with teal gaps overhead, the sun's disc and glow clear of them, a wide golden aureole
    sky: { cloudCover: 0.44, cloudSoft: 0.1, cloudScale: 1.2, cloudOffset: [1.4, 0.2], sunHalo: 1.5, sunSize: 1.5 },
    // the backlit golden-hour grade of S1 (the title applies it too while it shows)
    post: { exposure: 0.78, contrast: 1.12, saturation: 1.1, vignette: 0.45, splitStrength: 0.12 },
    pose(terrain) {
      // title backdrop: 470 m east-north-east of the sky torii, over the susuki falling toward the basin, the low sun
      // (az ≈ 254°, el ≈ 7°) 2° left of the torii; low enough that the field's plumes rise to the foot of the hill
      // through the long lens, high enough that the shot's staged samurai (11 m ahead) stays below the frame
      const px = 195, pz = 41;
      return aim([px, terrain.heightAt(px, pz) + 4.5, pz], 250.5, 1);
    },
  },
  S5_ginkgo: {
    // the farmhouse from its front yard (POI.camp.view, 36 m NNE of the house) looking SSW, pitched up ~9°;
    // the low sun (az ≈ 244°, el ≈ 15°) breaks through at the right edge of the frame beside the backlit ginkgo,
    // their long shadows falling left of the yard; the house spans ~45% of the frame height and 44–76% of its
    // width; heavy clouds overhead. Built from Layout, not from the props module's shots: the trees are planted
    // from this frame before that module loads.
    hours: 17.15,
    fov: 50,
    t0: 17,
    // storm deck: dark grey-brown masses overhead, the breaks low behind the house and toward the sun glowing cream
    sky: { cloudCover: 0.55, cloudDark: 0.15, cloudGlow: 2.8, cloudSoft: 0.08, cloudScale: 0.7, cloudOffset: [-0.6, 1.8] },
    // the default grade turned this scene olive: its saturation (1.2), its yellow split tone and its contrast around
    // 0.18 in display space (which zeroes every channel under ~0.016) crushed the blue out of the grey-brown thatch,
    // the storm greys and the shadows, leaving dark yellow. Here: no crush, a near-neutral saturation and a warmer
    // balance, so the thatch reads grey-brown, the shadows warm brown and the clouds brown-grey; a little more bloom
    // around the glowing breaks and a deeper vignette (dark corners)
    post: { exposure: 1.0, contrast: 1.0, saturation: 0.97, splitStrength: 0.05, warmth: 0.42, bloomStrength: 0.35, vignette: 0.45 },
    pose(terrain) {
      const H = POI.camp.house, V = POI.camp.view;
      let gy = Infinity;
      for (const [dx, dz] of [[0, 0], [-7, -5], [7, -5], [-7, 5], [7, 5]]) gy = Math.min(gy, terrain.heightAt(H.x + dx, H.z + dz));
      // the house right of centre (44–76% of the width): the lens stands 2 m left of the viewpoint and turns
      // left (from further left a hero maple and a banner would rise behind the fire's flame: scripts/camp.test.mjs)
      const fx = H.x - V.x, fz = H.z - V.z, L = Math.hypot(fx, fz);
      const lx = fz / L, lz = -fx / L; // unit vector to the left of the view
      const px = V.x + lx * 2, pz = V.z + lz * 2;
      return { pos: [px, terrain.heightAt(px, pz) + 1.6, pz], target: [H.x + lx * 5.5, gy + 8.4, H.z + lz * 5.5] };
    },
  },
};

export const SHOT_IDS = Object.keys(SHOTS);
