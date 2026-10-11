import { describe, expect, it } from 'vitest'
import type { MessagePart } from '@score/contract'
import { callingLine, statusLine, statusSegments, STATUS_MAX, trimLine } from './status-line.ts'

const tool = (name: string, status: 'running' | 'ok' | 'error' = 'running'): MessagePart => ({
  kind: 'tool',
  tool: name,
  args: '',
  result: null,
  status,
})
const text = (value: string): MessagePart => ({ kind: 'text', text: value })

describe('statusLine', () => {
  it('says nothing for an agent that is not working', () => {
    expect(statusLine({})).toBeNull()
    expect(statusLine({ parts: [] })).toBeNull()
  })

  it('names the running tool in code style', () => {
    expect(statusLine({ parts: [tool('search_changelog')] })).toBe('Calling `search_changelog()`…')
  })

  it('says the reply is being written while text streams', () => {
    expect(statusLine({ parts: [text('Here is')] })).toBe('Writing the reply…')
  })

  it('falls back to thinking for reasoning, a finished tool or an empty reply', () => {
    expect(statusLine({ parts: [{ kind: 'thinking', text: 'hm' }] })).toBe('Thinking…')
    expect(statusLine({ parts: [tool('a', 'ok')] })).toBe('Thinking…')
    expect(statusLine({ working: true })).toBe('Thinking…')
  })

  it('uses the typing event when no part says more', () => {
    expect(statusLine({ typing: 'is typing…' })).toBe('Writing the reply…')
    expect(statusLine({ typing: 'is typing…', parts: [tool('x')] })).toBe('Calling `x()`…')
  })

  it('ranks approval over compaction over tool over writing', () => {
    const parts = [text('hello'), tool('read_file')]
    expect(statusLine({ parts, compacting: true, waitingForApproval: true })).toBe(
      'Waiting for your approval',
    )
    expect(statusLine({ parts, compacting: true })).toBe('Compacting context…')
    expect(statusLine({ parts })).toBe('Calling `read_file()`…')
    expect(statusLine({ parts: [tool('read_file'), text('done')] })).toBe('Calling `read_file()`…')
    expect(statusLine({ parts: [tool('read_file', 'ok'), text('done')] })).toBe(
      'Writing the reply…',
    )
  })

  it('ignores an approval card part when looking at what came last', () => {
    expect(statusLine({ parts: [text('x'), { kind: 'approval', approvalId: 'a' }] })).toBe(
      'Writing the reply…',
    )
  })

  it('keeps every line within the limit, cutting the tool name and not the marks', () => {
    const line = statusLine({ parts: [tool('a_very_long_tool_name_'.repeat(5))] })!
    expect(line.length).toBeLessThanOrEqual(STATUS_MAX)
    expect(line).toMatch(/^Calling `.+…\(\)`…$/)
    expect(statusSegments(line)).toHaveLength(3)
    expect(callingLine('short')).toBe('Calling `short()`…')
  })

  it('trims plain text with one ellipsis', () => {
    expect(trimLine('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`)
    expect(trimLine('short', 10)).toBe('short')
  })
})
