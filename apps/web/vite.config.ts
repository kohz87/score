/// <reference types="vitest/config" />
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const serverPort = process.env.SCORE_PORT ?? '8740'

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
    proxy: { '/api': `http://127.0.0.1:${serverPort}` },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/tmp-root.ts'],
  },
})
