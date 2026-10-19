// Laser bolts (instanced camera-facing beams, two colours) and proton torpedoes (billboard glow).
import * as THREE from 'three';
import type { Targetable, Team } from './types';
import type { World } from './world';

interface Bolt {
  active: boolean;
  pos: THREE.Vector3;
  prev: THREE.Vector3;
  dir: THREE.Vector3;
  speed: number;
  life: number;
  team: Team;
  owner: Targetable | null;
  damage: number;
  color: 0 | 1;
  heavy: boolean;
}

export interface Torpedo {
  active: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  target: Targetable | null;
  /** Fixed homing point (exhaust port) when not chasing a Targetable. */
  point: THREE.Vector3 | null;
  owner: Targetable;
  life: number;
  mesh: THREE.Mesh;
  /** Set by script to decide the outcome on arrival at `point`. */
  onArrive: ((t: Torpedo) => void) | null;
  guidance: number;
}

const MAX_BOLTS = 600;
const _s = new THREE.Vector3();
const _n = new THREE.Vector3();
const _v = new THREE.Vector3();
const _px = new THREE.Vector2();

// Bolt beam: the instance matrix carries tail (column 3), axis × length (column 2) and thickness
// (|column 0|). The quad is expanded in view space around the projected axis with rounded caps, so
// bolts seen end-on still read as glowing dots; sub-pixel bolts are widened and dimmed instead of aliasing.
const BOLT_VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  uniform float uPx;
  uniform float uGlow;
  varying vec2 vQ;
  varying float vLen;
  varying float vI;
  void main() {
    vec3 tail = instanceMatrix[3].xyz;
    vec3 axis = instanceMatrix[2].xyz;
    float thick = length(instanceMatrix[0].xyz);
    vec3 a = (modelViewMatrix * vec4(tail, 1.0)).xyz;
    vec3 b = (modelViewMatrix * vec4(tail + axis, 1.0)).xyz;
    vec3 mid = 0.5 * (a + b);
    float depth = max(length(mid), 0.1);
    float hw = thick * uGlow;
    float minW = 2.0 * depth / uPx;
    vI = 1.0;
    if (hw < minW) {
      vI = hw / minW;
      hw = minW;
    }
    vec3 vdir = mid / depth;
    vec3 ab = b - a;
    vec3 axP = ab - dot(ab, vdir) * vdir;
    float lp = length(axP);
    vec3 u = lp > 1e-4 ? axP / lp : (abs(vdir.y) < 0.99 ? normalize(cross(vdir, vec3(0.0, 1.0, 0.0))) : vec3(1.0, 0.0, 0.0));
    vec3 side = normalize(cross(u, vdir));
    vec3 p = (position.y < 0.5 ? a - u * hw : b + u * hw) + side * (position.x * hw);
    vLen = lp / hw;
    vQ = vec2(position.x, position.y < 0.5 ? -1.0 : vLen + 1.0);
    gl_Position = projectionMatrix * vec4(p, 1.0);
    #include <logdepthbuf_vertex>
  }
`;
const BOLT_FRAG = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uCore;
  uniform vec3 uColor;
  varying vec2 vQ;
  varying float vLen;
  varying float vI;
  void main() {
    #include <logdepthbuf_fragment>
    float y = vQ.y;
    float dy = max(max(-y, y - vLen), 0.0);
    float f = clamp(y / max(vLen, 0.001), 0.0, 1.0); // 0 tail → 1 head
    float d = length(vec2(vQ.x, dy));
    float cw = mix(0.15, 0.27, f);
    float core = exp(-(d * d) / (cw * cw));
    float halo = exp(-d * 3.0) * (1.0 - smoothstep(0.6, 1.0, d));
    vec3 c = uCore * core * mix(0.5, 1.0, f) + uColor * halo * mix(0.55, 1.0, f);
    gl_FragColor = vec4(c * vI, 1.0);
  }
`;

// Torpedo: white-hot core, flickering orange glow, faint lens ring and slowly turning star spikes.
const TORP_VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  uniform float uPx;
  varying vec2 vUv;
  varying float vI;
  varying float vPhase;
  void main() {
    vec4 c = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float size = 4.6;
    float minS = 7.0 * max(length(c.xyz), 0.1) / uPx;
    vI = 1.0;
    if (size < minS) {
      vI = size / minS;
      size = minS;
    }
    vPhase = fract(dot(modelMatrix[3].xyz, vec3(0.013, 0.007, 0.011)));
    c.xy += position.xy * size;
    vUv = position.xy;
    gl_Position = projectionMatrix * c;
    #include <logdepthbuf_vertex>
  }
