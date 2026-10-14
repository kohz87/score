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
  await port.setSkillEnabled(details[0]!.id, 'example', false).catch(() => undefined)
  await port.listAgentDetails()
  expect(read).toHaveBeenCalledTimes(2)
  await port.listAgentDetails()
  expect(read).toHaveBeenCalledTimes(2)
})

test('a model save answers from what was written and confirms it in the background (5.23)', async () => {
  const port = withAgentDirectory(
    fake,
    createAgentDirectory(fake, env.db, env.ingest, undefined, () => now),
  )
  await port.listAgentDetails()
  const read = vi.spyOn(fake, 'listAgentDetails')
  const id = details[0]!.id
  await port.setAgentModel(id, { model: 'example/new-model', provider: 'example' })
  const answered = (await port.listAgentDetails()).find((agent) => agent.id === id)!
  expect(answered.model).toMatchObject({ id: 'example/new-model', via: 'example' })
  expect(read).toHaveBeenCalledTimes(1)
})

test('a refresh that started before a save cannot undo it, and the post-save read starts after the save', async () => {
  const old = structuredClone(details)
  const updated = structuredClone(details)
  updated[0]!.model = {
    id: 'new-model',
    label: 'new-model',
    via: 'Hermes configuration',
    fallback: null,
  }
  let stored = old // what Hermes holds
  const releases: Array<() => void> = []
  const port = {
    // Each read snapshots Hermes when it STARTS and answers later.
    listAgentDetails: vi.fn(
      () =>
        new Promise<AgentDetail[]>((resolve) => {
          const snapshot = structuredClone(stored)
          releases.push(() => resolve(snapshot))
        }),
    ),
    setAgentModel: vi.fn(async () => {
      stored = updated
    }),
  }
  const directory = createAgentDirectory(port as never, env.db, env.ingest, undefined, () => now)
  const wrapped = withAgentDirectory(port as unknown as HermesPort, directory)
  // Warm the projection, then let it go stale so a background refresh starts (and hangs).
  const first = directory.details()
  releases.shift()!()
  await first
  now += 20_000
  await wrapped.listAgentDetails() // background refresh begins with the OLD snapshot
  expect(port.listAgentDetails).toHaveBeenCalledTimes(2)
  await wrapped.setAgentModel(details[0]!.id, { model: 'new-model' })
  // The save answers from the recorded model at once.
  const reads = port.listAgentDetails.mock.calls.length
  releases.shift()!() // the old refresh finishes now
  await new Promise((resolve) => setTimeout(resolve, 20))
  const shown = (await directory.details()).find((agent) => agent.id === details[0]!.id)
  expect(shown?.model?.id).toBe('new-model')
  // Anything started after the save sees the new snapshot.
  for (const release of releases.splice(0)) release()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const again = (await directory.details()).find((agent) => agent.id === details[0]!.id)
  expect(again?.model?.id).toBe('new-model')
  expect(port.listAgentDetails.mock.calls.length).toBeGreaterThanOrEqual(reads)
})

test('live routes see a coding agent created a moment ago (7.7b live check: preflight found no coding worker)', async () => {
  const { routePort } = await import('../../src/app.ts')
  const { withCodingAgents } = await import('../../src/runtimes/coding/port.ts')
  type Coding = Parameters<typeof withCodingAgents>[1]
  const coder = {
    ...details[0]!,
    id: 'coder',
    name: 'coder',
    runtime: 'claude-code',
    runtimeNote: 'Claude Code',
  }
  const codingAgents: (typeof coder)[] = []
  const coding = {
    isCodingAgent: (id: string) => codingAgents.some((agent) => agent.id === id),
    details: async () => [...codingAgents],
  } as unknown as Coding
  // The composition root hands buildApp the composite (Hermes + coding); live mode adds the directory.
  const port = routePort({
    live: true,
    port: withCodingAgents(fake, coding),
    coding,
    db: env.db,
    ingest: env.ingest,
  })
  await port.listAgents() // a page load primes the directory's projection
  codingAgents.push(coder) // the person creates a coding agent, then starts an orchestration right away
  const ids = (await port.listAgents()).map((agent) => agent.id)
  expect(ids).toContain('coder')
  for (const agent of details) expect(ids).toContain(agent.id)
})
