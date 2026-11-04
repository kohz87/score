// Info's sections start folded or open by kind (3.27.1); tests that look inside every section open them first.
const KINDS = [
  'members',
  'workspace',
  'topic',
  'files',
  'topics',
  'open-jobs',
  'agent',
  'chats',
  'add',
]

export function openAllInfoSections(): void {
  for (const kind of KINDS) window.localStorage.setItem(`score.info-fold.${kind}`, 'open')
}

export function resetInfoFolds(): void {
  for (const kind of KINDS) window.localStorage.removeItem(`score.info-fold.${kind}`)
}