`;
const TORP_FRAG = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform float uTime;
  varying vec2 vUv;
  varying float vI;
  varying float vPhase;
  void main() {
    #include <logdepthbuf_fragment>
    float r = length(vUv);
    if (r > 1.0) discard;
    float flick = 0.82 + 0.18 * sin(uTime * 53.0 + vPhase * 40.0) * sin(uTime * 31.0 + vPhase * 17.0);
    float core = exp(-r * r * 110.0);
    float inner = exp(-r * r * 16.0);
    float halo = exp(-r * 4.2);
    float ring = exp(-pow((r - 0.58) / 0.045, 2.0)) * 0.12;
    float ang = atan(vUv.y, vUv.x) + uTime * 1.3 + vPhase * 6.28;
    float spikes = pow(abs(cos(ang * 2.0)), 60.0) * exp(-r * 3.2) * 0.9;
    vec3 col = vec3(12.0, 10.5, 9.0) * core
      + vec3(7.0, 2.6, 0.7) * inner * flick
      + vec3(2.0, 0.5, 0.1) * halo * flick
      + vec3(1.0, 0.65, 0.35) * (ring + spikes);
    gl_FragColor = vec4(col * vI * (1.0 - smoothstep(0.8, 1.0, r)), 1.0);
  }
`;

