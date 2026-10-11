import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'

/** Shown on the alias row and in the 409: Score sends only model and provider per request. */
export const CUSTOM_ALIAS_REASON = 'This alias uses a custom endpoint. Switch to it in Hermes.'

/**
 * The model an agent's alias stands for (`/model fast`), or null when the name is no alias of that agent. Hermes
 * lowercases alias names, so the match ignores case. A Hermes that can't answer means "no alias": the name is then
 * used as typed, which is what happened before aliases existed. An alias with its own endpoint or key can't be
 * reproduced per request (Hermes's Runs API resolves only model and provider), so using one is refused with a 409.
 */
export async function resolveAlias(
  port: Pick<HermesPort, 'readModelSettings'>,
  agentId: string,
  name: string,
): Promise<{ model: string; provider: string | null } | null> {
  const key = name.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(key)) return null
  let found
  try {
    found = (await port.readModelSettings(agentId)).aliases.find((alias) => alias.name === key)
  } catch {
    return null
  }
  if (found && !found.editable) throw new HttpError(409, 'conflict', CUSTOM_ALIAS_REASON)
  return found ? { model: found.model, provider: found.provider } : null
}
