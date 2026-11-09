import type { NeedsYou, WorkflowNeedsYou } from '@score/contract'
import type { ReactNode } from 'react'
import { PinCard } from './PinCards.tsx'

export function pinLabel(item: NeedsYou | WorkflowNeedsYou): string {
  switch (item.kind) {
    case 'gate':
      return 'A step waits for your approval'
    case 'inquiry':
      return 'The lead asks'
    case 'budget':
      if (item.reason === 'subagent_total') return 'Subagent total reached'
      return item.reason === 'unknown_spend' ? 'Spend not settled' : 'Budget or deadline'
    case 'paused':
      return 'Paused'
    case 'unknown':
      return 'Not confirmed as ended'
    case 'cancel_fence':
      return 'A stopped step may still run'
    case 'fence':
      return 'Starting work is blocked'
    case 'remap':
      return 'An agent was replaced'
    case 'policy_changed':
    case 'coding_agent_changed':
      return 'Agent settings changed'
    case 'coding_limit':
      return 'Coding step limit'
    case 'quota_low':
      return 'Quota is low'
    case 'retry':
    case 'refusal_limit':
    case 'coding_held_back':
    case 'node_inputs_withdrawn':
      return 'A step needs another try'
  }
}

export function pinNotice(item: NeedsYou | WorkflowNeedsYou): boolean {
  return item.kind === 'paused' || item.kind === 'fence'
}

export function RunPin({
  pinKey,
  since,
  notice,
  label,
  jobId,
  children,
}: {
  jobId: string
  pinKey: string
  since: string
  notice: boolean
  label: string
  children: ReactNode
}) {
  return (
    <PinCard
      pinKey={pinKey}
      since={since}
      notice={notice}
      label={label}
      variant="run-request"
      anchor={{ job: jobId }}
    >
      {children}
    </PinCard>
  )
}
