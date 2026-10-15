import { FX, type FxKind } from './effects'
import { mountField, STRATEGIES, STRATEGY_MATRIX, type InitReport, type Load, type Strategy } from './field'
import { blockingBetween, createSampler, measureRefresh, type Window } from './stats'
import { lineChart, SERIES_COLORS } from './chart'
import { buildReport, escapeHtml, GLOSSARY } from './report'
import { FRAME_METRICS, LOAD_METRICS, rate, rated, RATING, thresholds, thresholdTable, verdict, type Rating } from './thresholds'

export type Result = {
  fx: FxKind
  strategy: Strategy
  count: number
  activity: number
  /** Animating tiles played in step (worst case: all peak together) instead of staggered. */
  synced?: boolean
  dprMax: number
  /** Tile size setting (0 = all tiles fit on screen, 1 = one tile fills it) and the resulting tile width in CSS px. */
  scale?: number
  tilePx?: number
  /** Slower-hardware emulation used for the run. */
  load?: Load
  hardware?: string
  init: InitReport & { blockingMs: number; longTasks: number }
  run: Window
}

const COUNTS = [1, 4, 8, 16, 32, 64]
/** Device classes as "N× slower than this machine" at their display refresh. */
const HARDWARE = [
  { title: 'This machine', gpu: 1, cpu: 1, hz: 0, note: '' },
  { title: 'Laptop ~2020', gpu: 4, cpu: 2, hz: 60, note: 'Apple M1 or Intel Iris Xe class.' },
  { title: 'Older laptop ~2018', gpu: 24, cpu: 3, hz: 60, note: 'Intel UHD 620 class (Core i5-8250U).' },
  { title: 'Budget phone', gpu: 40, cpu: 6, hz: 60, note: 'Adreno 610 / Mali-G52 class.' },
]
const SWEEP_COUNTS = [1, 4, 8, 16, 32]
const WARMUP_MS = 1000
const MEASURE_MS = 3000
const strategies = Object.keys(STRATEGIES) as Strategy[]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const fmt = (v: number | undefined, digits = 1) => (v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(digits))

