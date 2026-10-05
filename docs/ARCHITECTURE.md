# Architecture

Kaze no Michi is plain JavaScript: ES modules, no framework, no TypeScript, three.js 0.186 on WebGL2 and Vite for
the dev server and the build. Every file starts with a header comment that states its purpose and its API; this page
is the map between them. Paths are relative to the repository root.

## Boot

1. [`index.html`](../index.html) shows the boot card (calligraphy, loading bar, Bashō haiku), loads the typefaces
   from Google Fonts and imports `src/main.js`.
2. [`src/main.js`](../src/main.js) reads the URL parameters, creates the `Game`, installs the `window.kaze` debug API
   ([`src/core/Debug.js`](../src/core/Debug.js)) and calls `game.init()`, which builds the core world: the noise
   texture, the atmosphere, the renderer, the sky, the sun and its lighting, the terrain, the distant ranges, the sea,
   the grass and the post-processing chain.
3. `installModules()` ([`src/game/modules.js`](../src/game/modules.js)) then imports the feature modules dynamically,
   in this order: `trees`, `props`, `actors`, `wildlife`, `ui`, `audio`. Each module's `index.js` exports
   `async install(game, ctx)` with `ctx = { params, shot }`; what it returns is stored in `game.modules[name]`.
   A module that throws is logged and skipped, so the rest of the game still runs. `?only=` and `?no=` pick the
   modules. The order matters: world content first (actors query colliders and the ground), wildlife after actors
   (it reads the samurai, the horse, the trees and the props), audio last.
4. The shaders are compiled, the state becomes `title` (or `play` without the `ui` module, or `shot` for a canonical
   capture), the loop starts and `window` receives the `kaze:ready` event.

## The Game object

[`src/game/Game.js`](../src/game/Game.js) owns the renderer, the scene, the camera and the world systems, and gives the
modules a few shared hooks:

| Hook | Purpose |
|---|---|
| `emit(type, detail)`, `on(type, fn)`, `off(type, fn)` | Event bus (an `EventTarget`; the payload is `e.detail`) |
| `setState(state)` | `title`, `play`, `paused`, `shot`; emits `state` `{ state, prev }` |
| `add(object3D)` | Adds to the scene and patches every material with the shared uniforms |
| `addSystem({ update, frame })` | `update(dt, t)` at the fixed step, `frame(dt, t)` once per rendered frame |
| `colliders`, `addGroundOverride(fn)`, `groundAt(x, z)` | Static 2D colliders ([`Colliders.js`](../src/game/Colliders.js)) and walkable height (stairs, floors) |
| `cameraController`, `freeCam` | The object that drives the camera; the F1 developer fly camera |
| `onShot(fn)`, `addStat(fn)` | Staging for canonical shots; extra entries in `game.stats()` |
| `setTimeOfDay(h)`, `setQuality(name)` | Sun, sky, fog, IBL and baked terrain light; preset switch |

**Shared GLSL.** [`src/render/globals.js`](../src/render/globals.js) keeps a registry of uniforms shared by every
patched material and provides `registerChunk()`, which makes a GLSL chunk usable as `#include <name>`; it registers
`kaze_common` (hashes, noise) itself. The other chunks live with their systems: `kaze_atmosphere` in
[`src/render/Atmosphere.js`](../src/render/Atmosphere.js), `kaze_wind` in [`src/world/Wind.js`](../src/world/Wind.js),
`kaze_terrain` in [`src/world/Terrain.js`](../src/world/Terrain.js), `kaze_field` and `kaze_lawn` in
[`src/render/fieldPalette.js`](../src/render/fieldPalette.js). `Game.patchMaterial()` merges the shared uniforms into
each shader at compile time and runs the material's own `userData.onBeforeCompile`, so built-in three.js materials get
the atmosphere, the wind and the terrain without custom shader classes.

## Loop, renderer and input (`src/core`)

