import {
  AgentPreviewRequestSchema,
  AgentPreviewSchema,
  type AgentPreviewRequest,
} from '@score/contract'
import { ProfileInventorySchema } from '../hermes/index.ts'
import { lifecycleOf } from './agent-lifecycle.ts'
import type { ProfileOperationsRuntime } from './profiles-runtime.ts'
import { emptyInherited, hash, stoppedSetup } from './profiles-support.ts'
import { readBaseline } from './team-rules.ts'

export const previewMethods = {
  async preview(this: ProfileOperationsRuntime, raw: AgentPreviewRequest) {
    const request = AgentPreviewRequestSchema.parse(raw)
    const name = request.kind === 'create' ? request.id : request.agentId
    const inventory = ProfileInventorySchema.parse(
      await this.port.profileInventory(
        name,
        request.kind === 'create' ? request.cloneFrom : undefined,
      ),
    )
    const lifecycle = lifecycleOf(this.db.sqlite, name)
    const pendingWork = this.pending(name)
    const blockers = [...inventory.blockers]
    // Removing an agent whose setup stopped abandons that setup first (3.2.2).
    const abandon = request.kind === 'delete' ? stoppedSetup(this.db.sqlite, name) : null
    if (name === 'default') blockers.push('The default profile is reserved.')
    if (request.kind === 'create') {
      if (inventory.exists)
        blockers.push(
          'A profile with this name already exists; Score never adopts it automatically.',
        )
    } else {
      if ((!inventory.exists && !abandon) || lifecycle?.state === 'removed')
        blockers.push('Agent not found.')
      if (
        pendingWork.activeRuns ||
        pendingWork.queuedTurns ||
        pendingWork.pendingApprovals ||
        pendingWork.assignments
      )
        blockers.push(
          'Finish active runs, queued turns, pending approvals and unfinished assignments before deleting.',
        )
    }
    if (lifecycle && !['ready', 'removed'].includes(lifecycle.state) && !abandon)
      blockers.push('An operation already holds this agent.')
    // A removed agent's name may be used again on purpose (2.0.8): its history keeps the name, so the person confirms.
    const reusesName = request.kind === 'create' && lifecycle?.state === 'removed'
    let providerLabel = request.kind === 'create' ? (request.provider ?? '') : ''
    if (request.kind === 'create' && request.provider) {
      const match = (await this.port.listModels(request.model).catch(() => [])).find(
        (item) => item.provider === request.provider && item.model === request.model,
      )
      if (match) providerLabel = match.providerLabel
    }
    const exportPath =
      request.kind === 'delete' && inventory.exists
        ? this.port.profileExportPath(name, inventory.revision)
        : null
    const data = {
      kind: request.kind,
      targetName: name,
      inherited: request.kind === 'create' ? inventory.inherited : emptyInherited,
      effects:
        request.kind === 'create'
          ? [
              request.cloneFrom
                ? `Copy ${request.cloneFrom}: configuration, personality, skills, memories, installed plugins and non-channel credentials.`
                : 'Seed the default model configuration and bundled skills; no existing conversations or jobs.',
              'No channel credentials, session history, jobs or AGENTS.md are cloned.',
              'The host gateway may discover the profile during setup. Score routes no work until all checks pass.',
              request.provider
                ? `Set the model to ${request.model} via ${providerLabel}.`
                : `Set the model to ${request.model}.`,
              'Preserve a fresh private Score key; set the chosen model and team rules; install and enable the bridge; verify authenticated gateway access and a new bridge handshake.',
              ...(reusesName
                ? [
                    `${name} was used by an agent that was removed. Its messages, runs and reports keep the name ${name} and will show next to the new agent; nothing else carries over.`,
                  ]
                : []),
            ]
          : [
              ...(abandon
                ? [
                    inventory.exists
                      ? 'The setup that stopped is abandoned first; what it made is exported and deleted like any agent.'
                      : 'The setup that stopped is abandoned first. Hermes never made the profile, so there is nothing to export or delete: Score only retires the name.',
                  ]
                : []),
              'Freeze new admissions, export privately, delete and purge profile identity, then retire routing references.',
              'The export omits credentials and is not a full undo. It may contain sensitive conversations and is kept privately until you remove it locally.',
            ],
      blockers,
      pendingWork,
      exportPath,
      ...(reusesName ? { reusesName: true } : {}),
    }
    return AgentPreviewSchema.parse({
      ...data,
      hash: hash({
        request,
        data,
        revision: inventory.revision,
        lifecycle: lifecycle?.incarnation_id ?? null,
        baseline: readBaseline(this.db.sqlite),
      }),
    })
  },
}

export type PreviewMethods = typeof previewMethods
