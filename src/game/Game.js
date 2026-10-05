import * as THREE from 'three';
import { Renderer } from '../core/Renderer.js';
import { Loop } from '../core/Loop.js';
import { Input } from '../core/Input.js';
import { FreeCamera } from '../core/FreeCamera.js';
import { getPreset } from '../core/Quality.js';
import { createNoise } from '../render/NoiseTexture.js';
import { GLOBAL_UNIFORMS, registerGlobalUniforms } from '../render/globals.js';
import { atmosphere } from '../render/Atmosphere.js';
import { PostFX } from '../render/PostFX.js';
import { GodRays, DepthOfField } from '../render/Effects.js';
import { wind } from '../world/Wind.js';
import { Sky } from '../world/Sky.js';
import { Lighting } from '../world/Lighting.js';
import { Terrain } from '../world/Terrain.js';
import { Water } from '../world/Water.js';
import { Backdrop } from '../world/Backdrop.js';
import { Grass } from '../world/Grass.js';
import { POI } from '../world/Layout.js';
import { Colliders } from './Colliders.js';

// Game: owns renderer, scene, camera and the world systems.
//   game.add(object3D)        add to the scene AND patch every material (shared uniforms: atmosphere, wind,
//                             noise, terrain; then material.userData.onBeforeCompile(shader, renderer))
//   game.addSystem({ update(dt, t), frame(dt, t) })   fixed-step update and/or per-frame hooks
//   game.setTimeOfDay(hours)  sun, sky, fog palette, IBL and baked terrain shadows
// Shared hooks for feature modules (see src/game/modules.js):
//   game.emit(type, detail) / game.on(type, fn) / game.off(type, fn)   event bus (detail in e.detail)
//   game.setState('title'|'play'|'paused'|'cutscene')                   emits 'state' { state, prev }
//   game.colliders                     static 2D colliders (addCircle/addBox/resolve/nearby)
//   game.addGroundOverride(fn)         fn(x, z) → height | null (stairs, floors); game.groundAt(x, z)
//   game.cameraController              object with frame(dt, t); drives the camera outside shot mode
//   game.onShot(fn)                    fn(shotId, shotDef) after a canonical shot pose is applied
//   game.player                        the player actor (set by the actors module)

const LIT = new Set(['MeshStandardMaterial', 'MeshPhysicalMaterial', 'MeshLambertMaterial', 'MeshPhongMaterial', 'MeshToonMaterial']);

export class Game {
  constructor(container, opts = {}) {
    this.container = container;
    this.opts = opts;
    this.quality = getPreset(opts.quality || 'high');
    this.seed = opts.seed || 1234;
    this.systems = [];
    this.ready = false;
    this.timeOfDay = 17.7;
    this._patched = new WeakSet();
    this.events = new EventTarget();
    this.state = 'boot';
    this.colliders = new Colliders();
    this._groundOverrides = [];
    this._shotHooks = [];
    this.cameraController = null;
    this.player = null;
    this.modules = {};
    this._extraStats = [];
  }

  emit(type, detail) {
    this.events.dispatchEvent(new CustomEvent(type, { detail }));
  }

  on(type, fn) {
    this.events.addEventListener(type, fn);
    return () => this.off(type, fn);
  }

  off(type, fn) {
    this.events.removeEventListener(type, fn);
  }

  setState(state) {
    if (state === this.state) return;
    const prev = this.state;
    this.state = state;
    this.emit('state', { state, prev });
  }

  addGroundOverride(fn) {
    this._groundOverrides.push(fn);
    return fn;
  }

  // Walkable ground height: terrain, raised by any override (stairs, floors, platforms) covering (x, z).
  groundAt(x, z) {
    let h = this.terrain.heightAt(x, z);
    for (const fn of this._groundOverrides) {
      const o = fn(x, z);
      if (o != null && o > h) h = o;
    }
    return h;
  }

