import { mountSmokeHover } from './smoke-hover'
import { mountHeartDrop } from './heart-drop'
import { mountVideoLed } from './video-led'
import { mountScrollDepth } from './scroll-depth'

// Each example mounts into `root` and returns an optional cleanup function.
export type Example = {
  id: string
  title: string
  mount: (root: HTMLElement) => void | (() => void)
}

export const examples: Example[] = [
  { id: 'smoke-hover', title: '1. Hover — smoke', mount: mountSmokeHover },
  { id: 'heart-drop', title: '2. 3D graphic — gravity', mount: mountHeartDrop },
  { id: 'video-led', title: '3. Video — backlight', mount: mountVideoLed },
  { id: 'scroll-depth', title: '4. Scroll — depth parallax', mount: mountScrollDepth },
]
