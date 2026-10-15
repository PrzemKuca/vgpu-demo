import { clock, effect, frameLoop, init, sampler, surface, texture } from 'vgpu'
import type { Gpu, Texture } from 'vgpu'
import buttonShader from './button.wgsl'

const LABEL = 'VISIT WEBSITE'
const BUTTON: [number, number] = [380, 84] // css px
const RADIUS = 10
const PAD: [number, number] = [220, 130] // room for the energy wave around the button, css px
const OFFSET: [number, number] = [BUTTON[0] * 0.38, -BUTTON[1] * 0.55] // tooltip centre relative to the cursor
const DEFAULT_DURATION = 0.9 // seconds for a full reveal

export function mountButtonHover(root: HTMLElement) {
  root.innerHTML = `
    <div class="button-scene">
      <div class="fx-trigger">
        <span>Hover me</span>
        <small>The button follows the cursor as a tooltip</small>
      </div>
      <div class="fx-tooltip"><canvas></canvas></div>
    </div>
    <aside class="controls">
      <h2>Controls</h2>
      <div class="field">
        <span class="label">Mode</span>
        <div class="segmented">
          <button data-mode="hover" class="active">Hover</button>
          <button data-mode="manual">Manual</button>
        </div>
      </div>
      <label class="field">
        <span class="label">Progress <output data-out="progress">0.00</output></span>
        <input type="range" name="progress" min="0" max="1" step="0.001" value="0" />
      </label>
      <label class="field">
        <span class="label">Duration <output data-out="duration">${DEFAULT_DURATION.toFixed(2)} s</output></span>
        <input type="range" name="duration" min="0.2" max="3" step="0.05" value="${DEFAULT_DURATION}" />
      </label>
      <label class="field">
        <span class="label">Glow <output data-out="glow">1.00</output></span>
        <input type="range" name="glow" min="0.2" max="1.6" step="0.01" value="1" />
      </label>
      <label class="field">
        <span class="label">Wobble <output data-out="wobble">1.00</output></span>
        <input type="range" name="wobble" min="0" max="2" step="0.01" value="1" />
      </label>
    </aside>
  `
  const scene = root.querySelector<HTMLElement>('.button-scene')!
  const trigger = root.querySelector<HTMLElement>('.fx-trigger')!
  const tooltip = root.querySelector<HTMLElement>('.fx-tooltip')!
  const canvas = tooltip.querySelector('canvas')!
  const panel = root.querySelector<HTMLElement>('.controls')!

  const tooltipSize: [number, number] = [BUTTON[0] + PAD[0] * 2, BUTTON[1] + PAD[1] * 2]
  Object.assign(tooltip.style, { width: `${tooltipSize[0]}px`, height: `${tooltipSize[1]}px` })

  let mode: 'hover' | 'manual' = 'hover'
  let target = 0
  let progress = 0
  let duration = DEFAULT_DURATION
  let glow = 1
  let wobble = 1

  const progressInput = panel.querySelector<HTMLInputElement>('[name=progress]')!
  const progressOut = panel.querySelector<HTMLOutputElement>('[data-out=progress]')!
  const modeButtons = panel.querySelectorAll<HTMLButtonElement>('[data-mode]')
  const setMode = (next: typeof mode) => {
    mode = next
    modeButtons.forEach((b) => b.classList.toggle('active', b.dataset.mode === next))
    target = progress
    if (next === 'manual') parkTooltip()
  }
  modeButtons.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode as typeof mode)))
  progressInput.addEventListener('input', () => {
    if (mode !== 'manual') setMode('manual')
    progress = target = progressInput.valueAsNumber
  })
  const slider = (name: string, apply: (v: number) => void, format: (v: number) => string) => {
    const input = panel.querySelector<HTMLInputElement>(`[name=${name}]`)!
    const out = panel.querySelector<HTMLOutputElement>(`[data-out=${name}]`)!
    input.addEventListener('input', () => {
      apply(input.valueAsNumber)
      out.textContent = format(input.valueAsNumber)
    })
  }
  slider('duration', (v) => (duration = v), (v) => `${v.toFixed(2)} s`)
  slider('glow', (v) => (glow = v), (v) => v.toFixed(2))
  slider('wobble', (v) => (wobble = v), (v) => v.toFixed(2))

  // Tooltip position: follows the cursor (eased) while hovering the trigger.
  const goal = { x: 0, y: 0 }
  const pos = { x: 0, y: 0 }
  const parkTooltip = () => {
    const s = scene.getBoundingClientRect()
    const t = trigger.getBoundingClientRect()
    goal.x = t.left - s.left + t.width / 2
    goal.y = t.top - s.top - BUTTON[1]
  }
  const follow = (e: PointerEvent, snap = false) => {
    const s = scene.getBoundingClientRect()
    goal.x = e.clientX - s.left + OFFSET[0]
    goal.y = e.clientY - s.top + OFFSET[1]
    if (snap) Object.assign(pos, goal)
  }
  trigger.addEventListener('pointerenter', (e) => {
    if (mode !== 'hover') return
    follow(e, progress < 0.05)
    target = 1
  })
  trigger.addEventListener('pointermove', (e) => mode === 'hover' && follow(e))
  trigger.addEventListener('pointerleave', () => {
    if (mode === 'hover') target = 0
  })
  parkTooltip()
  Object.assign(pos, goal)

  let disposed = false
  let gpu: Gpu | undefined
  let stopLoop: (() => void) | undefined

  ;(async () => {
    const g = await init()
    if (disposed) return g.dispose()
    gpu = g

    const linear = sampler(g, { minFilter: 'linear', magFilter: 'linear' })
    const canvasSurface = surface(g, canvas, { dpr: [1, 2] })
    const fx = effect(g, buttonShader, { set: { samp: linear } })

    // The label is rasterized at canvas resolution, centred on the button.
    let labelTexture: Texture | undefined
    let scale = 1
    canvasSurface.onResize(({ width, height }) => {
      scale = width / tooltipSize[0]
      const source = new OffscreenCanvas(width, height)
      const ctx = source.getContext('2d')!
      ctx.scale(scale, scale)
      const cx = tooltipSize[0] / 2
      const cy = tooltipSize[1] / 2
      ctx.fillStyle = '#000'
      ctx.textBaseline = 'middle'
      ctx.font = '400 30px system-ui, -apple-system, "Helvetica Neue", sans-serif'
      ctx.fillText(LABEL, cx - BUTTON[0] / 2 + 30, cy + 1)
      // Arrow icon at the right end.
      ctx.lineWidth = 2.5
      ctx.strokeStyle = '#000'
      const ax = cx + BUTTON[0] / 2 - 46
      ctx.beginPath()
      ctx.moveTo(ax, cy + 12)
      ctx.lineTo(ax + 24, cy - 12)
      ctx.moveTo(ax + 6, cy - 12)
      ctx.lineTo(ax + 24, cy - 12)
      ctx.lineTo(ax + 24, cy + 6)
      ctx.stroke()
      const next = texture(g, {
        kind: '2d',
        size: [width, height],
        format: 'rgba8unorm',
        usage: ['texture_binding', 'copy_dst', 'render_attachment'],
        label: 'button-label',
      })
      g.gpu.queue.copyExternalImageToTexture({ source }, { texture: next.gpu, premultipliedAlpha: true }, [width, height])
      fx.set({ label: next })
      labelTexture?.destroy()
      labelTexture = next
    })

    const time = clock(g)
    const handle = frameLoop(g, (frame) => {
      const dt = time.deltaTime
      if (mode === 'hover') {
        const step = dt / duration
        progress = target > progress ? Math.min(target, progress + step) : Math.max(target, progress - step)
        progressInput.value = String(progress)
      }
      progressOut.textContent = progress.toFixed(2)

      const k = Math.min(dt * 14, 1)
      pos.x += (goal.x - pos.x) * k
      pos.y += (goal.y - pos.y) * k
      tooltip.style.transform = `translate(${pos.x - tooltipSize[0] / 2}px, ${pos.y - tooltipSize[1] / 2}px)`

      fx.set({
        params: {
          canvasSize: tooltipSize,
          half: [BUTTON[0] / 2, BUTTON[1] / 2],
          radius: RADIUS,
          progress,
          time: time.time,
          glow,
          wobble,
        },
      })
      frame.pass({ target: canvasSurface, clear: [0, 0, 0, 0] }, (pass) => pass.draw(fx))
    })
    stopLoop = () => handle.stop()
  })().catch((err) => {
    console.error(err)
    tooltip.innerHTML = `<p class="placeholder">WebGPU unavailable: ${err.message ?? err}</p>`
  })

  return () => {
    disposed = true
    stopLoop?.()
    gpu?.dispose()
  }
}
