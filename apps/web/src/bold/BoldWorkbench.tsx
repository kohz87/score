import type { AgentSummary, Job, Workbench, WorkbenchComment, WorkbenchFile } from '@score/contract'
import {
  memo,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { Link, useSearchParams } from 'react-router'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { useStreamQuery } from '../data/query-client.ts'
import { tokenize } from '../routes/chat/highlight.ts'
import { BrowserPane, EditorPane, TerminalPane } from '../routes/watch/WatchStage.tsx'
import { clock } from '../routes/watch/watch-model.ts'
import '../routes/watch/watch.css'
import { boldAgentScreenLink, boldAgentWorkspaceLink, type WorkbenchTab } from './bold-links.ts'
import { agentDisplayName } from './bold-agents.ts'
import { teamRoomQuery } from './room/room-queries.ts'
import { useBoldWorkbench } from './bold-workbench-queries.ts'
import './bold-workbench.css'

type BenchTab = Extract<WorkbenchTab, 'code' | 'screen' | 'draft'>
type JobFace = Pick<Job, 'id' | 'title' | 'state'>

const COMMENT_LABEL: Record<WorkbenchComment['kind'], string> = {
  review: 'Review note',
  approve: 'Approved',
  send_back: 'Sent back',
}

const commentLine = (comment: WorkbenchComment): number | null => comment.line

function agentsOfFile(file: WorkbenchFile): string[] {
  return [...new Set([...file.editedBy, ...file.cursors.map((cursor) => cursor.agentId)])].sort()
}

/** The agent a tab takes its colour from: the one that edited last, else the first author. */
function fileAgent(file: WorkbenchFile): string | undefined {
  const cursor = [...file.cursors].sort((a, b) => b.at.localeCompare(a.at))[0]
  return cursor?.agentId ?? agentsOfFile(file)[0]
}

function party(agents: Map<string, AgentSummary>, agentId: string | undefined) {
  return agentId ? agents.get(agentId) : undefined
}

function AgentName({ agent, id }: { agent: AgentSummary | undefined; id: string }) {
  return (
    <span className="bold-bench-agent" style={agent ? { color: agent.style.color } : undefined}>
      <AgentGlyph
        agent={agent ?? { id, name: id, style: { color: '#626670', shape: 'circle-dot' } }}
        size="xs"
        bare
        decorative
      />
      {agent ? agentDisplayName(agent) : id}
    </span>
  )
}

function TabDot({ agent }: { agent: AgentSummary | undefined }) {
  return (
    <span
      className="bold-bench-dot"
      aria-hidden="true"
      style={{ background: agent?.style.color ?? 'var(--muted)' }}
    />
  )
}

const CodeText = memo(function CodeText({
  text,
  language,
}: {
  text: string
  language: string | null
}) {
  const tokens = useMemo(() => tokenize(text, language), [language, text])
  return (
    <>
      {tokens.map((token, index) =>
        token.type === 'plain' ? (
          token.text
        ) : (
          <span key={index} className={`tok-${token.type}`}>
            {token.text}
          </span>
        ),
      )}
    </>
  )
})

function CommentCard({
  comment,
  agent,
}: {
  comment: WorkbenchComment
  agent: AgentSummary | undefined
}) {
  const status = comment.outdated
    ? `Outdated · was line ${comment.originalLine}`
    : COMMENT_LABEL[comment.kind]
  return (
    <div
      className={`bold-bench-comment${comment.outdated ? ' is-outdated' : ''}`}
      data-comment={comment.kind}
      data-outdated={comment.outdated ? 'true' : undefined}
    >
      <AgentName agent={agent} id={comment.by} />
      <span className="bold-bench-comment-text">{comment.text}</span>
      <span className="bold-bench-comment-state">{status}</span>
    </div>
  )
}

/** The nearest line Score saw, for a cursor whose own line is missing from the file snapshot. */
function nearestLine(lines: WorkbenchFile['lines'], line: number): number | null {
  let nearest: number | null = null
  for (const candidate of lines) {
    if (
      nearest === null ||
      Math.abs(candidate.n - line) < Math.abs(nearest - line) ||
      (Math.abs(candidate.n - line) === Math.abs(nearest - line) && candidate.n < nearest)
    )
      nearest = candidate.n
  }
  return nearest
}

function CursorMark({
  cursor,
  agent,
}: {
  cursor: WorkbenchFile['cursors'][number]
  agent: AgentSummary | undefined
}) {
  return (
    <span
      className="bold-bench-cursor"
      data-cursor={cursor.agentId}
      style={{ '--cursor-colour': agent?.style.color ?? 'var(--ok)' } as CSSProperties}
    >
      <span className="bold-bench-caret" aria-hidden="true" />
      <span className="bold-bench-cursor-name">
        <AgentGlyph
          agent={
            agent ?? {
              id: cursor.agentId,
              name: cursor.agentId,
              style: { color: '#5EE3BF', shape: 'triangle' },
            }
          }
          size="xs"
          bare
          decorative
        />
        {agent ? agentDisplayName(agent) : cursor.agentId}
      </span>
    </span>
  )
}

const CodeView = memo(function CodeView({
  file,
  agents,
}: {
  file: WorkbenchFile
  agents: Map<string, AgentSummary>
}) {
  const authors = agentsOfFile(file)
  const editing = fileAgent(file)
  const editingAgent = party(agents, editing)
  const known = new Set(file.lines.map((line) => line.n))
  const cursorsByLine = new Map<number, WorkbenchFile['cursors']>()
  const headerCursors: WorkbenchFile['cursors'] = []
  for (const cursor of file.cursors) {
    // A cursor can point at a line Score never saw. Show it at the nearest known line instead of dropping it; with no
    // position at all (or no lines) the file header carries it, so the person still sees who is working where.
    const line =
      cursor.line === null
        ? null
        : known.has(cursor.line)
          ? cursor.line
          : nearestLine(file.lines, cursor.line)
    if (line === null) headerCursors.push(cursor)
    else cursorsByLine.set(line, [...(cursorsByLine.get(line) ?? []), cursor])
  }
  const byLine = new Map<number, WorkbenchComment[]>()
  const earlier: WorkbenchComment[] = []
  for (const comment of file.comments) {
    // An outdated note has no current line, but its original line is still the best place to explain the change it
    // caused. Only notes whose original line is no longer in view fall back to the earlier-notes list.
    const line = commentLine(comment) ?? comment.originalLine
    if (!file.lines.some((item) => item.n === line)) earlier.push(comment)
    else byLine.set(line, [...(byLine.get(line) ?? []), comment])
  }
  let lastNumber = 0
  let key = 0
  const rows: ReactNode[] = []
  for (const line of file.lines) {
    if (line.n > lastNumber + 1)
      rows.push(
        <div key={`gap-${line.n}`} className="bold-bench-gap" aria-label="Lines Score did not see">
          <span>…</span>
        </div>,
      )
    lastNumber = line.n
    const agent = line.by ? party(agents, line.by) : undefined
    const cursors = cursorsByLine.get(line.n) ?? []
    const rowKey = `line-${line.n}-${key++}`
    rows.push(
      <div
        key={rowKey}
        className={`bold-bench-line${line.by ? ' has-author' : ''}`}
        data-line={line.n}
        data-by={line.by ?? undefined}
        title={line.by ? `Written by ${agent ? agentDisplayName(agent) : line.by}` : undefined}
        style={agent ? ({ '--line-colour': agent.style.color } as CSSProperties) : undefined}
      >
        <span className="bold-bench-no" aria-hidden="true">
          {line.n}
        </span>
        <span className="bold-bench-bar" aria-hidden="true" />
        {line.by && (
          <span className="bold-bench-sr">
            Written by {agent ? agentDisplayName(agent) : line.by}
          </span>
        )}
        <span className="bold-bench-tx">
          <CodeText text={line.text} language={file.language} />
          {cursors.map((cursor) => (
            <CursorMark
              key={cursor.agentId}
              cursor={cursor}
              agent={party(agents, cursor.agentId)}
            />
          ))}
        </span>
      </div>,
    )
    for (const comment of byLine.get(line.n) ?? [])
      rows.push(
        <div key={`comment-${comment.id}`} className="bold-bench-comment-row">
          <CommentCard comment={comment} agent={party(agents, comment.by)} />
        </div>,
      )
  }
  return (
    <section className="bold-bench-code" aria-label={`Code in ${file.path}`}>
      <header className="bold-bench-file-head">
        <div className="bold-bench-file-title">
          <span className="bold-bench-kicker">Read-only</span>
          <h2>{file.path}</h2>
          {headerCursors.length > 0 && (
            <span className="bold-bench-head-cursors">
              {headerCursors.map((cursor) => (
                <CursorMark
                  key={cursor.agentId}
                  cursor={cursor}
                  agent={party(agents, cursor.agentId)}
                />
              ))}
            </span>
          )}
        </div>
        <div className="bold-bench-authors">
          {authors.map((id) => (
            <AgentName key={id} agent={party(agents, id)} id={id} />
          ))}
        </div>
        {(editing ?? authors[0]) && (
          <Link className="btn sm" to={boldAgentWorkspaceLink(editing ?? authors[0]!)}>
            Files
          </Link>
        )}
      </header>
      {!file.exact && (
        <p className="bold-bench-inexact">Authorship may be incomplete for this file.</p>
      )}
      {editingAgent && (
        <p className="bold-bench-lede">
          The colour bar marks the agent that wrote each line. {editingAgent.name} edited last.
        </p>
      )}
      <div className="bold-bench-code-body">
        {rows.length > 0 ? (
          rows
        ) : (
          <p className="bold-bench-empty">No lines Score saw for this file.</p>
        )}
      </div>
      {earlier.length > 0 && (
        <div className="bold-bench-earlier" aria-label="Earlier notes">
          <span className="bold-bench-kicker">Earlier notes</span>
          {earlier.map((comment) => (
            <CommentCard key={comment.id} comment={comment} agent={party(agents, comment.by)} />
          ))}
        </div>
      )}
    </section>
  )
})

function LooseComments({
  comments,
  agents,
}: {
  comments: Workbench['looseComments']
  agents: Map<string, AgentSummary>
}) {
  if (comments.length === 0) return null
  return (
    <section className="bold-bench-loose" aria-label="Notes on other files">
      <span className="bold-bench-kicker">Notes on files this job did not change</span>
      {comments.map((comment) => (
        <div key={comment.id} className="bold-bench-loose-item">
          <code>{comment.path}</code>
          <CommentCard comment={comment} agent={party(agents, comment.by)} />
        </div>
      ))}
    </section>
  )
}

function ScreenView({
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
          {agent ? <AgentGlyph agent={agent} size="sm" decorative /> : null}
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

function DraftView({
  draft,
  agent,
}: {
  draft: Workbench['drafts'][number]
  agent: AgentSummary | undefined
}) {
  const target = draft.target.kind === 'document' ? 'Attached document' : 'In the workspace'
  return (
    <article className="bold-bench-draft" data-draft={draft.id}>
      <header className="bold-bench-file-head">
        <div className="bold-bench-file-title">
          <span className="bold-bench-kicker">Draft</span>
          <h2>{draft.title}</h2>
        </div>
        <AgentName agent={agent} id={draft.agentId} />
      </header>
      <span
        className="bold-bench-draft-preview"
        aria-hidden="true"
        style={{ background: agent?.style.color ?? 'var(--field)' }}
      >
        <span />
        <span />
        <span />
      </span>
      <p className="bold-bench-caption">{target}</p>
      {draft.target.kind === 'workspace' && (
        <Link className="btn sm" to={boldAgentWorkspaceLink(draft.agentId, draft.target.path)}>
          Open in the workspace
        </Link>
      )}
    </article>
  )
}

export function BoldWorkbenchView({
  job,
  workbench,
  agents,
  work,
  preferredFile = null,
  hidden = false,
  pending = false,
  failed = false,
  onRetry,
  onWorkChange,
}: {
  job: JobFace | null
  workbench: Workbench | undefined
  agents: AgentSummary[]
  work: string | null
  preferredFile?: string | null
  hidden?: boolean
  pending?: boolean
  failed?: boolean
  onRetry?: () => void
  onWorkChange?: (tab: BenchTab) => void
}) {
  const byId = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])
  const jobKey = job?.id ?? null
  // Remember the pick with its job: another job starts on its first tab without a reset effect.
  const [picked, setPicked] = useState<{ job: string | null; key: string } | null>(null)
  const pickedKey = picked?.job === jobKey ? picked.key : null
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())

  if (pending && !workbench)
    return (
      <div className="sidebody bold-workbench" hidden={hidden} data-testid="bold-workbench">
        <p className="bold-bench-state" role="status">
          Loading the Workbench…
        </p>
      </div>
    )
  if (failed && !workbench)
    return (
      <div className="sidebody bold-workbench" hidden={hidden} data-testid="bold-workbench">
        <div className="bold-bench-error" role="alert">
          <p>Couldn’t load the Workbench. Try again.</p>
          {onRetry && (
            <button type="button" className="btn sm" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      </div>
    )
  if (!job)
    return (
      <div className="sidebody bold-workbench" hidden={hidden} data-testid="bold-workbench">
        <p className="bold-bench-state">Pick a job in the room to see its Workbench.</p>
      </div>
    )
  if (!workbench)
    return (
      <div className="sidebody bold-workbench" hidden={hidden} data-testid="bold-workbench">
        <p className="bold-bench-state" role="status">
          Loading the Workbench…
        </p>
      </div>
    )

  const tabs: { key: string; tab: BenchTab; label: string; agentId?: string }[] = [
    ...workbench.files.map((file) => ({
      key: `code:${file.path}`,
      tab: 'code' as const,
      label: file.path,
      agentId: fileAgent(file),
    })),
    ...workbench.screens.map((screen) => ({
      // Keyed by the agent, not the frame: a new frame must not remount the tab and drop its focus.
      key: `screen:${screen.frame.agentId}`,
      tab: 'screen' as const,
      label: `${
        byId.get(screen.frame.agentId)
          ? agentDisplayName(byId.get(screen.frame.agentId)!)
          : screen.frame.agentId
      }’s screen`,
      agentId: screen.frame.agentId,
    })),
    ...workbench.drafts.map((draft) => ({
      key: `draft:${draft.id}`,
      tab: 'draft' as const,
      label: draft.title,
      agentId: draft.agentId,
    })),
  ]
  const group: BenchTab = work === 'screen' ? 'screen' : work === 'draft' ? 'draft' : 'code'
  const inGroup = tabs.filter((tab) => tab.tab === group)
  const preferred = preferredFile
    ? inGroup.find((tab) => tab.tab === 'code' && tab.label === preferredFile)
    : undefined
  const active = inGroup.find((tab) => tab.key === pickedKey) ?? preferred ?? inGroup[0] ?? null
  const live = workbench.screens.some((screen) => screen.live) || job.state === 'working'
  const choose = (tab: { key: string; tab: BenchTab }) => {
    setPicked({ job: jobKey, key: tab.key })
    onWorkChange?.(tab.tab)
  }
  const focusKey = active?.key ?? tabs[0]?.key ?? null
  const onTabsKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, number | 'first' | 'last'> = {
      ArrowRight: 1,
      ArrowDown: 1,
      ArrowLeft: -1,
      ArrowUp: -1,
      Home: 'first',
      End: 'last',
    }
    const move = moves[event.key]
    if (move === undefined || tabs.length === 0) return
    event.preventDefault()
    const focused = (event.target as Element).closest<HTMLElement>('[data-bench-tab]')?.dataset
      .benchTab
    const from = Math.max(
      0,
      tabs.findIndex((tab) => tab.key === (focused ?? focusKey)),
    )
    const next =
      move === 'first'
        ? 0
        : move === 'last'
          ? tabs.length - 1
          : (from + move + tabs.length) % tabs.length
    const target = tabs[next]
    if (!target) return
    choose(target)
    requestAnimationFrame(() => tabRefs.current.get(target.key)?.focus())
  }

  let body: ReactNode
  if (!active)
    body = (
      <p className="bold-bench-state">
        Nothing to show in this job’s Workbench yet. Results appear as the team edits and reviews.
      </p>
    )
  else if (active.tab === 'code') {
    const file = workbench.files.find((item) => `code:${item.path}` === active.key)!
    body = (
      <>
        <CodeView file={file} agents={byId} />
        <LooseComments comments={workbench.looseComments} agents={byId} />
      </>
    )
  } else if (active.tab === 'screen') {
    const screen = workbench.screens.find((item) => `screen:${item.frame.agentId}` === active.key)!
    body = <ScreenView screen={screen} agent={byId.get(screen.frame.agentId)} />
  } else {
    const draft = workbench.drafts.find((item) => `draft:${item.id}` === active.key)!
    body = <DraftView draft={draft} agent={byId.get(draft.agentId)} />
  }

  return (
    <div className="sidebody bold-workbench" hidden={hidden} data-testid="bold-workbench">
      <header className="bold-bench-head">
        <div>
          <span className="bold-bench-kicker">Workbench</span>
          <h2>{job.title}</h2>
        </div>
        <span className={`bold-bench-status${live ? ' is-live' : ''}`}>
          <span className={`bold-bench-dot${live ? ' livedot' : ''}`} aria-hidden="true" />
          {live ? 'Live' : 'Read-only'}
        </span>
      </header>
      {tabs.length > 0 && (
        <div
          className="bold-bench-tabs"
          role="group"
          aria-label="Workbench files and screens"
          onKeyDown={onTabsKeyDown}
        >
          {tabs.map((tab) => (
            <button
              key={tab.key}
              ref={(element) => {
                if (element) tabRefs.current.set(tab.key, element)
                else tabRefs.current.delete(tab.key)
              }}
              type="button"
              className={`chip bold-bench-tab${active?.key === tab.key ? ' on' : ''}`}
              aria-pressed={active?.key === tab.key}
              data-bench-tab={tab.key}
              tabIndex={tab.key === focusKey ? 0 : -1}
              onClick={() => choose(tab)}
            >
              <TabDot agent={party(byId, tab.agentId)} />
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
      )}
      {failed && (
        <div className="bold-bench-inline-error" role="alert">
          <span>Some of the Workbench couldn’t be refreshed.</span>
          {onRetry && (
            <button type="button" className="btn sm" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      )}
      {body}
    </div>
  )
}

export function BoldWorkbench({ agents, hidden }: { agents: AgentSummary[]; hidden: boolean }) {
  const [search, setSearchParams] = useSearchParams()
  const room = useStreamQuery(teamRoomQuery(null))
  const jobs = room.data?.jobs ?? []
  const selectedId = search.get('job')
  const named = selectedId ? jobs.find((item) => item.id === selectedId) : undefined
  const job = named ?? (selectedId ? null : jobs.find((item) => item.state !== 'closed'))
  // The room list leaves closed jobs out. Their Workbench is still readable by id, so show it with a neutral heading
  // until a `job.upserted` event supplies the real title.
  const jobFace: JobFace | null =
    job ?? (selectedId ? { id: selectedId, title: 'Closed job', state: 'closed' } : null)
  const work = search.get('work')
  const data = useBoldWorkbench(
    jobFace?.id ?? null,
    !hidden,
    job?.activeAgents ?? [],
    work === 'screen',
  )
  const choose = (tab: BenchTab) => {
    const params = new URLSearchParams(search)
    params.set('work', tab)
    params.delete('file')
    setSearchParams(params)
  }
  return (
    <BoldWorkbenchView
      job={jobFace}
      workbench={data.workbench}
      agents={agents}
      work={work}
      preferredFile={search.get('file')}
      hidden={hidden}
      pending={data.pending || (room.status === 'pending' && !selectedId)}
      failed={data.failed || room.status === 'error'}
      onRetry={data.retry}
      onWorkChange={choose}
    />
  )
}
