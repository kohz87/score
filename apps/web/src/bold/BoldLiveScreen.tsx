import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { botScreenFrameUrl, botScreenQuery } from '../routes/watch/watch-queries.ts'
import { ControlBar } from './take-over/ControlBar.tsx'
import { ScreenInput } from './take-over/ScreenInput.tsx'
import { TakeOverConfirm } from './take-over/TakeOverConfirm.tsx'
import { useControlSession } from './take-over/use-control-session.ts'
import './take-over/bold-take-over.css'

const STORE_KEY = 'score.botScreen.hidden'

function readHidden(): boolean {
  try {
    return window.localStorage.getItem(STORE_KEY) === '1'
  } catch {
    return false
  }
}

function writeHidden(hidden: boolean) {
  try {
    window.localStorage.setItem(STORE_KEY, hidden ? '1' : '0')
  } catch {
    /* storage can be blocked; the toggle still works for this visit */
  }
}

/** True at phone width, where Hand back moves under the screen. jsdom has no matchMedia: desktop there. */
function usePhone(): boolean {
  const query = '(max-width: 600px)'
  const [phone, setPhone] = useState(() => window.matchMedia?.(query).matches ?? false)
  useEffect(() => {
    const list = window.matchMedia?.(query)
    if (!list) return
    const onChange = () => setPhone(list.matches)
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [])
  return phone
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
  return visible
}

const hhmm = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** What happened to the last takeover on this page, as a line under the screen. */
type Ended = { how: 'handed' | 'lost'; at: number }

/** The agent's live Bot Desktop. Watching is read-only; Take over… hands this page the keyboard and pointer (3.17.0). */
export function BoldLiveScreen({
  agentId,
  agentName,
  openConfirm = false,
  onConfirmShown,
}: {
  agentId: string
  agentName: string
  /** 3.18.0: `?take=1` from the Screens page: open the confirm card once the status says it can be taken. */
  openConfirm?: boolean
  /** Called once the request has been handled (card opened, or the screen can't be taken), so the page drops `?take`. */
  onConfirmShown?: () => void
}) {
  const [hidden, setHidden] = useState(readHidden)
  const [confirming, setConfirming] = useState(false)
  const [ended, setEnded] = useState<Ended | null>(null)
  const visible = usePageVisible()
  const queryClient = useQueryClient()
  const boxRef = useRef<HTMLDivElement>(null)
  const releaseRef = useRef<(() => void) | null>(null)
  const phone = usePhone()
  const active = !hidden && visible
  const query = useQuery({
    ...botScreenQuery(agentId),
    enabled: !hidden,
    refetchInterval: (q) =>
      active
        ? q.state.data?.control
          ? 400
          : q.state.data?.state === 'running'
            ? 1000
            : 5000
        : false,
  })
  const status = query.data
  const control = status?.control
  const refetch = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['bot-screen', agentId] }),
    [queryClient, agentId],
  )
  const onLost = useCallback(() => {
    setEnded({ how: 'lost', at: Date.now() })
    void refetch()
  }, [refetch])
  // Handled once, when the first status arrives: derived during render (React's "adjust state on a change" pattern).
  const [asked, setAsked] = useState(false)
  if (openConfirm && !asked && status) {
    setAsked(true)
    if (status.state === 'running' && !status.control) setConfirming(true)
  }
  useEffect(() => {
    if (asked) onConfirmShown?.()
  }, [asked, onConfirmShown])
  const session = useControlSession(agentId, control?.takeoverId, onLost)

  // Control that ends on the server (idle, hard limit, the Hermes app) shows up as the status losing `control`.
  const hadControl = useRef(false)
  useEffect(() => {
    if (control) hadControl.current = true
    else if (hadControl.current && status) {
      hadControl.current = false
      setEnded((previous) => previous ?? { how: 'lost', at: Date.now() })
    }
  }, [control, status])

  const toggle = () => {
    const next = !hidden
    setHidden(next)
    writeHidden(next)
  }
  const handBack = async () => {
    setEnded({ how: 'handed', at: Date.now() })
    hadControl.current = false
    releaseRef.current?.()
    await session.handBack()
    await refetch()
  }

  let body = null
  if (!hidden && status) {
    if (status.state === 'running') {
      const width = status.width ?? 1280
      const height = status.height ?? 800
      const src = botScreenFrameUrl(agentId, status.frameSeq)
      body = (
        <>
          {confirming && !control && (
            <TakeOverConfirm
              agentId={agentId}
              agentName={agentName}
              onCancel={() => setConfirming(false)}
              onTaken={() => {
                setConfirming(false)
                setEnded(null)
              }}
            />
          )}
          {control ? (
            <div className="bold-to-frame" data-control="on">
              <ScreenInput
                boxRef={boxRef}
                src={src}
                alt={`${agentName}’s screen, live`}
                label={`${agentName}’s desktop: you have control`}
                width={width}
                height={height}
                push={session.push}
                releaseRef={releaseRef}
              />
            </div>
          ) : (
            <img
              className="bold-live-screen-img"
              src={src}
              alt={`${agentName}’s screen, live`}
              width={status.width}
              height={status.height}
              style={{
                aspectRatio: status.width && status.height ? `${width} / ${height}` : '16 / 10',
              }}
              draggable={false}
            />
          )}
          {control && (
            <ControlBar
              agentName={agentName}
              boxRef={boxRef}
              lastInputAt={session.lastInputAt}
              push={session.push}
            />
          )}
          {control && phone && (
            <button
              type="button"
              className="bold-to-handback"
              data-protected="inline-flex"
              onClick={() => void handBack()}
            >
              Hand back to {agentName}
            </button>
          )}
          {!control && ended?.how === 'handed' && (
            <p className="bold-to-status" role="status" data-protected="block">
              You handed control back at {hhmm(ended.at)}. {agentName} carries on.
            </p>
          )}
          {!control && ended?.how === 'lost' && (
            <p className="bold-to-status" role="status" data-protected="block" data-tone="warn">
              Control went back to {agentName} at {hhmm(ended.at)}.
            </p>
          )}
        </>
      )
    } else if (status.state === 'off') {
      body = <p className="bold-live-screen-line">The screen is off.</p>
    } else if (status.state === 'sandboxed') {
      body = (
        <p className="bold-live-screen-line">
          This screen runs inside the agent’s sandbox, where Score can’t show it.
        </p>
      )
    } else if (status.state === 'human') {
      body = (
        <div className="bold-screen-human" data-protected="block">
          <h3>Someone else took over in the Hermes app</h3>
          <p>
            Score hides the screen while they work: they may be typing a password. It shows again
            when they hand back.
          </p>
        </div>
      )
    } else {
      body = (
        <p className="bold-live-screen-line">
          Score can’t show this screen.{status.reason ? ` ${status.reason}` : ''}
        </p>
      )
    }
  } else if (!hidden && query.isError) {
    body = <p className="bold-live-screen-line">Score can’t show this screen.</p>
  }

  return (
    <section className="bold-live-screen" aria-label="Live screen">
      <div className="bold-live-screen-head">
        <h2 className="bold-live-screen-title">Live screen</h2>
        {control ? (
          <span className="bold-to-pill" data-protected="inline-flex">
            <span className="bold-to-dot" aria-hidden="true" />
            You have control
          </span>
        ) : (
          <span className="bold-screen-readonly">Read-only</span>
        )}
        {!hidden && status?.state === 'running' && !control && !confirming && (
          <button
            type="button"
            className="btn ghost bold-to-open"
            onClick={() => {
              setEnded(null)
              setConfirming(true)
            }}
          >
            Take over…
          </button>
        )}
        {control && !phone && (
          <button
            type="button"
            className="bold-to-handback"
            data-protected="inline-flex"
            onClick={() => void handBack()}
          >
            Hand back to {agentName}
          </button>
        )}
        <button
          type="button"
          className="btn ghost bold-live-screen-toggle"
          aria-expanded={!hidden}
          disabled={Boolean(control)}
          onClick={toggle}
        >
          {hidden ? 'Show' : 'Hide'}
        </button>
      </div>
      {body}
    </section>
  )
}
