import { fbmSimplex3d } from "@vgpu/wgsl-std/noise/simplex";

struct Params {
  time: f32,
  progress: f32, // 0 = image A, 1 = image B
  aspect: f32,   // width / height (canvas and image share it)
  pad: f32,      // canvas overflow around the image, as a fraction of image size
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var imageA: texture_2d<f32>;
@group(0) @binding(2) var imageB: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

const BAND = 0.32;   // half-width of the gas front along the diagonal
const RADIUS = 0.02; // image corner radius, in image-height units
const PINK = vec3f(1.0, 0.275, 0.804);     // #FF46CD
const YELLOW = vec3f(0.894, 0.984, 0.0);   // #E4FB00

fn roundedBox(p: vec2f, half: vec2f, r: f32) -> f32 {
  let q = abs(p) - half + r;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let t = params.time;
  let pad = params.pad;

  // Image-space uv: 0..1 over the image, beyond it in the overflow margin.
  let iuv = uv * (1.0 + 2.0 * pad) - pad;
  let p = vec2f(iuv.x * params.aspect, iuv.y);

  // Diagonal coordinate: 0 at bottom-left, 1 at top-right (uv is top-origin).
  let diag = (iuv.x + (1.0 - iuv.y)) * 0.5;

  // Domain-warped fBm for soft, curling gas drifting up-right.
  let drift = vec2f(-0.06, 0.1) * t;
  let q = vec2f(
    fbmSimplex3d(vec3f(p * 0.8 + drift, t * 0.1), 3, 2.0, 0.5),
    fbmSimplex3d(vec3f(p * 0.8 + drift + vec2f(5.2, 1.3), t * 0.1 + 3.0), 3, 2.0, 0.5),
  );
  let n = fbmSimplex3d(vec3f(p * 1.1 + q * 1.2 + drift * 1.5, t * 0.15), 4, 2.0, 0.45);
  let fine = fbmSimplex3d(vec3f(p * 2.6 + q * 1.5 - drift, t * 0.25 + 9.0), 3, 2.0, 0.5);

  // Front sweeps from beyond the bottom-left margin to beyond the top-right one.
  let reach = pad + BAND * 1.3;
  let front = mix(-reach, 1.0 + reach, params.progress);
  let d = diag + n * 0.14;

  // Swap A -> B behind the front; the seam stays under the densest gas.
  let reveal = smoothstep(front + 0.04, front - 0.04, d);

  // Gas density: wide noisy band around the front, wispy at its edges.
  let x = (d - front) / BAND;
  let band = exp(-x * x * 2.0);
  let wisps = smoothstep(-0.55, 0.65, n + fine * 0.25);
  let core = exp(-x * x * 9.0); // guaranteed cover right on the seam
  var density = clamp(band * (0.2 + wisps * 0.85) + core * 0.55, 0.0, 1.0);
  density = density * density * (3.0 - 2.0 * density); // soft, veil-like falloff

  // Fade at canvas edges and at rest, so nothing lingers or clips hard.
  let edge = smoothstep(vec2f(0.0), vec2f(0.15), uv) * smoothstep(vec2f(1.0), vec2f(0.85), uv);
  let rest = smoothstep(0.0, 0.06, params.progress) * smoothstep(1.0, 0.94, params.progress);
  density *= edge.x * edge.y * rest;

  // Two-tone gas: pink/yellow regions follow the warp field, lit by fine detail.
  let tone = smoothstep(-0.5, 0.5, q.x - q.y * 0.6 + n * 0.3);
  let glow = 0.92 + 0.15 * smoothstep(-0.5, 0.5, fine);
  let gas = mix(PINK, YELLOW, tone) * glow;

  // Image, warped slightly under the gas, clipped to a rounded rectangle.
  let warp = vec2f(q.x, q.y) * 0.03 * band;
  let a = textureSampleLevel(imageA, samp, iuv + warp, 0.0).rgb;
  let b = textureSampleLevel(imageB, samp, iuv + warp, 0.0).rgb;
  let img = mix(a, b, reveal);
  let box = roundedBox(vec2f((iuv.x - 0.5) * params.aspect, iuv.y - 0.5), vec2f(0.5 * params.aspect, 0.5), RADIUS);
  let inside = 1.0 - smoothstep(-0.002, 0.002, box);

  // Premultiplied "gas over image" for the transparent canvas.
  let alpha = density + inside * (1.0 - density);
  let rgb = gas * density + img * inside * (1.0 - density);
  return vec4f(rgb, alpha);
}
