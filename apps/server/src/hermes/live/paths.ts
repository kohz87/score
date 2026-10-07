import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

export const ProfileNameSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)

export function resolveHermesHome(configured?: string): string {
  return configured ?? join(homedir(), '.hermes')
}

export function hermesPaths(hermesHome: string) {
  const home = z.string().min(1).parse(hermesHome)
  return {
    kanbanDb: join(home, 'kanban.db'),
    stateDb(profile: string): string {
      const name = ProfileNameSchema.parse(profile)
      return name === 'default' ? join(home, 'state.db') : join(home, 'profiles', name, 'state.db')
    },
  }
}
