// Sun visibility probe for the lens flare. Instead of CPU raycasts or occlusion queries, it samples
// the HDR scene buffer in a small disc around the projected sun: the sun sprite is drawn behind all
// geometry, so anything in front of it (ships, the Death Star, Yavin) naturally darkens those taps.
// The result is written to a 1×1 target with temporal smoothing; the finish pass draws the flare.
import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';

const ProbeShader = {
  uniforms: {
    tScene: { value: null as THREE.Texture | null },
    tPrev: { value: null as THREE.Texture | null },
    uSun: { value: new THREE.Vector2() },
    uRadius: { value: new THREE.Vector2() },
    uOn: { value: 0 },
    uBlend: { value: 1 },
  },
  vertexShader: /* glsl */ `
    void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tScene, tPrev;
    uniform vec2 uSun, uRadius;
    uniform float uOn, uBlend;
    float tap(vec2 o) {
      vec3 c = texture2D(tScene, uSun + o * uRadius).rgb;
      return smoothstep(0.9, 2.6, dot(c, vec3(0.2126, 0.7152, 0.0722)));
    }
    void main() {
      float v = tap(vec2(0.0)) * 2.0;
      for (int i = 0; i < 12; i++) {
        float a = float(i) * 2.39996 + 0.3;
        float r = sqrt((float(i) + 0.5) / 12.0);
        v += tap(vec2(cos(a), sin(a)) * r);
      }
      v = v / 14.0 * uOn;
      float prev = texture2D(tPrev, vec2(0.5)).r;
      gl_FragColor = vec4(vec3(mix(prev, v, uBlend)), 1.0);
    }
  `,
};

export class SunFlarePass extends Pass {
  /**
   * Uniforms consumed by the finish shader (shared objects: assign them into its uniform map).
   * `tSunVis` holds the smoothed visibility (0..1) in the red channel of a 1×1 texture; `uFlare` is
   * `strength` faded out as the sun leaves the screen.
   */
  readonly uniforms = {
    tSunVis: { value: null as THREE.Texture | null },
    uSunUv: { value: new THREE.Vector2(0.5, 0.5) },
    uFlare: { value: 0 },
  };
  strength = 1;
  private readonly targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private current = 0;
  private readonly quad: FullScreenQuad;
  private readonly material: THREE.ShaderMaterial;
  private readonly tmp = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly sunDirection: THREE.Vector3,
  ) {
    super();
    this.needsSwap = false;
    const opts = { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
    this.targets = [new THREE.WebGLRenderTarget(1, 1, opts), new THREE.WebGLRenderTarget(1, 1, opts)];
    this.material = new THREE.ShaderMaterial({ ...ProbeShader, uniforms: THREE.UniformsUtils.clone(ProbeShader.uniforms), depthTest: false, depthWrite: false });
    this.quad = new FullScreenQuad(this.material);
  }

  render(renderer: THREE.WebGLRenderer, _write: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget, deltaTime: number): void {
    const cam = this.camera;
    const p = this.tmp.copy(this.sunDirection).multiplyScalar(1e6).add(cam.position).project(cam);
    const inFront = cam.getWorldDirection(this.fwd).dot(this.sunDirection) > 0;
    const edge = Math.max(Math.abs(p.x), Math.abs(p.y));
    const edgeFade = inFront ? 1 - THREE.MathUtils.smoothstep(edge, 0.92, 1.12) : 0;
    this.uniforms.uSunUv.value.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
    this.uniforms.uFlare.value = edgeFade * this.strength;

    const u = this.material.uniforms;
    u.tScene.value = readBuffer.texture;
    u.tPrev.value = this.targets[this.current].texture;
    u.uSun.value.copy(this.uniforms.uSunUv.value);
    // Probe disc ≈ 0.28° around the sun centre (inside the ~0.39° bright disc of the sun sprite).
    const rad = (0.28 * Math.PI) / 180 / Math.tan((cam.fov * Math.PI) / 360);
    u.uRadius.value.set(rad / cam.aspect, rad).multiplyScalar(0.5);
    u.uOn.value = edgeFade > 0 ? 1 : 0;
    u.uBlend.value = 1 - Math.exp(-Math.min(deltaTime, 0.1) * 25);

    this.current ^= 1;
    renderer.setRenderTarget(this.targets[this.current]);
    this.quad.render(renderer);
    this.uniforms.tSunVis.value = this.targets[this.current].texture;
  }

  dispose(): void {
    this.targets[0].dispose();
    this.targets[1].dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}
