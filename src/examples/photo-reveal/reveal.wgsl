import { fbmSimplex3d } from "@vgpu/wgsl-std/noise/simplex";

// Photo reveal: a lumpy front rises from the bottom of the photo. The columns
// travel at different speeds (lobes), the mask near the front flares out
// sideways (the photo itself stays still), a lime band trails just below the front and a soft white halo
// glows above it. Hiding plays the same animation backwards.
struct Params {
  canvasSize: vec2f, // px
  half: vec2f,       // photo half size, px
  imageAspect: f32,  // width / height of the source image
  progress: f32,     // 0 hidden .. 1 revealed
  time: f32,
  glow: f32,
  wobble: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var photo: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

const LIME = vec3f(0.9, 0.95, 0.12);
const WHITE = vec3f(1.0);
const PI = 3.14159265;

fn box(p: vec2f, half: vec2f, r: f32) -> f32 {
  let q = abs(p) - half + r;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

// Smooth intersection: rounds the corners where the front meets the sides.
fn smax(a: f32, b: f32, k: f32) -> f32 {
  let h = max(k - abs(a - b), 0.0) / k;
  return max(a, b) + h * h * k * 0.25;
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p0 = (uv - 0.5) * params.canvasSize; // px, centred on the photo, y down
  let half = params.half;
  let H = half.y * 2.0;
  let t = params.time;
  let progress = clamp(params.progress, 0.0, 1.0);
  let e = progress * progress * (3.0 - 2.0 * progress);
  let travel = sin(PI * e); // 0 at rest, 1 mid-animation
  let fromBottom = half.y - p0.y;

  // Front height: lumpy lag per column (big slow lobes), settling at the end.
  let settle = 1.0 - smoothstep(0.75, 1.0, progress);
  let lump = fbmSimplex3d(vec3f(p0.x * 0.0045, 3.1, t * 0.15), 2, 2.0, 0.5);
  let lag = (0.5 + 0.5 * lump) * 0.2 * H * settle * params.wobble;
  let front = mix(-0.25 * H, 1.3 * H, e) - lag;
  let d = front - fromBottom; // > 0 below the front (revealed)

  // Flare: the region close to the front bulges out sideways.
  let flare = 1.0 + 0.09 * travel * exp(-max(d, 0.0) / (0.35 * H));
  let p = vec2f(p0.x / flare, p0.y);

  let rect = box(p, half, 4.0);
  let shape = smax(rect, -d, 0.22 * H * (0.4 + 0.6 * settle)); // revealed region SDF

  // Photo stays put: sampled from undistorted coordinates, only the mask moves.
  var suv = p0 / (half * 2.0) + 0.5;
  let rectAspect = half.x / half.y;
  if (params.imageAspect > rectAspect) {
    suv.x = (suv.x - 0.5) * rectAspect / params.imageAspect + 0.5;
  } else {
    suv.y = (suv.y - 0.5) * params.imageAspect / rectAspect + 0.5;
  }
  let img = textureSampleLevel(photo, samp, clamp(suv, vec2f(0.0), vec2f(1.0)), 0.0).rgb;

  // Energy: strong while travelling, a faint lime rim lingers until rest.
  let energy = smoothstep(0.0, 0.04, progress) * (1.0 - smoothstep(0.85, 1.0, progress)) * params.glow;

  let inside = smoothstep(1.0, -1.0, shape);
  // Depth below the front (not the sides/bottom), so the colours follow the
  // rising edge only. Taking the max with the shape keeps rounded corners lit.
  let edge = min(max(d, 0.0), max(-shape, 0.0) + 0.5 * max(d, 0.0));
  // Two colours: white on the outside of the edge, yellow on the inside.
  // The yellow stays solid for a short band, then fades into the photo.
  let limeBand = (1.0 - smoothstep(0.03 * H, 0.22 * H, edge)) * energy;
  var color = mix(img, LIME, limeBand);
  color = mix(color, WHITE, exp(-edge / (0.015 * H)) * energy);

  // Soft white halo around the shape, strongest above the front.
  let above = exp(-max(d, 0.0) / (0.3 * H));
  let hd = max(shape, 0.0) / (0.075 * H * max(params.glow, 0.01));
  let halo = exp(-hd * 1.6) * (1.0 - smoothstep(1.8, 2.6, hd)) * energy * above;
  let alpha = inside + (1.0 - inside) * halo;
  let outC = mix(WHITE, color, inside);
  return vec4f(outC * alpha, alpha); // premultiplied
}
