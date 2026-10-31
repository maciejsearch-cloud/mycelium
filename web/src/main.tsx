import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { I18nProvider } from './i18n'
import { nodeMode } from './myc/node'
import { applyTheme } from './myc/theme'

applyTheme()

// ?embed=1 – widżet osadzony na innej stronie (iframe): tylko okienko „Zostań węzłem”
const EMBED = new URLSearchParams(location.search).has('embed')
const NodePage = lazy(() => import('./pages/Node'))
nodeMode.init(`${import.meta.env.BASE_URL}sw.js`, !EMBED)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      {EMBED ? (
        <Suspense fallback={null}>
          <NodePage embed />
        </Suspense>
      ) : (
        <App />
      )}
    </I18nProvider>
  </StrictMode>,
)
