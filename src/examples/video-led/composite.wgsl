struct Params {
  aspect: f32,          // canvas width / height
  videoAspect: f32,     // video width / height
  screenWidth: f32,     // TV width as a fraction of canvas height-space
  ambientOn: f32,       // 0/1
  ambientStrength: f32,
  ambientSpread: f32,   // falloff distance on the wall
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var video: texture_2d<f32>;
@group(0) @binding(2) var ambient: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

const WALL = vec3f(0.045, 0.045, 0.05);

fn roundedBox(p: vec2f, half: vec2f, r: f32) -> f32 {
  let q = abs(p) - half + r;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  // Canvas space centred on the screen, y down, height = 1.
  let q = (uv - 0.5) * vec2f(params.aspect, 1.0);
  let half = vec2f(params.screenWidth, params.screenWidth / params.videoAspect) * 0.5;
  let screenUv = q / (half * 2.0) + 0.5;

  // Wall with a soft vignette.
  var wall = WALL * (1.0 - 0.35 * length(q * vec2f(0.6, 1.0)));

  // Ambient light: the nearest screen edge zone, washing out across the wall.
  if (params.ambientOn > 0.5) {
    let edge = clamp(q, -half, half);
    let d = length(q - edge);
    let zone = clamp(edge / (half * 2.0) + 0.5, vec2f(0.03), vec2f(0.97));
    // Blur widely along the edge (and a little inward) for an even, soft spill.
    let inward = normalize(-edge + 1e-5);
    let tangent = vec2f(-inward.y, inward.x);
    var light = vec3f(0.0);
    var weight = 0.0;
    for (var i = -6; i <= 6; i++) {
      let w = exp(-f32(i * i) / 18.0);
      let o = tangent * f32(i) * 0.035 + inward * 0.06;
      light += textureSampleLevel(ambient, samp, clamp(zone + o, vec2f(0.0), vec2f(1.0)), 0.0).rgb * w;
      weight += w;
    }
    light /= weight;

    let falloff = exp(-d / params.ambientSpread) * (1.0 - smoothstep(0.0, 0.02, -roundedBox(q, half, 0.0)));
    wall += light * light * falloff * params.ambientStrength * 1.6 + light * falloff * 0.15 * params.ambientStrength;
  }

  // TV: thin bezel, contact shadow, then the picture.
  let box = roundedBox(q, half + 0.008, 0.01);
  let shadow = 1.0 - 0.5 * exp(-max(box, 0.0) * 40.0) * step(0.0, box);
  var color = wall * shadow;
  if (box < 0.0) { color = vec3f(0.012); } // bezel
  if (all(screenUv >= vec2f(0.0)) && all(screenUv <= vec2f(1.0))) {
    color = textureSampleLevel(video, samp, screenUv, 0.0).rgb;
  }
  return vec4f(color, 1.0);
}
