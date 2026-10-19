import * as THREE from 'three';

/* ------------------------------------------------------------------------------------------------
 * Shared state
 * ---------------------------------------------------------------------------------------------- */

/** Normalized world direction toward the sun. Place a DirectionalLight along it. */
export const SUN_DIRECTION: THREE.Vector3 = new THREE.Vector3(0.55, 0.42, 0.72).normalize();

/** Advanced by updateCelestial; shared by every celestial shader that animates. */
export const timeUniform = { value: 0 };
/** Shared by reference: mutating SUN_DIRECTION propagates to every shader. */
export const sunDirUniform = { value: SUN_DIRECTION };

export function updateCelestial(dt: number): void {
  timeUniform.value += dt;
}

/** Superlaser dish axis in Death Star object space: 30° north of the equator, toward local -Z (forward). */
export const DEATH_STAR_DISH_DIR: THREE.Vector3 = new THREE.Vector3(
  0,
  Math.sin(THREE.MathUtils.degToRad(30)),
  -Math.cos(THREE.MathUtils.degToRad(30)),
).normalize();

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------------------------------------
 * GLSL chunks
 * ---------------------------------------------------------------------------------------------- */

export const GLSL_NOISE = /* glsl */ `
vec3 cMod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 cMod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 cPermute(vec4 x) { return cMod289(((x * 34.0) + 1.0) * x); }
vec4 cTaylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = cMod289(i);
  vec4 p = cPermute(cPermute(cPermute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = cTaylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

float fbm(vec3 p, int oct) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    s += a * snoise(p);
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s;
}

float h12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 h22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
`;

/** Vertex shader for bodies lit in object space: passes object position, view & sun directions (object space). */
export const BODY_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform vec3 uSunDir;
varying vec3 vObjPos;
varying vec3 vViewObj;
varying vec3 vSunObj;
void main() {
  vObjPos = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  mat3 mvT = transpose(mat3(modelViewMatrix));
  vViewObj = mvT * (-mv.xyz);
  vSunObj = mvT * (mat3(viewMatrix) * uSunDir);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

export const FRAG_HEAD = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
`;

export const FRAG_TAIL = /* glsl */ `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <logdepthbuf_fragment>
`;

/* ------------------------------------------------------------------------------------------------
 * Canvas textures (procedural)
 * ---------------------------------------------------------------------------------------------- */

let glowTexture: THREE.CanvasTexture | null = null;
function getGlowTexture(): THREE.CanvasTexture {
  if (glowTexture) return glowTexture;
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size * 2 - 1;
      const dy = (y + 0.5) / size * 2 - 1;
      const r = Math.sqrt(dx * dx + dy * dy);
      // Exponential core + long soft tail, forced to zero at the edge.
      const edge = Math.max(0, 1 - r);
      const v = (Math.exp(-r * 9) * 0.75 + Math.exp(-r * 3.2) * 0.25) * edge * edge;
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(Math.min(1, v) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  glowTexture = new THREE.CanvasTexture(canvas);
  glowTexture.colorSpace = THREE.NoColorSpace;
  return glowTexture;
}

let sunDiscTexture: THREE.CanvasTexture | null = null;
function getSunDiscTexture(): THREE.CanvasTexture {
  if (sunDiscTexture) return sunDiscTexture;
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const discR = 0.42;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size * 2 - 1;
      const dy = (y + 0.5) / size * 2 - 1;
      const r = Math.sqrt(dx * dx + dy * dy);
      let a: number;
      let lum: number;
      if (r < discR) {
        const mu = Math.sqrt(1 - (r / discR) ** 2);
        lum = 0.55 + 0.45 * mu; // limb darkening
        a = 1;
      } else {
        // thin corona fading out of the disc edge
        const t = (r - discR) / (1 - discR);
        lum = 0.55;
        a = Math.max(0, Math.exp(-t * 14) * (1 - t));
      }
      const aa = Math.min(1, Math.max(0, (discR - r) * size * 0.5 + 0.5));
      const alpha = r < discR ? Math.max(aa, a * (1 - aa)) : a;
      const i = (y * size + x) * 4;
      img.data[i] = Math.round(255 * lum);
      img.data[i + 1] = Math.round(255 * lum * 0.97);
      img.data[i + 2] = Math.round(255 * lum * 0.9);
      img.data[i + 3] = Math.round(alpha * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  sunDiscTexture = new THREE.CanvasTexture(canvas);
  sunDiscTexture.colorSpace = THREE.NoColorSpace;
  return sunDiscTexture;
}

/* ------------------------------------------------------------------------------------------------
 * Starfield + Milky Way
 * ---------------------------------------------------------------------------------------------- */

const STAR_RADIUS = 9e6;
const STAR_COUNT = 12000;

const STAR_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aSize;
attribute vec3 aColor;
attribute float aPhase;
uniform float uPixelRatio;
uniform float uTime;
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float tw = 0.86 + 0.14 * sin(uTime * (1.3 + aPhase * 3.1) + aPhase * 47.0);
  vColor = aColor * tw;
  gl_PointSize = max(aSize * uPixelRatio, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const STAR_FRAG = /* glsl */ `
${FRAG_HEAD}
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d2 = dot(c, c);
  if (d2 > 1.0) discard;
  float a = exp(-d2 * 3.5);
  gl_FragColor = vec4(vColor * a, 1.0);
${FRAG_TAIL}
}
`;

const SKY_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const SKY_FRAG = /* glsl */ `
${FRAG_HEAD}
${GLSL_NOISE}
uniform vec3 uGalN;
uniform vec3 uGalCore;
uniform float uIntensity;
uniform float uSeed;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float gl = dot(d, uGalN);
  float band = exp(-gl * gl * 22.0);
  vec3 col = vec3(0.0);
  vec3 so = vec3(uSeed, uSeed * 0.37, -uSeed * 0.71);
  if (band > 0.004) {
    float core = pow(dot(d, uGalCore) * 0.5 + 0.5, 5.0);
    float n1 = fbm(d * 3.0 + so, 4) * 0.5 + 0.5;
    float n2 = snoise(d * 11.0 + so) * 0.5 + 0.5;
    float clumps = 0.3 + 0.7 * n1 * (0.6 + 0.4 * n2);
    vec3 tint = mix(vec3(0.55, 0.62, 0.9), vec3(1.0, 0.82, 0.6), core);
    col = tint * band * clumps * (0.45 + 1.6 * core * exp(-gl * gl * 40.0));
    // dark dust lanes hugging the plane
    float dust = smoothstep(0.05, 0.4, fbm(d * 5.5 + so * 2.0, 4)) * exp(-gl * gl * 140.0);
    col *= 1.0 - dust * 0.85;
  }
  // sparse coloured nebulae
  float neb = smoothstep(0.25, 0.6, fbm(d * 1.8 + so + 13.0, 3));
  if (neb > 0.0) {
    float hue = snoise(d * 4.0 - so) * 0.5 + 0.5;
    col += neb * mix(vec3(0.7, 0.12, 0.3), vec3(0.12, 0.3, 0.7), hue) * 0.35;
  }
  gl_FragColor = vec4(col * uIntensity, 1.0);
