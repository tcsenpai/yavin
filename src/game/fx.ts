// Combat effects: GPU-animated billboard particles (noise-shaded fireballs, streaking sparks, sun-lit smoke,
// core flashes, shockwave rings), tumbling debris chunks with smoke trails, and dynamic flash lights.
// Particles are written once on emit; motion, growth and colour are evaluated analytically in the shader.
import * as THREE from 'three';
import { Rng } from '../core/rng';
import { SUN_DIRECTION } from '../world/celestial';

const FIRE = 0;
const SPARK = 1;
const SMOKE = 2;
const FLASH = 3;
const RING = 4;

// ---------------------------------------------------------------------------------------------
// Procedural tileable noise (RGBA: fbm, fbm, billow, fbm) shared by every FX instance.

let noiseTex: THREE.DataTexture | null = null;

function particleNoise(): THREE.DataTexture {
  if (noiseTex) return noiseTex;
  const N = 256;
  const GX = new Float32Array(256);
  const GY = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const a = (i / 256) * Math.PI * 2;
    GX[i] = Math.cos(a);
    GY[i] = Math.sin(a);
  }
  const hash = (x: number, y: number, s: number): number => {
    let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(s, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (h ^ (h >>> 16)) & 255;
  };
  // Periodic gradient noise; (x, y) in lattice units, wraps at `p`.
  const perlin = (x: number, y: number, p: number, s: number): number => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const x0 = ((xi % p) + p) % p;
    const y0 = ((yi % p) + p) % p;
    const x1 = (x0 + 1) % p;
    const y1 = (y0 + 1) % p;
    const g00 = hash(x0, y0, s);
    const g10 = hash(x1, y0, s);
    const g01 = hash(x0, y1, s);
    const g11 = hash(x1, y1, s);
    const n00 = GX[g00] * fx + GY[g00] * fy;
    const n10 = GX[g10] * (fx - 1) + GY[g10] * fy;
    const n01 = GX[g01] * fx + GY[g01] * (fy - 1);
    const n11 = GX[g11] * (fx - 1) + GY[g11] * (fy - 1);
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const a = n00 + (n10 - n00) * u;
    const b = n01 + (n11 - n01) * u;
    return a + (b - a) * v;
  };
  const fbm = (u: number, v: number, p: number, oct: number, s: number, billow: boolean): number => {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    for (let o = 0; o < oct; o++) {
      const n = perlin(u * p, v * p, p, s + o * 31);
      sum += amp * (billow ? Math.abs(n) * 2 - 0.35 : n);
      norm += amp;
      amp *= 0.5;
      p *= 2;
    }
    return sum / norm;
  };
  const data = new Uint8Array(N * N * 4);
  const to8 = (x: number): number => Math.max(0, Math.min(255, Math.round(x * 255)));
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x / N;
      const v = y / N;
      const o = (y * N + x) * 4;
      data[o] = to8(0.5 + fbm(u, v, 4, 5, 1, false) * 1.1);
      data[o + 1] = to8(0.5 + fbm(u, v, 4, 5, 7, false) * 1.1);
      data[o + 2] = to8(0.5 + fbm(u, v, 5, 4, 13, true) * 0.9);
      data[o + 3] = to8(0.5 + fbm(u, v, 8, 4, 21, false) * 1.1);
    }
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  noiseTex = t;
  return t;
}

// ---------------------------------------------------------------------------------------------
// Particle shader. Per-instance: a0 = (spawn pos, spawn time), a1 = (velocity, drag),
// a2 = (life, size0, size1, kind), a3 = (seed, spin, heat, stretch), a4 = kind-specific
// (ring: axis xyz; smoke: albedo in x, opacity in w).

const VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec4 a0;
  attribute vec4 a1;
  attribute vec4 a2;
  attribute vec4 a3;
  attribute vec4 a4;
  uniform float uTime;
  uniform float uPx;
  uniform vec3 uSun;
  varying vec2 vUv;
  varying float vAge;
  varying float vSeed;
  varying float vHeat;
  varying float vKind;
  varying float vFade;
  varying float vStretch;
  varying vec3 vSunL;
  varying vec2 vX;
  void main() {
    float age = uTime - a0.w;
    float life = a2.x;
    if (age < 0.0 || age >= life) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    float kind = a2.w;
    float t = age / life;
    float d = a1.w;
    float k = d > 1e-3 ? (1.0 - exp(-d * age)) / d : age;
    vec3 p = a0.xyz + a1.xyz * k;
    float ex = kind < 0.5 ? 3.0 : kind < 1.5 ? 1.0 : kind < 2.5 ? 2.2 : 2.0;
    float size = mix(a2.y, a2.z, 1.0 - pow(1.0 - t, ex));
    vec2 corner = position.xy;
    vUv = corner;
    vAge = t;
    vSeed = a3.x;
    vHeat = a3.z;
    vKind = kind;
    vX = a4.xw;
    vStretch = 1.0;
    vSunL = vec3(0.0);
    vFade = 1.0;
    vec4 mv;
    if (kind > 3.5) {
      // Shockwave: a flat ring in world space around a fixed axis.
      vec3 n = normalize(a4.xyz);
      vec3 u = normalize(cross(n, abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
      vec3 w = cross(n, u);
      mv = modelViewMatrix * vec4(p + (u * corner.x + w * corner.y) * size, 1.0);
    } else {
      mv = modelViewMatrix * vec4(p, 1.0);
      float dist = length(mv.xyz);
      bool glow = (kind > 0.5 && kind < 1.5) || kind > 2.5;
      if (glow) {
        // Keep tiny emitters at least ~1 px wide, conserving their energy.
        float minS = 1.1 * dist / uPx;
        if (size < minS) {
          float r = size / minS;
          vFade = r * r;
          size = minS;
        }
      } else {
        // The camera is inside the puff: fade out instead of filling the screen.
        vFade = smoothstep(0.35, 1.2, dist / max(size, 1e-3));
      }
      if (vFade < 0.004) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
      }
      if (kind > 0.5 && kind < 1.5) {
        // Velocity-stretched streak.
        vec3 vel = a1.xyz * exp(-d * age);
        vec2 sv = (modelViewMatrix * vec4(vel, 0.0)).xy;
        float sl = length(sv);
        vec2 dir = sl > 1e-4 ? sv / sl : vec2(1.0, 0.0);
        float len = size + sl * a3.w;
        vStretch = len / size;
        mv.xy += dir * (corner.x * len) + vec2(-dir.y, dir.x) * (corner.y * size);
      } else {
        float ang = a3.x * 6.2831853 + a3.y * age;
        float c = cos(ang);
        float s = sin(ang);
        mv.xy += vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y) * size;
        vec3 sv = normalize((viewMatrix * vec4(uSun, 0.0)).xyz);
        vSunL = vec3(c * sv.x + s * sv.y, -s * sv.x + c * sv.y, sv.z);
      }
    }
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }
`;

const FRAG = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D uNoise;
  uniform float uTime;
  varying vec2 vUv;
  varying float vAge;
  varying float vSeed;
  varying float vHeat;
  varying float vKind;
  varying float vFade;
  varying float vStretch;
  varying vec3 vSunL;
  varying vec2 vX;

  const vec3 SUN_COL = vec3(1.0, 0.94, 0.84);
  const vec3 AMBIENT = vec3(0.02, 0.024, 0.032);

  // Black-body-ish ramp: soot red → orange → yellow → white-hot (HDR, feeds bloom).
  vec3 fireRamp(float h) {
    h = max(h, 0.0);
    vec3 c = vec3(0.3, 0.025, 0.0) * smoothstep(0.0, 0.22, h);
    c = mix(c, vec3(1.6, 0.42, 0.04), smoothstep(0.15, 0.42, h));
    c = mix(c, vec3(3.4, 1.45, 0.28), smoothstep(0.38, 0.68, h));
    c = mix(c, vec3(5.0, 4.0, 2.8), smoothstep(0.66, 1.0, h));
    return c * (1.0 + max(h - 1.0, 0.0) * 2.0);
  }

  // Wrapped Lambert on a pseudo-spherical puff normal perturbed by the noise.
  float lightPuff(vec2 uv, vec2 g, float r) {
    vec3 n = normalize(vec3(uv * 0.85 + g, sqrt(max(1.0 - r * r, 0.0)) + 0.25));
    return clamp(dot(n, vSunL) * 0.6 + 0.4, 0.0, 1.0);
  }

  void main() {
    #include <logdepthbuf_fragment>
    float r = length(vUv);
    vec4 outc;
    if (vKind < 0.5) {
      if (r > 1.0) discard;
      vec2 nuv = vUv * 0.32 + vec2(vSeed * 17.31, vSeed * 9.73);
      vec4 n1 = texture2D(uNoise, nuv + vec2(0.0, -vAge * 0.1));
      vec4 n2 = texture2D(uNoise, nuv * 2.4 + (n1.gb - 0.5) * 0.35 + vec2(vAge * 0.07, 0.0));
      float n = n1.r * 0.55 + n2.b * 0.45;
      float edge = 1.0 - r;
      float dens = clamp((edge * 1.5 + (n - 0.5) * 1.7 - vAge * 0.5) * 2.5, 0.0, 1.0);
      float heat = vHeat * pow(1.0 - vAge, 2.0) * (0.4 + n * 1.05) * (0.5 + edge * 0.9);
      vec3 emis = fireRamp(heat) * dens;
      // Optically thick: even the hot core partly occludes, so stacked billows don't sum to a white blob.
      float cool = smoothstep(0.1, 0.6, vAge);
      float soot = dens * cool * 0.8;
      float lit = lightPuff(vUv, (vec2(n1.g, n2.g) - 0.5) * 1.4, r);
      vec3 sootCol = AMBIENT + SUN_COL * lit * 0.09;
      outc = vec4(emis + sootCol * soot, dens * mix(0.45, 0.85, cool));
    } else if (vKind < 1.5) {
      vec2 q = vec2(vUv.x * vStretch, vUv.y);
      float dx = max(abs(q.x) - (vStretch - 1.0), 0.0);
      float d = length(vec2(dx, q.y));
      if (d > 1.0) discard;
      float core = exp(-d * d * 5.0) * (1.0 - d);
      float head = mix(0.3, 1.0, vUv.x * 0.5 + 0.5);
      float tw = 0.65 + 0.35 * sin(uTime * 37.0 + vSeed * 91.0);
      float h = vHeat * (1.0 - vAge * 0.7);
      outc = vec4(fireRamp(h) * core * head * tw * (1.0 - vAge * vAge) * 1.6, 0.0);
    } else if (vKind < 2.5) {
      if (r > 1.0) discard;
      vec2 nuv = vUv * 0.28 + vec2(vSeed * 11.17, vSeed * 5.91);
      vec4 n1 = texture2D(uNoise, nuv + vec2(vAge * 0.04, vAge * 0.02));
      vec4 n2 = texture2D(uNoise, nuv * 2.6 + (n1.ga - 0.5) * 0.3 - vec2(0.0, vAge * 0.05));
      float n = n1.b * 0.6 + n2.r * 0.4;
      float edge = 1.0 - r;
      float dens = clamp((edge * 1.25 + (n - 0.5) * 1.6 - 0.05) * 1.8, 0.0, 1.0);
      float fadeIn = smoothstep(0.0, 0.05, vAge);
      float fadeOut = 1.0 - smoothstep(0.3, 1.0, vAge);
      float a = dens * fadeIn * fadeOut * vX.y;
      float lit = lightPuff(vUv, (vec2(n1.g, n2.a) - 0.5) * 1.6, r);
      vec3 col = AMBIENT + SUN_COL * (lit * lit) * vX.x * 1.7;
      float glow = vHeat * pow(max(1.0 - vAge * 3.5, 0.0), 2.0) * (0.3 + edge);
      col += vec3(2.4, 0.7, 0.12) * glow * (0.4 + n);
      outc = vec4(col * a, a);
    } else if (vKind < 3.5) {
      float core = exp(-r * r * 9.0);
      float halo = exp(-r * 4.5) * 0.45;
      float k = 1.0 - vAge;
      k *= k;
      vec3 c = mix(vec3(1.0, 0.92, 0.82), vec3(1.0, 0.6, 0.28), vAge);
      outc = vec4(c * (core + halo) * vHeat * k * (1.0 - smoothstep(0.8, 1.0, r)), 0.0);
    } else {
      float w = 0.045 + vAge * 0.12;
      if (abs(r - 0.86) > w * 2.6 + 0.05) discard; // only the band is shaded
      float ang = atan(vUv.y, vUv.x) / 6.2831853;
      vec4 n = textureLod(uNoise, vec2(ang * 3.0 + vSeed, r * 0.6 - vAge * 0.3), 0.0);
      float x = (r - 0.86 + (n.r - 0.5) * 0.1) / w;
      float ring = exp(-x * x);
      float k = pow(1.0 - vAge, 1.6);
      vec3 c = mix(vec3(1.0, 0.9, 0.82), vec3(1.0, 0.52, 0.22), vAge);
      outc = vec4(c * ring * (0.35 + n.g * 1.3) * vHeat * k * (1.0 - smoothstep(0.94, 1.0, r)), 0.0);
    }
    gl_FragColor = outc * vFade;
  }
`;

