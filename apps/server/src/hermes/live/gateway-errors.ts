export class HermesHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly maybeApplied = true,
  ) {
    super(`Gateway request failed (${status}, ${code})`)
    this.name = 'HermesHttpError'
  }
}
