<p align="center">
  <img src="docs/media/hero.jpg" alt="Kaze no Michi: an autumn island at golden hour" width="100%">
</p>

<h1 align="center">風の道 · Kaze no Michi</h1>

<p align="center"><em>A samurai journey across a procedurally generated autumn island, in the browser.</em></p>

<p align="center">
  <a href="https://github.com/cryptosecco/kaze-no-michi/actions/workflows/ci.yml"><img src="https://github.com/cryptosecco/kaze-no-michi/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22.12-339933?logo=node.js&logoColor=white" alt="Node >= 22.12">
  <img src="https://img.shields.io/badge/WebGL-2.0-990000?logo=webgl&logoColor=white" alt="WebGL2">
</p>

<p align="center"><img src="docs/media/preview.gif" alt="A short loop of play" width="720"></p>

<p align="center">
  <a href="docs/media/gameplay.mp4"><img src="docs/media/poster.jpg" alt="Gameplay video poster" width="720"><br><strong>Watch the gameplay video</strong></a>
</p>

## About

Kaze no Michi is a third-person action-adventure set on Hoshigashima, a fictional island in feudal Japan, on an autumn
evening. A samurai follows the wind across fields of susuki to a hill shrine, frees a bandit camp in a ginkgo valley
with the katana and reaches the cliffs at sunset, on foot or on horseback. It runs in the browser on WebGL2 with
three.js.

Everything is generated in code: the terrain, the vegetation, the buildings, the characters, the horse, the animals,
their textures, the music and the sound effects. The repository ships no texture, model or audio files.

風の道 (*kaze no michi*) means "the path of the wind" (風 wind, の of, 道 path). In the game a guiding wind blows
toward the next objective, and the grass, the leaves and the samurai's cape show the way.

**Status: early prototype.** Three short quests, one island, no saves. Expect rough edges. The interface starts in
Italian and the quest texts are Italian only; the interface can be switched to English under *Opzioni › Lingua*.

## Features

- **Procedural island**: a 2 km × 2 km heightfield with dirt paths, a sea with shoreline foam, distant mountain ranges.
- **One wind for everything**: gust fronts move the grass, trees, falling leaves, cape, birds and ambience; the guiding
  wind turns them toward the objective.
- **Fields and forests**: GPU-instanced grass, susuki and red spider lilies that bend in the wind and part around
  characters; maple, ginkgo, black pine, cedar and bamboo with impostor LODs, falling leaves and leaf litter.
- **Architecture**: torii, stone stairs to a hill shrine, a five-storey pagoda, a thatched farmhouse turned bandit
  camp, a cliff shrine.
- **Light and image**: procedural sky and clouds, height fog with sun in-scattering, cascaded shadows, HDR
  post-processing (bloom, god rays, depth of field, ACES tone mapping, grading, film grain, 2.39:1 letterbox,
  black-and-white cinema mode).
- **Characters and combat**: procedural skinned samurai and bandits with foot IK and a Verlet cloth cape; a three-hit
  combo, heavy strikes, block and parry, dodges (a last-moment dodge slows time), bandits that attack at most two at a
  time, a standoff duel and a kill cam.
- **A horse**: walk, trot, canter and gallop with planted hooves and leg IK; whistle for it, mount and ride.
- **Wildlife**: crows, sparrows and a kite with flight physics; a red fox and sika deer that graze, hunt and flee.
- **Procedural audio** (Web Audio): koto, shakuhachi and taiko in a generative score; wind, surf, fire, birds, insects.
- **Ink-brush UI** drawn as SVG: title screen, HUD, quest cards, a map in the pause screen, photo mode.
- **Tooling**: quality presets with dynamic resolution, a deterministic capture harness, a `window.kaze` debug API.

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="docs/media/screenshot-field.jpg" alt="The susuki field"></td>
    <td width="50%"><img src="docs/media/screenshot-shrine.jpg" alt="The stairs to the hill shrine"></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/media/screenshot-standoff.jpg" alt="A standoff at sunset"></td>
    <td width="50%"><img src="docs/media/screenshot-ginkgo.jpg" alt="The bandit camp in the ginkgo valley"></td>
  </tr>
</table>

## Quick start

Requirements: Node.js 22.12 or newer, and a desktop browser with WebGL2.

```bash
git clone https://github.com/cryptosecco/kaze-no-michi.git
cd kaze-no-michi
npm ci
npm run dev          # http://localhost:5173 (Vite takes the next free port if it is busy)
npm run build        # production build in dist/ with relative paths: serve it from any static host
npm run preview      # serve the build locally
```

