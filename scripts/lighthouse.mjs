// Lighthouse + runtime benchmark of bench.html across strategies.
//
//   npm run perf:lighthouse                       smoke, 12 cards, 1 run per scenario
//   npm run perf:lighthouse -- --fx=smoke,reveal --count=6,24 --runs=3 --no-build
//
// Writes perf-reports/<scenario>.html (full Lighthouse reports), summary.json
// (read by the Performance tab) and summary.md.
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import * as chromeLauncher from 'chrome-launcher'
import lighthouse from 'lighthouse'
import desktopConfig from 'lighthouse/core/config/desktop-config.js'
import { computeMedianRun } from 'lighthouse/core/lib/median-run.js'
import puppeteer from 'puppeteer-core'

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? true]
  }),
)
const list = (v, fallback) => (typeof v === 'string' ? v.split(',') : fallback)
const FX = list(args.fx, ['smoke'])
const COUNTS = list(args.count, ['12']).map(Number)
const STRATEGIES = list(args.strategy, ['none', 'naive', 'shared', 'production'])
const FORM_FACTORS = list(args.formFactor, ['mobile', 'desktop'])
const RUNS = Number(args.runs ?? 1)
const PORT = Number(args.port ?? 4317)
const OUT = 'perf-reports'
const ORIGIN = `http://localhost:${PORT}`
const CHROME_FLAGS = ['--headless=new', '--enable-unsafe-webgpu', '--no-first-run', '--no-default-browser-check']

const run = (cmd, cmdArgs, opts = {}) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, cmdArgs, { stdio: 'inherit', ...opts })
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${cmdArgs.join(' ')} exited with ${code}`))))
  })

async function waitForServer(url) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return
    } catch {}
    await sleep(100)
  }
  throw new Error(`server at ${url} did not start`)
}

const pick = (lhr) => {
  const a = lhr.audits
  return {
    score: lhr.categories.performance.score === null ? undefined : Math.round(lhr.categories.performance.score * 100),
    fcp: a['first-contentful-paint'].numericValue,
    lcp: a['largest-contentful-paint'].numericValue,
    tbt: a['total-blocking-time'].numericValue,
    cls: a['cumulative-layout-shift'].numericValue,
    si: a['speed-index'].numericValue,
    mainThreadMs: a['mainthread-work-breakdown'].numericValue,
    bootupMs: a['bootup-time'].numericValue,
    bytes: a['total-byte-weight'].numericValue,
    lcpElement: JSON.stringify(a['lcp-breakdown-insight']?.details ?? {}).match(/"snippet":"((?:[^"\\]|\\.)*)"/)?.[1]?.replace(/\\"/g, '"'),
  }
}

// Runtime: the same page with 25 % of the cards animating, measured from inside the page.
async function measureRuntime(port, url) {
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 2 } })
  const page = await browser.newPage()
  try {
    await page.goto(url, { waitUntil: 'load' })
    const init = await page.evaluate(() => window.__bench.ready)
    await sleep(1000)
    const run = await page.evaluate(() => window.__bench.measure(4000))
    return { init, ...run }
  } finally {
    await page.close()
    browser.disconnect()
  }
}

if (!args['no-build']) await run('npx', ['vite', 'build'])
await mkdir(OUT, { recursive: true })
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' })
const chrome = await chromeLauncher.launch({ chromeFlags: CHROME_FLAGS })
const summary = { date: new Date().toISOString(), lighthouseVersion: '', runsPerScenario: RUNS, chrome: '', gpu: '', runs: [] }

try {
  await waitForServer(`${ORIGIN}/bench.html`)
  const probe = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}` })
  summary.chrome = await probe.version()
  const probePage = await probe.newPage()
  await probePage.goto(`${ORIGIN}/bench.html?strategy=none&count=1`)
  summary.gpu = await probePage.evaluate(async () => {
    const a = await navigator.gpu?.requestAdapter()
    return a ? `${a.info.vendor} ${a.info.architecture}`.trim() : 'no WebGPU'
  })
  await probePage.close()
  probe.disconnect()
  console.log(`${summary.chrome} · GPU: ${summary.gpu}`)

  for (const fx of FX) {
    for (const count of COUNTS) {
      for (const strategy of STRATEGIES) {
        const query = `fx=${fx}&count=${count}&strategy=${strategy}`
        const label = `${fx} ×${count} · ${strategy}`
        const runtime =
          strategy === 'none' ? undefined : await measureRuntime(chrome.port, `${ORIGIN}/bench.html?${query}&activity=0.25&gpuTiming`).catch((e) => ({ error: String(e) }))

        for (const formFactor of FORM_FACTORS) {
          const lhrs = []
          let report = ''
          for (let i = 0; i < RUNS; i++) {
            const result = await lighthouse(
              `${ORIGIN}/bench.html?${query}`,
              { port: chrome.port, output: 'html', logLevel: 'error', onlyCategories: ['performance'] },
              formFactor === 'desktop' ? desktopConfig : undefined,
            )
            lhrs.push(result.lhr)
            if (lhrs.length === 1 || computeMedianRun(lhrs) === result.lhr) report = result.report
          }
          const median = computeMedianRun(lhrs)
          summary.lighthouseVersion = median.lighthouseVersion
          const file = `${fx}-${count}-${strategy}-${formFactor}.html`
          await writeFile(`${OUT}/${file}`, report)
          const row = { label, fx, count, strategy, formFactor, report: file, ...pick(median), runtime }
          summary.runs.push(row)
          console.log(
            `${label.padEnd(28)} ${formFactor.padEnd(8)} score ${String(row.score).padStart(3)}  LCP ${(row.lcp / 1000).toFixed(2)} s  TBT ${row.tbt.toFixed(0)} ms  CLS ${row.cls.toFixed(3)}` +
              (runtime && !runtime.error ? `  | runtime ${runtime.fps.toFixed(0)} fps, JS ${runtime.cpuMs.toFixed(2)} ms, GPU ${runtime.gpuMs?.toFixed(2) ?? 'n/a'} ms` : ''),
          )
        }
      }
    }
  }
} finally {
  await chrome.kill()
  server.kill()
}

