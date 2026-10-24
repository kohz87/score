import { describe, expect, test } from 'vitest'
import type { ExchangeAction } from '@score/contract'
import { parseScoreAction } from '../../src/domain/exchanges/action-block.ts'

const block = (value: unknown) =>
  `\`\`\`score-action\n${typeof value === 'string' ? value : JSON.stringify(value)}\n\`\`\``

const actions: ExchangeAction[] = [
  { action: 'handoff', to: 'builder', note: 'Build it' },
  { action: 'ask', to: 'builder', question: 'Can you build it?' },
  { action: 'review', to: 'reviewer', note: 'Please review', replaces: 'cmd-1' },
  { action: 'approve', note: 'Looks good' },
  { action: 'send_back', note: 'Needs tests' },
  { action: 'reply', text: 'The answer is 42' },
]

describe('parseScoreAction', () => {
  test.each(actions)('parses $action', (action) => {
    expect(parseScoreAction(`Before.\n${block(action)}\nAfter.`)).toEqual({
      kind: 'action',
      action,
    })
  })

  test('keeps replaces, including replacing an earlier command', () => {
    expect(parseScoreAction(block({ action: 'approve', note: 'ok', replaces: 'cmd:1' }))).toEqual({
      kind: 'action',
      action: { action: 'approve', note: 'ok', replaces: 'cmd:1' },
    })
  })

  test('zero blocks is no action', () => {
    expect(parseScoreAction('Just a normal reply.')).toEqual({ kind: 'none' })
  })

  test('two blocks are refused with a count, not their content', () => {
    const out = parseScoreAction(
      `${block({ action: 'approve', note: 'first secret' })}\n${block({ action: 'approve', note: 'second secret' })}`,
    )
    expect(out.kind).toBe('invalid')
    if (out.kind === 'invalid') {
      expect(out.notice).toContain('2 score-action blocks')
      expect(out.notice).not.toContain('secret')
    }
  })

  test('a complete block plus a stray opening marker is refused', () => {
    const out = parseScoreAction(`${block({ action: 'approve', note: 'ok' })}\n\`\`\`score-action`)
    expect(out.kind).toBe('invalid')
    if (out.kind === 'invalid') expect(out.notice).toContain('2 score-action blocks')
  })

  test('an unterminated block is refused', () => {
    const out = parseScoreAction('```score-action\n{"action":"approve","note":"ok"}')
    expect(out).toEqual({
      kind: 'invalid',
      notice: "Score ignored this reply's action: the score-action block wasn't complete.",
    })
  })

  test('invalid JSON is refused without quoting the body', () => {
    const out = parseScoreAction(block('{"action":"approve","note":"private secret"'))
    expect(out.kind).toBe('invalid')
    if (out.kind === 'invalid') {
      expect(out.notice).toContain("wasn't valid JSON")
      expect(out.notice).not.toContain('private')
    }
  })

  test('unknown actions and extra keys are refused', () => {
    expect(parseScoreAction(block({ action: 'delegate', to: 'builder', note: 'x' })).kind).toBe(
      'invalid',
    )
    const extra = parseScoreAction(
      block({ action: 'approve', note: 'ok', secret: 'do not quote me' }),
    )
    expect(extra.kind).toBe('invalid')
    if (extra.kind === 'invalid') expect(extra.notice).not.toContain('do not quote me')
  })

  test('reports a missing field without quoting the action', () => {
    expect(parseScoreAction(block({ action: 'approve' }))).toEqual({
      kind: 'invalid',
      notice: "Score ignored this reply's action: the action wasn't valid (note is required).",
    })
  })

  test('byte limits count UTF-8 bytes, not characters', () => {
    const reply8000 = 'é'.repeat(4000)
    expect(parseScoreAction(block({ action: 'reply', text: reply8000 })).kind).toBe('action')
    expect(parseScoreAction(block({ action: 'reply', text: reply8000 + 'é' })).kind).toBe('invalid')
    expect(
      parseScoreAction(block({ action: 'handoff', to: 'builder', note: 'é'.repeat(2000) })).kind,
    ).toBe('action')
    expect(
      parseScoreAction(block({ action: 'handoff', to: 'builder', note: 'é'.repeat(2001) })).kind,
    ).toBe('invalid')
  })

  test('accepts CRLF line endings', () => {
    const reply = 'Before\r\n```score-action   \r\n{"action":"approve","note":"ok"}\r\n```\r\nAfter'
    expect(parseScoreAction(reply)).toEqual({
      kind: 'action',
      action: { action: 'approve', note: 'ok' },
    })
  })

  test('finds one block inside surrounding text', () => {
    const reply = `Here is my work.\n\n${block({ action: 'review', to: 'reviewer', note: 'Look' })}\n\nThanks.`
    expect(parseScoreAction(reply)).toEqual({
      kind: 'action',
      action: { action: 'review', to: 'reviewer', note: 'Look' },
    })
  })

  test('a score-verdict block is not an action', () => {
    expect(parseScoreAction('```score-verdict\n{"verdict":"passed","reason":"ok"}\n```')).toEqual({
      kind: 'none',
    })
  })
})
