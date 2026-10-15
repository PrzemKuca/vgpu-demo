// Builds an "inflated" 3D mesh from an image's alpha channel: the silhouette
// becomes a pillow with a rounded rim, textured on both faces.

export type InflatedMesh = {
  vertices: Float32Array<ArrayBuffer> // position.xyz, normal.xyz, uv.xy
  indices: Uint32Array<ArrayBuffer>
  hull: Float32Array // sparse surface points (xyz), for collisions
  heightAt: (x: number, y: number) => number // half-thickness at local (x, y), 0 outside
  radius: number // bounding radius of the silhouette
  size: number // world-space width/height of the image square
}

const GRID = 160 // cells per side
const SIZE = 2 // world units covered by the image
const RIM = 0.32 // distance over which the rim rounds off
const DEPTH = 0.26 // half-thickness at the flat core
const DOME = 0.06 // extra bulge toward the centre

export function inflate(image: CanvasImageSource): InflatedMesh {
  const n = GRID + 1
  const canvas = new OffscreenCanvas(n, n)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(image, 0, 0, n, n)
  const alpha = ctx.getImageData(0, 0, n, n).data

  const inside = new Uint8Array(n * n)
  for (let i = 0; i < n * n; i++) inside[i] = alpha[i * 4 + 3] >= 128 ? 1 : 0

  // Chamfer distance transform: distance (in cells) to the nearest outside vertex.
  const dist = new Float32Array(n * n)
  for (let i = 0; i < n * n; i++) dist[i] = inside[i] ? 1e9 : 0
  const D = Math.SQRT2
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = y * n + x
      if (!dist[i]) continue
      if (x > 0) dist[i] = Math.min(dist[i], dist[i - 1] + 1)
      if (y > 0) {
        dist[i] = Math.min(dist[i], dist[i - n] + 1)
        if (x > 0) dist[i] = Math.min(dist[i], dist[i - n - 1] + D)
        if (x < n - 1) dist[i] = Math.min(dist[i], dist[i - n + 1] + D)
      }
    }
  for (let y = n - 1; y >= 0; y--)
    for (let x = n - 1; x >= 0; x--) {
      const i = y * n + x
      if (!dist[i]) continue
      if (x < n - 1) dist[i] = Math.min(dist[i], dist[i + 1] + 1)
      if (y < n - 1) {
        dist[i] = Math.min(dist[i], dist[i + n] + 1)
        if (x < n - 1) dist[i] = Math.min(dist[i], dist[i + n + 1] + D)
        if (x > 0) dist[i] = Math.min(dist[i], dist[i + n - 1] + D)
      }
    }

  const cell = SIZE / GRID
  let maxDist = 0
  for (let i = 0; i < n * n; i++) if (inside[i]) maxDist = Math.max(maxDist, dist[i])

  // Height profile: quarter-circle rim, flat core, gentle dome.
  const height = new Float32Array(n * n)
  for (let i = 0; i < n * n; i++) {
    if (!inside[i]) continue
    const d = (dist[i] - 0.5) * cell
    const r = Math.min(Math.max(d, 0) / RIM, 1)
    height[i] = DEPTH * Math.sqrt(1 - (1 - r) * (1 - r)) + DOME * (dist[i] / maxDist)
  }
  // Smooth out the stair-steps of the grid distance field (keeps the outline at 0).
  for (let pass = 0; pass < 4; pass++) {
    const src = height.slice()
    for (let y = 1; y < n - 1; y++)
      for (let x = 1; x < n - 1; x++) {
        const i = y * n + x
        if (!inside[i]) continue
        height[i] =
          (src[i] * 4 + src[i - 1] + src[i + 1] + src[i - n] + src[i + n]) / 8 +
          (src[i - n - 1] + src[i - n + 1] + src[i + n - 1] + src[i + n + 1] - src[i] * 4) / 32
      }
  }
  const h = (x: number, y: number) => height[Math.min(n - 1, Math.max(0, y)) * n + Math.min(n - 1, Math.max(0, x))]

  // Two layers of the full vertex grid: front (+z), back (-z).
  const vertices = new Float32Array(2 * n * n * 8)
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = y * n + x
      const px = (x / GRID - 0.5) * SIZE
      const py = (0.5 - y / GRID) * SIZE
      const hx = Math.max(-8, Math.min(8, (h(x + 1, y) - h(x - 1, y)) / (2 * cell)))
      const hy = Math.max(-8, Math.min(8, (h(x, y - 1) - h(x, y + 1)) / (2 * cell)))
      for (const side of [1, -1]) {
        const o = ((side === 1 ? 0 : n * n) + i) * 8
        const len = Math.hypot(hx, hy, 1)
        vertices.set([px, py, side * height[i], -hx / len, -hy / len, side / len, x / GRID, y / GRID], o)
      }
    }

  // Snap outline vertices (outside, next to the shape) onto the alpha = 0.5
  // contour, so front and back meet exactly on the silhouette with no gap.
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = y * n + x
      if (inside[i]) continue
      const ao = alpha[i * 4 + 3] / 255
      let sx = 0
      let sy = 0
      let count = 0
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= n || ny >= n || !inside[ny * n + nx]) continue
          const ai = alpha[(ny * n + nx) * 4 + 3] / 255
          const t = Math.min(Math.max((0.5 - ao) / Math.max(ai - ao, 1e-3), 0), 1)
          sx += x + dx * t
          sy += y + dy * t
          count++
        }
      if (!count) continue
      const gx = sx / count
      const gy = sy / count
      // Outward direction: from the contour point away from the shape.
      let ox = x - gx
      let oy = gy - y
      const ol = Math.hypot(ox, oy) || 1
      ox /= ol
      oy /= ol
      for (const o of [i * 8, (n * n + i) * 8]) {
        vertices.set([(gx / GRID - 0.5) * SIZE, (0.5 - gy / GRID) * SIZE, 0, ox, oy, 0, gx / GRID, gy / GRID], o)
      }
    }

  // Triangulate every cell touching the silhouette.
  const idx: number[] = []
  const back = n * n
  for (let y = 0; y < GRID; y++)
    for (let x = 0; x < GRID; x++) {
      const a = y * n + x
      const b = a + n
      const c = a + 1
      const d = b + 1
      if (!(inside[a] || inside[b] || inside[c] || inside[d])) continue
      idx.push(a, b, c, c, b, d)
      idx.push(back + a, back + c, back + b, back + c, back + d, back + b)
    }

  // Sparse hull for collisions: interior samples on both faces plus the outline.
  const hull: number[] = []
  const step = 8
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = y * n + x
      if (!inside[i]) continue
      const px = (x / GRID - 0.5) * SIZE
      const py = (0.5 - y / GRID) * SIZE
      const onEdge = dist[i] <= 1.5
      if (onEdge ? (x + y) % 3 === 0 : x % step === 0 && y % step === 0) {
        hull.push(px, py, height[i])
        if (!onEdge) hull.push(px, py, -height[i])
      }
    }

  // Bilinear lookup of the half-thickness field in local coordinates.
  const heightAt = (px: number, py: number) => {
    const gx = (px / SIZE + 0.5) * GRID
    const gy = (0.5 - py / SIZE) * GRID
    if (gx < 0 || gy < 0 || gx >= GRID || gy >= GRID) return 0
    const x0 = Math.floor(gx)
    const y0 = Math.floor(gy)
    const fx = gx - x0
    const fy = gy - y0
    const top = height[y0 * n + x0] * (1 - fx) + height[y0 * n + x0 + 1] * fx
    const bottom = height[(y0 + 1) * n + x0] * (1 - fx) + height[(y0 + 1) * n + x0 + 1] * fx
    return top * (1 - fy) + bottom * fy
  }

  let radius = 0
  for (let i = 0; i < hull.length; i += 3) radius = Math.max(radius, Math.hypot(hull[i], hull[i + 1]))

  return { vertices, indices: new Uint32Array(idx), hull: new Float32Array(hull), heightAt, radius, size: SIZE }
}
