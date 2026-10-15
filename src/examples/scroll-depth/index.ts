import { clock, draw, effect, frameLoop, init, sampler, surface, target, texture } from 'vgpu'
import type { Gpu } from 'vgpu'
import { composeMatrix, multiplyMatrices } from 'vgpu/scene'
import layerShader from './layer.wgsl'
import postShader from './post.wgsl'

type Vec3 = [number, number, number]

// Corridor content: photos, the heart art and headlines at increasing depth.
type LayerSpec =
  | { kind: 'photo'; url: string; position: Vec3; width: number }
  | { kind: 'image'; url: string; position: Vec3; width: number }
  | { kind: 'text'; text: string; sub?: string; position: Vec3; width: number }

const LAYERS: LayerSpec[] = [
  { kind: 'text', text: 'Scroll into depth', sub: 'Every layer has its own distance', position: [0, 0.3, -1], width: 7 },
  { kind: 'photo', url: 'https://picsum.photos/id/1018/900/600', position: [-2.6, 0.6, -5], width: 3.2 },
  { kind: 'image', url: '/shape-4.png', position: [3.1, 1.3, -3.5], width: 1.5 },
  { kind: 'photo', url: 'https://picsum.photos/id/1036/900/600', position: [2.8, -0.7, -8], width: 3 },
  { kind: 'image', url: '/heart.png', position: [0.4, 0.2, -11], width: 2.6 },
  { kind: 'text', text: 'Parallax', sub: 'Near moves fast, far moves slow', position: [-0.4, 1.2, -14], width: 6 },
  { kind: 'photo', url: 'https://picsum.photos/id/1043/900/600', position: [-3, -0.8, -17], width: 3.4 },
  { kind: 'image', url: '/shape-5.png', position: [0.6, -1.2, -15.5], width: 1.9 },
  { kind: 'photo', url: 'https://picsum.photos/id/1050/900/600', position: [2.6, 1, -20], width: 3 },
  { kind: 'photo', url: 'https://picsum.photos/id/1067/900/600', position: [-1.8, 1.4, -24], width: 2.8 },
  { kind: 'image', url: '/heart.png', position: [2.9, -1, -26], width: 1.8 },
  { kind: 'image', url: '/shape-8.png', position: [-3.2, -0.4, -22], width: 2.2 },
  { kind: 'image', url: '/shape-4.png', position: [-1.2, -1.5, -31], width: 1.4 },
  { kind: 'image', url: '/shape-5.png', position: [2.4, 1.3, -32.5], width: 1.6 },
  { kind: 'photo', url: 'https://picsum.photos/id/1080/900/600', position: [0.8, -0.6, -29], width: 3.6 },
  { kind: 'text', text: 'Built with vgpu', sub: 'WebGPU · WGSL · one frame loop', position: [0, 0.2, -34], width: 6.5 },
]

const CAMERA_START = 5
const CAMERA_END = -30
const FOCUS = 5.5 // in-focus distance in front of the camera
const FOV = (50 * Math.PI) / 180

type Effects = { dof: boolean; fog: boolean; zoomBlur: boolean; chroma: boolean; glitch: boolean; halftone: boolean }
const PRESETS: Record<string, Effects> = {
  Clean: { dof: false, fog: false, zoomBlur: false, chroma: false, glitch: false, halftone: false },
  Cinematic: { dof: true, fog: true, zoomBlur: false, chroma: true, glitch: false, halftone: false },
  Speed: { dof: false, fog: false, zoomBlur: true, chroma: true, glitch: false, halftone: false },
  Glitch: { dof: false, fog: true, zoomBlur: false, chroma: true, glitch: true, halftone: false },
  Print: { dof: true, fog: false, zoomBlur: false, chroma: false, glitch: false, halftone: true },
}
const EFFECT_LABELS: Record<keyof Effects, string> = {
  dof: 'Depth of field',
  fog: 'Fog',
  zoomBlur: 'Zoom blur (scroll speed)',
  chroma: 'Chromatic aberration',
  glitch: 'Glitch (scroll speed)',
  halftone: 'Halftone print',
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1)
  return t * t * (3 - 2 * t)
}

function viewProjection(eye: Vec3, look: Vec3, aspect: number) {
  const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  const norm = (a: Vec3): Vec3 => {
    const l = Math.hypot(...a)
    return [a[0] / l, a[1] / l, a[2] / l]
  }
  const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const back = norm(sub(eye, look))
  const right = norm(cross([0, 1, 0], back))
  const up = cross(back, right)
  const view = new Float32Array([
    right[0], up[0], back[0], 0,
    right[1], up[1], back[1], 0,
    right[2], up[2], back[2], 0,
    -dot(right, eye), -dot(up, eye), -dot(back, eye), 1,
  ])
  const near = 0.1
  const far = 100
  const f = 1 / Math.tan(FOV / 2)
  const proj = new Float32Array(16)
  proj[0] = f / aspect
  proj[5] = f
  proj[10] = far / (near - far)
  proj[11] = -1
  proj[14] = (near * far) / (near - far)
  return multiplyMatrices(proj, view, new Float32Array(16))
}

