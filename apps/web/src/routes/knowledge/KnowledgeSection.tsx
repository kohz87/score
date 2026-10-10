import { AgentUsage } from './AgentUsage.tsx'
import { formatBytes } from './knowledge-files.ts'
import { knowledgeFailure, useKnowledgeActions, useKnowledgeInfo } from './knowledge-queries.ts'

export function KnowledgeSection() {
  const info = useKnowledgeInfo()
  const actions = useKnowledgeActions()
  return (
    <section id="knowledge" className="settings-card" aria-labelledby="settings-knowledge">
      <div>
        <h2 id="settings-knowledge">Knowledge</h2>
        <p className="settings-muted-strong">
          The shared vault of Markdown notes and uploaded documents that your agents and you can
          read.
        </p>
      </div>
      {info.isPending && <p role="status">Loading…</p>}
      {info.isError && <p role="alert">Could not load the knowledge settings.</p>}
      {info.data && (
        <>
          <dl className="kn-settings">
            <div>
              <dt>Vault folder</dt>
              <dd>
                <code>{info.data.vault}</code>
              </dd>
            </div>
            <div>
              <dt>Notes</dt>
              <dd>{info.data.notes}</dd>
            </div>
            <div>
              <dt>Files</dt>
              <dd>
                {info.data.documents} {info.data.documents === 1 ? 'file' : 'files'},{' '}
                {formatBytes(info.data.documentBytes)} (PDF, DOCX, CSV, images and other uploads)
              </dd>
            </div>
            <div>
              <dt>Git</dt>
              <dd>
                {info.data.gitAvailable
                  ? 'Versioned with git: every save is a commit.'
                  : 'Not available. Notes still save; history and undo are off.'}
              </dd>
            </div>
          </dl>
          <label className="kn-check">
            <input
              type="checkbox"
              role="switch"
              checked={info.data.agentAccess}
              disabled={actions.setAgentAccess.isPending}
              onChange={(event) => actions.setAgentAccess.mutate(event.target.checked)}
            />
            Agents can use knowledge
          </label>
          <p className="settings-muted-strong">
            When off, agents cannot search, read or write notes. Files with names like .env or keys
            are never served, but Score cannot recognise every secret: do not store secrets in
            notes.
          </p>
          <AgentUsage />
          {actions.setAgentAccess.isError && (
            <p role="alert">
              {knowledgeFailure(actions.setAgentAccess.error, 'change this setting')}
            </p>
          )}
        </>
      )}
    </section>
  )
}
