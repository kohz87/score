import { expect, test } from 'vitest'
import { codingQuota, NOW } from '../../bold/quota/quota-test-data.ts'
import { buildUsageCard } from './usage-card.ts'

const context = {
  model: 'm',
  tokens: { input: 150_000, output: 32_000 },
  costUsd: null,
  contextLength: 434_000,
}

test('the /usage card has this session (tokens, context % full, no cost) and a bar per window', () => {
  const card = buildUsageCard(undefined, 'Builder', context, codingQuota(), 'claude-code', NOW)
  expect(card).toMatchObject({
    name: 'Builder',
    tokens: '182k tokens',
    contextPercent: 42,
    costUsd: null,
    planTitle: 'CLAUDE PLAN QUOTA',
  })
  expect(card.quota).toMatchObject({
    kind: 'windows',
    read: 'read after the 5:05 am turn',
    windows: [
      { title: '5 hours', left: 62, tone: 'ok', resets: '5:40 am' },
      { title: 'Week', left: 80, tone: 'ok' },
    ],
  })
})

test('a dollar cost appears only when the context reports one', () => {
  expect(
    buildUsageCard(undefined, 'B', { ...context, costUsd: 1.25 }, null, 'codex', NOW).costUsd,
  ).toBe(1.25)
})

test('an unknown share has no bar value, a low one is amber, and Antigravity names each group', () => {
  const card = buildUsageCard(
    undefined,
    'B',
    context,
    codingQuota(
      [
        { name: '5 hours', group: 'Gemini Models', usedPercent: null, resetsAt: null },
        { name: '5 hours', group: 'Claude and GPT models', usedPercent: 80.5, resetsAt: null },
      ],
      { runtime: 'antigravity', source: 'usage' },
    ),
    'antigravity',
    NOW,
  )
  expect(card.quota).toMatchObject({
    windows: [
      { title: 'Gemini Models, 5 hours', left: null, exact: null, tone: 'ok' },
      { title: 'Claude and GPT models, 5 hours', left: 20, tone: 'low' },
    ],
  })
})

test('no reading and a failed read are messages, not bars', () => {
  expect(buildUsageCard(undefined, 'B', context, null, 'codex', NOW).quota).toEqual({
    kind: 'message',
    text: 'Quota · shows after its first turn.',
  })
  expect(buildUsageCard(undefined, 'B', context, undefined, 'codex', NOW).quota).toEqual({
    kind: 'message',
    text: 'Quota couldn’t be read.',
  })
})
