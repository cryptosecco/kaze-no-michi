import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

// virtual:kaze-assets → { textures: [...], models: [...], audio: [...] } listing files present in public/assets.
// Lets the engine use optional art (photo textures, models) without probing URLs (no 404s in the console).
function kazeAssets() {
  const id = 'virtual:kaze-assets';
  const rid = '\0' + id;
  let root = process.cwd();
  const list = (dir) => {
    const p = path.resolve(root, 'public/assets', dir);
    return fs.existsSync(p) ? fs.readdirSync(p).filter((f) => !f.startsWith('.')) : [];
  };
  return {
    name: 'kaze-assets',
    configResolved(config) {
      root = config.root;
    },
    resolveId(source) {
      if (source === id) return rid;
    },
    load(source) {
      if (source !== rid) return;
      return `export default ${JSON.stringify({ textures: list('textures'), models: list('models'), audio: list('audio') })};`;
    },
    configureServer(server) {
      const reload = (file) => {
        if (!file.includes(path.join('public', 'assets'))) return;
        const mod = server.moduleGraph.getModuleById(rid);
        if (mod) server.moduleGraph.invalidateModule(mod);
      };
      server.watcher.on('add', reload);
      server.watcher.on('unlink', reload);
    },
  };
}

// build only: carries the legal notices into the production build; Vite drops legal comments when it minifies, so the
// three.js MIT license is added as a postBanner (applied after minification) to the chunks that bundle the three.js
// library files, and THIRD_PARTY_NOTICES.md is emitted as THIRD_PARTY_NOTICES.txt next to index.html
function kazeNotices() {
  let root = process.cwd();
  // the library files (three.core.js, three.module.js) are in three/build; the addons in examples/jsm get no banner
  const isThreeLib = (id) => id.replace(/\\/g, '/').includes('/node_modules/three/build/');
  return {
    name: 'kaze-notices',
    apply: 'build',
    configResolved(config) {
      root = config.root;
    },
    outputOptions(options) {
      const file = path.resolve(root, 'node_modules/three/LICENSE');
      // a `*/` in the text would end the comment early
      const license = fs.readFileSync(file, 'utf8').replaceAll('*/', '* /').trimEnd();
      const banner = `/*! three.js, https://threejs.org\n\n${license}\n*/`;
      // undefined, not '', for the other chunks: an empty banner still adds a blank line to the chunk
      const own = (chunk) => (chunk.moduleIds.some(isThreeLib) ? banner : undefined);
      const prev = options.postBanner;
      if (!prev) return { ...options, postBanner: own };
      // a postBanner that is already set stays, after ours
      const both = async (chunk) => {
        const other = typeof prev === 'function' ? await prev(chunk) : prev;
        return [own(chunk), other].filter(Boolean).join('\n') || undefined;
      };
      return { ...options, postBanner: both };
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'THIRD_PARTY_NOTICES.txt',
        source: fs.readFileSync(path.resolve(root, 'THIRD_PARTY_NOTICES.md'), 'utf8'),
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [kazeAssets(), kazeNotices()],
  server: { port: 5173, strictPort: false },
  // pre-bundle everything up front: avoids mid-session "optimized dependencies changed" reloads
  optimizeDeps: {
    include: [
      'three',
      'three/addons/lights/SunLight.js',
      'three/addons/postprocessing/Pass.js',
      'three/addons/loaders/GLTFLoader.js',
      'three/addons/utils/SkeletonUtils.js',
    ],
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  assetsInclude: ['**/*.glb', '**/*.hdr'],
});
