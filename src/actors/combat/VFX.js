import * as THREE from 'three';

// Combat VFX: blade trail ribbons, clash sparks + light flash, stylized blood spray, gold "unblockable" glint.
// Everything is pre-allocated (instanced meshes, one point light at intensity 0) so effects never trigger
// shader recompiles or allocations mid-fight.

const TRAIL_N = 16;
const _v = new THREE.Vector3(), _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _m = new THREE.Matrix4(), _c = new THREE.Vector3();

function softDot(size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.45, 'rgba(255,255,255,0.75)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function starTex(size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const h = size / 2;
  const grd = g.createRadialGradient(h, h, 0, h, h, h);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.12, 'rgba(255,240,200,0.9)');
  grd.addColorStop(0.35, 'rgba(255,200,120,0.25)');
  grd.addColorStop(1, 'rgba(255,180,80,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  g.globalCompositeOperation = 'lighter';
  for (const [w, l] of [[3, 1], [2, 0.7]]) {
    for (const a of [0, Math.PI / 2, Math.PI / 4, -Math.PI / 4]) {
      g.save();
      g.translate(h, h);
      g.rotate(a);
      const len = a % (Math.PI / 2) === 0 ? h * l : h * l * 0.45;
      const lg = g.createLinearGradient(-len, 0, len, 0);
      lg.addColorStop(0, 'rgba(255,220,150,0)');
      lg.addColorStop(0.5, 'rgba(255,250,235,1)');
      lg.addColorStop(1, 'rgba(255,220,150,0)');
      g.fillStyle = lg;
      g.fillRect(-len, -w / 2, len * 2, w);
      g.restore();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

class Trail {
  constructor(color) {
    this.base = Array.from({ length: TRAIL_N }, () => new THREE.Vector3());
    this.tip = Array.from({ length: TRAIL_N }, () => new THREE.Vector3());
    this.alive = new Float32Array(TRAIL_N);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_N * 2 * 3), 3));
    geo.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(TRAIL_N * 2), 1));
    geo.setAttribute('side', new THREE.BufferAttribute(new Float32Array(TRAIL_N * 2).map((_, i) => i % 2), 1));
    const idx = [];
    for (let i = 0; i < TRAIL_N - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, b, c, b, d, c);
    }
    geo.setIndex(idx);
    this.mesh = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({
        uniforms: { uColor: { value: color } },
        vertexShader: `attribute float alpha; attribute float side; varying float vA; varying float vS;
          void main(){ vA = alpha; vS = side; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `uniform vec3 uColor; varying float vA; varying float vS;
          void main(){ float a = vA * smoothstep(0.0, 0.85, vS); gl_FragColor = vec4(uColor * a, a); }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      })
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.active = false;
  }

  push(base, tip, on) {
    for (let i = TRAIL_N - 1; i > 0; i--) {
      this.base[i].copy(this.base[i - 1]);
      this.tip[i].copy(this.tip[i - 1]);
      this.alive[i] = this.alive[i - 1] * 0.9;
    }
    this.base[0].copy(base);
    this.tip[0].copy(tip);
    this.alive[0] = on ? 1 : 0;
    const pos = this.mesh.geometry.attributes.position, al = this.mesh.geometry.attributes.alpha;
    let any = false;
    for (let i = 0; i < TRAIL_N; i++) {
      pos.setXYZ(i * 2, this.base[i].x, this.base[i].y, this.base[i].z);
      pos.setXYZ(i * 2 + 1, this.tip[i].x, this.tip[i].y, this.tip[i].z);
      const f = Math.pow(1 - i / TRAIL_N, 1.6);
      const a = this.alive[i] * (i + 1 < TRAIL_N ? this.alive[i + 1] > 0.05 ? 1 : 0.3 : 0) * f;
      al.setX(i * 2, a * 0.55);
      al.setX(i * 2 + 1, a);
      if (a > 0.01) any = true;
    }
    pos.needsUpdate = true;
    al.needsUpdate = true;
    this.mesh.visible = any;
  }
}

