#!/usr/bin/env node
// Trot lab — both halves with the same arguments, one after the other (never two Chromes at once): the Node simulation
// (metrics, reference check, plots), then the browser capture (contact sheets).
//   npm run trotlab:all -- --label <name>
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
for (const step of ['sim.mjs', 'capture.mjs']) {
  const r = spawnSync(process.execPath, [path.join(dir, step), ...args], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`trotlab: ${step} failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}