${FRAG_TAIL}
}
`;

const STAR_TEMPS: ReadonlyArray<readonly [number, number, number, number]> = [
  // r, g, b, cumulative weight
  [0.62, 0.72, 1.0, 0.06], // O/B
  [0.8, 0.86, 1.0, 0.2], // A
  [1.0, 1.0, 1.0, 0.42], // F
  [1.0, 0.94, 0.8, 0.66], // G
  [1.0, 0.8, 0.56, 0.86], // K
  [1.0, 0.64, 0.42, 1.0], // M
];

/**
 * Points starfield on a 9e6 m sphere plus a shader Milky Way skydome.
 * Copy the camera position into the returned object every frame so it sits at infinity.
 * Drawn first (renderOrder -1000, depthTest off) so anything in the scene paints over it.
 */
export function createStarfield(seed: number): THREE.Object3D {
  const rng = mulberry32(seed);
  const group = new THREE.Group();
  group.name = 'Starfield';

  // Galactic frame: tilted plane, random azimuth from seed.
  const galN = new THREE.Vector3(0.38, 0.62, 0.69).normalize();
  galN.applyAxisAngle(new THREE.Vector3(0, 1, 0), rng() * Math.PI * 2);
  const galA = new THREE.Vector3().crossVectors(galN, new THREE.Vector3(0, 0, 1)).normalize();
  const galB = new THREE.Vector3().crossVectors(galN, galA).normalize();
  const coreAng = rng() * Math.PI * 2;
  const galCore = galA.clone().multiplyScalar(Math.cos(coreAng)).addScaledVector(galB, Math.sin(coreAng)).normalize();

  const positions = new Float32Array(STAR_COUNT * 3);
  const colors = new Float32Array(STAR_COUNT * 3);
  const sizes = new Float32Array(STAR_COUNT);
  const phases = new Float32Array(STAR_COUNT);
  const dir = new THREE.Vector3();
  for (let i = 0; i < STAR_COUNT; i++) {
    if (rng() < 0.38) {
      // concentrate along the galactic band (gaussian latitude)
      const a = rng() * Math.PI * 2;
      const g = Math.sqrt(-2 * Math.log(Math.max(1e-6, rng()))) * Math.cos(2 * Math.PI * rng()) * 0.11;
      dir.copy(galA).multiplyScalar(Math.cos(a)).addScaledVector(galB, Math.sin(a)).addScaledVector(galN, g).normalize();
    } else {
      const z = rng() * 2 - 1;
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(1 - z * z);
      dir.set(r * Math.cos(a), z, r * Math.sin(a));
    }
    positions[i * 3] = dir.x * STAR_RADIUS;
    positions[i * 3 + 1] = dir.y * STAR_RADIUS;
    positions[i * 3 + 2] = dir.z * STAR_RADIUS;

    const b = Math.pow(rng(), 8); // most stars faint, a few bright
    const w = rng();
    let k = 0;
    while (k < STAR_TEMPS.length - 1 && w > STAR_TEMPS[k][3]) k++;
    const t = STAR_TEMPS[k];
    // ~10% of stars cross the bloom threshold; ~60 hero stars (b > 0.96) clearly bloom.
    const intensity = 0.16 + b * 1.9 + (b > 0.96 ? 1.4 : 0);
    colors[i * 3] = t[0] * intensity;
    colors[i * 3 + 1] = t[1] * intensity;
    colors[i * 3 + 2] = t[2] * intensity;
    sizes[i] = 1.3 + b * 2.6 + rng() * 0.5;
    phases[i] = rng();
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geom.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geom.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));

  const starMat = new THREE.ShaderMaterial({
    uniforms: { uPixelRatio: { value: 1 }, uTime: timeUniform },
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    transparent: false,
    fog: false,
  });
  const stars = new THREE.Points(geom, starMat);
  stars.frustumCulled = false;
  stars.renderOrder = -1000;
  stars.onBeforeRender = (renderer) => {
    starMat.uniforms.uPixelRatio.value = renderer.getPixelRatio();
  };

  const skyMat = new THREE.ShaderMaterial({
    uniforms: {
      uGalN: { value: galN },
      uGalCore: { value: galCore },
      uIntensity: { value: 0.055 },
      uSeed: { value: (seed % 997) * 0.013 },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    transparent: false,
    fog: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(STAR_RADIUS * 0.98, 64, 32), skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -1001;

  group.add(sky, stars);
  return group;
}

/* ------------------------------------------------------------------------------------------------
 * Sun
 * ---------------------------------------------------------------------------------------------- */

const SUN_DISTANCE = 8e6;

export interface SunOptions {
  /** World direction toward this sun (default SUN_DIRECTION). */
  direction?: THREE.Vector3;
  /** Disc and glow size relative to the main sun. */
  size?: number;
  /** HDR sprite tints (linear, may exceed 1). */
  glowColor?: THREE.Color;
  discColor?: THREE.Color;
}

/**
 * Sun disc + glow sprites placed at `direction` * 8e6 inside the returned group.
 * Copy the camera position into the returned group each frame (like the starfield).
 */
export function createSun(opts: SunOptions = {}): THREE.Object3D {
  const size = opts.size ?? 1;
  const group = new THREE.Group();
  group.name = 'Sun';

  const glowMat = new THREE.SpriteMaterial({
    map: getGlowTexture(),
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    transparent: false,
    fog: false,
  });
  glowMat.color.copy(opts.glowColor ?? new THREE.Color(2.0, 1.45, 0.95));
  const glow = new THREE.Sprite(glowMat);
  glow.scale.setScalar(1.6e6 * size);
  glow.frustumCulled = false;
  glow.renderOrder = -999;

  const discMat = new THREE.SpriteMaterial({
    map: getSunDiscTexture(),
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    transparent: false,
    fog: false,
  });
  discMat.color.copy(opts.discColor ?? new THREE.Color(7.0, 6.4, 5.6));
  const disc = new THREE.Sprite(discMat);
  disc.scale.setScalar(2.6e5 * size);
  disc.frustumCulled = false;
  disc.renderOrder = -998;

  const anchor = new THREE.Group();
  anchor.position.copy(opts.direction ?? SUN_DIRECTION).normalize().multiplyScalar(SUN_DISTANCE);
  anchor.add(glow, disc);
  group.add(anchor);
  return group;
}

/* ------------------------------------------------------------------------------------------------
 * Atmosphere halo (shared by planets)
 * ---------------------------------------------------------------------------------------------- */

const HALO_FRAG = /* glsl */ `
${FRAG_HEAD}
uniform vec3 uColor;
uniform float uIntensity;
uniform float uLimbDot;
varying vec3 vObjPos;
varying vec3 vViewObj;
varying vec3 vSunObj;
void main() {
  vec3 n = normalize(vObjPos);
  vec3 V = normalize(vViewObj);
  vec3 L = normalize(vSunObj);
  float nv = abs(dot(n, V));
  float t = clamp(nv / uLimbDot, 0.0, 1.0); // 0 at outer edge -> 1 at the planet limb
  float glow = t * t * t;
  vec3 nl = normalize(n - dot(n, V) * V + 1e-6);
  float sun = clamp(dot(nl, L) * 0.85 + 0.3, 0.0, 1.0);
  // forward scattering when backlit
  float fwd = pow(max(dot(-V, L), 0.0), 8.0) * 0.8;
  gl_FragColor = vec4(uColor * glow * (sun + fwd) * uIntensity, 1.0);
${FRAG_TAIL}
}
`;

export function makeHalo(radius: number, ratio: number, color: THREE.Color, intensity: number): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: sunDirUniform,
      uColor: { value: color },
      uIntensity: { value: intensity },
      uLimbDot: { value: Math.sqrt(1 - 1 / (ratio * ratio)) },
    },
    vertexShader: BODY_VERT,
    fragmentShader: HALO_FRAG,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius * ratio, 96, 48), mat);
  mesh.name = 'AtmosphereHalo';
  return mesh;
}

/* ------------------------------------------------------------------------------------------------
 * Gas giants (Yavin, Endor)
 * ---------------------------------------------------------------------------------------------- */

const GAS_GIANT_FRAG = /* glsl */ `
${FRAG_HEAD}
${GLSL_NOISE}
uniform float uTime;
uniform float uSunIntensity;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uC3;
uniform vec3 uC4;
uniform vec3 uStormA;
uniform vec3 uStormB;
uniform float uStorm;
uniform vec3 uTerm;
uniform vec3 uAtm;
varying vec3 vObjPos;
varying vec3 vViewObj;
varying vec3 vSunObj;