- [`Loop.js`](../src/core/Loop.js): the simulation runs at a fixed 60 Hz (`update`), rendering once per displayed
  frame (`frame`). `timeScale` gives slow motion and hit-stop. In deterministic mode the loop takes exactly one fixed
  step per rendered frame, so captures do not depend on the machine's speed.
- [`Renderer.js`](../src/core/Renderer.js): a WebGL2 context (it throws if WebGL2 is missing), reversed-Z depth when
  `EXT_clip_control` is available, shadow maps, resizing and dynamic resolution.
- [`Quality.js`](../src/core/Quality.js): the `low`, `medium`, `high` and `ultra` presets. Each sets the pixel-ratio
  cap, render scale, MSAA, shadow map size and distance, grass density and rings, pampas density, terrain LOD distance
  and whether dynamic resolution is on. Modules keep their own per-preset budgets (trees, leaves and impostors in
  `src/world/trees/index.js`, animal counts in `src/world/wildlife/species.js`).
- **Dynamic resolution** (Low, Medium, High; off on Ultra and in deterministic mode): every 1.2 s the renderer
  compares a smoothed frame time with a target of about 58 fps and moves the render scale between 0.6 and the
  preset's own, down faster than up.
- [`Input.js`](../src/core/Input.js): named actions over the keyboard, the mouse (pointer lock), the gamepad (standard
  mapping) and its rumble, with care for keys that would stick (focus loss, macOS ⌘ chords).
  [`ActionBuffer.js`](../src/core/ActionBuffer.js) keeps a combat press for 0.2 s until its action becomes legal.

## Rendering (`src/render`)

- [`PostFX.js`](../src/render/PostFX.js): the scene renders into a multisampled HalfFloat target with a depth texture;
  HDR passes run on it ([`Effects.js`](../src/render/Effects.js): screen-space god rays radiating from the drawn sun,
  and a thin-lens depth of field), then bloom (downsample chain and tent upsample), then the final pass: exposure,
  ACES filmic tone mapping, grade (lift, gamma, gain, saturation, split toning), black-and-white mode, vignette,
  ground shade, letterbox, film grain, dither. The grain is seeded by the wind clock, so a capture repeats exactly.
- [`Atmosphere.js`](../src/render/Atmosphere.js): two exponential height layers (a dense ground mist and a thin aerial
  haze) plus in-scattering toward the sun, applied to every material through overridden fog chunks; the sky uses the
  same model, so the horizon meets distant terrain without a seam.
- [`NoiseTexture.js`](../src/render/NoiseTexture.js): a tileable four-channel noise texture (four octaves in one fetch)
  whose data is also kept on the CPU, so gameplay samples what the GPU sees.

## The world (`src/world`)

- [`Layout.js`](../src/world/Layout.js) describes Hoshigashima: a 2048 m square (+X east, −Z north), the places
  (spawn, field, shrine hill, bandit camp, ginkgo valley, pagoda, cliff) and the paths between them. Everything that
  places content reads it.
- [`TerrainGen.js`](../src/world/TerrainGen.js) generates on the CPU the heightfield (a 2 m grid), the surface masks
  (grass, pampas, flowers, path, rock, forest, sand, wet) and the baked light (sun visibility and horizon occlusion).
  [`Terrain.js`](../src/world/Terrain.js) draws it as LOD chunks plus a far ring and uploads it as textures, so any
  vertex shader can read the ground height (`kaze_terrain`).
- [`Sky.js`](../src/world/Sky.js) (HDR sky dome and lit clouds), [`Lighting.js`](../src/world/Lighting.js) (cascaded
  sun shadows, a palette keyed by sun elevation, image-based light baked from the sky),
  [`Water.js`](../src/world/Water.js) (the sea) and [`Backdrop.js`](../src/world/Backdrop.js) (mountain silhouettes
  3–15 km away).
