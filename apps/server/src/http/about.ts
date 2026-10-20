import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  AboutSchema,
  CONTRACT_VERSION,
  UpdateCheckSchema,
  type SystemStatus,
} from '@score/contract'
import { humanGuard } from '../auth/human.ts'
import type { Config } from '../config.ts'
import type { ScoreDb } from '../db/index.ts'
import { CHECKOUT, createUpdateChecker, readCommit, type UpdateFetcher } from '../domain/about.ts'

const PackageSchema = z.object({ version: z.string().min(1) })
const packageVersion = (): string =>
  PackageSchema.parse(
    JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')),
  ).version

const defaultFetcher: UpdateFetcher = (url, init) => fetch(url, { ...init, redirect: 'error' })

/** Settings › About. The update check runs only when POSTed (a click); nothing here starts it by itself. */
export function registerAboutRoutes(
  app: FastifyInstance,
  options: {
    config: Pick<Config, 'mode' | 'updateRepo'>
    db: ScoreDb | undefined
    getSystemStatus: () => SystemStatus
    fetcher?: UpdateFetcher
    commit?: () => Promise<string | null>
    clock?: () => number
  },
): void {
  const version = packageVersion()
  const { config } = options
  // Fake mode never reaches GitHub: its answer is fixed.
  const fakeFetcher: UpdateFetcher = async () => ({
    ok: true,
    status: 200,
    json: async () => [{ name: `v${version}` }],
  })
  const check = createUpdateChecker({
    repo: config.updateRepo,
    version,
    fetcher: options.fetcher ?? (config.mode === 'fake' ? fakeFetcher : defaultFetcher),
    ...(options.clock ? { clock: options.clock } : {}),
  })
  const schema = (): number => {
    if (!options.db) return 0
    const row = options.db.read((sqlite) =>
      sqlite.prepare('SELECT MAX(version) AS version FROM schema_migrations').get(),
    )
    return z.object({ version: z.number().nullable() }).parse(row).version ?? 0
  }
  app.get('/api/about', async () => {
    const { hermes: status } = options.getSystemStatus()
    const hermes = status.version
    return AboutSchema.parse({
      version,
      commit: await (options.commit ?? readCommit)(),
      schema: schema(),
      contract: CONTRACT_VERSION,
      hermes: hermes ? { version: hermes } : null,
      node: process.version,
      mode: config.mode,
      repository: `https://github.com/${config.updateRepo}`,
      checkout: CHECKOUT,
      // The launcher sets it only for the systemd service's own process (scripts/score run).
      service: process.env.SCORE_RUN_AS === 'service',
    })
  })
  app.post('/api/about/update-check', { preHandler: humanGuard(app.pairing) }, async () =>
    UpdateCheckSchema.parse(await check()),
  )
}