  // Extra entries merged into stats() (read by the shots harness → report.json), e.g. a module's CPU cost.
  addStat(fn) {
    this._extraStats.push(fn);
    return fn;
  }

  onShot(fn) {
    this._shotHooks.push(fn);
    return fn;
  }

  _runShotHooks(id, def) {
    for (const fn of this._shotHooks) {
      try {
        fn(id, def);
      } catch (err) {
        console.error('[kaze] shot hook failed:', err);
      }
    }
  }

  async init(onProgress = () => {}) {
    onProgress(0.05, 'noise');
    this.noise = createNoise(7);
    registerGlobalUniforms({ uNoiseTex: { value: this.noise.texture } });
    wind.setNoise(this.noise);
    this.wind = wind;
    this.atmosphere = atmosphere;
    atmosphere.install();

    this.renderer = new Renderer(this.container, this.quality);
    if (this.opts.deterministic) this.renderer.dyn.enabled = false; // reproducible captures
    this.gl = this.renderer.renderer;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0xffffff, 0.0001); // enables USE_FOG → kaze atmosphere chunks
    this.camera = new THREE.PerspectiveCamera(50, this.renderer.width / this.renderer.height, 0.3, 20000);
    this.renderer.onResize((r) => {
      this.camera.aspect = r.width / r.height;
      this.camera.updateProjectionMatrix();
    });
    this.input = new Input(this.renderer.canvas);

    onProgress(0.15, 'sky');
    this.sky = new Sky();
    this.scene.add(this.sky.mesh);
    this.lighting = new Lighting({
      renderer: this.gl,
      scene: this.scene,
      quality: this.quality,
      atmosphere,
      sky: this.sky,
    });

    onProgress(0.25, 'terrain');
    await nextFrame();
    this.terrain = new Terrain({ seed: this.seed, quality: this.quality });
    this.terrain.onMaterialSwap = (m) => this.patchMaterial(m);
    this.add(this.terrain.group);

    this.backdrop = new Backdrop();
    this.add(this.backdrop.group);

    onProgress(0.6, 'water');
    this.water = new Water();
    this.water.mesh.renderOrder = 5;
    this.add(this.water.mesh);

    onProgress(0.7, 'grass');
    await nextFrame();
    this.grass = new Grass({ quality: this.quality });
    this.add(this.grass.group);

    this.post = new PostFX(this.renderer, this.quality);
    this.godRays = this.post.addHDRPass(new GodRays(this.post));
    this.dof = this.post.addHDRPass(new DepthOfField(this.post));

    onProgress(0.8, 'light');
    this.setTimeOfDay(this.timeOfDay);
    await this.terrain.loadPhotoTextures(this.gl).catch(() => false);

    // default view: in the field, looking toward the shrine hill and the setting sun
    const h = this.terrain.heightAt(POI.spawn.x, POI.spawn.z);
    this.camera.position.set(POI.spawn.x + 12, h + 1.75, POI.spawn.z - 6);
    this.camera.lookAt(POI.shrine.x, h + 18, POI.shrine.z);
    this.freeCam = new FreeCamera(this.camera, this.input, this.terrain);
    this.freeCam.enabled = !this.opts.noFreeCam;

