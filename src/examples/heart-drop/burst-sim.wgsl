// GPU particle physics for the heart burst: spawning, gravity, drag,
// floor bounces and lifetime, one invocation per particle.
struct Particle {
  posLife: vec4f,  // xyz position, w remaining life (s); <= 0 means dead
  velMax: vec4f,   // xyz velocity, w total life (for fading)
  spin: vec4f,     // x angle, y angular velocity, z size, w seed
}

struct Sim {
  origin: vec3f,     // burst centre for this frame's spawns
  dt: f32,
  gravity: f32,
  time: f32,
  spawnStart: u32,   // first ring-buffer slot to (re)spawn
  spawnCount: u32,   // how many slots to spawn this frame
  capacity: u32,
}

@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;

fn hash(n: f32) -> f32 {
  return fract(sin(n * 12.9898 + 78.233) * 43758.5453);
}

@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= sim.capacity) { return; }
  var p = particles[i];

  let slot = (i + sim.capacity - sim.spawnStart) % sim.capacity;
  if (slot < sim.spawnCount) {
    // Spawn: random direction biased upward, random speed, spin and size.
    let s = f32(i) * 1.37 + sim.time * 91.0;
    let theta = hash(s) * 6.2831853;
    let up = 0.35 + hash(s + 1.0) * 0.65;
    let ring = sqrt(1.0 - up * up);
    let dir = vec3f(cos(theta) * ring, up, sin(theta) * ring);
    let speed = 3.0 + hash(s + 2.0) * 6.0;
    let life = 2.5 + hash(s + 3.0) * 1.5;
    p.posLife = vec4f(sim.origin + dir * 0.15, life);
    p.velMax = vec4f(dir * speed, life);
    p.spin = vec4f(hash(s + 4.0) * 6.28, (hash(s + 5.0) - 0.5) * 14.0, 0.07 + hash(s + 6.0) * 0.1, hash(s + 7.0));
    particles[i] = p;
    return;
  }

  if (p.posLife.w <= 0.0) { return; }
  let dt = sim.dt;
  var vel = p.velMax.xyz;
  vel.y -= sim.gravity * dt;
  vel *= 1.0 - 0.9 * dt; // light hearts flutter: strong air drag
  var pos = p.posLife.xyz + vel * dt;

  // Floor: small bounce, friction, spin slows down.
  let radius = p.spin.z * 0.5;
  if (pos.y < radius) {
    pos.y = radius;
    if (vel.y < 0.0) { vel.y = -vel.y * 0.3; }
    vel.x *= 0.85;
    vel.z *= 0.85;
    p.spin.y *= 0.85;
  }

  p.spin.x += p.spin.y * dt;
  p.posLife = vec4f(pos, p.posLife.w - dt);
  p.velMax = vec4f(vel, p.velMax.w);
  particles[i] = p;
}
