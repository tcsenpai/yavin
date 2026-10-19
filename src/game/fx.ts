// Particle effects: fireballs, sparks, smoke, debris, flak bursts and dynamic flash lights.
import * as THREE from 'three';
import { Rng } from '../core/rng';

const VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float aSize;
  attribute vec4 aColor;
  varying vec4 vColor;
  uniform float uScale;
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(aSize * uScale / max(-mv.z, 0.1), 0.0, 512.0);
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }
`;
const FRAG = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  varying vec4 vColor;
  uniform float uSoft;
  void main() {
    #include <logdepthbuf_fragment>
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d) * 2.0;
    if (r > 1.0) discard;
    float a = pow(1.0 - r, uSoft);
    gl_FragColor = vec4(vColor.rgb, vColor.a * a);
  }
`;

type Kind = 0 | 1 | 2; // fire, spark, smoke

class ParticlePool {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private s0: Float32Array;
  private s1: Float32Array;
  private kind: Uint8Array;
  private drag: Float32Array;
  private cursor = 0;
  private uniforms: { uScale: { value: number }; uSoft: { value: number } };

  constructor(readonly capacity: number, blending: THREE.Blending, soft: number) {
    this.pos = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 4);
    this.size = new Float32Array(capacity);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.s0 = new Float32Array(capacity);
    this.s1 = new Float32Array(capacity);
    this.kind = new Uint8Array(capacity);
    this.drag = new Float32Array(capacity);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.uniforms = { uScale: { value: 600 }, uSoft: { value: soft } };
    const m = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending,
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  setViewportScale(h: number, fov: number): void {
    this.uniforms.uScale.value = h / (2 * Math.tan((fov * Math.PI) / 360));
  }

  emit(p: THREE.Vector3, v: THREE.Vector3, life: number, s0: number, s1: number, kind: Kind, drag: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.pos[i * 3] = p.x;
    this.pos[i * 3 + 1] = p.y;
    this.pos[i * 3 + 2] = p.z;
    this.vel[i * 3] = v.x;
    this.vel[i * 3 + 1] = v.y;
    this.vel[i * 3 + 2] = v.z;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.s0[i] = s0;
    this.s1[i] = s1;
    this.kind[i] = kind;
    this.drag[i] = drag;
  }

  update(dt: number): void {
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) {
        this.size[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const t = 1 - Math.max(this.life[i], 0) / this.maxLife[i]; // 0 → 1
      const k = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= k;
      this.vel[i * 3 + 1] *= k;
      this.vel[i * 3 + 2] *= k;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * Math.sqrt(t);
      const c = i * 4;
      switch (this.kind[i]) {
        case 0: {
          // White-hot → yellow → orange → deep red, fading.
          const r = 1;
          const g = t < 0.15 ? 1 : Math.max(0.15, 1 - (t - 0.15) * 1.4);
          const b = t < 0.08 ? 0.85 : Math.max(0.02, 0.5 - t * 1.6);
          const boost = 3.2 * (1 - t) + 0.4;
          this.col[c] = r * boost;
          this.col[c + 1] = g * boost * 0.85;
          this.col[c + 2] = b * boost * 0.6;
          this.col[c + 3] = (1 - t) * (1 - t);
          break;
        }
        case 1: {
          const boost = 4 * (1 - t);
          this.col[c] = boost;
          this.col[c + 1] = boost * 0.75;
          this.col[c + 2] = boost * 0.4;
          this.col[c + 3] = 1 - t;
          break;
        }
        default: {
          const g = 0.09 + t * 0.06;
          this.col[c] = g;
          this.col[c + 1] = g;
          this.col[c + 2] = g * 1.05;
          this.col[c + 3] = Math.min(t * 6, 1) * (1 - t) * 0.7;
        }
      }
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aColor.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
  }
}

interface Debris {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  life: number;
}

interface Flash {
  light: THREE.PointLight;
  life: number;
  max: number;
  peak: number;
}

const _v = new THREE.Vector3();
const _p = new THREE.Vector3();

export class FX {
  readonly group = new THREE.Group();
  private fire = new ParticlePool(5000, THREE.AdditiveBlending, 1.6);
  private smoke = new ParticlePool(2500, THREE.NormalBlending, 1.2);
  private debris: Debris[] = [];
  private flashes: Flash[] = [];
  private rng = new Rng(4242);
  private debrisGeo = new THREE.BoxGeometry(1, 0.3, 0.7);
  private debrisMat = new THREE.MeshStandardMaterial({ color: 0x55575c, roughness: 0.7, metalness: 0.5 });

  constructor() {
    this.group.add(this.smoke.points, this.fire.points);
    for (let i = 0; i < 4; i++) {
      const light = new THREE.PointLight(0xffa050, 0, 600, 1.6);
      this.group.add(light);
      this.flashes.push({ light, life: 0, max: 1, peak: 0 });
    }
  }

  setViewport(h: number, fov: number): void {
    this.fire.setViewportScale(h, fov);
    this.smoke.setViewportScale(h, fov);
  }

  private randDir(scale: number): THREE.Vector3 {
    const r = this.rng;
    _v.set(r.range(-1, 1), r.range(-1, 1), r.range(-1, 1));
    if (_v.lengthSq() < 1e-4) _v.set(0, 1, 0);
    return _v.normalize().multiplyScalar(scale);
  }

  private flash(pos: THREE.Vector3, peak: number, dur: number, range: number): void {
    const f = this.flashes.reduce((a, b) => (a.life < b.life ? a : b));
    f.light.position.copy(pos);
    f.light.distance = range;
    f.life = dur;
    f.max = dur;
    f.peak = peak;
  }

