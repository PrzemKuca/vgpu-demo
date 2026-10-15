// N copies of one effect on a page, rendered with one of three strategies.
//
//   naive       what the demos do: every tile owns a device (init()), its own
//               resources and its own loop, and renders every frame.
//   shared      one device and one loop for all tiles, still every tile every frame.
//   production  one device, created lazily; a tile gets its GPU resources when it
//               first nears the viewport and is drawn only while visible and
//               animating. An <img> poster covers the time before the first frame.
import { frame, init, surface } from 'vgpu'
import type { Effect, Gpu, Surface } from 'vgpu'
import { FX, type FxKind } from './effects'
import { work } from './stats'
import { renderTiles } from './tiles'
import { createFrameSpan } from './gpu-span'

export type Strategy = 'naive' | 'shared' | 'production'

export const STRATEGIES: Record<Strategy, { title: string; tagline: string; analogy: string; summary: string; how: string[] }> = {
  naive: {
    title: 'Naive (as in demos)',
    tagline: 'Every effect brings its own engine.',
    analogy: 'Like giving every picture on the wall its own projector, all switched on all the time — even in rooms nobody is in.',
    summary: 'Every effect is a self-contained component, exactly like the demo pages. Simple to drop in, but every cost is paid once per instance.',
    how: [
      'Each instance calls init(), so it gets its own GPUDevice: its own shader pipelines (compiled N times), its own copy of every texture and its own command queue.',
      'Each instance runs its own requestAnimationFrame loop and submits its own command buffer every frame.',
      'It renders every frame, even when it is scrolled off-screen or nothing is animating.',
      'Cost grows linearly with the number of instances; browsers can also refuse or drop devices when a page creates many of them.',
    ],
  },
  shared: {
    title: 'Shared device',
    tagline: 'One engine powers all effects.',
    analogy: 'One projector serves every picture — but it still lights up all of them, all the time.',
    summary: 'All canvases on the page share one GPUDevice and one frame loop. Startup, memory and JS cost drop; the GPU still draws every tile every frame.',
    how: [
      'One init() for the whole page; every canvas is a surface of that device.',
      'Shaders compile once (the pipeline is cached and reused by every tile) and textures upload once.',
      'One requestAnimationFrame loop encodes a pass per canvas into a single command buffer and submits once per frame.',
      'Still renders every tile every frame, so the GPU workload is the same as Naive.',
    ],
  },
  production: {
    title: 'Production',
    tagline: 'One engine, and only what you can see moves.',
    analogy: 'The projector lights only the pictures in front of you, and only while they move. Everything else shows a still photo.',
    summary: 'Shared device plus doing nothing that the visitor cannot see. This is the setup recommended for real pages.',
    how: [
      'The page ships plain HTML first: every tile is an <img> poster, which is what Lighthouse scores as LCP and what visitors without WebGPU keep seeing.',
      'vgpu (~67 KB gzip with the shaders) is loaded with a dynamic import() only after the load event and an idle callback, so it never competes with the first paint.',
      'An IntersectionObserver gives a tile its GPU resources only when it first comes within 200 px of the viewport.',
      'A tile is drawn only while it is visible and animating (or needs one repaint after a resize). An idle canvas keeps showing its last frame and costs the GPU nothing.',
      'Same shared device and single loop as Shared device.',
    ],
  },
}

/** Side-by-side comparison, one row per difference. */
export const STRATEGY_MATRIX: [string, Record<Strategy, string>][] = [
  ['GPU connections (devices)', { naive: 'one per effect', shared: 'one', production: 'one' }],
  ['Shader compiled / images uploaded', { naive: 'once per effect', shared: 'once', production: 'once' }],
  ['Animation loops', { naive: 'one per effect', shared: 'one', production: 'one' }],
  ['Draws effects scrolled out of view', { naive: 'yes', shared: 'yes', production: 'no' }],
  ['Draws effects that are standing still', { naive: 'every frame', shared: 'every frame', production: 'once, then stops' }],
  ['GPU set up for effects never scrolled to', { naive: 'yes', shared: 'yes', production: 'no' }],
  ['When the vgpu code loads', { naive: 'with the page', shared: 'with the page', production: 'after the page has loaded' }],
  ['Good for', { naive: 'one hero effect, demos', shared: 'a few effects always in view', production: 'real pages with many effects' }],
]

