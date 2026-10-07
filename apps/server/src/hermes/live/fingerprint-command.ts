import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../../config.ts'
import { migrate, ScoreDb } from '../../db/index.ts'
import { computeFingerprint, type Fingerprint } from './fingerprint.ts'
import { GatewayClient } from './gateway.ts'

export async function currentMachineFingerprint(): Promise<Fingerprint> {
  const config = loadConfig(process.env)
  // The gateway client tracks credential generations; the printer needs no persistent Score writes.
  const db = new ScoreDb(new DatabaseSync(':memory:'))
  try {
    migrate(db, fileURLToPath(new URL('../../../migrations/', import.meta.url)))
    const gateway = new GatewayClient({
      scoreHome: config.home,
      db,
      ...(config.hermesUrl ? { baseUrl: config.hermesUrl } : {}),
    })
    return await computeFingerprint({
      ...(config.hermesHome ? { hermesHome: config.hermesHome } : {}),
      gateway,
    })
  } finally {
    db.close()
  }
}
