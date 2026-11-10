import type { ChatModel } from '@score/contract'
import { OWN, chatTagParts } from './model-model.ts'

/** The tag's text, "deep · max"; a part that is the agent's own reads "its own", muted. */
export function ChatTagText({ model, effort }: { model: ChatModel | null; effort: string | null }) {
  const parts = chatTagParts(model, effort)
  if (!parts) return <span className="bold-me-own">{OWN}</span>
  const part = (text: string) =>
    text === OWN ? <span className="bold-me-own">{text}</span> : <>{text}</>
  return (
    <>
      {part(parts.model)}
      <span className="bold-me-sep">{' · '}</span>
      {part(parts.effort)}
    </>
  )
}
