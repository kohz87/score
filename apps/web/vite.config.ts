/// <reference types="vitest/config" />
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Tests and the e2e server read times as UTC whatever zone the machine is set to (the VM moved to GMT+8 on 2026-10-28,
// and times rendered in the local zone broke tests written against UTC). Workers and the web server inherit it.
process.env.TZ = 'UTC'

const serverPort = process.env.SCORE_PORT ?? '8740'
// Point the dev proxy at a TLS Score (https://127.0.0.1:8741) to use the web terminal, which needs HTTPS end to end.
const apiTarget = process.env.SCORE_API_TARGET ?? `http://127.0.0.1:${serverPort}`

/** Gives public/sw.js a build id (a hash of the built index.html, which names every hashed asset), so a new build is a new worker. */
function serviceWorkerBuildId(): Plugin {
  let outDir = ''
  return {
    name: 'score-sw-build-id',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      const id = createHash('sha256')
        .update(readFileSync(join(outDir, 'index.html')))
        .digest('hex')
        .slice(0, 16)
      const path = join(outDir, 'sw.js')
      writeFileSync(path, readFileSync(path, 'utf8').replace('__BUILD_ID__', id))
    },
  }
}

export default defineConfig({
  plugins: [react(), serviceWorkerBuildId()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.SCORE_WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      // ws: the terminal's WebSocket upgrade. The Host header is kept (no changeOrigin) so the server's Host and Origin
      // checks see the address the browser used; a development certificate is self-signed.
      '/api': { target: apiTarget, ws: true, secure: false },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: [
      './src/test/tmp-root.ts',
      './src/test/load-tolerance.ts',
      './src/test/xhr-via-fetch.ts',
    ],
    testTimeout: 20_000,
  },
})
