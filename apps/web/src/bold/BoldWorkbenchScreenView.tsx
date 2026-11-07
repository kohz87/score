import type { AgentSummary, Workbench } from '@score/contract'
import { Link } from 'react-router'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { BrowserPane, EditorPane, TerminalPane } from '../routes/watch/WatchStage.tsx'
import { clock } from '../routes/watch/watch-model.ts'
import { agentDisplayName, agentMood } from './bold-agents.ts'
import { boldAgentScreenLink } from './bold-links.ts'

export function ScreenView({
  screen,
  agent,
}: {
  screen: Workbench['screens'][number]
  agent: AgentSummary | undefined
}) {
  const frame = screen.frame
  const name = agent ? agentDisplayName(agent) : frame.agentId
  return (
    <section className="bold-bench-screen" aria-label={`${name}’s screen`}>
      <header className="bold-bench-screen-head">
        <span className="bold-bench-screen-who">
          {agent ? <AgentGlyph agent={agent} size="sm" decorative mood={agentMood(agent)} /> : null}
          <b>{name}’s screen</b>
          {screen.live && (
            <span className="bold-bench-live">
              <span className="livedot" aria-hidden="true" />
              Live
            </span>
          )}
        </span>
        <span className="bold-bench-readonly">Read-only · you’re watching</span>
        <Link className="btn sm" to={boldAgentScreenLink(frame.agentId)}>
          Open full screen and replay
        </Link>
      </header>
      <div className="bold-bench-screen-frame">
        {frame.terminal && <TerminalPane terminal={frame.terminal} live={false} />}
        {frame.editor && <EditorPane editor={frame.editor} />}
        {frame.browser && <BrowserPane browser={frame.browser} />}
      </div>
      <p className="bold-bench-caption">
        {frame.caption} · <time dateTime={frame.at}>{clock(frame.at)}</time>
      </p>
    </section>
  )
}
