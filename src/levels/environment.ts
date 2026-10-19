// Shared space backdrop + lighting rig for every level.
import * as THREE from 'three';
import {
  SUN_DIRECTION,
  createDeathStarSphere,
  createGasGiantYavin,
  createMoonYavin4,
  createStarfield,
  createSun,
  updateCelestial,
  type DeathStarSphere,
} from '../world/celestial';
import { createSpaceEnvMap } from '../render/spaceEnvMap';

export const DEATH_STAR_RADIUS = 80000; // DS-I ≈ 160 km diameter

export interface Environment {
  sunLight: THREE.DirectionalLight;
  deathStar: DeathStarSphere | null;
  yavin: THREE.Mesh;
  yavin4: THREE.Mesh;
  /** Per-frame: keep sky at infinity, follow the focus with the shadow frustum. */
  update(dt: number, camera: THREE.Camera, focus: THREE.Vector3): void;
}

export interface EnvOptions {
  /** Death Star centre in world space (null = no sphere). */
  deathStarCenter: THREE.Vector3 | null;
  /** Rotate the station so the dish faces this direction (world). */
  dishFacing?: THREE.Vector3;
  shadows: boolean;
  shadowExtent?: number;
  /** Positions of Yavin and Yavin 4 relative to world origin. */
  yavinPos?: THREE.Vector3;
  yavin4Pos?: THREE.Vector3;
  ambient?: number;
  /** Camera-aligned fill light intensity (higher in open space). */
  viewFill?: number;
}

export function buildEnvironment(scene: THREE.Scene, opts: EnvOptions): Environment {
  scene.background = new THREE.Color(0x000000);
  const stars = createStarfield(1977);
  const sun = createSun();
  scene.add(stars, sun);

  const yavinRadius = 7e7;
  const yavin4Radius = 5e6;
  const yavin = createGasGiantYavin(yavinRadius);
  yavin.position.copy(opts.yavinPos ?? new THREE.Vector3(-1.6e8, -0.3e8, 2.4e8));
  scene.add(yavin);
  const yavin4 = createMoonYavin4(yavin4Radius);
  yavin4.position.copy(opts.yavin4Pos ?? new THREE.Vector3(1.2e7, -0.4e7, 3.2e7));
  scene.add(yavin4);

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

  // Image-based lighting: a procedural radiance map of this level's sky (bodies placed where they
  // really are), generated once and PMREM-filtered by three on first use.
  const bodies = [
    { center: yavin.position, radius: yavinRadius, albedoA: new THREE.Color(0.62, 0.3, 0.1), albedoB: new THREE.Color(0.36, 0.13, 0.04), bands: 9 },
    { center: yavin4.position, radius: yavin4Radius, albedoA: new THREE.Color(0.12, 0.2, 0.1), albedoB: new THREE.Color(0.22, 0.26, 0.3), bands: 2 },
  ];
  // Shadowed levels fly over the station: the trench passes no sphere, but sits on the plane y = 0.
  const dsCenter = opts.deathStarCenter ?? (opts.shadows ? new THREE.Vector3(0, -DEATH_STAR_RADIUS, 0) : null);
  if (dsCenter) {
    // Effective albedo, darker than the plating itself: the city of greebles shadows most of it.
    const grey = new THREE.Color(0.15, 0.155, 0.165);
    bodies.push({ center: dsCenter, radius: DEATH_STAR_RADIUS, albedoA: grey, albedoB: grey, bands: 0 });
  }
  scene.environment = createSpaceEnvMap({ sunDirection: SUN_DIRECTION, bodies });
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
    yavin,
    yavin4,
    update(dt, camera, focus) {
      stars.position.copy(camera.position);
      sun.position.copy(camera.position);
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
