import { clock, compute, draw, frameLoop, geometry, init, sampler, storage, surface, texture } from 'vgpu'
import type { Gpu } from 'vgpu'
import { composeMatrix, multiplyMatrices } from 'vgpu/scene'
import heartShader from './heart.wgsl'
import floorShader from './floor.wgsl'
import burstSimShader from './burst-sim.wgsl'
import burstShader from './burst.wgsl'
import { inflate } from './mesh'
import { Body, World, type BodySettings, type Vec3 } from './physics'

const ART_URL = '/heart.png'
const ART_SIZE = 1024
const EYE: Vec3 = [0, 4.2, 7.5]
const LOOK_AT: Vec3 = [0, 0.9, 0]
const FOV = (38 * Math.PI) / 180
const DEPTH_LIMIT = 1.6 // invisible walls in front of and behind the pillows
const MAX_PILLOWS = 16 // matches MAX_PILLOWS in floor.wgsl
const PARTICLES = 4096 // ring buffer of small hearts
const BURST = 300 // hearts per click
const PARTICLE_BYTES = 48 // three vec4f, see burst-sim.wgsl

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(...a)
  return [a[0] / l, a[1] / l, a[2] / l]
}

// Camera basis: right, up, back (the camera looks down -back).
const back = norm(sub(EYE, LOOK_AT))
const right = norm(cross([0, 1, 0], back))
const up = cross(back, right)

