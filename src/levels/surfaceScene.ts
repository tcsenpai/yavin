// Death Star surface battlefield shared by the surface-attack and dogfight levels.
import * as THREE from 'three';
import { Rng } from '../core/rng';
import { Tower } from '../game/tower';
import { DeathStarSurface } from '../world/surface';
import type { LevelContext } from './context';
import { DEATH_STAR_RADIUS, buildEnvironment, type Environment } from './environment';

export interface SurfaceScene {
  env: Environment;
  surface: DeathStarSurface;
  /** Per-frame upkeep (sky, shadows, chunk streaming, flak). */
  update(dt: number): void;
  flak: number; // bursts per second around the player
}

export function buildSurfaceScene(ctx: LevelContext, seed: number): SurfaceScene {
  const R = DEATH_STAR_RADIUS;
  const env = buildEnvironment(ctx.scene, {
    // The sphere sits 3 m below the streamed plating so they never z-fight; it provides the true horizon.
    deathStarCenter: new THREE.Vector3(0, -R - 3, 0),
    dishFacing: new THREE.Vector3(1, 0, 0),
    shadows: true,
    shadowExtent: 320,
    yavinPos: new THREE.Vector3(-1.4e8, 0.9e8, -2.2e8),
    yavin4Pos: new THREE.Vector3(1.6e7, 0.5e7, 2.8e7),
    ambient: 0.6,
  });
  const surface = new DeathStarSurface({ seed, curvatureR: R });
  ctx.world.setSurface(surface);
  const rng = new Rng(seed * 7 + 1);
  const scene: SurfaceScene = {
    env,
    surface,
    flak: 0,
    update(dt) {
      const p = ctx.player?.alive ? ctx.player.pos : ctx.camera.position;
      env.update(dt, ctx.camera, p);
      surface.update(ctx.camera.position);
      if (scene.flak > 0 && ctx.player?.alive && rng.chance(dt * scene.flak)) {
        const pl = ctx.player;
        const fwd = pl.forward();
        const fp = pl.pos.clone().addScaledVector(fwd, rng.range(80, 600)).add(new THREE.Vector3(rng.range(-160, 160), rng.range(-60, 120), rng.range(-160, 160)));
        if (fp.y > surface.heightAt(fp.x, fp.z) + 20) {
          ctx.world.fx.flak(fp);
          ctx.audio.explosion('small', fp);
          const d = fp.distanceTo(pl.pos);
          if (d < 25) {
            pl.takeDamage(10 * ctx.difficulty * (1 - d / 25) + 2, fp, null);
            ctx.shake = Math.max(ctx.shake, 0.4);
          }
        }
      }
    },
  };
  return scene;
}

/** Place `n` turbolaser towers in a region, clearing pads in the greeble field. */
export function placeTowers(ctx: LevelContext, surface: DeathStarSurface, seed: number, n: number, center: THREE.Vector3, spread: number): Tower[] {
  const rng = new Rng(seed);
  const out: Tower[] = [];
  const pts: THREE.Vector3[] = [];
  let guard = 0;
  while (pts.length < n && guard++ < 500) {
    const p = new THREE.Vector3(center.x + rng.range(-spread, spread), 0, center.z + rng.range(-spread, spread));
    if (pts.some((q) => q.distanceTo(p) < spread * 0.35)) continue;
    pts.push(p);
  }
  for (const p of pts) surface.addClearing(p.x, p.z, 34);
  for (const [i, p] of pts.entries()) {
    p.y = surface.curvature(p.x, p.z);
    const t = new Tower('tower', seed * 31 + i, p, new THREE.Vector3(0, 1, 0), ctx.difficulty);
    ctx.world.addTower(t);
    out.push(t);
  }
  return out;
}
