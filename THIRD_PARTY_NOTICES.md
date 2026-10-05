# Third-party notices

Kaze no Michi (風の道) ships no third-party art, audio or model assets. Every texture, mesh, animation, sound and piece of music in the game is generated in code at run time.

This file lists what the project does use from others: the library the game is built on, the typefaces it loads, the tools used to develop it, the published techniques its code implements, and the poems shown while the game loads. The project's own code is released under the [MIT License](LICENSE).

## three.js

The game is built on [three.js](https://threejs.org/) (the `three` package on npm, including the modules the game imports from `three/addons`), which is bundled into the production build. three.js is released under the MIT License:

```text
The MIT License

Copyright © 2010-2026 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Typefaces

The game loads three typefaces at run time from [Google Fonts](https://fonts.google.com/): Cormorant Garamond, Shippori Mincho and Yuji Boku. They are not part of this repository or of the build. When the game loads, the player's browser fetches them from Google's servers (`fonts.googleapis.com` and `fonts.gstatic.com`).

All three are licensed under the SIL Open Font License, Version 1.1 (<https://openfontlicense.org>). The copyright notice of each family is the one published with it on Google Fonts.

## Development tools

These tools are installed by npm for development. They are not part of this repository and are not shipped with the game, apart from Vite's small module-preload helper, which Vite inlines into the production build.

### Vite

[Vite](https://vite.dev) is the build tool and development server. It is released under the MIT License:

```text
MIT License

Copyright (c) 2019-present, VoidZero Inc. and Vite contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### playwright-core

[playwright-core](https://playwright.dev) drives Chrome for the screenshot and capture scripts. It is released under the Apache License, Version 2.0 (<http://www.apache.org/licenses/LICENSE-2.0>), with the notices from its `NOTICE` and `LICENSE` files:

```text
Playwright
Copyright (c) Microsoft Corporation

This software contains code derived from the Puppeteer project (https://github.com/puppeteer/puppeteer),
available under the Apache 2.0 license (https://github.com/puppeteer/puppeteer/blob/master/LICENSE).

Portions Copyright (c) Microsoft Corporation.
Portions Copyright 2017 Google Inc.
```

### Other development dependencies

The remaining packages that npm installs for development (the full list, with each package's license, is in `package-lock.json`) are licensed under MIT, ISC, BSD-3-Clause or Apache-2.0, with one exception: lightningcss and its platform packages are licensed under MPL-2.0. lightningcss is used only at development time and is not shipped.

## Techniques implemented from public references

The code in this repository implements the following techniques and small routines from public references. Authors and sources are named here; the code comments name only some of them.

- **2D simplex noise**, after Stefan Gustavson's implementation, with a seeded permutation table: `src/core/math.js`.
- **Mulberry32**, the seeded pseudo-random number generator: `src/core/math.js`.
- **Hash without Sine**, by David Hoskins (2014, https://www.shadertoy.com/view/4djSRW), published under the MIT License, Copyright (c) 2014 David Hoskins (same terms as the three.js notice above): the sine-free hash built on `fract(p.xyx * 0.1031)` in `src/render/globals.js` (`kazeHash12`) and `src/render/PostFX.js`.
- **The ACES filmic fit** for tone mapping, with its input and output matrices (`RRTAndODTFit`, `ACESInputMat` and `ACESOutputMat` in the final pass): `src/render/PostFX.js`. It is the fit by Stephen Hill that three.js ships as its `ACESFilmicToneMapping`, where three.js cites https://github.com/selfshadow/ltc_code as its source; the three.js notice above covers the three.js copy.
- **Bloom**: a 13-tap downsample chain with a tent-filter upsample, as in Jorge Jimenez's *Next Generation Post Processing in Call of Duty: Advanced Warfare* (SIGGRAPH 2014), and a first downsample that averages the samples with Karis weights (`karis` in the shader, after Brian Karis) to stay firefly-safe: `src/render/PostFX.js`.
- **Interleaved gradient noise**, by Jorge Jimenez (2014): the constants `52.9829189`, `0.06711056` and `0.00583715` in `src/world/trees/` (`Carpet.js`, `Litter.js`, `impostors.js`, `materials.js`).
- **pcg3d**, by Mark Jarzynski and Marc Olano, *Hash Functions for GPU Rendering* (Journal of Computer Graphics Techniques, 2020): the integer hash in `src/render/globals.js`.

## Deploying a build

The production build carries these notices itself. It ships this file as `THIRD_PARTY_NOTICES.txt` next to `index.html`, and it prepends the three.js MIT license, as a comment, to every JavaScript chunk that bundles the three.js library files (`three.core.js` and `three.module.js`). A hosted build therefore includes the notices without any extra step.

## Poems

The loading card shows haiku by Matsuo Bashō (1644–1694). The Japanese originals are in the public domain:

- この道や　行く人なしに　秋の暮
- あかあかと　日はつれなくも　秋の風
- 石山の　石より白し　秋の風
- 旅に病んで　夢は枯野を　かけ廻る

The Italian and English renderings shown next to the Japanese originals on the loading card were written for this project with Claude Sonnet 5.5 and are covered by the project's [MIT License](LICENSE).
