// Minimal rigid-body world: gravity, contact impulses with restitution and
// friction against axis-aligned planes and between pillows, a spring used
// while the user drags one, and a squash spring for the soft-body look.

export type Vec3 = [number, number, number]
export type Quat = [number, number, number, number] // xyzw

export type Plane = { normal: Vec3; offset: number } // dot(p, normal) >= offset is free space

export type BodySettings = { gravity: number; bounce: number; friction: number; thickness: number; softness: number }

/** The pillow's shape: collision points on its surface and its half-thickness field. */
export type Shape = {
  hull: Float32Array // local xyz points (z unscaled by thickness)
  heightAt: (x: number, y: number) => number // half-thickness at local (x, y), 0 outside
  radius: number // bounding radius in the xy plane
}

const MASS = 1
const INERTIA = 0.35 // isotropic, roughly a 2x2 slab
const SUBSTEPS = 4
const HIT_SPEED = 0.8 // contact speed that counts as an impact
const SLOP = 0.01 // penetration tolerated before pushing pillows apart
const SLEEP_SPEED = 0.08

const add = (a: Vec3, b: Vec3, s = 1): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s]
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2])

export function rotate(q: Quat, v: Vec3): Vec3 {
  const u: Vec3 = [q[0], q[1], q[2]]
  const t = scale(cross(u, v), 2)
  return add(add(v, t, q[3]), cross(u, t))
}
const unrotate = (q: Quat, v: Vec3) => rotate([-q[0], -q[1], -q[2], q[3]], v)

function normalize(q: Quat): Quat {
  const l = Math.hypot(...q)
  return q.map((c) => c / l) as Quat
}

export class Body {
  position: Vec3
  velocity: Vec3 = [0, 0, 0]
  orientation: Quat
  spin: Vec3 // angular velocity, world space
  dragTarget: Vec3 | null = null
  squash = 0 // soft-body deformation, driven by a damped spring
  squashVelocity = 0
  lowestY = 0 // lowest hull point above the floor, the anchor for squashing
  supported = false // resting on the floor or another pillow
  impact = 0

  constructor(position: Vec3) {
    this.position = position
    const r = () => Math.random() - 0.5
    this.orientation = normalize([r() * 0.6, r() * 0.6, r() * 0.6, 1])
    this.spin = [r() * 3, r() * 2, r() * 3]
  }

  /** Inverse mass: a dragged pillow is moved by the hand, not by collisions. */
  get inverseMass() {
    return this.dragTarget ? 0 : 1 / MASS
  }
  get inverseInertia() {
    return this.dragTarget ? 0 : 1 / INERTIA
  }

  pointVelocity(r: Vec3): Vec3 {
    return add(this.velocity, cross(this.spin, r))
  }

  applyImpulse(r: Vec3, dir: Vec3, j: number) {
    this.velocity = add(this.velocity, dir, j * this.inverseMass)
    this.spin = add(this.spin, cross(r, dir), j * this.inverseInertia)
  }

  integrate(dt: number, s: BodySettings) {
    if (this.dragTarget) {
      // Critically damped follow, with sway from the motion.
      const prev = this.velocity
      this.velocity = scale(sub(this.dragTarget, this.position), 14)
      const accel = sub(this.velocity, prev)
      this.spin = add(scale(this.spin, 0.94), [accel[1] * 0.05, 0, -accel[0] * 0.08])
    } else {
      this.velocity[1] -= s.gravity * dt
    }

    this.position = add(this.position, this.velocity, dt)
    const w = this.spin
    const q = this.orientation
    this.orientation = normalize([
      q[0] + 0.5 * dt * (w[0] * q[3] + w[1] * q[2] - w[2] * q[1]),
      q[1] + 0.5 * dt * (w[1] * q[3] + w[2] * q[0] - w[0] * q[2]),
      q[2] + 0.5 * dt * (w[2] * q[3] + w[0] * q[1] - w[1] * q[0]),
      q[3] - 0.5 * dt * (w[0] * q[0] + w[1] * q[1] + w[2] * q[2]),
    ])
  }

  damp(dt: number) {
    // Air drag; rolling resistance once resting.
    this.velocity = scale(this.velocity, 1 - 0.15 * dt)
    this.spin = scale(this.spin, 1 - (this.supported ? 0.9 : 0.3) * dt)
    // Sleep: a supported pillow that barely moves settles fully instead of jittering.
    if (this.supported && !this.dragTarget && len(this.velocity) < SLEEP_SPEED && len(this.spin) < SLEEP_SPEED * 2) {
      this.velocity = scale(this.velocity, 0.5)
      this.spin = scale(this.spin, 0.5)
    }
  }

  // Pillow feel: impacts kick a damped spring; resting sags a little.
  soften(dt: number, s: BodySettings) {
    const soft = s.softness
    if (this.impact > 0) {
      this.squashVelocity += this.impact * soft * 1.6
      this.impact = 0
    }
    const rest = this.supported && !this.dragTarget ? soft * 0.08 : 0
    const stiffness = 520 - soft * 380
    const damping = 14 - soft * 9
    const accel = -stiffness * (this.squash - rest) - damping * this.squashVelocity
    this.squashVelocity += accel * dt
    this.squash = Math.min(Math.max(this.squash + this.squashVelocity * dt, -0.35), 0.6)
  }

  release() {
    this.dragTarget = null
    const speed = len(this.velocity)
    if (speed > 12) this.velocity = scale(this.velocity, 12 / speed)
    // Tumble along with the throw.
    this.spin = add(this.spin, [this.velocity[1] * 0.4, 0, -this.velocity[0] * 0.6])
  }
}

