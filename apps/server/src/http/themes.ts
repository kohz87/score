import { randomUUID } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  LookSettingsSchema,
  ThemeDetailSchema,
  ThemeIdSchema,
  ThemeImportResultSchema,
  ThemeListSchema,
  ThemeSaveSchema,
} from '@score/contract'
import { humanGuard } from '../auth/human.ts'
import type { ScoreDb } from '../db/index.ts'
import { HttpError } from '../errors.ts'
import type { Ingest } from '../hub/ingest.ts'
import { parseSingleFile } from '../media/multipart.ts'
import { isBuiltinThemeId } from '../themes/builtin.ts'
import { checkThemeCss, rewriteAssetUrls } from '../themes/css-check.ts'
import { readLook, readResetGeneration, writeLook } from '../themes/look.ts'
import {
  ASSET_TYPES,
  MAX_UPLOAD_BYTES,
  ThemeRejected,
  assetExtension,
  buildThemePackage,
  readThemePackage,
} from '../themes/package.ts'
import { ThemeStore } from '../themes/store.ts'
import { requestIdempotency } from './idempotency.ts'

const IdParams = z.object({ id: ThemeIdSchema })
const AssetParams = z.object({
  id: ThemeIdSchema,
  '*': z
    .string()
    .regex(/^(?:fonts|img)\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(?:woff2|png|jpg|jpeg|webp|avif)$/),
})
const ImportQuery = z.object({ replace: z.enum(['1']).optional() })

const notFound = () => new HttpError(404, 'not_found', 'Couldn’t find that theme.')
const rejected = (reasons: string[]) =>
  new HttpError(422, 'theme_rejected', 'That theme can’t be used: ' + reasons[0], { reasons })