export function mountPerfLab(root: HTMLElement) {
  root.innerHTML = `
    <div class="lab">
      <section class="lab-page">
        <section class="lab-explain" data-explain>
          <header><h2>Three ways to put many effects on one page</h2><button class="chip" data-toggle-explain>Hide details</button></header>
          <div class="lab-explain-body">
            <div class="lab-explain-cards">
              ${strategies.map((s, i) => `<button class="lab-card" data-pick="${s}"><b><i style="background:${SERIES_COLORS[i]}"></i>${STRATEGIES[s].title}</b><strong>${STRATEGIES[s].tagline}</strong><span>${STRATEGIES[s].analogy}</span></button>`).join('')}
            </div>
            <div class="lab-table-wrap"><table class="lab-matrix">
              <thead><tr><th></th>${strategies.map((s) => `<th data-col="${s}">${STRATEGIES[s].title}</th>`).join('')}</tr></thead>
              <tbody>${STRATEGY_MATRIX.map(([label, v]) => `<tr><th>${label}</th>${strategies.map((s) => `<td data-col="${s}">${v[s]}</td>`).join('')}</tr>`).join('')}</tbody>
            </table></div>
            <details><summary>Technical detail</summary><div class="lab-explain-cards">${strategies
              .map((s) => `<div><b>${STRATEGIES[s].title}</b><p>${STRATEGIES[s].summary}</p><ul>${STRATEGIES[s].how.map((h) => `<li>${escapeHtml(h)}</li>`).join('')}</ul></div>`)
              .join('')}</div></details>
          </div>
        </section>
        <section class="lab-sim">
          <header class="lab-page-head">
            <h2>Simulated page</h2>
            <p data-caption></p>
            <div class="lab-status" data-status><span class="muted">measuring…</span></div>
          </header>
          <div class="lab-grid"></div>
        </section>
      </section>
      <aside class="controls lab-panel">
        <h2>Scenario</h2>
        <div class="field"><span class="label">Effect</span><div class="chips" data-group="fx">
          ${Object.values(FX).map((d) => `<button class="chip" data-value="${d.kind}">${d.title}</button>`).join('')}
        </div></div>
        <div class="field"><span class="label">Instances on the page</span><div class="chips" data-group="count">
          ${COUNTS.map((c) => `<button class="chip" data-value="${c}">${c}</button>`).join('')}
        </div></div>
        <label class="field">
          <span class="label">Tile size <output data-out="scale">0 %</output></span>
          <input type="range" name="scale" min="0" max="1" step="0.01" value="0" />
          <small class="lab-hint">0 % all tiles on screen · 100 % one tile fills it</small>
        </label>
        <label class="field">
          <span class="label">Animating at once <output data-out="activity">25 %</output></span>
          <input type="range" name="activity" min="0" max="1" step="0.05" value="0.25" />
        </label>
        <button class="button lab-sync" data-sync aria-pressed="false">Sync animations</button>
        <div class="field"><span class="label">Max device pixel ratio</span><div class="chips" data-group="dpr">
          ${[1, 1.5, 2].map((d) => `<button class="chip" data-value="${d}">${d}×</button>`).join('')}
        </div></div>

        <h2>Emulate slower hardware</h2>
        <div class="chips lab-hw" data-hw>
          ${HARDWARE.map((h, i) => `<button class="chip${i ? '' : ' active'}" data-hw-preset="${i}" title="${h.note}">${h.title}</button>`).join('')}
        </div>
        <label class="field">
          <span class="label">GPU work per frame <output data-out="gpuLoad">×1</output></span>
          <input type="range" name="gpuLoad" min="1" max="48" step="1" value="1" />
        </label>
        <label class="field">
          <span class="label">CPU (effect JS) slowdown <output data-out="cpuLoad">×1</output></span>
          <input type="range" name="cpuLoad" min="1" max="8" step="0.5" value="1" />
        </label>
        <p class="lab-note" data-hw-note></p>

        <h2>Live <small data-env></small></h2>
        <div class="lab-metrics" data-live><span class="muted">measuring…</span></div>
        <div class="lab-howto">
          <details data-thresholds><summary>Pass / fail thresholds</summary></details>
          <details><summary>What the numbers mean</summary><ul>${GLOSSARY.map(([k, v]) => `<li><b>${k}</b> — ${escapeHtml(v)}</li>`).join('')}</ul></details>
        </div>
        <h2>Startup</h2>
        <div class="lab-metrics" data-init><span class="muted">mounting…</span></div>

        <h2>Benchmark</h2>
        <p class="lab-note" data-bench-note></p>
        <label class="field check"><input type="checkbox" name="with64" /><span>Also 64 instances</span></label>
        <button class="button" data-run>Run benchmark</button>
        <div class="lab-results" data-results></div>

        <h2>Lighthouse</h2>
        <div class="lab-lighthouse" data-lighthouse><span class="muted">loading…</span></div>
      </aside>
    </div>
  `
  const grid = root.querySelector<HTMLElement>('.lab-grid')!
  const panel = root.querySelector<HTMLElement>('.lab-panel')!
  const caption = root.querySelector<HTMLElement>('[data-caption]')!
  const live = panel.querySelector<HTMLElement>('[data-live]')!
  const initEl = panel.querySelector<HTMLElement>('[data-init]')!
  const env = panel.querySelector<HTMLElement>('[data-env]')!
  const runButton = panel.querySelector<HTMLButtonElement>('[data-run]')!
  const resultsEl = panel.querySelector<HTMLElement>('[data-results]')!
  const activityInput = panel.querySelector<HTMLInputElement>('[name=activity]')!
  const scaleInput = panel.querySelector<HTMLInputElement>('[name=scale]')!
  const scaleOut = panel.querySelector<HTMLOutputElement>('[data-out=scale]')!
  const activityOut = panel.querySelector<HTMLOutputElement>('[data-out=activity]')!
  const gpuLoadInput = panel.querySelector<HTMLInputElement>('[name=gpuLoad]')!
  const cpuLoadInput = panel.querySelector<HTMLInputElement>('[name=cpuLoad]')!
  const hwNote = panel.querySelector<HTMLElement>('[data-hw-note]')!
  const statusEl = root.querySelector<HTMLElement>('[data-status]')!
  const benchNote = panel.querySelector<HTMLElement>('[data-bench-note]')!
  const with64 = panel.querySelector<HTMLInputElement>('[name=with64]')!
  const syncButton = panel.querySelector<HTMLButtonElement>('[data-sync]')!

  const state = { fx: 'smoke' as FxKind, count: 8, strategy: 'production' as Strategy, activity: 0.25, synced: false, dprMax: 2, gpuTiming: true, scale: 0, load: { gpu: 1, cpu: 1 } as Load }
  let hwPreset = 0
  let tilePx = 0
  let field: ReturnType<typeof mountField> | undefined
  let lastInit: Result['init'] | undefined
  let refreshMs = 1000 / 60
  let gpuName = ''
  let running = false
  let disposed = false

  const sweepCounts = () => (with64.checked ? [...SWEEP_COUNTS, 64] : SWEEP_COUNTS)
  const sync = () => {
    const pick = (group: string, value: unknown) =>
      panel.querySelectorAll<HTMLButtonElement>(`[data-group=${group}] button`).forEach((b) => b.classList.toggle('active', b.dataset.value === String(value)))
    pick('fx', state.fx)
    pick('count', state.count)
    pick('dpr', state.dprMax)
    root.querySelectorAll<HTMLElement>('[data-pick], [data-col]').forEach((el) => el.classList.toggle('active', (el.dataset.pick ?? el.dataset.col) === state.strategy))
    activityInput.value = String(state.activity)
    activityOut.textContent = `${Math.round(state.activity * 100)} %`
    syncButton.classList.toggle('active', state.synced)
    syncButton.setAttribute('aria-pressed', String(state.synced))
    syncButton.textContent = state.synced ? 'Animations in sync · click to stagger' : 'Sync animations'
    scaleInput.value = String(state.scale)
    const counts = sweepCounts()
    benchNote.textContent = `Runs all three strategies at ${counts.join(', ')} instances with the settings above (effect, tile size, animating share and sync, DPR, hardware emulation): ${WARMUP_MS / 1000} s warm-up and ${MEASURE_MS / 1000} s of measuring each, about ${Math.ceil((strategies.length * counts.length * (WARMUP_MS + MEASURE_MS + 800)) / 60000)} min. Keep this tab in front; you can stop it at any time.`
    caption.textContent = `${state.count} × ${FX[state.fx].title} · ${STRATEGIES[state.strategy].title} · ${Math.round(state.activity * 100)} % animating${state.synced ? ' in sync' : ''} · DPR ≤ ${state.dprMax} · tiles ${tilePx} px${state.load.gpu > 1 || state.load.cpu > 1 ? ` · emulating GPU ×${state.load.gpu}, CPU ×${state.load.cpu}` : ''}`
  }

  // Scale the tiles so all of them fit the visible area at once.
  const fitGrid = () => {
    const [width, height] = [grid.clientWidth, grid.clientHeight]
    const n = state.count
    const aspect = FX[state.fx].aspect
    const gap = n > 16 ? 6 : n > 4 ? 10 : 16
    // 0 % = all n tiles on screen, 100 % = one; geometric steps in between.
    const k = Math.min(n, Math.max(1, Math.round(n ** (1 - state.scale))))
    let best = { cols: 1, w: 0 }
    for (let cols = 1; cols <= k; cols++) {
      const rows = Math.ceil(k / cols)
      const w = Math.min((width - gap * (cols - 1)) / cols, ((height - gap * (rows - 1)) / rows) * aspect)
      if (w > best.w) best = { cols, w }
    }
    // Rows are a screen's height ÷ rows-per-screen, so exactly k tiles show and the rest scroll.
    const rows = Math.ceil(k / best.cols)
    const w = Math.max(1, Math.floor(best.w))
    grid.style.gap = `${gap}px`
    grid.style.gridTemplateColumns = `repeat(${best.cols}, ${w}px)`
    grid.style.gridAutoRows = `${Math.max(w / aspect, (height - gap * (rows - 1)) / rows)}px`
    tilePx = w
    scaleOut.textContent = `${Math.round(state.scale * 100)} % · ${Math.min(n, best.cols * rows)}/${n} visible · ${w} px`
    sync()
  }
  const gridSize = new ResizeObserver(fitGrid)
  gridSize.observe(grid)

  const remount = () => {
    field?.dispose()
    lastInit = undefined
    initEl.innerHTML = '<span class="muted">mounting…</span>'
    fitGrid()
    grid.scrollTop = 0
    const f = (field = mountField(grid, { ...state, root: grid }))
    const t0 = performance.now()
    const ready = f.ready.then((r) => {
      const { count, blocking } = blockingBetween(t0, performance.now())
      return { ...r, longTasks: count, blockingMs: blocking }
    })
    ready.then((r) => {
      if (field !== f) return
      lastInit = r
      initEl.innerHTML = metrics([
        ['Devices', String(r.devices), r.failed ? `${r.failed} failed` : ''],
        ['Device ready', `${fmt(r.deviceMs, 0)} ms`],
        ['Resources ready', `${fmt(r.resourcesMs, 0)} ms`],
        ['First frame', `${fmt(r.firstFrameMs, 0)} ms`, state.strategy === 'production' ? 'visible tiles' : 'all tiles', rate(lines().firstFrame, r.firstFrameMs)],
        ['Long tasks', String(r.longTasks)],
        ['Blocking (TBT)', `${fmt(r.blockingMs, 0)} ms`, 'Σ(task − 50 ms)', rate(lines().tbtInit, r.blockingMs)],
      ]) + (r.error ? `<p class="lab-error">${r.error}</p>` : '')
    })
    return ready
  }

  const bind = (group: string, apply: (v: string) => void) =>
    panel.querySelectorAll<HTMLButtonElement>(`[data-group=${group}] button`).forEach((b) =>
      b.addEventListener('click', () => {
        if (running) return
        apply(b.dataset.value!)
        remount()
      }),
    )
  root.querySelectorAll<HTMLButtonElement>('[data-pick]').forEach((b) =>
    b.addEventListener('click', () => {
      if (running) return
      state.strategy = b.dataset.pick as Strategy
      remount()
    }),
  )
  const explain = root.querySelector<HTMLElement>('[data-explain]')!
  const toggleExplain = root.querySelector<HTMLButtonElement>('[data-toggle-explain]')!
  const setExplain = (hidden: boolean) => {
    explain.classList.toggle('collapsed', hidden)
    toggleExplain.textContent = hidden ? 'Show details' : 'Hide details'
    try {
      localStorage.setItem('perf-lab-explain-hidden', hidden ? '1' : '')
    } catch {}
  }
  try {
    if (localStorage.getItem('perf-lab-explain-hidden')) setExplain(true)
  } catch {}
  toggleExplain.addEventListener('click', () => setExplain(!explain.classList.contains('collapsed')))
  bind('fx', (v) => (state.fx = v as FxKind))
  bind('count', (v) => (state.count = Number(v)))
  bind('dpr', (v) => (state.dprMax = Number(v)))
  scaleInput.addEventListener('input', () => {
    state.scale = scaleInput.valueAsNumber
    fitGrid() // canvases resize themselves; no remount needed
  })
  syncButton.addEventListener('click', () => {
    if (running) return
    state.synced = !state.synced
    field?.setSynced(state.synced)
    sync()
  })
  activityInput.addEventListener('input', () => {
    state.activity = activityInput.valueAsNumber
    field?.setActivity(state.activity)
    sync()
  })
  // Hardware emulation: presets turn "N× slower device at 60 Hz" into per-frame multipliers for this display.
  const syncLoad = () => {
    gpuLoadInput.value = String(state.load.gpu)
    cpuLoadInput.value = String(state.load.cpu)
    panel.querySelector('[data-out=gpuLoad]')!.textContent = `×${state.load.gpu}`
    panel.querySelector('[data-out=cpuLoad]')!.textContent = `×${state.load.cpu}`
    panel.querySelectorAll<HTMLButtonElement>('[data-hw-preset]').forEach((b) => b.classList.toggle('active', Number(b.dataset.hwPreset) === hwPreset))
    const h = HARDWARE[Math.max(0, hwPreset)]
    const hz = Math.round(1000 / refreshMs)
    hwNote.innerHTML =
      hwPreset > 0
        ? `<b>${h.title}</b>: ${h.note} GPU ≈ ${h.gpu}× and CPU ≈ ${h.cpu}× slower than this machine at ${h.hz} Hz, which is ×${state.load.gpu} GPU / ×${state.load.cpu} CPU per frame on this ${hz} Hz display (it draws ${(hz / h.hz).toFixed(1).replace('.0', '')}× as many frames). Rough ratios from published GPU FP32 throughput and CPU single-core scores, assuming this machine is an Apple M5 Pro-class device; memory bandwidth, thermals and drivers also differ. For whole-page CPU throttling use Chrome DevTools → Performance → CPU.`
        : hwPreset === 0
          ? 'Multipliers re-render every tile N times per frame (same image, N× the GPU work) and stretch the effect’s JS N× with a busy-wait. Pick a device class to set them for you.'
          : 'Custom multipliers.'
    field?.setLoad(state.load)
    sync()
  }
  const perFrame = (slowdown: number, deviceHz: number, step: number) => Math.max(1, Math.round((slowdown * deviceHz * refreshMs) / 1000 / step) * step)
  const applyPreset = (i: number) => {
    hwPreset = i
    const h = HARDWARE[i]
    state.load = { gpu: Math.min(48, perFrame(h.gpu, h.hz, 1)), cpu: Math.min(8, perFrame(h.cpu, h.hz, 0.5)) }
    syncLoad()
  }
  panel.querySelectorAll<HTMLButtonElement>('[data-hw-preset]').forEach((b) => b.addEventListener('click', () => !running && applyPreset(Number(b.dataset.hwPreset))))
  gpuLoadInput.addEventListener('input', () => {
    hwPreset = -1
    state.load = { ...state.load, gpu: gpuLoadInput.valueAsNumber }
    syncLoad()
  })
  cpuLoadInput.addEventListener('input', () => {
    hwPreset = -1
    state.load = { ...state.load, cpu: cpuLoadInput.valueAsNumber }
    syncLoad()
  })

  // Live readout: 1 s windows.
  const sampler = createSampler()
  const liveTimer = setInterval(() => {
    if (running) return
    const w = sampler.read(refreshMs)
    sampler.start()
    showLive(w)
  }, 1000)
  const showLive = (w: Window) => {
    if (w.frames < 2) {
      // rAF doesn't run in a hidden tab or window, so there is nothing to measure.
      const paused = '<span class="muted">Paused — the page is not visible, so the browser stops drawing frames.</span>'
      live.innerHTML = paused
      statusEl.innerHTML = paused
      return
    }
    live.innerHTML = liveMetrics(w, refreshMs, gpuNote())
    statusEl.innerHTML = liveStatus(w, refreshMs)
  }
  const gpuNote = () =>
    state.strategy === 'naive'
      ? 'not measurable: each tile has its own GPU device'
      : lastInit && !lastInit.gpuTiming
          ? 'this browser has no timestamp-query'
          : 'waiting for data'


  const lines = () => thresholds(refreshMs)
  const renderThresholds = () => {
    const el = panel.querySelector<HTMLElement>('[data-thresholds]')!
    el.innerHTML = `<summary>Pass / fail thresholds</summary>
      <p>Every value is marked <span class="rated good"><i style="color:${RATING.good.color}">${RATING.good.icon}</i>${RATING.good.label}</span>, <span class="rated warn"><i style="color:${RATING.warn.color}">${RATING.warn.icon}</i>${RATING.warn.label}</span> or <span class="rated poor"><i style="color:${RATING.poor.color}">${RATING.poor.icon}</i>${RATING.poor.label}</span>. Frame lines scale with this display (${Math.round(1000 / refreshMs)} Hz, ${refreshMs.toFixed(1)} ms budget). Hover a row for the reason.</p>
      ${thresholdTable(lines(), FRAME_METRICS)}${thresholdTable(lines(), LOAD_METRICS)}`
  }
  renderThresholds()
  measureRefresh().then((ms) => {
    refreshMs = ms
    renderThresholds()
    if (hwPreset > 0) applyPreset(hwPreset)
    else syncLoad()
    navigator.gpu
      ?.requestAdapter()
      .then((a) => {
        const name = a?.info ? [a.info.vendor, a.info.architecture].filter(Boolean).join(' ') : ''
        gpuName = name
        env.textContent = `${Math.round(1000 / ms)} Hz · budget ${ms.toFixed(1)} ms${name ? ` · ${name}` : ''}`
      })
      .catch(() => {})
  })

  // Sweep
  let results: Result[] = []
  let stopRequested = false
  const setBusy = (busy: boolean) => {
    running = busy
    panel.classList.toggle('busy', busy)
    root.querySelector('.lab')!.classList.toggle('busy', busy)
    panel.querySelectorAll<HTMLInputElement>('input').forEach((i) => (i.disabled = busy))
    runButton.classList.toggle('stop', busy)
  }
  with64.addEventListener('change', sync)
  runButton.addEventListener('click', async () => {
    if (running) {
      stopRequested = true
      runButton.textContent = 'Stopping after this step…'
      return
    }
    stopRequested = false
    setBusy(true)
    const saved = { ...state }
    const counts = sweepCounts()
    results = []
    // Throwaway mount so the first measured run doesn't pay the one-time shader compile.
    runButton.textContent = 'Warming up…'
    Object.assign(state, { strategy: 'shared', count: 1 })
    await Promise.race([remount(), sleep(10000)])
    const total = strategies.length * counts.length
    try {
      for (const strategy of strategies) {
        for (const count of counts) {
          if (disposed || stopRequested) break
          Object.assign(state, { strategy, count })
          runButton.textContent = `Stop · ${results.length + 1}/${total}: ${STRATEGIES[strategy].title}, ${count} instances`
          const init = await Promise.race([remount(), sleep(20000).then(() => undefined)])
          await sleep(WARMUP_MS)
          sampler.start()
          await sleep(MEASURE_MS)
          const run = sampler.read(refreshMs)
          showLive(run)
          results.push({ fx: state.fx, strategy, count, activity: state.activity, synced: state.synced, dprMax: state.dprMax, scale: state.scale, tilePx, load: { ...state.load }, hardware: hwPreset >= 0 ? HARDWARE[hwPreset].title : 'Custom', run, init: init ?? lastInit ?? timedOutInit() })
          renderResults()
        }
      }
    } finally {
      setBusy(false)
      runButton.textContent = 'Run benchmark'
      renderResults()
      if (!disposed) {
        Object.assign(state, saved)
        remount()
        sampler.start()
      }
    }
  })

  const renderResults = () => {
    if (!results.length) return
    const series = (pick: (r: Result) => number | undefined) =>
      strategies.map((s, i) => ({
        name: STRATEGIES[s].title,
        color: SERIES_COLORS[i],
        points: results.filter((r) => r.strategy === s).map((r) => ({ x: r.count, y: pick(r) })),
      }))
    const first = results[0]
    resultsEl.innerHTML = `
      <p class="lab-note">${FX[first.fx].title} · ${Math.round(first.activity * 100)} % animating${first.synced ? ' in sync' : ''} · DPR ≤ ${first.dprMax}${first.scale !== undefined ? ` · tile size ${Math.round(first.scale * 100)} %` : ''}${first.load && (first.load.gpu > 1 || first.load.cpu > 1) ? ` · emulated ${first.hardware}: GPU ×${first.load.gpu}, CPU ×${first.load.cpu}` : ''} · ${Math.round(1000 / refreshMs)} Hz display</p>
      ${lineChart({ title: 'Frame time p95 (ms)', series: series((r) => r.run.p95), budget: refreshMs, unit: 'ms' })}
      ${lineChart({ title: 'Main-thread JS per frame (ms)', series: series((r) => r.run.cpuMs), unit: 'ms' })}
      ${results.some((r) => r.run.gpuMs !== undefined) ? lineChart({ title: 'GPU time per frame, all canvases (ms)', series: series((r) => r.run.gpuMs), unit: 'ms' }) : ''}
      ${lineChart({ title: 'Startup: first frame (ms)', series: series((r) => r.init.firstFrameMs), unit: 'ms' })}
      <div class="lab-table-wrap"><table class="lab-table">
        <thead><tr><th>Strategy</th><th>N</th><th>Verdict</th><th>FPS</th><th>p95</th><th>Drop</th><th>JS</th><th>GPU</th><th>1st frame</th><th>TBT</th><th>Dev.</th></tr></thead>
        <tbody>${results.map((r) => resultRow(r, lines())).join('')}</tbody>
      </table></div>
      ${results.some((r) => r.strategy === 'naive') ? '<p class="lab-note">GPU time can’t be measured for Naive (each tile has its own GPU device and their work overlaps), so its verdict covers FPS, frame time and JS only.</p>' : ''}${results.length < strategies.length * sweepCounts().length && !running ? '<p class="lab-note">Stopped early — partial results.</p>' : ''}
      <button class="button" data-report>Download report (HTML, printable to PDF)</button>
      <div class="button-row">
        <button class="button" data-copy>Copy Markdown</button>
        <button class="button" data-json>Download JSON</button>
      </div>
    `
    resultsEl.querySelector('[data-copy]')!.addEventListener('click', (e) => {
      navigator.clipboard.writeText(toMarkdown(results, refreshMs))
      ;(e.target as HTMLButtonElement).textContent = 'Copied'
    })
    resultsEl.querySelector('[data-report]')!.addEventListener('click', () => {
      const html = buildReport({ results, refreshMs, gpu: gpuName ? `GPU ${gpuName}` : '', lighthouse: lighthouseData })
      download(new Blob([html], { type: 'text/html' }), `vgpu-performance-${first.fx}-${new Date().toISOString().slice(0, 10)}.html`)
    })
    resultsEl.querySelector('[data-json]')!.addEventListener('click', () => {
      download(new Blob([JSON.stringify({ userAgent: navigator.userAgent, refreshMs, results }, null, 2)], { type: 'application/json' }), `vgpu-perf-${first.fx}.json`)
    })
  }

  let lighthouseData: LighthouseSummary | undefined
  loadLighthouse(panel.querySelector<HTMLElement>('[data-lighthouse]')!).then((d) => (lighthouseData = d))
  remount()
  sampler.start()

  return () => {
    disposed = true
    clearInterval(liveTimer)
    gridSize.disconnect()
    sampler.stop()
    field?.dispose()
  }
}