/**
 * Resolves one contact between body `a` (at world point `p`) and body `b`
 * (or the static world when `b` is null). `n` points from b toward a.
 */
function resolveContact(a: Body, b: Body | null, p: Vec3, n: Vec3, s: BodySettings) {
  const ra = sub(p, a.position)
  const rb = b ? sub(p, b.position) : ([0, 0, 0] as Vec3)
  const relative = () => sub(a.pointVelocity(ra), b ? b.pointVelocity(rb) : [0, 0, 0])
  const effectiveMass = (dir: Vec3) => {
    const ca = cross(ra, dir)
    const cb = cross(rb, dir)
    return (
      a.inverseMass +
      dot(ca, ca) * a.inverseInertia +
      (b ? b.inverseMass + dot(cb, cb) * b.inverseInertia : 0)
    )
  }

  const vn = dot(relative(), n)
  if (vn >= 0) return
  const k = effectiveMass(n)
  if (k <= 0) return
  // Only real hits squash the pillow; resting contact must stay calm.
  const hit = vn < -HIT_SPEED
  if (hit) {
    a.impact = Math.max(a.impact, -vn)
    if (b) b.impact = Math.max(b.impact, -vn)
  }

  // Pillows don't bounce off each other; floor and walls use the bounciness
  // setting (a soft body returns less energy), never for slow resting contact.
  const bounce = hit && !b ? s.bounce * (1 - 0.45 * s.softness) : 0
  const j = (-(1 + bounce) * vn) / k
  a.applyImpulse(ra, n, j)
  b?.applyImpulse(rb, n, -j)

  // Coulomb friction along the sliding direction.
  const v = relative()
  const vt = add(v, n, -dot(v, n))
  const speed = len(vt)
  if (speed > 1e-5) {
    const t = scale(vt, -1 / speed)
    const jt = Math.min(speed / effectiveMass(t), s.friction * j)
    a.applyImpulse(ra, t, jt)
    b?.applyImpulse(rb, t, -jt)
  }
}

export class World {
  bodies: Body[] = []
  planes: Plane[] = []
  private shape: Shape

  constructor(shape: Shape) {
    this.shape = shape
  }

  step(dt: number, s: BodySettings) {
    const h = Math.min(dt, 1 / 30) / SUBSTEPS
    for (let i = 0; i < SUBSTEPS; i++) {
      for (const body of this.bodies) {
        body.supported = false
        body.integrate(h, s)
        for (const plane of this.planes) this.collidePlane(body, plane, s)
      }
      for (let a = 0; a < this.bodies.length; a++)
        for (let b = a + 1; b < this.bodies.length; b++) {
          this.collidePair(this.bodies[a], this.bodies[b], s)
          this.collidePair(this.bodies[b], this.bodies[a], s)
        }
      for (const body of this.bodies) {
        body.damp(h)
        body.soften(h, s)
      }
    }
  }

  private worldHull(body: Body, thickness: number, visit: (p: Vec3) => void) {
    const hull = this.shape.hull
    for (let i = 0; i < hull.length; i += 3) {
      visit(add(body.position, rotate(body.orientation, [hull[i], hull[i + 1], hull[i + 2] * thickness])))
    }
  }

  private collidePlane(body: Body, plane: Plane, s: BodySettings) {
    const { normal: n, offset } = plane
    const isFloor = n[1] === 1
    let deepest = 0
    let lowest = Infinity
    this.worldHull(body, s.thickness, (p) => {
      const depth = dot(p, n) - offset
      lowest = Math.min(lowest, depth)
      if (depth >= 0) return
      deepest = Math.min(deepest, depth)
      resolveContact(body, null, p, n, s)
    })
    if (deepest < 0) body.position = add(body.position, n, -deepest)
    if (isFloor) {
      body.lowestY = Math.max(lowest - deepest, 0)
      if (deepest < 0) body.supported = true
    }
  }

  /** Hull points of `a` pushed out of `b`'s volume along b's face normal. */
  private collidePair(a: Body, b: Body, s: BodySettings) {
    const t = s.thickness
    const reach = this.shape.radius * 2 + 0.3 * t
    if (len(sub(a.position, b.position)) > reach) return

    let deepest = 0
    let pushNormal: Vec3 = [0, 1, 0]
    this.worldHull(a, t, (p) => {
      const local = unrotate(b.orientation, sub(p, b.position))
      const half = this.shape.heightAt(local[0], local[1]) * t
      if (half <= 1e-3) return
      const depth = half - Math.abs(local[2])
      if (depth <= 0) return
      const n = rotate(b.orientation, [0, 0, Math.sign(local[2]) || 1])
      resolveContact(a, b, p, n, s)
      if (depth > deepest) {
        deepest = depth
        pushNormal = n
      }
    })
    if (deepest <= 0) return

    // Gently remove overlap beyond a small slop, split by how free each pillow is.
    const correction = Math.max(deepest - SLOP, 0) * 0.35
    const wa = a.inverseMass
    const wb = b.inverseMass
    if (wa + wb === 0 || correction === 0) return
    a.position = add(a.position, pushNormal, (correction * wa) / (wa + wb))
    b.position = add(b.position, pushNormal, (-correction * wb) / (wa + wb))
    if (pushNormal[1] > 0.5) a.supported = true
    if (pushNormal[1] < -0.5) b.supported = true
  }
}
