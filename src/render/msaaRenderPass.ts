// Scene pass with multisampling confined to the scene render. Making the composer's own ping-pong
// targets multisampled would also run every later full-screen pass (bloom composite, output) at
// N samples plus a resolve each; here the scene renders into a private MSAA target and one cheap
// copy hands the resolved image to the rest of the chain.
import * as THREE from 'three';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';

export class MsaaRenderPass extends RenderPass {
  private target: THREE.WebGLRenderTarget | null = null;
  private readonly copy = new FullScreenQuad(
    new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms),
      vertexShader: CopyShader.vertexShader,
      fragmentShader: CopyShader.fragmentShader,
      blending: THREE.NoBlending,
      depthTest: false,
      depthWrite: false,
    }),
  );
  private readonly size = new THREE.Vector2(1, 1);

  constructor(scene: THREE.Scene, camera: THREE.Camera, samples: number) {
    super(scene, camera);
    this.samples = samples;
  }

  /** MSAA sample count (0 = render straight into the composer buffer). */
  get samples(): number {
    return this.target?.samples ?? 0;
  }

  set samples(n: number) {
    if (n === this.samples) return;
    this.target?.dispose();
    // Only the resolved colour is consumed: skip the depth resolve and let the driver discard the
    // multisampled attachments after the resolve (big bandwidth saving on tiled GPUs).
    this.target =
      n > 0
        ? new THREE.WebGLRenderTarget(this.size.x, this.size.y, {
            type: THREE.HalfFloatType,
            samples: n,
            resolveDepthBuffer: false,
            resolveStencilBuffer: false,
            storeMultisampledColorBuffer: false,
            storeMultisampledDepthBuffer: false,
          })
        : null;
  }

  setSize(width: number, height: number): void {
    this.size.set(width, height);
    this.target?.setSize(width, height);
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget, deltaTime: number, maskActive: boolean): void {
    if (!this.target || this.renderToScreen) {
      super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
      return;
    }
    super.render(renderer, writeBuffer, this.target, deltaTime, maskActive);
    (this.copy.material as THREE.ShaderMaterial).uniforms.tDiffuse.value = this.target.texture;
    renderer.setRenderTarget(readBuffer);
    this.copy.render(renderer);
  }

  dispose(): void {
    super.dispose();
    this.target?.dispose();
    this.copy.material.dispose();
    this.copy.dispose();
  }
}