function download(blob: Blob, name: string) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name })
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

const timedOutInit = (): Result['init'] => ({
  devices: 0, tilesReady: 0, failed: 1, error: 'timed out', deviceMs: NaN, resourcesMs: NaN, firstFrameMs: NaN, gpuTiming: false, longTasks: 0, blockingMs: NaN,
})

const metrics = (rows: [string, string, string?, Rating?][]) =>
  rows
    .map(([k, v, hint, r]) => {
      const mark = r ? `<i style="color:${RATING[r].color}" title="${RATING[r].label}">${RATING[r].icon}</i>` : ''
      return `<div class="${r ?? ''}"><span>${k}${mark}</span><b>${v}</b>${hint ? `<small>${hint}</small>` : ''}</div>`
    })
    .join('')

function resultRow(r: Result, l: ReturnType<typeof thresholds>) {
  const v = verdict(r, l)
  return `<tr${r.init.failed ? ' class="fail"' : ''}>
    <td>${STRATEGIES[r.strategy].title}</td><td>${r.count}</td>
    <td><span class="rated ${v}"><i style="color:${RATING[v].color}">${RATING[v].icon}</i>${RATING[v].label}</span></td>
    <td>${rated(l, 'fps', r.run.fps, fmt(r.run.fps, 0))}</td><td>${rated(l, 'p95', r.run.p95, fmt(r.run.p95))}</td>
    <td>${rated(l, 'dropped', r.run.dropped, `${fmt(r.run.dropped * 100, 0)}%`)}</td><td>${rated(l, 'cpu', r.run.cpuMs, fmt(r.run.cpuMs, 2))}</td>
    <td>${r.strategy === 'naive' ? '<span class="muted" title="Not measurable: one GPU device per tile">n/m</span>' : rated(l, 'gpu', r.run.gpuMs, fmt(r.run.gpuMs, 2))}</td><td>${rated(l, 'firstFrame', r.init.firstFrameMs, fmt(r.init.firstFrameMs, 0))}</td>
    <td>${rated(l, 'tbtInit', r.init.blockingMs, fmt(r.init.blockingMs, 0))}</td><td>${r.init.devices}${r.init.failed ? ` (${r.init.failed}✕)` : ''}</td></tr>`
}