class Burst {
  constructor(capacity, material, geo) {
    this.cap = capacity;
    this.mesh = new THREE.InstancedMesh(geo, material, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.p = [];
    this.renderOrder = 9;
  }

  emit(n, fn) {
    for (let i = 0; i < n; i++) {
      if (this.p.length >= this.cap) this.p.shift();
      this.p.push(fn(i));
    }
  }

  update(dt, camPos, gravity, orient) {
    const out = [];
    for (const q of this.p) {
      q.age += dt;
      if (q.age >= q.life) continue;
      q.v.y -= gravity * dt;
      q.v.multiplyScalar(Math.exp(-dt * (q.drag || 0)));
      q.pos.addScaledVector(q.v, dt);
      out.push(q);
    }
    this.p = out;
    let i = 0;
    for (const q of this.p) {
      const k = 1 - q.age / q.life;
      orient(q, k, camPos);
      this.mesh.setMatrixAt(i++, _m);
    }
    this.mesh.count = i;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

export class VFX {
  constructor(game) {
    this.game = game;
    this.group = new THREE.Group();
    this.group.name = 'vfx';
    this.trails = new Map();
    // sparks: HDR streaks
    const sparkGeo = new THREE.PlaneGeometry(1, 1);
    const sparkMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 5.2, 1.8), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    this.sparks = new Burst(160, sparkMat, sparkGeo);
    // blood: soft dark droplets
    const bloodMat = new THREE.MeshBasicMaterial({ color: 0x4a0806, map: softDot(), transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0.95 });
    this.blood = new Burst(260, bloodMat, new THREE.PlaneGeometry(1, 1));
    this.group.add(this.sparks.mesh, this.blood.mesh);
    // glints
    this.glintMat =new THREE.SpriteMaterial({ map: starTex(), color: new THREE.Color(7, 5, 2.2), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.glints = [];
    for (let i = 0; i < 4; i++) {
      const s = new THREE.Sprite(this.glintMat.clone());
      s.visible = false;
      s.renderOrder = 11;
      this.group.add(s);
      this.glints.push({ sprite: s, t: 0, dur: 0, follow: null });
    }
    // one shared flash light (present from the start → no recompiles)
    this.flash = new THREE.PointLight(0xffc88a, 0, 7, 2);
    this.flash.castShadow = false;
    this.group.add(this.flash);
    this.flashI = 0;
  }

  trailFor(actor) {
    let t = this.trails.get(actor);
    if (!t) {
      t = new Trail(actor.team === 'player' ? new THREE.Color(2.2, 2.0, 1.7) : new THREE.Color(1.6, 1.2, 0.9));
      this.trails.set(actor, t);
      this.group.add(t.mesh);
    }
    return t;
  }

  sparksAt(p, dir, n = 34) {
    this.sparks.emit(n, () => {
      const v = new THREE.Vector3((Math.random() - 0.5) * 2, Math.random() * 1.2, (Math.random() - 0.5) * 2).normalize();
      if (dir) v.addScaledVector(dir, 0.8).normalize();
      return { pos: p.clone(), v: v.multiplyScalar(3 + Math.random() * 7), age: 0, life: 0.18 + Math.random() * 0.35, drag: 2.5, len: 0.05 + Math.random() * 0.09 };
    });
    this.flash.position.copy(p);
    this.flashI = 7;
  }

  bloodAt(p, dir, n = 26) {
    this.blood.emit(n, () => {
      const v = new THREE.Vector3((Math.random() - 0.5) * 0.9, 0.25 + Math.random() * 0.8, (Math.random() - 0.5) * 0.9);
      if (dir) v.addScaledVector(dir, 1.3);
      return { pos: p.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.15, (Math.random() - 0.5) * 0.12)), v: v.multiplyScalar(1.6 + Math.random() * 3.2), age: 0, life: 0.45 + Math.random() * 0.5, drag: 1.2, size: 0.025 + Math.random() * 0.045 };
    });
  }

  glint(actor, dur = 0.5) {
    const g = this.glints.find((x) => x.t >= x.dur) || this.glints[0];
    g.t = 0;
    g.dur = dur;
    g.follow = actor;
    g.sprite.visible = true;
  }

  update(dt, actors) {
    const cam = this.game.camera;
    const camPos = cam.position;
    // trails (blade base → tip) while an attack or parry is in motion
    const base = new THREE.Vector3(), tip = new THREE.Vector3();
    for (const a of actors) {
      if (!a.weapon || !a.root.visible) continue;
      const f = a.fighter;
      const swinging = f && ((f.attack && f.inHitWindow()) || (f.attack && f.attack.layer.time > (f.attack.meta.hit ? f.attack.meta.hit[0] - 0.05 : 0) && f.attack.layer.time < (f.attack.meta.hit ? f.attack.meta.hit[1] + 0.06 : 0)));
      const t = this.trailFor(a);
      a.bladeSegment(base, tip);
      // trail covers the upper two thirds of the blade
      base.lerp(tip, 0.25);
      t.push(base, tip, !!swinging);
    }
    this.sparks.update(dt, camPos, 9.8, (q, k) => {
      _x.copy(q.v).normalize();
      _c.subVectors(camPos, q.pos).normalize();
      _y.crossVectors(_x, _c).normalize();
      _z.crossVectors(_x, _y);
      const len = q.len * (0.4 + k);
      _m.makeBasis(_x.multiplyScalar(len), _y.multiplyScalar(0.006 + 0.004 * k), _z);
      _m.setPosition(q.pos);
    });
    this.blood.update(dt, camPos, 9.8, (q, k) => {
      _x.copy(q.v);
      const sp = _x.length();
      _x.normalize();
      _c.subVectors(camPos, q.pos).normalize();
      _y.crossVectors(_x, _c).normalize();
      _z.crossVectors(_x, _y);
      const s = q.size * (0.6 + 0.4 * k);
      _m.makeBasis(_x.multiplyScalar(s * (1 + sp * 0.12)), _y.multiplyScalar(s), _z);
      _m.setPosition(q.pos);
    });
    this.flashI *= Math.exp(-dt * 22);
    this.flash.intensity = this.flashI;
    for (const g of this.glints) {
      if (g.t >= g.dur) {
        g.sprite.visible = false;
        continue;
      }
      g.t += dt;
      if (g.follow && g.follow.weapon) {
        g.follow.bladeSegment(base, tip);
        g.sprite.position.copy(tip);
      }
      const k = g.t / g.dur;
      const pulse = Math.sin(Math.min(1, k) * Math.PI);
      const s = 0.25 + 0.55 * pulse;
      g.sprite.scale.set(s, s, s);
      g.sprite.material.rotation = k * 1.2;
      g.sprite.material.opacity = pulse;
    }
  }
}