void main() {
  vec3 n = normalize(vObjPos);
  vec3 V = normalize(vViewObj);
  vec3 L = normalize(vSunObj);
  float lat = n.y;

  // Zonal jets: each latitude drifts at its own speed.
  float spd = 0.0025 * sin(lat * 9.0) + 0.0012 * sin(lat * 23.0 + 1.0);
  float a = uTime * spd;
  float ca = cos(a), sa = sin(a);
  vec3 p = vec3(ca * n.x - sa * n.z, n.y, sa * n.x + ca * n.z);
  float t = uTime * 0.004;

  vec3 q = vec3(p.x * 2.0, p.y * 7.0, p.z * 2.0);
  vec2 w = vec2(fbm(q + vec3(0.0, 0.0, t), 4), fbm(q * 1.7 + vec3(5.2, 1.3, -t), 3));
  float turb = fbm(vec3(p.x * 3.0, p.y * 18.0, p.z * 3.0) + vec3(w * 1.8, t * 2.0), 5);

  float b = lat * 10.0 + turb * 0.9 + w.x * 0.7;
  float bands = 0.5 + 0.5 * sin(b * 3.1 + sin(b * 1.3));
  float fine = 0.5 + 0.5 * sin(lat * 74.0 + turb * 5.0 + w.y * 3.0);

  vec3 col = mix(uC1, uC2, bands);
  col = mix(col, uC3, smoothstep(0.55, 0.95, fine) * 0.4);
  col = mix(col, uC4, smoothstep(0.2, 0.7, turb + w.y * 0.3) * 0.45);

  // Great storm riding its band
  float lon = atan(p.z, p.x);
  float dl = lon - 2.2;
  dl = dl - 6.28318530718 * floor((dl + 3.14159265359) / 6.28318530718);
  vec2 sv = vec2(dl * 0.95 / 0.17, (asin(clamp(lat, -1.0, 1.0)) + 0.33) / 0.075);
  float sr = length(sv);
  if (sr < 1.8 && uStorm > 0.0) {
    float ang = atan(sv.y, sv.x) + (1.0 - sr) * 2.5 + uTime * 0.01;
    float sw = snoise(vec3(cos(ang) * sr * 2.5, sin(ang) * sr * 2.5, t * 3.0)) * 0.5 + 0.5;
    float core = 1.0 - smoothstep(0.2, 1.0, sr);
    col = mix(col, mix(uStormA, uStormB, sw), core * 0.85 * uStorm);
    col = mix(col, uC4, (1.0 - smoothstep(0.0, 0.25, abs(sr - 1.1))) * 0.5 * uStorm);
  }

  // Polar haze
  col *= mix(1.0, 0.55, smoothstep(0.62, 0.97, abs(lat)));

  float ndl = dot(n, L);
  float diff = clamp((ndl + 0.04) / 1.04, 0.0, 1.0);
  float nv = max(dot(n, V), 0.0);
  vec3 termTint = mix(uTerm, vec3(1.0), smoothstep(0.0, 0.35, ndl));
  vec3 lit = col * termTint * diff * uSunIntensity;
  lit *= mix(0.5, 1.0, pow(nv, 0.4)); // limb darkening
  float fres = pow(1.0 - nv, 3.0);
  vec3 atm = uAtm * fres * clamp(ndl * 1.4 + 0.25, 0.0, 1.0) * 0.8;
  gl_FragColor = vec4(lit + atm + col * 0.004, 1.0);
${FRAG_TAIL}
}
`;

/** Banding palette of a gas giant (linear colours). */
export interface GasGiantPalette {
  name: string;
  /** Belt, zone, dark streak and pale highlight colours. */
  bands: readonly [THREE.Color, THREE.Color, THREE.Color, THREE.Color];
  /** Great storm colours (dark, light) and strength (0 = no storm). */
  storm: readonly [THREE.Color, THREE.Color];
  stormStrength: number;
  /** Terminator tint and fresnel atmosphere colour. */
  terminator: THREE.Color;
  atmosphere: THREE.Color;
  halo: THREE.Color;
  haloIntensity: number;
  sunIntensity: number;
}

export const YAVIN_PALETTE: GasGiantPalette = {
  name: 'Yavin',
  bands: [
    new THREE.Color(0.50, 0.21, 0.06), // deep ochre
    new THREE.Color(0.86, 0.52, 0.22), // orange cream
    new THREE.Color(0.34, 0.11, 0.035), // rust
    new THREE.Color(0.95, 0.76, 0.48), // pale zone
  ],
  storm: [new THREE.Color(0.6, 0.2, 0.07), new THREE.Color(0.95, 0.6, 0.35)],
  stormStrength: 1,
  terminator: new THREE.Color(1.0, 0.42, 0.18),
  atmosphere: new THREE.Color(1.0, 0.55, 0.25),
  halo: new THREE.Color(1.0, 0.58, 0.28),
  haloIntensity: 1.1,
  sunIntensity: 1.7,
};

/** Banded, animated gas giant. Yavin: radius ~7e7 m at ~3e8 m from the battle. */
export function createGasGiant(radius: number, palette: GasGiantPalette): THREE.Mesh {
  const [c1, c2, c3, c4] = palette.bands;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: sunDirUniform,
      uTime: timeUniform,
      uSunIntensity: { value: palette.sunIntensity },
      uC1: { value: c1 },
      uC2: { value: c2 },
      uC3: { value: c3 },
      uC4: { value: c4 },
      uStormA: { value: palette.storm[0] },
      uStormB: { value: palette.storm[1] },
      uStorm: { value: palette.stormStrength },
      uTerm: { value: palette.terminator },
      uAtm: { value: palette.atmosphere },
    },
    vertexShader: BODY_VERT,
    fragmentShader: GAS_GIANT_FRAG,
    fog: false,
  });
  const geom = new THREE.SphereGeometry(radius, 160, 80);
  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = palette.name;
  mesh.add(makeHalo(radius, 1.025, palette.halo, palette.haloIntensity));
  return mesh;
}

/* ------------------------------------------------------------------------------------------------
 * Yavin 4 (jungle moon)
 * ---------------------------------------------------------------------------------------------- */

const MOON_FRAG = /* glsl */ `
${FRAG_HEAD}
${GLSL_NOISE}
uniform float uTime;
uniform float uSunIntensity;
varying vec3 vObjPos;
varying vec3 vViewObj;
varying vec3 vSunObj;

