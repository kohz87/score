import { useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router'
import { agentTint } from '../../components/AgentGlyph.tsx'
import { useStreamQuery } from '../../data/query-client.ts'
import { agentsQuery, statusLabels, useAgentDetail } from './team-queries.ts'
import { AgentOverview } from './AgentOverview.tsx'
import { AgentStylePicker } from './AgentStylePicker.tsx'
import { RoutinesTab } from './RoutinesTab.tsx'
import { AgentFiles } from './AgentFiles.tsx'
import { MemoryTab } from './MemoryTab.tsx'
import { ModelTab } from './ModelTab.tsx'
import { SkillsTab } from './SkillsTab.tsx'
import { PermissionsTab } from './PermissionsTab.tsx'
import { ToolsTab } from './ToolsTab.tsx'
import { PluginsTab } from './PluginsTab.tsx'
import { ChannelsTab } from './ChannelsTab.tsx'
import { HistoryTab } from './HistoryTab.tsx'
import { WorkspaceTab } from './WorkspaceTab.tsx'
import { PopOutButton } from '../pop/PopOutButton.tsx'
import type { AgentFileName } from './file-queries.ts'
import { CodingOverview } from './CodingAgent.tsx'

// Dark text on light agent colors, white on dark ones (the design's jade band uses #08241C).
function bandInk(color: string) {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16))
  return (r * 299 + g * 587 + b * 114) / 1000 > 120 ? '#08241c' : '#ffffff'
}

const hermesTabs = [
  'Overview',
  'Personality',
  'Model',
  'Skills',
  'Memory',
  'Tools',
  'Plugins',
  'Workspace',
  'Routines',
  'Channels',
  'Permissions',
  'History',
]

// A coding agent (PLAN 7.2) has no Hermes profile behind it: no personality files, skills, memory or routines.
const codingTabs = ['Overview', 'Workspace', 'History']

export function AgentPage() {
  const { agentId = '' } = useParams()
  const location = useLocation()
  // A workspace:// link to another file of the same agent must open it, so every navigation remounts the page.
  return <AgentProfile key={`${agentId}:${location.key}`} agentId={agentId} />
}

