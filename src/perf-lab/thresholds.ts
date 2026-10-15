import type { Result } from './index'

// Pass/fail lines for every metric. Frame metrics scale with the display's
// frame budget; page-load lines are Google's Core Web Vitals / Lighthouse ones.

export type Rating = 'good' | 'warn' | 'poor'
export type Metric = 'fps' | 'p95' | 'dropped' | 'cpu' | 'gpu' | 'firstFrame' | 'tbtInit' | 'lcp' | 'tbt' | 'cls' | 'fcp' | 'score'

type Line = { label: string; good: number; poor: number; higherIsBetter?: boolean; format: (v: number) => string; why: string }

export function thresholds(budgetMs: number): Record<Metric, Line> {
  const ms = (v: number) => `${+v.toFixed(1)} ms`
  const hz = 1000 / budgetMs
  return {
    fps: { label: 'FPS', good: hz * 0.95, poor: hz * 0.8, higherIsBetter: true, format: (v) => v.toFixed(0), why: 'Below 95 % of the refresh rate motion starts to judder; below 80 % it is clearly choppy.' },
    p95: { label: 'Frame time p95', good: budgetMs * 1.25, poor: budgetMs * 2, format: ms, why: 'A p95 above 2× the frame budget means at least 1 frame in 20 is a visible hitch.' },
    dropped: { label: 'Dropped frames', good: 0.05, poor: 0.15, format: (v) => `${(v * 100).toFixed(0)} %`, why: 'Share of frames slower than 1.5× the budget.' },
    cpu: { label: 'JS per frame', good: 2, poor: 4, format: ms, why: 'Effects are decoration: they should leave the main thread to scrolling, input and the rest of the page (a 60 Hz frame has ~10 ms for all JS).' },
    gpu: { label: 'GPU per frame', good: budgetMs * 0.5, poor: budgetMs * 0.8, format: ms, why: 'Above half the budget on a fast GPU leaves no headroom for slower ones (integrated laptop GPUs and phones are several times slower).' },
    firstFrame: { label: 'First frame', good: 100, poor: 300, format: ms, why: 'Time until the effects are on screen; past ~300 ms the swap from poster to canvas becomes noticeable.' },
    tbtInit: { label: 'Startup blocking', good: 50, poor: 200, format: ms, why: 'Long-task time caused by mounting the effects; it adds straight to the page TBT (whose whole budget is 200 ms).' },
    lcp: { label: 'LCP', good: 2500, poor: 4000, format: (v) => `${(v / 1000).toFixed(1)} s`, why: 'Core Web Vitals.' },
    tbt: { label: 'TBT', good: 200, poor: 600, format: ms, why: 'Lighthouse.' },
    cls: { label: 'CLS', good: 0.1, poor: 0.25, format: (v) => v.toFixed(2), why: 'Core Web Vitals.' },
    fcp: { label: 'FCP', good: 1800, poor: 3000, format: (v) => `${(v / 1000).toFixed(1)} s`, why: 'Lighthouse.' },
    score: { label: 'Performance score', good: 90, poor: 50, higherIsBetter: true, format: (v) => v.toFixed(0), why: 'Lighthouse.' },
  }
}

export function rate(line: Line, value: number | undefined): Rating | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  if (line.higherIsBetter) return value >= line.good ? 'good' : value >= line.poor ? 'warn' : 'poor'
  return value <= line.good ? 'good' : value <= line.poor ? 'warn' : 'poor'
}

/** Status hues are reserved for ratings and always come with an icon and a label. */
export const RATING = {
  good: { color: '#0ca30c', icon: '✓', label: 'Good' },
  warn: { color: '#fab219', icon: '!', label: 'Needs work' },
  poor: { color: '#d03b3b', icon: '✕', label: 'Poor' },
} as const

/** A value with its rating mark, e.g. inside a table cell. */
export function rated(lines: Record<Metric, Line>, metric: Metric, value: number | undefined, text: string) {
  const r = rate(lines[metric], value)
  if (!r) return text
  const { color, icon, label } = RATING[r]
  return `<span class="rated ${r}" title="${label}: ${describe(lines[metric])}"><i style="color:${color}" aria-label="${label}">${icon}</i>${text}</span>`
}

export const describe = (l: Line) =>
  l.higherIsBetter ? `good ≥ ${l.format(l.good)}, poor < ${l.format(l.poor)}` : `good ≤ ${l.format(l.good)}, poor > ${l.format(l.poor)}`

/** Legend table of every line, for the panel and the report. */
export function thresholdTable(lines: Record<Metric, Line>, metrics: Metric[]) {
  const mark = (r: Rating) => `<i style="color:${RATING[r].color}">${RATING[r].icon}</i> ${RATING[r].label}`
  const cmp = (l: Line, r: Rating) => {
    const [a, b] = l.higherIsBetter ? ['≥', '<'] : ['≤', '>']
    if (r === 'good') return `${a} ${l.format(l.good)}`
    if (r === 'poor') return `${b} ${l.format(l.poor)}`
    return `${l.format(Math.min(l.good, l.poor))} – ${l.format(Math.max(l.good, l.poor))}`
  }
  return `<table class="thresholds"><thead><tr><th>Metric</th><th>${mark('good')}</th><th>${mark('warn')}</th><th>${mark('poor')}</th></tr></thead><tbody>${metrics
    .map((m) => {
      const l = lines[m]
      return `<tr title="${l.why}"><td>${l.label}</td><td>${cmp(l, 'good')}</td><td>${cmp(l, 'warn')}</td><td>${cmp(l, 'poor')}</td></tr>`
    })
    .join('')}</tbody></table>`
}

export const FRAME_METRICS: Metric[] = ['fps', 'p95', 'dropped', 'cpu', 'gpu', 'firstFrame', 'tbtInit']
export const LOAD_METRICS: Metric[] = ['score', 'fcp', 'lcp', 'tbt', 'cls']

/** Worst rating of the runtime metrics: a result's overall verdict. */
export function verdict(r: Result, l: Record<Metric, Line>): Rating {
  if (r.init.failed) return 'poor'
  const order: Rating[] = ['good', 'warn', 'poor']
  const ratings = [rate(l.fps, r.run.fps), rate(l.p95, r.run.p95), rate(l.dropped, r.run.dropped), rate(l.cpu, r.run.cpuMs), rate(l.gpu, r.run.gpuMs)]
  return ratings.reduce<Rating>((worst, x) => (x && order.indexOf(x) > order.indexOf(worst) ? x : worst), 'good')
}