interface Shared {
  [key: string]: THREE.IUniform;
  uTime: { value: number };
  uPx: { value: number };
  uSun: { value: THREE.Vector3 };
  uNoise: { value: THREE.Texture };
}

/** Emission parameters, filled by FX.set() before ParticlePool.emit() (avoids per-call allocation). */
const S = { kind: 0, life: 1, s0: 1, s1: 1, drag: 0, delay: 0, seed: 0, spin: 0, heat: 1, stretch: 0, ax: 0, ay: 0, az: 0, aw: 1 };

class ParticlePool {
  readonly mesh: THREE.Mesh;
  private geo = new THREE.InstancedBufferGeometry();
  private arrays: Float32Array[] = [];
  private attrs: THREE.InstancedBufferAttribute[] = [];
  private cursor = 0;
  private dirtyStart = 0;
  private dirtyCount = 0;
  private high = 0;

  constructor(readonly capacity: number, material: THREE.ShaderMaterial, renderOrder: number) {
    const quad = new THREE.PlaneGeometry(2, 2);
    this.geo.setIndex(quad.index);
    this.geo.setAttribute('position', quad.attributes.position);
    for (let k = 0; k < 5; k++) {
      const arr = new Float32Array(capacity * 4);
      const attr = new THREE.InstancedBufferAttribute(arr, 4).setUsage(THREE.DynamicDrawUsage);
      this.geo.setAttribute('a' + k, attr);
      this.arrays.push(arr);
      this.attrs.push(attr);
    }
    for (let i = 0; i < capacity; i++) this.arrays[0][i * 4 + 3] = -1e9; // long dead
    this.geo.instanceCount = 0;
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
  }