function liveMetrics(w: Window, refreshMs: number, gpuNote: string) {
  const busy = w.cpuMs + (w.gpuMs ?? 0)
  const l = thresholds(refreshMs)
  const worst = (a?: Rating, b?: Rating) => (a === 'poor' || b === 'poor' ? 'poor' : a === 'warn' || b === 'warn' ? 'warn' : a ?? b)
  return metrics([
    ['FPS', fmt(w.fps, 0), `${fmt(w.dropped * 100, 0)} % frames dropped`, worst(rate(l.fps, w.fps), rate(l.dropped, w.dropped))],
    ['Frame p50 / p95', `${fmt(w.p50)} / ${fmt(w.p95)} ms`, `p99 ${fmt(w.p99)} ms`, rate(l.p95, w.p95)],
    ['JS per frame', `${fmt(w.cpuMs, 2)} ms`, `${fmt((w.cpuMs / refreshMs) * 100, 0)} % of budget`, rate(l.cpu, w.cpuMs)],
    ['GPU per frame', w.gpuMs === undefined ? 'n/a' : `${fmt(w.gpuMs, 2)} ms`, w.gpuMs === undefined ? gpuNote : `${fmt((busy / refreshMs) * 100, 0)} % budget incl. JS`, rate(l.gpu, w.gpuMs)],
    ['Canvas pixels drawn', `${fmt(w.mpx, 2)} Mpx`, 'per frame, before emulation'],
    ['Long tasks', String(w.longTasks), w.heapMb ? `${fmt(w.heapMb, 0)} MB JS heap` : ''],
  ])
}