function AgentProfile({ agentId }: { agentId: string }) {
  const detail = useAgentDetail(agentId)
  const agents = useStreamQuery(agentsQuery)
  const { pathname } = useLocation()
  const [search] = useSearchParams()
  const deepLink = pathname.endsWith('/workspace')
  const [tab, setTab] = useState(deepLink ? 'Workspace' : 'Overview')
  // The Overview's "New routine" link opens the form; clicking the tab itself shows the list.
  const [composing, setComposing] = useState(false)
  const [file, setFile] = useState<AgentFileName>('SOUL.md')
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  if (!detail.data && detail.isPending) return <p role="status">Loading agent…</p>
  if (!detail.data && detail.isError)
    return (
      <section className="team-card" role="alert">
        <h1>Agent unavailable</h1>
        <p>Could not load this agent. Check the address or try again.</p>
        <button onClick={() => void detail.refetch()}>Try again</button>
      </section>
    )
  if (!detail.data) return null
  const summary = agents.data?.find((agent) => agent.id === agentId)
  // The detail endpoint has no watermark; the fenced list owns live summary fields.
  const agent = {
    ...detail.data,
    ...summary,
    model:
      summary && summary.model?.id !== detail.data.model?.id
        ? summary.model && { ...summary.model, via: '', fallback: null }
        : detail.data.model,
  }
  const isCoding = Boolean(agent.runtime && agent.runtime !== 'hermes')
  const tabs = isCoding ? codingTabs : hermesTabs
  function navigateTabs(event: KeyboardEvent, index: number) {
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : event.key === 'ArrowRight'
            ? (index + 1) % tabs.length
            : event.key === 'ArrowLeft'
              ? (index + tabs.length - 1) % tabs.length
              : null
    if (next === null) return
    event.preventDefault()
    setComposing(false)
    setTab(tabs[next]!)
    tabRefs.current[next]?.focus()
  }
  return (
    <div
      className="team-profile"
      style={
        {
          '--team-color': agent.style.color,
          '--team-tint': agentTint(agent.style.color),
          '--team-band-ink': bandInk(agent.style.color),
        } as CSSProperties
      }
    >
      <header className="team-band">
        <AgentStylePicker key={agent.id} agent={agent} />
        <div className="team-band-copy">
          <h1>{agent.name}</h1>
          <p>{agent.tagline || agent.role}</p>
          <span className="team-status" aria-live="polite">
            {agent.lifecycle?.state === 'ready'
              ? 'Ready'
              : agent.lifecycle
                ? agent.activity
                : statusLabels[agent.status]}
            {agent.activity && ` · ${agent.activity}`}
          </span>
          {agent.lifecycle?.state !== 'removed' && agent.served && (
            <Link className="team-watch-link" to={`/now/watch/${encodeURIComponent(agent.id)}`}>
              Watch {agent.name} work
            </Link>
          )}
          {agent.lifecycle?.state !== 'removed' && agent.served && (
            <PopOutButton agentId={agent.id} agentName={agent.name} className="team-popout-link" />
          )}
        </div>
      </header>
      {detail.isError && (
        <p role="alert">
          Could not refresh agent details.{' '}
          <button onClick={() => void detail.refetch()}>Try again</button>
        </p>
      )}
      <div className="team-tabs" role="tablist" aria-label={`${agent.name}'s settings`}>
        {tabs.map((name, index) => (
          <button
            type="button"
            role="tab"
            key={name}
            id={`team-tab-${name}`}
            aria-controls="team-tab-panel"
            aria-selected={tab === name}
            tabIndex={tab === name ? 0 : -1}
            ref={(element) => {
              tabRefs.current[index] = element
            }}
            onKeyDown={(event) => navigateTabs(event, index)}
            onClick={() => {
              setComposing(false)
              setTab(name)
            }}
          >
            {name}
          </button>
        ))}
      </div>
      <div id="team-tab-panel" role="tabpanel" aria-labelledby={`team-tab-${tab}`} tabIndex={0}>
        {tab === 'Overview' && isCoding ? (
          <CodingOverview agent={agent} />
        ) : tab === 'Overview' ? (
          <>
            <AgentOverview
              agent={agent}
              agents={agents.data ?? []}
              selectTab={(name, target) => {
                // The Overview's "New routine" link opens the form; a file link picks SOUL.md or AGENTS.md.
                setComposing(name === 'Routines')
                if (target) setFile(target)
                setTab(name)
                tabRefs.current[tabs.indexOf(name)]?.focus()
              }}
            />
            {/* Settings and the danger zone come after the overview the design shows. */}
            <ProfileSettings key={`${agent.id}:${agent.name}:${agent.role}`} agent={agent} />
          </>
        ) : tab === 'Routines' ? (
          <RoutinesTab
            key={String(composing)}
            agentId={agent.id}
            agentName={agent.name}
            startCreating={composing}
          />
        ) : tab === 'Personality' ? (
          <AgentFiles agent={agent} file={file} onFile={setFile} />
        ) : tab === 'Model' ? (
          <ModelTab agent={agent} />
        ) : tab === 'Skills' ? (
          <SkillsTab agentId={agent.id} agentName={agent.name} />
        ) : tab === 'Memory' ? (
          <MemoryTab agentId={agent.id} agentName={agent.name} />
        ) : tab === 'Tools' ? (
          <ToolsTab agent={agent} />
        ) : tab === 'Plugins' ? (
          <PluginsTab agent={agent} />
        ) : tab === 'Permissions' ? (
          <PermissionsTab agent={agent} />
        ) : tab === 'Workspace' ? (
          <WorkspaceTab
            agentId={agent.id}
            agentName={agent.name}
            initialPath={deepLink ? search.get('path') : null}
          />
        ) : tab === 'Channels' ? (
          <ChannelsTab agentId={agent.id} agentName={agent.name} />
        ) : (
          <HistoryTab agentId={agent.id} agentName={agent.name} />
        )}
      </div>
    </div>
  )
}
import { ProfileSettings } from './ProfileSettings.tsx'
