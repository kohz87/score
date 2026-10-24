import type { AgentDetail, AgentSummary } from '@score/contract'
import { useState } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { activityOfStatus } from '../components/agent-activity.ts'
import { runtimeLabel } from '../components/runtime-label.ts'
import { TodoItems, todoProgress, useAgentTodos } from '../components/TodoList.tsx'
import { useStreamQuery } from '../data/query-client.ts'
import { agentsQuery } from '../routes/chat/queries.ts'
import { PopOutButton } from '../routes/pop/PopOutButton.tsx'
import { usePermissionAction } from '../routes/settings/rules-queries.ts'
import { useAgentDetail } from '../routes/team/team-queries.ts'
import { AgentFiles } from '../routes/team/AgentFiles.tsx'
import { AgentStylePicker } from '../routes/team/AgentStylePicker.tsx'
import { ChannelsTab } from '../routes/team/ChannelsTab.tsx'
import { CodingOverview } from '../routes/team/CodingAgent.tsx'
import { HistoryTab } from '../routes/team/HistoryTab.tsx'
import { McpAccessSection } from '../routes/team/McpAccessSection.tsx'
import { MemoryTab } from '../routes/team/MemoryTab.tsx'
import { ModelTab } from '../routes/team/ModelTab.tsx'
import { PermissionsTab } from '../routes/team/PermissionsTab.tsx'
import { PluginsTab } from '../routes/team/PluginsTab.tsx'
import { ProfileSettings } from '../routes/team/ProfileSettings.tsx'
import { RoutinesTab } from '../routes/team/RoutinesTab.tsx'
import { SkillsTab } from '../routes/team/SkillsTab.tsx'
import { ToolsTab } from '../routes/team/ToolsTab.tsx'
import { WorkspaceTab } from '../routes/team/WorkspaceTab.tsx'
import { boldAgentScreenLink } from './bold-links.ts'
import type { AgentFileName } from '../routes/team/file-queries.ts'
import { useAgentPause } from '../routes/watch/watch-queries.ts'
import '../routes/team/team.css'
import '../components/todo.css'
import { RunsOnCard } from './BoldRunsOn.tsx'
import './bold-team.css'

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
  'Appearance',
  'Todo',
  'Details',
] as const

const codingTabs = ['Overview', 'Workspace', 'History', 'Appearance'] as const

const sectionIds: Record<(typeof hermesTabs)[number], string> = {
  Overview: 'agent-overview',
  Personality: 'agent-personality',
  Model: 'agent-model',
  Skills: 'agent-skills',
  Memory: 'agent-memory',
  Tools: 'agent-tools',
  Plugins: 'agent-plugins',
  Workspace: 'agent-workspace',
  Routines: 'agent-routines',
  Channels: 'agent-channels',
  Permissions: 'agent-permissions',
  History: 'agent-history',
  Appearance: 'agent-appearance',
  Todo: 'agent-todo',
  Details: 'agent-details',
}

function statusText(agent: AgentDetail): string {
  if (agent.status === 'paused') return 'Paused'
  if (agent.status === 'working') return agent.activity ? `Working · ${agent.activity}` : 'Working'
  if (agent.status === 'waiting')
    return agent.activity ? `Needs you · ${agent.activity}` : 'Needs you'
  if (agent.status === 'offline') return 'Offline'
  if (agent.status === 'up-next') return 'Up next'
  return 'Free'
}

