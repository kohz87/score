import { useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useStreamQuery } from '../data/query-client.ts'
import { loadDraft, saveDraft } from '../routes/chat/composer-model.ts'
import { agentsQuery } from '../routes/chat/queries.ts'
import { teamRoomQuery } from './room/room-queries.ts'
import { isNotePath } from '../routes/knowledge/knowledge-files.ts'
import { BoldLibrary } from './BoldLibrary.tsx'
import './bold-knowledge.css'

// 3.19.0: Knowledge on its own page (`/b/knowledge`, `?note=<path>`). It is the Library's code in its page layout, so
// the side panel and the page share notes, files, search, editing and the live refresh. Mock-up:
// docs/design/bold/mockups/16-knowledge.dc.html.
export function BoldKnowledgePage() {
  const agents = useStreamQuery(agentsQuery).data ?? []
  const navigate = useNavigate()
  // The rooms list leaves team rooms out: the team room comes from its own query, as the rest of the shell reads it.
  const teamRoom = useStreamQuery(teamRoomQuery(null)).data?.room
  const [params, setParams] = useSearchParams()
  const note = params.get('note')
  const onOpened = useCallback(
    (path: string | null) =>
      setParams(
        (current) => {
          const next = new URLSearchParams(current)
          if (path) next.set('note', path)
          else next.delete('note')
          return next
        },
        { replace: true },
      ),
    [setParams],
  )
  // The team room's composer opens with the note named in its draft; the person reads it and sends.
  const share = teamRoom
    ? (path: string) => {
        const sentence = isNotePath(path)
          ? `Please read the Knowledge note [[${path.replace(/\.md$/iu, '')}]].`
          : `Please read the Knowledge file ${path}.`
        // A draft already in the composer stays; the sentence goes on a new line after it.
        const draft = loadDraft(teamRoom.id)
        saveDraft(
          teamRoom.id,
          draft.trim() === '' ? `${sentence} ` : `${draft.trimEnd()}\n${sentence} `,
        )
        void navigate('/b')
      }
    : undefined
  return (
    <section className="bold-knowledge" aria-label="Knowledge">
      <BoldLibrary agents={agents} openPath={note} page onOpened={onOpened} onShare={share} />
    </section>
  )
}