Press a key on the title screen and choose **New Journey** (*Nuovo viaggio* in Italian); click the game if the mouse is
not captured. Holding E, Space or Enter skips the opening cinematic.
Essentials: WASD move, mouse look, left click attack, Q block, Space dodge, E interact or mount, Esc pause; the full
[Controls](#controls) table is below.

## Controls

Gamepad buttons use the standard layout (Xbox names; on PlayStation A/B/X/Y are Cross/Circle/Square/Triangle); rumble
can be turned off in Settings › Controls. There is no touch input.

| Action | Keyboard and mouse | Gamepad |
|---|---|---|
| Move | WASD or arrow keys | Left stick |
| Look | Mouse (click the game to capture it) | Right stick |
| Sprint | Shift (hold, or toggle in Settings › Controls) | Click L3 (toggle) or hold B |
| Walk (toggle) | Z | — |
| Light attack (three-hit combo) | Left click | X |
| Heavy attack (strikes on release) | Right click or F | Y |
| Block; parry by blocking as the blow lands | Q | L1 |
| Dodge | Space or C | B (tap) |
| Heal (spends one resolve) | R | D-pad up |
| Interact, pray, mount and dismount, standoff | E | R1 |
| Whistle for the horse | H | D-pad left |
| Guiding wind (about 9 s) | T or Tab | Back / Share |
| Panorama zoom; reset it | Mouse wheel; wheel click | — |
| Pause (with the map) | Esc or P | Start |
| Photo mode | O | — (use the pause menu) |
| Mute | M | — |
| Free camera (development) | F1 | — |

- **Standoff**: near bandits who have not noticed you, press E and keep it held; release it as the bandit lunges.
  Releasing too early or too late costs a wound and starts the fight. Keep holding after a kill to face the next one
  (up to three).
- **Riding**: mount within about 2.3 m of the horse. The stick (or WASD) sets the heading and how far it is pushed sets
  the gait (walk, trot, canter); sprint gallops, Z keeps a walk, pulling back brakes and then backs up. Keys always ask
  for the full stick, so on a keyboard the horse walks (Z), canters or gallops: a trot needs an analog stick. E
  dismounts at a stand; at speed, hold E to pull up first. A hit or a fight nearby throws the rider; whistle to call
  the horse back.

## Settings and language

The pause screen (Esc, P or Start) freezes the world and shows **Resume**, **Settings**, **Photo Mode** and
**Return to Title**, with the current objective and a map of the island. Return to Title reloads the page.

Settings (also under **Options** on the title screen):

- **Image**: quality preset (Low, Medium, High, Ultra), render resolution (50–100 % of the preset's), cinema mode
  (black and white), cinematic bars (2.39:1, on by default), film grain.
- **Controls**: mouse sensitivity, invert vertical axis, sprint (hold or toggle), vibration.
- **Sound**: master, music, effects and ambience volumes.
- **Language**: Italiano or English.

Settings are kept in the browser's `localStorage` (key `kaze.settings.v1`); nothing else is saved. Changing the preset
switches render scale, shadows and dynamic resolution at once; grass, terrain detail and tree budgets are built at boot
from `?quality=` (default `high`).

**Photo mode** (O, or from the pause menu) flies a camera within 30 m of where it opened (WASD, Q/E, Shift, drag to
look, wheel for the field of view), with the hour, exposure, field of view, filters (none, black and white, dusk,
mist), bars and grain. H hides the panel; Space or F12 saves a PNG.

**Language**: the interface starts in Italian; *Impostazioni › Lingua* switches it to English (the string table is in
[`src/ui/i18n.js`](src/ui/i18n.js)). Quest titles, objectives and the prayer and standoff prompts are Italian only
([`src/actors/quest/Quests.js`](src/actors/quest/Quests.js), [`src/actors/combat/Standoff.js`](src/actors/combat/Standoff.js)).

## Developer URL parameters

Append them to the page URL, for example `http://localhost:5173/?debug&quality=medium`.

| Parameter | Effect |
|---|---|
| `quality=low\|medium\|high\|ultra` | Quality preset at boot (default `high`); a quality saved in Settings is applied over it |
| `debug` | Overlay with fps, frame time, render scale, draw calls, triangles, camera position and hour |
| `shot=S1_field\|S2_shrine\|S3_standoff\|S4_title\|S5_ginkgo` | Canonical framing for captures (implies `deterministic`; no horse, no wildlife) |
| `seed=<number>` | Seed of the terrain noise, tree placement and wildlife (default `1234`); places and paths are fixed |
| `deterministic` | One fixed simulation step per rendered frame, dynamic resolution off |
| `only=<modules>` / `no=<modules>` | Load only, or skip, feature modules: `trees`, `props`, `actors`, `wildlife`, `ui`, `audio` |
| `grass=near,mid,tuft,pampas,lily` | Show only these grass layers (`grass=none` hides them all) |
| `nointro` / `intro` | Skip the opening cinematic / play it even when the game starts without the title |

Without the `ui` module the game starts directly in play. The `window.kaze` debug API is described in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Project structure

```
index.html            boot card (loading bar, haiku), fonts, entry point
vite.config.js        Vite configuration (relative base, for static hosting)
src/
  main.js             boot: URL parameters, the Game, the debug API, the feature modules
  game/               Game (scene, systems, events, states), module loader, colliders
  core/               renderer, fixed-step loop, input, quality presets, canonical shots, debug API
  render/             atmosphere, HDR post-processing, god rays, depth of field, shared GLSL
  world/              layout, terrain, sky, lighting, water, grass, wind, distant ranges
  world/trees/        forests, impostors, falling leaves                           [module]
  world/props/        shrine hill, pagoda, bandit camp, cliff, roadside details    [module]
  world/wildlife/     birds, fox and deer                                          [module]
  actors/             samurai, bandits, animation, cape, camera, combat, quests    [module]
  actors/horse/       the horse: gaits, legs, steering, riding
  ui/                 title, HUD, cards, pause and map, settings, photo mode       [module]
  audio/              procedural Web Audio: instruments, score, ambience           [module]
scripts/              unit tests (*.test.mjs) and developer tools (shots, probe, variants, wildlife/, trotlab/)
docs/                 architecture, development guide, trot lab, media
.github/              continuous integration
```

## Development

`npm test` runs the unit tests in Node (`scripts/*.test.mjs`, no browser or GPU needed). `npm run trotlab` measures the
horse's trot in a Node simulation (only its plots are rasterised in headless Chrome; `--no-plots` keeps it Node-only).
The capture tools (`npm run shots`, `npm run trotlab:capture`, `scripts/probe.mjs`, `scripts/variants.mjs`,
`scripts/wildlife/capture.mjs`) drive the system Google Chrome through playwright-core with Metal flags, so they need
macOS. Generated output goes to `out/`, which git ignores.
Read [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) (setup, tests, the debug API, the tools),
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (how the game is organised) and [docs/trot-lab.md](docs/trot-lab.md)
(the bench that measures the horse's trot against the literature).

## Browser support and performance

WebGL2 is required: without it the game stops on the loading card with an error (reversed-Z depth is used when
`EXT_clip_control` is available). Desktop only: keyboard and mouse, or a gamepad. Performance has only been measured in
Chrome on macOS with Apple Silicon: through the capture harness (headless, vsync off, 1920×1080, High) the five
canonical shots, which leave out the horse and the wildlife, ran at roughly 90–110 fps. Other browsers, operating
systems and GPUs are untested. On a slower machine, lower the quality preset or the render resolution; Low, Medium and
High also lower the resolution by themselves when the frame rate drops.

## Known limitations

- Early prototype: three short quests and no saved progress (only settings persist; there is no Continue).
- In play the hour is fixed (17.7 h, a late autumn afternoon): no day–night cycle and no weather. Only photo mode
  changes the hour, until it closes.
- No dialogue, no inventory, no touch or mobile support. Quest texts and a few prompts are Italian only.
- The UI typefaces are fetched from Google Fonts at runtime; offline, the UI falls back to local serif fonts.

## Contributing

Bug reports, fixes and ideas are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first; everyone taking part
follows the [Code of Conduct](CODE_OF_CONDUCT.md). To report a vulnerability, see [SECURITY.md](SECURITY.md). Changes
are listed in [CHANGELOG.md](CHANGELOG.md).

## Credits

Full notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

- [three.js](https://threejs.org/) (MIT) renders the game; [Vite](https://vite.dev/) serves and builds it;
  playwright-core drives Chrome in the developer tools.
- Typefaces Cormorant Garamond, Shippori Mincho and Yuji Boku (SIL Open Font License), loaded from Google Fonts.
- The loading card shows haiku by Matsuo Bashō (1644–1694).
- Eadweard Muybridge's plates 596 and 601 from *Animal Locomotion* (1887), public domain (Wikimedia Commons, USC
  Digital Library), are the visual reference of the trot lab, whose ranges derive from published equine biomechanics.
  The plates are not included in this repository.

## License

[MIT](LICENSE) © 2026 havok6.

Kaze no Michi's visual language is inspired by samurai cinema and games; it is an independent project with original
names, characters and code, not affiliated with or endorsed by any game publisher or studio.
