import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useStreamQueryRefetch } from '../../data/query-client.ts'
import { saveDraft } from '../../routes/chat/composer-model.ts'
import { boldChatLink, boldChatRefLink } from '../bold-links.ts'
import { useBoldTeamRoom } from '../bold-search-queries.ts'
import type { DirectChatProps } from './direct-chat-props.ts'
import { createDirectChat, directChatsQuery } from './direct-queries.ts'
import { Welcome } from './Welcome.tsx'

/**
 * An agent with no direct room yet. The first chat is made when the person picks a starter (its text becomes the draft),
 * or at once when "Take it aside" brought a reference, so a look that goes nowhere leaves nothing behind.
 */
export function NoRoomYet({ agent, bar }: DirectChatProps & { bar: ReactNode }) {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const refetch = useStreamQueryRefetch(useMemo(() => directChatsQuery(agent.id), [agent.id]))
  const team = useBoldTeamRoom().data
  const referenceJobId = params.get('ref')
  const referenceTitle = referenceJobId
    ? (team?.jobs.find((job) => job.id === referenceJobId)?.title ?? 'the earlier chat')
    : null
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function start(prompt?: string, title?: string) {
    setBusy(true)
    setError(null)
    try {
      const made = await createDirectChat(agent.id, title)
      if (prompt) saveDraft(made.roomId, prompt)
      await refetch()
      navigate(
        referenceJobId
          ? boldChatRefLink(agent.id, made.id, referenceJobId)
          : boldChatLink(agent.id, made.id),
        { replace: true },
      )
    } catch {
      setError('Couldn’t start a chat. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const starting = useRef(false)
  useEffect(() => {
    if (!referenceTitle || starting.current) return
    starting.current = true
    createDirectChat(agent.id, referenceTitle)
      .then((made) => {
        navigate(boldChatRefLink(agent.id, made.id, referenceJobId!), { replace: true })
      })
      .catch(() => {
        starting.current = false
        setError('Couldn’t start a chat. Try again.')
      })
  }, [agent.id, navigate, referenceJobId, referenceTitle])

  return (
    <>
      {bar}
      <div className="stream">
        <Welcome agent={agent} busy={busy} onAsk={(text) => void start(text)} />
        {error && (
          <p className="small bold-dm-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </>
  )
}
