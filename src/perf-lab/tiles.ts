// Static tile markup: a poster image and an empty canvas. Rendered before vgpu
// loads (or without it), then picked up by mountField.
import { FX_META, type FxKind } from './meta'

export function renderTiles(container: HTMLElement, fx: FxKind, count: number) {
  const def = FX_META[fx]
  container.replaceChildren()
  for (let i = 0; i < count; i++) {
    const el = document.createElement('figure')
    el.className = 'fx-tile'
    el.style.aspectRatio = String(def.aspect)
    if (def.poster) {
      const img = document.createElement('img')
      img.src = def.poster
      img.alt = ''
      img.decoding = 'async'
      img.style.inset = def.posterInset ?? '0'
      if (i > 3) img.loading = 'lazy'
      el.append(img)
    }
    el.append(document.createElement('canvas'))
    container.append(el)
  }
}
