import fs from 'node:fs/promises'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  KnowledgeDocumentSchema,
  KnowledgeExportRequestSchema,
  KnowledgeExportSummarySchema,
  KnowledgeFolderRequestSchema,
  KnowledgeFromMediaRequestSchema,
  KnowledgeHistorySchema,
  KnowledgeInfoSchema,
  KnowledgeMoveRequestSchema,
  KnowledgeMoveResponseSchema,
  KnowledgeNoteSchema,
  KnowledgeRestoreRequestSchema,
  KnowledgeSearchResponseSchema,
  KnowledgeTreeSchema,
  KnowledgeUnzipResultSchema,
  KnowledgeUploadConflictSchema,
  KnowledgeUploadResultSchema,
  KnowledgeZipPreviewSchema,
  KnowledgeVersionSchema,
  KnowledgeWriteRequestSchema,
  KnowledgeWriteResponseSchema,
} from '@score/contract'
import { humanGuard } from '../auth/human.ts'
import { HttpError } from '../errors.ts'
import { MAX_FILE_BYTES, isDocumentPath } from '../knowledge/doc-types.ts'
import {
  EXPORT_TIMEOUT_MS,
  exportCandidates,
  exportFileName,
  exportStream,
  exportSummary,
  planExport,
} from '../knowledge/export.ts'
import { MAX_NOTE_BYTES, parseNotePath } from '../knowledge/note.ts'
import { sniffImage } from '../media/sniff.ts'
import type { MediaStore } from '../media/store.ts'
import type { KnowledgeVault } from '../knowledge/vault.ts'

const WildcardSchema = z.object({ '*': z.string().min(1).max(4096) })
const SearchQuerySchema = z.object({
  q: z.string().max(500).default(''),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})
const SettingsSchema = z.object({ agentAccess: z.boolean() })
const UploadQuerySchema = z.object({
  onConflict: KnowledgeUploadConflictSchema.default('ask'),
  mode: z.enum(['keep', 'unzip', 'preview']).default('keep'),
  folder: z.string().max(1024).optional(),
})
const DownloadQuerySchema = z.object({ download: z.enum(['1']).optional() })
const COMMIT = /^[0-9a-f]{7,64}$/

