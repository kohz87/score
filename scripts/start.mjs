// `pnpm start`: serve the built web app and the API from one loopback port (default 8740).
// Runs the TypeScript server in-process through tsx (already the dev runner), so the launcher's PID is the server's.
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = new URL('../', import.meta.url)
if (!existsSync(fileURLToPath(new URL('apps/web/dist/index.html', root)))) {
  process.stderr.write('Score is not built yet. Run `pnpm build` first, then `pnpm start`.\n')
  process.exit(1)
}
process.env.SCORE_SERVE_WEB = '1'
const require = createRequire(new URL('apps/server/package.json', root))
const { register } = await import(pathToFileURL(require.resolve('tsx/esm/api')).href)
register()
await import(new URL('apps/server/src/index.ts', root).href)