export class Weapons {
  readonly group = new THREE.Group();
  private bolts: Bolt[] = [];
  private meshes: THREE.InstancedMesh[];
  readonly torpedoes: Torpedo[] = [];
  private time = 0;
  private pxUniform = { value: 600 };
  private timeUniform = { value: 0 };
  private torpGeo = new THREE.PlaneGeometry(2, 2);
  private torpMat = new THREE.ShaderMaterial({
    vertexShader: TORP_VERT,
    fragmentShader: TORP_FRAG,
    uniforms: { uPx: this.pxUniform, uTime: this.timeUniform },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  /** Keeps the pixel-size uniform in sync with the render target and camera. */
  private syncPx = (renderer: THREE.WebGLRenderer, _scene: THREE.Scene, camera: THREE.Camera): void => {
    this.pxUniform.value = 0.5 * renderer.getDrawingBufferSize(_px).y * camera.projectionMatrix.elements[5];
  };

  constructor() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 2, 1, 3]);
    const looks: [THREE.Vector3, THREE.Vector3][] = [
      [new THREE.Vector3(7, 5, 4.6), new THREE.Vector3(9, 0.35, 0.22)], // Rebel red
      [new THREE.Vector3(5, 7, 5), new THREE.Vector3(0.4, 8, 0.5)], // Imperial green
    ];
    this.meshes = looks.map(([core, color]) => {
      const mat = new THREE.ShaderMaterial({
        vertexShader: BOLT_VERT,
        fragmentShader: BOLT_FRAG,
        uniforms: { uPx: this.pxUniform, uGlow: { value: 3.2 }, uCore: { value: core }, uColor: { value: color } },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      const im = new THREE.InstancedMesh(geo, mat, MAX_BOLTS);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.frustumCulled = false;
      im.count = 0;
      im.renderOrder = 6;
      im.onBeforeRender = this.syncPx;
      this.group.add(im);
      return im;
    });
    for (let i = 0; i < MAX_BOLTS; i++) {
      this.bolts.push({
        active: false,
        pos: new THREE.Vector3(),
        prev: new THREE.Vector3(),
        dir: new THREE.Vector3(),
        speed: 0,
        life: 0,
        team: 'rebel',
        owner: null,
        damage: 0,
        color: 0,
        heavy: false,
      });
    }
  }

  fireBolt(owner: Targetable | null, origin: THREE.Vector3, dir: THREE.Vector3, speed: number, color: 'red' | 'green', damage: number, team?: Team, heavy = false): void {
    const b = this.bolts.find((x) => !x.active);
    if (!b) return;
    b.active = true;
    b.pos.copy(origin);
    b.prev.copy(origin);
    b.dir.copy(dir).normalize();
    b.speed = speed + (owner ? Math.max(0, owner.vel.dot(b.dir)) : 0);
    b.life = 2.6;
    b.team = team ?? owner?.team ?? 'empire';
    b.owner = owner;
    b.damage = damage;
    b.color = color === 'red' ? 0 : 1;
    b.heavy = heavy;
  }

  fireTorpedo(owner: Targetable, origin: THREE.Vector3, vel: THREE.Vector3, target: Targetable | null, point: THREE.Vector3 | null): Torpedo {
    let t = this.torpedoes.find((x) => !x.active);
    if (!t) {
      const mesh = new THREE.Mesh(this.torpGeo, this.torpMat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 6;
      mesh.onBeforeRender = this.syncPx;
      t = { active: false, pos: mesh.position, vel: new THREE.Vector3(), target: null, point: null, owner, life: 0, mesh, onArrive: null, guidance: 2.5 };
      this.torpedoes.push(t);
      this.group.add(mesh);
    }
    t.active = true;
    t.mesh.visible = true;
    t.pos.copy(origin);
    t.vel.copy(vel);
    t.target = target;
    t.point = point;
    t.owner = owner;
    t.life = 6;
    t.onArrive = null;
    t.guidance = 2.5;
    return t;
  }

  /** Remove every bolt (level resets / cinematic cuts). */
  clear(): void {
    for (const b of this.bolts) b.active = false;
    for (const t of this.torpedoes) {
      t.active = false;
      t.mesh.visible = false;
    }
  }

  update(world: World, dt: number): void {
    this.time += dt;
    this.timeUniform.value = this.time;
    const counts = [0, 0];
    const targets = world.targetables;
    for (const b of this.bolts) {
      if (!b.active) continue;
      b.life -= dt;
      if (b.life <= 0) {
        b.active = false;
        continue;
      }
      b.prev.copy(b.pos);
      b.pos.addScaledVector(b.dir, b.speed * dt);
      // Hit hostile targets.
      let hit: Targetable | null = null;
      let best = 2;
      for (const t of targets) {
        if (!t.alive || t.team === b.team || t === b.owner) continue;
        const dx = t.pos.x - b.pos.x;
        const dz = t.pos.z - b.pos.z;
        const reach = b.speed * dt + t.radius + 60;
        if (dx * dx + dz * dz > reach * reach) continue;
        const tt = t.intersectSegment(b.prev, b.pos);
        if (tt >= 0 && tt < best) {
          best = tt;
          hit = t;
        }
      }
      if (hit) {
        _v.lerpVectors(b.prev, b.pos, best);
        hit.takeDamage(b.damage, b.prev, b.owner);
        world.onBoltHit(hit, _v, b.owner);
        b.active = false;
        continue;
      }
      // Hit the Death Star hull/trench.
      if (world.staticHit(b.prev, b.pos, _v, _n)) {
        world.fx.sparks(_v, _n);
        if (b.heavy) world.fx.flak(_v);
        b.active = false;
        continue;
      }
      // Tail, axis × length and thickness packed into the instance matrix (see BOLT_VERT).
      const e = this.meshes[b.color].instanceMatrix.array as Float32Array;
      const o = counts[b.color]++ * 16;
      const len = b.heavy ? 18 : 12;
      const thick = b.heavy ? 0.55 : 0.22;
      e.fill(0, o, o + 16);
      e[o] = thick;
      e[o + 5] = thick;
      e[o + 8] = b.dir.x * len;
      e[o + 9] = b.dir.y * len;
      e[o + 10] = b.dir.z * len;
      e[o + 12] = b.pos.x - b.dir.x * len;
      e[o + 13] = b.pos.y - b.dir.y * len;
      e[o + 14] = b.pos.z - b.dir.z * len;
      e[o + 15] = 1;
    }
    for (let c = 0; c < 2; c++) {
      this.meshes[c].count = counts[c];
      this.meshes[c].instanceMatrix.needsUpdate = true;
    }

    for (const t of this.torpedoes) {
      if (!t.active) continue;
      t.life -= dt;
      const goal = t.target?.alive ? t.target.pos : t.point;
      if (goal) {
        _v.copy(goal).sub(t.pos);
        const dist = _v.length();
        const speed = Math.max(t.vel.length(), 260);
        _v.multiplyScalar(speed / Math.max(dist, 1e-3));
        t.vel.lerp(_v, Math.min(1, t.guidance * dt));
        t.vel.setLength(Math.min(speed + 120 * dt, 420));
        if (dist < Math.max(4, t.vel.length() * dt * 1.2)) {
          t.active = false;
          t.mesh.visible = false;
          if (t.onArrive) t.onArrive(t);
          else if (t.target?.alive) {
            t.target.takeDamage(400, t.pos, t.owner);
            world.onBoltHit(t.target, t.pos, t.owner);
            world.fx.explosion(t.pos, 6);
          }
          continue;
        }
      }
      t.pos.addScaledVector(t.vel, dt);
      world.fx.torpedoTrail(t.pos, t.vel, dt);
      if (!t.onArrive && world.staticHit(_v.copy(t.pos).addScaledVector(t.vel, -dt), t.pos, _s, _n)) {
        world.fx.explosion(t.pos, 5);
        world.audio.explosion('medium', t.pos);
        t.active = false;
        t.mesh.visible = false;
        continue;
      }
      if (t.life <= 0) {
        world.fx.explosion(t.pos, 4);
        t.active = false;
        t.mesh.visible = false;
      }
    }
  }
}
