struct Camera {
  viewProjection: mat4x4f,
  eye: vec3f,
}

struct Model {
  model: mat4x4f,
  thickness: f32,
  squash: f32,   // >0 flattens toward the floor, <0 stretches up
  anchorY: f32,  // world height the squash is anchored at (lowest point)
  center: vec3f, // body centre in world space
}

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> model: Model;
@group(0) @binding(2) var art: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) side: f32, // 0 on the faces, 1 on the steep rim
}

@vertex fn vs_main(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
) -> VertexOut {
  var out: VertexOut;
  let rigid = (model.model * vec4f(position, 1.0)).xyz;

  // Soft-body squash: flatten toward the contact, bulge sideways (volume-preserving).
  let sy = 1.0 - model.squash;
  let sxz = 1.0 / sqrt(max(sy, 0.2));
  let anchor = vec3f(model.center.x, model.anchorY, model.center.z);
  let world = anchor + (rigid - anchor) * vec3f(sxz, sy, sxz);

  out.position = camera.viewProjection * vec4f(world, 1.0);
  out.world = world;
  // The model scales z by `thickness`; the normal needs the inverse scale (same for squash).
  let t = model.thickness;
  let n = (model.model * vec4f(normal.xy, normal.z / (t * t), 0.0)).xyz;
  out.normal = n / vec3f(sxz, sy, sxz);
  out.uv = uv;
  out.side = 1.0 - abs(normal.z);
  return out;
}

const KEY = vec3f(-0.45, 0.85, 0.55);
const PINK = vec3f(1.0, 0.275, 0.804);
const RIM_COLOR = vec3f(0.93, 0.78, 0.25); // matches the art's golden outline

@fragment fn fs_main(in: VertexOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  let tex = textureSample(art, samp, in.uv);
  // The rim would stretch edge texels into streaks; paint it solid instead.
  // The seam where both faces meet sits on the art's soft outline; cover it too.
  let rimMask = max(smoothstep(0.12, 0.45, in.side), 1.0 - smoothstep(0.75, 0.97, tex.a));
  let base = mix(tex.rgb / max(tex.a, 1e-3), RIM_COLOR, rimMask);

  var n = normalize(in.normal);
  if (!front) { n = -n; }
  let v = normalize(camera.eye - in.world);
  let l = normalize(KEY);

  let diffuse = max(dot(n, l), 0.0);
  let hemi = mix(0.25, 0.55, n.y * 0.5 + 0.5);
  let spec = pow(max(dot(n, normalize(l + v)), 0.0), 70.0) * 0.55;
  let rim = pow(1.0 - max(dot(n, v), 0.0), 3.0) * 0.35;

  let color = base * (hemi + diffuse * 0.8) + vec3f(spec) + PINK * rim;
  return vec4f(color, 1.0);
}