export type FieldOptions = {
  fx: FxKind
  count: number
  strategy: Strategy
  /** Upper bound for the canvas device pixel ratio. */
  dprMax: number
  /** Share of tiles playing their animation at any moment (0..1). */
  activity: number
  /** Play every animating tile in step instead of staggered. */
  synced?: boolean
  gpuTiming: boolean
  /** Slower-hardware emulation: draw every tile this many times per frame (GPU) and stretch the frame's JS by this factor (CPU). */
  load?: Load
  /** Scroll container the tiles live in; null = the viewport. */
  root?: HTMLElement | null
  /** production only: wait for this before creating the device. */
  defer?: Promise<unknown>
}

export type Load = { gpu: number; cpu: number }

export type InitReport = {
  devices: number
  tilesReady: number
  failed: number
  error?: string
  /** ms from mount: device(s) created, shared resources uploaded, first frame of the initially visible tiles done on the GPU. */
  deviceMs: number
  resourcesMs: number
  firstFrameMs: number
  gpuTiming: boolean
}

type Tile = {
  index: number
  el: HTMLElement
  canvas: HTMLCanvasElement
  poster?: HTMLImageElement
  visible: boolean
  claimed: boolean
  drawn: boolean
  phase: number
  dirty: boolean
  surf?: Surface
  draw?: (progress: number, time: number) => Effect
  group?: Group
}

type Group = {
  gpu: Gpu
  res: unknown
  span?: ReturnType<typeof createFrameSpan>
  stat?: { ms: number; n: number }
  tiles: Tile[]
}

const PERIOD = 3.2 // seconds per show/hide cycle of an active tile
const cycle = (t: number) => {
  const x = ((t % PERIOD) + PERIOD) % PERIOD
  if (x < 1) return x
  if (x < 1.6) return 1
  if (x < 2.6) return 2.6 - x
  return 0
}

let timestampSupport: Promise<boolean> | undefined
const supportsTimestamps = () =>
  (timestampSupport ??= navigator.gpu
    ? navigator.gpu.requestAdapter().then((a) => !!a?.features.has('timestamp-query'), () => false)
    : Promise.resolve(false))

