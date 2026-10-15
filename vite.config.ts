import { defineConfig } from 'vite'
import { wgslVitePlugin } from '@vgpu/wgsl/loader-vite'

export default defineConfig({
  plugins: [wgslVitePlugin()],
  // bench.html is the page scripts/lighthouse.mjs audits.
  build: { rolldownOptions: { input: { main: 'index.html', bench: 'bench.html' } } },
})
