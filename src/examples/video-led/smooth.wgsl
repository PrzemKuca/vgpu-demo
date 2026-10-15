// Temporal smoothing of the ambient zones, like a TV's ambient-light controller.
struct Params { response: f32 }

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var current: texture_2d<f32>;
@group(0) @binding(2) var history: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let now = textureSampleLevel(current, samp, uv, 0.0);
  let before = textureSampleLevel(history, samp, uv, 0.0);
  return mix(before, now, params.response);
}
