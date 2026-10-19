import type { AgentSummary, KnowledgeDocument } from '@score/contract'
import { ApiError } from '../../data/api.ts'
import { CsvTable, TextPreview } from '../chat/DocumentPreview.tsx'
import { AuthorLabel } from './NotePanels.tsx'
import { fileHref, formatBytes, TYPE_LABEL } from './knowledge-files.ts'
import { knowledgeFailure, useDocument } from './knowledge-queries.ts'
import { timeAgo } from './knowledge-paths.ts'

const NO_TEXT: Record<string, string> = {
  unavailable:
    'Text is not available for this file (it may be scanned, encrypted, damaged or empty). It is stored and can be downloaded, but agents and search can’t read it.',
  none: '',
  too_large: 'Too large to preview (over 25 MB). Download it to open it.',
  truncated: 'The text was cut at 2 MB. Search and agents see the first part only.',
}

function Body({ doc }: { doc: KnowledgeDocument }) {
  const path = doc.path
  if (doc.type === 'image' && doc.textStatus === 'too_large')
    return <p className="kn-banner is-warn">{NO_TEXT.too_large}</p>
  if (doc.type === 'image')
    return (
      <img
        className="kn-doc-image"
        src={fileHref(path)}
        alt={`Preview of ${path.split('/').pop()}`}
      />
    )
  if (doc.type === 'zip')
    return (
      <section aria-labelledby="kn-zip-files">
        <h3 id="kn-zip-files">Files in this zip</h3>
        {doc.entries === null ? (
          <p className="kn-muted">The file list is not available.</p>
        ) : doc.entries.length === 0 ? (
          <p className="kn-muted">The zip is empty.</p>
        ) : (
          <ul className="kn-zip-list" aria-label="Files in the zip" tabIndex={0}>
            {doc.entries.map((entry) => (
              <li key={entry.path}>
                <span className="kn-zip-name">{entry.path}</span>
                <span className="kn-muted">{formatBytes(entry.size)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="kn-muted">
          Score stores zips for download but doesn’t search them. To add the files inside, upload
          the zip again and choose “Unzip into a folder”.
        </p>
      </section>
    )
  const note = NO_TEXT[doc.textStatus]
  return (
    <section aria-labelledby="kn-doc-text">
      <h3 id="kn-doc-text">
        {doc.type === 'pdf' || doc.type === 'docx' ? 'Extracted text' : 'Contents'}
      </h3>
      {note && <p className="kn-banner is-warn">{note}</p>}
      {doc.text !== '' &&
        (doc.type === 'csv' ? (
          <CsvTable text={doc.text} />
        ) : doc.type === 'json' ? (
          <TextPreview kind="json" text={doc.text} />
        ) : (
          <pre className="kn-doc-text" tabIndex={0}>
            {doc.text}
          </pre>
        ))}
    </section>
  )
}

export function DocumentWorkspace({
  path,
  agents,
  onMove,
  onDelete,
}: {
  path: string
  agents: AgentSummary[]
  onMove: () => void
  onDelete: () => void
}) {
  const query = useDocument(path)
  const doc = query.data
  if (query.isError && !doc) {
    const missing = query.error instanceof ApiError && query.error.status === 404
    return (
      <div className="kn-empty" role="alert">
        <h2>{missing ? 'This file doesn’t exist' : 'Couldn’t open this file'}</h2>
        <p className="kn-muted">
          {missing
            ? 'It may have been moved or deleted.'
            : knowledgeFailure(query.error, 'open the file')}
        </p>
      </div>
    )
  }
  if (!doc) return <p role="status">Opening file…</p>
  return (
    <section className="kn-doc" aria-label="File">
      <header className="kn-note-head">
        <div>
          <h2>{path.split('/').pop()}</h2>
          <p className="kn-path">{path}</p>
        </div>
        <div className="kn-actions">
          <a className="kn-button" href={fileHref(path, true)} download>
            Download
          </a>
          <button type="button" onClick={onMove}>
            Rename or move
          </button>
          <button type="button" onClick={onDelete}>
            Delete
          </button>
        </div>
      </header>
      <dl className="kn-props kn-doc-props">
        <div>
          <dt>Type</dt>
          <dd>{TYPE_LABEL[doc.type]}</dd>
        </div>
        <div>
          <dt>Size</dt>
          <dd>{formatBytes(doc.size)}</dd>
        </div>
        <div>
          <dt>Modified</dt>
          <dd>{timeAgo(doc.mtime)}</dd>
        </div>
        {doc.lastAuthor && (
          <div>
            <dt>Added by</dt>
            <dd>
              <AuthorLabel author={doc.lastAuthor} agents={agents} />
            </dd>
          </div>
        )}
        <div>
          <dt>Versions</dt>
          <dd>
            {doc.versioned
              ? 'In Knowledge history (git)'
              : 'Not versioned: stored without history (files over 10 MB, or in a folder .gitignore excludes)'}
          </dd>
        </div>
        <div>
          <dt>Search</dt>
          <dd>
            {doc.textStatus === 'indexed' || doc.textStatus === 'truncated'
              ? 'Text is indexed'
              : doc.textStatus === 'none'
                ? 'Not indexed'
                : doc.textStatus === 'too_large'
                  ? 'Not indexed (over 25 MB)'
                  : 'Text not available'}
          </dd>
        </div>
      </dl>
      <Body doc={doc} />
    </section>
  )
}