await writeFile(`${OUT}/summary.json`, JSON.stringify(summary, null, 2))
const f = (v, d = 0) => (v === undefined || v === null || Number.isNaN(v) ? '—' : Number(v).toFixed(d))
// Same lines as src/perf-lab/thresholds.ts: ✓ good, ! needs work, ✕ poor.
const mark = (v, good, poor, higher = false) =>
  v === undefined || v === null || Number.isNaN(v) ? '' : (higher ? v >= good : v <= good) ? '✓ ' : (higher ? v >= poor : v <= poor) ? '! ' : '✕ '
const md = [
  `# vgpu effects — Lighthouse`,
  ``,
  `${summary.date} · Lighthouse ${summary.lighthouseVersion} · ${summary.chrome} · GPU ${summary.gpu} · ${RUNS} run(s) per scenario (median)`,
  ``,
  `✓ good · ! needs work · ✕ poor (Core Web Vitals / Lighthouse thresholds: score ≥ 90 / < 50, FCP ≤ 1.8 / > 3 s, LCP ≤ 2.5 / > 4 s, TBT ≤ 200 / > 600 ms, CLS ≤ 0.1 / > 0.25).`,
  ``,
  `Runtime columns: same page at 1280×800 @2x with 25 % of the cards animating, measured in-page for 4 s.`,
  ``,
  `| Scenario | Form factor | Score | FCP s | LCP s | TBT ms | CLS | Main thread ms | Bytes KB | Runtime FPS | p95 ms | JS ms/frame | GPU ms/frame | Devices |`,
  `|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|`,
  ...summary.runs.map(
    (r) =>
      `| ${r.label} | ${r.formFactor} | ${mark(r.score, 90, 50, true)}${f(r.score)} | ${mark(r.fcp, 1800, 3000)}${f(r.fcp / 1000, 2)} | ${mark(r.lcp, 2500, 4000)}${f(r.lcp / 1000, 2)} | ${mark(r.tbt, 200, 600)}${f(r.tbt)} | ${mark(r.cls, 0.1, 0.25)}${f(r.cls, 3)} | ${f(r.mainThreadMs)} | ${f(r.bytes / 1024)} | ${f(r.runtime?.fps)} | ${f(r.runtime?.p95, 1)} | ${f(r.runtime?.cpuMs, 2)} | ${f(r.runtime?.gpuMs, 2)} | ${f(r.runtime?.init?.devices)} |`,
  ),
].join('\n')
await writeFile(`${OUT}/summary.md`, md + '\n')
console.log(`\nWrote ${OUT}/summary.md, summary.json and ${summary.runs.length} HTML reports.`)
