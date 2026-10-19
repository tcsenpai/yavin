// Final display-space pass: film grade (contrast curve, split toning), anamorphic sun flare, lens
// fringe, vignette, film grain and the gameplay overlays (flash, damage tint, fade).
import * as THREE from 'three';

export const FinishShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tSunVis: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uFlash: { value: 0 },
    uDamage: { value: 0 },
    uFade: { value: 0 },
    uGrain: { value: 0.03 },
    /** Film grade strength (0 = neutral, 1 = default look). */
    uGrade: { value: 1 },
    uSunUv: { value: new THREE.Vector2(0.5, 0.5) },
    /** Flare strength × on-screen fade (0 disables the flare). */
    uFlare: { value: 0 },
    uAspect: { value: 16 / 9 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse, tSunVis;
    uniform float uTime, uFlash, uDamage, uFade, uGrain, uGrade, uFlare, uAspect;
    uniform vec2 uSunUv;
    varying vec2 vUv;
    const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
    float rand(vec2 c) { return fract(sin(dot(c, vec2(12.9898, 78.233)) + uTime * 7.13) * 43758.5453); }

    // Soft hexagonal aperture ghost (six-blade iris), brighter towards its rim.
    float ghost(vec2 p, vec2 c, float size) {
      vec2 q = abs(p - c) / size;
      float h = max(q.x * 0.866 + q.y * 0.5, q.y);
      return (1.0 - smoothstep(0.82, 1.0, h)) * (0.45 + 0.55 * smoothstep(0.35, 0.95, h));
    }

    vec3 flare(vec2 uv) {
      float vis = texture2D(tSunVis, vec2(0.5)).r * uFlare;
      if (vis < 0.002) return vec3(0.0);
      vec2 a = vec2(uAspect, 1.0);
      vec2 p = (uv - 0.5) * a;
      vec2 s = (uSunUv - 0.5) * a;
      vec2 d = p - s;
      float r = length(d);
      // Centred flares are stronger; off-axis ones fade.
      float axis = 1.0 - 0.45 * smoothstep(0.0, 0.9, length(s));
      vec3 c = vec3(0.0);
      // Anamorphic streak (1977 Panavision): long thin cyan-blue line through the sun.
      c += vec3(0.32, 0.55, 1.0) * exp(-abs(d.y) * 260.0) * exp(-abs(d.x) * 1.6) * 0.55;
      c += vec3(0.5, 0.7, 1.0) * exp(-abs(d.y) * 70.0) * exp(-abs(d.x) * 5.0) * 0.12;
      // Veiling glare around the sun.
      c += vec3(1.0, 0.86, 0.66) * exp(-r * 5.0) * 0.08;
      // Chromatic halo ring.
      vec3 ring = vec3(
        exp(-pow((r - 0.43) * 30.0, 2.0)),
        exp(-pow((r - 0.415) * 30.0, 2.0)),
        exp(-pow((r - 0.40) * 30.0, 2.0)));
      c += ring * 0.035 * axis;
      // Aperture ghosts mirrored through the screen centre.
      c += vec3(1.0, 0.55, 0.25) * ghost(p, s * -0.35, 0.045) * 0.10 * axis;
      c += vec3(0.35, 0.85, 0.7) * ghost(p, s * -0.62, 0.09) * 0.045 * axis;
      c += vec3(0.55, 0.45, 1.0) * ghost(p, s * -1.05, 0.16) * 0.035 * axis;
      c += vec3(1.0, 0.75, 0.45) * ghost(p, s * 0.42, 0.03) * 0.12 * axis;
      c += vec3(0.4, 0.7, 1.0) * ghost(p, s * -1.55, 0.06) * 0.06 * axis;
      c += vec3(0.9, 0.5, 0.8) * ghost(p, s * 1.35, 0.022) * 0.08 * axis;
      return c * vis;
    }

    void main() {
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);
      vec2 off = d * (0.0016 + uDamage * 0.01);
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;

      // Film grade (display-referred): gentle S-curve, cool shadows / warm highlights, a touch of
      // saturation. Multiplicative toning keeps deep space black.
      vec3 g = mix(col, col * col * (3.0 - 2.0 * col), 0.22);
      float l = dot(g, LUMA);
      g *= mix(vec3(0.95, 0.99, 1.07), vec3(1.05, 1.0, 0.93), smoothstep(0.08, 0.75, l));
      g = max(mix(vec3(l), g, 1.06), 0.0);
      col = mix(col, g, uGrade);
      l = dot(col, LUMA);

      col += flare(vUv) * (1.0 - l * 0.5);
      col *= 1.0 - smoothstep(0.2, 0.8, r2) * 0.5;
      // Film grain: luminance-only, strongest in the mid-tones so deep space stays clean.
      float gl = dot(col, LUMA);
      col += (rand(vUv * 913.0) - 0.5) * uGrain * (0.3 + 2.8 * gl * (1.0 - gl));
      col = mix(col, vec3(0.9, 0.12, 0.05) * (0.5 + 0.5 * col), uDamage * smoothstep(0.08, 0.45, r2) * 0.8);
      col = mix(col, vec3(1.0, 0.97, 0.9), clamp(uFlash, 0.0, 1.0));
      col *= 1.0 - uFade;
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};
