// Procedural image-based lighting for space: a small HDR equirect radiance map (deep space, faint
// nebulae, sun glow, and the sun-lit discs of Yavin / Yavin 4 / the Death Star), generated on the CPU
// once per level. three.js PMREM-filters it on first use, so hull materials get real roughness-aware
// reflections of the bodies around them at zero per-frame cost.
import * as THREE from 'three';

export interface EnvBody {
  /** Centre relative to the reflection origin (world origin). */
  center: THREE.Vector3;
  radius: number;
  /** Linear albedo of the two band colours (equal for unbanded bodies). */
  albedoA: THREE.Color;
  albedoB: THREE.Color;
  /** Number of latitude bands (0 = none). */
  bands: number;
}

export interface SpaceEnvOptions {
  sunDirection: THREE.Vector3;
  bodies: EnvBody[];
  seed?: number;
  width?: number;
}

const SUN_RADIANCE = new THREE.Color(1.0, 0.93, 0.82);

function hash3(x: number, y: number, z: number, s: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ Math.imul(s, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, z: number, s: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz, s);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v),
    l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  );
}

function fbm(x: number, y: number, z: number, s: number, octaves: number): number {
  let a = 0.5, f = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += a * valueNoise(x * f, y * f, z * f, s + i * 17);
    norm += a;
    a *= 0.5;
    f *= 2.07;
  }
  return sum / norm;
}

/** Build the HDR equirect radiance texture (EquirectangularReflectionMapping, half float). */
export function createSpaceEnvMap(opts: SpaceEnvOptions): THREE.DataTexture {
  const W = opts.width ?? 256;
  const H = W >> 1;
  const seed = opts.seed ?? 1977;
  const L = opts.sunDirection.clone().normalize();
  const data = new Uint16Array(W * H * 4);
  const toHalf = THREE.DataUtils.toHalfFloat;

  // Pre-normalised body data.
  const bodies = opts.bodies.map((b) => {
    const dist = b.center.length();
    return { ...b, dir: b.center.clone().divideScalar(dist), dist, r2: b.radius * b.radius };
  });

  const d = new THREE.Vector3();
  const n = new THREE.Vector3();
  const col = new THREE.Color();
  for (let j = 0; j < H; j++) {
    const lat = ((j + 0.5) / H - 0.5) * Math.PI;
    const cl = Math.cos(lat), sl = Math.sin(lat);
    for (let i = 0; i < W; i++) {
      const phi = ((i + 0.5) / W - 0.5) * Math.PI * 2;
      d.set(cl * Math.cos(phi), sl, cl * Math.sin(phi));

      // Deep space: near-black with a hint of blue, plus two faint nebula layers.
      const neb = fbm(d.x * 2.2 + 3.1, d.y * 2.2, d.z * 2.2 - 1.7, seed, 5);
      const neb2 = fbm(d.x * 3.7 - 5.3, d.y * 3.7 + 2.9, d.z * 3.7, seed + 101, 4);
      const cool = Math.max(0, neb - 0.48) * 0.11;
      const warm = Math.max(0, neb2 - 0.55) * 0.08;
      col.setRGB(0.0016 + cool * 0.45 + warm * 0.9, 0.0019 + cool * 0.6 + warm * 0.45, 0.0034 + cool * 1.0 + warm * 0.3);

      // Sun: soft forward-scatter glow only (the DirectionalLight provides the specular point).
      const sd = Math.max(0, d.dot(L));
      const glow = Math.pow(sd, 48) * 0.6 + Math.pow(sd, 6) * 0.025;
      col.r += glow * SUN_RADIANCE.r;
      col.g += glow * SUN_RADIANCE.g;
      col.b += glow * SUN_RADIANCE.b;

      // Bodies: nearest ray-sphere hit, Lambert-lit by the sun with a little cool ambient.
      let tBest = Infinity;
      let hit: (typeof bodies)[number] | null = null;
      for (const b of bodies) {
        const tc = d.dot(b.center);
        if (tc <= 0) continue;
        const d2 = b.dist * b.dist - tc * tc;
        if (d2 > b.r2) continue;
        const t = tc - Math.sqrt(b.r2 - d2);
        if (t < tBest) {
          tBest = t;
          hit = b;
        }
      }
      if (hit) {
        n.copy(d).multiplyScalar(tBest).sub(hit.center).divideScalar(hit.radius);
        const nl = Math.max(0, n.dot(L));
        // Soft terminator so the PMREM blur doesn't ring.
        const lit = nl * 0.92 + Math.pow(Math.max(0, n.dot(L) + 0.08), 2) * 0.08;
        let k = 0;
        if (hit.bands > 0) {
          const bandN = fbm(n.y * hit.bands, n.x * 0.6, n.z * 0.6, seed + 7, 3);
          k = THREE.MathUtils.smoothstep(bandN, 0.42, 0.62);
        }
        const ar = hit.albedoA.r + (hit.albedoB.r - hit.albedoA.r) * k;
        const ag = hit.albedoA.g + (hit.albedoB.g - hit.albedoA.g) * k;
        const ab = hit.albedoA.b + (hit.albedoB.b - hit.albedoA.b) * k;
        const e = lit * 1.7;
        col.setRGB(ar * (e * SUN_RADIANCE.r + 0.012), ag * (e * SUN_RADIANCE.g + 0.014), ab * (e * SUN_RADIANCE.b + 0.02));
      }

      const o = (j * W + i) * 4;
      data[o] = toHalf(col.r);
      data[o + 1] = toHalf(col.g);
      data[o + 2] = toHalf(col.b);
      data[o + 3] = toHalf(1);
    }
  }

  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.wrapS = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  tex.name = 'ProceduralSpaceEnv';
  return tex;
}
