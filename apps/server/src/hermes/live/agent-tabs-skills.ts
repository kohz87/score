import { HubSkillSchema, type HubSkill, type SkillItem } from '@score/contract'
import { z } from 'zod'
import { HttpError } from '../../errors.ts'
import { redactBounded } from '../../redact.ts'
import { HubQuerySchema, InstallSkillSchema, SkillNameSchema } from '../agent-tabs.ts'
import { AgentTabsChannels } from './agent-tabs-channels.ts'
import { HubRowsSchema, readDisabledSkills } from './agent-config.ts'
import { skillNames } from './profiles.ts'

const HUB_LIMIT = 20

/** Skill listing, installs, toggles and Hub search for one Hermes profile. */
export abstract class AgentTabsSkills extends AgentTabsChannels {
  async listSkills(agentId: string): Promise<SkillItem[]> {
    const { profile, home } = this.profile(agentId)
    const disabled = new Set(
      (await readDisabledSkills(this.runner, this.hermesHome, profile)) ?? [],
    )
    return skillNames(home).map((name) => ({ name, enabled: !disabled.has(name) }))
  }
  async installSkill(
    agentId: string,
    input: z.infer<typeof InstallSkillSchema>,
  ): Promise<SkillItem[]> {
    const req = InstallSkillSchema.parse(input)
    const { profile } = this.profile(agentId)
    await this.serial(profile, () =>
      this.mutate(profile, ['skills', 'install', '--yes', '--', req.name], 120000),
    )
    return this.listSkills(agentId)
  }
  async setSkillEnabled(agentId: string, name: string, enabled: boolean): Promise<SkillItem> {
    SkillNameSchema.parse(name)
    const { profile } = this.profile(agentId)
    return this.serial(profile, async () => {
      const skills = await this.listSkills(agentId)
      if (!skills.some((skill) => skill.name === name))
        throw new HttpError(404, 'not_found', 'Couldn’t find that skill.')
      const current = await readDisabledSkills(this.runner, this.hermesHome, profile)
      if (current === null)
        throw new HttpError(
          502,
          'hermes_unavailable',
          'Couldn’t read the skill settings from Hermes.',
        )
      const next = new Set(current)
      if (enabled) next.delete(name)
      else next.add(name)
      if (current.includes(name) === enabled)
        await this.mutate(profile, [
          'config',
          'set',
          'skills.disabled',
          JSON.stringify([...next].sort()),
        ])
      return { name, enabled }
    })
  }
  async searchHub(query: string): Promise<HubSkill[]> {
    const q = HubQuerySchema.parse(query).trim()
    if (!q) return []
    const result = await this.runner(
      ['skills', 'search', '--json', '--limit', String(HUB_LIMIT), '--', q],
      { timeoutMs: 30000, hermesHome: this.hermesHome, captureRead: true },
    ).catch(() => ({ exitCode: -1 }) as { exitCode: number; stdout?: string })
    if (result.exitCode !== 0 || !result.stdout)
      throw new HttpError(
        502,
        'hermes_unavailable',
        'Couldn’t search skills. Check that Hermes is reachable.',
      )
    let rows: z.infer<typeof HubRowsSchema>
    try {
      const text = result.stdout
      rows = HubRowsSchema.parse(JSON.parse(text.slice(Math.max(0, text.indexOf('[')))))
    } catch {
      throw new HttpError(
        502,
        'hermes_unavailable',
        'Couldn’t search skills. Check that Hermes is reachable.',
      )
    }
    return rows.slice(0, HUB_LIMIT).map((row) =>
      HubSkillSchema.parse({
        name: redactBounded(row.name ?? row.identifier, 200),
        identifier: row.identifier,
        source: redactBounded(row.source ?? '', 100),
        trust: redactBounded(row.trust_level ?? '', 50),
        description: redactBounded(row.description ?? '', 600),
      }),
    )
  }
}