// Themes (contract §16). Every route needs a paired browser; changes also carry the web-client header (csrf guard).
// Nothing here runs theme code: a package is data, and its CSS is checked and stored exactly as written or refused.
export function registerThemeRoutes(
  app: FastifyInstance,
  options: { db: ScoreDb; home: string; ingest?: Ingest; clock?: () => number },
): ThemeStore {
  const { db, ingest } = options
  const store = new ThemeStore(db, options.home, options.clock)
  // Finish or undo swaps and id moves that a stop left half done, then the 9.5 id move (gate findings #11, #12).
  store.recoverInterrupted()
  store.reclaimBuiltinIds()
  const guard = { preHandler: [humanGuard(app.pairing)] }
  const receipts = requestIdempotency(db, options.clock)
  const mutation = {
    preHandler: [humanGuard(app.pairing), receipts.preHandler],
    onSend: receipts.onSend,
  }
  // One change at a time: an import and a delete of the same id must not interleave their folder swaps.
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T> | T): Promise<T> => {
    const run = queue.then(work, work)
    queue = run.catch(() => undefined)
    return run
  }
  const detail = (id: string) => ThemeDetailSchema.parse(store.detail(id))

  app.get('/api/themes', guard, async () => {
    const { look, resetGeneration } = db.read((sqlite) => ({
      look: readLook(sqlite),
      resetGeneration: readResetGeneration(sqlite),
    }))
    return ThemeListSchema.parse({
      items: store.list(),
      active: look.activeTheme,
      mode: look.mode,
      resetGeneration,
    })
  })

  app.get('/api/themes/:id', guard, async (request) => {
    const { id } = IdParams.parse(request.params)
    if (!store.exists(id)) throw notFound()
    return detail(id)
  })

  app.get('/api/themes/:id/style.css', guard, async (request, reply) => {
    const { id } = IdParams.parse(request.params)
    const theme = store.get(id)
    if (!theme) throw notFound()
    return reply
      .header('Content-Type', 'text/css; charset=utf-8')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, no-cache')
      .send(rewriteAssetUrls(theme.css, id))
  })

  app.get('/api/themes/:id/assets/*', guard, async (request, reply) => {
    const parsed = AssetParams.safeParse(request.params)
    if (!parsed.success) throw notFound()
    const { id, '*': path } = parsed.data
    const file = join(store.assetRoot(id), ...path.split('/'))
    // A symlink or anything but a regular file is not served, whatever is on disk.
    let bytes: Buffer
    try {
      if (!lstatSync(file).isFile()) throw new Error('not a file')
      bytes = readFileSync(file)
    } catch {
      throw notFound()
    }
    return reply
      .header('Content-Type', ASSET_TYPES[assetExtension(path)]!)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', 'inline')
      .header('Cache-Control', 'private, no-cache')
      .send(bytes)
  })

  app.put('/api/themes/:id', { ...mutation, bodyLimit: 1024 * 1024 }, async (request) => {
    const { id } = IdParams.parse(request.params)
    const body = ThemeSaveSchema.parse(request.body)
    if (body.manifest.id !== id)
      throw new HttpError(400, 'bad_request', 'The theme’s id doesn’t match the address.')
    const checked = checkThemeCss(body.css)
    if (checked.reasons.length > 0) throw rejected(checked.reasons)
    return serial(() => {
      const current = store.get(id)
      if (isBuiltinThemeId(id) || (current && current.source !== 'custom'))
        throw new HttpError(
          409,
          'builtin_theme',
          'Built-in and imported themes can’t be changed. Save a copy under a new name.',
        )
      const currentEtag = store.detail(id)?.etag ?? null
      if (body.etag !== currentEtag)
        throw new HttpError(409, 'etag_mismatch', 'This theme changed elsewhere. Reload it first.')
      store.saveCustom(body.manifest, body.css)
      return detail(id)
    })
  })

  // The multipart parser lives in its own scope so no other route accepts that content type.
  void app.register(async (scope) => {
    const limit = MAX_UPLOAD_BYTES + 64 * 1024
    scope.addContentTypeParser(
      'multipart/form-data',
      { parseAs: 'buffer', bodyLimit: limit },
      (_request, body, done) => done(null, body),
    )
    scope.post(
      '/api/themes/import',
      {
        bodyLimit: limit,
        // Before the body is read, so an unpaired caller can't make the server buffer megabytes.
        onRequest: async (request) => {
          if (!app.pairing.isPaired(request.headers.cookie))
            throw new HttpError(
              401,
              'not_paired',
              'Pair this browser first. Open the pairing link shown in the server terminal.',
            )
        },
      },
      async (request, reply) => {
        if (!Buffer.isBuffer(request.body))
          throw new HttpError(400, 'bad_request', 'Couldn’t read that upload. Try again.')
        const { replace } = ImportQuery.parse(request.query)
        const file = parseSingleFile(request.body, request.headers['content-type'])
        const result = await serial(async () => {
          let pkg
          try {
            pkg = await readThemePackage(file.bytes)
          } catch (error) {
            if (error instanceof ThemeRejected) throw rejected(error.reasons)
            throw error
          }
          const existing = store.get(pkg.manifest.id)
          // A conditional replace (the Customizer's): checked here, inside the same serialised step as the swap, so
          // no other theme change can land between the check and the write.
          const ifMatch = request.headers['if-match']
          if (replace !== undefined && typeof ifMatch === 'string') {
            const current = existing ? (store.detail(pkg.manifest.id)?.etag ?? null) : null
            if (existing?.source !== 'builtin' && current !== ifMatch.trim().replace(/^"|"$/g, ''))
              throw new HttpError(
                409,
                'etag_mismatch',
                'This theme changed elsewhere. Reload it first.',
                { etag: current },
              )
          }
          if (existing && (replace === undefined || existing.source === 'builtin'))
            throw new HttpError(409, 'theme_exists', 'A theme with this id is already installed.')
          store.storeImported(pkg.manifest, pkg.css, pkg.assets, pkg.licenses)
          // Replacing a theme that is the shared look keeps it active: the row changed, not the choice.
          return ThemeImportResultSchema.parse({
            theme: store.summary(store.get(pkg.manifest.id)!),
            report: { dropped: [] },
          })
        })
        return reply.code(201).send(result)
      },
    )
  })

  app.get('/api/themes/:id/export', guard, async (request, reply) => {
    const { id } = IdParams.parse(request.params)
    const theme = store.get(id)
    if (!theme) throw notFound()
    const assets = new Map(
      store.assets(id).map((path) => [path, readFileSync(join(store.assetRoot(id), path))]),
    )
    const zip = await buildThemePackage(theme.manifest, theme.css, assets, theme.licenses)
    return reply
      .header('Content-Type', 'application/zip')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', `attachment; filename="${id}.zip"`)
      .header('Cache-Control', 'private, no-cache')
      .send(zip)
  })

  app.delete('/api/themes/:id', mutation, async (request, reply) => {
    const { id } = IdParams.parse(request.params)
    await serial(() => {
      if (isBuiltinThemeId(id))
        throw new HttpError(409, 'builtin_theme', 'Built-in themes can’t be deleted.')
      if (!store.exists(id)) throw notFound()
      if (db.read((sqlite) => readLook(sqlite)).activeTheme === id)
        throw new HttpError(
          409,
          'theme_active',
          'This theme is in use. Switch to another one first.',
        )
      store.remove(id)
    })
    return reply.code(204).send()
  })

  app.put('/api/look', mutation, async (request, reply) => {
    const look = LookSettingsSchema.parse(request.body)
    await serial(async () => {
      if (!store.exists(look.activeTheme)) throw notFound()
      // The setting and the event commit together, so a device that missed the event sees the change on reload.
      if (ingest)
        await ingest.submit({
          source: 'look',
          identity: randomUUID(),
          apply: ({ sqlite }) => {
            writeLook(sqlite, look)
            return [
              {
                type: 'look.changed',
                data: { ...look, resetGeneration: readResetGeneration(sqlite) },
              },
            ]
          },
        })
      else db.tx((sqlite) => writeLook(sqlite, look))
    })
    return reply.code(204).send()
  })

  return store
}
