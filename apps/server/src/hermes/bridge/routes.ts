import {
  BridgeEventsRequestSchema,
  BridgeEventsResponseSchema,
  BridgeHelloRequestSchema,
  BridgeHelloResponseSchema,
} from '@score/contract'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ApprovalOutbox } from '../../domain/approval-outbox.ts'
import { registerBridgeDecisionRoutes } from './decisions.ts'
import type { CompatibilityEvaluation } from '../port.ts'
import type { ScoreDb } from '../../db/index.ts'
import { HttpError } from '../../errors.ts'
import type { Ingest } from '../../hub/ingest.ts'
import { redact } from '../../redact.ts'
import { hashBridgeToken } from './bootstrap.ts'
import { acknowledge, ProducerSchema, retainedBridgePosition } from './registry.ts'
import { translateBridgeEvent, type BridgeMetrics } from './translate.ts'

export interface BridgeDeps {
  db: ScoreDb
  ingest: Pick<Ingest, 'submit' | 'clearHolds'>
  bootstrapHash: Buffer
  getCompatibility: () => CompatibilityEvaluation
  clock?: () => number
  metrics?: BridgeMetrics
  outbox?: ApprovalOutbox
}

export const SHIPPED_PLUGIN_VERSION = '0.1.0'

const BearerSchema = z.string().regex(/^Bearer [A-Za-z0-9_-]{43}$/i)
const BatchSchema = BridgeEventsRequestSchema.refine(
  ({ events }) =>
    events.length <= 200 &&
    events.every((event, index) => index === 0 || event.counter > events[index - 1]!.counter),
)
const unauthorized = () => new HttpError(401, 'unauthorized', 'Invalid bridge token')

function bearerHash(value: unknown): Buffer {
  const parsed = BearerSchema.safeParse(value)
  if (!parsed.success) throw unauthorized()
  return hashBridgeToken(parsed.data.slice(7))
}

