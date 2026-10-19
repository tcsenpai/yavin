// Briefing in the Massassi temple: General Dodonna's hologram of the battle station and the trench approach.
import * as THREE from 'three';
import type { Script } from '../game/script';
import type { LevelContext, LevelDef } from './context';

const HOLO = new THREE.Color(0.35, 0.8, 1.9);
const HOT = new THREE.Color(2.4, 0.9, 0.3);

function holoMaterial(color: THREE.Color, opacity = 0.85): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
}

/** Wireframe battle station: latitude/longitude grid, equatorial trench, superlaser dish. */
function holoDeathStar(r: number): THREE.Group {
  const g = new THREE.Group();
  const pts: number[] = [];
  const seg = 96;
  for (let lat = -80; lat <= 80; lat += 10) {
    const y = r * Math.sin((lat * Math.PI) / 180);
    const rr = r * Math.cos((lat * Math.PI) / 180);
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      pts.push(Math.cos(a0) * rr, y, Math.sin(a0) * rr, Math.cos(a1) * rr, y, Math.sin(a1) * rr);
    }
  }
  for (let lon = 0; lon < 360; lon += 15) {
    const a = (lon * Math.PI) / 180;
    for (let i = 0; i < seg / 2; i++) {
      const b0 = -Math.PI / 2 + (i / (seg / 2)) * Math.PI;
      const b1 = -Math.PI / 2 + ((i + 1) / (seg / 2)) * Math.PI;
      pts.push(Math.cos(b0) * Math.cos(a) * r, Math.sin(b0) * r, Math.cos(b0) * Math.sin(a) * r);
      pts.push(Math.cos(b1) * Math.cos(a) * r, Math.sin(b1) * r, Math.cos(b1) * Math.sin(a) * r);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  g.add(new THREE.LineSegments(geo, holoMaterial(HOLO, 0.45)));
  // Equatorial trench: doubled ring.
  for (const k of [0.99, 1.01]) {
    const ring: number[] = [];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      ring.push(Math.cos(a) * r * k, 0, Math.sin(a) * r * k);
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.Float32BufferAttribute(ring, 3));
    g.add(new THREE.Line(rg, holoMaterial(HOLO, 1)));
  }
  // Superlaser dish, 30° north, facing +Z.
  const dish = new THREE.Group();
  for (const k of [1, 0.66, 0.33]) {
    const ring: number[] = [];
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      ring.push(Math.cos(a) * r * 0.24 * k, Math.sin(a) * r * 0.24 * k, 0);
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.Float32BufferAttribute(ring, 3));
    dish.add(new THREE.Line(rg, holoMaterial(HOLO, 1)));
  }
  const lat = Math.PI / 6;
  dish.position.set(0, Math.sin(lat) * r * 0.97, Math.cos(lat) * r * 0.97);
  dish.lookAt(dish.position.clone().multiplyScalar(2));
  g.add(dish);
  return g;
}

/** Close-up trench schematic with the attack path and the exhaust port. */
function holoTrench(): { group: THREE.Group; fighter: THREE.Mesh; torp: THREE.Mesh; port: THREE.Vector3 } {
  const g = new THREE.Group();
  const pts: number[] = [];
  const L = 60;
  const w = 1;
  const d = 1;
  for (const x of [-w, w]) {
    pts.push(x, 0, 0, x, 0, -L, x, -d, 0, x, -d, -L);
    pts.push(x * 4, 0, 0, x * 4, 0, -L);
  }
  for (let z = 0; z >= -L; z -= 2) pts.push(-w, 0, z, -w, -d, z, -w, -d, z, w, -d, z, w, -d, z, w, 0, z);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  g.add(new THREE.LineSegments(geo, holoMaterial(HOLO, 0.7)));
  const port = new THREE.Vector3(0, -d, -L + 6);
  const portRing: number[] = [];
  for (let i = 0; i <= 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    portRing.push(Math.cos(a) * 0.25, -d + 0.01, -L + 6 + Math.sin(a) * 0.25);
  }
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.Float32BufferAttribute(portRing, 3));
  g.add(new THREE.Line(pg, holoMaterial(HOT, 1)));
  const fighter = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.4, 4).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: HOT, toneMapped: false }));
  const torp = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), new THREE.MeshBasicMaterial({ color: HOT, toneMapped: false }));
  torp.visible = false;
  g.add(fighter, torp);
  return { group: g, fighter, torp, port };
}