// Knowledge (contract §12). Reads are open to any caller the server already trusts; every change needs a paired
// browser (**H**). Agents write through the bridge (6.4) via KnowledgeVault.writeNote, never through these routes.
export function registerKnowledgeRoutes(
  app: FastifyInstance,
  vault: KnowledgeVault,
  media?: MediaStore,
): void {
  const guard = { preHandler: [humanGuard(app.pairing)] }
  // A note may be 2 MiB; the JSON envelope and escaping need headroom over Fastify's 1 MiB default.
  const write = { ...guard, bodyLimit: MAX_NOTE_BYTES * 2 + 64 * 1024 }
  const rest = (request: { params: unknown }) => WildcardSchema.parse(request.params)['*']

  app.get('/api/knowledge', async () => KnowledgeInfoSchema.parse(vault.info()))
  app.get('/api/knowledge/tree', async () => KnowledgeTreeSchema.parse(await vault.tree()))
  app.get('/api/knowledge/search', async (request) => {
    const { q, limit } = SearchQuerySchema.parse(request.query)
    return KnowledgeSearchResponseSchema.parse({ items: vault.search(q, limit) })
  })

  // `*` swallows `/history`, `/versions/<commit>` and `/restore`: note paths end in `.md`, so the suffixes are
  // unambiguous.
  app.get('/api/knowledge/notes/*', async (request, reply) => {
    const target = rest(request)
    if (DownloadQuerySchema.parse(request.query).download !== undefined) {
      // The note exactly as stored (frontmatter included), read without following a symlink.
      const rel = parseNotePath(target)
      const abs = path.join(vault.vault, ...rel.split('/'))
      const stat = await fs.lstat(abs).catch(() => null)
      if (!stat?.isFile()) throw new HttpError(404, 'not_found', 'Unknown note')
      const bytes = await vault.readContainedBuffer(abs)
      return reply
        .header('Content-Type', 'text/markdown; charset=utf-8')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'no-store')
        .header(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(rel.split('/').pop()!)}`,
        )
        .send(bytes)
    }
    const history = /^(.+)\/history$/.exec(target)
    if (history) return KnowledgeHistorySchema.parse({ items: await vault.history(history[1]!) })
    const version = /^(.+)\/versions\/([^/]+)$/.exec(target)
    if (version) {
      if (!COMMIT.test(version[2]!)) throw new HttpError(400, 'bad_request', 'Invalid commit')
      return KnowledgeVersionSchema.parse(await vault.version(version[1]!, version[2]!))
    }
    return KnowledgeNoteSchema.parse(await vault.readNote(target))
  })

  app.put('/api/knowledge/notes/*', write, async (request) => {
    // The schema's own length cap would answer 400; the contract says 413 for an oversized note.
    const raw = request.body as { body?: unknown } | null
    if (typeof raw?.body === 'string' && raw.body.length > MAX_NOTE_BYTES)
      throw new HttpError(413, 'payload_too_large', 'That note is too large')
    const body = KnowledgeWriteRequestSchema.parse(request.body)
    return KnowledgeWriteResponseSchema.parse(await vault.writeNote(rest(request), body))
  })

  app.post('/api/knowledge/notes/*', guard, async (request) => {
    const restore = /^(.+)\/restore$/.exec(rest(request))
    if (!restore) throw new HttpError(404, 'not_found', 'Route not found')
    const { commit } = KnowledgeRestoreRequestSchema.parse(request.body)
    return KnowledgeWriteResponseSchema.parse(await vault.restoreNote(restore[1]!, commit))
  })

  app.delete('/api/knowledge/notes/*', guard, async (request, reply) => {
    await vault.deleteNote(rest(request))
    return reply.code(204).send()
  })

  app.post('/api/knowledge/move', guard, async (request) => {
    const { from, to, updateLinks } = KnowledgeMoveRequestSchema.parse(request.body)
    // Documents (PLAN 6.6) move by the same route; they have no links to rewrite.
    if (isDocumentPath(from))
      return KnowledgeMoveResponseSchema.parse(await vault.docs.move(from, to))
    return KnowledgeMoveResponseSchema.parse(await vault.moveNote(from, to, updateLinks))
  })

  // ---- documents and folders (PLAN 6.6) ----------------------------------------------------------------------

  app.get('/api/knowledge/documents/*', async (request) =>
    KnowledgeDocumentSchema.parse(await vault.docs.get(rest(request))),
  )

  app.delete('/api/knowledge/documents/*', guard, async (request, reply) => {
    await vault.docs.delete(rest(request))
    return reply.code(204).send()
  })

  // The bytes are served by kind and never reinterpreted: images inline, everything else (PDF and Word included) as a
  // download, always under a sandbox CSP, so an uploaded HTML or PDF can't run on Score's origin.
  app.get('/api/knowledge/files/*', async (request, reply) => {
    const { download } = DownloadQuerySchema.parse(request.query)
    const file = await vault.docs.bytes(rest(request))
    void reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'no-store')
    const inline = file.type === 'image' && download === undefined
    const type = inline
      ? (sniffImage(file.bytes) ?? 'application/octet-stream')
      : 'application/octet-stream'
    return reply
      .header('Content-Type', type)
      .header(
        'Content-Disposition',
        inline ? 'inline' : `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      )
      .send(file.bytes)
  })

  // ---- export (PLAN 6.7) -------------------------------------------------------------------------------------

  const planFrom = async (body: unknown) =>
    planExport(
      vault.vault,
      exportCandidates(await vault.tree()),
      KnowledgeExportRequestSchema.parse(body),
    )
  app.post('/api/knowledge/export/summary', guard, async (request) =>
    KnowledgeExportSummarySchema.parse(exportSummary(await planFrom(request.body))),
  )
  app.post('/api/knowledge/export', guard, async (request, reply) => {
    const plan = await planFrom(request.body)
    const now = new Date()
    const stream = exportStream(vault.vault, plan, now)
    const timer = setTimeout(() => stream.destroy(new Error('Export timed out')), EXPORT_TIMEOUT_MS)
    stream.once('close', () => clearTimeout(timer))
    // A closed connection stops the read; no orphaned file handles.
    reply.raw.once('close', () => stream.destroy())
    return reply
      .header('Content-Type', 'application/zip')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'no-store')
      .header('Content-Disposition', `attachment; filename="${exportFileName(plan, now)}"`)
      .send(stream)
  })

  app.post('/api/knowledge/folders', guard, async (request, reply) => {
    const { path } = KnowledgeFolderRequestSchema.parse(request.body)
    return reply.code(201).send(await vault.createFolder(path))
  })
  app.delete('/api/knowledge/folders/*', guard, async (request, reply) => {
    await vault.deleteFolder(rest(request))
    return reply.code(204).send()
  })

  if (media)
    app.post('/api/knowledge/files-from-media', guard, async (request, reply) => {
      const body = KnowledgeFromMediaRequestSchema.parse(request.body)
      const stored = media.read(body.mediaId)
      if (!stored) throw new HttpError(404, 'not_found', 'That attachment is no longer stored')
      const result = await vault.docs.upload(body.path, stored.bytes, body.onConflict)
      return reply.code(201).send(KnowledgeUploadResultSchema.parse(result))
    })

  // The raw-body parser lives in its own scope so no other route accepts that content type.
  void app.register(async (scope) => {
    const limit = MAX_FILE_BYTES + 1024
    scope.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: limit },
      (_request, body, done) => done(null, body),
    )
    scope.put(
      '/api/knowledge/files/*',
      {
        bodyLimit: limit,
        // Before the body is read, so an unpaired caller can't make the server buffer megabytes.
        onRequest: async (request) => {
          if (!app.pairing.isPaired(request.headers.cookie))
            throw new HttpError(401, 'not_paired', 'Pair this browser to make human decisions')
        },
      },
      async (request, reply) => {
        if (!Buffer.isBuffer(request.body))
          throw new HttpError(400, 'bad_request', 'The file is missing')
        const target = rest(request)
        const query = UploadQuerySchema.parse(request.query)
        const name = target.split('/').pop()!
        if (/\.zip$/i.test(name)) {
          if (query.mode === 'preview')
            return KnowledgeZipPreviewSchema.parse(await vault.docs.zipPreview(request.body))
          if (query.mode === 'unzip') {
            const folder =
              query.folder ??
              [...target.split('/').slice(0, -1), name.replace(/\.zip$/i, '')].join('/')
            return reply
              .code(201)
              .send(
                KnowledgeUnzipResultSchema.parse(
                  await vault.docs.unzip(request.body, name, folder, query.onConflict),
                ),
              )
          }
        }
        const result = await vault.docs.upload(target, request.body, query.onConflict)
        return reply.code(201).send(KnowledgeUploadResultSchema.parse(result))
      },
    )
  })

  app.put('/api/knowledge/settings', guard, async (request) => {
    const { agentAccess } = SettingsSchema.parse(request.body)
    return KnowledgeInfoSchema.parse(vault.setAgentAccess(agentAccess))
  })
}