void main() {
  vec3 n = normalize(vObjPos);
  vec3 V = normalize(vViewObj);
  vec3 L = normalize(vSunObj);

  float c = fbm(n * 1.8 + 4.3, 6);
  float c2 = fbm(n * 7.0 + 1.7, 3);
  float h = c + c2 * 0.22 - 0.03;
  float land = smoothstep(0.0, 0.025, h);
  float hum = fbm(n * 3.5 + 9.1, 3) * 0.5 + 0.5;

  vec3 jungle = mix(vec3(0.025, 0.10, 0.03), vec3(0.03, 0.15, 0.10), hum);
  vec3 highland = vec3(0.13, 0.14, 0.08);
  vec3 lc = mix(jungle, highland, smoothstep(0.32, 0.6, h));
  lc *= 0.85 + 0.3 * (c2 * 0.5 + 0.5);
  float polar = smoothstep(0.84, 0.94, abs(n.y) + c2 * 0.06);
  lc = mix(lc, vec3(0.62, 0.68, 0.72), polar);
  vec3 ocean = mix(vec3(0.004, 0.025, 0.06), vec3(0.02, 0.11, 0.12), smoothstep(-0.14, 0.0, h));
  vec3 albedo = mix(ocean, lc, land);

  // Clouds drift slowly around the axis
  float ca = cos(uTime * 0.003), sa = sin(uTime * 0.003);
  vec3 pc = vec3(ca * n.x - sa * n.z, n.y, sa * n.x + ca * n.z);
  vec3 cw = vec3(fbm(pc * 2.0 + 3.0, 3), fbm(pc * 2.0 + 7.0, 3), 0.0);
  float cl = fbm(pc * vec3(3.0, 5.0, 3.0) + cw * 1.2 + vec3(0.0, 0.0, uTime * 0.0015), 5);
  float clouds = smoothstep(0.02, 0.4, cl + 0.05 * sin(n.y * 12.0));

  float ndl = dot(n, L);
  float diff = clamp(ndl, 0.0, 1.0);
  vec3 H = normalize(L + V);
  float nh = max(dot(n, H), 0.0);
  float spec = (pow(nh, 120.0) * 1.6 + pow(nh, 14.0) * 0.06) * (1.0 - land) * (1.0 - clouds) * smoothstep(0.0, 0.1, ndl);

  vec3 surf = mix(albedo * (1.0 - clouds * 0.35), vec3(0.82, 0.85, 0.88), clouds);
  vec3 col = surf * diff * uSunIntensity + vec3(1.0, 0.95, 0.85) * spec * uSunIntensity;

  float nv = max(dot(n, V), 0.0);
  float fres = pow(1.0 - nv, 2.6);
  float atmLit = clamp(ndl * 1.3 + 0.25, 0.0, 1.0);
  col = mix(col, col * vec3(0.7, 0.85, 1.1) + vec3(0.02, 0.05, 0.12) * diff, 0.35 * (1.0 - nv));
  col += vec3(0.25, 0.5, 1.0) * fres * atmLit * 1.2;
  // reddened terminator scattering
  col += vec3(0.25, 0.12, 0.05) * fres * (1.0 - smoothstep(0.0, 0.25, abs(ndl)));
  gl_FragColor = vec4(col, 1.0);
${FRAG_TAIL}
}
`;

/** Yavin 4: jungle moon with oceans, clouds, ocean glint and blue atmosphere rim. */
export function createMoonYavin4(radius: number): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: sunDirUniform,
      uTime: timeUniform,
      uSunIntensity: { value: 1.8 },
    },
    vertexShader: BODY_VERT,
    fragmentShader: MOON_FRAG,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 160, 80), mat);
  mesh.name = 'Yavin4';
  mesh.add(makeHalo(radius, 1.03, new THREE.Color(0.35, 0.6, 1.0), 1.4));
  return mesh;
}

/* ------------------------------------------------------------------------------------------------
 * Death Star sphere
 * ---------------------------------------------------------------------------------------------- */

const DS_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform vec3 uSunDir;
uniform float uRadius;
uniform float uDishAngle;
uniform float uDishDepth;
uniform vec3 uDishAxis;
varying vec3 vObjPos;
varying vec3 vViewObj;
varying vec3 vSunObj;
void main() {
  vec3 n = normalize(position);
  float th = acos(clamp(dot(n, uDishAxis), -1.0, 1.0));
  float tn = th / uDishAngle;
  float r = uRadius;
  if (tn < 1.0) r -= uDishDepth * (1.0 - tn * tn);
  vec3 p = n * r;
  vObjPos = p;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  mat3 mvT = transpose(mat3(modelViewMatrix));
  vViewObj = mvT * (-mv.xyz);
  vSunObj = mvT * (mat3(viewMatrix) * uSunDir);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

const DS_FRAG = /* glsl */ `
${FRAG_HEAD}
${GLSL_NOISE}
uniform float uRadius;
uniform float uTime;
uniform float uTrenchHW;
uniform float uDishAngle;
uniform float uDishDepth;
uniform float uCharge;
uniform float uSunIntensity;
uniform vec3 uDishAxis;
uniform vec3 uDishE1;
uniform vec3 uDishE2;
varying vec3 vObjPos;
varying vec3 vViewObj;
varying vec3 vSunObj;

// Antialiased line: d = distance to line centre, w = full width (m), fw = metres per pixel.
float aaLine(float d, float w, float fw) {
  float we = max(w, fw);
  return (1.0 - smoothstep(we * 0.5, we, d)) * (w / we);
}

uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