export const briefing: LevelDef = {
  id: 'briefing',
  kind: 'cinematic',
  titleKey: 'l0.title',
  subKey: 'l0.sub',
  introKey: 'l0.intro',
  setup(ctx: LevelContext) {
    ctx.showHud = false;
    ctx.playerControl = false;
    ctx.scene.background = new THREE.Color(0x020306);
    ctx.scene.fog = null;
    const ds = holoDeathStar(10);
    ctx.scene.add(ds);
    const trench = holoTrench();
    trench.group.visible = false;
    trench.group.position.set(0, 0, 30);
    ctx.scene.add(trench.group);
    // Briefing-room floor ring (the projector).
    const ring = new THREE.Mesh(new THREE.RingGeometry(12, 12.3, 96).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: HOLO, transparent: true, opacity: 0.4, toneMapped: false }));
    ring.position.y = -13;
    ctx.scene.add(ring);
    ctx.music('briefing');

    let t = 0;
    let phase = 0;
    let runT = 0;
    ctx.cameraOverride = (cam) => {
      if (phase === 0) {
        cam.position.set(Math.sin(t * 0.05) * 6, 6, 36);
        cam.lookAt(0, 0, 0);
      } else {
        // Ride down the trench behind the fighter.
        const f = trench.fighter.getWorldPosition(new THREE.Vector3());
        cam.position.copy(f).add(new THREE.Vector3(1.6, 2.4, 5));
        cam.lookAt(f.clone().add(new THREE.Vector3(0, -0.6, -6)));
      }
      cam.fov = 50;
      cam.updateProjectionMatrix();
      return true;
    };
    ctx.onUpdate = (dt) => {
      t += dt;
      ds.rotation.y += dt * 0.12;
      for (const o of ds.children) {
        const m = (o as THREE.Line).material as THREE.LineBasicMaterial;
        if (m?.opacity !== undefined) m.opacity = 0.45 + Math.sin(t * 13 + o.id) * 0.04 + (Math.random() < 0.02 ? -0.2 : 0);
      }
      if (phase === 1) {
        runT += dt;
        const z = -Math.min(runT * 5, 52);
        trench.fighter.position.set(Math.sin(runT * 1.3) * 0.25, -0.5, z);
        if (z <= -48 && !trench.torp.visible) {
          trench.torp.visible = true;
          trench.torp.position.copy(trench.fighter.position);
        }
        if (trench.torp.visible) {
          trench.torp.position.lerp(trench.port, Math.min(1, dt * 2.5));
        }
      }
    };

    function* script(): Script {
      const c = ctx.comms;
      yield 1;
      yield c.say('dodonna', 'l0.d.station');
      yield c.say('dodonna', 'l0.d.defenses');
      yield c.say('goldLeader', 'l0.gold.question');
      yield c.say('dodonna', 'l0.d.threat');
      yield c.say('dodonna', 'l0.d.weakness');
      phase = 1;
      ds.visible = false;
      ring.visible = false;
      trench.group.visible = true;
      yield c.say('dodonna', 'l0.d.trench');
      yield c.say('dodonna', 'l0.d.port');
      yield c.say('dodonna', 'l0.d.chain');
      yield c.say('dodonna', 'l0.d.torpedoes');
      yield c.say('luke', 'l0.luke.impossible');
      yield c.say('wedge', 'l0.wedge.womprats');
      yield c.say('dodonna', 'l0.d.force');
      yield 1;
      ctx.complete();
    }
    ctx.run(script());
  },
};
