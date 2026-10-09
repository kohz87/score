/** `workspace://<path>` and `workspace://<agentId>/<path>` links (contract §8): they open a file in the agent's Workspace tab. */
export const WORKSPACE_SCHEME = 'workspace://'

export const isWorkspaceHref = (href: string | undefined): href is string =>
  href !== undefined && href.toLowerCase().startsWith(WORKSPACE_SCHEME)

export type WorkspaceTarget = { agentId: string; path: string; to: string }

/**
 * Resolves a workspace link. The first segment is an agent id only when it names a known agent (so
 * `workspace://src/main.ts` stays a path); otherwise the file belongs to `defaultAgent`, usually the message's author.
 * Returns null when no agent can be determined. Path safety is the server's job; this only builds the address.
 */
export function parseWorkspaceLink(
  href: string,
  defaultAgent: string | null,
  knownAgents: readonly string[],
): WorkspaceTarget | null {
  let rest = href.slice(WORKSPACE_SCHEME.length).replace(/[?#].*$/, '')
  try {
    rest = decodeURIComponent(rest)
  } catch {
    return null
  }
  rest = rest.replace(/^\/+/, '')
  let agentId = defaultAgent
  const slash = rest.indexOf('/')
  const first = slash === -1 ? rest : rest.slice(0, slash)
  if (knownAgents.includes(first)) {
    agentId = first
    rest = slash === -1 ? '' : rest.slice(slash + 1)
  }
  if (agentId === null || rest === '') return null
  return {
    agentId,
    path: rest,
    to: `/team/${encodeURIComponent(agentId)}/workspace?path=${encodeURIComponent(rest)}`,
  }
}

/** The address of a file in an agent's Workspace tab. */
export const workspaceFileLink = (agentId: string, path: string): string =>
  `/team/${encodeURIComponent(agentId)}/workspace?path=${encodeURIComponent(path)}`