  /** Ship/structure explosion. `scale` ≈ object radius in metres. */
  explosion(pos: THREE.Vector3, scale: number, inherit?: THREE.Vector3): void {
    const r = this.rng;
    const n = Math.min(40 + scale * 14, 360);
    for (let i = 0; i < n; i++) {
      _p.copy(pos).addScaledVector(this.randDir(1), r.range(0, scale * 0.4));
      const v = this.randDir(r.range(0.2, 1) * scale * 7);
      if (inherit) v.addScaledVector(inherit, 0.35);
      this.fire.emit(_p, v, r.range(0.5, 1.3) * (0.7 + scale * 0.04), scale * r.range(0.6, 1.4), scale * r.range(2.2, 4), 0, 2.2);
    }
    for (let i = 0; i < n * 0.6; i++) {
      const v = this.randDir(r.range(40, 160) + scale * 8);
      if (inherit) v.addScaledVector(inherit, 0.5);
      this.fire.emit(pos, v, r.range(0.3, 1.2), scale * 0.18 + 0.4, 0.05, 1, 0.9);
    }
    for (let i = 0; i < n * 0.35; i++) {
      const v = this.randDir(r.range(2, 10) * (1 + scale * 0.3));
      if (inherit) v.addScaledVector(inherit, 0.2);
      this.smoke.emit(pos, v, r.range(1.8, 3.8), scale * 1.2, scale * r.range(3.5, 6), 2, 0.8);
    }
    const dn = Math.min(4 + Math.floor(scale), 14);
    for (let i = 0; i < dn; i++) this.spawnDebris(pos, scale, inherit);
    this.flash(pos, 40 + scale * 25, 0.45 + scale * 0.03, 80 + scale * 40);
  }

  private spawnDebris(pos: THREE.Vector3, scale: number, inherit?: THREE.Vector3): void {
    let d = this.debris.find((x) => x.life <= 0);
    if (!d) {
      if (this.debris.length >= 80) return;
      d = { mesh: new THREE.Mesh(this.debrisGeo, this.debrisMat), vel: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0 };
      this.debris.push(d);
      this.group.add(d.mesh);
    }
    const r = this.rng;
    d.mesh.visible = true;
    d.mesh.position.copy(pos);
    const s = r.range(0.3, 1) * Math.max(scale * 0.18, 0.5);
    d.mesh.scale.set(s * r.range(0.5, 2), s, s * r.range(0.5, 1.5));
    d.vel.copy(this.randDir(r.range(20, 70) + scale * 4));
    if (inherit) d.vel.addScaledVector(inherit, 0.6);
    d.spin.set(r.range(-8, 8), r.range(-8, 8), r.range(-8, 8));
    d.life = r.range(1.5, 3.5);
  }

  /** Laser impact on a hull: sparks + small flash. */
  sparks(pos: THREE.Vector3, normal?: THREE.Vector3): void {
    const r = this.rng;
    for (let i = 0; i < 14; i++) {
      const v = this.randDir(r.range(20, 90));
      if (normal) v.addScaledVector(normal, 50);
      this.fire.emit(pos, v, r.range(0.15, 0.5), 0.45, 0.05, 1, 2);
    }
    for (let i = 0; i < 4; i++) this.fire.emit(pos, this.randDir(4), r.range(0.15, 0.3), 1.5, 4, 0, 3);
    for (let i = 0; i < 2; i++) this.smoke.emit(pos, normal ? _p.copy(normal).multiplyScalar(4) : this.randDir(3), 1.2, 1.5, 6, 2, 0.6);
  }

  /** Imperial flak burst: dark smoke puff with a bright core (as seen over the Death Star). */
  flak(pos: THREE.Vector3): void {
    const r = this.rng;
    for (let i = 0; i < 18; i++) this.fire.emit(pos, this.randDir(r.range(5, 30)), r.range(0.15, 0.4), 4, 9, 0, 3);
    for (let i = 0; i < 10; i++) this.smoke.emit(pos, this.randDir(r.range(2, 9)), r.range(1.5, 2.6), 6, 16, 2, 0.4);
    this.flash(pos, 25, 0.2, 140);
  }

  /** Continuous smoke/fire trail for damaged ships (call each frame). */
  trail(pos: THREE.Vector3, vel: THREE.Vector3, intensity: number): void {
    const r = this.rng;
    if (r.float() < intensity) this.smoke.emit(pos, _v.copy(vel).multiplyScalar(0.1), r.range(1, 2), 1.5, 6, 2, 1);
    if (r.float() < intensity * 0.6) this.fire.emit(pos, this.randDir(4).addScaledVector(vel, 0.2), 0.25, 1.2, 0.3, 0, 2);
  }

  /** Engine/muzzle flash sprite. */
  muzzle(pos: THREE.Vector3, vel: THREE.Vector3): void {
    this.fire.emit(pos, vel, 0.06, 2.6, 1.2, 1, 0);
  }

  update(dt: number): void {
    this.fire.update(dt);
    this.smoke.update(dt);
    for (const d of this.debris) {
      if (d.life <= 0) continue;
      d.life -= dt;
      d.mesh.position.addScaledVector(d.vel, dt);
      d.mesh.rotation.x += d.spin.x * dt;
      d.mesh.rotation.y += d.spin.y * dt;
      d.mesh.rotation.z += d.spin.z * dt;
      if (d.life <= 0) d.mesh.visible = false;
    }
    for (const f of this.flashes) {
      if (f.life <= 0) {
        f.light.intensity = 0;
        continue;
      }
      f.life -= dt;
      const t = Math.max(f.life, 0) / f.max;
      f.light.intensity = f.peak * t * t * 400;
    }
  }
}
