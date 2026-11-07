import type { ReportBack, Trigger, TriggerMapping } from '@score/contract'
import { ApiError } from '../../data/api.ts'
import { failure } from '../../routes/settings/TerminalCommand.tsx'
import type { TeamChoice } from '../room/team-choice.tsx'
import { pairingProblem } from '../bold-errors.ts'
import type { MappingSlot } from '../trigger-model.ts'

export type ReportMode = ReportBack['mode']

export type Wizard = {
  mode: 'create' | 'edit'
  step: 1 | 2 | 3 | 4
  triggerId: string | null
  url: string | null
  name: string
  app: string
  mapping: Record<MappingSlot, string>
  template: string
  reportMode: ReportMode
  /** null = the first team room. */
  teamRoomId: string | null
  tool: string
  args: string
  sample: unknown | null
  activeSlot: MappingSlot
  problem: string
  busy: boolean
}

export type Secret = { triggerId: string; name: string; value: string }
export const CONFIRM_TITLE: Record<'rotate' | 'delete' | 'unfinished', string> = {
  rotate: 'Rotate the secret?',
  delete: 'Delete this trigger?',
  unfinished: 'Keep this unfinished trigger?',
}

export type Confirmation = {
  /** `unfinished`: the wizard closed after its address went live but before the mapping was saved. */
  kind: 'rotate' | 'delete' | 'unfinished'
  trigger: Pick<Trigger, 'id' | 'name'>
}

export const STEPS = ['Set up', 'Test call', 'Map fields', 'Report back'] as const
const DEFAULT_ARGS = '{\n  "id": "{{source.ref}}"\n}'

function slotsOf(mapping: TriggerMapping): Record<MappingSlot, string> {
  return {
    ref: mapping.ref,
    title: mapping.title ?? '',
    link: mapping.link ?? '',
    details: mapping.details ?? '',
  }
}

export function blankWizard(): Wizard {
  return {
    mode: 'create',
    step: 1,
    triggerId: null,
    url: null,
    name: '',
    app: '',
    mapping: { ref: '', title: '', link: '', details: '' },
    template: '',
    reportMode: 'off',
    teamRoomId: null,
    tool: '',
    args: DEFAULT_ARGS,
    sample: null,
    activeSlot: 'ref',
    problem: '',
    busy: false,
  }
}

export function editWizard(trigger: Trigger): Wizard {
  return {
    mode: 'edit',
    step: 3,
    triggerId: trigger.id,
    url: trigger.url,
    name: trigger.name,
    app: trigger.app,
    mapping: slotsOf(trigger.mapping),
    template: trigger.template,
    reportMode: trigger.reportBack.mode,
    teamRoomId: trigger.teamRoomId,
    tool: trigger.reportBack.mode === 'off' ? '' : trigger.reportBack.tool,
    args: trigger.reportBack.mode === 'off' ? DEFAULT_ARGS : trigger.reportBack.args,
    sample: trigger.sample,
    activeSlot: 'ref',
    problem: '',
    busy: false,
  }
}

export function reportBackOf(wizard: Wizard): ReportBack {
  if (wizard.reportMode === 'off') return { mode: 'off' }
  return {
    mode: wizard.reportMode,
    tool: wizard.tool.trim(),
    args: wizard.args,
  }
}

/** The team a trigger starts jobs in, named only when several exist and it isn't the first. */
export function teamNameOf(trigger: Trigger, teams: TeamChoice): string | null {
  if (!teams.several || trigger.teamRoomId === null) return null
  return teams.teams.find((team) => team.id === trigger.teamRoomId)?.name ?? null
}

export function plainProblem(error: unknown, action: string): string {
  const pairing = pairingProblem(error)
  if (pairing) return pairing
  if (error instanceof ApiError) {
    if (error.code === 'bad_template')
      return 'The report-back arguments must be JSON, and every {{…}} must be inside a quoted string.'
    if (error.code === 'not_found') return 'That trigger no longer exists.'
    if (error.code === 'gone') return 'That trigger was deleted.'
  }
  return failure(error, action)
}

export function when(value: string | null): string {
  if (!value) return 'never'
  return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

export function preview(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value) ?? '—'
}
