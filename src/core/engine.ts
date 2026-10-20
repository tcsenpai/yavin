// Renderer, post-processing and the per-level scene container.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { MsaaRenderPass } from '../render/msaaRenderPass';
import { FinishShader } from '../render/finishShader';
import { SunFlarePass } from '../render/sunFlare';
import { SUN_DIRECTION } from '../world/celestial';

export type Quality = 'low' | 'medium' | 'high';

interface QualityProfile {
  maxPixelRatio: number;
  /**
   * MSAA samples of the HDR scene render (0 = off, FXAA instead). 2× rather than 4× on 'high':
   * with the log-depth shaders 4× measured ~+45% GPU time on the surface level vs ~+18% for 2×,
   * and at Retina pixel ratios 2× already gives ~8 coverage samples per CSS pixel.
   */
  samples: number;
  bloom: boolean;
  flare: boolean;
  shadows: boolean;
}

const PROFILES: Record<Quality, QualityProfile> = {
  low: { maxPixelRatio: 1, samples: 0, bloom: false, flare: false, shadows: false },
  medium: { maxPixelRatio: 1.5, samples: 2, bloom: true, flare: true, shadows: true },
  high: { maxPixelRatio: 2, samples: 2, bloom: true, flare: true, shadows: true },
};

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  scene = new THREE.Scene();
  private composer: EffectComposer;
  private renderPass: MsaaRenderPass;
  private sunFlare: SunFlarePass;
  private bloom: UnrealBloomPass;
  private fxaa: FXAAPass;
  private finish: ShaderPass;
  quality: Quality = 'high';
  flash = 0;
  damage = 0;
  fade = 0;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: false, // MSAA lives on the HDR scene target instead (the canvas only gets the final pass)
      powerPreference: 'high-performance',
      logarithmicDepthBuffer: true,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // ACES kept after A/B against AgX and Neutral: those two flatten the image and turn the hot
    // engine/laser emissives pink, while ACES' warm roll-off reads like 1977 film stock. The finish
    // pass adds the grade (contrast, split tone) on top.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(68, 1, 0.3, 2e9);

    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new MsaaRenderPass(this.scene, this.camera, PROFILES[this.quality].samples);
    this.sunFlare = new SunFlarePass(this.camera, SUN_DIRECTION);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.4, 0.9);
    this.fxaa = new FXAAPass();
    this.finish = new ShaderPass(FinishShader);
    // Share the probe's uniform objects so the finish pass reads this frame's sun visibility.
    Object.assign(this.finish.uniforms, this.sunFlare.uniforms);
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.sunFlare);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.composer.addPass(this.fxaa);
    this.composer.addPass(this.finish);
    this.applyProfile();

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  setQuality(q: Quality): void {
    this.quality = q;
    this.applyProfile();
    this.resize();
  }

  /** Replace the scene (each level owns a fresh scene). Disposes GPU resources of the old one unless it is persistent (menu backdrop). */
  setScene(scene: THREE.Scene): void {
    const old = this.scene;
    this.scene = scene;
    this.renderPass.scene = scene;
    if (old !== scene && !old.userData.persistent) disposeScene(old);
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const ratio = Math.min(window.devicePixelRatio, PROFILES[this.quality].maxPixelRatio);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h);
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(w, h);
    // Bloom at CSS resolution regardless of pixel ratio: its blur is resolution-relative, so this
    // keeps the glow radius identical on Retina and makes it 4× cheaper at ratio 2.
    this.bloom.setSize(w, h);
    this.finish.uniforms.uAspect.value = w / h;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(time: number): void {
    const u = this.finish.uniforms;
    u.uTime.value = time % 100;
    u.uFlash.value = this.flash;
    u.uDamage.value = this.damage;
    u.uFade.value = this.fade;
    this.composer.render();
  }

  private applyProfile(): void {
    const p = PROFILES[this.quality];
    // three does not recompile programs when shadow mapping is toggled: force it, or shadows freeze/never appear.
    if (this.renderer.shadowMap.enabled !== p.shadows) {
      this.scene.traverse((o) => {
        const mm = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (mm) for (const x of Array.isArray(mm) ? mm : [mm]) x.needsUpdate = true;
      });
    }
    this.renderer.shadowMap.enabled = p.shadows;
    this.renderPass.samples = p.samples;
    this.bloom.enabled = p.bloom;
    this.sunFlare.enabled = p.flare;
    if (!p.flare) this.sunFlare.uniforms.uFlare.value = 0;
    this.fxaa.enabled = p.samples === 0;
  }
}

export function disposeScene(scene: THREE.Scene): void {
  const geos = new Set<THREE.BufferGeometry>();
  const mats = new Set<THREE.Material>();
  scene.traverse((o) => {
    // Lights own their shadow map render target (32 MB at 2048²): free it with the scene.
    if (o instanceof THREE.Light) o.dispose();
    const m = o as THREE.Mesh;
    if (m.geometry && !m.geometry.userData.shared) geos.add(m.geometry);
    const mm = m.material as THREE.Material | THREE.Material[] | undefined;
    if (mm) for (const x of Array.isArray(mm) ? mm : [mm]) if (!x.userData.shared) mats.add(x);
  });
  geos.forEach((g) => g.dispose());
  mats.forEach((m) => m.dispose());
  // Procedural IBL maps are generated per level; disposing also frees three's PMREM copy.
  if (scene.environment && !scene.environment.userData.shared) scene.environment.dispose();
}
