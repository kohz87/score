import { AgentGlyph, type AgentGlyphProps } from './AgentGlyph.tsx'
import { PetAvatar } from './PetAvatar.tsx'

/**
 * Where an agent is shown big enough to wear its pet pack (a Team card, the agent page header): the pack's animated
 * avatar when it has one, with its mark as the badge, else the mark. Everywhere else uses AgentGlyph.
 */
export function AgentAvatar({
  petClassName,
  ...glyph
}: AgentGlyphProps & { petClassName?: string }) {
  const { agent, activity, decorative } = glyph
  const pack = agent.style.pack
  if (!pack) return <AgentGlyph {...glyph} />
  return (
    <PetAvatar
      agent={{ ...agent, style: { ...agent.style, pack } }}
      {...(activity ? { activity } : {})}
      {...(decorative ? { decorative } : {})}
      {...(petClassName ? { className: petClassName } : {})}
    />
  )
}