- [`Grass.js`](../src/world/Grass.js): each layer (`near`, `mid`, `tuft`, `pampas`, `lily`) is one instanced geometry
  drawn as a toroidal patch around the camera, with stable per-spot randomness. A per-frame GPU prepass evaluates the
  costly per-blade data once; up to eight trample zones part the grass around actors and arenas.
  [`grassBend.js`](../src/world/grassBend.js) holds the bend functions with a CPU mirror that the tests check.
- [`Wind.js`](../src/world/Wind.js): one wind field shared by grass, trees, leaves, cloth, particles, birds and audio,
  in GLSL (`kaze_wind`) with a CPU mirror (`wind.sample()`). Gust fronts cross the land; the guiding wind is a second
  field with its own heading, faded in and out by an envelope.
- Modules: [`trees/`](../src/world/trees/index.js) (species generator, full and light LODs, baked impostor cards,
  falling leaves, leaf litter, trunk colliders), [`props/`](../src/world/props/index.js) (shrine hill, pagoda, camp,
  cliff and roadside details, merged per material, with colliders and ground overrides) and
  [`wildlife/`](../src/world/wildlife/index.js) (birds and mammals: behaviour in `sim.js` and `mammals.js`, flight
  physics in `flight.js`, quadruped gaits and leg IK in `quad.js`, instanced drawing in `render.js` and `beasts.js`).

## Actors, combat and the horse (`src/actors`)

- **Bodies**: [`rig/skeleton.js`](../src/actors/rig/skeleton.js) (a humanoid rig with Mixamo-compatible bone names),
  [`gen/character.js`](../src/actors/gen/character.js) (the samurai and the five bandits as procedural skinned meshes
  and textures), [`Cape.js`](../src/actors/Cape.js) (Verlet cloth pushed by the wind and the wearer).
- **Animation**: [`anim/Animator.js`](../src/actors/anim/Animator.js) layers a locomotion base, one-shot action layers,
  a sword track with arm IK, foot planting and look-at; [`anim/library.js`](../src/actors/anim/library.js) generates
  gait cycles and keyframes the combat clips; [`anim/ik.js`](../src/actors/anim/ik.js) is two-bone IK.
- **Player and camera**: [`Player.js`](../src/actors/Player.js), [`locomotion.js`](../src/actors/locomotion.js)
  (speeds, sprint intent), [`combat/windows.js`](../src/actors/combat/windows.js) (cancel windows),
  [`CameraRig.js`](../src/actors/CameraRig.js) (third-person orbit, combat framing, blended overrides, panorama zoom).
- **Combat**: [`Fighter.js`](../src/actors/Fighter.js) (attacks, block and parry timing, dodge, posture, death),
  [`combat/Combat.js`](../src/actors/combat/Combat.js) (hit resolution, guard break, attack tokens, hit-stop, slow
  motion, kill cam), [`Enemy.js`](../src/actors/Enemy.js) (bandit AI), [`combat/Standoff.js`](../src/actors/combat/Standoff.js),
  [`combat/VFX.js`](../src/actors/combat/VFX.js) (pre-allocated trails, sparks, blood).
- **Story**: [`quest/Quests.js`](../src/actors/quest/Quests.js) (the quest chain and the guiding wind),
  [`intro.js`](../src/actors/intro.js) (the opening cinematic, rendered by the engine).
- **The horse** ([`horse/`](../src/actors/horse/index.js)) is wired from the actors module (it needs the samurai, the
  camera, combat and the quests) and is not installed for canonical shots. [`Horse.js`](../src/actors/horse/Horse.js)
  runs the kinematics, a contact cycle per hoof (planted in stance, swung in flight), a spring-mass trunk and the
  riderless behaviour (graze, come when called, flee, wait); [`gait.js`](../src/actors/horse/gait.js) describes the four
  gaits as data; [`steer.js`](../src/actors/horse/steer.js) holds speeds, turn rates and collision rules;
  [`Riding.js`](../src/actors/horse/Riding.js) mounts, rides, whistles and throws the rider. Its trot can be measured
  with the [trot lab](trot-lab.md).

