import type { RunsOn, RunsOnUpdate } from '@score/contract'
import { homedir, hostname, networkInterfaces } from 'node:os'
import { HttpError } from '../../errors.ts'
import { describeRunsOn, type TerminalSettings, type ThisMachine } from '../runs-on.ts'
import { configJson } from './agent-config.ts'
import { AgentTabsWorkspace } from './agent-tabs-workspace.ts'
import { dockerAnswers } from './docker-check.ts'

/** Where one Hermes profile's runs execute: local, Docker or SSH. */
export abstract class AgentTabsRunsOn extends AgentTabsWorkspace {
  /** Whether Docker answers here; a field so tests can stand in for the daemon. */
  dockerReady: () => Promise<boolean> = () => dockerAnswers()

  async readRunsOn(agentId: string): Promise<RunsOn> {
    const { profile } = this.profile(agentId)
    return describeRunsOn(await this.terminalSettings(profile), thisMachine(), homedir())
  }
  private async terminalValue(profile: string, key: string): Promise<unknown> {
    const answer = await configJson(this.runner, this.hermesHome, profile, key)
    if (answer.state === 'unavailable')
      throw new HttpError(502, 'hermes_unavailable', 'Couldn’t read this agent from Hermes.')
    return answer.state === 'ok' ? answer.value : null
  }
  private async terminalSettings(profile: string): Promise<TerminalSettings> {
    const read = (key: string) => this.terminalValue(profile, `terminal.${key}`)
    const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null)
    // Hermes coerces "true"/"false" on write, but a hand-edited config can still hold the string.
    const flag = (value: unknown) =>
      typeof value === 'boolean'
        ? value
        : value === 'true'
          ? true
          : value === 'false'
            ? false
            : null
    const backend = text(await read('backend'))
    const name = backend?.trim().toLowerCase()
    const docker = name === 'docker'
    const ssh = name === 'ssh'
    const port = ssh ? await read('ssh_port') : null
    return {
      backend,
      dockerImage: docker ? text(await read('docker_image')) : null,
      dockerNetwork: docker ? flag(await read('docker_network')) : null,
      dockerMountCwd: docker ? flag(await read('docker_mount_cwd_to_workspace')) : null,
      dockerRunAsHostUser: docker ? flag(await read('docker_run_as_host_user')) : null,
      dockerVolumes: docker ? await read('docker_volumes') : null,
      dockerExtraArgs: docker ? await read('docker_extra_args') : null,
      dockerForwardEnv: docker ? await read('docker_forward_env') : null,
      sshHost: ssh ? text(await read('ssh_host')) : null,
      sshUser: ssh ? text(await read('ssh_user')) : null,
      sshPort: typeof port === 'number' && Number.isInteger(port) && port > 0 ? port : null,
    }
  }
  async setRunsOn(agentId: string, update: RunsOnUpdate): Promise<RunsOn> {
    const { profile } = this.profile(agentId)
    if (update.backend === 'docker' && !(await this.dockerReady()))
      throw new HttpError(
        409,
        'backend_unavailable',
        'Docker isn’t installed or running on this machine.',
      )
    // Settings first and `terminal.backend` last. Omitted Docker fields stay as they are; SSH's port and key go back
    // to Hermes's defaults when omitted, so a new host never inherits the last host's key.
    const writes: [string, string][] = []
    if (update.backend === 'docker') {
      if (update.image !== undefined) writes.push(['terminal.docker_image', update.image])
      if (update.network !== undefined)
        writes.push(['terminal.docker_network', update.network ? 'true' : 'false'])
    }
    if (update.backend === 'ssh')
      writes.push(
        ['terminal.ssh_host', update.host],
        ['terminal.ssh_user', update.user],
        ['terminal.ssh_port', String(update.port ?? 22)],
        ['terminal.ssh_key', update.keyPath ?? ''],
      )
    writes.push(['terminal.backend', update.backend])
    return this.serial(profile, async () => {
      // A failure part-way puts back what was written, so the agent keeps running exactly where it did.
      const before = new Map<string, unknown>()
      for (const [key] of writes) before.set(key, await this.terminalValue(profile, key))
      const done: string[] = []
      try {
        for (const [key, value] of writes) {
          await this.mutate(profile, ['config', 'set', key, value])
          done.push(key)
        }
      } catch (error) {
        for (const key of done.reverse()) {
          const prior = before.get(key)
          const value =
            prior === null || prior === undefined
              ? ''
              : typeof prior === 'string'
                ? prior
                : JSON.stringify(prior)
          await this.mutate(profile, ['config', 'set', key, value]).catch(() => undefined)
        }
        throw error
      }
      return describeRunsOn(await this.terminalSettings(profile), thisMachine(), homedir())
    })
  }
}

/** This machine's names and addresses, so SSH to it in any spelling reads as "not separated". */
function thisMachine(): ThisMachine {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .flatMap((item) => (item ? [item.address.replace(/%.*$/u, '')] : []))
  return { names: [hostname()], addresses }
}
