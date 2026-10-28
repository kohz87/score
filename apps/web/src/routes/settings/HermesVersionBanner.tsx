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
    if (error.code === 'wrong_password') return 'That is not the security password.'
    if (error.code === 'too_many_attempts')
      return 'Too many wrong passwords. Wait 15 minutes and try again.'
    if (error.code === 'password_not_set')
      return 'Set a security password first (Settings › Remote access and security).'
    if (error.code === 'not_overridable')
      return 'This Hermes lacks what approvals need, so they can’t be turned on.'
    if (error.code === 'not_paired')
      return 'Pair this browser using the link in the server terminal first.'
    if (error.status === 409 && error.code === 'conflict')
      return 'Hermes changed after it was checked. Check it again.'
    if (error.status === 409)
      return 'This version changed in ways Score can’t accept, so approvals stay paused.'
  }
  return 'Couldn’t complete the check. Try again.'
}

export function HermesVersionBanner() {
  const system = useSystemStatus()
  const { check, accept, override } = useHermesCheck()
  const [result, setResult] = useState<HermesCheck | null>(null)
  const [password, setPassword] = useState('')
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
      data-protected="block"
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
          ) : result.overridable ? (
            // 3.14.4 (owner): the person may turn approvals on anyway; it is their decision, with the password.
            <form
              className="settings-form"
              aria-label="Turn approvals on anyway"
              onSubmit={(event) => {
                event.preventDefault()
                const typed = password
                setPassword('')
                override.mutate(
                  { hash: result.hash, password: typed },
                  { onSuccess: () => setResult(null) },
                )
              }}
            >
              <p role="status">
                Changed: {changedNames}. Score hasn’t been tested with these changes: approvals may
                fail or show wrong details. Hermes still has the approval functions Score uses, so
                you can turn approvals on anyway.
              </p>
              <label>
                Security password
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <button className="settings-primary" type="submit" disabled={override.isPending}>
                {override.isPending ? 'Turning on…' : 'Turn approvals on anyway'}
              </button>
            </form>
          ) : (
            <p role="status">
              Approvals stay paused. Changed: {changedNames}. Score can’t accept this version until
              Score is updated for it.
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
                setPassword('')
                accept.reset()
                override.reset()
              }}
            >
              {result.compatible ? 'Not now' : 'Stay paused'}
            </button>
          </div>
        </>
      )}
      {(check.isError || accept.isError || override.isError) && (
        <p role="alert">{failure(check.error ?? accept.error ?? override.error)}</p>
      )}
    </section>
  )
}
