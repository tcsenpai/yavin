// Laser bolts (instanced camera-facing beams, two colours) and proton torpedoes (glowing ball + ribbon trail).
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
/** Ribbon history: up to this many samples, spanning TRAIL_TIME seconds. */
const TRAIL_SAMPLES = 64;
const TRAIL_TIME = 0.4;
const _s = new THREE.Vector3();
const _n = new THREE.Vector3();
const _v = new THREE.Vector3();
const _px = new THREE.Vector2();

interface TorpTrail {
  mesh: THREE.Mesh;
  pos: THREE.BufferAttribute;
  dir: THREE.BufferAttribute;
  info: THREE.BufferAttribute;
  /** Ring buffer of (x, y, z, time) samples. */
  samples: Float32Array;
  head: number;
  count: number;
  /** A launch flash is still owed at `origin` (emitted on the next update, which has the FX system). */
  launch: boolean;
  origin: THREE.Vector3;
}

/** Upload only the first `count` vertices of a dynamic attribute. */
function markRange(attr: THREE.BufferAttribute, count: number): void {
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, count * attr.itemSize);
  attr.needsUpdate = true;
}

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

// Proton torpedo as in the 1977 film: one bright ball, white-hot centre falling off through orange to deep
// red, softly pulsing, smooth halo. Only the small centre exceeds the bloom threshold. Kept at least a few
// pixels wide so it reads at long range.
const TORP_VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  uniform float uPx;
  varying vec2 vUv;
  varying float vI;
  varying float vPhase;
  void main() {
    vec4 c = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float size = 3.2;
    float minS = 12.0 * max(length(c.xyz), 0.1) / uPx;
    vI = 1.0;
    if (size < minS) {
      vI = sqrt(size / minS);
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
    float r2 = dot(vUv, vUv);
    if (r2 > 1.0) discard;
    float pulse = 0.9 + 0.1 * sin(uTime * 13.0 + vPhase * 40.0);
    float core = exp(-r2 * 55.0);
    float ball = exp(-r2 * 9.0);
    float halo = exp(-sqrt(r2) * 3.6) * (1.0 - r2);
    vec3 col = vec3(2.6, 2.1, 1.6) * core
      + vec3(2.0, 0.62, 0.14) * ball * pulse
      + vec3(0.5, 0.07, 0.02) * halo * (0.85 + 0.15 * pulse);
    gl_FragColor = vec4(col * vI, 1.0);
  }
`;

// Torpedo wake: camera-facing ribbon through the last TRAIL_TIME s of positions, tapering and cooling
// orange → red → transparent with age.
const TRAIL_VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  uniform float uPx;
  attribute vec3 aDir;
  attribute vec2 aInfo; // side (-1 / +1), age (s)
  varying float vT;
  varying float vX;
  varying float vI;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec3 d = (modelViewMatrix * vec4(aDir, 0.0)).xyz;
    vec3 side = cross(d, normalize(mv.xyz));
    float l = length(side);
    side = l > 1e-6 ? side / l : vec3(1.0, 0.0, 0.0);
    float t = clamp(aInfo.y / ${TRAIL_TIME.toFixed(3)}, 0.0, 1.0);
    float w = mix(0.75, 0.15, t);
    float minW = 1.5 * max(length(mv.xyz), 0.1) / uPx;
    vI = 1.0;
    if (w < minW) {
      vI = w / minW;
      w = minW;
    }
    mv.xyz += side * (aInfo.x * w);
    vT = t;
    vX = aInfo.x;
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }
`;
const TRAIL_FRAG = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  varying float vT;
  varying float vX;
  varying float vI;
  void main() {
    #include <logdepthbuf_fragment>
    float x2 = vX * vX;
    float body = exp(-x2 * 3.0) * (1.0 - x2);
    float core = exp(-x2 * 12.0);
    float k = max(1.0 - vT, 0.0); // interpolation can overshoot 1 slightly: pow(<0) is NaN and poisons bloom
    vec3 col = mix(vec3(1.25, 0.36, 0.07), vec3(0.45, 0.05, 0.015), vT) * body + vec3(0.9, 0.42, 0.14) * core * k * k;
    gl_FragColor = vec4(col * pow(k, 2.4) * vI, 1.0);
  }
`;

export class Weapons {
  readonly group = new THREE.Group();
  private bolts: Bolt[] = [];
  private meshes: THREE.InstancedMesh[];
  readonly torpedoes: Torpedo[] = [];
  /** Wake ribbon for each torpedo (same index). */
  private trails: TorpTrail[] = [];
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
  private trailMat = new THREE.ShaderMaterial({
    vertexShader: TRAIL_VERT,
    fragmentShader: TRAIL_FRAG,
    uniforms: { uPx: this.pxUniform },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  /** Quad strip indices shared by every trail ribbon. */
  private trailIndex: THREE.BufferAttribute;
  /** Keeps the pixel-size uniform (CSS pixels per metre at 1 m) in sync with the canvas and camera, so minimum
   *  on-screen sizes look the same on standard and high-DPI displays. */
  private syncPx = (renderer: THREE.WebGLRenderer, _scene: THREE.Scene, camera: THREE.Camera): void => {
    this.pxUniform.value = (0.5 * renderer.getDrawingBufferSize(_px).y * camera.projectionMatrix.elements[5]) / renderer.getPixelRatio();
  };

  constructor() {
    const idx = new Uint16Array((TRAIL_SAMPLES - 1) * 6);
    for (let i = 0; i < TRAIL_SAMPLES - 1; i++) idx.set([2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 2, 2 * i + 1, 2 * i + 3], i * 6);
    this.trailIndex = new THREE.BufferAttribute(idx, 1);
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
    let i = this.torpedoes.findIndex((x) => !x.active);
    if (i < 0) {
      const mesh = new THREE.Mesh(this.torpGeo, this.torpMat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 6;
      mesh.onBeforeRender = this.syncPx;
      i = this.torpedoes.length;
      this.torpedoes.push({ active: false, pos: mesh.position, vel: new THREE.Vector3(), target: null, point: null, owner, life: 0, mesh, onArrive: null, guidance: 2.5 });
      this.trails.push(this.createTrail());
      this.group.add(mesh);
    }
    const t = this.torpedoes[i];
    const trail = this.trails[i];
    trail.count = 0;
    trail.launch = true;
    trail.origin.copy(origin);
    trail.mesh.visible = false;
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
    for (let i = 0; i < this.torpedoes.length; i++) {
      this.torpedoes[i].active = false;
      this.torpedoes[i].mesh.visible = false;
      this.trails[i].count = 0;
      this.trails[i].launch = false;
      this.trails[i].mesh.visible = false;
    }
  }

  private createTrail(): TorpTrail {
    const n = TRAIL_SAMPLES * 2;
    const geo = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const dir = new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const info = new THREE.BufferAttribute(new Float32Array(n * 2), 2).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', pos);
    geo.setAttribute('aDir', dir);
    geo.setAttribute('aInfo', info);
    geo.setIndex(this.trailIndex);
    geo.setDrawRange(0, 0);
    const mesh = new THREE.Mesh(geo, this.trailMat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    mesh.visible = false;
    mesh.onBeforeRender = this.syncPx;
    this.group.add(mesh);
    return { mesh, pos, dir, info, samples: new Float32Array(TRAIL_SAMPLES * 4), head: 0, count: 0, launch: false, origin: new THREE.Vector3() };
  }

  /** Record the torpedo's position and rebuild its wake ribbon from the samples younger than TRAIL_TIME. */
  private updateTrail(trail: TorpTrail, t: Torpedo, world: World): void {
    if (trail.launch) {
      trail.launch = false;
      world.fx.torpedoLaunch(trail.origin, t.owner.vel);
    }
    const s = trail.samples;
    if (t.active) {
      const o = trail.head * 4;
      s[o] = t.pos.x;
      s[o + 1] = t.pos.y;
      s[o + 2] = t.pos.z;
      s[o + 3] = this.time;
      trail.head = (trail.head + 1) % TRAIL_SAMPLES;
      if (trail.count < TRAIL_SAMPLES) trail.count++;
    }
    if (trail.count === 0) return;
    const p = trail.pos.array as Float32Array;
    const info = trail.info.array as Float32Array;
    let n = 0;
    for (let k = 0; k < trail.count; k++) {
      const o = ((trail.head - 1 - k + TRAIL_SAMPLES) % TRAIL_SAMPLES) * 4;
      const age = this.time - s[o + 3];
      if (age > TRAIL_TIME) break;
      const v = n * 6;
      p[v] = p[v + 3] = s[o];
      p[v + 1] = p[v + 4] = s[o + 1];
      p[v + 2] = p[v + 5] = s[o + 2];
      const w = n * 4;
      info[w] = -1;
      info[w + 1] = age;
      info[w + 2] = 1;
      info[w + 3] = age;
      n++;
    }
    if (n < 2) {
      trail.mesh.visible = false;
      if (n === 0) trail.count = 0;
      return;
    }
    // Tangents by central differences (one-sided at the ends).
    const d = trail.dir.array as Float32Array;
    for (let j = 0; j < n; j++) {
      const a = Math.max(j - 1, 0) * 6;
      const b = Math.min(j + 1, n - 1) * 6;
      const v = j * 6;
      d[v] = d[v + 3] = p[a] - p[b];
      d[v + 1] = d[v + 4] = p[a + 1] - p[b + 1];
      d[v + 2] = d[v + 5] = p[a + 2] - p[b + 2];
    }
    markRange(trail.pos, n * 2);
    markRange(trail.dir, n * 2);
    markRange(trail.info, n * 2);
    trail.mesh.geometry.setDrawRange(0, (n - 1) * 6);
    trail.mesh.visible = true;
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
      // A ship in an evasive barrel roll slips most incoming bolts.
      if (hit && 'evadeT' in hit && typeof hit.evadeT === 'number' && hit.evadeT > 0 && Math.random() < 0.65) hit = null;
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
    for (let i = 0; i < this.torpedoes.length; i++) this.updateTrail(this.trails[i], this.torpedoes[i], world);
  }
}
