import type { AgentSummary } from '@score/contract'
import type { RefObject } from 'react'

/** What every part of a one-to-one needs from the page that mounts it. */
export type DirectChatProps = {
  agent: AgentSummary
  agents: AgentSummary[]
  phone: boolean
  infoOpen: boolean
  onToggleInfo: () => void
  onChatInfo: () => void
  infoRef?: RefObject<HTMLButtonElement | null> | undefined
  infoExpanded?: boolean | undefined
  onBackToChats: () => void
}
