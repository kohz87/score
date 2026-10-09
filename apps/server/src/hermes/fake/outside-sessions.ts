import { redact } from '../../redact.ts'
import {
  sourceLabel,
  type OutsideSessionFact,
  type OutsideSessionHistory,
  type OutsideSessionMessage,
} from '../outside-sessions.ts'

// Neutral example conversations the fake adapter pretends Hermes has from elsewhere (demo and e2e).
interface Seed {
  id: string
  agentId: string
  source: string
  title: string
  hoursAgo: number
  busy?: boolean
  turns: [OutsideSessionMessage['role'], string][]
}

const SEEDS: Seed[] = [
  {
    id: 'ext-telegram-1',
    agentId: 'lead',
    source: 'telegram',
    title: 'Plan the launch checklist',
    hoursAgo: 30,
    turns: [
      ['user', 'Can you outline the launch checklist for next week?'],
      [
        'assistant',
        'Sure. **Checklist**\n\n- Freeze the release branch\n- Run the full test suite\n- Write the announcement',
      ],
      [
        'user',
        'Add a step for the docs review, and use api_key=sk-fakefakefakefake123 for the preview site.',
      ],
      ['assistant', 'Added "Review the docs" after the test run.'],
    ],
  },
  {
    id: 'ext-cli-1',
    agentId: 'builder',
    source: 'cli',
    title: '',
    hoursAgo: 5,
    turns: [
      ['user', 'Why is the parser test flaky on CI?'],
      [
        'assistant',
        'It depends on map iteration order. Sorting the keys before comparing fixes it.',
      ],
    ],
  },
  {
    id: 'ext-discord-1',
    agentId: 'builder',
    source: 'discord',
    title: 'Live pairing session',
    hoursAgo: 0,
    busy: true,
    turns: [
      ['user', 'Are you there?'],
      ['assistant', 'Yes, working on the migration.'],
    ],
  },
]

export function fakeOutsideSessions(
  agentIds: string[],
  nowMs: number,
  known?: ReadonlySet<string>,
): { items: OutsideSessionFact[]; unavailable: string[] } {
  const items = SEEDS.filter(
    (seed) => agentIds.includes(seed.agentId) && (!known || known.has(seed.agentId)),
  )
    .map((seed) => factOf(seed, nowMs))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  return { items, unavailable: [] }
}

function factOf(seed: Seed, nowMs: number): OutsideSessionFact {
  const firstUser = seed.turns.find(([role]) => role === 'user')?.[1] ?? ''
  return {
    id: seed.id,
    agentId: seed.agentId,
    source: seed.source,
    sourceLabel: sourceLabel(seed.source),
    title: seed.title || redact(firstUser).slice(0, 120),
    startedAt: new Date(nowMs - seed.hoursAgo * 3_600_000).toISOString(),
    messageCount: seed.turns.length,
    busy: seed.busy === true,
  }
}

export function fakeOutsideSession(
  agentId: string,
  sessionId: string,
  nowMs: number,
): OutsideSessionHistory | null {
  const seed = SEEDS.find((item) => item.id === sessionId && item.agentId === agentId)
  if (!seed) return null
  const start = nowMs - seed.hoursAgo * 3_600_000
  return {
    session: factOf(seed, nowMs),
    messages: seed.turns.map(([role, text], index) => ({
      role,
      text: redact(text),
      at: new Date(start + index * 60_000).toISOString(),
    })),
  }
}
