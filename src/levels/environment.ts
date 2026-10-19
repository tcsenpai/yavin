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

  const yavin = createGasGiantYavin(7e7);
  yavin.position.copy(opts.yavinPos ?? new THREE.Vector3(-1.6e8, -0.3e8, 2.4e8));
  scene.add(yavin);
  const yavin4 = createMoonYavin4(5e6);
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
  }
  // Fill: cool bounce from space + warm reflected Yavin light from below.
  scene.add(new THREE.HemisphereLight(0x5a6c8a, 0x3a2a1c, opts.ambient ?? 0.55));
  // Viewer fill ("key light from the camera"): keeps black TIE panels and shadowed hulls readable
  // against black space — the same trick space-combat games use for silhouette legibility.
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
