import { ConfigService, type ConfigBackend, type ConfigIndexEntry } from '../config-service.ts'

// Neutral in-memory config for fake mode and e2e. `approvals.mode` (owned by Rules and approvals) and the
// credential-shaped key are here on purpose: the service must keep them out of search and writes, as it does
// for the real index.
const INDEX: ConfigIndexEntry[] = [
  { key: 'agent.max_turns', description: 'Most tool-use turns an agent takes before it stops.' },
  { key: 'agent.verbose', description: 'Show extra detail about what the agent is doing.' },
  {
    key: 'approvals.mode',
    description: 'How Hermes asks before running risky commands: manual, smart or off.',
  },
  { key: 'display.compact', description: 'Use the compact layout for tool output.' },
  { key: 'display.language', description: 'Language for Hermes messages.' },
  { key: 'terminal.backend', description: 'Where terminal commands run: local, docker or ssh.' },
  { key: 'terminal.timeout', description: 'Seconds before a terminal command is stopped.' },
  { key: 'gateway.port', description: 'Port the messaging gateway listens on.' },
  { key: 'memory.enabled', description: 'Let agents keep long-term memory.' },
  { key: 'auxiliary.vision.api_key', description: 'Key for the vision model.' },
  { key: 'auxiliary.vision.provider', description: 'Provider for the vision model.' },
]

class FakeConfigBackend implements ConfigBackend {
  readonly file = 'config.yaml'
  private config: Record<string, unknown> = {
    agent: { max_turns: 60, verbose: false },
    approvals: { mode: 'smart' },
    display: { compact: false, language: 'en' },
    terminal: { backend: 'local', timeout: 180 },
    gateway: { port: 8642 },
    memory: { enabled: true },
    auxiliary: { vision: { api_key: 'fake-secret-do-not-show', provider: 'auto' } },
  }
  async readSection(top: string) {
    return Object.hasOwn(this.config, top)
      ? { found: true, value: structuredClone(this.config[top]) }
      : { found: false }
  }
  async write(key: string, value: string) {
    // Mirrors Hermes's coercion of CLI strings closely enough for the fake.
    let parsed: unknown = value
    if (/^(true|false)$/i.test(value)) parsed = value.toLowerCase() === 'true'
    else if (/^null$/i.test(value)) parsed = null
    else if (/^-?\d+(\.\d+)?$/.test(value)) parsed = Number(value)
    else if (/^[[{]/.test(value))
      try {
        parsed = JSON.parse(value) as unknown
      } catch {
        return false
      }
    const path = key.split('.')
    let node = this.config
    for (const name of path.slice(0, -1)) {
      const child = node[name]
      node = (child !== null && typeof child === 'object' ? child : (node[name] = {})) as Record<
        string,
        unknown
      >
    }
    node[path.at(-1)!] = parsed
    return true
  }
}

export function createFakeConfigService(): ConfigService {
  return new ConfigService(new FakeConfigBackend(), INDEX)
}