  emit(p: THREE.Vector3, v: THREE.Vector3, time: number): void {
    const i = this.cursor;
    this.cursor = (i + 1) % this.capacity;
    if (this.dirtyCount === 0) this.dirtyStart = i;
    this.dirtyCount++;
    if (i >= this.high) this.high = i + 1;
    const o = i * 4;
    const a = this.arrays;
    const a0 = a[0];
    const a1 = a[1];
    const a2 = a[2];
    const a3 = a[3];
    const a4 = a[4];
    a0[o] = p.x;
    a0[o + 1] = p.y;
    a0[o + 2] = p.z;
    a0[o + 3] = time + S.delay;
    a1[o] = v.x;
    a1[o + 1] = v.y;
    a1[o + 2] = v.z;
    a1[o + 3] = S.drag;
    a2[o] = S.life;
    a2[o + 1] = S.s0;
    a2[o + 2] = S.s1;
    a2[o + 3] = S.kind;
    a3[o] = S.seed;
    a3[o + 1] = S.spin;
    a3[o + 2] = S.heat;
    a3[o + 3] = S.stretch;
    a4[o] = S.ax;
    a4[o + 1] = S.ay;
    a4[o + 2] = S.az;
    a4[o + 3] = S.aw;
  }

  /** Upload only the slots written since the last flush (ranges accumulate until the renderer uploads them). */
  flush(): void {
    const n = this.dirtyCount;
    if (n === 0) return;
    const cap = this.capacity;
    const start = this.dirtyStart;
    for (const a of this.attrs) {
      if (n >= cap) a.clearUpdateRanges(); // everything changed: full upload
      else if (start + n <= cap) a.addUpdateRange(start * 4, n * 4);
      else {
        a.addUpdateRange(start * 4, (cap - start) * 4);
        a.addUpdateRange(0, (n - (cap - start)) * 4);
      }
      a.needsUpdate = true;
    }
    this.geo.instanceCount = this.high;
    this.dirtyCount = 0;
  }
}

// ---------------------------------------------------------------------------------------------

interface Debris {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  rot: THREE.Vector3;
  spin: THREE.Vector3;
  scale: THREE.Vector3;
  life: number;
  /** Smoke trail size (0 = none). */
  trail: number;
  /** Seconds it keeps burning. */
  burn: number;
  age: number;
  acc: number;
}

interface Flash {
  light: THREE.PointLight;
  life: number;
  max: number;
  peak: number;
}

/** Irregular faceted chunk (jittered icosahedron). */
function chunkGeometry(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 0);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
    const f = 0.6 + 0.65 * (h - Math.floor(h));
    pos.setXYZ(i, x * f, y * f, z * f);
  }
  g.computeVertexNormals();
  return g;
}

const MAX_DEBRIS = 120;
const TRAIL_STEP = 0.04;

const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _iv = new THREE.Vector3();
const _zero = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