/** One-line summary above the tiles, so the effect of a setting is visible without scrolling the panel. */
function liveStatus(w: Window, refreshMs: number) {
  const l = thresholds(refreshMs)
  const item = (label: string, metric: Parameters<typeof rated>[1], value: number | undefined, text: string) => `<span><small>${label}</small>${rated(l, metric, value, text)}</span>`
  return [
    item('FPS', 'fps', w.fps, fmt(w.fps, 0)),
    item('Frame p95', 'p95', w.p95, `${fmt(w.p95)} ms`),
    item('JS / frame', 'cpu', w.cpuMs, `${fmt(w.cpuMs, 2)} ms`),
    w.gpuMs === undefined ? '<span><small>GPU / frame</small><span class="muted">n/a</span></span>' : item('GPU / frame', 'gpu', w.gpuMs, `${fmt(w.gpuMs, 2)} ms · ${fmt((w.gpuMs / refreshMs) * 100, 0)} % of budget`),
  ].join('')
}

function toMarkdown(results: Result[], refreshMs: number) {
  const r0 = results[0]
  const head = `**${FX[r0.fx].title}** · ${Math.round(r0.activity * 100)} % animating${r0.synced ? ' in sync' : ''} · DPR ≤ ${r0.dprMax}${r0.scale !== undefined ? ` · tile size ${Math.round(r0.scale * 100)} %` : ''}${r0.load && (r0.load.gpu > 1 || r0.load.cpu > 1) ? ` · emulated ${r0.hardware}: GPU ×${r0.load.gpu}, CPU ×${r0.load.cpu}` : ''} · ${Math.round(1000 / refreshMs)} Hz · ${navigator.userAgent}\n\n`
  const rows = results.map(
    (r) =>
      `| ${STRATEGIES[r.strategy].title} | ${r.count} | ${RATING[verdict(r, thresholds(refreshMs))].icon} ${RATING[verdict(r, thresholds(refreshMs))].label} | ${fmt(r.run.fps, 0)} | ${fmt(r.run.p95)} | ${fmt(r.run.dropped * 100, 0)} % | ${fmt(r.run.cpuMs, 2)} | ${fmt(r.run.gpuMs, 2)} | ${fmt(r.init.firstFrameMs, 0)} | ${fmt(r.init.blockingMs, 0)} | ${r.init.devices} |`,
  )
  return head + ['| Strategy | Instances | Verdict | FPS | p95 ms | Dropped | JS ms/frame | GPU ms/frame | First frame ms | TBT ms | Devices |', '|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|', ...rows].join('\n')
}

