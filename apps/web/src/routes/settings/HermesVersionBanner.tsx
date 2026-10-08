import { useState } from 'react'
import type { HermesCheck } from '@score/contract'
import { ApiError } from '../../data/api.ts'
import { needsHermesCheck, useHermesCheck, useSystemStatus } from './settings-queries.ts'

const statusLabel = {
  same: 'Unchanged',
  added: 'Added',
  changed: 'Changed',
  removed: 'Removed',
} as const

function failure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'not_paired')
      return 'Pair this browser using the link in the server terminal first.'
    if (error.status === 409 && error.code === 'conflict')
      return 'Hermes changed after it was checked. Check it again.'
    if (error.status === 409)
      return 'This version changed in ways Score cannot accept, so approvals stay paused.'
  }
  return 'Could not complete the check. Please try again.'
}

export function HermesVersionBanner() {
  const system = useSystemStatus()
  const { check, accept } = useHermesCheck()
  const [result, setResult] = useState<HermesCheck | null>(null)
  if (!needsHermesCheck(system.data)) return null
  const version = system.data?.hermes.version
  const changedNames =
    result?.parts
      .filter((part) => !['same', 'added'].includes(part.status))
      .map((part) => part.name)
      .join(', ') || 'the Hermes build could not be identified'
  return (
    <section
      id="hermes-version"
      className="settings-card settings-banner"
      aria-labelledby="settings-hermes-version"
    >
      <h2 id="settings-hermes-version">Hermes was updated</h2>
      <p>
        Hermes was updated{version ? ` to ${version}` : ''}. Approvals in Score are paused until you
        check this version.
      </p>
      {!result && (
        <button
          className="settings-primary settings-start"
          type="button"
          disabled={check.isPending}
          onClick={() => check.mutate(undefined, { onSuccess: (checked) => setResult(checked) })}
        >
          {check.isPending ? 'Checking…' : 'Check this Hermes version'}
        </button>
      )}
      {result && (
        <>
          <table className="settings-check-table">
            <caption className="settings-muted">What changed since the last checked build</caption>
            <thead>
              <tr>
                <th scope="col">Part</th>
                <th scope="col">Result</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {result.parts.map((part) => (
                <tr key={part.name}>
                  <th scope="row">{part.name}</th>
                  <td data-status={part.status}>{statusLabel[part.status]}</td>
                  <td className="settings-detail">{part.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.compatible ? (
            <p>
              Nothing Score depends on has changed. Turning approvals back on lets Score answer
              Hermes approval requests again.
            </p>
          ) : (
            <p role="status">
              Approvals stay paused. Changed: {changedNames}. Score cannot accept this version until
              it is updated for it.
            </p>
          )}
          <div className="settings-actions">
            {result.compatible && (
              <button
                className="settings-primary"
                type="button"
                disabled={accept.isPending}
                onClick={() => accept.mutate(result.hash, { onSuccess: () => setResult(null) })}
              >
                {accept.isPending ? 'Turning on…' : 'Turn approvals back on'}
              </button>
            )}
            <button
              className="settings-pill"
              type="button"
              onClick={() => {
                setResult(null)
                accept.reset()
              }}
            >
              {result.compatible ? 'Not now' : 'Stay paused'}
            </button>
          </div>
        </>
      )}
      {(check.isError || accept.isError) && (
        <p role="alert">{failure(check.error ?? accept.error)}</p>
      )}
    </section>
  )
}
