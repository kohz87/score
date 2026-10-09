import type { HermesPort } from '../hermes/index.ts'

/**
 * The model an agent's alias stands for (`/model fast`), or null when the name is no alias of that agent. Hermes
 * lowercases alias names, so the match ignores case. A Hermes that can't answer means "no alias": the name is then
 * used as typed, which is what happened before aliases existed.
 */
export async function resolveAlias(
  port: Pick<HermesPort, 'readModelSettings'>,
  agentId: string,
  name: string,
): Promise<{ model: string; provider: string | null } | null> {
  const key = name.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(key)) return null
  try {
    const found = (await port.readModelSettings(agentId)).aliases.find(
      (alias) => alias.name === key,
    )
    return found ? { model: found.model, provider: found.provider } : null
  } catch {
    return null
  }
}
