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
          Markdown notes and uploaded documents that you and your agents can read.
        </p>
      </div>
      {info.isPending && <p role="status">Loading…</p>}
      {info.isError && <p role="alert">Couldn’t load the Knowledge settings.</p>}
      {info.data && (
        <>
          <dl className="kn-settings">
            <div>
              <dt>Knowledge folder</dt>
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
            Agents can use Knowledge
          </label>
          <p className="settings-muted-strong">
            When off, agents can’t search, read or write notes. Files with names like .env or keys
            are never served, but Score can’t recognise every secret, so don’t store secrets in
            notes.
          </p>
          <label className="kn-check">
            <input
              type="checkbox"
              role="switch"
              checked={info.data.memoryNotes}
              disabled={actions.setMemoryNotes.isPending}
              onChange={(event) => actions.setMemoryNotes.mutate(event.target.checked)}
            />
            Save compacted summaries as memory notes
          </label>
          <p className="settings-muted-strong">
            When you compact an agent’s context, Score saves the summary as a note under Memory in
            Knowledge, with a list for each month.
          </p>
          {actions.setMemoryNotes.isError && (
            <p role="alert">
              {knowledgeFailure(actions.setMemoryNotes.error, 'change this setting')}
            </p>
          )}
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
