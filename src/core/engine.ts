// Renderer, post-processing and the per-level scene container.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

export type Quality = 'low' | 'medium' | 'high';

// Film-grain, vignette, chromatic fringe, screen flash and damage tint in one pass.
const FinishShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uFlash: { value: 0 },
    uDamage: { value: 0 },
    uFade: { value: 0 },
    uGrain: { value: 0.045 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uFlash, uDamage, uFade, uGrain;
    varying vec2 vUv;
    float rand(vec2 c) { return fract(sin(dot(c, vec2(12.9898, 78.233)) + uTime * 7.13) * 43758.5453); }
    void main() {
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);
      vec2 off = d * (0.0025 + uDamage * 0.01);
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;
      col *= 1.0 - smoothstep(0.18, 0.75, r2) * 0.55;
      col += (rand(vUv * 913.0) - 0.5) * uGrain;
      col = mix(col, vec3(0.9, 0.12, 0.05) * (0.5 + 0.5 * col), uDamage * smoothstep(0.08, 0.45, r2) * 0.8);
      col = mix(col, vec3(1.0, 0.97, 0.9), clamp(uFlash, 0.0, 1.0));
      col *= 1.0 - uFade;
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  scene = new THREE.Scene();
  private composer: EffectComposer;
  private renderPass: RenderPass;
  private bloom: UnrealBloomPass;
  private finish: ShaderPass;
  quality: Quality = 'high';
  flash = 0;
  damage = 0;
  fade = 0;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
      logarithmicDepthBuffer: true,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(68, 1, 0.3, 2e9);

    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.4, 0.9);
    this.finish = new ShaderPass(FinishShader);
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.composer.addPass(this.finish);

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  setQuality(q: Quality): void {
    this.quality = q;
    this.renderer.shadowMap.enabled = q !== 'low';
    this.bloom.enabled = q !== 'low';
    this.resize();
  }

  /** Replace the scene (each level owns a fresh scene). Disposes GPU resources of the old one. */
  setScene(scene: THREE.Scene): void {
    const old = this.scene;
    this.scene = scene;
    this.renderPass.scene = scene;
    if (old !== scene) disposeScene(old);
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const maxRatio = this.quality === 'high' ? 2 : this.quality === 'medium' ? 1.5 : 1;
    const ratio = Math.min(window.devicePixelRatio, maxRatio);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h);
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w / 2, h / 2);
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
}

export function disposeScene(scene: THREE.Scene): void {
  const geos = new Set<THREE.BufferGeometry>();
  const mats = new Set<THREE.Material>();
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry && !m.geometry.userData.shared) geos.add(m.geometry);
    const mm = m.material as THREE.Material | THREE.Material[] | undefined;
    if (mm) for (const x of Array.isArray(mm) ? mm : [mm]) if (!x.userData.shared) mats.add(x);
  });
  geos.forEach((g) => g.dispose());
  mats.forEach((m) => m.dispose());
}
