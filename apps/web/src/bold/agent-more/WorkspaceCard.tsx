import { Link } from 'react-router'
import type { AgentDetail } from '@score/contract'
import { ApiError } from '../../data/api.ts'
import {
  useGitStatus,
  useTree,
  useWorkspace,
  WorkspaceRootContext,
} from '../../routes/team/workspace-queries.ts'
import { Fail, Loading, MoreCard } from './MoreCard.tsx'

function RecentFiles({
  agentId,
  onOpen,
}: {
  agentId: string
  onOpen: (path: string | null) => void
}) {
  const git = useGitStatus(agentId)
  const tree = useTree(agentId, '')
  const files = (tree.data ?? [])
    .filter((entry) => entry.kind === 'file' && !entry.hidden)
    .sort((one, other) => other.mtime.localeCompare(one.mtime))
    .slice(0, 4)
  return (
    <>
      {git.data && (
        <span className="small muted">
          Branch {git.data.branch} · {git.data.changed} file{git.data.changed === 1 ? '' : 's'}{' '}
          changed
        </span>
      )}
      {tree.isPending && <Loading what="files" />}
      {tree.isError && <Fail>Couldn’t list the files.</Fail>}
      {tree.isSuccess && !files.length && <p className="small muted">No files here yet.</p>}
      {files.map((file) => (
        <button
          type="button"
          className="listrow bold-mc-file"
          key={file.name}
          onClick={() => onOpen(file.name)}
        >
          <span className="grow">{file.name}</span>
          <span className="small muted">open</span>
        </button>
      ))}
      <button type="button" className="link bold-mc-start" onClick={() => onOpen(null)}>
        Browse all files
      </button>
    </>
  )
}

/** Where it works (read-only), the newest files, and the way into the full file browser (the Files panel under the cards). */
export function WorkspaceCard({
  agent,
  onOpen,
}: {
  agent: AgentDetail
  onOpen: (path: string | null) => void
}) {
  const info = useWorkspace(agent.id)
  const root = info.data?.root ?? null
  const usable = info.data?.available === true && root !== null

  return (
    <MoreCard id="agent-workspace" title="Workspace">
      {info.isPending && <Loading what="workspace" />}
      {info.isError && (
        <Fail>
          {info.error instanceof ApiError && info.error.code === 'not_paired'
            ? 'Pair this browser using the link in the server terminal to see the workspace.'
            : 'Couldn’t load the workspace.'}
        </Fail>
      )}
      {info.isSuccess && (
        <span className="small muted" role="status">
          {usable ? <code>{root}</code> : (info.data.reason ?? 'The workspace is unavailable.')}
        </span>
      )}
      {usable && (
        <WorkspaceRootContext.Provider value={root}>
          <RecentFiles agentId={agent.id} onOpen={onOpen} />
        </WorkspaceRootContext.Provider>
      )}
      {/* 3.20.0: the folder is no longer changed here; workspaces are shared and set in Settings. */}
      <Link className="link bold-mc-start" to="/b/settings/workspaces">
        Workspaces are set in Settings › Workspaces
      </Link>
    </MoreCard>
  )
}
