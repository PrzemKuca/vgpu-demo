// The demo shaders wrapped as repeatable tiles: one shared resource set per
// device, one effect (= one uniform block) per tile.
import { effect, sampler, texture } from 'vgpu'
import type { Effect, Gpu, Texture } from 'vgpu'
import smokeShader from '../examples/smoke-hover/smoke.wgsl'
import buttonShader from '../examples/button-hover/button.wgsl'
import revealShader from '../examples/photo-reveal/reveal.wgsl'
import { BUTTON_CANVAS, FX_META, PHOTO as PHOTO_URL, REVEAL_CANVAS, SMOKE_PAD, type FxKind, type FxMeta } from './meta'

export type { FxKind } from './meta'

export type FxDef = FxMeta & {
  load(g: Gpu): Promise<unknown>
  create(g: Gpu, res: unknown): (progress: number, time: number) => Effect
}

let photo: Promise<ImageBitmap> | undefined
const loadPhoto = () =>
  (photo ??= (async () => {
    const img = new Image()
    img.src = PHOTO_URL
    await img.decode()
    return createImageBitmap(img)
  })())

function upload(g: Gpu, source: ImageBitmap | OffscreenCanvas, label: string) {
  const size: [number, number] = [source.width, source.height]
  const tex = texture(g, { kind: '2d', size, format: 'rgba8unorm', usage: ['texture_binding', 'copy_dst', 'render_attachment'], label })
  g.gpu.queue.copyExternalImageToTexture({ source }, { texture: tex.gpu, premultipliedAlpha: true }, size)
  return tex
}

const linear = (g: Gpu) => sampler(g, { minFilter: 'linear', magFilter: 'linear' })

// Smoke: photo A → hue-shifted photo B, both cover-cropped to 3:2.
const SMOKE_TEX: [number, number] = [900, 600]
const smoke: FxDef = {
  ...FX_META.smoke,
  async load(g) {
    const bitmap = await loadPhoto()
    const crop = (filter: string) => {
      const [w, h] = SMOKE_TEX
      const c = new OffscreenCanvas(w, h)
      const ctx = c.getContext('2d')!
      ctx.filter = filter
      const s = Math.max(w / bitmap.width, h / bitmap.height)
      ctx.drawImage(bitmap, (w - bitmap.width * s) / 2, (h - bitmap.height * s) / 2, bitmap.width * s, bitmap.height * s)
      return c
    }
    return { a: upload(g, crop('none'), 'smoke-a'), b: upload(g, crop('hue-rotate(150deg) saturate(1.4)'), 'smoke-b'), samp: linear(g) }
  },
  create(g, res) {
    const { a, b, samp } = res as { a: Texture; b: Texture; samp: ReturnType<typeof sampler> }
    const fx = effect(g, smokeShader, { set: { params: { time: 0, progress: 0, aspect: 1.5, pad: SMOKE_PAD }, imageA: a, imageB: b, samp } })
    return (progress, time) => {
      fx.set({ params: { time, progress: progress * progress * (3 - 2 * progress) } })
      return fx
    }
  },
}

// Button: the liquid tooltip button at its demo proportions.
const BUTTON_HALF: [number, number] = [190, 42]
const button: FxDef = {
  ...FX_META.button,
  async load(g) {
    const scale = 1.5
    const c = new OffscreenCanvas(BUTTON_CANVAS[0] * scale, BUTTON_CANVAS[1] * scale)
    const ctx = c.getContext('2d')!
    ctx.scale(scale, scale)
    const [cx, cy] = [BUTTON_CANVAS[0] / 2, BUTTON_CANVAS[1] / 2]
    ctx.fillStyle = '#000'
    ctx.textBaseline = 'middle'
    ctx.font = '400 30px system-ui, -apple-system, "Helvetica Neue", sans-serif'
    ctx.fillText('VISIT WEBSITE', cx - BUTTON_HALF[0] + 30, cy + 1)
    return { label: upload(g, c, 'button-label'), samp: linear(g) }
  },
  create(g, res) {
    const { label, samp } = res as { label: Texture; samp: ReturnType<typeof sampler> }
    const fx = effect(g, buttonShader, {
      set: { label, samp, params: { canvasSize: BUTTON_CANVAS, half: BUTTON_HALF, radius: 10, progress: 0, time: 0, glow: 1, wobble: 1 } },
    })
    return (progress, time) => {
      fx.set({ params: { progress, time } })
      return fx
    }
  },
}

// Reveal: the photo rising behind the glowing front.
const reveal: FxDef = {
  ...FX_META.reveal,
  async load(g) {
    const bitmap = await loadPhoto()
    return { photo: upload(g, bitmap, 'photo'), aspect: bitmap.width / bitmap.height, samp: linear(g) }
  },
  create(g, res) {
    const { photo, aspect, samp } = res as { photo: Texture; aspect: number; samp: ReturnType<typeof sampler> }
    const fx = effect(g, revealShader, {
      set: { photo, samp, params: { canvasSize: REVEAL_CANVAS, half: [200, 250], imageAspect: aspect, progress: 0, time: 0, glow: 1, wobble: 1 } },
    })
    return (progress, time) => {
      fx.set({ params: { progress, time } })
      return fx
    }
  },
}

export const FX: Record<FxKind, FxDef> = { smoke, button, reveal }
