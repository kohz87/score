import { z } from 'zod'
import type { ConnectResult, ConnectionsResponse, ToolServerRequest } from '@score/contract'
import { HttpError } from '../../errors.ts'
import { messagingFields } from '../messaging-fields.ts'
import { redact } from '../../redact.ts'
import { quote, READ_TIMEOUT_MS, ServersSchema } from './settings-catalog.ts'
import { messagingRows, readProfilePlatforms } from './settings-gateway.ts'
import { LiveSettingsProviders } from './settings-providers.ts'

export abstract class LiveSettingsConnections extends LiveSettingsProviders {
  /**
   * `mcp remove <id>` (2.0.3). Hermes asks "Remove server?" and has no flag to skip it: stdin is closed so it takes its
   * default (yes); the person already confirmed in Score. Its exit code doesn't say whether the server existed, so a
   * fresh read of `mcp_servers` decides.
   */
  async removeToolServer(id: string): Promise<void> {
    const name = z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/)
      .parse(id)
    await this.locks.run(this.profile ?? 'default', async () => {
      const before = ServersSchema.safeParse(
        await this.readJson(['config', 'get', '--json', 'mcp_servers'], true),
      )
      if (!before.success)
        throw new HttpError(502, 'hermes_unavailable', 'Couldn’t read the tool servers.')
      if (!Object.hasOwn(before.data, name))
        throw new HttpError(404, 'not_found', 'Couldn’t find that tool server.')
      await this.runner([...this.profileArgs(), 'mcp', 'remove', name], {
        timeoutMs: READ_TIMEOUT_MS,
        hermesHome: this.home,
        closeStdin: true,
      }).catch(() => ({ exitCode: -1 }))
      // Exit 1 = the key is unset now (the last server went); any other failure says nothing, so it is not a success.
      const after = await this.runner(
        [...this.profileArgs(), 'config', 'get', '--json', 'mcp_servers'],
        { timeoutMs: READ_TIMEOUT_MS, hermesHome: this.home, captureSettings: true, fresh: true },
      )
      let left: Record<string, unknown> | null = null
      if (after.exitCode === 0 && after.stdout !== undefined) {
        try {
          const parsed = ServersSchema.safeParse(JSON.parse(after.stdout))
          if (parsed.success) left = parsed.data
        } catch {
          /* unreadable: left stays null */
        }
      } else if (after.exitCode === 1) left = {}
      if (left === null)
        throw new HttpError(
          502,
          'hermes_unavailable',
          'Couldn’t check that the tool server is gone.',
        )
      if (Object.hasOwn(left, name))
        throw new HttpError(409, 'not_verified', 'Hermes still lists that tool server.')
    })
  }

  async listConnections(): Promise<ConnectionsResponse> {
    return { toolServers: await this.toolServers(), messaging: this.messaging() }
  }
  private async toolServers(): Promise<ConnectionsResponse['toolServers']> {
    const parsed = ServersSchema.safeParse(
      await this.readJson(['config', 'get', '--json', 'mcp_servers']),
    )
    if (!parsed.success) return []
    return Object.entries(parsed.data)
      .filter(([name]) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name))
      .map(([name, config]) => {
        // Only presence of a launch target is read; env and header values stay unread.
        const target = z
          .object({ command: z.unknown().optional(), url: z.unknown().optional() })
          .safeParse(config)
        const launchable = target.success && Boolean(target.data.command || target.data.url)
        return {
          id: name,
          label: redact(name),
          status: launchable ? ('ok' as const) : ('error' as const),
          usedBy: 'everyone' as const,
        }
      })
  }
  private messaging(): ConnectionsResponse['messaging'] {
    return messagingRows(readProfilePlatforms(this.home, this.profile ?? 'default'))
  }

  connectMessaging(platform: string): ConnectResult {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(platform))
      throw new HttpError(404, 'not_found', 'Couldn’t find that messaging platform.')
    // Token-based platforms are set up in the browser form; pairings (QR codes) still need the terminal.
    if (messagingFields(platform).browserSetup) return { next: 'form' }
    return { next: 'run_in_terminal', command: 'hermes gateway setup' }
  }
  addToolServer(req: ToolServerRequest): ConnectResult {
    const args = req.url
      ? ['--url', req.url]
      : [
          '--command',
          req.command![0]!,
          ...(req.command!.length > 1 ? ['--args'] : []),
          ...req.command!.slice(1),
        ]
    return {
      next: 'run_in_terminal',
      command: ['hermes', 'mcp', 'add', req.name, ...args].map(quote).join(' '),
    }
  }
}
