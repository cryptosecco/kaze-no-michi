# Contributing to Kaze no Michi

Thank you for your interest in 風の道 (Kaze no Michi), a procedural samurai action-adventure that runs in the browser. Bug reports, fixes, tests, documentation and focused improvements are all welcome. Everyone who takes part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Scope

Kaze no Michi is a static, client-side game written in vanilla ES-module JavaScript (no framework, no TypeScript) on top of Three.js and WebGL2, and built with Vite. It has no backend, no accounts and no analytics, so proposals that need any of them are unlikely to fit. The world, the characters, the horse, the wildlife, the sound and the music are all generated in code.

Small fixes, tests and documentation can go straight to a pull request. For anything larger (a new system, a visual overhaul, a new dependency), please open an issue first, so that the direction can be agreed before you spend the time.

## Prerequisites

- Node.js 22.12 or newer. The `.nvmrc` file selects Node 22, so `nvm use` picks it up.
- A browser with WebGL2 to run the game. The developer tools that take screenshots and captures drive a locally installed, recent Chrome through `playwright-core` with ANGLE/Metal flags, so they need macOS and Chrome.

## Setup and commands

```bash
npm ci            # install the exact dependencies from package-lock.json
npm run dev       # development server at http://localhost:5173
npm test          # unit tests (node:test)
npm run build     # production build into dist/
npm run preview   # serve the production build locally
```

[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) describes the developer tools and the workflow in more detail.

## Project principles

- **Everything is procedural.** The game ships no binary art, audio or model assets: no texture files, sound files, 3D models or bundled fonts (the only binaries in the repository are the screenshots and video under `docs/media/`). Textures, geometry, animation, sound and music are produced by code. If you bring in anything third-party (a library, a typeface, a technique implemented from a published reference), say where it comes from and add an entry to [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- **Refactors must not change behavior.** The world is deterministic for a given seed, so after a refactor the game should look and play exactly as before.
- **Pure logic gets tests.** Logic that does not need a browser is covered by `node:test` tests in `scripts/*.test.mjs`, and `npm test` runs them all. New pure logic comes with tests.

## Code style

There is no formatter or linter, so match the code around you. The `.editorconfig` file sets the basics: UTF-8, LF line endings, two-space indentation and a final newline.

- Single quotes, semicolons, two-space indentation, and trailing commas in multi-line literals.
- Arrow functions with parenthesized parameters: `(x) => x * 2`.
- Lines of about 120 columns at most.
- `camelCase` for functions and variables, `PascalCase` for classes (and usually for the files that hold them, like `Horse.js`), `UPPER_SNAKE_CASE` for constants, and a `this._private` prefix for members that are private to a class.
- Comments are plain `//` comments in English, and they explain why, not what.
- Errors are logged as `console.error('[kaze] ...', err)`.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/): a type, an optional scope in parentheses, a colon and a short summary of the change. For example:

```text
feat(horse): add a new gait
fix(ui): keep the map inside small windows
docs: describe the quality presets
chore: update the CI workflow
test: cover the settings migration
```

## Pull requests

- Keep each pull request small and focused on one change. Unrelated clean-ups belong in a pull request of their own.
- Make sure `npm test` and `npm run build` pass. CI runs both on Node 22 and Node 24.
- Say what the change does and why in the description. The pull request template holds the checklist.
- Attach screenshots for anything that changes how the game looks.
- Update the documentation where your change affects it.

## Reporting bugs

Open an issue with the bug report template. Please include your browser and its version, your operating system, your GPU or chip, and the quality preset (low, medium, high or ultra; the default is high), together with the steps to reproduce the problem and any errors from the browser console. Screenshots or a short video help with visual problems.

Do not report security problems in a public issue: follow [SECURITY.md](SECURITY.md) instead.

## More documentation

- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): working on the game and using the developer tools.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the code is organized.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md): how we treat each other.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
