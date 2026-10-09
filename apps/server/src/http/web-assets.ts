import { readFileSync, readdirSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { FastifyInstance, FastifyReply } from 'fastify'

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
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
    throw new Error('Serving the web app requires a readable built web app; run pnpm build', {
      cause: error,
    })
  }
  if (!assets.has('/index.html'))
    throw new Error('Serving the web app requires the built web app; run pnpm build')
  return assets
}

export type WebAssets = ReturnType<typeof loadWebAssets>

// The built app has no inline scripts; React style attributes need inline styles. Images include /api/media.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ')

function withSecurityHeaders(reply: FastifyReply): FastifyReply {
  return reply
    .header('content-security-policy', CONTENT_SECURITY_POLICY)
    .header('x-content-type-options', 'nosniff')
    .header('x-frame-options', 'DENY')
    .header('referrer-policy', 'no-referrer')
}

export function registerWebAssets(
  app: FastifyInstance,
  assets: WebAssets,
  transport?: 'tls',
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
      const response = withSecurityHeaders(reply)
      // The worker controls the whole app, so it must be allowed to take the root scope.
      if (path === '/sw.js') response.header('service-worker-allowed', '/')
      return response.type(result.type).send(result.body)
    })
  for (const path of ['/', '/pair'])
    app.get(path, async (_request, reply) =>
      withSecurityHeaders(reply).type(index.type).send(index.body),
    )
  app.get('/*', async (request, reply) => {
    const path = request.url.split('?', 1)[0]!
    // Notes are deep-linked as /knowledge/<path>.md: those are app routes, not files.
    if (
      path.startsWith('/api/') ||
      path.startsWith('/bridge/') ||
      (extname(path) && !path.startsWith('/knowledge/'))
    )
      return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } })
    return withSecurityHeaders(reply).type(index.type).send(index.body)
  })
}
