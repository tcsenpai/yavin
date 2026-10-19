// Procedural planets for the skirmish arenas: one object-space-lit shader with a surface branch per
// style (selected by a define), sharing clouds, ocean glint, night lights and the fresnel rim.
import * as THREE from 'three';
import {
  BODY_VERT,
  FRAG_HEAD,
  FRAG_TAIL,
  GLSL_NOISE,
  createGasGiant,
  makeHalo,
  sunDirUniform,
  timeUniform,
  type GasGiantPalette,
} from './celestial';

export type PlanetStyle =
  | 'desert'
  | 'swampTemperate'
  | 'temperate'
  | 'ecumenopolis'
  | 'ice'
  | 'forest'
  | 'barren'
  | 'gasGiant';

const PLANET_FRAG = /* glsl */ `
${FRAG_HEAD}
${GLSL_NOISE}
uniform float uTime;
uniform float uSunIntensity;
uniform float uSeed;
uniform float uRadius;
uniform vec3 uAtm;
uniform float uAtmStrength;
uniform float uHaze;
uniform vec3 uTerm;
uniform float uCloudBias;
uniform float uCloudMax;
uniform float uCloudWarp;
uniform vec3 uCloudCol;
varying vec3 vObjPos;
varying vec3 vViewObj;
varying vec3 vSunObj;

// 1 while a pattern of 'freq' cycles per unit sphere is well above pixel size, 0 once it would alias.
float detail(float freq, float px) { return 1.0 - smoothstep(0.12, 0.45, freq * px); }

float ridge(vec3 p) { float r = 1.0 - abs(snoise(p)); return r * r; }

vec3 h33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

// Bowl craters on a 3D cell lattice: x = floor darkening, y = rim brightening.
vec2 craters(vec3 p) {
  vec3 i = floor(p);
  vec2 acc = vec2(0.0);
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec3 c = i + vec3(float(x), float(y), float(z));
    vec3 h = h33(c);
    float r = 0.18 + 0.3 * h.x * h.x;
    float d = length(p - c - h) / r;
    acc.x = max(acc.x, 1.0 - smoothstep(0.6, 1.0, d));
    acc.y = max(acc.y, 1.0 - smoothstep(0.0, 0.25, abs(d - 1.0)));
  }
  return acc;
}

void main() {
  vec3 n = normalize(vObjPos);
  vec3 V = normalize(vViewObj);
  vec3 L = normalize(vSunObj);
  float ndl = dot(n, L);
  // Size of one pixel on the unit sphere (grazing angles included).
  float px = length(fwidth(vObjPos)) / uRadius;
  vec3 sp = n + vec3(uSeed * 1.37, uSeed * 2.11, uSeed * 0.73);
  float lat = abs(n.y);

  vec3 albedo = vec3(0.5);
  float water = 0.0;
  vec3 night = vec3(0.0);

#if defined(STYLE_DESERT)
  float c = fbm(sp * 1.6, 5);
  float d2 = fbm(sp * 5.0 + 2.0, 4);
  // Dune seas: long wind-aligned ripples bent by large-scale flow.
  float flow = fbm(sp * 2.4 + 6.0, 3);
  vec3 wind = normalize(vec3(1.0, 0.25 * sin(n.y * 3.0 + c * 2.0), 0.55));
  float dunes = mix(0.5, 0.5 + 0.5 * sin(dot(n, wind) * 230.0 + flow * 14.0 + c * 18.0), detail(37.0, px));
  float erg = smoothstep(0.0, 0.3, c);
  vec3 plain = mix(vec3(0.48, 0.32, 0.18), vec3(0.62, 0.45, 0.27), d2 * 0.5 + 0.5);
  vec3 sand = mix(vec3(0.70, 0.48, 0.26), vec3(0.84, 0.63, 0.37), d2 * 0.5 + 0.5) * (0.84 + 0.22 * dunes);
  albedo = mix(plain, sand, erg);
  // Rocky badlands: mesas and canyons along ridged noise.
  float badl = smoothstep(0.0, 0.2, fbm(sp * 2.2 + 11.0, 5));
  float rr = ridge(sp * 7.0 + d2) * 0.6 + ridge(sp * 18.0 + 3.0) * 0.4 * detail(18.0, px);
  vec3 rock = mix(vec3(0.24, 0.13, 0.07), vec3(0.55, 0.36, 0.21), rr);
  albedo = mix(albedo, rock, badl * (1.0 - erg * 0.7));
  // Pale salt pans in the basins.
  float salt = smoothstep(0.32, 0.42, fbm(sp * 3.0 + 5.0, 4)) * (1.0 - badl);
  albedo = mix(albedo, vec3(0.74, 0.62, 0.46), salt * 0.4);
  albedo *= 0.9 + 0.2 * fbm(sp * 22.0, 3) * detail(22.0, px);
#elif defined(STYLE_SWAMP)
  float c = fbm(sp * 1.5, 6);
  float c2 = fbm(sp * 6.0 + 1.7, 4);
  float h = c + c2 * 0.2 + 0.1;
  float land = smoothstep(0.0, 0.02, h);
  // Inland lakes and meandering wetlands.
  float lk = fbm(sp * 4.5 + 7.0, 4);
  float lake = smoothstep(0.28, 0.31, lk) * smoothstep(0.04, 0.12, h);
  float wet = fbm(sp * 3.0 + 13.0, 4) + max(lk, 0.0) * 0.8;
  vec3 plains = mix(vec3(0.05, 0.15, 0.025), vec3(0.13, 0.22, 0.05), c2 * 0.5 + 0.5);
  vec3 lc = mix(plains, vec3(0.04, 0.12, 0.07), smoothstep(0.1, 0.35, wet));
  lc = mix(lc, vec3(0.30, 0.31, 0.22), smoothstep(0.5, 0.75, h + c2 * 0.2));
  lc *= 0.85 + 0.3 * (fbm(sp * 16.0, 3) * 0.5 + 0.5) * detail(16.0, px) + 0.15 * (1.0 - detail(16.0, px));
  lc = mix(lc, vec3(0.75, 0.8, 0.85), smoothstep(0.9, 0.96, lat + c2 * 0.05));
  vec3 ocean = mix(vec3(0.008, 0.05, 0.16), vec3(0.03, 0.20, 0.30), smoothstep(-0.12, 0.0, h));
  albedo = mix(ocean, lc, land);
  albedo = mix(albedo, vec3(0.02, 0.12, 0.22), lake);
  water = max(1.0 - land, lake);
#elif defined(STYLE_TEMPERATE)
  float c = fbm(sp * 1.4, 6);
  float c2 = fbm(sp * 5.5 + 1.7, 4);
  float h = c + c2 * 0.25 - 0.06;
  float land = smoothstep(0.0, 0.015, h);
  // Mountain ranges along ridged noise, snow-capped.
  float rr = ridge(sp * 2.6 + c2 * 0.6) * 0.75 + ridge(sp * 8.0 + 4.0) * 0.35;
  float mount = smoothstep(0.4, 0.9, rr) * smoothstep(0.02, 0.2, h);
  float dry = smoothstep(0.05, 0.4, fbm(sp * 2.5 + 9.0, 4) + (0.3 - abs(lat - 0.3)) * 0.7);
  vec3 green = mix(vec3(0.04, 0.13, 0.03), vec3(0.15, 0.23, 0.07), c2 * 0.5 + 0.5);
  vec3 lc = mix(green, vec3(0.38, 0.30, 0.17), dry * 0.85);
  lc = mix(lc, vec3(0.28, 0.25, 0.22), mount);
  float snow = smoothstep(0.7, 1.0, mount + lat * 0.35 + c2 * 0.15) * (0.55 + 0.45 * smoothstep(-0.2, 0.3, fbm(sp * 20.0, 3)));
  lc = mix(lc, vec3(0.86, 0.88, 0.92), snow);
  lc *= 0.88 + 0.24 * (fbm(sp * 18.0, 3) * 0.5 + 0.5) * detail(18.0, px) + 0.12 * (1.0 - detail(18.0, px));
  float polar = smoothstep(0.82, 0.9, lat + c2 * 0.08);
  vec3 ocean = mix(vec3(0.004, 0.02, 0.09), vec3(0.02, 0.10, 0.20), smoothstep(-0.14, 0.0, h));
  albedo = mix(mix(ocean, lc, land), vec3(0.88, 0.9, 0.94), polar);
  water = (1.0 - land) * (1.0 - polar);
#elif defined(STYLE_CITY)
  // Cube-face grid: even blocks without pole pinching.
  vec3 an = abs(n);
  vec2 uv;
  float face;
  if (an.x >= an.y && an.x >= an.z) { uv = n.yz / an.x; face = n.x > 0.0 ? 0.0 : 1.0; }
  else if (an.y >= an.z) { uv = n.xz / an.y; face = n.y > 0.0 ? 2.0 : 3.0; }
  else { uv = n.xy / an.z; face = n.z > 0.0 ? 4.0 : 5.0; }
  // Gentle warp so avenues bend between districts instead of ruling the whole face.
  uv += vec2(fbm(sp * 4.0, 3), fbm(sp * 4.0 + 9.0, 3)) * 0.012;
  float dist = fbm(sp * 2.5, 5) * 0.5 + 0.5;
  vec3 base = mix(vec3(0.33, 0.32, 0.31), vec3(0.46, 0.37, 0.25), smoothstep(0.35, 0.7, dist));
  base = mix(base, vec3(0.19, 0.19, 0.21), smoothstep(0.55, 0.75, fbm(sp * 6.0 + 3.0, 3) * 0.5 + 0.5) * 0.6);
  base *= 0.8 + 0.4 * (fbm(sp * 14.0, 4) * 0.5 + 0.5);
  float density = smoothstep(0.2, 0.8, fbm(sp * 3.2 + 21.0, 5) * 0.5 + 0.5 + 0.15);
  // Light clusters: dense cores, darker gaps.
  float lightMask = density * (0.25 + 0.75 * smoothstep(0.35, 0.65, fbm(sp * 10.0 + 4.0, 4) * 0.5 + 0.5));
  // Megahighways: sparse straight segments on two coarse grids, each edge segment lit at random.
  float art = 0.0;
  float hf = 10.0;
  for (int k = 0; k < 2; k++) {
    vec2 g = uv * hf;
    vec2 cell = floor(g);
    vec2 fr = fract(g);
    vec2 ed = min(fr, 1.0 - fr);
    float fw = hf * px * 1.5;
    float sx = step(0.5, h12(vec2(floor(g.x + 0.5), cell.y) + face * 7.1 + hf));
    float sy = step(0.5, h12(vec2(cell.x, floor(g.y + 0.5)) + face * 3.3 + hf * 2.0));
    float lx = (1.0 - smoothstep(0.012, 0.012 + fw, ed.x)) * sx;
    float ly = (1.0 - smoothstep(0.012, 0.012 + fw, ed.y)) * sy;
    art += max(lx, ly) * detail(hf, px) * (1.0 - float(k) * 0.4);
    hf *= 3.5;
  }
  // City blocks: three grid tiers, each filtered against the pixel footprint and replaced by its
  // mean once it would alias.
  float glow = 0.0;
  float shade = 1.0;
  float f = 160.0;
  for (int k = 0; k < 3; k++) {
    vec2 g = uv * f;
    vec2 fr = fract(g);
    vec2 cell = floor(g);
    float e = min(min(fr.x, 1.0 - fr.x), min(fr.y, 1.0 - fr.y));
    float fw = f * px * 1.5;
    float line = 1.0 - smoothstep(0.04, 0.04 + fw, e);
    float hc = h12(cell + face * 53.7 + float(k) * 17.3);
    float fade = detail(f, px);
    float p = density * 0.6;
    float on = step(1.0 - p, hc) * (0.4 + 0.6 * h12(cell.yx + float(k) * 3.1));
    glow += mix(0.1 + p * 0.35, line * 0.6 + on * 0.5, fade) * (0.45 - float(k) * 0.1);
    shade *= mix(1.0, (0.85 + 0.3 * hc) * (1.0 - line * 0.12), fade);
    f *= 4.0;
  }
  albedo = base * shade * (1.0 - art * 0.08);
  night = vec3(1.0, 0.55, 0.22) * (glow * lightMask * 1.7 + art * (0.3 + 0.7 * lightMask) * 0.6);
#elif defined(STYLE_ICE)
  float c = fbm(sp * 1.8, 6);
  float c2 = fbm(sp * 6.0 + 2.0, 4);
  albedo = mix(vec3(0.60, 0.72, 0.84), vec3(0.88, 0.91, 0.95), smoothstep(-0.25, 0.25, c + c2 * 0.3));
  albedo = mix(albedo, vec3(0.42, 0.57, 0.75), smoothstep(0.2, 0.5, -c) * 0.55);
  // Crevasse fields: thin pixel-filtered lines along warped noise zero crossings.
  vec3 wq = sp * 5.0 + vec3(fbm(sp * 3.0, 3), fbm(sp * 3.0 + 4.0, 3), 0.0) * 0.35;
  float cv = abs(snoise(wq));
  float crev = (1.0 - smoothstep(0.0, 0.012 + fwidth(cv) * 1.5, cv)) * detail(8.0, px) * 0.5;
  float cv2 = abs(snoise(sp * 15.0 + 9.0));
  crev = max(crev, (1.0 - smoothstep(0.0, 0.015 + fwidth(cv2) * 1.5, cv2)) * detail(24.0, px) * 0.6);
  crev *= smoothstep(-0.2, 0.2, c2);
  albedo = mix(albedo, vec3(0.32, 0.46, 0.64), crev * 0.45);
  // Sparse dark rock outcrops (nunataks).
  float rk = fbm(sp * 7.0 + 9.0, 5) + c * 0.2;
  albedo = mix(albedo, vec3(0.36, 0.40, 0.46), smoothstep(0.45, 0.5, rk) * 0.4);
  water = 0.12;
#elif defined(STYLE_FOREST)
  float c = fbm(sp * 1.7, 6);
  float c2 = fbm(sp * 6.5 + 1.7, 4);
  float h = c + c2 * 0.2;
  vec3 forest = mix(vec3(0.018, 0.065, 0.02), vec3(0.045, 0.12, 0.04), c2 * 0.5 + 0.5);
  forest *= 0.8 + 0.4 * (fbm(sp * 20.0, 3) * 0.5 + 0.5) * detail(20.0, px) + 0.2 * (1.0 - detail(20.0, px));
  float mount = smoothstep(0.55, 0.85, ridge(sp * 3.0 + c2 * 0.5)) * smoothstep(0.0, 0.3, h);
  vec3 lc = mix(forest, vec3(0.16, 0.17, 0.12), mount * 0.8);
  lc = mix(lc, vec3(0.08, 0.13, 0.05), smoothstep(0.2, 0.5, fbm(sp * 4.0 + 17.0, 4)) * 0.5);
  float lake = max(smoothstep(0.36, 0.39, fbm(sp * 5.0 + 3.0, 4)), 1.0 - smoothstep(-0.40, -0.36, h));
  albedo = mix(lc, vec3(0.008, 0.03, 0.05), lake);
  water = lake;
#else
  // Barren: mottled regolith, dark maria, craters.
  float c = fbm(sp * 2.0, 5);
  albedo = mix(vec3(0.20, 0.19, 0.18), vec3(0.44, 0.43, 0.41), c * 0.5 + 0.5);
  albedo *= 1.0 - 0.35 * smoothstep(0.1, 0.3, fbm(sp * 1.2 + 4.0, 3));
  vec2 cr = craters(sp * 5.0) * detail(5.0, px);
  vec2 cr2 = craters(sp * 13.0 + 7.0) * detail(13.0, px);
  albedo *= (1.0 - cr.x * 0.3) * (1.0 + cr.y * 0.35) * (1.0 - cr2.x * 0.2) * (1.0 + cr2.y * 0.25);
#endif

  float clouds = 0.0;
  if (uCloudMax > 0.0) {
    float ca = cos(uTime * 0.003), sa = sin(uTime * 0.003);
    vec3 pc = vec3(ca * n.x - sa * n.z, n.y, sa * n.x + ca * n.z) + vec3(uSeed * 0.71, uSeed * 1.9, 0.0);
    vec3 cw = vec3(fbm(pc * 2.0 + 3.0, 3), fbm(pc * 2.0 + 7.0, 3), fbm(pc * 2.0 + 11.0, 2));
    float cl = fbm(pc * vec3(2.5, 3.4, 2.5) + cw * uCloudWarp + vec3(0.0, 0.0, uTime * 0.0015), 6);
    // Fine breakup keeps edges wispy instead of blobby.
    float fineC = fbm(pc * 16.0 + cw * 2.0, 3) * detail(32.0, px);
    clouds = smoothstep(0.0, 0.45, cl + fineC * 0.15 + uCloudBias + 0.05 * sin(n.y * 12.0)) * uCloudMax;
  }

  float diff = clamp(ndl, 0.0, 1.0);
  vec3 H = normalize(L + V);
  float nh = max(dot(n, H), 0.0);
  float spec = (pow(nh, 600.0) * 1.2 + pow(nh, 40.0) * 0.05) * water * (1.0 - clouds) * smoothstep(0.0, 0.1, ndl);

  vec3 surf = mix(albedo * (1.0 - clouds * 0.35), uCloudCol, clouds);
  vec3 col = surf * diff * uSunIntensity + vec3(1.0, 0.95, 0.85) * spec * uSunIntensity;
  // City lights fade in past the terminator, dimmed under cloud.
  col += night * (1.0 - smoothstep(-0.14, 0.06, ndl)) * (1.0 - clouds * 0.75);

  float nv = max(dot(n, V), 0.0);
  float fres = pow(1.0 - nv, 2.6);
  float atmLit = clamp(ndl * 1.3 + 0.25, 0.0, 1.0);
  vec3 hazeCol = uAtm / max(max(max(uAtm.r, uAtm.g), uAtm.b), 1e-4);
  col = mix(col, col * (0.55 + 0.5 * hazeCol) + hazeCol * 0.1 * diff, uHaze * (1.0 - nv));
  col += uAtm * fres * atmLit * uAtmStrength;
  // Reddened scattering in a narrow band at the lit edge of the terminator
  col += uTerm * fres * smoothstep(-0.1, 0.02, ndl) * (1.0 - smoothstep(0.02, 0.25, ndl));
  gl_FragColor = vec4(col, 1.0);
${FRAG_TAIL}
}
`;

