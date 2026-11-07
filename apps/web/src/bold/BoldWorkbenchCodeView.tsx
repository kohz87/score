import type { AgentSummary, WorkbenchComment, WorkbenchFile } from '@score/contract'
import { memo, type CSSProperties, type ReactNode } from 'react'
import { Link } from 'react-router'
import { agentDisplayName } from './bold-agents.ts'
import { boldAgentWorkspaceLink } from './bold-links.ts'
import { AgentName } from './BoldWorkbenchAgentName.tsx'
import { CodeText } from './BoldWorkbenchCodeText.tsx'
import { CommentCard } from './BoldWorkbenchCommentCard.tsx'
import { CursorMark } from './BoldWorkbenchCursorMark.tsx'
import { agentsOfFile, commentLine, fileAgent, nearestLine, party } from './bold-workbench-model.ts'

export const CodeView = memo(function CodeView({
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
