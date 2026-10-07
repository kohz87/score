import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate, openDatabase } from '../../../../src/db/index.ts'
import { createIngest } from '../../../../src/hub/ingest.ts'
import { GatewayClient } from '../../../../src/hermes/live/gateway.ts'
import { RunIntents } from '../../../../src/hermes/live/intents.ts'
import { FakeGateway } from './fake-gateway.ts'

export function setup() {
  const home = mkdtempSync(join(tmpdir(), 'score-gateway-'))
  mkdirSync(join(home, 'hermes-keys'), { mode: 0o700 })
  const fake = new FakeGateway()
  for (const [profile, key] of fake.keys)
    writeFileSync(join(home, 'hermes-keys', profile), key, { mode: 0o600 })
  const db = openDatabase(join(home, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../../../migrations/', import.meta.url)))
  const ingest = createIngest(db)
  const gateway = new GatewayClient({ scoreHome: home, db, fetch: fake.fetch })
  const intents = new RunIntents({ db, gateway, sink: ingest })
  return { home, db, ingest, gateway, intents, fake }
}
