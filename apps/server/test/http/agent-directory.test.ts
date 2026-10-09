import fs from 'node:fs'
import type { AgentDetail } from '@score/contract'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createAgentDirectory, withAgentDirectory } from '../../src/http/agent-directory.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import type { HermesPort } from '../../src/hermes/index.ts'
import { setup } from '../hermes/live/gateway/helpers.ts'

let env: ReturnType<typeof setup>
let fake: FakePort
let details: AgentDetail[]
let now = 0
beforeEach(async () => {
  env = setup()
  fake = new FakePort(1, { db: env.db }, false)
  details = await fake.listAgentDetails()
  now = 1_000_000
})
afterEach(async () => {
  await env.ingest.close()
  env.db.close()
  fs.rmSync(env.home, { recursive: true, force: true })
})

const slowPort = (read: () => Promise<AgentDetail[]>) =>
  ({ listAgentDetails: vi.fn(read) }) as unknown as Pick<HermesPort, 'listAgentDetails'> & {
    listAgentDetails: ReturnType<typeof vi.fn>
  }

test('a cold server waits once; later reads answer from the projection without Hermes', async () => {
  const port = slowPort(async () => details)
  const directory = createAgentDirectory(port, env.db, env.ingest, undefined, () => now)
  expect((await directory.details()).map((a) => a.id)).toEqual(details.map((a) => a.id))
  expect(port.listAgentDetails).toHaveBeenCalledTimes(1)
  now += 5_000
  await directory.details()
  expect(port.listAgentDetails).toHaveBeenCalledTimes(1)
})

test('a stale projection answers at once and refreshes in the background', async () => {
  let release: () => void = () => undefined
  const port = slowPort(async () => details)
  const directory = createAgentDirectory(port, env.db, env.ingest, undefined, () => now)
  await directory.details()
  port.listAgentDetails.mockImplementation(
    () => new Promise<AgentDetail[]>((resolve) => (release = () => resolve(details))),
  )
  now += 20_000
  const answered = await directory.details()
  expect(answered.length).toBe(details.length)
  expect(port.listAgentDetails).toHaveBeenCalledTimes(2)
  // A second page load while the refresh is running shares it.
  await directory.details()
  expect(port.listAgentDetails).toHaveBeenCalledTimes(2)
  release()
})

test('the first agent read after an agent-affecting write goes to Hermes', async () => {
  const read = vi.spyOn(fake, 'listAgentDetails')
  const port = withAgentDirectory(
    fake,
    createAgentDirectory(fake, env.db, env.ingest, undefined, () => now),
  )
  await port.listAgentDetails()
  await port.listAgents()
  expect(read).toHaveBeenCalledTimes(1)
  await port.setAgentModel(details[0]!.id, { model: 'example-model' }).catch(() => undefined)
  await port.listAgentDetails()
  expect(read).toHaveBeenCalledTimes(2)
  await port.listAgentDetails()
  expect(read).toHaveBeenCalledTimes(2)
})
