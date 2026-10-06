import { ZodError } from 'zod'

export function formatStartupError(error: unknown): string {
  if (error instanceof ZodError) {
    const issues = error.issues.map(
      (issue) => `  ${issue.path.join('.') || 'config'}: ${issue.message}`,
    )
    return `Score server could not start:\n${issues.join('\n')}`
  }
  const reason = error instanceof Error ? error.message : String(error)
  return `Score server could not start: ${reason}`
}
