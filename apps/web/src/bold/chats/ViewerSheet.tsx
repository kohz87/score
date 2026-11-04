import type { AgentSummary } from '@score/contract'
import { useEffect, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router'
import { useStreamQuery } from '../../data/query-client.ts'
import { CloseIcon } from '../BoldIcons.tsx'
import { BoldWorkbench, type JobFace } from '../BoldWorkbench.tsx'
import { directChatsQuery } from '../direct/direct-queries.ts'
import { focusOpenedRow } from './FilesResults.tsx'
import { viewerClosedSearch } from './files-model.ts'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * The viewer sheet (3.25.0): the Workbench viewer (a file or draft, its comments, screens and the approval bar on an
 * agent's screen) as a wide sheet over the conversation column; a phone's is full screen. Escape and the close button
 * return focus to the row that opened it. Everything inside is the Workbench itself, so its protected surfaces stay.
 */
export function ViewerSheet({
  agents,
  phone,
  fallbackJob,
}: {
  agents: AgentSummary[]
  phone: boolean
  fallbackJob?: JobFace | undefined
}) {
  const [params, setParams] = useSearchParams()
  const sheetRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const paramsRef = useRef(params)

  const close = () => {
    setParams(viewerClosedSearch(paramsRef.current), { replace: true })
    requestAnimationFrame(() => {
      if (!focusOpenedRow()) document.getElementById('chat-info-files')?.focus()
    })
  }
  const closeRefFn = useRef(close)
  useEffect(() => {
    paramsRef.current = params
    closeRefFn.current = close
  })

  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const sheet = sheetRef.current
      if (!sheet) return
      if (event.key === 'Escape') {
        if (event.defaultPrevented) return
        const dialog =
          event.target instanceof Element
            ? event.target.closest('[role="dialog"], [aria-modal="true"]')
            : null
        // The sheet is the dialog; one inside it (or any other dialog the key came from) owns its own Escape.
        if (dialog && dialog !== sheet) return
        event.preventDefault()
        closeRefFn.current()
        return
      }
      if (event.key !== 'Tab' || !sheet.contains(document.activeElement)) return
      const items = [...sheet.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (item) => !item.closest('[hidden]'),
      )
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div
      ref={sheetRef}
      className={`bold-viewer-sheet${phone ? ' phone' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="Workbench viewer"
      data-testid="bold-viewer-sheet"
    >
      <div className="bold-viewer-bar">
        <h2 className="bold-chat-kicker">Files and results</h2>
        <button
          ref={closeRef}
          type="button"
          className="icon-btn sm"
          aria-label="Close the viewer"
          onClick={close}
        >
          <CloseIcon />
        </button>
      </div>
      <div className="bold-viewer-body">
        <BoldWorkbench agents={agents} hidden={false} fallbackJob={fallbackJob} />
      </div>
    </div>
  )
}

/** A one-to-one's viewer: its chat is a job the team room doesn't list, so its title comes from the agent's chats. */
export function DirectViewerSheet({
  agents,
  agentId,
  phone,
}: {
  agents: AgentSummary[]
  agentId: string
  phone: boolean
}) {
  const definition = useMemo(() => directChatsQuery(agentId), [agentId])
  const chats = useStreamQuery(definition).data?.chats ?? []
  const [params] = useSearchParams()
  const chat = chats.find((item) => item.id === params.get('job'))
  const fallbackJob: JobFace | undefined = chat
    ? { id: chat.id, title: chat.isDefault ? 'Main chat' : chat.title, state: chat.state }
    : undefined
  return <ViewerSheet agents={agents} phone={phone} fallbackJob={fallbackJob} />
}
