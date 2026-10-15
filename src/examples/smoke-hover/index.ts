import { clock, effect, frameLoop, init, sampler, surface, texture } from 'vgpu'
import type { Gpu } from 'vgpu'
import smokeShader from './smoke.wgsl'

const IMAGE_A = 'https://picsum.photos/id/1015/1200/800'
const IMAGE_B = 'https://picsum.photos/id/1043/1200/800'
const TEX_SIZE: [number, number] = [1200, 800]
const DEFAULT_DURATION = 1.8 // seconds for a full A -> B transition
const PAD = 0.3 // gas canvas overflow around the image (fraction of its size)

async function loadTexture(gpu: Gpu, url: string) {
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.src = url
  await img.decode()

  // Cover-crop into a fixed-size canvas so both images share one aspect.
  const [w, h] = TEX_SIZE
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')!
  const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight)
  const dw = img.naturalWidth * scale
  const dh = img.naturalHeight * scale
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh)

  const tex = texture(gpu, {
    kind: '2d',
    size: TEX_SIZE,
    format: 'rgba8unorm',
    usage: ['texture_binding', 'copy_dst', 'render_attachment'],
    label: url,
  })
  gpu.gpu.queue.copyExternalImageToTexture({ source: canvas }, { texture: tex.gpu }, TEX_SIZE)
  return tex
}

export function mountSmokeHover(root: HTMLElement) {
  root.innerHTML = `
    <div class="smoke-hover">
      <canvas></canvas>
      <p class="hint">Hover over the image</p>
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
        <span class="label">Transition time <output data-out="duration">${DEFAULT_DURATION.toFixed(1)} s</output></span>
        <input type="range" name="duration" min="0.3" max="6" step="0.1" value="${DEFAULT_DURATION}" />
      </label>
      <label class="field check">
        <input type="checkbox" name="freeze" />
        <span>Freeze smoke motion</span>
      </label>
    </aside>
  `
  const card = root.querySelector<HTMLDivElement>('.smoke-hover')!
  const canvas = card.querySelector('canvas')!
  Object.assign(canvas.style, {
    left: `${-PAD * 100}%`,
    top: `${-PAD * 100}%`,
    width: `${(1 + 2 * PAD) * 100}%`,
    height: `${(1 + 2 * PAD) * 100}%`,
  })

  let disposed = false
  let gpu: Gpu | undefined
  let stopLoop: (() => void) | undefined
  let target = 0
  let progress = 0
  let duration = DEFAULT_DURATION
  let mode: 'hover' | 'manual' = 'hover'
  let frozen = false

  const panel = root.querySelector<HTMLElement>('.controls')!
  const progressInput = panel.querySelector<HTMLInputElement>('[name=progress]')!
  const progressOut = panel.querySelector<HTMLOutputElement>('[data-out=progress]')!
  const durationOut = panel.querySelector<HTMLOutputElement>('[data-out=duration]')!
  const modeButtons = panel.querySelectorAll<HTMLButtonElement>('[data-mode]')

  const setMode = (next: typeof mode) => {
    mode = next
    modeButtons.forEach((b) => b.classList.toggle('active', b.dataset.mode === next))
    target = progress
  }
  modeButtons.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode as typeof mode)))

  // Dragging the slider takes over the animation.
  progressInput.addEventListener('input', () => {
    if (mode !== 'manual') setMode('manual')
    progress = target = progressInput.valueAsNumber
  })
  panel.querySelector<HTMLInputElement>('[name=duration]')!.addEventListener('input', (e) => {
    duration = (e.target as HTMLInputElement).valueAsNumber
    durationOut.textContent = `${duration.toFixed(1)} s`
  })
  panel.querySelector<HTMLInputElement>('[name=freeze]')!.addEventListener('change', (e) => {
    frozen = (e.target as HTMLInputElement).checked
  })

  card.addEventListener('pointerenter', () => mode === 'hover' && (target = 1))
  card.addEventListener('pointerleave', () => mode === 'hover' && (target = 0))

  ;(async () => {
    const g = await init()
    if (disposed) return g.dispose()
    gpu = g

    const [a, b] = await Promise.all([loadTexture(g, IMAGE_A), loadTexture(g, IMAGE_B)])
    if (disposed) return

    const canvasSurface = surface(g, canvas, { dpr: [1, 2] })
    const fx = effect(g, smokeShader, {
      set: {
        params: { time: 0, progress: 0, aspect: TEX_SIZE[0] / TEX_SIZE[1], pad: PAD },
        imageA: a,
        imageB: b,
        samp: sampler(g, { minFilter: 'linear', magFilter: 'linear' }),
      },
    })

    const time = clock(g)
    let smokeTime = 0
    const handle = frameLoop(g, (frame) => {
      if (!frozen) smokeTime += time.deltaTime
      if (mode === 'hover') {
        const step = time.deltaTime / duration
        progress = target > progress ? Math.min(target, progress + step) : Math.max(target, progress - step)
        progressInput.value = String(progress)
      }
      progressOut.textContent = progress.toFixed(2)
      // Manual scrubbing maps 1:1; the hover animation gets an ease-in-out.
      const shown = mode === 'manual' ? progress : progress * progress * (3 - 2 * progress)
      fx.set({ params: { time: smokeTime, progress: shown } })
      frame.pass(canvasSurface, fx)
    })
    stopLoop = () => handle.stop()
  })().catch((err) => {
    console.error(err)
    card.innerHTML = `<p class="placeholder">WebGPU unavailable: ${err.message ?? err}</p>`
  })

  return () => {
    disposed = true
    stopLoop?.()
    gpu?.dispose()
  }
}
