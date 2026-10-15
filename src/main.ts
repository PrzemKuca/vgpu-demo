import './style.css'
import { examples } from './examples'
import { mountPerfOverlay } from './perf'

const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
  <nav class="sidebar">
    <h1>vgpu</h1>
    <ul>${examples.map((e) => `<li><a href="#${e.id}" data-id="${e.id}">${e.title}</a></li>`).join('')}</ul>
    <footer class="sidebar-links">
      <a href="https://vgpu.sh/docs" target="_blank" rel="noopener">vgpu docs ↗</a>
      <a href="https://github.com/vercel-labs/vgpu" target="_blank" rel="noopener">GitHub ↗</a>
    </footer>
  </nav>
  <main class="stage"></main>
`

const stage = app.querySelector<HTMLElement>('.stage')!
let cleanup: void | (() => void)

function route() {
  const id = location.hash.slice(1)
  const example = examples.find((e) => e.id === id) ?? examples[0]
  cleanup?.()
  stage.replaceChildren()
  cleanup = example.mount(stage)
  app.querySelectorAll<HTMLAnchorElement>('a[data-id]').forEach((a) => a.classList.toggle('active', a.dataset.id === example.id))
}

mountPerfOverlay(document.body)

window.addEventListener('hashchange', route)
route()
