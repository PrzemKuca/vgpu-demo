import { effect, frameLoop, init, sampler, surface, target, texture } from 'vgpu'
import type { Gpu } from 'vgpu'
import downsampleShader from './downsample.wgsl'
import smoothShader from './smooth.wgsl'
import compositeShader from './composite.wgsl'

const VIDEO_URL = '/ignite-phone.mp4'
const ZONES: [number, number] = [48, 27] // ambient light resolution (matches downsample.wgsl)

type Settings = {
  ambientOn: number
  ambientStrength: number
  ambientSpread: number
  response: number
  screenWidth: number
}

export function mountVideoLed(root: HTMLElement) {
  root.innerHTML = `
    <div class="video-scene"><canvas></canvas></div>
    <aside class="controls">
      <h2>Controls</h2>
      <button class="button" data-action="play">Pause</button>
      <label class="field check"><input type="checkbox" name="ambientOn" checked /><span>Ambient backlight</span></label>
      <label class="field">
        <span class="label">Backlight strength <output data-out="ambientStrength"></output></span>
        <input type="range" name="ambientStrength" min="0" max="3" step="0.01" value="1" />
      </label>
      <label class="field">
        <span class="label">Backlight spread <output data-out="ambientSpread"></output></span>
        <input type="range" name="ambientSpread" min="0.03" max="0.6" step="0.01" value="0.22" />
      </label>
      <label class="field">
        <span class="label">Backlight response <output data-out="response"></output></span>
        <input type="range" name="response" min="0.02" max="1" step="0.01" value="0.12" />
      </label>
      <label class="field">
        <span class="label">Screen size <output data-out="screenWidth"></output></span>
        <input type="range" name="screenWidth" min="0.3" max="0.95" step="0.01" value="0.6" />
      </label>
    </aside>
  `
  const canvas = root.querySelector<HTMLCanvasElement>('.video-scene canvas')!
  const panel = root.querySelector<HTMLElement>('.controls')!

  const settings: Settings = {
    ambientOn: 1,
    ambientStrength: 1,
    ambientSpread: 0.22,
    response: 0.12,
    screenWidth: 0.6,
  }
  for (const input of panel.querySelectorAll<HTMLInputElement>('input')) {
    const key = input.name as keyof Settings
    const out = panel.querySelector<HTMLOutputElement>(`[data-out=${key}]`)
    const sync = () => {
      settings[key] = input.type === 'checkbox' ? Number(input.checked) : input.valueAsNumber
      if (out) out.textContent = input.step === '1' ? String(input.valueAsNumber) : input.valueAsNumber.toFixed(2)
    }
    input.addEventListener('input', sync)
    sync()
  }

  const video = document.createElement('video')
  video.src = VIDEO_URL
  video.muted = true
  video.loop = true
  video.playsInline = true
  video.className = 'video-source' // in the DOM so the browser keeps decoding it
  root.querySelector('.video-scene')!.append(video)
  const playButton = panel.querySelector<HTMLButtonElement>('[data-action=play]')!
  playButton.addEventListener('click', () => (video.paused ? video.play() : video.pause()))
  video.addEventListener('play', () => (playButton.textContent = 'Pause'))
  video.addEventListener('pause', () => (playButton.textContent = 'Play'))

  let disposed = false
  let gpu: Gpu | undefined
  let stopLoop: (() => void) | undefined

  ;(async () => {
    const g = await init()
    if (disposed) return g.dispose()
    gpu = g

    // Don't depend on autoplay succeeding: a paused first frame still renders.
    video.play().catch(() => {})
    if (video.readyState < 2) await new Promise((r) => video.addEventListener('loadeddata', r, { once: true }))
    if (disposed) return
    const size: [number, number] = [video.videoWidth, video.videoHeight]

    const frameTexture = texture(g, {
      kind: '2d',
      size,
      format: 'rgba8unorm',
      usage: ['texture_binding', 'copy_dst', 'render_attachment'],
      label: 'video-frame',
    })
    // Everything in Settings except `response`, which belongs to the smoothing pass.
    const compositeParams = (aspect: number) => {
      const { response: _, ...rest } = settings
      const videoAspect = size[0] / size[1]
      // Screen size is a fraction of the canvas width, capped so it fits vertically.
      const screenWidth = Math.min(settings.screenWidth * aspect, 0.8 * videoAspect)
      return { ...rest, screenWidth, aspect, videoAspect }
    }
    const linear = sampler(g, { minFilter: 'linear', magFilter: 'linear' })
    const zones = target(g, { size: ZONES })
    // Two history targets, swapped every frame, hold the smoothed ambient light.
    const history = [target(g, { size: ZONES }), target(g, { size: ZONES })]

    const downsample = effect(g, downsampleShader, { set: { video: frameTexture, samp: linear } })
    const smooth = effect(g, smoothShader, { set: { current: zones, samp: linear, params: { response: 1 } } })
    const composite = effect(g, compositeShader, {
      set: { video: frameTexture, samp: linear, params: compositeParams(1) },
    })

    const canvasSurface = surface(g, canvas, { dpr: [1, 2] })
    let aspect = 1
    canvasSurface.onResize(({ width, height }) => (aspect = width / height))

    let flip = 0
    const handle = frameLoop(g, (frame) => {
      if (video.readyState >= 2) {
        g.gpu.queue.copyExternalImageToTexture({ source: video }, { texture: frameTexture.gpu }, size)
      }
      const prev = history[flip]
      const next = history[1 - flip]
      flip = 1 - flip

      frame.pass(zones, downsample)
      smooth.set({ history: prev, params: { response: settings.response } })
      frame.pass(next, smooth)
      composite.set({ ambient: next, params: compositeParams(aspect) })
      frame.pass(canvasSurface, composite)
    })
    stopLoop = () => handle.stop()
  })().catch((err) => {
    console.error(err)
    root.querySelector('.video-scene')!.innerHTML = `<p class="placeholder">Could not start: ${err.message ?? err}</p>`
  })

  return () => {
    disposed = true
    video.pause()
    video.removeAttribute('src')
    stopLoop?.()
    gpu?.dispose()
  }
}