export class FX {
  readonly group = new THREE.Group();
  private uniforms: Shared;
  private smoke: ParticlePool;
  private fire: ParticlePool;
  private debris: Debris[] = [];
  private debrisMesh: THREE.InstancedMesh;
  private debrisCursor = 0;
  private flashes: Flash[] = [];
  private rng = new Rng(4242);
  private time = 0;

  constructor() {
    this.uniforms = {
      uTime: { value: 0 },
      uPx: { value: 600 },
      uSun: { value: SUN_DIRECTION },
      uNoise: { value: particleNoise() },
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      // Premultiplied alpha: rgb adds light, alpha occludes → fire (additive) and smoke (occluding) share a pass.
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.smoke = new ParticlePool(4096, mat, 5);
    this.fire = new ParticlePool(6144, mat, 6);

    this.debrisMesh = new THREE.InstancedMesh(
      chunkGeometry(),
      new THREE.MeshStandardMaterial({ color: 0x55585e, roughness: 0.55, metalness: 0.6, flatShading: true }),
      MAX_DEBRIS,
    );
    this.debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debrisMesh.frustumCulled = false;
    this.debrisMesh.count = 0;
    for (let i = 0; i < MAX_DEBRIS; i++) {
      this.debris.push({
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        rot: new THREE.Vector3(),
        spin: new THREE.Vector3(),
        scale: new THREE.Vector3(),
        life: 0,
        trail: 0,
        burn: 0,
        age: 0,
        acc: 0,
      });
    }

    this.group.add(this.debrisMesh, this.smoke.mesh, this.fire.mesh);
    for (let i = 0; i < 4; i++) {
      const light = new THREE.PointLight(0xffa050, 0, 600, 1.6);
      this.group.add(light);
      this.flashes.push({ light, life: 0, max: 1, peak: 0 });
    }
  }

  setViewport(h: number, fov: number): void {
    this.uniforms.uPx.value = h / (2 * Math.tan((fov * Math.PI) / 360));
  }

  private randDir(out: THREE.Vector3, scale: number): THREE.Vector3 {
    const r = this.rng;
    do out.set(r.range(-1, 1), r.range(-1, 1), r.range(-1, 1));
    while (out.lengthSq() > 1 || out.lengthSq() < 1e-4);
    return out.normalize().multiplyScalar(scale);
  }

  /** Reset the emission spec for one particle. */
  private set(kind: number, life: number, s0: number, s1: number, drag: number, heat: number): void {
    S.kind = kind;
    S.life = life;
    S.s0 = s0;
    S.s1 = s1;
    S.drag = drag;
    S.heat = heat;
    S.seed = this.rng.float();
    S.spin = this.rng.range(-0.7, 0.7);
    S.stretch = 0;
    S.delay = 0;
    S.ax = 0;
    S.ay = 0;
    S.az = 0;
    S.aw = 1;
  }

  /** Smoke look: albedo (sun-lit brightness) and opacity. */
  private smokeLook(albedo: number, opacity: number): void {
    S.ax = albedo;
    S.aw = opacity;
  }

  private emitFire(p: THREE.Vector3, v: THREE.Vector3): void {
    this.fire.emit(p, v, this.time);
  }

  private emitSmoke(p: THREE.Vector3, v: THREE.Vector3): void {
    this.smoke.emit(p, v, this.time);
  }

  private flash(pos: THREE.Vector3, peak: number, dur: number, range: number, onlyIfFree = false): void {
    let f = this.flashes[0];
    for (const x of this.flashes) if (x.life < f.life) f = x;
    if (onlyIfFree && f.life > 0) return;
    f.light.position.copy(pos);
    f.light.distance = range;
    f.life = dur;
    f.max = dur;
    f.peak = peak;
  }

  private ring(pos: THREE.Vector3, vel: THREE.Vector3, life: number, s0: number, s1: number, heat: number, delay: number): void {
    this.set(RING, life, s0, s1, 0, heat);
    this.randDir(_v, 1);
    S.ax = _v.x;
    S.ay = _v.y;
    S.az = _v.z;
    S.delay = delay;
    this.emitFire(pos, vel);
  }

  /** Ship/structure explosion. `scale` ≈ object radius in metres. */
  explosion(pos: THREE.Vector3, scale: number, inherit?: THREE.Vector3): void {
    const r = this.rng;
    const s = scale;
    const big = s >= 11;
    _iv.set(0, 0, 0);
    if (inherit) _iv.copy(inherit);

    // Hot core flash.
    this.set(FLASH, big ? 0.6 : 0.22, s * (big ? 1.2 : 1.0), s * (big ? 3.2 : 2.6), 0, big ? 3.5 : 3);
    this.emitFire(pos, _vel.copy(_iv).multiplyScalar(0.35));

    // Main fireball: few large noise-shaded billows that cool into soot.
    const nf = big ? Math.min(26 + s * 0.5, 48) : Math.round(9 + s * 1.2);
    for (let i = 0; i < nf; i++) {
      this.randDir(_v, 1);
      _p.copy(pos).addScaledVector(_v, r.range(0, s * 0.35));
      _vel.copy(_v).multiplyScalar(r.range(0.6, 2.2) * s * (big ? 0.9 : 2.2)).addScaledVector(_iv, 0.35);
      const life = big ? r.range(1.6, 3.2) : r.range(0.8, 1.5) * (0.85 + s * 0.03);
      this.set(FIRE, life, s * r.range(0.35, 0.7), s * (big ? r.range(1.0, 1.9) : r.range(1.6, 2.6)), big ? 1.4 : 2.5, r.range(0.9, 1.1));
      S.delay = r.range(0, big ? 0.25 : 0.06);
      this.emitFire(_p, _vel);
    }

    // Secondary detonations ripple through large structures.
    if (big) {
      const nb = 3 + Math.floor(r.float() * 3);
      for (let b = 0; b < nb; b++) {
        const c = _s.copy(pos).add(this.randDir(_v, r.range(0.6, 1.6) * s));
        const d0 = r.range(0.12, 1.0);
        this.set(FLASH, 0.3, s * 0.5, s * 1.6, 0, 2.5);
        S.delay = d0;
        this.emitFire(c, _vel.copy(_iv).multiplyScalar(0.35));
        for (let i = 0; i < 7; i++) {
          this.randDir(_v, 1);
          _p.copy(c).addScaledVector(_v, r.range(0, s * 0.2));
          _vel.copy(_v).multiplyScalar(r.range(0.5, 1.6) * s).addScaledVector(_iv, 0.35);
          this.set(FIRE, r.range(1.0, 2.0), s * r.range(0.2, 0.4), s * r.range(0.7, 1.2), 2, r.range(0.9, 1.15));
          S.delay = d0 + r.range(0, 0.08);
          this.emitFire(_p, _vel);
        }
      }
    }

    // Shockwave rings.
    _vel.copy(_iv).multiplyScalar(0.35);
    if (big) {
      this.ring(pos, _vel, 1.6, s * 0.4, s * 11, 1.0, 0);
      this.ring(pos, _vel, 2.2, s * 0.3, s * 16, 0.5, 0.08);
    } else if (s >= 4) this.ring(pos, _vel, 0.55, s * 0.4, s * 6, 0.8, 0);

    // Fast streaking sparks.
    const ns = big ? 90 : Math.round(24 + s * 4);
    for (let i = 0; i < ns; i++) {
      this.randDir(_vel, r.range(60, 220) * (big ? 1.8 : 1)).addScaledVector(_iv, 0.5);
      this.set(SPARK, r.range(0.35, 1.1) * (big ? 1.6 : 1), big ? r.range(0.3, 0.6) : r.range(0.12, 0.22) + s * 0.015, 0.05, 1.0, 1.3);
      S.stretch = 0.05;
      this.emitFire(pos, _vel);
    }

    // Slow glowing embers.
    const ne = big ? 60 : Math.round(10 + s * 2);
    for (let i = 0; i < ne; i++) {
      this.randDir(_vel, r.range(8, 45) * (big ? 2 : 1)).addScaledVector(_iv, 0.4);
      this.set(SPARK, r.range(1.2, 3.0) * (big ? 1.6 : 1), r.range(0.12, 0.25) * (big ? 2.5 : 1), 0.06, 0.7, r.range(0.75, 1.0));
      S.stretch = 0.015;
      S.delay = r.range(0, 0.15);
      this.emitFire(pos, _vel);
    }

    // Long-lived sun-lit smoke, glowing from within at first.
    const nsm = big ? Math.min(30 + s * 0.6, 60) : Math.round(7 + s * 1.5);
    for (let i = 0; i < nsm; i++) {
      this.randDir(_v, 1);
      _p.copy(pos).addScaledVector(_v, r.range(0, s * 0.6));
      _vel.copy(_v).multiplyScalar(r.range(1.5, 6) * (1 + s * 0.25)).addScaledVector(_iv, 0.25);
      const life = big ? r.range(7, 13) : r.range(3.5, 6.5);
      this.set(SMOKE, life, s * r.range(0.5, 0.9), s * (big ? r.range(3.1, 5.2) : r.range(2.2, 3.6)), 0.45, 1);
      this.smokeLook(r.range(0.12, 0.22), r.range(0.7, 0.95));
      S.delay = r.range(0.1, big ? 1.2 : 0.35);
      this.emitSmoke(_p, _vel);
    }

    const nd = big ? Math.floor(Math.min(12 + s * 0.2, 22)) : Math.floor(Math.min(5 + s * 0.5, 10));
    for (let i = 0; i < nd; i++) this.spawnDebris(pos, s, big);
    this.flash(pos, 12 + s * 5, 0.35 + s * 0.02, 60 + s * 30);
  }

  private spawnDebris(pos: THREE.Vector3, scale: number, big: boolean): void {
    let d: Debris | null = null;
    for (let k = 0; k < MAX_DEBRIS; k++) {
      const c = this.debris[(this.debrisCursor + k) % MAX_DEBRIS];
      if (c.life <= 0) {
        d = c;
        break;
      }
    }
    if (!d) d = this.debris[this.debrisCursor];
    this.debrisCursor = (this.debrisCursor + 1) % MAX_DEBRIS;
    const r = this.rng;
    d.pos.copy(pos).add(this.randDir(_v, r.range(0, scale * 0.2)));
    const size = big ? r.range(0.25, 1) * scale * 0.1 : r.range(0.3, 1) * Math.max(scale * 0.16, 0.45);
    d.scale.set(size * r.range(0.6, 2.2), size * r.range(0.25, 0.8), size * r.range(0.6, 1.6));
    this.randDir(d.vel, big ? r.range(15, 60) + scale * 1.5 : r.range(20, 70) + scale * 4).addScaledVector(_iv, 0.6);
    d.rot.set(r.range(0, 6.28), r.range(0, 6.28), r.range(0, 6.28));
    d.spin.set(r.range(-6, 6), r.range(-6, 6), r.range(-6, 6));
    d.life = big ? r.range(3, 6) : r.range(1.8, 3.6);
    d.trail = r.float() < 0.55 ? size : 0;
    d.burn = r.range(0.3, 1.2) * (big ? 2 : 1);
    d.age = 0;
    d.acc = r.range(0, TRAIL_STEP);
  }

  /** Laser impact on a hull: white-hot flash, streaking sparks, a puff of smoke and a light flicker. */
  sparks(pos: THREE.Vector3, normal?: THREE.Vector3): void {
    const r = this.rng;
    this.set(FLASH, 0.1, 0.9, 2.4, 0, 5);
    this.emitFire(pos, _zero);
    for (let i = 0; i < 10; i++) {
      this.randDir(_vel, r.range(30, 110));
      if (normal) _vel.addScaledVector(normal, 60);
      this.set(SPARK, r.range(0.15, 0.45), r.range(0.08, 0.14), 0.04, 2.2, 1.25);
      S.stretch = 0.035;
      this.emitFire(pos, _vel);
    }
    for (let i = 0; i < 2; i++) {
      this.randDir(_vel, r.range(5, 20));
      this.set(SPARK, r.range(0.5, 1.0), 0.12, 0.06, 1.0, 0.9);
      this.emitFire(pos, _vel);
    }
    if (normal) _vel.copy(normal).multiplyScalar(4);
    else this.randDir(_vel, 2);
    this.set(SMOKE, r.range(1.0, 1.6), 0.6, r.range(2.5, 4), 1.2, 0.8);
    this.smokeLook(0.25, 0.5);
    this.emitSmoke(pos, _vel);
    this.flash(pos, 4, 0.07, 30, true);
  }

  /** Imperial flak burst: dark smoke puff with a bright core (as seen over the Death Star). */
  flak(pos: THREE.Vector3): void {
    const r = this.rng;
    this.set(FLASH, 0.14, 3, 7, 0, 5);
    this.emitFire(pos, _zero);
    for (let i = 0; i < 6; i++) {
      this.randDir(_vel, r.range(4, 15));
      this.set(FIRE, r.range(0.3, 0.5), 2, r.range(5, 8), 3, 1.0);
      this.emitFire(pos, _vel);
    }
    for (let i = 0; i < 8; i++) {
      this.randDir(_vel, r.range(40, 120));
      this.set(SPARK, r.range(0.2, 0.5), 0.15, 0.05, 1.5, 1.2);
      S.stretch = 0.04;
      this.emitFire(pos, _vel);
    }
    for (let i = 0; i < 10; i++) {
      this.randDir(_vel, r.range(2, 9));
      this.set(SMOKE, r.range(2, 3.5), 4, r.range(12, 18), 0.6, 0.6);
      this.smokeLook(0.08, 0.95);
      S.delay = r.range(0, 0.05);
      this.emitSmoke(pos, _vel);
    }
    this.flash(pos, 25, 0.2, 140);
  }

  /** Continuous smoke/fire trail for damaged ships (call each frame). */
  trail(pos: THREE.Vector3, vel: THREE.Vector3, intensity: number): void {
    const r = this.rng;
    if (r.float() < intensity) {
      this.randDir(_vel, 1.5).addScaledVector(vel, 0.1);
      this.set(SMOKE, r.range(1.2, 2.2), 1.0, r.range(3.5, 6), 1.0, 0.7);
      this.smokeLook(0.2, 0.55);
      this.emitSmoke(pos, _vel);
    }
    if (r.float() < intensity * 0.7) {
      this.randDir(_vel, 4).addScaledVector(vel, 0.2);
      this.set(FIRE, r.range(0.18, 0.32), r.range(0.9, 1.4), 0.5, 2, 1.05);
      this.emitFire(pos, _vel);
    }
    if (r.float() < intensity * 0.12) {
      this.randDir(_vel, r.range(10, 30)).addScaledVector(vel, 0.5);
      this.set(SPARK, r.range(0.3, 0.6), 0.12, 0.05, 1.2, 1.1);
      S.stretch = 0.03;
      this.emitFire(pos, _vel);
    }
  }

  /** Proton torpedo wake: only an occasional, very faint thin smoke wisp (the glow ribbon lives in Weapons). */
  torpedoTrail(pos: THREE.Vector3, vel: THREE.Vector3, dt: number): void {
    const r = this.rng;
    if (r.float() > dt * 15) return;
    _p.copy(pos).addScaledVector(vel, -dt * r.float());
    this.randDir(_vel, 0.6);
    this.set(SMOKE, r.range(0.7, 1.1), 0.35, r.range(1.1, 1.6), 1, 0);
    this.smokeLook(0.35, 0.14);
    this.emitSmoke(_p, _vel);
  }

  /** Brief orange launch flash at a torpedo tube, carried along with the launching ship. */
  torpedoLaunch(pos: THREE.Vector3, vel: THREE.Vector3): void {
    this.set(FLASH, 0.1, 1.1, 0.5, 0, 1.6);
    this.emitFire(pos, vel);
    this.flash(pos, 2.5, 0.1, 30, true);
  }

  /** Engine/muzzle flash sprite. */
  muzzle(pos: THREE.Vector3, vel: THREE.Vector3): void {
    this.set(FLASH, 0.07, 1.3, 0.5, 0, 3);
    this.emitFire(pos, vel);
  }

  update(dt: number): void {
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    this.updateDebris(dt);
    this.fire.flush();
    this.smoke.flush();
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

  private updateDebris(dt: number): void {
    const r = this.rng;
    const mesh = this.debrisMesh;
    let n = 0;
    for (const d of this.debris) {
      if (d.life <= 0) continue;
      d.life -= dt;
      if (d.life <= 0) continue;
      d.age += dt;
      d.pos.addScaledVector(d.vel, dt);
      d.rot.addScaledVector(d.spin, dt);
      _q.setFromEuler(_e.set(d.rot.x, d.rot.y, d.rot.z));
      _s.copy(d.scale).multiplyScalar(Math.min(1, d.life / 0.4));
      mesh.setMatrixAt(n++, _m.compose(d.pos, _q, _s));
      if (d.trail <= 0 || d.life < 0.3 || d.age > 2.5) continue;
      d.acc += dt;
      while (d.acc >= TRAIL_STEP) {
        d.acc -= TRAIL_STEP;
        _p.copy(d.pos).addScaledVector(d.vel, -d.acc);
        const fresh = Math.max(0, 1 - d.age / (d.burn + 1.5));
        this.randDir(_vel, 1).addScaledVector(d.vel, 0.05);
        this.set(SMOKE, r.range(0.7, 1.3), d.trail * 1.1, d.trail * r.range(3.5, 5), 1, fresh);
        this.smokeLook(0.22, 0.35 + 0.3 * fresh);
        this.emitSmoke(_p, _vel);
        if (d.age < d.burn) {
          this.set(FIRE, r.range(0.22, 0.4), d.trail * 1.1, d.trail * 0.35, 2, 1.0);
          this.emitFire(_p, _vel.copy(d.vel).multiplyScalar(0.1));
        }
      }
    }
    mesh.count = n;
    if (n > 0) mesh.instanceMatrix.needsUpdate = true;
  }
}
