export interface RunContext {
  profile: string
  runId: string
  credentialGeneration: number
  getDisabled?: () => readonly string[]
}

export interface RunMetrics {
  unknownEvents: number
}

export const MAX_THINKING_CHARS = 4096
