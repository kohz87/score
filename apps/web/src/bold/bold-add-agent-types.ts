import { PROFILE_IMPORT_MAX_BYTES, type AgentStyle, type RunsOn } from '@score/contract'
import type { WorksOnChoice } from './bold-add-agent.ts'

export type From = 'new' | 'import' | 'coding'

export type AddedAgent = {
  id: string
  name: string
  style: AgentStyle
  detail: string
  another: boolean
  runs?: RunsOutcome
}

export type RunsOutcome =
  { kind: 'saved'; runsOn: RunsOn } | { kind: 'local' } | { kind: 'failed'; reason: string }

export type Runs = {
  backend: WorksOnChoice['backend']
  sshHost: string
  sshUser: string
  sshPort: string
  sshKey: string
}

export const fromLabels: { value: From; label: string }[] = [
  { value: 'new', label: 'New agent' },
  { value: 'import', label: 'Bring in a Hermes profile' },
  { value: 'coding', label: 'A coding tool' },
]

export const worksOnLabels: { value: WorksOnChoice['backend']; label: string }[] = [
  { value: 'local', label: 'This machine as you' },
  { value: 'docker', label: 'Docker (partly separated)' },
  { value: 'ssh', label: 'Another machine over SSH' },
]

export const separatedLabels: Record<RunsOn['separated'], string> = {
  no: 'Not separated',
  partly: 'Partly separated',
  unknown: 'Separation not known',
}

export const importMax = `${Math.round(PROFILE_IMPORT_MAX_BYTES / (1024 * 1024))} MB`
