// What a page needs to lay out an effect tile before (or without) loading vgpu.
import PHOTO_URL from '../examples/photo-reveal/photo.webp'

export type FxKind = 'smoke' | 'button' | 'reveal'

export type FxMeta = {
  kind: FxKind
  title: string
  /** Canvas width / height. */
  aspect: number
  /** Progress an idle tile rests at (what a visitor sees before/after the interaction). */
  rest: number
  /** Image shown under the canvas until its first frame (LCP candidate and no-WebGPU fallback). */
  poster?: string
  /** Where the photo sits inside the canvas (CSS inset), so the poster lines up with the first frame. */
  posterInset?: string
}

export const PHOTO = PHOTO_URL
export const SMOKE_PAD = 0.3
export const BUTTON_CANVAS: [number, number] = [820, 344]
export const REVEAL_CANVAS: [number, number] = [630, 740]

export const FX_META: Record<FxKind, FxMeta> = {
  smoke: { kind: 'smoke', title: 'Hover — smoke', aspect: 1.5, rest: 0, poster: PHOTO_URL, posterInset: `${(SMOKE_PAD / (1 + 2 * SMOKE_PAD)) * 100}%` },
  button: { kind: 'button', title: 'Button — liquid hover', aspect: BUTTON_CANVAS[0] / BUTTON_CANVAS[1], rest: 1 },
  reveal: {
    kind: 'reveal',
    title: 'Photo — glow reveal',
    aspect: REVEAL_CANVAS[0] / REVEAL_CANVAS[1],
    rest: 1,
    poster: PHOTO_URL,
    posterInset: `${(120 / REVEAL_CANVAS[1]) * 100}% ${(115 / REVEAL_CANVAS[0]) * 100}%`,
  },
}