interface RockyLook {
  define: string;
  sunIntensity: number;
  atm: THREE.Color;
  atmStrength: number;
  haze: number;
  term: THREE.Color;
  cloudBias: number;
  cloudMax: number;
  cloudWarp: number;
  cloudCol: THREE.Color;
  /** Halo: shell ratio, colour, intensity (intensity 0 = airless, no halo). */
  halo: readonly [number, THREE.Color, number];
}

const ROCKY: Record<Exclude<PlanetStyle, 'gasGiant'>, RockyLook> = {
  desert: {
    define: 'STYLE_DESERT',
    sunIntensity: 1.4,
    atm: new THREE.Color(0.9, 0.62, 0.36),
    atmStrength: 0.45,
    haze: 0.18,
    term: new THREE.Color(0.3, 0.14, 0.05),
    cloudBias: -0.22,
    cloudMax: 0.25,
    cloudWarp: 1.2,
    cloudCol: new THREE.Color(0.9, 0.84, 0.76),
    halo: [1.02, new THREE.Color(1.0, 0.7, 0.42), 0.55],
  },
  swampTemperate: {
    define: 'STYLE_SWAMP',
    sunIntensity: 1.8,
    atm: new THREE.Color(0.3, 0.6, 1.0),
    atmStrength: 1.5,
    haze: 0.4,
    term: new THREE.Color(0.25, 0.12, 0.05),
    cloudBias: 0.0,
    cloudMax: 1.0,
    cloudWarp: 1.4,
    cloudCol: new THREE.Color(0.86, 0.88, 0.9),
    halo: [1.03, new THREE.Color(0.35, 0.62, 1.0), 1.6],
  },
  temperate: {
    define: 'STYLE_TEMPERATE',
    sunIntensity: 1.8,
    atm: new THREE.Color(0.25, 0.5, 1.0),
    atmStrength: 1.3,
    haze: 0.38,
    term: new THREE.Color(0.25, 0.12, 0.05),
    cloudBias: 0.1,
    cloudMax: 1.0,
    cloudWarp: 1.8,
    cloudCol: new THREE.Color(0.88, 0.9, 0.92),
    halo: [1.03, new THREE.Color(0.32, 0.58, 1.0), 1.5],
  },
  ecumenopolis: {
    define: 'STYLE_CITY',
    sunIntensity: 1.7,
    atm: new THREE.Color(0.75, 0.68, 0.55),
    atmStrength: 0.7,
    haze: 0.32,
    term: new THREE.Color(0.3, 0.15, 0.06),
    cloudBias: -0.2,
    cloudMax: 0.45,
    cloudWarp: 1.2,
    cloudCol: new THREE.Color(0.7, 0.68, 0.64),
    halo: [1.025, new THREE.Color(0.85, 0.72, 0.55), 0.8],
  },
  ice: {
    define: 'STYLE_ICE',
    sunIntensity: 1.15,
    atm: new THREE.Color(0.45, 0.78, 1.0),
    atmStrength: 0.9,
    haze: 0.3,
    term: new THREE.Color(0.18, 0.12, 0.1),
    cloudBias: -0.12,
    cloudMax: 0.55,
    cloudWarp: 1.2,
    cloudCol: new THREE.Color(0.9, 0.93, 0.96),
    halo: [1.025, new THREE.Color(0.55, 0.85, 1.0), 1.1],
  },
  forest: {
    define: 'STYLE_FOREST',
    sunIntensity: 1.8,
    atm: new THREE.Color(0.3, 0.58, 1.0),
    atmStrength: 1.3,
    haze: 0.25,
    term: new THREE.Color(0.25, 0.12, 0.05),
    cloudBias: 0.0,
    cloudMax: 0.9,
    cloudWarp: 1.5,
    cloudCol: new THREE.Color(0.84, 0.86, 0.88),
    halo: [1.03, new THREE.Color(0.35, 0.6, 1.0), 1.4],
  },
  barren: {
    define: 'STYLE_BARREN',
    sunIntensity: 1.6,
    atm: new THREE.Color(0, 0, 0),
    atmStrength: 0,
    haze: 0,
    term: new THREE.Color(0, 0, 0),
    cloudBias: 0,
    cloudMax: 0,
    cloudWarp: 0,
    cloudCol: new THREE.Color(0, 0, 0),
    halo: [1, new THREE.Color(0, 0, 0), 0],
  },
};

