import type { OrchEvent } from '@score/contract'
import { describe, expect, it } from 'vitest'
import { statusMessages } from './status-messages.ts'

let n = 0
const event = (patch: Partial<OrchEvent> & Pick<OrchEvent, 'kind'>): OrchEvent => ({
  id: `e${++n}`,
  at: `2026-10-16T10:00:${String(n).padStart(2, '0')}.000Z`,
  stepId: null,
  attemptId: null,
  tool: null,
  verdict: null,
  code: null,
  summary: '',
  ...patch,
})

describe('statusMessages', () => {
  const context = { stepAgent: (id: string) => (id === 's1' ? 'builder' : null) }

  it('turns the news of a run into short lines, in time order', () => {
    const lines = statusMessages(
      [
        event({ kind: 'run_started' }),
        event({ kind: 'step_admitted', stepId: 's1' }),
        event({ kind: 'gate_opened', stepId: 's2' }),
        event({ kind: 'gate_decided', stepId: 's2', verdict: 'approved' }),
        event({ kind: 'step_result', stepId: 's1', verdict: 'succeeded' }),
        event({ kind: 'control', verdict: 'ended', summary: 'Run ended: succeeded' }),
      ],
      context,
    )
    expect(lines.map((line) => line.text)).toEqual([
      'The run started.',
      'Step s1 (builder) started.',
      'Waiting for you: approve s2.',
      'You approved s2.',
      'Step s1 (builder) finished.',
      'The run finished.',
    ])
    expect(lines.map((line) => line.tone)).toEqual(['info', 'info', 'need', 'info', 'ok', 'ok'])
  })

  it('keeps the event id so a line is stable between reads', () => {
    const source = event({ kind: 'inquiry_opened' })
    expect(statusMessages([source])[0]?.id).toBe(source.id)
  })

  it('says failures and stops plainly', () => {
    const lines = statusMessages([
      event({ kind: 'step_result', stepId: 's3', verdict: 'failed' }),
      event({ kind: 'control', verdict: 'stop_requested' }),
      event({ kind: 'control', verdict: 'ended', summary: 'Run ended: stopped' }),
      event({ kind: 'control', verdict: 'ended', summary: 'Run ended: failed (lead_failing)' }),
    ])
    expect(lines.map((line) => line.text)).toEqual([
      'Step s3 failed.',
      'Stopping the run.',
      'The run was stopped.',
      'The run failed.',
    ])
  })

  it('leaves out the lead’s own turns, tool calls and withdrawn gates', () => {
    expect(
      statusMessages([
        event({ kind: 'lead_wake' }),
        event({ kind: 'lead_done' }),
        event({ kind: 'command', tool: 'orch.assign', verdict: 'accepted' }),
        event({ kind: 'gate_decided', stepId: 's1', verdict: 'withdrawn' }),
        event({ kind: 'control', verdict: 'late_result' }),
      ]),
    ).toEqual([])
  })

  it('separates a pause by the person from one Score caused', () => {
    const lines = statusMessages([
      event({ kind: 'control', verdict: 'paused', summary: 'Run paused by you' }),
      event({ kind: 'control', verdict: 'paused', summary: 'Run paused (budget)' }),
    ])
    expect(lines.map((line) => line.text)).toEqual(['You paused the run.', 'The run paused.'])
  })
})