// Film-style hull quilt: each TOP x TOP lat/long cell is recursively kd-split (axis + position per node)
// into rectangular plates of very mixed sizes. Each split draws a thin dark seam with rounded plate edges;
// a few nodes become recessed dark sectors, wide service channels, or large smooth plates.
// Every level fades out by pixel footprint so distant/grazing views converge to flat grey instead of shimmering.
const float TOP = 4800.0;
void quilt(vec2 pp, float fw, out float alb, out float cav, out vec2 bev, out float hs) {
  alb = 1.0;
  cav = 0.0;
  bev = vec2(0.0);
  hs = 0.5;
  vec2 cid = floor(pp / TOP);
  vec2 q = pp - cid * TOP;
  uint node = pcg(uint(int(cid.x) + 32768) * 65599u + uint(int(cid.y) + 32768));
  vec2 lo = vec2(0.0);
  vec2 hi = vec2(TOP);

  // top-level cell seams
  vec2 dt = min(q, TOP - q);
  cav = aaLine(min(dt.x, dt.y), 22.0, fw) * 0.85;

  float contrast = 1.0;
  bool stopped = false;
  bool recessed = false;
  vec2 rlo = vec2(0.0);
  vec2 rhi = vec2(0.0);
  for (int i = 0; i < 28; i++) {
    vec2 sz = hi - lo;
    float ms = min(sz.x, sz.y);
    float vis = smoothstep(2.0, 6.0, ms / fw);
    if (vis <= 0.0 || ms < 0.8) break;
    uint h = pcg(node);
    float hA = float(h & 255u) / 255.0;
    float hP = float((h >> 8u) & 255u) / 255.0;
    float hT = float((h >> 16u) & 255u) / 255.0;
    float hE = float(h >> 24u) / 255.0;

    alb *= 1.0 + (hT - 0.5) * 0.07 * vis * contrast;
    hs = mix(hs, hT, vis);
    if (!recessed && !stopped && ms > 40.0 && ms < 1600.0 && hE < 0.015) {
      recessed = true;
      rlo = lo;
      rhi = hi;
      alb *= mix(1.0, 0.82, vis);
    } else if (!stopped && ms < 700.0 && hE > 0.86) {
      stopped = true;
      contrast = 0.3; // large smooth plate: only faint weathering seams below this node
    }

    // split the longer side; near-square nodes pick at random
    float rx = sz.x / sz.y;
    bool ax = rx > 1.6 ? true : (rx < 0.625 ? false : hA < 0.5);
    vec2 m = ax ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    float t = hP < 0.4 ? 0.5 : (hP < 0.6 ? 0.3333 : (hP < 0.8 ? 0.6667 : (hP < 0.9 ? 0.25 : 0.75)));
    float sp = dot(lo, m) + dot(sz, m) * t;
    float c = dot(q, m) - sp;
    float d = abs(c);
    float w = clamp(ms * 0.005, 0.05, 8.0);
    float depth = 0.85 * contrast;
    if (!stopped && ms > 200.0 && hE > 0.5 && hE < 0.56) {
      w = ms * 0.025; // service channel
      depth = 0.95;
    }
    cav = max(cav, aaLine(d, w, fw) * vis * depth);
    float bw = w * 2.5;
    float bvw = 1.0 - smoothstep(0.0, bw, abs(d - w * 0.5));
    bev -= sign(c) * m * bvw * min(1.0, bw / fw) * vis * 0.5 * contrast;

    if (c < 0.0) {
      hi = mix(hi, vec2(sp), m);
      node = pcg(node ^ 0x68E31DA4u);
    } else {
      lo = mix(lo, vec2(sp), m);
      node = pcg(node ^ 0xB5297A4Du);
    }
  }

  if (recessed) {
    // pit walls face inward; their base is in shadow
    vec2 de = min(q - rlo, rhi - q);
    float ww = min(rhi.x - rlo.x, rhi.y - rlo.y) * 0.03;
    vec2 s = (1.0 - smoothstep(vec2(0.0), vec2(ww), de)) * min(1.0, ww / fw);
    bev -= sign(q - (rlo + rhi) * 0.5) * s * 0.9;
    cav = max(cav, max(s.x, s.y) * 0.35);
  }
}

// Pin-point lights on a grid of cell size s (m).
float lightsAt(vec2 p, float s, float fw, float dens) {
  vec2 q = p / s;
  vec2 id = floor(q);
  vec2 f = q - id;
  float h = h12(id + 17.0);
  if (h > dens) return 0.0;
  vec2 c = 0.15 + 0.7 * h22(id + 3.7);
  float r = max(fw * 0.75, s * 0.05);
  float d = length((f - c) * s);
  float k = 1.0 - smoothstep(r * 0.25, r, d);
  return k * (0.5 + h / max(dens, 1e-3));
}