/** Endor: the pale blue-grey gas giant the forest moon orbits. */
const ENDOR_PALETTE: GasGiantPalette = {
  name: 'Endor',
  bands: [
    new THREE.Color(0.26, 0.34, 0.42),
    new THREE.Color(0.50, 0.59, 0.66),
    new THREE.Color(0.20, 0.27, 0.35),
    new THREE.Color(0.70, 0.77, 0.82),
  ],
  storm: [new THREE.Color(0.30, 0.40, 0.48), new THREE.Color(0.80, 0.86, 0.90)],
  stormStrength: 0.6,
  terminator: new THREE.Color(0.85, 0.55, 0.4),
  atmosphere: new THREE.Color(0.55, 0.75, 1.0),
  halo: new THREE.Color(0.6, 0.78, 1.0),
  haloIntensity: 1.0,
  sunIntensity: 1.4,
};

/** Effective albedo per style for the IBL radiance map (two band colours + band count). */
export const PLANET_ENV_ALBEDO: Record<PlanetStyle, { a: THREE.Color; b: THREE.Color; bands: number }> = {
  desert: { a: new THREE.Color(0.66, 0.47, 0.27), b: new THREE.Color(0.5, 0.34, 0.19), bands: 0 },
  swampTemperate: { a: new THREE.Color(0.14, 0.26, 0.12), b: new THREE.Color(0.3, 0.38, 0.45), bands: 2 },
  temperate: { a: new THREE.Color(0.1, 0.16, 0.24), b: new THREE.Color(0.45, 0.48, 0.52), bands: 2 },
  ecumenopolis: { a: new THREE.Color(0.32, 0.3, 0.27), b: new THREE.Color(0.38, 0.33, 0.26), bands: 0 },
  ice: { a: new THREE.Color(0.78, 0.84, 0.9), b: new THREE.Color(0.6, 0.72, 0.84), bands: 0 },
  forest: { a: new THREE.Color(0.06, 0.12, 0.06), b: new THREE.Color(0.3, 0.33, 0.36), bands: 2 },
  barren: { a: new THREE.Color(0.3, 0.29, 0.28), b: new THREE.Color(0.22, 0.21, 0.2), bands: 0 },
  gasGiant: { a: new THREE.Color(0.6, 0.67, 0.72), b: new THREE.Color(0.36, 0.44, 0.5), bands: 9 },
};

