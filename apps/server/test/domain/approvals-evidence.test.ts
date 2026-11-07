import { expect, test } from 'vitest'
import { deriveApproval } from '../../src/domain/approvals.ts'

const baseEvidence = {
  stage: 'human' as const,
  linked_to: null,
  guardian_verdict: null,
  decision_choice: null,
  closed_reason: null,
  tool_outcome: null,
}
test.each([
  [{}, 'none', 'human_pending', 'pending'],
  [{ stage: 'guardian' }, 'none', 'guardian_evaluating', 'pending'],
  [
    { stage: 'guardian', linked_to: 'human', guardian_verdict: 'deny' },
    'none',
    'escalated',
    'withdrawn',
  ],
  [{ stage: 'guardian', guardian_verdict: 'approve' }, 'none', 'decided', 'approved'],
  [
    { stage: 'guardian', guardian_verdict: 'deny', closed_reason: 'expired' },
    'none',
    'decided',
    'denied',
  ],
  [{ decision_choice: 'once', closed_reason: 'timeout' }, 'none', 'decided', 'approved'],
  [{ decision_choice: 'deny', tool_outcome: 'blocked' }, 'none', 'blocked', 'denied'],
  [{ decision_choice: 'once', tool_outcome: 'ok' }, 'none', 'executed', 'approved'],
  [{ decision_choice: 'once', tool_outcome: 'error' }, 'none', 'blocked', 'approved'],
  [{ closed_reason: 'timeout' }, 'none', 'expired', 'expired'],
  [{ closed_reason: 'cancelled' }, 'none', 'withdrawn', 'withdrawn'],
  [{ closed_reason: 'run_ended' }, 'unknown', 'withdrawn', 'unknown'],
  [{ closed_reason: 'superseded' }, 'delivering', 'withdrawn', 'unknown'],
] as const)('derives evidence %j with %s', (patch, delivery, phase, status) => {
  expect(deriveApproval({ ...baseEvidence, ...patch }, delivery)).toEqual({ phase, status })
})
