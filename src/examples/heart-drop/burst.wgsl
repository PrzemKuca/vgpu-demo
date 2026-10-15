// Draws every particle as a small spinning heart billboard.
struct Particle {
  posLife: vec4f,
  velMax: vec4f,
  spin: vec4f,
}

struct Camera {
  viewProjection: mat4x4f,
  right: vec3f,
  up: vec3f,
}

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<storage, read> particles: array<Particle>;
@group(0) @binding(2) var art: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) fade: f32,
}

@vertex fn vs_main(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VertexOut {
  var corners = array<vec2f, 6>(
    vec2f(-0.5, -0.5), vec2f(0.5, -0.5), vec2f(-0.5, 0.5),
    vec2f(-0.5, 0.5), vec2f(0.5, -0.5), vec2f(0.5, 0.5),
  );
  var out: VertexOut;
  let p = particles[ii];
  let life = p.posLife.w;
  if (life <= 0.0) {
    out.position = vec4f(2.0, 2.0, 2.0, 1.0); // outside the clip volume
    return out;
  }

  // Pop in quickly, shrink and fade over the last second.
  let age = p.velMax.w - life;
  let fade = smoothstep(0.0, 1.0, life) * smoothstep(0.0, 0.12, age);
  let c = corners[vi];
  let a = p.spin.x;
  let rotated = vec2f(c.x * cos(a) - c.y * sin(a), c.x * sin(a) + c.y * cos(a));
  let size = p.spin.z * (0.4 + 0.6 * fade);
  let world = p.posLife.xyz + (camera.right * rotated.x + camera.up * rotated.y) * size;

  out.position = camera.viewProjection * vec4f(world, 1.0);
  out.uv = vec2f(c.x + 0.5, 0.5 - c.y);
  out.fade = fade;
  return out;
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let tex = textureSample(art, samp, in.uv); // premultiplied
  if (tex.a < 0.02) { discard; }
  return tex * in.fade;
}