/** Procedural planet of the given style (radius in metres), with an atmosphere halo child when it has air. */
export function createPlanet(radius: number, style: PlanetStyle, seed = 0): THREE.Mesh {
  if (style === 'gasGiant') return createGasGiant(radius, ENDOR_PALETTE);
  const look = ROCKY[style];
  const mat = new THREE.ShaderMaterial({
    defines: { [look.define]: '' },
    uniforms: {
      uSunDir: sunDirUniform,
      uTime: timeUniform,
      uSunIntensity: { value: look.sunIntensity },
      uSeed: { value: seed },
      uRadius: { value: radius },
      uAtm: { value: look.atm },
      uAtmStrength: { value: look.atmStrength },
      uHaze: { value: look.haze },
      uTerm: { value: look.term },
      uCloudBias: { value: look.cloudBias },
      uCloudMax: { value: look.cloudMax },
      uCloudWarp: { value: look.cloudWarp },
      uCloudCol: { value: look.cloudCol },
    },
    vertexShader: BODY_VERT,
    fragmentShader: PLANET_FRAG,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 160, 80), mat);
  mesh.name = `Planet:${style}`;
  const [ratio, color, intensity] = look.halo;
  if (intensity > 0) mesh.add(makeHalo(radius, ratio, color, intensity));
  return mesh;
}
