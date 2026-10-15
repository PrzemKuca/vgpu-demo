import { simplex3d } from "@vgpu/wgsl-std/noise/simplex";

// Tooltip button reveal, rebuilt from the reference frames.
//
// Two shapes, unioned smoothly into one pink "energy" silhouette:
//   head: a big tilted ellipse riding the wave front (tilts down-right early,
//         up-right late, shrinks into a cap at the top-right corner at the end)
//   band: a thin strip riding the button's top edge behind the front
// Inside the button the colour climbs white → cream → pink from behind the
// front to ahead of it; outside it the energy is pink with a warm rim.
struct Params {
  canvasSize: vec2f, // px
  half: vec2f,       // button half size, px
  radius: f32,       // corner radius, px
  progress: f32,     // 0 hidden .. 1 revealed
  time: f32,
  glow: f32,         // size of the energy
  wobble: f32,       // gentle undulation of the outline
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var label: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

const PINK = vec3f(0.98, 0.29, 0.80);
const CREAM = vec3f(1.0, 0.96, 0.62);
const WHITE = vec3f(1.0);
const INK = vec3f(0.07, 0.07, 0.07);

fn roundedBox(p: vec2f, half: vec2f, r: f32) -> f32 {
  let q = abs(p) - half + r;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

fn smin(a: f32, b: f32, k: f32) -> f32 {
  let h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

// Pink → cream → white.
fn ramp(f: f32) -> vec3f {
  return mix(mix(PINK, CREAM, smoothstep(0.5, 0.78, f)), WHITE, smoothstep(0.78, 0.97, f));
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = (uv - 0.5) * params.canvasSize; // px, centred on the button, y down
  let half = params.half;
  let h = half.y * 2.0;
  let pr = clamp(params.progress, 0.0, 1.0);
  let t = params.time;
  let g = max(params.glow, 0.05); // scales every dimension of the energy together

  // Wave front, sweeping from the left part of the button to its right edge.
  let front = mix(-half.x + 0.2 * h, half.x + 0.3 * h, smoothstep(0.0, 0.92, pr));
  let ahead = p.x - front; // > 0 ahead of the front

  // Lifetime of the energy: grows in, then shrinks into a cap and vanishes.
  let grow = smoothstep(0.0, 0.25, pr);
  let presence = grow * (1.0 - smoothstep(0.93, 1.0, pr));

  // Gentle, very smooth undulation (single octave, low frequency).
  let wob = simplex3d(vec3f(p * 0.004, t * 0.4)) * 0.07 * h * params.wobble;

  // Head: tilted ellipse anchored on the front (so it always sits on the
  // reveal edge). At the end it docks against the right edge as an upright
  // capsule, then shrinks into a small cap at the top-right corner.
  let dock = smoothstep(0.6, 0.85, pr);    // front reaches the right edge
  let settle = smoothstep(0.82, 0.98, pr); // capsule shrinks into the corner cap
  let tilt = mix(mix(0.35, -0.55, smoothstep(0.15, 0.6, pr)), 0.0, dock); // y-down: + = down-right
  let travelling = vec2f(front + 0.3 * h * g, -0.12 * h * g);
  let docked = vec2f(half.x + 0.1 * h * g, -0.12 * h);
  let corner = vec2f(half.x + 0.04 * h * g, -half.y + 0.02 * h);
  let headCentre = mix(mix(travelling, docked, dock), corner, settle);
  let travelRadii = vec2f(1.3 * h, 0.75 * h) * g * mix(0.55, 1.0, grow);
  let dockRadii = vec2f(0.38 * h * g, half.y + 0.28 * h * g);
  let cornerRadii = vec2f(0.22, 0.3) * h * g;
  let radii = mix(mix(travelRadii, dockRadii, dock), cornerRadii, settle);
  let rel = p - headCentre;
  let c = cos(tilt);
  let s = sin(tilt);
  let rot = vec2f(c * rel.x + s * rel.y, -s * rel.x + c * rel.y);
  let head = (length(rot / radii) - 1.0) * min(radii.x, radii.y);

  // Band: a straight strip along the top edge (within the button's width),
  // thickest at the front, fading behind it and quickly ahead of it.
  let bandHeight = 0.18 * h * g
    * exp(-max(-ahead, 0.0) / (3.0 * h))
    * exp(-pow(max(ahead + 0.3 * h, 0.0) / (0.9 * h), 2.0))
    * (1.0 - dock * 0.6);
  let bandFade = bandHeight / (0.18 * h * g);
  let band = abs(p.y + half.y) - bandHeight
    + max(abs(p.x) - half.x, 0.0)
    + (1.0 - bandFade) * 0.6 * h; // faded band leaves the shape instead of a hairline

  let energySdf = smin(head, band, 0.7 * h * g) + wob * g;
  let soft = h * (0.09 + 0.07 * g); // never razor-thin, even with a small glow
  var energy = smoothstep(soft, -soft, energySdf) * presence;

  // Inside the button, independent of glow: transparent ahead of the front,
  // a soft pink leading edge, cream behind it, then white.
  let rect = roundedBox(p, half, params.radius);
  let inRect = smoothstep(0.75, -0.75, rect);
  let done = smoothstep(0.85, 1.0, pr);
  let lead = smoothstep(0.45 * h, -0.05 * h, ahead);                       // fade-in at the edge
  let fill = smoothstep(0.1 * h, -2.0 * h, ahead - p.y * 0.5);             // white behind, warmer low
  let inside = max(mix(0.5, 1.0, fill) * lead * grow, done);

  // Glow limits the spill: how far the energy may reach outside the button
  // edge and ahead of the front. Small glow → a thin halo hugging the button.
  let spill = h * max(1.4 * g * g - 0.05, 0.03); // shrinks quickly below glow ≈ 0.6
  energy *= smoothstep(spill, 0.0, max(rect, 0.0));
  energy *= smoothstep(h * (0.12 + 1.5 * g * g), 0.0, ahead);

  // Energy outside the button sits in the pink part of the ramp, warmer near the edge.
  let rim = exp(-max(rect, 0.0) / (0.05 * h * g)) * 0.15 * (1.0 - inRect) * smoothstep(0.5 * h, -0.5 * h, ahead);
  let outside = energy * (0.5 + rim);
  let f = mix(outside, max(outside, inside), inRect);

  let alpha = smoothstep(0.02, 0.45, f);
  var color = ramp(f);

  // Label, visible where the button is cream or white.
  let text = textureSampleLevel(label, samp, uv, 0.0).a * smoothstep(0.55, 0.8, f) * inRect;
  color = mix(color, INK, text);

  return vec4f(color * alpha, alpha); // premultiplied
}