void main() {
  vec3 P = vObjPos;
  vec3 n = normalize(P);
  vec3 V = normalize(vViewObj);
  vec3 L = normalize(vSunObj);
  float R = uRadius;
  float fw = max(length(fwidth(P)), 1e-3);

  float lat = atan(n.y, length(n.xz));
  float lon = atan(n.z, n.x);
  vec3 east = normalize(vec3(-n.z, 0.0, n.x) + vec3(1e-7, 0.0, 0.0));
  vec3 north = cross(east, n);

  // Lat/long panel space (metres). Each TOP-high row keeps one x-scale so cells stay near-square at every latitude.
  float y = lat * R;
  float bandId = floor(y / 2400.0);
  float latc = (floor(y / TOP) + 0.5) * TOP / R;
  float x = lon * R * cos(latc);
  vec2 pp = vec2(x, y);

  float alb;
  float cav;
  float hs;
  vec2 bev;
  quilt(pp, fw, alb, cav, bev, hs);

  // Latitudinal surface grooves (the many horizontal "trenches" visible from afar)
  float bnd = floor(y / 2400.0 + 0.5);
  float gh = h12(vec2(bnd, 9.0));
  if (gh > 0.45) {
    float gw = 30.0 + 90.0 * gh;
    float gc = y - bnd * 2400.0;
    cav = max(cav, aaLine(abs(gc), gw, fw) * 0.9);
    float gwall = 1.0 - smoothstep(0.0, gw * 0.15, abs(abs(gc) - gw * 0.5));
    bev.y -= sign(gc) * gwall * min(1.0, gw * 0.15 / fw) * 0.8;
  }

  // Large-scale tonal variation (sectors) + close-range grime
  alb *= 0.92 + 0.16 * (snoise(n * 6.0) * 0.5 + 0.5);
  alb *= 1.0 + 0.06 * snoise(P * 0.08) * (1.0 - smoothstep(2.0, 8.0, fw));

  vec3 N = normalize(n + (east * bev.x + north * bev.y) * 0.35);

  // Equatorial trench
  float ay = abs(y);
  float hw = uTrenchHW;
  float trW = max(hw, fw * 0.9);
  float tre = (1.0 - smoothstep(trW - fw * 0.5, trW + fw * 0.5, ay)) * min(1.0, hw / trW + 0.35);
  if (tre > 0.0) {
    float wallW = hw * 0.25;
    float inWall = smoothstep(hw - wallW, hw - wallW * 0.3, ay);
    vec3 wallN = -sign(y + 1e-6) * north;
    N = normalize(mix(N, wallN, inWall * tre));
    alb *= mix(1.0, 0.5, tre * (1.0 - inWall));
    cav *= 1.0 - 0.5 * tre;
  }

  // Superlaser dish
  float ct = dot(n, uDishAxis);
  float th = acos(clamp(ct, -1.0, 1.0));
  float tn = th / uDishAngle;
  float inDish = 0.0;
  vec3 emis = vec3(0.0);
  if (tn < 1.08) {
    vec3 td = n - uDishAxis * ct;
    float tl = length(td);
    td = tl > 1e-7 ? td / tl : uDishE1;
    float phi = atan(dot(td, uDishE2), dot(td, uDishE1));
    float rm = th * R;
    float dishR = uDishAngle * R;
    if (tn < 1.0) {
      inDish = 1.0;
      // concave bowl normal (surface of revolution r(theta))
      float rr = R - uDishDepth * (1.0 - tn * tn);
      float dr = 2.0 * uDishDepth * th / (uDishAngle * uDishAngle);
      vec3 tTh = -uDishAxis * sin(th) + td * cos(th);
      vec3 bowl = normalize(n * rr - tTh * dr);
      N = normalize(bowl + (east * bev.x + north * bev.y) * 0.12);

      float ringSp = dishR / 16.0;
      float c1 = aaLine(abs(fract(rm / ringSp + 0.5) - 0.5) * ringSp, ringSp * 0.035, fw);
      float sp2 = ringSp * 0.25;
      float c2 = aaLine(abs(fract(rm / sp2 + 0.5) - 0.5) * sp2, sp2 * 0.05, fw) * 0.5;
      float spokes = 48.0;
      float sp = phi / (2.0 * PI) * spokes;
      float arc = 2.0 * PI * max(rm, 1.0) / spokes;
      float c3 = aaLine(abs(fract(sp + 0.5) - 0.5) * arc, ringSp * 0.03, fw) * smoothstep(0.12, 0.2, tn);
      cav = max(cav * 0.5, max(max(c1, c2), c3) * 0.85);
      alb *= 0.82;

      // Eight tributary emitters on a ring around the focus lens
      vec2 u = tn * vec2(cos(phi), sin(phi));
      float k = floor(phi / (PI * 0.25) + 0.5);
      float eca = k * PI * 0.25;
      float de = length(u - 0.52 * vec2(cos(eca), sin(eca))) * dishR;
      float er = 0.085 * dishR;
      float well = 1.0 - smoothstep(er * 0.82, er * 0.82 + fw, de);
      float erim = aaLine(abs(de - er * 0.9), er * 0.14, fw);
      float einner = aaLine(abs(de - er * 0.45), er * 0.06, fw);
      // Central focus lens
      float fr = 0.11 * dishR;
      float lens = 1.0 - smoothstep(fr * 0.9, fr * 0.9 + fw, rm);
      float lensRim = aaLine(abs(rm - fr), fr * 0.12, fw);
      float lensRing = aaLine(abs(rm - fr * 0.55), fr * 0.05, fw);
      alb *= 1.0 - 0.6 * well - 0.55 * lens;
      alb *= 1.0 + 0.8 * (erim + lensRim) + 0.4 * (einner + lensRing);
      float pulse = 1.0 + 0.3 * sin(uTime * 9.0) * uCharge;
      vec3 green = vec3(0.3, 1.0, 0.35);
      emis += green * well * (0.015 + uCharge * 6.0 * (1.0 - smoothstep(0.0, er, de) * 0.6)) * pulse;
      emis += green * lens * (0.01 + uCharge * 10.0 * (1.0 - smoothstep(0.0, fr, rm) * 0.5)) * pulse;
      emis += green * (einner + lensRing) * uCharge * 4.0;
      // dark shadowed lip just inside the rim
      cav = max(cav, aaLine(abs(tn - 0.985) * dishR, dishR * 0.02, fw) * 0.8);
    } else {
      // raised rim ridge just outside the bowl
      float lip = (tn - 1.0) / 0.08;
      N = normalize(N + td * 0.6 * (1.0 - lip) * step(0.0, lip));
      alb *= 1.0 + 0.25 * (1.0 - lip);
    }
  }

  // City lights: power-of-two grids picked from the pixel footprint keep them pin-sharp at any range.
  float district = snoise(n * 9.0) * 0.6 + snoise(n * 37.0) * 0.4;
  float dens = clamp(0.1 + district * 0.35, 0.0, 0.5);
  dens *= 0.5 + 0.9 * h12(vec2(bandId, 5.0));
  dens = mix(dens, 0.6, tre);
  float lv = log2(fw * 7.0);
  float l0 = floor(lv);
  float lt = lv - l0;
  float lights = mix(lightsAt(pp, exp2(l0), fw, dens), lightsAt(pp, exp2(l0 + 1.0), fw, dens), lt);
  lights *= 1.0 - inDish * 0.7;

  // Lighting
  float ndlGeo = dot(n, L);
  float shadowTerm = smoothstep(-0.02, 0.06, ndlGeo);
  float ndl = max(dot(N, L), 0.0) * shadowTerm;
  vec3 base = vec3(0.19, 0.2, 0.215) * alb * (1.0 - 0.8 * cav);
  vec3 Hh = normalize(L + V);
  float spec = pow(max(dot(N, Hh), 0.0), 48.0) * (0.02 + 0.08 * hs) * shadowTerm;
  vec3 sunC = vec3(1.0, 0.97, 0.92) * uSunIntensity;
  vec3 col = base * (sunC * ndl + vec3(0.010, 0.011, 0.014)) + sunC * spec * (1.0 - cav);
  float night = smoothstep(0.12, -0.12, ndlGeo);
  col += vec3(1.0, 0.86, 0.62) * lights * mix(0.25, 2.6, night);
  col += emis;
  gl_FragColor = vec4(col, 1.0);
${FRAG_TAIL}
}
`;

export interface DeathStarSphere {
  mesh: THREE.Mesh;
  update(dt: number): void;
  setDestroyed(visible: boolean): void;
}

/**
 * DS-I battle station. Superlaser dish axis = DEATH_STAR_DISH_DIR (object space, 30° N, toward -Z).
 * Material uniforms of note: uTrenchHW (equatorial trench half-width, m), uCharge (0..1 superlaser glow).
 * setDestroyed(true) hides the station; setDestroyed(false) shows it again.
 */
export function createDeathStarSphere(radius: number): DeathStarSphere {
  const axis = DEATH_STAR_DISH_DIR.clone();
  const e1 = new THREE.Vector3().crossVectors(axis, new THREE.Vector3(0, 1, 0)).normalize();
  const e2 = new THREE.Vector3().crossVectors(axis, e1).normalize();
  const dishAngle = 0.24; // rad: dish diameter ~ a quarter of the station's diameter
  const uniforms = {
    uSunDir: sunDirUniform,
    uRadius: { value: radius },
    uTime: { value: 0 },
    uTrenchHW: { value: Math.max(60, radius * 0.004) },
    uDishAngle: { value: dishAngle },
    uDishDepth: { value: radius * 0.045 },
    uDishAxis: { value: axis },
    uDishE1: { value: e1 },
    uDishE2: { value: e2 },
    uCharge: { value: 0 },
    uSunIntensity: { value: 1.35 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: DS_VERT,
    fragmentShader: DS_FRAG,
    fog: false,
  });
  const geom = new THREE.SphereGeometry(radius, 384, 192);
  geom.deleteAttribute('uv');
  geom.deleteAttribute('normal');
  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = 'DeathStar';

  return {
    mesh,
    update(dt: number): void {
      uniforms.uTime.value += dt;
    },
    setDestroyed(destroyed: boolean): void {
      mesh.visible = !destroyed;
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * Death Star explosion
 * ---------------------------------------------------------------------------------------------- */

const EXPLOSION_DURATION = 10;

let fireballGeom: THREE.BufferGeometry | null = null;
let ringGeom: THREE.BufferGeometry | null = null;
let debrisGeom: THREE.BufferGeometry | null = null;
const DEBRIS_COUNT = 6000;

function getFireballGeom(): THREE.BufferGeometry {
  if (!fireballGeom) {
    fireballGeom = new THREE.IcosahedronGeometry(1, 20);
    fireballGeom.deleteAttribute('uv');
  }
  return fireballGeom;
}

function getRingGeom(): THREE.BufferGeometry {
  if (!ringGeom) {
    ringGeom = new THREE.PlaneGeometry(2, 2, 1, 1);
    ringGeom.rotateX(-Math.PI / 2);
  }
  return ringGeom;
}

function getDebrisGeom(): THREE.BufferGeometry {
  if (debrisGeom) return debrisGeom;
  const rng = mulberry32(0x0de57a);
  const pos = new Float32Array(DEBRIS_COUNT * 3);
  const dir = new Float32Array(DEBRIS_COUNT * 3);
  const speed = new Float32Array(DEBRIS_COUNT);
  const size = new Float32Array(DEBRIS_COUNT);
  const seed = new Float32Array(DEBRIS_COUNT);
  for (let i = 0; i < DEBRIS_COUNT; i++) {
    let x: number;
    let y: number;
    let z: number;
    const a = rng() * Math.PI * 2;
    if (rng() < 0.4) {
      // flattened toward the shockwave plane
      y = (rng() * 2 - 1) * 0.18;
      const r = Math.sqrt(1 - y * y);
      x = r * Math.cos(a);
      z = r * Math.sin(a);
    } else {
      y = rng() * 2 - 1;
      const r = Math.sqrt(1 - y * y);
      x = r * Math.cos(a);
      z = r * Math.sin(a);
    }
    dir[i * 3] = x;
    dir[i * 3 + 1] = y;
    dir[i * 3 + 2] = z;
    speed[i] = 0.2 + Math.pow(rng(), 1.6) * 1.1; // radii per second
    size[i] = 0.003 + Math.pow(rng(), 3) * 0.014; // fraction of radius
    seed[i] = rng();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aDir', new THREE.BufferAttribute(dir, 3));
  g.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  debrisGeom = g;
  return g;
}

const FIREBALL_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
${GLSL_NOISE}
uniform float uAge;
varying vec3 vDir;
varying vec3 vViewObj;
varying float vDisp;
void main() {
  vec3 n = normalize(position);
  float d = snoise(n * 2.5 + vec3(0.0, uAge * 0.4, 0.0)) * 0.6 + snoise(n * 6.0 - vec3(uAge * 0.7)) * 0.3;
  vDisp = d;
  vDir = n;
  vec3 p = n * (1.0 + 0.1 * d);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vViewObj = transpose(mat3(modelViewMatrix)) * (-mv.xyz);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

const FIREBALL_FRAG = /* glsl */ `
${FRAG_HEAD}
${GLSL_NOISE}
uniform float uAge;
uniform float uFade;
varying vec3 vDir;
varying vec3 vViewObj;
varying float vDisp;

