# Development

How to run, test and inspect Kaze no Michi. For how the code is organised, see [ARCHITECTURE.md](ARCHITECTURE.md);
for contribution rules, see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Requirements

- Node.js 22.12 or newer and npm (`.nvmrc` names Node 22).
- A desktop browser with WebGL2 to play.
- For the capture tools only: macOS and the system Google Chrome. They drive Chrome through playwright-core
  (`channel: 'chrome'`, ANGLE on Metal); no browser is downloaded.

## Setup

```bash
npm ci
npm run dev        # http://localhost:5173 (Vite takes the next free port if it is busy)
```

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Production build into `dist/` (`base: './'`: relative paths, any static host) |
| `npm run preview` | Serves `dist/` locally |
| `npm test` | Unit tests: `node --test "scripts/*.test.mjs"` |
| `npm run shots` | Canonical captures and an fps report (macOS and Chrome) |
| `npm run trotlab` | Trot lab: Node simulation, metrics, plots ([trot-lab.md](trot-lab.md)) |
| `npm run trotlab:capture` | Trot lab: contact sheets captured in the game (macOS and Chrome) |
| `npm run trotlab:all` | Both trot lab steps, one after the other |

`npm run build` also ships the legal notices: `dist/THIRD_PARTY_NOTICES.txt`, generated from
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md), and the three.js MIT license as a banner on the chunks that bundle
the three.js library files (a build-only plugin in `vite.config.js` does both).

## Tests

The tests use Node's built-in runner (`node:test`). Each area has one file in `scripts/`, named `*.test.mjs`: controls
and input, settings, camera, menu navigation, title, intro, HUD and letterbox, map, sky, wind and grass bending, trees,
shrine and camp placement, shot staging, poses, the horse, birds and mammals, the trot lab. They import the game's own
modules and run without a browser or a GPU: logic that can be tested is kept apart from scene code (for example
`src/actors/locomotion.js`, `src/actors/horse/steer.js`, `src/ui/mapModel.js`, `src/world/grassBend.js`), and classes
that need a page run on small stand-ins (a minimal DOM, `localStorage`, a canvas that draws nothing). Each file runs in
its own process, so it can install its own stand-ins.

```bash
npm test                                                    # everything
node --test scripts/horse.test.mjs                          # one file
node --test --test-name-pattern="<pattern>" scripts/horse.test.mjs   # tests whose name matches
```

Shader code cannot run in Node. The wind and the grass bend have CPU mirrors that the tests check; to compare a
shader with its mirror on a real GPU, run the matching snippet through the probe:
`node scripts/probe.mjs --file scripts/wind.gpu.js` (or `scripts/grassbend.gpu.js`).

## URL parameters

| Parameter | Effect |
|---|---|
| `quality=low\|medium\|high\|ultra` | Preset at boot (default `high`). A quality saved in Settings is applied after boot, over this value (not in shot mode) |
| `debug` | Overlay: fps and frame time, render scale, draw calls, triangles, camera position, hour |
| `shot=<id>` | Canonical shot: `S1_field`, `S2_shrine`, `S3_standoff`, `S4_title`, `S5_ginkgo`. Implies `deterministic`; saved settings are ignored, there is no sound, no horse and no wildlife, and the UI only shows for `S4_title` |
| `seed=<number>` | Seed of the terrain noise, tree placement and wildlife (default `1234`). The places and paths of `src/world/Layout.js` do not move |
| `deterministic` | One fixed simulation step per rendered frame; dynamic resolution off |
| `only=a,b` / `no=a,b` | Load only, or skip, feature modules: `trees`, `props`, `actors`, `wildlife`, `ui`, `audio`. `only=none` keeps just the core world |
| `grass=<layers>` | Show only these grass layers: `near`, `mid`, `tuft`, `pampas`, `lily` (`grass=none` hides them all) |
| `nointro` / `intro` | Skip the opening cinematic / play it even when the game starts without the title |

Without the `ui` module the game goes straight to play (no title screen, no pause menu). The F1 key toggles a fly
camera in play (WASD, E/Q up and down, Shift faster, mouse wheel for speed).

## The `window.kaze` debug API

[`src/core/Debug.js`](../src/core/Debug.js) installs `window.kaze` as the page boots. When the modules are installed,
`kaze.ready` becomes `true` and `window` fires the `kaze:ready` event (its `detail` is the game).

| Member | Description |
|---|---|
| `kaze.game` | The `Game`: `scene`, `camera`, `terrain`, `wind`, `post`, `loop`, `modules`, `settings`… |
| `kaze.ready` | `true` once the game has booted |
| `kaze.shot` | The id of the last shot applied |
| `kaze.setShot(id)` | Applies a canonical shot: hour, camera, wind clock, sky and grade, actor staging. Throws on an unknown id |
| `kaze.setTime(h)` | Sets the hour (sun, sky, fog, baked terrain light) |
| `kaze.stats()` | Same as `game.stats()` (below) |
| `kaze.waitFrames(n)` | Promise resolved after `n` more rendered frames |
| `kaze.measureFps(ms)` | Samples frame times for `ms` (default 3000) and resolves `{ fps, avgMs, p50, p95, frames }` |

In the browser console:

```js
kaze.stats()                                  // draw calls, triangles, render scale, module timings
kaze.game.terrain.heightAt(0, 0)              // ground height at the spawn
kaze.game.modules.trees.nearest(0, 0, 30)     // trees within 30 m of the spawn
kaze.game.post.params.grain = 0               // post-processing parameters are live
kaze.game.loop.paused = true                  // freeze the simulation (rendering continues)
await kaze.measureFps(3000)
```

Other handles: `game.modules.actors` (player, bandits, combat, standoff, quests, horse, camera rig),
`game.modules.props.sites`, `game.modules.wildlife`, `game.settings` (live settings values) and the event bus
(`game.on(type, fn)`).

## Measuring performance

- `?debug` shows fps, frame time, render scale, draw calls and triangles every 30 frames.
- `game.stats()` returns `fps` and `frameMs` (last frame), `calls`, `triangles`, `renderScale`, `renderSize`,
  `quality`, `grass` (per-layer counts) and the modules' CPU time: `actorsMs`, `horseMs`, `wildlifeMs` (smoothed) with
  their `…MsMax` peaks, plus the numbers of `birds` and `mammals` drawn.
- `kaze.measureFps(ms)` measures what the browser displays, so it stops at the screen's refresh rate. The capture
  tools launch Chrome with vsync off to measure the headroom.
- Dynamic resolution (Low, Medium, High) lowers the render scale when frames are slow: read `renderScale` along with
  the fps, or use Ultra or `?deterministic`, where it is off.
- `npm run shots` stores per-shot fps and `game.stats()` in `report.json`.

## Developer tools

The capture tools below (shots, probe, variants, wildlife capture) and `npm run trotlab:capture` need macOS and Google
Chrome: they start their own Vite server (shots and the trot lab capture can use a running one with `--url`), open the
game headless with hardware WebGL2 (ANGLE on Metal) and write into `out/`. `npm run trotlab` itself runs in Node and
uses headless Chrome only to rasterise its plots (`--no-plots` skips them). Read each script's header for every option.

### Canonical captures: `npm run shots`

```bash
npm run shots -- --label mine                                  # the five shots, with an fps pass
npm run shots -- --label mine --shots S2_shrine --no-fps       # one shot, no fps pass
npm run shots -- --label mine --params only=none               # the core world only
npm run shots -- --label mine --shots S1_field --seq 6 --seq-ms 150   # a frame sequence and its contact sheet
```

Options: `--shots`, `--quality` (default `high`), `--width`/`--height` (1920×1080), `--fps-ms` (3000), `--no-fps`,
`--url` (use a dev server that is already running), `--params` (extra URL parameters), `--seq`/`--seq-ms`. Output in
`out/shots/<label>/`: `<shot>.png`, the sequence frames and `seq_<shot>.png` with `--seq`, and `report.json` (fps,
load time, scene stats, GPU, console errors and warnings). Every screenshot is taken with the loop frozen an exact
number of fixed steps after `kaze.setShot()`, so two captures of the same code give the same images.

### Evaluate code in the game: `node scripts/probe.mjs`

```bash
node scripts/probe.mjs --eval "kaze.game.terrain.heightAt(0, 0)"
node scripts/probe.mjs --file snippet.js --params only=trees,props
node scripts/probe.mjs --file snippet.js --shot S1_field --screenshot out/probe.png
```

The expression or snippet runs after `kaze.ready`, with `kaze` and `game` in scope; a snippet may be async and
`return` a value, which is printed as JSON. Defaults: `--params only=none` (no feature modules unless you pass some),
`--quality low`, 960×540. With `--shot` and `--screenshot` the PNG repeats exactly.

### Look-development variants: `node scripts/variants.mjs`

```bash
node scripts/variants.mjs --shot S5_ginkgo --file variants.json --label look
```

`variants.json` is a list such as `[{ "name": "a", "js": "kaze.game.post.params.exposure = 0.9" }]`. The shot is
re-applied before each variant, so they do not add up. Output: `out/shots/<label>/<name>.png` and a two-column
`sheet.png`. Options: `--quality`, `--width`/`--height`, `--params`, `--frames` (30).

### Wildlife sheets: `node scripts/wildlife/capture.mjs`

```bash
node scripts/wildlife/capture.mjs --only foxtrot,deer --params grass=none
```

It boots into play without UI and audio, freezes the loop and steps the wildlife by hand. Scenarios: `crowland`,
`shadow`, `torii`, `crowground`, `sparrows`, `turn`, `kite`, `play`, `lineup`, `foxtrot`, `deergait`, `foxpounce`,
`foxflee`, `deer`, `perf`. Output in `out/shots/wildlife/` (or `--out`): one sheet per scenario, a zoomed sheet, the
frames and `report.json`.

### Trot lab

`npm run trotlab`, `trotlab:capture` and `trotlab:all` measure the horse's trot and compare it with ranges from the
equine biomechanics literature. See [trot-lab.md](trot-lab.md).

## The `out/` directory

Everything the tools generate goes under `out/`, which git ignores: `out/shots/<label>/` (captures and variants),
`out/shots/wildlife/` and `out/trotlab/<label>/`. It can be deleted at any time. `npm run build` writes `dist/`, also
ignored.

## Audio self-test

[`src/audio/selftest.js`](../src/audio/selftest.js) renders every instrument and sound patch offline and reports peak,
RMS and invalid samples. With the dev server running, in the browser console:

```js
const { audioSelfTest } = await import('/src/audio/selftest.js');
await audioSelfTest();
```