## Audio (`src/audio`)

[`index.js`](../src/audio/index.js) builds a Web Audio graph on the first user gesture (music, effects and ambience
into a master bus and a limiter), listens to game events and follows the volume settings; M toggles mute.
[`instruments.js`](../src/audio/instruments.js) synthesises the koto (Karplus-Strong), shakuhachi, taiko and the
sound effects; [`music.js`](../src/audio/music.js) is a generative score in the *in* scale on D with moods (title,
explore, combat, standoff, death, ending); [`ambience.js`](../src/audio/ambience.js) mixes noise beds (wind, grass,
surf, fire) with scheduled voices (birds, insects, crows, crackles). [`selftest.js`](../src/audio/selftest.js) renders
every patch offline and reports peaks and silence (run it from the browser console).

## UI (`src/ui`)

[`index.js`](../src/ui/index.js) wires the screens to the game states: [`Title.js`](../src/ui/Title.js),
[`HUD.js`](../src/ui/HUD.js) (it fades out when nothing changes), [`Cards.js`](../src/ui/Cards.js) (quest, death and
ending cards), [`Pause.js`](../src/ui/Pause.js) with [`MapPanel.js`](../src/ui/MapPanel.js) and its pure logic in
[`mapModel.js`](../src/ui/mapModel.js), [`PhotoMode.js`](../src/ui/PhotoMode.js), [`settings.js`](../src/ui/settings.js)
and [`i18n.js`](../src/ui/i18n.js). [`menu.js`](../src/ui/menu.js) is the navigation stack (keyboard, gamepad,
mouse); [`brush.js`](../src/ui/brush.js) draws seeded sumi-e brush strokes as SVG paths; [`ink.js`](../src/ui/ink.js)
is the ink transition; [`bars.js`](../src/ui/bars.js) keeps the HUD inside the letterbox.

## Events

Modules talk through the bus. A few of the main events:

| Event | From |
|---|---|
| `state` | `Game.setState` |
| `quest:update`, `quest:complete`, `guide`, `pray:start`, `blessing`, `ending` | Quests |
| `hit`, `combat:start`, `combat:end`, `perfect-dodge`, `player:death`, `enemy:death` | Combat |
| `standoff:start`, `standoff:lunge`, `standoff:end` | Standoff |
| `horse:whistle`, `horse:mount`, `horse:throw`, `horse:step` | the horse |
| `wildlife:flush`, `wildlife:alarm` | wildlife |
| `settings`, `audio:mute-toggle`, `ui:newgame`, `ui:quit` | UI |

## Determinism and captures

- **Seeds**: [`src/core/math.js`](../src/core/math.js) provides seeded random numbers and simplex noise. `?seed=`
  (default 1234) seeds the terrain noise, the tree placement and the wildlife; the layout is fixed.
- **Canonical shots**: [`src/core/shots.js`](../src/core/shots.js) defines `S1_field`, `S2_shrine`, `S3_standoff`,
  `S4_title` and `S5_ginkgo`: a camera pose computed from the terrain, an hour, a wind time `t0`, and optional sky and
  grade overrides. Modules add a few development framings to the same table.
- **Shot mode** (`?shot=`): the loop is deterministic, dynamic resolution is off, saved settings are ignored, audio
  stays silent, the horse and the wildlife are not installed and the UI hides (except for `S4_title`, which shows the
  title screen). `kaze.setShot(id)` sets the hour and the camera, re-anchors the wind clock at `t0`, applies the
  overrides and lets every module stage its actors through `onShot`. The capture tools rely on this to produce
  repeatable images (see the header of `scripts/shots.mjs`).
- **`window.kaze`**: `setShot`, `setTime`, `stats`, `waitFrames`, `measureFps` and the `game` itself; see
  [DEVELOPMENT.md](DEVELOPMENT.md#the-windowkaze-debug-api).
