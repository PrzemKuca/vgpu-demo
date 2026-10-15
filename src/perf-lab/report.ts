// Standalone HTML report of a benchmark run: findings, method, charts, tables.
// Self-contained (inline CSS and SVG), light theme, prints cleanly to PDF.
import { lineChart, SERIES_COLORS } from './chart'
import { FX } from './effects'
import { STRATEGIES, STRATEGY_MATRIX, type Strategy } from './field'
import type { LighthouseSummary, Result } from './index'
import { FRAME_METRICS, LOAD_METRICS, rated, RATING, thresholds, thresholdTable, verdict, type Rating } from './thresholds'

export const GLOSSARY: [string, string][] = [
  ['FPS', 'frames the browser actually presented per second; the display refresh rate is the ceiling.'],
  ['Frame time p95', '95 % of frames were at least this fast. Above the frame budget (1000 ms ÷ refresh rate) means visible stutter.'],
  ['Dropped', 'share of frames that took more than 1.5× the frame budget.'],
  ['JS per frame', 'main-thread time spent encoding and submitting GPU work. It competes with scrolling, input and the rest of the page.'],
  ['GPU per frame', 'time the GPU spent on a frame, from before its first pass to after its last (timestamp-query), averaged over all display frames — idle frames count as 0. Not measured for Naive: frames of separate devices overlap on the GPU and their times cannot be added up. Chrome rounds timestamps to 0.1 ms. Compare it with the frame budget: that ratio is your headroom on weaker GPUs.'],
  ['First frame', 'from mounting the effects until the first frame of every tile that has to render is finished on the GPU.'],
  ['TBT', 'Total Blocking Time: Σ(long task − 50 ms). The Lighthouse metric for an unresponsive main thread.'],
  ['LCP', 'Largest Contentful Paint: when the biggest image or text block appears. A WebGPU canvas is never an LCP candidate; the poster <img> is.'],
]

export const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const fmt = (v: number | undefined, d = 1) => (v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d))