function viewProjection(aspect: number) {
  const view = new Float32Array([
    right[0], up[0], back[0], 0,
    right[1], up[1], back[1], 0,
    right[2], up[2], back[2], 0,
    -dot(right, EYE), -dot(up, EYE), -dot(back, EYE), 1,
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

async function loadArt(gpu: Gpu) {
  const img = new Image()
  img.src = ART_URL
  await img.decode()
  const canvas = new OffscreenCanvas(ART_SIZE, ART_SIZE)
  canvas.getContext('2d')!.drawImage(img, 0, 0, ART_SIZE, ART_SIZE)
  const tex = texture(gpu, {
    kind: '2d',
    size: [ART_SIZE, ART_SIZE],
    format: 'rgba8unorm',
    usage: ['texture_binding', 'copy_dst', 'render_attachment'],
    label: 'heart-art',
  })
  gpu.gpu.queue.copyExternalImageToTexture({ source: canvas }, { texture: tex.gpu, premultipliedAlpha: true }, [ART_SIZE, ART_SIZE])
  return { tex, image: img }
}

export function mountHeartDrop(root: HTMLElement) {
  root.innerHTML = `
    <div class="heart-scene">
      <canvas></canvas>
      <p class="scene-hint">Drag a pillow to throw it · click for hearts</p>
    </div>
    <aside class="controls">
      <h2>Controls</h2>
      <div class="field">
        <span class="label">Pillows <output data-out="count">1</output></span>
        <div class="button-row">
          <button class="button" data-action="add">+ Add</button>
          <button class="button" data-action="remove">− Remove</button>
        </div>
      </div>
      <button class="button" data-action="drop">Drop again</button>
      <label class="field check"><input type="checkbox" name="bursts" checked /><span>Heart burst on click</span></label>
      <label class="field">
        <span class="label">Gravity <output data-out="gravity"></output></span>
        <input type="range" name="gravity" min="1" max="30" step="0.5" value="14" />
      </label>
      <label class="field">
        <span class="label">Bounciness <output data-out="bounce"></output></span>
        <input type="range" name="bounce" min="0" max="0.9" step="0.01" value="0.45" />
      </label>
      <label class="field">
        <span class="label">Friction <output data-out="friction"></output></span>
        <input type="range" name="friction" min="0" max="1.5" step="0.01" value="0.6" />
      </label>
      <label class="field">
        <span class="label">Softness <output data-out="softness"></output></span>
        <input type="range" name="softness" min="0" max="1" step="0.01" value="0.6" />
      </label>
      <label class="field">
        <span class="label">Thickness <output data-out="thickness"></output></span>
        <input type="range" name="thickness" min="0.2" max="2" step="0.01" value="1" />
      </label>
    </aside>
  `
  const scene = root.querySelector<HTMLDivElement>('.heart-scene')!
  const canvas = scene.querySelector('canvas')!
  const panel = root.querySelector<HTMLElement>('.controls')!

  const settings: BodySettings = { gravity: 14, bounce: 0.45, friction: 0.6, thickness: 1, softness: 0.6 }
  let burstsOn = true
  panel.querySelector<HTMLInputElement>('[name=bursts]')!.addEventListener('change', (e) => {
    burstsOn = (e.target as HTMLInputElement).checked
  })
  for (const input of panel.querySelectorAll<HTMLInputElement>('input[type=range]')) {
    const key = input.name as keyof BodySettings
    const out = panel.querySelector<HTMLOutputElement>(`[data-out=${key}]`)!
    const sync = () => {
      settings[key] = input.valueAsNumber
      out.textContent = input.valueAsNumber.toFixed(2)
    }
    input.addEventListener('input', sync)
    sync()
  }

  let disposed = false
  let gpu: Gpu | undefined
  let stopLoop: (() => void) | undefined
  let removeListeners: (() => void) | undefined

  ;(async () => {
    const g = await init()
    if (disposed) return g.dispose()
    gpu = g

    const { tex, image } = await loadArt(g)
    if (disposed) return
    const mesh = inflate(image)

    const canvasSurface = surface(g, canvas, { dpr: [1, 2], depth: true, msaa: true })
    const heartGeometry = geometry(g, {
      buffers: [{ data: mesh.vertices, attributes: { position: 'float32x3', normal: 'float32x3', uv: 'float32x2' } }],
      indices: mesh.indices,
    })
    const artSampler = sampler(g, { minFilter: 'linear', magFilter: 'linear' })
    const F = 30
    const floor = draw(g, {
      shader: floorShader,
      geometry: geometry(g, {
        buffers: [{ data: new Float32Array([-F, 0, -F, F, 0, -F, -F, 0, F, F, 0, F]), attributes: { position: 'float32x3' } }],
        indices: [0, 2, 1, 1, 2, 3],
      }),
    })

    // Heart burst: simulated and drawn entirely on the GPU.
    const particles = storage(g, PARTICLES * PARTICLE_BYTES)
    const burstSim = compute(g, burstSimShader, { set: { particles } })
    const burstDraw = draw(g, {
      shader: burstShader,
      vertices: 6,
      instances: PARTICLES,
      blend: 'premultiplied',
      depth: { write: false },
      set: { particles, art: tex, samp: artSampler },
    })
    let spawnStart = 0
    let pendingSpawns: { origin: Vec3; count: number }[] = []
    const burst = (origin: Vec3) => {
      if (burstsOn) pendingSpawns.push({ origin, count: BURST })
    }

    // Each pillow: a physics body plus its own draw (sharing geometry and pipeline).
    type Pillow = { body: Body; draw: ReturnType<typeof draw>; matrix: Float32Array }
    const world = new World(mesh)
    const pillows: Pillow[] = []
    let camera = { viewProjection: viewProjection(1), eye: EYE }
    let halfWidth = 3

    const spawnPoint = (i: number): Vec3 => [
      (Math.random() - 0.5) * Math.max(halfWidth - 1, 0.5) * 1.4,
      3.4 + i * 0.6,
      (Math.random() - 0.5) * 1.2,
    ]
    const addPillow = () => {
      if (pillows.length >= MAX_PILLOWS) return
      const body = new Body(spawnPoint(0))
      const pillowDraw = draw(g, {
        shader: heartShader,
        geometry: heartGeometry,
        set: { art: tex, samp: artSampler, camera },
      })
      pillows.push({ body, draw: pillowDraw, matrix: new Float32Array(16) })
      world.bodies.push(body)
      syncCount()
    }
    const removePillow = () => {
      const pillow = pillows.pop()
      if (!pillow) return
      if (dragged === pillow.body) dragged = null
      world.bodies.splice(world.bodies.indexOf(pillow.body), 1)
      pillow.draw.dispose()
      syncCount()
    }
    const dropAll = () =>
      pillows.forEach(({ body }, i) => {
        body.position = spawnPoint(i)
        body.velocity = [0, 0, 0]
      })
    const countOut = panel.querySelector<HTMLOutputElement>('[data-out=count]')!
    const addButton = panel.querySelector<HTMLButtonElement>('[data-action=add]')!
    const removeButton = panel.querySelector<HTMLButtonElement>('[data-action=remove]')!
    const syncCount = () => {
      countOut.textContent = String(pillows.length)
      addButton.disabled = pillows.length >= MAX_PILLOWS
      removeButton.disabled = pillows.length === 0
    }

    // Walls follow the visible width at the pillows' depth.
    let aspect = 1
    canvasSurface.onResize(({ width, height }) => {
      aspect = width / height
      camera = { viewProjection: viewProjection(aspect), eye: EYE }
      for (const pillow of pillows) pillow.draw.set({ camera })
      floor.set({ camera })
      burstDraw.set({ camera: { viewProjection: camera.viewProjection, right, up } })
      halfWidth = Math.tan(FOV / 2) * aspect * Math.hypot(...sub(EYE, LOOK_AT)) - 0.4
      world.planes = [
        { normal: [0, 1, 0], offset: 0 },
        { normal: [1, 0, 0], offset: -halfWidth },
        { normal: [-1, 0, 0], offset: -halfWidth },
        { normal: [0, 0, 1], offset: -DEPTH_LIMIT },
        { normal: [0, 0, -1], offset: -DEPTH_LIMIT },
      ]
    })

    // Pointer ray through the camera; dragging moves on the plane facing the camera.
    const ray = (e: PointerEvent): Vec3 => {
      const rect = canvas.getBoundingClientRect()
      const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1
      const ny = 1 - ((e.clientY - rect.top) / rect.height) * 2
      const t = Math.tan(FOV / 2)
      return norm([
        -back[0] + right[0] * nx * t * aspect + up[0] * ny * t,
        -back[1] + right[1] * nx * t * aspect + up[1] * ny * t,
        -back[2] + right[2] * nx * t * aspect + up[2] * ny * t,
      ])
    }
    const onDragPlane = (dir: Vec3, depthZ: number): Vec3 => {
      const t = (depthZ - EYE[2]) / dir[2]
      return [EYE[0] + dir[0] * t, Math.max(EYE[1] + dir[1] * t, 0.3), depthZ]
    }
    let grabOffset: Vec3 = [0, 0, 0]
    let dragged: Body | null = null
    // Nearest pillow whose centre passes close to the pointer ray.
    const pick = (dir: Vec3) => {
      let best: Body | null = null
      let bestAlong = Infinity
      for (const { body } of pillows) {
        const along = dot(sub(body.position, EYE), dir)
        const closest: Vec3 = [EYE[0] + dir[0] * along, EYE[1] + dir[1] * along, EYE[2] + dir[2] * along]
        if (Math.hypot(...sub(closest, body.position)) < mesh.size * 0.45 && along < bestAlong) {
          best = body
          bestAlong = along
        }
      }
      return best
    }

    // A short press without movement is a click: it fires a burst.
    let press = { x: 0, y: 0, t: 0 }
    canvas.addEventListener('pointerdown', (e) => {
      press = { x: e.clientX, y: e.clientY, t: performance.now() }
    })
    canvas.addEventListener('pointerup', (e) => {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 5 || performance.now() - press.t > 350) return
      const dir = ray(e)
      const hit = pick(dir)
      burst(hit ? [...hit.position] as Vec3 : onDragPlane(dir, 0))
    })

    canvas.addEventListener('pointerdown', (e) => {
      const dir = ray(e)
      dragged = pick(dir)
      if (!dragged) return
      canvas.setPointerCapture(e.pointerId)
      grabOffset = sub(dragged.position, onDragPlane(dir, dragged.position[2]))
      dragged.dragTarget = dragged.position
      scene.classList.add('dragging')
    })
    canvas.addEventListener('pointermove', (e) => {
      const dir = ray(e)
      if (dragged?.dragTarget) {
        const p = onDragPlane(dir, dragged.dragTarget[2])
        dragged.dragTarget = [p[0] + grabOffset[0], Math.max(p[1] + grabOffset[1], 0.9), p[2]]
      } else {
        scene.classList.toggle('grabbable', !!pick(dir))
      }
    })
    const drop = () => {
      if (!dragged) return
      dragged.release()
      dragged = null
      scene.classList.remove('dragging')
    }
    // Release wherever the pointer ends up, even over the controls panel.
    window.addEventListener('pointerup', drop)
    window.addEventListener('pointercancel', drop)
    canvas.addEventListener('lostpointercapture', drop)
    removeListeners = () => {
      window.removeEventListener('pointerup', drop)
      window.removeEventListener('pointercancel', drop)
    }
    panel.querySelector('[data-action=drop]')!.addEventListener('click', dropAll)
    addButton.addEventListener('click', addPillow)
    removeButton.addEventListener('click', removePillow)
    addPillow()

    const time = clock(g)
    const shadowCenters = Array.from({ length: MAX_PILLOWS }, () => [0, 0, 0, 0])
    const handle = frameLoop(g, (frame) => {
      world.step(time.deltaTime, settings)
      pillows.forEach(({ body, draw: pillowDraw, matrix }, i) => {
        composeMatrix(
          { position: body.position, quaternion: body.orientation, scale: [1, 1, settings.thickness] },
          matrix,
        )
        pillowDraw.set({
          model: {
            model: matrix,
            thickness: settings.thickness,
            squash: body.squash,
            anchorY: body.lowestY,
            center: body.position,
          },
        })
        shadowCenters[i] = [...body.position, 0]
      })
      floor.set({ shadows: { count: pillows.length, radius: mesh.size * 0.45, centers: shadowCenters } })
      // One burst per frame through the sim's spawn window; extra clicks wait a frame.
      const spawn = pendingSpawns.shift()
      burstSim.set({
        sim: {
          origin: spawn?.origin ?? [0, 0, 0],
          dt: Math.min(time.deltaTime, 1 / 30),
          gravity: settings.gravity * 0.6,
          time: time.time,
          spawnStart,
          spawnCount: spawn?.count ?? 0,
          capacity: PARTICLES,
        },
      })
      if (spawn) spawnStart = (spawnStart + spawn.count) % PARTICLES
      frame.computePass((pass) => pass.dispatch(burstSim, Math.ceil(PARTICLES / 64)))

      frame.pass({ target: canvasSurface, clear: [0, 0, 0, 1] }, (pass) => {
        pass.draw(floor)
        for (const pillow of pillows) pass.draw(pillow.draw)
        pass.draw(burstDraw)
      })
    })
    stopLoop = () => handle.stop()
  })().catch((err) => {
    console.error(err)
    scene.innerHTML = `<p class="placeholder">WebGPU unavailable: ${err.message ?? err}</p>`
  })

  return () => {
    disposed = true
    removeListeners?.()
    stopLoop?.()
    gpu?.dispose()
  }
}
