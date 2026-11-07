import { isInstallationId } from './installation-identity.ts'
import type { RegistryEntry, RegistryPath } from './installation-types.ts'

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseEntry(value: unknown): RegistryEntry | undefined {
  if (!isObject(value) || typeof value.createdAt !== 'string' || !Array.isArray(value.paths))
    return undefined
  const paths: RegistryPath[] = []
  for (const item of value.paths) {
    if (
      !isObject(item) ||
      typeof item.path !== 'string' ||
      !item.path ||
      (item.state !== 'current' && item.state !== 'moved') ||
      typeof item.at !== 'string'
    )
      return undefined
    paths.push({ path: item.path, state: item.state, at: item.at })
  }
  if (value.copiedFrom !== undefined && !isInstallationId(value.copiedFrom)) return undefined
  return {
    createdAt: value.createdAt,
    paths,
    ...(value.copiedFrom === undefined ? {} : { copiedFrom: value.copiedFrom as string }),
  }
}
