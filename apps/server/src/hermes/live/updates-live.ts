import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ScoreDb } from '../../db/index.ts'
import type { HermesPort } from '../port.ts'
import { spawnHermesUpdate } from './cli.ts'
import { resolveHermesHome } from './paths.ts'
import { HermesUpdates } from './updates.ts'

/** Score is idle for an update: no turn in a room and no Hermes run queued, running or waiting for an approval. */
export function scoreIdle(db: ScoreDb): { idle: boolean; note: string } {
  return db.read((sqlite) => {
    const turns = sqlite
      .prepare("SELECT count(*) AS n FROM message_runs WHERE state = 'active'")
      .get() as { n: number }
    const runs = sqlite
      .prepare(
        "SELECT count(*) AS n FROM runs WHERE status IN ('queued','running','waiting_for_approval')",
      )
      .get() as { n: number }
    const busy = turns.n + runs.n
    return { idle: busy === 0, note: busy === 0 ? 'nothing running' : `${busy} still working` }
  })
}

/**
 * Sizes only (lstat, never a file's contents, so Hermes's credential files are never read): Hermes's home without its
 * own code checkout, which its backup leaves out. Cached for ten minutes; a walk of a large home takes a few seconds.
 */
function backupEstimate(home: string) {
  let cached: { at: number; value: Promise<number | null> } | null = null
  const walk = async (dir: string): Promise<number> => {
    let total = 0
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) total += await walk(full)
      else if (entry.isFile()) total += (await fs.lstat(full).catch(() => null))?.size ?? 0
    }
    return total
  }
  return (): Promise<number | null> => {
    const now = Date.now()
    if (!cached || now - cached.at > 10 * 60_000)
      cached = {
        at: now,
        value: (async () => {
          let total = 0
          for (const entry of await fs.readdir(home, { withFileTypes: true })) {
            if (entry.name === 'hermes-agent') continue
            const full = path.join(home, entry.name)
            if (entry.isDirectory()) total += await walk(full)
            else if (entry.isFile()) total += (await fs.lstat(full)).size
          }
          // A zip of mixed files plus room to spare: the update also installs new dependencies.
          return Math.round(total * 0.8 + 2 * 1024 ** 3)
        })().catch(() => null),
      }
    return cached.value
  }
}

export function createLiveHermesUpdates(options: {
  db: ScoreDb
  port: HermesPort
  hermesHome?: string | undefined
}): HermesUpdates {
  const home = resolveHermesHome(options.hermesHome)
  return new HermesUpdates({
    hermesHome: options.hermesHome,
    spawn: spawnHermesUpdate,
    idle: () => scoreIdle(options.db),
    version: () =>
      new Promise((resolve) => {
        let first: string | null = null
        const child = spawnHermesUpdate('version', 'stable', {
          hermesHome: options.hermesHome,
          onLine: (line) => {
            if (first === null && line.trim()) first = line.trim()
          },
        })
        void child.exited.then((code) => resolve(code === 0 ? first : null))
      }),
    check: () => options.port.checkHermes(),
    accept: (hash) => options.port.acceptHermes(hash),
    startTestRun: (agentId, input) =>
      options.port.startRun({ agentId, input, turnId: randomUUID() }),
    readRun: (runId) =>
      options.db.read(
        (sqlite) =>
          sqlite.prepare('SELECT status, output, error FROM runs WHERE id = ?').get(runId) as
            { status: string; output: string | null; error: string | null } | undefined,
      ),
    diskFreeBytes: async () => {
      const stats = await fs.statfs(home)
      return stats.bavail * stats.bsize
    },
    backupNeedsBytes: backupEstimate(home),
  })
}
