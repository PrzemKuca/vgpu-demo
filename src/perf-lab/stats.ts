// Main-thread measurements: rAF frame intervals, long tasks, and CPU/GPU work
// reported by the renderers.

export type Window = {
  durationMs: number
  frames: number
  fps: number
  p50: number
  p95: number
  p99: number
  /** Share of frames that took longer than 1.5× the display refresh interval. */
  dropped: number
  /** JS time spent in the render callbacks, per frame. */
  cpuMs: number
  /** Canvas pixels shaded per frame, in megapixels. */
  mpx: number
  /** GPU pass time summed over all canvases, per frame (undefined without timestamp-query). */
  gpuMs?: number
  longTasks: number
  /** Σ(longTask − 50 ms), the Lighthouse TBT formula applied to the window. */
  blockingMs: number
  heapMb?: number
}

const quantile = (sorted: number[], q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0)

type LongTask = { start: number; duration: number }
const longTasks: LongTask[] = []
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) longTasks.push({ start: e.startTime, duration: e.duration })
    if (longTasks.length > 2000) longTasks.splice(0, 1000)
  }).observe({ type: 'longtask', buffered: true })
} catch {
  // Long Tasks API is Chromium-only.
}

export function blockingBetween(from: number, to: number) {
  let count = 0
  let blocking = 0
  for (const t of longTasks) {
    if (t.start < from || t.start > to) continue
    count++
    blocking += Math.max(0, t.duration - 50)
  }
  return { count, blocking }
}

/**
 * Renderers add their cost here. CPU time is divided by presented frames; GPU
 * time is averaged per device over the frames its timer reported (readbacks
 * can skip frames), then summed over devices.
 */
export const work = { cpuMs: 0, px: 0, gpu: new Set<{ ms: number; n: number }>() }

function gpuPerFrame() {
  let sum = 0
  let any = false
  work.gpu.forEach((g) => {
    if (!g.n) return
    sum += g.ms / g.n
    any = true
  })
  return any ? sum : undefined
}

export function createSampler() {
  let deltas: number[] = []
  let last = 0
  let start = 0
  let raf = 0
  const tick = (now: number) => {
    if (last) deltas.push(now - last)
    last = now
    raf = requestAnimationFrame(tick)
  }

  return {
    start() {
      cancelAnimationFrame(raf)
      deltas = []
      last = 0
      start = performance.now()
      work.cpuMs = work.px = 0
      work.gpu.forEach((g) => (g.ms = g.n = 0))
      raf = requestAnimationFrame(tick)
    },
    /** Snapshot of everything since start(); keeps sampling. */
    read(refreshMs: number): Window {
      const now = performance.now()
      const sorted = [...deltas].sort((a, b) => a - b)
      const total = deltas.reduce((a, b) => a + b, 0)
      const frames = deltas.length
      const { count, blocking } = blockingBetween(start, now)
      const memory = (performance as any).memory?.usedJSHeapSize as number | undefined
      return {
        durationMs: now - start,
        frames,
        fps: frames ? (1000 * frames) / total : 0,
        p50: quantile(sorted, 0.5),
        p95: quantile(sorted, 0.95),
        p99: quantile(sorted, 0.99),
        dropped: frames ? deltas.filter((d) => d > refreshMs * 1.5).length / frames : 0,
        cpuMs: frames ? work.cpuMs / frames : 0,
        mpx: frames ? work.px / frames / 1e6 : 0,
        gpuMs: gpuPerFrame(),
        longTasks: count,
        blockingMs: blocking,
        heapMb: memory ? memory / 1048576 : undefined,
      }
    },
    stop() {
      cancelAnimationFrame(raf)
    },
  }
}

/** Median rAF interval over ~0.5 s: the display refresh the frame budget is measured against. */
export async function measureRefresh() {
  const deltas: number[] = []
  let last = 0
  await new Promise<void>((done) => {
    const tick = (now: number) => {
      if (last) deltas.push(now - last)
      last = now
      if (deltas.length < 30) requestAnimationFrame(tick)
      else done()
    }
    requestAnimationFrame(tick)
  })
  return deltas.sort((a, b) => a - b)[deltas.length >> 1]
}