vec3 heatRamp(float h) {
  vec3 c = vec3(0.0);
  c = mix(c, vec3(0.7, 0.08, 0.02), smoothstep(0.05, 0.3, h));
  c = mix(c, vec3(2.4, 0.75, 0.12), smoothstep(0.3, 0.55, h));
  c = mix(c, vec3(4.5, 3.0, 1.0), smoothstep(0.55, 0.8, h));
  c = mix(c, vec3(8.0, 7.6, 7.0), smoothstep(0.8, 1.0, h));
  return c;
}

void main() {
  vec3 n = normalize(vDir);
  vec3 V = normalize(vViewObj);
  float nv = max(dot(n, V), 0.0);
  vec3 q = n * 4.0 + vec3(0.0, 0.0, uAge * 0.6);
  float turb = abs(snoise(q)) * 0.5 + abs(snoise(q * 2.1 + 3.0)) * 0.25 + abs(snoise(q * 4.3 - 1.0)) * 0.125;
  turb = 1.0 - turb * 1.3;
  float heat = nv * 0.75 + turb * 0.45 + vDisp * 0.15 - uAge * 0.12;
  vec3 col = heatRamp(clamp(heat, 0.0, 1.0));
  float edge = smoothstep(0.0, 0.35, nv + turb * 0.15 - 0.1);
  gl_FragColor = vec4(col * edge * uFade, 1.0);
${FRAG_TAIL}
}
`;

const RING_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vP;
void main() {
  vP = position.xz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const RING_FRAG = /* glsl */ `
${FRAG_HEAD}
${GLSL_NOISE}
uniform float uExtent;   // plane half-size in radii
uniform float uRingR;    // current ring radius in radii
uniform float uAge;
uniform float uFade;
uniform float uSeed;
uniform float uThin;
varying vec2 vP;
void main() {
  float r = length(vP) * uExtent;
  float ang = atan(vP.y, vP.x);
  float d = r - uRingR;
  float thick = (0.12 + uRingR * 0.09) * uThin;
  float lead = exp(-max(d, 0.0) * 30.0 / (1.0 + uRingR * 0.25));
  float trail = exp(min(d, 0.0) / thick);
  float prof = d > 0.0 ? lead : trail;
  if (prof < 0.002) discard;
  vec2 cs = vec2(cos(ang), sin(ang));
  float s1 = snoise(vec3(cs * 7.0, r * 1.2 - uAge * 0.4 + uSeed)) * 0.5 + 0.5;
  float s2 = snoise(vec3(cs * 34.0, uAge * 0.25 + uSeed * 3.0)) * 0.5 + 0.5;
  float streak = 0.25 + 0.75 * s1 * (0.4 + 0.6 * s2);
  float edgeHot = exp(-abs(d) * 10.0);
  vec3 col = mix(vec3(2.2, 0.75, 0.2), vec3(1.6, 2.0, 3.2), edgeHot);
  col = mix(col, vec3(0.9, 0.18, 0.05), smoothstep(0.0, 1.0, -d / (thick * 2.5)));
  float fadeOut = 1.0 - smoothstep(uExtent * 0.85, uExtent, r);
  gl_FragColor = vec4(col * prof * streak * uFade * fadeOut * 1.6, 1.0);
${FRAG_TAIL}
}
`;

const DEBRIS_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aDir;
attribute float aSpeed;
attribute float aSize;
attribute float aSeed;
uniform float uAge;
uniform float uR;
uniform vec2 uViewport;
varying vec3 vCol;
varying float vA;
varying vec2 vStreak;   // streak direction in point-coord space
varying float vWidth;   // core width / point size
void main() {
  float k = 0.12;
  float tau = (1.0 - exp(-uAge * k)) / k;
  float vel = exp(-uAge * k);
  vec3 p = aDir * uR * (0.08 + aSpeed * tau);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  // screen-space motion over a 0.25s "shutter"
  vec4 c1 = projectionMatrix * modelViewMatrix * vec4(p - aDir * uR * aSpeed * vel * 0.25, 1.0);
  vec2 s0 = gl_Position.xy / max(gl_Position.w, 1e-6);
  vec2 s1 = c1.xy / max(c1.w, 1e-6);
  vec2 dpx = (s0 - s1) * 0.5 * uViewport;
  float len = length(dpx);

  float core = aSize * uR * projectionMatrix[1][1] * uViewport.y * 0.5 / max(-mv.z, 1.0);
  float coreC = max(core, 1.5);
  float sizePx = clamp(max(len, coreC), 1.5, 64.0);
  gl_PointSize = sizePx;
  vStreak = len > 0.5 ? vec2(dpx.x, -dpx.y) / len : vec2(1.0, 0.0);
  vWidth = clamp(coreC / sizePx, 0.04, 1.0);

  float life = clamp(uAge / (3.0 + aSeed * 6.0), 0.0, 1.0);
  vec3 hot = vec3(5.0, 4.4, 3.6);
  vec3 warm = vec3(3.2, 1.3, 0.3);
  vec3 cool = vec3(0.7, 0.15, 0.04);
  vCol = life < 0.3 ? mix(hot, warm, life / 0.3) : mix(warm, cool, (life - 0.3) / 0.7);
  vA = (1.0 - smoothstep(0.65, 1.0, life)) * smoothstep(0.0, 0.1, uAge) * min(1.0, core / 1.5 + 0.35);
  #include <logdepthbuf_vertex>
}
`;

