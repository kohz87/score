import type { KnowledgeAuthor, KnowledgeNote, AgentSummary } from '@score/contract'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { MarkdownEditor } from './MarkdownEditor.tsx'
import { collapseDataUris } from './knowledge-images.ts'
import { lineDiff } from './line-diff.ts'
import {
  knowledgeFailure,
  useHistory,
  useKnowledgeActions,
  useVersion,
} from './knowledge-queries.ts'
import { noteUrl, timeAgo } from './knowledge-paths.ts'

export function AuthorLabel({
  author,
  agents,
}: {
  author: KnowledgeAuthor | null
  agents: AgentSummary[]
}) {
  if (author === null) return null
  if (author === 'you') return <>You</>
  if (author === 'outside') return <>An outside edit</>
  const agent = agents.find((a) => a.id === author.agentId)
  return (
    <span className="kn-author">
      {agent && <AgentGlyph agent={agent} size="xs" decorative />}
      {agent?.name ?? author.agentId}
    </span>
  )
}

function Properties({ frontmatter }: { frontmatter: Record<string, unknown> }) {
  const entries = Object.entries(frontmatter)
  return (
    <section className="kn-panel" aria-labelledby="kn-props">
      <h3 id="kn-props">Properties</h3>
      {entries.length === 0 ? (
        <p className="kn-muted">None.</p>
      ) : (
        <dl className="kn-props">
          {entries.map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  )
}

function History({
  path,
  versioned,
  currentBody,
  agents,
  onRestored,
}: {
  path: string
  versioned: boolean
  currentBody: string
  agents: AgentSummary[]
  onRestored: () => void
}) {
  const history = useHistory(path, true)
  const actions = useKnowledgeActions()
  const [commit, setCommit] = useState<string | null>(null)
  const [showDiff, setShowDiff] = useState(false)
  const version = useVersion(path, commit)
  const items = history.data ?? []
  return (
    <section className="kn-panel" aria-labelledby="kn-history">
      <h3 id="kn-history">History</h3>
      {history.isPending && <p role="status">Loading history…</p>}
      {history.isError && <p role="alert">History is not available.</p>}
      {!versioned && (
        <p className="kn-muted" data-testid="history-not-kept">
          This note isn’t kept in history: .gitignore excludes this folder, so Score saves it
          without earlier versions.
        </p>
      )}
      {versioned && history.data && items.length === 0 && (
        <p className="kn-muted">No saved versions yet, or git is not available.</p>
      )}
      <ol className="kn-history-list">
        {items.map((item) => (
          <li key={item.commit} aria-current={item.commit === commit ? 'true' : undefined}>
            <button
              type="button"
              className="kn-link-button"
              onClick={() => {
                setCommit(item.commit === commit ? null : item.commit)
                setShowDiff(false)
              }}
            >
              {item.message || item.commit.slice(0, 7)}
            </button>
            <span className="kn-muted">
              <AuthorLabel author={item.author} agents={agents} /> · {timeAgo(item.at)}
            </span>
          </li>
        ))}
      </ol>
      {commit && (
        <div className="kn-version" role="region" aria-label={`Version ${commit.slice(0, 7)}`}>
          {version.isPending && <p role="status">Loading version…</p>}
          {version.isError && <p role="alert">Couldn’t load that version.</p>}
          {version.data && (
            <>
              <div className="kn-actions">
                <button type="button" onClick={() => setShowDiff((value) => !value)}>
                  {showDiff ? 'Show version' : 'Compare with current'}
                </button>
                <button
                  type="button"
                  className="kn-primary"
                  disabled={actions.restore.isPending}
                  onClick={() =>
                    actions.restore.mutate({ path, commit }, { onSuccess: () => onRestored() })
                  }
                >
                  Restore this version
                </button>
              </div>
              {actions.restore.isError && (
                <p role="alert">{knowledgeFailure(actions.restore.error, 'restore it')}</p>
              )}
              {showDiff ? (
                <DiffView before={version.data.body} after={currentBody} />
              ) : (
                // The saved version in the same editor, read-only: formatted, images shown, nothing to type in.
                <div className="kn-version-body">
                  <MarkdownEditor
                    key={commit}
                    initial={version.data.body}
                    label={`Version ${commit.slice(0, 7)} of ${path}`}
                    notes={() => []}
                    onChange={() => undefined}
                    readOnly
                  />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}

export function DiffView({ before, after }: { before: string; after: string }) {
  const lines = lineDiff(before, after)
  const changed = lines.some((line) => line.kind !== 'same')
  if (!changed) return <p className="kn-muted">No differences.</p>
  return (
    <pre className="kn-diff" aria-label="Differences">
      {lines.map((line, index) => (
        <div key={index} className={`kn-diff-${line.kind}`}>
          <span aria-hidden="true">
            {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}
          </span>
          <span className="kn-sr">
            {line.kind === 'added' ? 'Added: ' : line.kind === 'removed' ? 'Removed: ' : ''}
          </span>
          {collapseDataUris(line.text) || ' '}
        </div>
      ))}
    </pre>
  )
}

export function NotePanels({
  note,
  currentBody,
  agents,
  onOpenPath,
  onRestored,
  onCreate,
}: {
  note: KnowledgeNote
  currentBody: string
  agents: AgentSummary[]
  onOpenPath?: (path: string) => void
  onRestored: () => void
  onCreate: (target: string) => void
}) {
  const pathLink = (path: string, children: ReactNode) =>
    onOpenPath ? (
      <button type="button" className="kn-link-button" onClick={() => onOpenPath(path)}>
        {children}
      </button>
    ) : (
      <Link to={noteUrl(path)}>{children}</Link>
    )
  return (
    <aside className="kn-side" aria-label="Note details">
      <section className="kn-panel" aria-labelledby="kn-backlinks">
        <h3 id="kn-backlinks">Backlinks</h3>
        {note.backlinks.length === 0 ? (
          <p className="kn-muted">No other note links here.</p>
        ) : (
          <ul>
            {note.backlinks.map((link) => (
              <li key={link.path}>{pathLink(link.path, link.title || link.path)}</li>
            ))}
          </ul>
        )}
      </section>
      <section className="kn-panel" aria-labelledby="kn-outgoing">
        <h3 id="kn-outgoing">Links in this note</h3>
        {note.links.length === 0 ? (
          <p className="kn-muted">None.</p>
        ) : (
          <ul>
            {note.links.map((link) => (
              <li key={link.target}>
                {link.path ? (
                  pathLink(link.path, link.target)
                ) : (
                  <>
                    <span className="kn-missing">{link.target}</span>{' '}
                    <span className="kn-muted">missing</span>{' '}
                    <button
                      type="button"
                      className="kn-link-button"
                      onClick={() => onCreate(link.target)}
                    >
                      Create<span className="kn-sr"> {link.target}</span>
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <Properties frontmatter={note.frontmatter} />
      <History
        key={note.path}
        path={note.path}
        versioned={note.versioned}
        currentBody={currentBody}
        agents={agents}
        onRestored={onRestored}
      />
    </aside>
  )
}
