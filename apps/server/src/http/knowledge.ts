import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  KnowledgeHistorySchema,
  KnowledgeInfoSchema,
  KnowledgeMoveRequestSchema,
  KnowledgeMoveResponseSchema,
  KnowledgeNoteSchema,
  KnowledgeRestoreRequestSchema,
  KnowledgeSearchResponseSchema,
  KnowledgeTreeSchema,
  KnowledgeVersionSchema,
  KnowledgeWriteRequestSchema,
  KnowledgeWriteResponseSchema,
} from '@score/contract'
import { humanGuard } from '../auth/human.ts'
import { HttpError } from '../errors.ts'
import { MAX_NOTE_BYTES } from '../knowledge/note.ts'
import type { KnowledgeVault } from '../knowledge/vault.ts'

const WildcardSchema = z.object({ '*': z.string().min(1).max(4096) })
const SearchQuerySchema = z.object({
  q: z.string().max(500).default(''),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})
const SettingsSchema = z.object({ agentAccess: z.boolean() })
const COMMIT = /^[0-9a-f]{7,64}$/

// Knowledge (contract §12). Reads are open to any caller the server already trusts; every change needs a paired
// browser (**H**). Agents write through the bridge (6.4) via KnowledgeVault.writeNote, never through these routes.
export function registerKnowledgeRoutes(app: FastifyInstance, vault: KnowledgeVault): void {
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
  app.get('/api/knowledge/notes/*', async (request) => {
    const target = rest(request)
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
    return KnowledgeMoveResponseSchema.parse(await vault.moveNote(from, to, updateLinks))
  })

  app.put('/api/knowledge/settings', guard, async (request) => {
    const { agentAccess } = SettingsSchema.parse(request.body)
    return KnowledgeInfoSchema.parse(vault.setAgentAccess(agentAccess))
  })
}