/** The four cards the prototype puts first: how it works, what runs it, where, and what it asks first. */
function HermesUpFront({
  agent,
  file,
  onFile,
  openSection,
}: {
  agent: AgentDetail
  file: AgentFileName
  onFile: (file: AgentFileName) => void
  openSection: (id: string) => void
}) {
  const engine = runtimeLabel(agent.runtime) ?? 'Hermes'
  const change = usePermissionAction(agent.id)
  const asks = agent.permissions.filter((permission) => permission.level === 'asks')
  return (
    <div className="grid2 bold-upfront">
      <section className="card bold-up-card" id="agent-personality" aria-label="How it works">
        <span className="lab">How {agent.id} works</span>
        <AgentFiles agent={agent} file={file} onFile={onFile} />
      </section>

      <section className="card bold-up-card" id="agent-model" aria-labelledby="agent-model-title">
        <span className="lab" id="agent-model-title">
          Runs on
        </span>
        <span className="row wrap">
          <span className="chip on">{engine}</span>
          <span className="small muted">Engine is set when the agent is added.</span>
        </span>
        <ModelTab agent={agent} />
      </section>

      <RunsOnCard agent={agent} />

      <section
        className="card bold-up-card"
        id="agent-asks"
        aria-labelledby="agent-asks-title"
        data-protected="block"
      >
        <span className="lab" id="agent-asks-title">
          Asks you first before
        </span>
        {asks.length ? (
          <ul className="bold-asks">
            {asks.map((permission) => (
              <li key={permission.id} style={{ listStyle: 'none' }}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked
                    disabled={change.isPending}
                    onChange={(event) =>
                      change.mutate({
                        id: permission.id,
                        level: event.target.checked ? 'asks' : 'allowed',
                      })
                    }
                  />
                  <span className="grow">{permission.label}</span>
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">Nothing asks you first right now.</p>
        )}
        {change.isError && <p role="alert">Couldn’t change the permission. Try again.</p>}
        <p className="small muted">
          Stricter than the team rules is fine; looser isn’t.{' '}
          <button
            type="button"
            className="link"
            onClick={() => openSection(sectionIds.Permissions)}
          >
            Change permissions
          </button>
        </p>
      </section>
    </div>
  )
}

/** The two overview facts the prototype puts in a quiet row under the agent's state. */
function OverviewFacts({ agent, agents }: { agent: AgentDetail; agents: AgentSummary[] }) {
  const manager = agents.find((item) => item.id === agent.reportsTo)
  return (
    <dl className="bold-agent-facts" aria-label="Overview facts">
      <div>
        <dt>Reports to</dt>
        <dd>
          {manager ? (
            <Link to={`/b/team/${encodeURIComponent(manager.id)}`}>{manager.name}</Link>
          ) : (
            (agent.reportsTo ?? 'No one')
          )}
        </dd>
      </div>
      <div>
        <dt>Works in</dt>
        <dd>{agent.worksIn ? <code>{agent.worksIn}</code> : 'Not set'}</dd>
      </div>
    </dl>
  )
}

function AppearanceCard({ agent }: { agent: AgentDetail }) {
  return (
    <section className="team-card" aria-labelledby="agent-appearance-heading">
      <h2 id="agent-appearance-heading">Appearance</h2>
      <p className="team-muted">
        Change {agent.name}’s look, colour and shape, or give it a pet pack.
      </p>
      <AgentStylePicker key={agent.id} agent={agent} />
    </section>
  )
}

function TodosCard({ agent }: { agent: AgentDetail }) {
  const todos = useAgentTodos(agent.id, agent.status === 'working')
  return (
    <section className="team-card" id="agent-todo" aria-labelledby="agent-todo-heading">
      <div className="team-card-heading">
        <h2 id="agent-todo-heading">Todo</h2>
        {todos.data?.todos.length ? (
          <span className="small muted">{todoProgress(todos.data.todos)}</span>
        ) : null}
      </div>
      {todos.isPending && <p role="status">Loading todo…</p>}
      {todos.isError && <p role="alert">Couldn’t load the todo list.</p>}
      {todos.isSuccess && (!todos.data || todos.data.todos.length === 0) && (
        <p className="team-muted-strong">Nothing on its todo list.</p>
      )}
      {todos.data?.todos.length ? <TodoItems todos={todos.data.todos} /> : null}
    </section>
  )
}

function MoreSections({ agent }: { agent: AgentDetail }) {
  return (
    <div className="grid3 bold-more-grid">
      <div className="bold-more-cell" id="agent-appearance">
        <AppearanceCard agent={agent} />
      </div>
      <div className="bold-more-cell" id="agent-memory">
        <MemoryTab agentId={agent.id} agentName={agent.name} />
      </div>
      <div className="bold-more-cell" id="agent-skills">
        <SkillsTab agentId={agent.id} agentName={agent.name} />
      </div>
      <div className="bold-more-cell" id="agent-tools">
        <ToolsTab agent={agent} />
        <McpAccessSection agent={agent} />
      </div>
      <div className="bold-more-cell" id="agent-plugins">
        <PluginsTab agent={agent} />
      </div>
      <div className="bold-more-cell" id="agent-routines">
        <RoutinesTab agentId={agent.id} agentName={agent.name} startCreating={false} />
      </div>
      <div className="bold-more-cell" id="agent-channels">
        <ChannelsTab agentId={agent.id} agentName={agent.name} />
      </div>
      <div className="bold-more-cell">
        <TodosCard agent={agent} />
      </div>
      <div className="bold-more-cell span2" id="agent-workspace">
        <WorkspaceTab agentId={agent.id} agentName={agent.name} initialPath={null} />
      </div>
      <div className="bold-more-cell span2" id="agent-permissions">
        <PermissionsTab agent={agent} />
      </div>
      <div className="bold-more-cell span2" id="agent-history">
        <HistoryTab agentId={agent.id} agentName={agent.name} />
      </div>
      <div className="bold-more-cell span2" id="agent-details">
        <ProfileSettings key={`${agent.id}:${agent.name}:${agent.role}`} agent={agent} />
      </div>
    </div>
  )
}

/** PLAN 11.8b: one agent on the bold shell. The four cards come first; every classic tab lives under More. */
export function BoldAgentPage() {
  const { agentId = '' } = useParams()
  return <AgentProfile key={agentId} agentId={agentId} />
}

function AgentProfile({ agentId }: { agentId: string }) {
  const detail = useAgentDetail(agentId)
  const agents = useStreamQuery(agentsQuery)
  const location = useLocation()
  const [search] = useSearchParams()
  const [file, setFile] = useState<AgentFileName>('SOUL.md')
  const [more, setMore] = useState(() => location.hash.startsWith('#agent-'))
  const client = useQueryClient()
  const pause = useAgentPause(agentId)

  if (!detail.data && detail.isPending) return <p role="status">Loading agent…</p>
  if (!detail.data && detail.isError)
    return (
      <section className="page bold-agent-missing" role="alert">
        <h1 className="big">Agent unavailable</h1>
        <p className="muted">Couldn’t load this agent. Check the address or try again.</p>
        <button type="button" className="btn" onClick={() => void detail.refetch()}>
          Try again
        </button>
      </section>
    )
  if (!detail.data) return null

  const summary = agents.data?.find((agent) => agent.id === agentId)
  // The detail endpoint has no watermark; the fenced list owns live summary fields.
  const agent: AgentDetail = {
    ...detail.data,
    ...summary,
    model:
      summary && summary.model?.id !== detail.data.model?.id
        ? summary.model && { ...summary.model, via: '', fallback: null }
        : detail.data.model,
  }
  const coding = Boolean(agent.runtime && agent.runtime !== 'hermes')
  const tabs = coding ? codingTabs : hermesTabs
  const paused = agent.status === 'paused'
  // The server can commit a pause and still answer with an error. While that error shows, the button repeats the
  // action that failed, whatever the status says now (the classic header's rule).
  const failed = pause.isError ? pause.variables : null

  function reveal(id: string) {
    setMore(true)
    window.setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ block: 'start' })
    }, 0)
  }

  function togglePause() {
    pause.mutate(failed ?? (paused ? 'resume' : 'pause'), {
      onSettled: () => {
        void client.invalidateQueries({ queryKey: ['team'] })
        void client.invalidateQueries({ queryKey: ['chat', 'agents'] })
      },
    })
  }

  return (
    <section className="page bold-agent" aria-labelledby="agent-title">
      <div className="pagehead" id="agent-overview">
        <Link className="link" to="/b/team">
          Team
        </Link>
        <span className="muted" aria-hidden>
          /
        </span>
        <AgentGlyph agent={agent} size="md" activity={activityOfStatus(agent.status)} decorative />
        <h1 className="big" id="agent-title">
          {agent.id}
        </h1>
        <span className="muted bold-agent-role">{agent.role}</span>
        <span className="row wrap bold-agent-actions">
          <Link className="btn primary" to={`/b?with=${encodeURIComponent(agent.id)}`}>
            Message
          </Link>
          {agent.lifecycle?.state !== 'removed' && (
            <button
              type="button"
              className="btn ghost"
              disabled={pause.isPending}
              onClick={togglePause}
            >
              {failed
                ? `${failed === 'pause' ? 'Pause' : 'Resume'} again`
                : paused
                  ? 'Resume'
                  : 'Pause'}{' '}
              {agent.id}
            </button>
          )}
          {agent.served && (
            <>
              <Link
                className="link bold-agent-watch"
                to={boldAgentScreenLink(agent.id)}
              >
                Look at its screen
              </Link>
              <PopOutButton
                agentId={agent.id}
                agentName={agent.name}
                className="team-popout-link bold-agent-popout"
              />
            </>
          )}
        </span>
      </div>
      <div className="row wrap bold-agent-now">
        <span className="bold-agent-state" aria-live="polite">
          {statusText(agent)}
        </span>
        {summary?.runtimeNote && <span className="small muted">{summary.runtimeNote}</span>}
      </div>
      {!coding && <OverviewFacts agent={agent} agents={agents.data ?? []} />}
      {pause.error && (
        <p role="alert" className="bold-team-error">
          Couldn’t {paused ? 'resume' : 'pause'} {agent.id}. Try again.
        </p>
      )}
      {detail.isError && (
        <p role="alert">
          Couldn’t refresh agent details.{' '}
          <button type="button" className="link" onClick={() => void detail.refetch()}>
            Try again
          </button>
        </p>
      )}

      {coding ? (
        <div className="bold-coding">
          <CodingOverview agent={agent} teamPath="/b/team" />
        </div>
      ) : (
        <HermesUpFront agent={agent} file={file} onFile={setFile} openSection={reveal} />
      )}

      <button
        type="button"
        className="btn ghost bold-more-toggle"
        aria-expanded={more}
        aria-controls="agent-more"
        onClick={() => setMore((open) => !open)}
      >
        {more
          ? 'Less'
          : `More: ${
              coding
                ? 'tools, workspace, delete'
                : 'memory, skills, tools, workspace, repeating jobs, delete'
            }`}
      </button>

      {more && (
        <div className="bold-more" id="agent-more">
          <nav className="bold-more-nav" aria-label="Agent settings sections">
            {tabs.map((tab) => (
              <a key={tab} href={`#${sectionIds[tab]}`}>
                {tab}
              </a>
            ))}
          </nav>
          {coding ? (
            <div className="grid2 bold-more-grid">
              <div className="bold-more-cell span2" id="agent-appearance">
                <AppearanceCard agent={agent} />
              </div>
              <div className="bold-more-cell" id="agent-workspace">
                <WorkspaceTab
                  agentId={agent.id}
                  agentName={agent.name}
                  initialPath={search.get('path')}
                />
              </div>
              <div className="bold-more-cell" id="agent-history">
                <HistoryTab agentId={agent.id} agentName={agent.name} />
              </div>
            </div>
          ) : (
            <MoreSections agent={agent} />
          )}
        </div>
      )}
    </section>
  )
}