export function registerBridgeRoutes(app: FastifyInstance, deps: BridgeDeps): void {
  const {
    db,
    ingest,
    bootstrapHash,
    getCompatibility,
    clock = Date.now,
    metrics = { unknownHooks: 0 },
  } = deps

  // Recover a crash between observation commit and the response's contiguous acknowledgement.
  db.sqlite
    .prepare(
      `UPDATE ingest_checkpoints SET cursor = (
    SELECT CAST(acked_through AS TEXT) FROM producers WHERE 'bridge:' || incarnation = ingest_checkpoints.source
  ) WHERE scope = 'events' AND source IN (SELECT 'bridge:' || incarnation FROM producers)`,
    )
    .run()

  // Browser mutations have their own credentials. A bridge bearer never authorizes an API call.
  app.addHook('onRequest', async (request) => {
    const path = request.routeOptions.url ?? request.url.split('?', 1)[0] ?? ''
    if (!path.startsWith('/api/') || request.headers.authorization === undefined) return
    const parsed = BearerSchema.safeParse(request.headers.authorization)
    if (!parsed.success) return
    // Reject the bridge credential format even after rotation removes its hash from the registry.
    throw unauthorized()
  })

  app.post(
    '/bridge/v1/hello',
    {
      onRequest: async (request) => {
        if (!timingSafeEqual(bearerHash(request.headers.authorization), bootstrapHash))
          throw unauthorized()
      },
    },
    async (request) => {
      const hello = BridgeHelloRequestSchema.parse(request.body)
      const token = randomBytes(32).toString('base64url')
      const now = clock()
      const at = new Date(now).toISOString()
      const expires = now + 60 * 60 * 1000
      const compatibility = getCompatibility()
      const gatewayApprovals =
        hello.pluginVersion === SHIPPED_PLUGIN_VERSION &&
        // Hermes reports `<version>+<build>`; the code SHA is the exact identity.
        hello.hermes.version.split('+', 1)[0] === compatibility.matchedHermes?.version &&
        hello.hermes.codeSha === compatibility.matchedHermes?.codeSha &&
        hello.isolation === 'in_process' &&
        ['list_gateway_approvals', 'resolve_gateway_approval', '_lock', '_gateway_queues'].every(
          (name) =>
            (hello.privateApis[`tools.approval.${name}`] ?? hello.privateApis[name]) === true,
        ) &&
        !compatibility.disabled.includes('gateway-approvals')
      db.tx((sqlite) => {
        const row = sqlite
          .prepare('SELECT * FROM producers WHERE incarnation = ?')
          .get(hello.incarnation)
        const previous = row === undefined ? undefined : ProducerSchema.parse(row)
        if (
          previous &&
          (previous.profile !== hello.profile ||
            previous.pid !== hello.pid ||
            previous.kanban_task_id !== hello.kanbanTaskId)
        ) {
          throw new HttpError(
            409,
            'conflict',
            'Producer incarnation belongs to a different identity',
          )
        }
        sqlite
          .prepare(
            `INSERT INTO producers (id, profile, incarnation, pid, kanban_task_id, isolation, plugin_version,
        hermes_version, hermes_code_sha, private_apis, token_hash, token_expires_at, created_at, last_seen_at, gateway_approvals, acked_through)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (incarnation) DO UPDATE SET isolation = excluded.isolation, plugin_version = excluded.plugin_version,
        hermes_version = excluded.hermes_version, hermes_code_sha = excluded.hermes_code_sha,
        private_apis = excluded.private_apis, token_hash = excluded.token_hash,
        token_expires_at = excluded.token_expires_at, last_seen_at = excluded.last_seen_at, gateway_approvals = excluded.gateway_approvals`,
          )
          .run(
            previous?.id ?? randomUUID(),
            hello.profile,
            hello.incarnation,
            hello.pid,
            hello.kanbanTaskId,
            hello.isolation,
            redact(hello.pluginVersion),
            redact(hello.hermes.version),
            redact(hello.hermes.codeSha),
            JSON.stringify(hello.privateApis),
            hashBridgeToken(token).toString('hex'),
            expires,
            at,
            at,
            gatewayApprovals ? 1 : 0,
            retainedBridgePosition(sqlite, hello.incarnation),
          )
      })
      return BridgeHelloResponseSchema.parse({
        producerToken: token,
        expiresAt: new Date(expires).toISOString(),
        enabled: {
          watch: true,
          kanbanGrants: false,
          gatewayApprovals,
        },
      })
    },
  )

  if (deps.outbox)
    registerBridgeDecisionRoutes(app, {
      outbox: deps.outbox,
      clock,
      authenticate(value) {
        const row = db.sqlite
          .prepare('SELECT * FROM producers WHERE token_hash = ?')
          .get(bearerHash(value).toString('hex'))
        if (!row) throw unauthorized()
        const producer = ProducerSchema.parse(row)
        if (producer.token_expires_at <= clock()) throw unauthorized()
        return producer
      },
    })

  app.post(
    '/bridge/v1/events',
    {
      bodyLimit: 2 * 1024 * 1024,
      onRequest: async (request) => {
        const hash = bearerHash(request.headers.authorization).toString('hex')
        const row = db.sqlite.prepare('SELECT * FROM producers WHERE token_hash = ?').get(hash)
        if (row === undefined || ProducerSchema.parse(row).token_expires_at <= clock())
          throw unauthorized()
      },
    },
    async (request) => {
      const hash = bearerHash(request.headers.authorization).toString('hex')
      const row = db.sqlite.prepare('SELECT * FROM producers WHERE token_hash = ?').get(hash)
      if (row === undefined) throw unauthorized()
      const producer = ProducerSchema.parse(row)
      if (producer.token_expires_at <= clock()) throw unauthorized()
      const { events } = BatchSchema.parse(request.body)
      // Validate the whole batch before accepting any part of it.
      const observations = events.map((event) =>
        translateBridgeEvent(producer, event, metrics, getCompatibility().disabled),
      )
      let ackedThrough: number
      try {
        for (const observation of observations) await ingest.submit(observation)
      } finally {
        ackedThrough = db.tx((sqlite) =>
          acknowledge(sqlite, producer, new Date(clock()).toISOString()),
        )
        ingest.clearHolds(`bridge:${producer.incarnation}`, 'events', ackedThrough)
      }
      return BridgeEventsResponseSchema.parse({ ackedThrough })
    },
  )
}
