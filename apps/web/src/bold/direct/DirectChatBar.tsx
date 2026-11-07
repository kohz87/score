import type { ReactNode } from 'react'
import type { DirectChatProps } from './direct-chat-props.ts'
import { DirectBar, DirectPhoneBar } from './DirectHeader.tsx'

/** The one-to-one header: the phone bar with a back button, or the desktop bar with Chat info. */
export function DirectChatBar({
  agent,
  phone,
  menu,
  topic,
  infoOpen,
  onToggleInfo,
  onChatInfo,
  infoRef,
  infoExpanded,
  onBackToChats,
}: Omit<DirectChatProps, 'agents'> & { menu?: ReactNode; topic?: string }) {
  return phone ? (
    <DirectPhoneBar
      agent={agent}
      topic={topic}
      menu={menu}
      infoRef={infoRef}
      infoExpanded={infoExpanded}
      onBack={onBackToChats}
      onInfo={onChatInfo}
    />
  ) : (
    <DirectBar agent={agent} menu={menu} infoOpen={infoOpen} onToggleInfo={onToggleInfo} />
  )
}
