import {
  ModelSettingsUpdateSchema,
  type ModelSettings,
  type ModelSettingsUpdate,
} from '@score/contract'
import { z } from 'zod'
import { HttpError } from '../../errors.ts'
import { SetModelSchema } from '../agent-tabs.ts'
import { readLocalProviderIds, readModelPair } from './agent-config.ts'
import { AgentTabsRunsOn } from './agent-tabs-runs-on.ts'
import {
  applyOps,
  deriveSettings,
  opArgs,
  planWrites,
  readRawSettings,
  undoOps,
} from './model-settings.ts'

/** Model selection and model settings for one Hermes profile. */
export abstract class AgentTabsModels extends AgentTabsRunsOn {
  async setModel(agentId: string, input: z.infer<typeof SetModelSchema>): Promise<void> {
    const req = SetModelSchema.parse(input)
    const { profile } = this.profile(agentId)
    await this.serial(profile, async () => {
      // Local providers live in each profile's own config.yaml and the picker lists the default profile's, so a
      // provider only the default profile defines would save fine and then fail to resolve on this agent's runs.
      // Only a local provider needs the check; reads are cached, so this costs no CLI call on an unchanged config.
      if (req.provider && profile !== 'default') {
        const shared = await readLocalProviderIds(this.runner, this.hermesHome, 'default')
        if (shared?.has(req.provider)) {
          const own = await readLocalProviderIds(this.runner, this.hermesHome, profile)
          // A local provider Score added lives in the default profile: copy it into this agent's profile first, so the
          // person's choice in Score is enough (2.0.3).
          if (own && !own.has(req.provider)) await this.copyProviderUnlocked(profile, req.provider)
          // An earlier copy (before 2.0.10) has the address but not the key: say so instead of a model that 401s.
          else if (
            (await this.localProviderKeyed('default', req.provider)) === true &&
            (await this.localProviderKeyed(profile, req.provider)) === false
          )
            throw new HttpError(
              409,
              'needs_key',
              'That local provider needs its API key for this agent. Add the key again in Settings › Connections: it is given to every agent.',
            )
        }
      }
      const prior = await readModelPair(this.runner, this.hermesHome, profile)
      // Without the current pair there is no way back from a half-applied change: stop before writing anything.
      if (prior === null)
        throw new HttpError(
          502,
          'hermes_unavailable',
          'Couldn’t read the agent’s current model, so nothing was changed.',
        )
      let wroteModel = false
      let wroteProvider = false
      try {
        // Each write is a Hermes process (seconds): a value that is already set is not written again.
        if (prior.model !== req.model) {
          wroteModel = true
          await this.mutate(profile, ['config', 'set', 'model.default', req.model])
        }
        if (req.provider && prior.provider !== req.provider) {
          wroteProvider = true
          await this.mutate(profile, ['config', 'set', 'model.provider', req.provider])
        }
      } catch (error) {
        // Two CLI writes are not atomic: put back what was changed, so a failure never leaves a new model paired
        // with the previous provider. Best effort; the request still reports the original failure.
        const undo = (args: string[]) => this.mutate(profile, args).catch(() => undefined)
        if (prior.scalar && prior.model && (wroteModel || wroteProvider))
          await undo(['config', 'set', 'model', prior.model])
        else {
          if (wroteModel && prior.model) await undo(['config', 'set', 'model.default', prior.model])
          if (wroteProvider) await undo(['config', 'set', 'model.provider', prior.provider ?? ''])
        }
        throw error
      }
    })
  }

  async getModelSettings(agentId: string): Promise<ModelSettings> {
    const { profile } = this.profile(agentId)
    return deriveSettings(await readRawSettings(this.runner, this.hermesHome, profile))
  }

  /** Writes only the keys that differ from what Hermes holds and answers from what was written (no re-read). */
  async updateModelSettings(agentId: string, input: ModelSettingsUpdate): Promise<ModelSettings> {
    const update = ModelSettingsUpdateSchema.parse(input)
    const { profile } = this.profile(agentId)
    return this.serial(profile, async () => {
      const raw = await readRawSettings(this.runner, this.hermesHome, profile)
      const ops = planWrites(raw, update)
      const attempted: typeof ops = []
      try {
        for (const op of ops) {
          // Counted before it runs: a write that timed out may still have landed.
          attempted.push(op)
          await this.mutate(profile, opArgs(op))
        }
      } catch (error) {
        // The CLI writes one key at a time: put back what this save already changed, so a failure leaves no
        // half-applied settings. Best effort; the request still reports the original failure. (A crash between two
        // writes can't be undone this way; the next read shows what Hermes holds.)
        for (const op of undoOps(raw, attempted))
          await this.mutate(profile, opArgs(op)).catch(() => undefined)
        throw error
      }
      return deriveSettings(applyOps(raw, ops))
    })
  }
}
