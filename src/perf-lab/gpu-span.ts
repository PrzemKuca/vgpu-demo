// GPU time of a whole frame: a timestamp before the first pass and after the
// last one, written by two empty marker passes submitted around the frame.
//
// Summing per-pass timer spans over-counts on tile-based GPUs (Apple), where
// passes of one frame overlap: each span then includes its neighbours' work.
// The begin→end span of the frame is the wall-clock time the GPU spent on it.
const RING = 8
// WebGPU usage flags (the globals aren't in this project's DOM typings).
const MAP_READ = 0x1
const COPY_SRC = 0x4
const COPY_DST = 0x8
const QUERY_RESOLVE = 0x200
const RENDER_ATTACHMENT = 0x10

export function createFrameSpan(device: GPUDevice, onResult: (ms: number) => void) {
  const querySet = device.createQuerySet({ type: 'timestamp', count: 2 })
  const resolve = device.createBuffer({ size: 16, usage: QUERY_RESOLVE | COPY_SRC })
  const free = Array.from({ length: RING }, () => device.createBuffer({ size: 16, usage: MAP_READ | COPY_DST }))
  const view = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: RENDER_ATTACHMENT }).createView()
  const marker = (encoder: GPUCommandEncoder, timestampWrites: GPURenderPassTimestampWrites) =>
    encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'discard' }], timestampWrites }).end()
  let open = false

  return {
    /** Returns false when every readback buffer is still in flight; skip timing this frame. */
    begin() {
      if (!free.length) return false
      const encoder = device.createCommandEncoder()
      marker(encoder, { querySet, beginningOfPassWriteIndex: 0 })
      device.queue.submit([encoder.finish()])
      open = true
      return true
    },
    end() {
      if (!open) return
      open = false
      const readback = free.pop()!
      const encoder = device.createCommandEncoder()
      marker(encoder, { querySet, endOfPassWriteIndex: 1 })
      encoder.resolveQuerySet(querySet, 0, 2, resolve, 0)
      encoder.copyBufferToBuffer(resolve, 0, readback, 0, 16)
      device.queue.submit([encoder.finish()])
      readback.mapAsync(MAP_READ).then(
        () => {
          const [t0, t1] = new BigInt64Array(readback.getMappedRange())
          readback.unmap()
          free.push(readback)
          if (t1 > t0) onResult(Number(t1 - t0) / 1e6)
        },
        () => {}, // device destroyed
      )
    },
  }
}
