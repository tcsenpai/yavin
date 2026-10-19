// Epilogue — the Death Star is destroyed. Cinematic, then the throne-room ceremony card.
import * as THREE from 'three';
import { KinematicBrain } from '../game/ai';
import type { Script } from '../game/script';
import { createDeathStarExplosion } from '../world/celestial';
import { RED, spawnPlayer, spawnShip } from './common';
import type { LevelContext, LevelDef } from './context';
import { DEATH_STAR_RADIUS, buildEnvironment } from './environment';

export const epilogue: LevelDef = {
  id: 'epilogue',
  kind: 'cinematic',
  titleKey: 'l5.title',
  subKey: 'l5.sub',
  introKey: 'l5.intro',
  setup(ctx: LevelContext) {
    const R = DEATH_STAR_RADIUS;
    const dsCenter = new THREE.Vector3(30000, 25000, -300000);
    const env = buildEnvironment(ctx.scene, {
      deathStarCenter: dsCenter,
      dishFacing: new THREE.Vector3(0, 0, 1),
      shadows: false,
      yavinPos: new THREE.Vector3(-2.6e8, -0.4e8, -1.2e8),
      yavin4Pos: new THREE.Vector3(-0.4e7, -0.3e7, 2.6e7),
    });
    const ds = env.deathStar!;
    const boom = createDeathStarExplosion(R);
    boom.group.position.copy(dsCenter);
    boom.group.visible = false;
    ctx.scene.add(boom.group);

    ctx.showHud = false;
    ctx.playerControl = false;
    ctx.music('none');

    // Luke, Wedge and the Falcon racing home toward Yavin 4 (+Z).
    const vel = new THREE.Vector3(0, 0, 210);
    let t = 0;
    const along = (off: THREE.Vector3) => () => off.clone().addScaledVector(vel, t);
    const player = spawnPlayer(ctx, new THREE.Vector3(0, 0, 0));
    player.brain = new KinematicBrain(along(new THREE.Vector3(0, 0, 0)), 4);
    const wedge = spawnShip(ctx, 'xwing', 'spk.wedge', new THREE.Vector3(-22, 6, -30), undefined, RED);
    wedge.brain = new KinematicBrain(along(new THREE.Vector3(-22, 6, -30)), 4);
    const falcon = spawnShip(ctx, 'falcon', 'spk.han', new THREE.Vector3(40, 18, -90));
    falcon.brain = new KinematicBrain(along(new THREE.Vector3(40, 18, -90)), 4);
    for (const s of [player, wedge, falcon]) s.invulnerable = true;

    let exploded = false;
    let shown = false;
    ctx.cameraOverride = (cam) => {
      // Camera ahead of the ships, looking back at them with the station behind.
      const k = Math.min(t / 14, 1);
      cam.position.copy(player.pos).add(new THREE.Vector3(14 - k * 6, 4 + k * 3, 46 + k * 30));
      cam.up.set(0, 1, 0);
      cam.lookAt(player.pos.clone().lerp(dsCenter, 0.00004));
      cam.fov = 55;
      cam.updateProjectionMatrix();
      return true;
    };
    ctx.onUpdate = (dt) => {
      t += dt;
      env.update(dt, ctx.camera, player.pos);
      if (exploded) {
        boom.update(dt);
        ctx.flash = Math.max(ctx.flash, boom.flash);
        if (!shown && boom.flash > 0.9) {
          ds.setDestroyed(true);
          shown = true;
        }
      }
    };

    function* script(): Script {
      yield 3;
      ctx.audio.explosion('deathstar');
      boom.group.visible = true;
      exploded = true;
      ctx.shake = 0.5;
      yield 0.2;
      if (!shown) {
        ds.setDestroyed(true);
        shown = true;
      }
      ctx.music('victory');
      yield 4;
      yield ctx.comms.say('han', 'l5.han.great');
      yield ctx.comms.say('obiwan', 'l5.ben.remember');
      yield 2;
      ctx.complete();
    }
    ctx.run(script());
  },
};