export function mountField(container: HTMLElement, opts: FieldOptions) {
  const def = FX[opts.fx]
  const t0 = performance.now()
  let disposed = false
  let activity = opts.activity
  let load: Load = opts.load ?? { gpu: 1, cpu: 1 }
  // Synced tiles share one cycle that starts when syncing was switched on.
  let syncedAt: number | undefined = opts.synced ? performance.now() / 1000 : undefined
  const groups: Group[] = []
  const report: InitReport = { devices: 0, tilesReady: 0, failed: 0, deviceMs: 0, resourcesMs: 0, firstFrameMs: 0, gpuTiming: false }

  // Reuse server/pre-rendered markup when it matches, otherwise render it now.
  if (container.querySelectorAll(':scope > .fx-tile').length !== opts.count) renderTiles(container, opts.fx, opts.count)
  const tiles: Tile[] = [...container.querySelectorAll<HTMLElement>(':scope > .fx-tile')].map((el, index) => ({
    index,
    el,
    canvas: el.querySelector('canvas')!,
    poster: el.querySelector('img') ?? undefined,
    visible: false,
    claimed: false,
    drawn: false,
    // Golden-ratio spread so "25 % active" picks every 4th-ish tile, not the first quarter.
    phase: (index * 0.618034) % 1,
    dirty: true,
  }))
  const isActive = (t: Tile) => t.phase < activity
  const progressOf = (t: Tile, now: number) => {
    if (!isActive(t)) return def.rest
    const c = cycle(syncedAt === undefined ? now + t.phase * PERIOD : now - syncedAt)
    return def.rest === 0 ? c : 1 - c
  }

  const makeGroup = async (timing: boolean): Promise<Group> => {
    const gpu = await init(timing ? { requiredFeatures: ['timestamp-query'] } : {})
    if (disposed) {
      gpu.dispose() // the field was torn down while this device was being created
      throw new Error('disposed')
    }
    report.devices++
    const group: Group = { gpu, res: undefined, tiles: [] }
    if (timing) {
      const stat = (group.stat = { ms: 0, n: 0 })
      work.gpu.add(stat)
      group.span = createFrameSpan(gpu.gpu, (ms) => {
        stat.ms += ms
        stat.n++
      })
    }
    groups.push(group)
    return group
  }

  const attach = async (tile: Tile, group: Group) => {
    if (disposed) return
    tile.group = group
    tile.surf = surface(group.gpu, tile.canvas, { dpr: [1, opts.dprMax], alphaMode: 'premultiplied' })
    tile.surf.onResize(() => (tile.dirty = true))
    tile.draw = def.create(group.gpu, group.res)
    await tile.draw(def.rest, 0).compile(tile.surf)
    group.tiles.push(tile)
    report.tilesReady++
  }

  const fail = (err: unknown) => {
    if (disposed) return
    report.failed++
    report.error ??= err instanceof Error ? err.message : String(err)
    console.error(err)
  }

  // One rAF for everything; each group submits one frame with a pass per drawn tile.
  let raf = 0
  const firstFrames: Promise<void>[] = []
  const tick = () => {
    raf = requestAnimationFrame(tick)
    const start = performance.now()
    const now = start / 1000
    let ballastMs = 0 // JS spent encoding the emulation passes; not charged to the effect
    for (const group of groups) {
      let f: ReturnType<typeof frame> | undefined
      let timed = false
      for (const tile of group.tiles) {
        const drawIt = opts.strategy === 'production' ? tile.visible && (tile.dirty || isActive(tile)) : true
        if (!drawIt || !tile.surf || !tile.draw) continue
        try {
          if (!f) {
            timed = group.span?.begin() ?? false
            f = frame(group.gpu)
          }
          const fx = tile.draw(progressOf(tile, now), now)
          // GPU emulation: the same pass k times; each clears, so the image is unchanged and the GPU does k× the work.
          if (load.gpu > 1) {
            const b = performance.now()
            for (let i = 1; i < load.gpu; i++) f.pass({ target: tile.surf, clear: [0, 0, 0, 0] }, fx)
            ballastMs += performance.now() - b
          }
          f.pass({ target: tile.surf, clear: [0, 0, 0, 0] }, fx)
          work.px += tile.surf.size[0] * tile.surf.size[1]
          if (!tile.drawn) {
            tile.drawn = true
            const poster = tile.poster
            firstFrames.push(f.done.then(() => poster?.remove()))
          }
          tile.dirty = false
        } catch (err) {
          fail(err)
          group.tiles.splice(group.tiles.indexOf(tile), 1)
        }
      }
      if (f) {
        f.submit()
        if (timed) group.span!.end()
      } else if (group.stat) group.stat.n++ // an idle frame costs the GPU nothing
    }
    // CPU emulation: busy-wait so the effect's own JS takes cpu× as long, like a slower processor.
    const own = performance.now() - start - ballastMs
    if (load.cpu > 1) {
      const until = performance.now() + own * (load.cpu - 1)
      while (performance.now() < until);
    }
    work.cpuMs += own * load.cpu
  }

  // Two observers: tiles within 200 px of the viewport get their GPU resources early,
  // but only tiles actually on screen are drawn.
  let observed = 0
  const tileOf = (e: IntersectionObserverEntry) => tiles[Number((e.target as HTMLElement).dataset.index)]
  const nearby = new IntersectionObserver((entries) => entries.forEach((e) => e.isIntersecting && wake(tileOf(e))), {
    root: opts.root ?? null,
    rootMargin: '200px 0px',
  })
  const visibility = new IntersectionObserver(
    (entries) => {
      observed += entries.length
      for (const e of entries) {
        const tile = tileOf(e)
        tile.visible = e.isIntersecting
        if (tile.visible) {
          tile.dirty = true
          wake(tile)
        }
      }
    },
    { root: opts.root ?? null },
  )
  tiles.forEach((t) => {
    t.el.dataset.index = String(t.index)
    nearby.observe(t.el)
    visibility.observe(t.el)
  })

  // production: device on first need, a tile's resources when it first nears the viewport.
  let shared: Promise<Group> | undefined
  const wake = (tile: Tile) => {
    if (opts.strategy !== 'production' || tile.claimed || disposed) return
    tile.claimed = true
    shared ??= (async () => {
      await opts.defer
      const timing = opts.gpuTiming && (await supportsTimestamps())
      report.gpuTiming = timing
      const g = await makeGroup(timing)
      report.deviceMs = performance.now() - t0
      g.res = await def.load(g.gpu)
      report.resourcesMs = performance.now() - t0
      return g
    })()
    shared.then((g) => (disposed ? undefined : attach(tile, g))).catch(fail)
  }

  const ready = (async (): Promise<InitReport> => {
    raf = requestAnimationFrame(tick)
    // Frame spans of separate devices overlap on the GPU and can't be added up, so naive goes untimed.
    const timing = opts.strategy !== 'naive' && opts.gpuTiming && (await supportsTimestamps())
    report.gpuTiming = timing
    if (opts.strategy === 'shared') {
      const g = await makeGroup(timing)
      report.deviceMs = performance.now() - t0
      g.res = await def.load(g.gpu)
      report.resourcesMs = performance.now() - t0
      await Promise.all(tiles.map((t) => attach(t, g).catch(fail)))
    } else if (opts.strategy === 'naive') {
      // Every tile is an independent component, mounted at the same time.
      const made = await Promise.all(tiles.map((t) => makeGroup(timing).then((g) => [t, g] as const, fail)))
      report.deviceMs = performance.now() - t0
      await Promise.all(made.map(async (m) => m && (m[1].res = await def.load(m[1].gpu).catch(fail))))
      report.resourcesMs = performance.now() - t0
      await Promise.all(made.map((m) => m && m[1].res && attach(m[0], m[1]).catch(fail)))
    } else {
      // Wait for the observer's first report, then for the visible tiles to attach.
      await waitFor(() => observed >= tiles.length || disposed)
      if (shared) await shared.catch(() => {})
      await waitFor(() => tiles.every((t) => !t.visible || t.surf) || report.failed > 0 || disposed)
    }
    const needed = (t: Tile) => !!t.surf && (opts.strategy !== 'production' || t.visible)
    await waitFor(() => tiles.every((t) => !needed(t) || t.drawn) || disposed)
    await Promise.all(firstFrames)
    report.firstFrameMs = performance.now() - t0
    return report
  })()

  return {
    ready,
    tiles: () => tiles.length,
    setSynced(on: boolean) {
      syncedAt = on ? performance.now() / 1000 : undefined
    },
    setLoad(value: Load) {
      load = value
    },
    setActivity(value: number) {
      activity = value
      tiles.forEach((t) => (t.dirty = true))
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(raf)
      visibility.disconnect()
      nearby.disconnect()
      for (const g of groups) {
        if (g.stat) work.gpu.delete(g.stat)
        g.gpu.dispose()
      }
      container.replaceChildren()
    },
  }
}

const waitFor = (cond: () => boolean) =>
  new Promise<void>((done) => {
    const check = () => (cond() ? done() : requestAnimationFrame(check))
    check()
  })
