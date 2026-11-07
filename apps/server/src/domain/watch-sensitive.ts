// Tools whose arguments or results can carry credentials. Only the tool name and status are ever kept
// (plugin and server both enforce this); the Watch view shows a plain sentence instead.
const sensitiveTool = /vault|credential|secret|passw(?:or)?d|keychain|api[_-]?key/i
export function isSensitiveTool(name: string | undefined | null): boolean {
  return typeof name === 'string' && sensitiveTool.test(name)
}

const credentialPath =
  /(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|\.netrc|\.npmrc|\.pypirc|auth\.json|credentials(?:\.[^\\/]*)?|id_(?:rsa|dsa|ecdsa|ed25519)|[^\\/]*\.(?:pem|key|p12|pfx|keystore))$/i
export function isCredentialPath(path: string): boolean {
  return credentialPath.test(path)
}

const patchPaths =
  /^(?:\*\*\* (?:Update|Add|Delete) File:|\*\*\* Move to:|---|\+\+\+)\s+(?:[ab]\/)?(\S.*?)\s*$/gm
/** True when a tool's arguments name a credential file; its result and content must then not be stored (D6). */
export function touchesCredentialFile(args: unknown): boolean {
  if (args === null || typeof args !== 'object') return false
  const { path, patch } = args as { path?: unknown; patch?: unknown }
  if (typeof path === 'string' && isCredentialPath(path)) return true
  if (typeof patch !== 'string') return false
  return [...patch.slice(0, 200_000).matchAll(patchPaths)].some((m) => isCredentialPath(m[1] ?? ''))
}
