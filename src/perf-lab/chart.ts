// Small SVG line chart: instances (log2 x) against one metric.

/** Validated for the dark #0a0a0a panel (OKLCH L band, CVD separation, 3:1 contrast). */
export const SERIES_COLORS = ['#E0189F', '#8C9A00', '#0E8FC8']

type Series = { name: string; color: string; points: { x: number; y: number | undefined }[] }

const W = 288
const H = 150
const M = { top: 12, right: 12, bottom: 22, left: 34 }

const niceMax = (v: number) => {
  if (v <= 0) return 1
  const step = 10 ** Math.floor(Math.log10(v))
  return [1, 2, 2.5, 5, 10].map((m) => m * step).find((m) => m >= v)!
}

export function lineChart(opts: { title: string; series: Series[]; unit: string; budget?: number }) {
  const xs = [...new Set(opts.series.flatMap((s) => s.points.map((p) => p.x)))].sort((a, b) => a - b)
  const ys = opts.series.flatMap((s) => s.points.map((p) => p.y)).filter((y): y is number => y !== undefined && Number.isFinite(y))
  if (!xs.length || !ys.length) return ''
  const yMax = niceMax(Math.max(...ys, opts.budget ?? 0) * 1.05)
  const lx = (x: number) => Math.log2(x)
  const [x0, x1] = [lx(xs[0]), lx(xs[xs.length - 1])]
  const px = (x: number) => M.left + (x1 === x0 ? 0.5 : (lx(x) - x0) / (x1 - x0)) * (W - M.left - M.right)
  const py = (y: number) => H - M.bottom - (y / yMax) * (H - M.top - M.bottom)
  const ticks = [0, 0.5, 1].map((t) => t * yMax)

  const grid = ticks
    .map((t) => `<line x1="${M.left}" x2="${W - M.right}" y1="${py(t)}" y2="${py(t)}" class="grid"/><text x="${M.left - 6}" y="${py(t) + 3}" text-anchor="end">${+t.toFixed(2)}</text>`)
    .join('')
  const xAxis = xs.map((x) => `<text x="${px(x)}" y="${H - 6}" text-anchor="middle">${x}</text>`).join('')
  const budget =
    opts.budget === undefined
      ? ''
      : `<line x1="${M.left}" x2="${W - M.right}" y1="${py(opts.budget)}" y2="${py(opts.budget)}" class="budget"/>`
  const lines = opts.series
    .map((s) => {
      const pts = s.points.filter((p): p is { x: number; y: number } => p.y !== undefined && Number.isFinite(p.y))
      if (!pts.length) return ''
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join('')
      const dots = pts
        .map(
          (p) =>
            `<g class="pt"><circle cx="${px(p.x)}" cy="${py(p.y)}" r="10" fill="transparent"/><circle cx="${px(p.x)}" cy="${py(p.y)}" r="4" fill="${s.color}" class="dot"/><title>${s.name} · ${p.x} instances: ${p.y.toFixed(2)} ${opts.unit}</title></g>`,
        )
        .join('')
      return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>${dots}`
    })
    .join('')
  const legend =
    opts.series.map((s) => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join('') +
    (opts.budget === undefined ? '' : `<span><i class="budget-key"></i>frame budget ${opts.budget.toFixed(1)} ms</span>`)

  return `<figure class="lab-chart">
    <figcaption>${opts.title}</figcaption>
    <div class="lab-legend">${legend}</div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${opts.title} by number of instances">${grid}${budget}${xAxis}${lines}</svg>
  </figure>`
}