export function buildReport(opts: { results: Result[]; refreshMs: number; gpu: string; lighthouse?: LighthouseSummary }) {
  const { results, refreshMs } = opts
  const r0 = results[0]
  const strategies = (Object.keys(STRATEGIES) as Strategy[]).filter((st) => results.some((r) => r.strategy === st))
  const hz = Math.round(1000 / refreshMs)
  const series = (pick: (r: Result) => number | undefined) =>
    strategies.map((s) => ({
      name: STRATEGIES[s].title,
      color: SERIES_COLORS[(Object.keys(STRATEGIES) as Strategy[]).indexOf(s)],
      points: results.filter((r) => r.strategy === s).map((r) => ({ x: r.count, y: pick(r) })),
    }))

  // Findings: the biggest count each strategy kept smooth, and the cost gap at the biggest count tested.
  const lines = thresholds(refreshMs)
  const badge = (v: Rating) => `<span class="rated ${v}"><i style="color:${RATING[v].color}">${RATING[v].icon}</i>${RATING[v].label}</span>`
  const maxCount = Math.max(...results.map((r) => r.count))
  const at = (s: Strategy) => results.find((r) => r.strategy === s && r.count === maxCount)
  const findings = strategies.map((s) => {
    // The biggest count this strategy reached (a stopped sweep can end early).
    const own = results.filter((r) => r.strategy === s)
    const top = own.reduce<Result | undefined>((a, r) => (!a || r.count > a.count ? r : a), undefined)
    // "✓ Good up to 32 · ! Needs work from 64": the lowest count at which each worse rating first appears.
    const first = (v: Rating) => own.filter((r) => verdict(r, lines) === v).map((r) => r.count).sort((a, b) => a - b)[0]
    const goodUpTo = own.filter((r) => r.count < Math.min(first('warn') ?? Infinity, first('poor') ?? Infinity)).map((r) => r.count)
    const plural = (n: number) => `${n} instance${n === 1 ? '' : 's'}`
    const held = [
      goodUpTo.length ? `${RATING.good.icon} good up to <b>${plural(Math.max(...goodUpTo))}</b>` : '',
      first('warn') ? `${RATING.warn.icon} needs work from <b>${plural(first('warn'))}</b>` : '',
      first('poor') ? `${RATING.poor.icon} poor from <b>${plural(first('poor'))}</b>` : '',
    ]
      .filter(Boolean)
      .join(' · ')
    return `<li>${top ? badge(verdict(top, lines)) : ''} <b>${STRATEGIES[s].title}</b>: ${held}. At ${top ? plural(top.count) : '—'}: p95 ${fmt(top?.run.p95)} ms, JS ${fmt(top?.run.cpuMs, 2)} ms/frame, ${s === 'naive' ? 'GPU not measurable (one device per tile)' : `GPU ${fmt(top?.run.gpuMs, 2)} ms/frame`}, first frame ${fmt(top?.init.firstFrameMs, 0)} ms, ${top?.init.devices ?? '—'} GPU device(s)${top?.init.failed ? `, <b>${top.init.failed} failed</b> (${escapeHtml(top.init.error ?? '')})` : ''}.</li>`
  })
  const tested = [...new Set(results.map((r) => r.count))].sort((a, b) => a - b)
  const missing = (Object.keys(STRATEGIES) as Strategy[]).filter((st) => results.filter((r) => r.strategy === st).length < tested.length)
  if (missing.length) findings.push(`<li><b>Partial run:</b> the benchmark was stopped before ${missing.map((m) => STRATEGIES[m].title).join(', ')} covered every instance count (${tested.join(', ')}).</li>`)
  const naive = at('naive')
  const shared = at('shared')
  const prod = at('production')
  if (naive && prod)
    findings.push(`<li>At ${maxCount} instances Production spends <b>${fmt(naive.run.cpuMs / Math.max(prod.run.cpuMs, 0.001))}×</b> less main-thread JS per frame than Naive${shared?.run.gpuMs && prod.run.gpuMs ? ` and <b>${fmt(shared.run.gpuMs / prod.run.gpuMs)}×</b> less GPU time than Shared device` : ''}.</li>`)

  const lighthouse = opts.lighthouse ? lighthouseSection(opts.lighthouse) : ''

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>vgpu performance report — ${escapeHtml(FX[r0.fx].title)}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; background: #fff; color: #1a1a1a; font: 14px/1.55 system-ui, -apple-system, sans-serif; }
  main { max-width: 920px; margin: 0 auto; padding: 40px 24px 64px; }
  h1 { font-size: 28px; margin: 0 0 4px; letter-spacing: -0.01em; }
  h2 { font-size: 18px; margin: 36px 0 10px; padding-top: 12px; border-top: 1px solid #e5e5e5; }
  h3 { font-size: 15px; margin: 18px 0 6px; }
  .meta { color: #666; margin: 0 0 4px; }
  .findings li { margin-bottom: 6px; }
  .strategies { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
  .strategy { border: 1px solid #e5e5e5; border-radius: 8px; padding: 12px 14px; break-inside: avoid; }
  .strategy h3 { margin: 0 0 4px; display: flex; align-items: center; gap: 8px; }
  .strategy h3 i { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .strategy p { margin: 0 0 6px; color: #444; }
  .strategy ul { margin: 0; padding-left: 18px; color: #555; font-size: 13px; }
  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 20px; }
  .lab-chart { margin: 0; break-inside: avoid; }
  .lab-chart figcaption { font-weight: 600; font-size: 13px; }
  .lab-chart svg { width: 100%; height: auto; overflow: visible; }
  .lab-chart text { fill: #666; font-size: 9px; font-variant-numeric: tabular-nums; }
  .lab-chart .grid { stroke: #e8e8e8; stroke-width: 1; }
  .lab-chart .budget { stroke: #888; stroke-width: 1; stroke-dasharray: 3 3; }
  .lab-legend i.budget-key { width: 14px; height: 0; border-radius: 0; border-top: 1px dashed #888; vertical-align: middle; }
  .lab-chart .dot { stroke: #fff; stroke-width: 2; }
  .lab-legend { display: flex; flex-wrap: wrap; gap: 12px; color: #444; font-size: 12px; margin: 4px 0; }
  .lab-legend i { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; font-variant-numeric: tabular-nums; break-inside: auto; }
  th, td { padding: 5px 6px; text-align: right; border-bottom: 1px solid #eee; }
  th:first-child, td:first-child { text-align: left; }
  th { color: #666; font-weight: 500; border-bottom-color: #ccc; }
  tr.fail td { color: #b0006e; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; margin: 0; }
  dt { font-weight: 600; } dd { margin: 0; color: #444; }
  .note { color: #666; font-size: 13px; }
  .rated { display: inline-flex; align-items: baseline; gap: 4px; white-space: nowrap; }
  .rated i, .thresholds i { font-style: normal; font-weight: 700; }
  .thresholds { margin-bottom: 10px; } .thresholds td, .thresholds th { text-align: left; }
  dl.why { margin: 8px 0 0; font-size: 13px; }
  .matrix th, .matrix td { text-align: left; vertical-align: top; } .matrix tbody th { color: #555; font-weight: 400; }
  @media print { main { padding: 0; } h2 { break-after: avoid; } }
</style></head>
<body><main>
  <h1>vgpu effects — performance report</h1>
  <p class="meta">${new Date().toLocaleString()} · <b>${escapeHtml(FX[r0.fx].title)}</b> · ${Math.round(r0.activity * 100)} % of instances animating at once${r0.synced ? ', all in sync' : ', staggered'} · device pixel ratio ≤ ${r0.dprMax} ${r0.scale !== undefined ? ` · tile size ${Math.round(r0.scale * 100)} % (0 % = all tiles on screen, 100 % = one tile fills it)` : ''}${r0.load && (r0.load.gpu > 1 || r0.load.cpu > 1) ? ` · <b>emulated hardware: ${escapeHtml(r0.hardware ?? 'custom')}</b> (every tile drawn ${r0.load.gpu}× per frame, effect JS stretched ${r0.load.cpu}×)` : ''}${r0.tilePx ? ` · tile width by count: ${[...new Map(results.map((r) => [r.count, r.tilePx])).entries()].map(([c, w]) => `${c} → ${w} px`).join(', ')}` : ''}</p>
  <p class="meta">${hz} Hz display (frame budget ${fmt(refreshMs)} ms) · ${escapeHtml(opts.gpu)} · ${escapeHtml(navigator.userAgent)}</p>

  <h2>Key findings</h2>
  <ul class="findings">${findings.join('')}</ul>

  <h2>Strategies</h2>
  <div class="strategies">${strategies
    .map(
      (s) => `<section class="strategy"><h3><i style="background:${SERIES_COLORS[(Object.keys(STRATEGIES) as Strategy[]).indexOf(s)]}"></i>${STRATEGIES[s].title}</h3>
        <p><b>${escapeHtml(STRATEGIES[s].tagline)}</b> ${escapeHtml(STRATEGIES[s].analogy)}</p><p>${escapeHtml(STRATEGIES[s].summary)}</p><ul>${STRATEGIES[s].how.map((h) => `<li>${escapeHtml(h)}</li>`).join('')}</ul></section>`,
    )
    .join('')}</div>

  <h3>Side by side</h3>
  <table class="matrix"><thead><tr><th></th>${strategies.map((s) => `<th>${STRATEGIES[s].title}</th>`).join('')}</tr></thead>
    <tbody>${STRATEGY_MATRIX.map(([label, v]) => `<tr><th>${label}</th>${strategies.map((s) => `<td>${v[s]}</td>`).join('')}</tr>`).join('')}</tbody></table>

  <h2>Results by number of instances</h2>
  <div class="charts">
    ${lineChart({ title: 'Frame time p95 (ms) — lower is better', series: series((r) => r.run.p95), budget: refreshMs, unit: 'ms' })}
    ${lineChart({ title: 'Main-thread JS per frame (ms)', series: series((r) => r.run.cpuMs), unit: 'ms' })}
    ${results.some((r) => r.run.gpuMs !== undefined) ? lineChart({ title: 'GPU time per frame, all canvases (ms)', series: series((r) => r.run.gpuMs), unit: 'ms' }) : ''}
    ${lineChart({ title: 'Startup: time to first frame (ms)', series: series((r) => r.init.firstFrameMs), unit: 'ms' })}
  </div>

  <h3>All measurements</h3>
  <table>
    <thead><tr><th>Strategy</th><th>Instances</th><th>Verdict</th><th>FPS</th><th>p50 ms</th><th>p95 ms</th><th>p99 ms</th><th>Dropped</th><th>JS ms/frame</th><th>GPU ms/frame</th><th>Mpx/frame</th><th>First frame ms</th><th>TBT ms</th><th>Devices</th></tr></thead>
    <tbody>${results
      .map(
        (r) => `<tr${r.init.failed ? ' class="fail"' : ''}><td>${STRATEGIES[r.strategy].title}</td><td>${r.count}</td><td>${badge(verdict(r, lines))}</td><td>${rated(lines, 'fps', r.run.fps, fmt(r.run.fps, 0))}</td><td>${fmt(r.run.p50)}</td><td>${rated(lines, 'p95', r.run.p95, fmt(r.run.p95))}</td><td>${fmt(r.run.p99)}</td>
          <td>${rated(lines, 'dropped', r.run.dropped, `${fmt(r.run.dropped * 100, 0)} %`)}</td><td>${rated(lines, 'cpu', r.run.cpuMs, fmt(r.run.cpuMs, 2))}</td><td>${r.strategy === 'naive' ? 'n/m' : rated(lines, 'gpu', r.run.gpuMs, fmt(r.run.gpuMs, 2))}</td><td>${fmt(r.run.mpx, 2)}</td><td>${rated(lines, 'firstFrame', r.init.firstFrameMs, fmt(r.init.firstFrameMs, 0))}</td><td>${rated(lines, 'tbtInit', r.init.blockingMs, fmt(r.init.blockingMs, 0))}</td><td>${r.init.devices}${r.init.failed ? ` (${r.init.failed} failed)` : ''}</td></tr>`,
      )
      .join('')}</tbody>
  </table>
  ${results.some((r) => r.strategy === 'naive') ? '<p class="note">n/m — GPU time can’t be measured for Naive: each tile has its own GPU device and their work overlaps. Its verdict covers FPS, frame time and JS only.</p>' : ''}

  ${lighthouse}

  <h2>Pass / fail thresholds</h2>
  <p class="note">Every value is marked ${badge('good')}, ${badge('warn')} or ${badge('poor')}. A row's verdict is its worst runtime metric (FPS, p95, dropped, JS, GPU). Frame thresholds scale with the display (${hz} Hz, ${fmt(refreshMs)} ms budget); page-load thresholds are Google's Core Web Vitals / Lighthouse lines.</p>
  <h3>Runtime and startup</h3>
  ${thresholdTable(lines, FRAME_METRICS)}
  <dl class="why">${FRAME_METRICS.map((m) => `<dt>${lines[m].label}</dt><dd>${escapeHtml(lines[m].why)}</dd>`).join('')}</dl>
  <h3>Page load (Lighthouse)</h3>
  ${thresholdTable(lines, LOAD_METRICS)}

  <h2>Method</h2>
  <p class="note">Every strategy was mounted with each instance count in the same browser tab, warmed up for 1 s and measured for 3 s. Tiles are laid out by the Tile size setting: at 0 % all of them are on screen, above it some scroll out of view (Production skips those). Animating tiles loop a show/hide cycle (3.2 s), staggered — or all in step when Sync animations is on, the worst case where every tile peaks at once. A throwaway mount runs first so the one-time shader compilation is not charged to the first measured strategy. With hardware emulation, every tile is drawn N times per frame and the effect’s JS is stretched N× — an estimate of a slower device, not a substitute for one. Measurements come from one machine and one browser; repeat on the slowest device you target before drawing hard limits.</p>
  <dl>${GLOSSARY.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>
</main></body></html>`
}

function lighthouseSection(data: LighthouseSummary) {
  const ffs = [...new Set(data.runs.map((r) => r.formFactor))]
  return `<h2>Lighthouse (page load)</h2>
  <p class="note">${new Date(data.date).toLocaleString()} · Lighthouse ${escapeHtml(data.lighthouseVersion)}${data.chrome ? ` · ${escapeHtml(data.chrome)}` : ''}${data.gpu ? ` · GPU ${escapeHtml(data.gpu)}` : ''} · median of ${data.runsPerScenario} run(s). <i>none</i> is the same page with static images and no WebGPU — the baseline. Runtime columns: the same page with 25 % of cards animating, 1280×800 @2x.</p>
  ${ffs
    .map(
      (ff) => `<h3>${ff === 'mobile' ? 'Mobile (Moto G Power emulation, 4× CPU slowdown, slow 4G)' : 'Desktop'}</h3>
      <table><thead><tr><th>Scenario</th><th>Score</th><th>FCP s</th><th>LCP s</th><th>TBT ms</th><th>CLS</th><th>Transfer KB</th><th>Runtime FPS</th><th>JS ms/frame</th><th>GPU ms/frame</th></tr></thead>
      <tbody>${data.runs
        .filter((r) => r.formFactor === ff)
        .map((r) => {
          const l = thresholds(r.runtime?.refreshMs ?? 1000 / 60)
          return `<tr><td>${escapeHtml(r.label)}</td><td>${rated(l, 'score', r.score, String(r.score ?? '—'))}</td><td>${rated(l, 'fcp', r.fcp, fmt(r.fcp / 1000, 2))}</td><td>${rated(l, 'lcp', r.lcp, fmt(r.lcp / 1000, 2))}</td><td>${rated(l, 'tbt', r.tbt, fmt(r.tbt, 0))}</td><td>${rated(l, 'cls', r.cls, fmt(r.cls, 3))}</td><td>${fmt(r.bytes / 1024, 0)}</td>
            <td>${rated(l, 'fps', r.runtime?.fps, fmt(r.runtime?.fps, 0))}</td><td>${rated(l, 'cpu', r.runtime?.cpuMs, fmt(r.runtime?.cpuMs, 2))}</td><td>${rated(l, 'gpu', r.runtime?.gpuMs, fmt(r.runtime?.gpuMs, 2))}</td></tr>`
        })
        .join('')}</tbody></table>`,
    )
    .join('')}`
}