// Results written by `npm run perf:lighthouse` (served by the dev server from the project root).
async function loadLighthouse(el: HTMLElement): Promise<LighthouseSummary | undefined> {
  const howTo = `<p class="lab-note">Lighthouse runs against a production build in a fresh Chrome, so it can't run inside this tab. Generate a report with</p>
    <pre>npm run perf:lighthouse</pre>
    <p class="lab-note">It builds the app, serves <code>bench.html</code> (a landing-like page with N effect cards), audits each scenario with the mobile and desktop presets and measures runtime FPS. Results appear here and in <code>perf-reports/</code>.</p>`
  try {
    const res = await fetch('/perf-reports/summary.json', { cache: 'no-store' })
    if (!res.ok) throw new Error()
    const data = (await res.json()) as LighthouseSummary
    const groups = [...new Set(data.runs.map((r) => r.formFactor))]
    el.innerHTML = `
      <p class="lab-note">${new Date(data.date).toLocaleString()} · Lighthouse ${data.lighthouseVersion} · ${data.runsPerScenario} run(s) per scenario, median shown.</p>
      ${groups
        .map(
          (ff) => `<h3>${ff}</h3><div class="lab-table-wrap"><table class="lab-table">
            <thead><tr><th>Scenario</th><th>Score</th><th>LCP</th><th>TBT</th><th>CLS</th><th>FCP</th><th>FPS</th><th>JS/fr</th></tr></thead>
            <tbody>${data.runs
              .filter((r) => r.formFactor === ff)
              .map((r) => {
                const l = thresholds(r.runtime?.refreshMs ?? 1000 / 60)
                return `<tr><td><a href="/perf-reports/${r.report}" target="_blank" rel="noopener">${r.label}</a></td><td>${rated(l, 'score', r.score, String(r.score ?? '—'))}</td>
                  <td>${rated(l, 'lcp', r.lcp, `${fmt(r.lcp / 1000, 2)} s`)}</td><td>${rated(l, 'tbt', r.tbt, `${fmt(r.tbt, 0)} ms`)}</td><td>${rated(l, 'cls', r.cls, fmt(r.cls, 3))}</td>
                  <td>${rated(l, 'fcp', r.fcp, `${fmt(r.fcp / 1000, 2)} s`)}</td><td>${rated(l, 'fps', r.runtime?.fps, fmt(r.runtime?.fps, 0))}</td><td>${rated(l, 'cpu', r.runtime?.cpuMs, fmt(r.runtime?.cpuMs, 2))}</td></tr>`
              })
              .join('')}</tbody></table></div>`,
        )
        .join('')}
      <details><summary>How to re-run</summary>${howTo}</details>`
    return data
  } catch {
    el.innerHTML = howTo
  }
}

export type LighthouseSummary = {
  date: string
  lighthouseVersion: string
  runsPerScenario: number
  chrome?: string
  gpu?: string
  runs: {
    label: string
    strategy: string
    formFactor: string
    report: string
    score?: number
    lcp: number
    tbt: number
    cls: number
    fcp: number
    bytes: number
    runtime?: { fps: number; p95: number; cpuMs: number; gpuMs?: number; refreshMs?: number; init?: { devices: number } }
  }[]
}
