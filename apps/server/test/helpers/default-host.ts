import { vi } from 'vitest'

// Local mode answers only loopback Host names on its own ports (SCORE-030), but Fastify's inject() defaults the Host
// header to `localhost:80`. Apps built in tests get the default server authority instead; tests that care about the
// Host (remote mode, the guard itself) set the header explicitly, which always wins over this default.
const AUTHORITY = '127.0.0.1:8740'

vi.mock('fastify', async (importOriginal) => {
  const real = await importOriginal<typeof import('fastify')>()
  const create = ((...args: Parameters<typeof real.default>) => {
    const app = real.default(...args)
    const inject = app.inject.bind(app) as (options?: unknown, callback?: unknown) => unknown
    ;(app as { inject: unknown }).inject = (options?: unknown, callback?: unknown) => {
      if (options === undefined) return inject()
      const given = typeof options === 'string' ? { url: options } : (options as object)
      return inject({ authority: AUTHORITY, ...given }, callback)
    }
    return app
  }) as typeof real.default
  Object.assign(create, real.default)
  return { ...real, default: create, fastify: create }
})
