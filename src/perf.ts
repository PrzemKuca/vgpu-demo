// Small fixed overlay with FPS and frame-time stats, sampled from rAF.
export function mountPerfOverlay(parent: HTMLElement) {
  const el = document.createElement('div')
  el.className = 'perf'
  parent.append(el)

  let gpuName = ''
  navigator.gpu
    ?.requestAdapter()
    .then((a) => (gpuName = a?.info ? [a.info.vendor, a.info.architecture].filter(Boolean).join(' ') : ''))
    .catch(() => {})

  const times: number[] = []
  let last = performance.now()
  let lastPaint = 0

  const tick = (now: number) => {
    times.push(now - last)
    last = now
    if (times.length > 120) times.shift()

    if (now - lastPaint > 250) {
      lastPaint = now
      const avg = times.reduce((a, b) => a + b, 0) / times.length
      const worst = Math.max(...times)
      const fps = 1000 / avg
      const memory = (performance as any).memory?.usedJSHeapSize as number | undefined
      el.innerHTML = `
        <span class="fps ${fps < 50 ? 'warn' : ''}">${fps.toFixed(0)} fps</span>
        <span>${avg.toFixed(1)} ms avg · ${worst.toFixed(1)} max</span>
        ${memory ? `<span>${(memory / 1048576).toFixed(0)} MB heap</span>` : ''}
        ${gpuName ? `<span>${gpuName}</span>` : ''}
      `
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}
