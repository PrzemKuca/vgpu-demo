// Landing-like page with N effect cards, driven by query params, for
// Lighthouse and the runtime measurements in scripts/lighthouse.mjs:
//   bench.html?fx=smoke&count=8&strategy=production&activity=0&dpr=2
// strategy=none renders the same page with static images and no WebGPU.
import './bench.css'
import { FX_META, type FxKind } from './perf-lab/meta'
import type { Strategy } from './perf-lab/field'
import { renderTiles } from './perf-lab/tiles'
import { createSampler, measureRefresh } from './perf-lab/stats'

const q = new URLSearchParams(location.search)
const fx = (q.get('fx') ?? 'smoke') as FxKind
const count = Number(q.get('count') ?? 8)
const strategy = (q.get('strategy') ?? 'production') as Strategy | 'none'
const activity = Number(q.get('activity') ?? 0)
const dprMax = Number(q.get('dpr') ?? 2)
const def = FX_META[fx]

const root = document.querySelector<HTMLElement>('#bench')!
root.innerHTML = `
  <header>
    <h1>Ideas that move people</h1>
    <p>A landing page with ${count} interactive ${def.title.toLowerCase()} cards. Strategy: <b>${strategy}</b>.</p>
  </header>
  <section class="cards"></section>
`
const cards = root.querySelector<HTMLElement>('.cards')!

const sampler = createSampler()
const bench = {
  ready: Promise.resolve<unknown>(null),
  async measure(ms: number) {
    const refreshMs = await measureRefresh()
    sampler.start()
    await new Promise((r) => setTimeout(r, ms))
    return { refreshMs, ...sampler.read(refreshMs) }
  },
  setActivity: (_: number) => {},
}
;(window as any).__bench = bench

renderTiles(cards, fx, count)
if (strategy !== 'none') {
  // production also defers loading vgpu itself until the page has loaded and gone idle.
  const idle = () =>
    new Promise<void>((r) => {
      const go = () => ('requestIdleCallback' in window ? requestIdleCallback(() => r(), { timeout: 2000 }) : setTimeout(r, 200))
      document.readyState === 'complete' ? go() : addEventListener('load', go, { once: true })
    })
  bench.ready = (async () => {
    if (strategy === 'production') await idle()
    const { mountField } = await import('./perf-lab/field')
    const field = mountField(cards, { fx, count, strategy, dprMax, activity, gpuTiming: q.has('gpuTiming') })
    bench.setActivity = field.setActivity
    return field.ready
  })()
}
