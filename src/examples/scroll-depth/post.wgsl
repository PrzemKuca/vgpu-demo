// Screen-space finishing: zoom blur, chromatic aberration, glitch, halftone, vignette, grain.
struct Params {
  time: f32,
  velocity: f32, // smoothed scroll speed, signed (progress per second)
  aspect: f32,
  strength: f32,
  zoomBlur: f32,
  chroma: f32,
  glitch: f32,
  halftone: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var scene: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

const PINK = vec3f(1.0, 0.275, 0.804);   // #FF46CD
const YELLOW = vec3f(0.894, 0.984, 0.0); // #E4FB00
const BACKGROUND = vec3f(0.035, 0.035, 0.045);

fn hash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn sampleScene(uv: vec2f, split: f32) -> vec3f {
  let dir = uv - 0.5;
  let r = textureSampleLevel(scene, samp, uv + dir * split, 0.0);
  let g = textureSampleLevel(scene, samp, uv, 0.0);
  let b = textureSampleLevel(scene, samp, uv - dir * split, 0.0);
  // Scene is premultiplied over a transparent clear: composite onto the background.
  return vec3f(r.r, g.g, b.b) + BACKGROUND * (1.0 - g.a);
}

@fragment fn fs_main(@location(0) uv0: vec2f) -> @location(0) vec4f {
  let speed = abs(params.velocity);
  var uv = uv0;

  // Glitch: horizontal slices jump sideways while scrolling fast.
  if (params.glitch > 0.5) {
    let band = floor(uv.y * 36.0);
    let tick = floor(params.time * 18.0);
    let amount = clamp(speed * 1.5, 0.0, 1.0) * params.strength;
    if (hash(vec2f(band, tick)) < 0.25 * amount + 0.02 * params.strength) {
      uv.x += (hash(vec2f(tick, band)) - 0.5) * 0.12 * (0.3 + amount);
    }
  }

  let split = select(0.0, (0.004 + speed * 0.05) * params.strength, params.chroma > 0.5);

  // Zoom blur toward the centre, scaled by scroll speed (flying forward).
  var color = vec3f(0.0);
  if (params.zoomBlur > 0.5) {
    let blur = clamp(speed * 0.25, 0.0, 0.15) * params.strength;
    for (var i = 0; i < 10; i++) {
      let t = f32(i) / 9.0;
      color += sampleScene(0.5 + (uv - 0.5) * (1.0 - blur * t), split);
    }
    color /= 10.0;
  } else {
    color = sampleScene(uv, split);
  }

  // Halftone print: duotone dots in brand colours.
  if (params.halftone > 0.5) {
    let luma = dot(color, vec3f(0.299, 0.587, 0.114));
    let cells = 90.0;
    let p = vec2f(uv0.x * params.aspect, uv0.y) * cells;
    let rot = mat2x2f(0.7071, -0.7071, 0.7071, 0.7071);
    let f = fract(rot * p) - 0.5;
    let dotSize = sqrt(luma) * 0.62;
    let ink = smoothstep(dotSize, dotSize - 0.08, length(f));
    let printed = mix(BACKGROUND, mix(PINK, YELLOW, smoothstep(0.35, 0.85, luma)), ink);
    color = mix(color, printed, params.strength * 0.5 + 0.5);
  }

  // Vignette and film grain.
  let v = length((uv0 - 0.5) * vec2f(params.aspect, 1.0));
  color *= 1.0 - smoothstep(0.45, 1.2, v) * 0.55;
  color += (hash(uv0 * 913.0 + params.time) - 0.5) * 0.035;
  return vec4f(color, 1.0);
}
