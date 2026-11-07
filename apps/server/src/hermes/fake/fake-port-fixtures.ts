import { createHash } from 'node:crypto'
import type { HubSkill } from '@score/contract'
import type { Scheduler } from '../port.ts'

export const realScheduler: Scheduler = {
  now: Date.now,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export const memoryId = (text: string) =>
  `m-${createHash('sha1').update(text).digest('hex').slice(0, 12)}`
export const fakeHub: HubSkill[] = [
  ['changelog-writer', 'Drafts a changelog from merged pull requests.'],
  ['test-triage', 'Groups failing tests by likely cause.'],
  ['release-checklist', 'Walks through a release checklist step by step.'],
  ['meeting-notes', 'Turns a transcript into notes and action items.'],
].map(([name, description]) => ({
  name: name!,
  identifier: `example/skills/${name}`,
  source: 'official',
  trust: 'builtin',
  description: description!,
}))