    onProgress(0.9, 'shaders');
    this.renderer.canvas.addEventListener('click', () => {
      if (this.freeCam.enabled && !this.opts.shot) this.input.requestPointerLock();
    });
    this.loop = new Loop({
      update: (dt, t) => this.update(dt, t),
      frame: (dt, t, a, ms) => this.frame(dt, t, a, ms),
      deterministic: !!this.opts.deterministic,
    });
    this._patchNew();
    await this.gl.compileAsync(this.scene, this.camera).catch(() => {});
    onProgress(1, 'ready');
    return this;
  }

  start() {
    this.loop.start();
  }

  add(object) {
    if (!object.parent) this.scene.add(object);
    object.traverse((o) => {
      if (!o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) this.patchMaterial(m);
    });
    return object;
  }

  remove(object) {
    if (object.parent) object.parent.remove(object);
  }

  patchMaterial(mat) {
    if (!mat || this._patched.has(mat)) return mat;
    this._patched.add(mat);
    const prev = mat.onBeforeCompile;
    const custom = mat.userData && mat.userData.onBeforeCompile;
    mat.onBeforeCompile = function (shader, renderer) {
      if (prev) prev.call(this, shader, renderer);
      for (const k in GLOBAL_UNIFORMS) if (!(k in shader.uniforms)) shader.uniforms[k] = GLOBAL_UNIFORMS[k];
      if (custom) custom(shader, renderer);
    };
    const key = (mat.userData && mat.userData.shaderKey) || '';
    mat.customProgramCacheKey = () => 'kaze|' + key;
    mat.needsUpdate = true;
    return mat;
  }

  // safety net: patch materials that were added to the scene without game.add()
  _patchNew() {
    this.scene.traverse((o) => {
      if (!o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (!this._patched.has(m) && m.type !== 'ShaderMaterial' && m.type !== 'RawShaderMaterial') this.patchMaterial(m);
    });
  }

  addSystem(sys) {
    this.systems.push(sys);
    return sys;
  }

  removeSystem(sys) {
    this.systems = this.systems.filter((s) => s !== sys);
  }

  setTimeOfDay(hours) {
    this.timeOfDay = hours;
    this.lighting.setTimeOfDay(hours);
    this.terrain.bakeLighting(this.lighting.sunDir);
    // skylight scattered inside thin translucent vegetation (pampas plumes) follows the fill light
    const f = this.lighting.fill;
    if (GLOBAL_UNIFORMS.uPlumeGlow) GLOBAL_UNIFORMS.uPlumeGlow.value.copy(f.color).multiplyScalar(f.intensity * 0.55);
  }

  setQuality(name) {
    this.quality = getPreset(name);
    this.renderer.setQuality(this.quality);
    this.lighting.setQuality(this.quality);
  }

  update(dt, t) {
    wind.update(dt);
    for (const s of this.systems) if (s.update) s.update(dt, t);
  }

  frame(dt, t, alpha, realMs) {
    this.input.update();
    for (const s of this.systems) if (s.frame) s.frame(dt, t, alpha);
    if (this.freeCam && this.freeCam.enabled) this.freeCam.frame(dt);
    else if (this.cameraController && !this.opts.shot) this.cameraController.frame(dt, t);
    const cam = this.camera;
    // guiding wind is computed from the player when there is one in play, otherwise from the camera
    const org = this.player && this.state === 'play' ? this.player.position : cam.position;
    wind.setOrigin(org.x, org.z);
    this.sky.update(cam, dt, wind.uniforms.uWindDir.value);
    this.water.update(cam);
    this.grass.update(cam, this.renderer.renderHeight, this.gl);
    this.lighting.update();
    if ((this.loop.frameCount & 63) === 0) this._patchNew();
    this.gl.info.reset();
    // the film grain is seeded by the wind clock, not by loop.time: kaze.setShot() re-anchors the wind clock to the
    // shot's t0, so a capture's grain depends on the shot and the frames since it was set, not on how long the page
    // ran before (the fps pass, the load). In play the two clocks run together (wind.update(dt) takes the same fixed
    // steps), so the grain animates the same either way
    this.post.render(this.scene, cam, wind.time);
    this.renderer.updateDynamicResolution(realMs);
  }

  stats() {
    const info = this.gl.info;
    return {
      fps: 1000 / Math.max(1, this.loop.lastFrameMs),
      frameMs: this.loop.lastFrameMs,
      calls: info.render.calls,
      triangles: info.render.triangles,
      renderScale: this.renderer.renderScale,
      renderSize: [this.renderer.renderWidth, this.renderer.renderHeight],
      quality: this.quality.name,
      grass: this.grass.stats(),
      ...Object.assign({}, ...this._extraStats.map((fn) => fn())),
    };
  }
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}