// Draws each layer's content into a 2D canvas, ready to upload.
async function rasterize(spec: LayerSpec): Promise<{ canvas: OffscreenCanvas; aspect: number }> {
  if (spec.kind === 'text') {
    const canvas = new OffscreenCanvas(2048, 640)
    const ctx = canvas.getContext('2d')!
    ctx.textAlign = 'center'
    ctx.fillStyle = '#ffffff'
    ctx.font = '700 230px system-ui, -apple-system, sans-serif'
    ctx.fillText(spec.text, 1024, 330)
    if (spec.sub) {
      ctx.fillStyle = '#FF46CD'
      ctx.font = '500 72px system-ui, -apple-system, sans-serif'
      ctx.fillText(spec.sub, 1024, 480)
    }
    return { canvas, aspect: 2048 / 640 }
  }
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.src = spec.url
  await img.decode()
  const canvas = new OffscreenCanvas(img.naturalWidth, img.naturalHeight)
  canvas.getContext('2d')!.drawImage(img, 0, 0)
  return { canvas, aspect: img.naturalWidth / img.naturalHeight }
}

export function mountScrollDepth(root: HTMLElement) {
  root.innerHTML = `
    <div class="depth-scene">
      <canvas></canvas>
      <div class="depth-scroller"><div class="depth-track"></div></div>
      <p class="scene-hint depth-hint">Scroll ↓</p>
    </div>
    <aside class="controls">
      <h2>Controls</h2>
      <div class="field">
        <span class="label">Variant</span>
        <div class="chips">${Object.keys(PRESETS).map((p) => `<button class="chip" data-preset="${p}">${p}</button>`).join('')}</div>
      </div>
      ${(Object.keys(EFFECT_LABELS) as (keyof Effects)[])
        .map((k) => `<label class="field check"><input type="checkbox" name="${k}" /><span>${EFFECT_LABELS[k]}</span></label>`)
        .join('')}
      <label class="field">
        <span class="label">Effect strength <output data-out="strength">1.00</output></span>
        <input type="range" name="strength" min="0" max="2" step="0.01" value="1" />
      </label>
      <label class="field check"><input type="checkbox" name="mouse" checked /><span>Mouse parallax</span></label>
    </aside>
  `
  const scene = root.querySelector<HTMLElement>('.depth-scene')!
  const canvas = scene.querySelector('canvas')!
  const scroller = scene.querySelector<HTMLElement>('.depth-scroller')!
  const hint = scene.querySelector<HTMLElement>('.depth-hint')!
  const panel = root.querySelector<HTMLElement>('.controls')!

  const effects: Effects = { ...PRESETS.Cinematic }
  let strength = 1
  let mouseParallax = true
  const checkbox = (k: keyof Effects) => panel.querySelector<HTMLInputElement>(`input[name=${k}]`)!
  const applyPreset = (name: string) => {
    Object.assign(effects, PRESETS[name])
    for (const k of Object.keys(effects) as (keyof Effects)[]) checkbox(k).checked = effects[k]
    panel.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) => b.classList.toggle('active', b.dataset.preset === name))
  }
  panel.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) => b.addEventListener('click', () => applyPreset(b.dataset.preset!)))
  for (const k of Object.keys(EFFECT_LABELS) as (keyof Effects)[]) {
    checkbox(k).addEventListener('change', () => {
      effects[k] = checkbox(k).checked
      panel.querySelectorAll('[data-preset]').forEach((b) => b.classList.remove('active'))
    })
  }
  panel.querySelector<HTMLInputElement>('[name=strength]')!.addEventListener('input', (e) => {
    strength = (e.target as HTMLInputElement).valueAsNumber
    panel.querySelector('[data-out=strength]')!.textContent = strength.toFixed(2)
  })
  panel.querySelector<HTMLInputElement>('[name=mouse]')!.addEventListener('change', (e) => {
    mouseParallax = (e.target as HTMLInputElement).checked
  })
  applyPreset('Cinematic')

  // Scroll progress and smoothed velocity; pointer position for parallax.
  let progress = 0
  let velocity = 0
  const pointer = { x: 0, y: 0, sx: 0, sy: 0 }
  const readScroll = () => {
    const max = scroller.scrollHeight - scroller.clientHeight
    return max > 0 ? scroller.scrollTop / max : 0
  }
  scene.addEventListener('pointermove', (e) => {
    const r = scene.getBoundingClientRect()
    pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1
    pointer.y = ((e.clientY - r.top) / r.height) * 2 - 1
  })

  let disposed = false
  let gpu: Gpu | undefined
  let stopLoop: (() => void) | undefined

  ;(async () => {
    const g = await init()
    if (disposed) return g.dispose()
    gpu = g

    const linear = sampler(g, { minFilter: 'linear', magFilter: 'linear' })
    const rasters = await Promise.all(LAYERS.map(rasterize))
    if (disposed) return

    const layers = LAYERS.map((spec, i) => {
      const { canvas: source, aspect } = rasters[i]
      const size: [number, number] = [source.width, source.height]
      const tex = texture(g, {
        kind: '2d',
        size,
        format: 'rgba8unorm',
        usage: ['texture_binding', 'copy_dst', 'render_attachment'],
      })
      g.gpu.queue.copyExternalImageToTexture({ source }, { texture: tex.gpu, premultipliedAlpha: true }, size)
      const layerDraw = draw(g, {
        shader: layerShader,
        vertices: 6,
        blend: 'premultiplied',
        set: { art: tex, samp: linear },
      })
      return { spec, aspect, draw: layerDraw, matrix: new Float32Array(16) }
    })

    const canvasSurface = surface(g, canvas, { dpr: [1, 2] })
    const sceneTarget = target(g, { size: [canvasSurface.size[0], canvasSurface.size[1]] })
    const post = effect(g, postShader, { set: { scene: sceneTarget, samp: linear } })
    let aspect = 1
    canvasSurface.onResize(({ width, height }) => {
      aspect = width / height
      sceneTarget.resize([width, height])
    })

    const time = clock(g)
    let lastProgress = readScroll()
    const handle = frameLoop(g, (frame) => {
      const dt = Math.max(time.deltaTime, 1e-3)
      const raw = readScroll()
      velocity += ((raw - lastProgress) / dt - velocity) * Math.min(dt * 8, 1)
      lastProgress = raw
      progress += (raw - progress) * Math.min(dt * 6, 1) // eased camera follow
      hint.style.opacity = String(1 - smoothstep(0, 0.04, progress))

      const k = Math.min(dt * 4, 1)
      pointer.sx += ((mouseParallax ? pointer.x : 0) - pointer.sx) * k
      pointer.sy += ((mouseParallax ? pointer.y : 0) - pointer.sy) * k

      const camZ = CAMERA_START + (CAMERA_END - CAMERA_START) * progress
      const eye: Vec3 = [pointer.sx * 0.6, -pointer.sy * 0.4, camZ]
      const look: Vec3 = [pointer.sx * 0.15, -pointer.sy * 0.1, camZ - 10]
      const camera = { viewProjection: viewProjection(eye, look, aspect) }

      // Far layers first: transparent cards blend back to front.
      const ordered = layers
        .map((l) => ({ l, dist: camZ - l.spec.position[2] }))
        .filter(({ dist }) => dist > 0.2 && dist < 42)
        .sort((a, b) => b.dist - a.dist)

      for (const { l, dist } of ordered) {
        const height = l.spec.width / l.aspect
        // Graphics float gently, each on its own phase; photos and text stay put.
        const phase = l.spec.position[2] * 1.7
        const float = l.spec.kind === 'image'
        composeMatrix(
          {
            position: float
              ? [l.spec.position[0], l.spec.position[1] + Math.sin(time.time * 0.9 + phase) * 0.12, l.spec.position[2]]
              : l.spec.position,
            rotation: float ? [0, Math.sin(time.time * 0.6 + phase) * 0.25, Math.sin(time.time * 0.7 + phase) * 0.06] : [0, 0, 0],
            scale: [l.spec.width, height, 1],
          },
          l.matrix,
        )
        const coc = effects.dof ? Math.min(Math.abs(dist - FOCUS) * 0.0035 * strength, 0.045) : 0
        l.draw.set({
          camera,
          layer: {
            model: l.matrix,
            opacity: smoothstep(0.2, 2.2, dist) * (1 - smoothstep(32, 42, dist)),
            coc,
            fog: effects.fog ? smoothstep(4, 26, dist) * 0.9 * Math.min(strength, 1.2) : 0,
            aspect: l.aspect,
            corner: l.spec.kind === 'photo' ? 0.03 : 0,
          },
        })
      }

      post.set({
        params: {
          time: time.time,
          velocity,
          aspect,
          strength,
          zoomBlur: Number(effects.zoomBlur),
          chroma: Number(effects.chroma),
          glitch: Number(effects.glitch),
          halftone: Number(effects.halftone),
        },
      })
      frame.pass({ target: sceneTarget, clear: [0, 0, 0, 0] }, (pass) => {
        for (const { l } of ordered) pass.draw(l.draw)
      })
      frame.pass(canvasSurface, post)
    })
    stopLoop = () => handle.stop()
  })().catch((err) => {
    console.error(err)
    scene.innerHTML = `<p class="placeholder">Could not start: ${err.message ?? err}</p>`
  })

  return () => {
    disposed = true
    stopLoop?.()
    gpu?.dispose()
  }
}
