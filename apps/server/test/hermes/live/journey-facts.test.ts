import fs from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { readJourneyFacts } from '../../../src/hermes/live/journey-facts.ts'

const TMP = '/home/raven/.claude/jobs/999c85f0/tmp/7.4bc'
let root: string
beforeEach(() => {
  fs.mkdirSync(TMP, { recursive: true })
  root = fs.mkdtempSync(join(TMP, 'journey-'))
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

test('skills by name and memory file times only; contents are never returned', () => {
  const home = join(root, 'profiles', 'builder')
  fs.mkdirSync(join(home, 'skills', 'review'), { recursive: true })
  fs.mkdirSync(join(home, 'memories'), { recursive: true })
  fs.writeFileSync(
    join(home, 'skills', 'review', 'SKILL.md'),
    '---\nname: code-review\n---\nSECRET-BODY',
  )
  fs.writeFileSync(join(home, 'memories', 'MEMORY.md'), 'MEMORY-SECRET')
  const facts = readJourneyFacts(
    { from: 0, to: Date.now() + 1000, agentIds: ['builder', 'ghost'] },
    (profile) => (profile === 'builder' ? home : null),
    root,
  )
  expect(facts.tasks).toEqual([]) // no kanban.db under this home
  expect(facts.skills).toEqual([
    { agentId: 'builder', at: expect.any(Number), name: 'code-review' },
  ])
  expect(facts.memory).toEqual([{ agentId: 'builder', at: expect.any(Number) }])
  expect(JSON.stringify(facts)).not.toMatch(/SECRET/)
})
