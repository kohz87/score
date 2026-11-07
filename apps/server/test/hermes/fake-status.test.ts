import { expect, test } from 'vitest'
import { installFakeHooks, type FakeState } from './fake-helpers.ts'

let directory: FakeState['directory']
let db: FakeState['db']
let ingest: FakeState['ingest']
let port: FakeState['port']
let scheduler: FakeState['scheduler']
let sink: FakeState['sink']
let observations: FakeState['observations']
let results: FakeState['results']
let onError: FakeState['onError']

installFakeHooks(
  (state) => {
    directory = state.directory
    db = state.db
    ingest = state.ingest
    port = state.port
    scheduler = state.scheduler
    sink = state.sink
    observations = state.observations
    results = state.results
    onError = state.onError
  },
  () => ({ directory, db, ingest, port, scheduler, sink, observations, results, onError }),
)

test('fake status and agent styles match the defaults; returned objects cannot mutate port state', async () => {
  expect(port.status()).toMatchObject({
    hermes: {
      reachable: true,
      apiServer: true,
      servedProfiles: ['lead', 'builder', 'reviewer', 'designer'],
    },
    bridge: { producers: 0 },
    compatibility: { fingerprint: 'fake', tested: true, disabled: [] },
    agentIsolation: 'same_user',
    degraded: [],
  })
  const agents = await port.listAgents()
  expect(agents.map(({ id, style }) => ({ id, ...style }))).toEqual([
    { id: 'lead', color: '#6B4EFF', shape: 'circle-dot' },
    { id: 'builder', color: '#19C39A', shape: 'triangle' },
    { id: 'reviewer', color: '#FFB61E', shape: 'diamond' },
    { id: 'designer', color: '#FF6B8A', shape: 'square' },
  ])
  agents[0]!.style.color = '#000000'
  expect((await port.listAgents())[0]!.style.color).toBe('#6B4EFF')
  await port.start(sink)
  await port.start(sink)
  await scheduler.advance(900 * 18)
  expect(observations).toHaveLength(15)
  expect((await port.listAgents())[1]!.status).toBe('working')
})
