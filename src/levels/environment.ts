// Shared space backdrop + lighting rig for every level.
import * as THREE from 'three';
import {
  SUN_DIRECTION,
  YAVIN_PALETTE,
  createDeathStarSphere,
  createGasGiant,
  createMoonYavin4,
  createStarfield,
  createSun,
  updateCelestial,
  type DeathStarSphere,
} from '../world/celestial';
import { PLANET_ENV_ALBEDO, createPlanet, type PlanetStyle } from '../world/planets';
import { createSpaceEnvMap, type EnvBody } from '../render/spaceEnvMap';

export const DEATH_STAR_RADIUS = 80000; // DS-I ≈ 160 km diameter

export interface Environment {
  sunLight: THREE.DirectionalLight;
  deathStar: DeathStarSphere | null;
  /** Backdrop planets: [Yavin, Yavin 4] by default, or the arena's bodies (index 0 = primary). */
  bodies: THREE.Mesh[];
  /** Per-frame: keep sky at infinity, follow the focus with the shadow frustum. */
  update(dt: number, camera: THREE.Camera, focus: THREE.Vector3): void;
}

export interface ArenaBody {
  style: PlanetStyle;
  /** Radius (m). */
  radius: number;
  /** Centre relative to world origin (m); keep it well clear of the ~3 km battle space. */
  pos: THREE.Vector3;
  seed?: number;
}

/** Skirmish backdrop replacing Yavin and Yavin 4. */
export interface ArenaSky {
  /** The planet the battle orbits: large and below/ahead of the fight. */
  primary: ArenaBody;
  /** Companion bodies (parent gas giant, moons). */
  others?: readonly ArenaBody[];
  /** Add a second, smaller and oranger sun beside the main one (Tatooine). */
  twinSun?: boolean;
}

export interface EnvOptions {
  /** Death Star centre in world space (null = no sphere). */
  deathStarCenter: THREE.Vector3 | null;
  /** Rotate the station so the dish faces this direction (world). */
  dishFacing?: THREE.Vector3;
  shadows: boolean;
  shadowExtent?: number;
  /** Positions of Yavin and Yavin 4 relative to world origin (ignored with `sky`). */
  yavinPos?: THREE.Vector3;
  yavin4Pos?: THREE.Vector3;
  /** Arena backdrop shown instead of Yavin and Yavin 4. */
  sky?: ArenaSky;
  ambient?: number;
  /** Camera-aligned fill light intensity (higher in open space). */
  viewFill?: number;
}

/** Direction of Tatooine's second sun: a few degrees off the main one. */
const TWIN_SUN_DIRECTION = SUN_DIRECTION.clone().add(new THREE.Vector3(0.09, -0.06, -0.03)).normalize();

