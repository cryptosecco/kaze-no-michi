# Security policy

## Supported versions

Kaze no Michi has no versioned releases yet. Only the latest commit on the `main` branch is supported: security fixes land there, and older commits are not patched.

## Reporting a vulnerability

Please report vulnerabilities privately, through GitHub. Do not open a public issue, pull request or discussion for a vulnerability.

1. Open the [Security tab](https://github.com/cryptosecco/kaze-no-michi/security) of the repository.
2. Choose **Report a vulnerability**.
3. Describe what you found, how to reproduce it and what you think the impact is. A proof of concept helps.

If that option is not available, contact the maintainer @cryptosecco on GitHub and ask for a private way to share the details. Do not post the details publicly.

## Scope

Kaze no Michi is a static, client-side game. It has no backend, no user accounts and no analytics or telemetry. What it does with data:

- It stores the player's settings in the browser's `localStorage`, under the key `kaze.settings.v1`, and nothing else.
- The only request it makes to a third party is for its typefaces, which the page loads from Google Fonts.

Reports about the code in this repository are in scope: the game, the build configuration, the developer scripts and the GitHub Actions workflows. A vulnerability in a third-party dependency (three.js, Vite, Playwright) belongs to that project. If this project's use of a dependency makes the problem exploitable, please report it here as well.

## What to expect

This project is maintained on a best-effort basis: reports are read and answered when time allows, and there is no service-level agreement. Please allow a reasonable time for a fix before you disclose a problem publicly.