const DEBRIS_FRAG = /* glsl */ `
${FRAG_HEAD}
varying vec3 vCol;
varying float vA;
varying vec2 vStreak;
varying float vWidth;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float along = dot(c, vStreak);
  float across = dot(c, vec2(-vStreak.y, vStreak.x)) / vWidth;
  float e = along * along + across * across;
  if (e > 1.0) discard;
  float head = mix(0.25, 1.0, smoothstep(-1.0, 0.8, along));
  float a = exp(-e * 3.0) * head * vA;
  gl_FragColor = vec4(vCol * a, 1.0);
${FRAG_TAIL}
}
`;

export interface DeathStarExplosion {
  group: THREE.Group;
  update(dt: number): void;
  readonly done: boolean;
  readonly flash: number;
}

/**
 * Death Star explosion centred on the returned group's origin (place it at the station centre).
 * ~10 s: core flash, turbulent fireball to 1.6R, planar shockwave ring to 6R (~8 s), streaking debris.
 */
export function createDeathStarExplosion(radius: number): DeathStarExplosion {
  const R = radius;
  const group = new THREE.Group();
  group.name = 'DeathStarExplosion';

  // Core flash
  const flashMat = new THREE.SpriteMaterial({
    map: getGlowTexture(),
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    fog: false,
  });
  const flashSprite = new THREE.Sprite(flashMat);
  flashSprite.frustumCulled = false;
  flashSprite.renderOrder = 12;

  // Fireball
  const fireUniforms = { uAge: { value: 0 }, uFade: { value: 1 } };
  const fireMat = new THREE.ShaderMaterial({
    uniforms: fireUniforms,
    vertexShader: FIREBALL_VERT,
    fragmentShader: FIREBALL_FRAG,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    fog: false,
  });
  const fireball = new THREE.Mesh(getFireballGeom(), fireMat);
  fireball.frustumCulled = false;
  fireball.renderOrder = 10;

  // Shockwave rings (main equatorial-ish ring + fainter tilted secondary)
  const extent = 6.5;
  const makeRing = (seed: number, thin: number, tiltX: number, tiltZ: number) => {
    const uniforms = {
      uExtent: { value: extent },
      uRingR: { value: 0 },
      uAge: { value: 0 },
      uFade: { value: 0 },
      uSeed: { value: seed },
      uThin: { value: thin },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const mesh = new THREE.Mesh(getRingGeom(), mat);
    mesh.scale.setScalar(extent * R);
    mesh.rotation.set(tiltX, 0, tiltZ);
    mesh.frustumCulled = false;
    mesh.renderOrder = 11;
    return { mesh, uniforms };
  };
  const ringA = makeRing(1.3, 1.0, 0.22, 0.08);
  const ringB = makeRing(7.9, 0.5, -0.5, 0.35);

  // Debris
  const debrisUniforms = {
    uAge: { value: 0 },
    uR: { value: R },
    uViewport: { value: new THREE.Vector2(1920, 1080) },
  };
  const debrisMat = new THREE.ShaderMaterial({
    uniforms: debrisUniforms,
    vertexShader: DEBRIS_VERT,
    fragmentShader: DEBRIS_FRAG,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    fog: false,
  });
  const debris = new THREE.Points(getDebrisGeom(), debrisMat);
  debris.frustumCulled = false;
  debris.renderOrder = 13;
  debris.onBeforeRender = (renderer) => {
    renderer.getDrawingBufferSize(debrisUniforms.uViewport.value);
  };

  group.add(fireball, ringA.mesh, ringB.mesh, debris, flashSprite);

  let t = 0;
  let done = false;
  let flash = 0;

  const ringRadius = (age: number, start: number, dur: number, maxR: number): number => {
    const a = Math.max(0, age - start);
    const k = 0.45;
    return (maxR * (1 - Math.exp(-a * k))) / (1 - Math.exp(-dur * k));
  };

  const apply = () => {
    // Screen flash: near-instant attack, quick decay, small secondary pulse when the ring launches.
    const f1 = t < 0.06 ? t / 0.06 : Math.exp(-(t - 0.06) * 3.2);
    const f2 = t > 0.25 ? 0.25 * Math.exp(-(t - 0.25) * 2.5) : 0;
    flash = THREE.MathUtils.clamp(f1 + f2, 0, 1);

    // Core flash sprite: blooms out to 4R in 0.4 s then fades.
    const fs = t < 0.4 ? 0.4 + (t / 0.4) * 3.6 : 4 + (t - 0.4) * 0.6;
    flashSprite.scale.setScalar(fs * R * 2);
    const fi = t < 0.4 ? 14 : 14 * Math.exp(-(t - 0.4) * 2.2);
    flashMat.color.setRGB(fi, fi * 0.95, fi * 0.85);
    flashSprite.visible = fi > 0.01;

    // Fireball: expand to 1.6R, fade 2-7 s.
    const fr = Math.max(0.08, 1.6 * (1 - Math.exp(-t * 1.5)));
    fireball.scale.setScalar(fr * R);
    fireUniforms.uAge.value = t;
    fireUniforms.uFade.value = (1 - THREE.MathUtils.smoothstep(t, 2, 7)) * THREE.MathUtils.smoothstep(t, 0, 0.12);
    fireball.visible = fireUniforms.uFade.value > 0.001;

    // Shockwave: 6R over ~8 s, fade 4-9.5 s.
    ringA.uniforms.uRingR.value = Math.min(6, ringRadius(t, 0.25, 8, 6));
    ringA.uniforms.uAge.value = t;
    ringA.uniforms.uFade.value = THREE.MathUtils.smoothstep(t, 0.25, 0.6) * (1 - THREE.MathUtils.smoothstep(t, 4, 9.5));
    ringB.uniforms.uRingR.value = Math.min(4.5, ringRadius(t, 0.5, 8, 4.5));
    ringB.uniforms.uAge.value = t;
    ringB.uniforms.uFade.value = 0.55 * THREE.MathUtils.smoothstep(t, 0.5, 0.9) * (1 - THREE.MathUtils.smoothstep(t, 3, 8));
    ringA.mesh.visible = ringA.uniforms.uFade.value > 0.001;
    ringB.mesh.visible = ringB.uniforms.uFade.value > 0.001;

    debrisUniforms.uAge.value = t;
  };
  apply();

  return {
    group,
    update(dt: number): void {
      if (done) return;
      t += dt;
      if (t >= EXPLOSION_DURATION) {
        done = true;
        flash = 0;
        group.visible = false;
        return;
      }
      apply();
    },
    get done(): boolean {
      return done;
    },
    get flash(): number {
      return flash;
    },
  };
}
