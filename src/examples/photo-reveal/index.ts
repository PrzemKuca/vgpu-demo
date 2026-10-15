import { clock, effect, frameLoop, init, sampler, surface, texture } from 'vgpu'
import type { Gpu } from 'vgpu'
import revealShader from './reveal.wgsl'
// From noaignite.com (contacts). Kept local: the CDN sends no CORS headers,
// so it can't be uploaded to a WebGPU texture straight from there.
import PHOTO_URL from './photo.webp'

const PHOTO: [number, number] = [400, 500] // css px
const PAD: [number, number] = [115, 120] // room for the glow, css px
const DEFAULT_DURATION = 1.4 // seconds for a full reveal

export function mountPhotoReveal(root: HTMLElement) {
  root.innerHTML = `
    <div class="photo-scene">
      <canvas></canvas>
    </div>
    <aside class="controls">
      <h2>Controls</h2>
      <div class="field">
        <span class="label">Mode</span>
        <div class="segmented">
          <button data-mode="toggle" class="active">Toggle</button>
          <button data-mode="manual">Manual</button>
        </div>
      </div>
      <button class="button" data-toggle>Show photo</button>
      <label class="field">
        <span class="label">Progress <output data-out="progress">0.00</output></span>
        <input type="range" name="progress" min="0" max="1" step="0.001" value="0" />
      </label>
      <label class="field">
        <span class="label">Duration <output data-out="duration">${DEFAULT_DURATION.toFixed(2)} s</output></span>
        <input type="range" name="duration" min="0.3" max="4" step="0.05" value="${DEFAULT_DURATION}" />
      </label>
      <label class="field">
        <span class="label">Glow <output data-out="glow">1.00</output></span>
        <input type="range" name="glow" min="0" max="1.5" step="0.01" value="1" />
      </label>
      <label class="field">
        <span class="label">Wobble <output data-out="wobble">1.00</output></span>
        <input type="range" name="wobble" min="0" max="2" step="0.01" value="1" />
      </label>
    </aside>
  `
  const scene = root.querySelector<HTMLElement>('.photo-scene')!
  const canvas = scene.querySelector('canvas')!
  const panel = root.querySelector<HTMLElement>('.controls')!
  const canvasSize: [number, number] = [PHOTO[0] + PAD[0] * 2, PHOTO[1] + PAD[1] * 2]
  Object.assign(canvas.style, { aspectRatio: `${canvasSize[0]} / ${canvasSize[1]}`, height: `min(${canvasSize[1]}px, 100cqh - 24px, (100cqw - 24px) * ${canvasSize[1] / canvasSize[0]})` })

  let target = 0
  let progress = 0
  let duration = DEFAULT_DURATION
  let glow = 1
  let wobble = 1
  let mode: 'toggle' | 'manual' = 'toggle'

  const toggle = panel.querySelector<HTMLButtonElement>('[data-toggle]')!
  const progressInput = panel.querySelector<HTMLInputElement>('[name=progress]')!
  const progressOut = panel.querySelector<HTMLOutputElement>('[data-out=progress]')!
  const modeButtons = panel.querySelectorAll<HTMLButtonElement>('[data-mode]')
  const syncToggle = () => (toggle.textContent = target >= 0.5 ? 'Hide photo' : 'Show photo')
  const setMode = (next: typeof mode) => {
    mode = next
    modeButtons.forEach((b) => b.classList.toggle('active', b.dataset.mode === next))
    toggle.disabled = next === 'manual'
    target = progress // hold where we are; the toggle picks up from here
    syncToggle()
  }
  modeButtons.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode as typeof mode)))
  toggle.addEventListener('click', () => {
    target = target >= 0.5 ? 0 : 1
    syncToggle()
  })
  // Dragging the slider takes over the animation.
  progressInput.addEventListener('input', () => {
    if (mode !== 'manual') setMode('manual')
    progress = target = progressInput.valueAsNumber
    progressOut.textContent = progress.toFixed(2)
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

  let disposed = false
  let gpu: Gpu | undefined
  let stopLoop: (() => void) | undefined

  ;(async () => {
    const g = await init()
    if (disposed) return g.dispose()
    gpu = g

    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.src = PHOTO_URL
    await img.decode()
    if (disposed) return
    const bitmap = await createImageBitmap(img)
    const size: [number, number] = [bitmap.width, bitmap.height]
    const photo = texture(g, {
      kind: '2d',
      size,
      format: 'rgba8unorm',
      usage: ['texture_binding', 'copy_dst', 'render_attachment'],
      label: 'photo',
    })
    g.gpu.queue.copyExternalImageToTexture({ source: bitmap }, { texture: photo.gpu }, size)

    const linear = sampler(g, { minFilter: 'linear', magFilter: 'linear' })
    const canvasSurface = surface(g, canvas, { dpr: [1, 2] })
    const fx = effect(g, revealShader, { set: { samp: linear, photo } })

    const time = clock(g)
    const handle = frameLoop(g, (frame) => {
      if (mode === 'toggle') {
        const step = time.deltaTime / duration
        progress = target > progress ? Math.min(target, progress + step) : Math.max(target, progress - step)
        progressInput.value = String(progress)
      }
      progressOut.textContent = progress.toFixed(2)

      fx.set({
        params: {
          canvasSize,
          half: [PHOTO[0] / 2, PHOTO[1] / 2],
          imageAspect: size[0] / size[1],
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
    scene.innerHTML = `<p class="placeholder">WebGPU unavailable: ${err.message ?? err}</p>`
  })

  return () => {
    disposed = true
    stopLoop?.()
    gpu?.dispose()
  }
}
