// One textured card in the depth corridor, with optional depth-of-field blur and fog.
struct Camera {
  viewProjection: mat4x4f,
}

struct Layer {
  model: mat4x4f,
  opacity: f32,
  coc: f32,    // blur radius in uv units (circle of confusion)
  fog: f32,    // 0..1 mix toward the fog colour
  aspect: f32, // card width / height, keeps the blur round
  corner: f32, // corner radius in uv units (0 for text)
}

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> layer: Layer;
@group(0) @binding(2) var art: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOut {
  var corners = array<vec2f, 6>(
    vec2f(-0.5, -0.5), vec2f(0.5, -0.5), vec2f(-0.5, 0.5),
    vec2f(-0.5, 0.5), vec2f(0.5, -0.5), vec2f(0.5, 0.5),
  );
  let c = corners[vi];
  var out: VertexOut;
  out.position = camera.viewProjection * layer.model * vec4f(c, 0.0, 1.0);
  out.uv = vec2f(c.x + 0.5, 0.5 - c.y);
  return out;
}

const FOG = vec3f(0.16, 0.05, 0.13);
const GOLDEN = 2.39996323;

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  var color = textureSample(art, samp, in.uv);
  // Bokeh-ish disk blur on a golden-angle spiral.
  if (layer.coc > 0.0005) {
    var sum = color;
    for (var i = 1; i < 20; i++) {
      let r = sqrt(f32(i) / 20.0) * layer.coc;
      let a = f32(i) * GOLDEN;
      let o = vec2f(cos(a), sin(a) * layer.aspect) * r;
      sum += textureSampleLevel(art, samp, in.uv + o, 0.0);
    }
    color = sum / 20.0;
  }

  // Rounded corners for photo cards.
  if (layer.corner > 0.0) {
    let p = (in.uv - 0.5) * vec2f(layer.aspect, 1.0);
    let half = vec2f(layer.aspect, 1.0) * 0.5;
    let q = abs(p) - half + layer.corner;
    let d = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - layer.corner;
    color *= 1.0 - smoothstep(-0.004, 0.002, d);
  }

  // Premultiplied: fog tints the covered part only.
  let rgb = mix(color.rgb, FOG * color.a, layer.fog);
  return vec4f(rgb, color.a) * layer.opacity;
}
