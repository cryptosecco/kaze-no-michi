import * as THREE from 'three';

// Developer fly camera: click to lock pointer, WASD to move, E/Q up/down, Shift fast, wheel = speed.
// Keeps a minimum clearance above the terrain so inspection never clips underground.

export class FreeCamera {
  constructor(camera, input, terrain) {
    this.camera = camera;
    this.input = input;
    this.terrain = terrain;
    this.enabled = true;
    this.speed = 12;
    this.yaw = 0;
    this.pitch = 0;
    this._v = new THREE.Vector3();
    this._f = new THREE.Vector3();
    this._r = new THREE.Vector3();
    this.syncFromCamera();
  }

  syncFromCamera() {
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.yaw = e.y;
    this.pitch = e.x;
  }

  frame(dt) {
    if (!this.enabled) return;
    const inp = this.input;
    const look = inp.look(dt);
    if (inp.pointerLocked || inp.pad.connected) {
      this.yaw -= look.x;
      this.pitch = THREE.MathUtils.clamp(this.pitch - look.y, -1.5, 1.5);
    }
    if (inp.wheel) this.speed = THREE.MathUtils.clamp(this.speed * (inp.wheel > 0 ? 0.8 : 1.25), 1, 400);
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    const m = inp.move();
    const f = this._f.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const r = this._r.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const v = this._v.set(0, 0, 0).addScaledVector(f, m.y).addScaledVector(r, m.x);
    if (inp.down('up')) v.y += 1;
    if (inp.down('down')) v.y -= 1;
    const sp = this.speed * (inp.down('fast') ? 4 : 1);
    this.camera.position.addScaledVector(v, sp * dt);
    if (this.terrain) {
      const h = this.terrain.heightAt(this.camera.position.x, this.camera.position.z) + 0.6;
      if (this.camera.position.y < h) this.camera.position.y = h;
    }
  }
}
