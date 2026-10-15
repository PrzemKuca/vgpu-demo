// Averages the video into a tiny target: one texel per ambient "LED zone".
@group(0) @binding(0) var video: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

@fragment fn fs_main(@location(0) uv: vec2f, @builtin(position) pos: vec4f) -> @location(0) vec4f {
  let cell = 1.0 / vec2f(48.0, 27.0);
  var sum = vec3f(0.0);
  for (var y = 0; y < 4; y++) {
    for (var x = 0; x < 4; x++) {
      let o = (vec2f(f32(x), f32(y)) + 0.5) / 4.0 - 0.5;
      sum += textureSampleLevel(video, samp, uv + o * cell, 0.0).rgb;
    }
  }
  return vec4f(sum / 16.0, 1.0);
}