export function buildEnvironment(scene: THREE.Scene, opts: EnvOptions): Environment {
  scene.background = new THREE.Color(0x000000);
  const stars = createStarfield(1977);
  const sun = createSun();
  scene.add(stars, sun);
  const twinSun = opts.sky?.twinSun
    ? createSun({
        direction: TWIN_SUN_DIRECTION,
        size: 0.75,
        glowColor: new THREE.Color(2.0, 0.85, 0.3),
        discColor: new THREE.Color(3.2, 1.6, 0.6),
      })
    : null;
  if (twinSun) scene.add(twinSun);

  const bodies: THREE.Mesh[] = [];
  // Image-based lighting: a procedural radiance map of this level's sky (bodies placed where they
  // really are), generated once and PMREM-filtered by three on first use.
  const envBodies: EnvBody[] = [];
  if (opts.sky) {
    for (const b of [opts.sky.primary, ...(opts.sky.others ?? [])]) {
      const mesh = createPlanet(b.radius, b.style, b.seed);
      mesh.position.copy(b.pos);
      // Show the battle the equatorial belt (not a pole), with a slight axial tilt.
      mesh.lookAt(0, 0, 0);
      mesh.rotateZ(0.4);
      scene.add(mesh);
      bodies.push(mesh);
      const albedo = PLANET_ENV_ALBEDO[b.style];
      envBodies.push({ center: mesh.position, radius: b.radius, albedoA: albedo.a, albedoB: albedo.b, bands: albedo.bands });
    }
  } else {
    const yavinRadius = 7e7;
    const yavin4Radius = 5e6;
    const yavin = createGasGiant(yavinRadius, YAVIN_PALETTE);
    yavin.position.copy(opts.yavinPos ?? new THREE.Vector3(-1.6e8, -0.3e8, 2.4e8));
    const yavin4 = createMoonYavin4(yavin4Radius);
    yavin4.position.copy(opts.yavin4Pos ?? new THREE.Vector3(1.2e7, -0.4e7, 3.2e7));
    scene.add(yavin, yavin4);
    bodies.push(yavin, yavin4);
    envBodies.push(
      { center: yavin.position, radius: yavinRadius, albedoA: new THREE.Color(0.62, 0.3, 0.1), albedoB: new THREE.Color(0.36, 0.13, 0.04), bands: 9 },
      { center: yavin4.position, radius: yavin4Radius, albedoA: new THREE.Color(0.12, 0.2, 0.1), albedoB: new THREE.Color(0.22, 0.26, 0.3), bands: 2 },
    );
  }

  let deathStar: DeathStarSphere | null = null;
  if (opts.deathStarCenter) {
    deathStar = createDeathStarSphere(DEATH_STAR_RADIUS);
    deathStar.mesh.position.copy(opts.deathStarCenter);
    if (opts.dishFacing) {
      // The dish looks down local -Z (30° north). lookAt points +Z, so look away from the facing direction.
      deathStar.mesh.lookAt(deathStar.mesh.position.clone().sub(opts.dishFacing));
    }
    scene.add(deathStar.mesh);
  }

  // Shadowed levels fly over the station: the trench passes no sphere, but sits on the plane y = 0.
  const dsCenter = opts.deathStarCenter ?? (opts.shadows ? new THREE.Vector3(0, -DEATH_STAR_RADIUS, 0) : null);
  if (dsCenter) {
    // Effective albedo, darker than the plating itself: the city of greebles shadows most of it.
    const grey = new THREE.Color(0.15, 0.155, 0.165);
    envBodies.push({ center: dsCenter, radius: DEATH_STAR_RADIUS, albedoA: grey, albedoB: grey, bands: 0 });
  }
  scene.environment = createSpaceEnvMap({ sunDirection: SUN_DIRECTION, bodies: envBodies });
  scene.environmentIntensity = 2.0;

  const sunLight = new THREE.DirectionalLight(0xfff1dc, 3.2);
  sunLight.position.copy(SUN_DIRECTION).multiplyScalar(1000);
  scene.add(sunLight, sunLight.target);
  const ext = opts.shadowExtent ?? 260;
  if (opts.shadows) {
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(2048, 2048);
    const sc = sunLight.shadow.camera;
    sc.left = -ext;
    sc.right = ext;
    sc.top = ext;
    sc.bottom = -ext;
    sc.near = 10;
    sc.far = 3000;
    sunLight.shadow.bias = -0.0004;
    sunLight.shadow.normalBias = 0.6;
    // PCF in three r18x uses a Vogel-disk kernel: the radius widens the penumbra at no extra cost.
    sunLight.shadow.radius = 2.5;
  }
  // Fill: cool bounce from space + warm reflected Yavin light from below. Kept low: the IBL above
  // now supplies directional ambient (Death Star / Yavin bounce) instead of a flat wash.
  scene.add(new THREE.HemisphereLight(0x5a6c8a, 0x3a2a1c, (opts.ambient ?? 0.55) * 0.6));
  // Viewer fill ("key light from the camera"): keeps black TIE panels and shadowed hulls readable
  // against black space, the same trick space-combat games use for silhouette legibility.
  const viewFill = new THREE.DirectionalLight(0xbfd2ff, opts.viewFill ?? 0.35);
  scene.add(viewFill, viewFill.target);

  return {
    sunLight,
    deathStar,
    bodies,
    update(dt, camera, focus) {
      stars.position.copy(camera.position);
      sun.position.copy(camera.position);
      twinSun?.position.copy(camera.position);
      updateCelestial(dt);
      deathStar?.update(dt);
      // Texel-snapped shadow frustum around the focus to avoid shimmering.
      const step = (ext * 2) / 2048;
      const fx = Math.round(focus.x / step) * step;
      const fy = Math.round(focus.y / step) * step;
      const fz = Math.round(focus.z / step) * step;
      sunLight.target.position.set(fx, fy, fz);
      sunLight.position.set(fx, fy, fz).addScaledVector(SUN_DIRECTION, 1500);
      viewFill.position.copy(camera.position);
      camera.getWorldDirection(viewFill.target.position).add(camera.position);
    },
  };
}
