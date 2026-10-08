import { readFileSync, readdirSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { FastifyInstance } from 'fastify'

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

export function loadWebAssets(directory: string): Map<string, { body: Buffer; type: string }> {
  const assets = new Map<string, { body: Buffer; type: string }>()
  function read(relative: string): void {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) read(path)
      else if (entry.isFile()) {
        const type = contentTypes[extname(path)]
        if (type) assets.set(`/${path}`, { body: readFileSync(join(directory, path)), type })
      }
    }
  }
  try {
    read('')
  } catch (error) {
    throw new Error('Remote mode requires a readable built web app; run pnpm build', {
      cause: error,
    })
  }
  if (!assets.has('/index.html'))
    throw new Error('Remote mode requires the built web app; run pnpm build')
  return assets
}

export type WebAssets = ReturnType<typeof loadWebAssets>

export function registerWebAssets(
  app: FastifyInstance,
  assets: WebAssets,
  transport?: 'http' | 'tls',
): void {
  const source = assets.get('/index.html')!
  // Presentation metadata keeps the public session endpoint boolean-only.
  const index = transport
    ? {
        ...source,
        body: Buffer.from(
          source.body
            .toString('utf8')
            .replace(/<html\b/i, `<html data-score-transport="${transport}"`),
        ),
      }
    : source
  for (const [path, asset] of assets)
    app.get(path, async (_request, reply) => {
      const result = path === '/index.html' ? index : asset
      return reply.type(result.type).send(result.body)
    })
  for (const path of ['/', '/pair'])
    app.get(path, async (_request, reply) => reply.type(index.type).send(index.body))
  app.get('/*', async (request, reply) => {
    const path = request.url.split('?', 1)[0]!
    if (path.startsWith('/api/') || path.startsWith('/bridge/') || extname(path))
      return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } })
    return reply.type(index.type).send(index.body)
  })
}
