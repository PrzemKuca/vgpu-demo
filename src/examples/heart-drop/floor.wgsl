struct Camera {
  viewProjection: mat4x4f,
  eye: vec3f,
}

const MAX_PILLOWS = 16u;

struct Shadows {
  count: u32,
  radius: f32,
  centers: array<vec4f, 16>, // xyz = pillow position
}

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> shadows: Shadows;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
}

@vertex fn vs_main(@location(0) position: vec3f) -> VertexOut {
  var out: VertexOut;
  out.position = camera.viewProjection * vec4f(position, 1.0);
  out.world = position;
  return out;
}

const BACKGROUND = vec3f(0.0);

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let p = in.world.xz;

  // Subtle grid.
  let g = abs(fract(p * 2.0 - 0.5) - 0.5) / fwidth(p * 2.0);
  let line = 1.0 - min(min(g.x, g.y), 1.0);
  var color = vec3f(0.07, 0.07, 0.08) + line * 0.05;

  // Soft contact shadows that spread and fade with height.
  var light = 1.0;
  for (var i = 0u; i < min(shadows.count, MAX_PILLOWS); i++) {
    let c = shadows.centers[i].xyz;
    let height = max(c.y, 0.0);
    let spread = shadows.radius * (0.8 + height * 0.35);
    let d = length(p - c.xz) / spread;
    light *= 1.0 - (1.0 - smoothstep(0.0, 1.0, d)) * 0.75 / (1.0 + height * 0.6);
  }
  color *= light;

  // Fade into the background with distance.
  let fade = smoothstep(4.0, 14.0, length(in.world - vec3f(camera.eye.x, 0.0, camera.eye.z)));
  return vec4f(mix(color, BACKGROUND, fade), 1.0);
}
