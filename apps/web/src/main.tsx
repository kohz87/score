import '@fontsource/bricolage-grotesque/500.css'
import '@fontsource/bricolage-grotesque/600.css'
import '@fontsource/bricolage-grotesque/700.css'
import '@fontsource/hanken-grotesk/400.css'
import '@fontsource/hanken-grotesk/500.css'
import '@fontsource/hanken-grotesk/600.css'
import '@fontsource/hanken-grotesk/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import './styles/tokens.css'
import './styles/packs/paper.css'
import './styles/packs/night.css'
import './styles/packs/dense.css'
import './styles/select.css'
import './styles/protected.css'
import './themes/variants.css'
import './shell/shell.css'

import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter } from 'react-router'
import { App, appRoutes } from './App.tsx'
import { createQueryClient, StreamContext } from './data/query-client.ts'
import { createStreamClient } from './data/stream.ts'
import { createStreamQueryRegistry } from './data/resync.ts'
import { clearBrowserSession } from './data/session.ts'
import { applyTheme, readTheme } from './data/theme.ts'
import { LookRuntime } from './themes/LookRuntime.tsx'
import { registerServiceWorker } from './pwa/service-worker.ts'

applyTheme(readTheme())
registerServiceWorker()

const queryClient = createQueryClient()
const stream = createStreamClient()
const streamContext = { client: stream, queries: createStreamQueryRegistry(queryClient, stream) }
const handleLogout = () => {
  clearBrowserSession(queryClient, streamContext)
  window.location.assign('/pair')
}
window.addEventListener('score:logout', handleLogout)
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    window.removeEventListener('score:logout', handleLogout)
    streamContext.queries.dispose()
    stream.close()
  })
const router = createBrowserRouter(appRoutes)

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <StreamContext value={streamContext}>
        <App router={router} />
        <LookRuntime router={router} />
      </StreamContext>
    </QueryClientProvider>
  </StrictMode>,
)
