import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { botScreenFrameUrl, botScreenQuery } from '../routes/watch/watch-queries.ts'

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

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
  return visible
}

/** The agent's live Bot Desktop: a picture, not a remote desktop (no input of any kind goes back). */
export function BoldLiveScreen({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [hidden, setHidden] = useState(readHidden)
  const visible = usePageVisible()
  const active = !hidden && visible
  const query = useQuery({
    ...botScreenQuery(agentId),
    enabled: !hidden,
    refetchInterval: (q) => (active ? (q.state.data?.state === 'running' ? 1000 : 5000) : false),
  })
  const status = query.data
  const toggle = () => {
    const next = !hidden
    setHidden(next)
    writeHidden(next)
  }

  let body = null
  if (!hidden && status) {
    if (status.state === 'running') {
      const ratio = status.width && status.height ? `${status.width} / ${status.height}` : '16 / 10'
      body = (
        <img
          className="bold-live-screen-img"
          src={botScreenFrameUrl(agentId, status.frameSeq)}
          alt={`${agentName}’s screen, live`}
          width={status.width}
          height={status.height}
          style={{ aspectRatio: ratio }}
          draggable={false}
        />
      )
    } else if (status.state === 'off') {
      body = <p className="bold-live-screen-line muted">The screen is off.</p>
    } else if (status.state === 'sandboxed') {
      body = (
        <p className="bold-live-screen-line muted">
          This screen runs inside the agent’s sandbox, where Score can’t show it.
        </p>
      )
    } else if (status.state === 'human') {
      body = (
        <p className="bold-live-screen-line bold-screen-human" data-protected="flex">
          Someone has taken over this screen. Score hides it while they work.
        </p>
      )
    } else {
      body = (
        <p className="bold-live-screen-line muted">
          Score can’t show this screen.{status.reason ? ` ${status.reason}` : ''}
        </p>
      )
    }
  } else if (!hidden && query.isError) {
    body = <p className="bold-live-screen-line muted">Score can’t show this screen.</p>
  }

  return (
    <section className="bold-live-screen" aria-label="Live screen">
      <div className="bold-live-screen-head">
        <h2 className="bold-live-screen-title">Live screen</h2>
        <span className="bold-screen-readonly">Read-only</span>
        <button
          type="button"
          className="btn ghost bold-live-screen-toggle"
          aria-expanded={!hidden}
          onClick={toggle}
        >
          {hidden ? 'Show' : 'Hide'}
        </button>
      </div>
      {body}
    </section>
  )
}
