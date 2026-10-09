import { AgentIdSchema } from '@score/contract'
import { useLoaderData } from 'react-router'
import { useState } from 'react'
import { ApiError, apiFetch } from '../../data/api.ts'
import { remoteTransport } from '../../data/session.ts'
import { passkeysSupportedHere, signInWithPasskey } from '../../data/passkeys.ts'

export async function pairBrowser() {
  const token = window.location.hash.slice(1)
  if (!token) return { status: 'missing' as const }
  window.history.replaceState(
    window.history.state,
    '',
    window.location.pathname + window.location.search,
  )
  if (remoteTransport()) return { status: 'consent' as const, token }
  return redeem(token)
}

async function redeem(token: string) {
  try {
    await apiFetch('/session/pair', {
      method: 'POST',
      body: JSON.stringify({ token: AgentIdSchema.max(256).parse(token) }),
    })
    return { status: 'paired' as const }
  } catch (error) {
    return {
      status:
        error instanceof ApiError && error.status === 401
          ? ('expired' as const)
          : ('failed' as const),
    }
  }
}

function PasskeySignIn() {
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle')
  if (!remoteTransport() || !passkeysSupportedHere()) return null
  return (
    <>
      <button
        type="button"
        disabled={state === 'busy'}
        onClick={async () => {
          setState('busy')
          try {
            await signInWithPasskey()
            // A full load starts the app with the new session cookie.
            window.location.assign('/now')
          } catch {
            setState('failed')
          }
        }}
      >
        {state === 'busy' ? 'Waiting for your device…' : 'Sign in with a passkey'}
      </button>
      {state === 'failed' && (
        <p role="alert">Passkey sign-in failed. Try again or use a pairing link.</p>
      )}
    </>
  )
}

export function PairPage() {
  const data = useLoaderData<typeof pairBrowser>()
  const [result, setResult] = useState<Awaited<ReturnType<typeof redeem>>>()
  const [pending, setPending] = useState(false)
  const status = result?.status ?? data.status
  return (
    <>
      <h1>Pair this browser</h1>
      <div className="pair-card" role="status">
        {status === 'consent' && (
          <>
            <p>
              Pairing grants this browser access to every conversation and profile in Score. It can
              send instructions, change settings, and approve commands.
            </p>
            <button
              type="button"
              disabled={pending}
              onClick={async () => {
                if (pending || data.status !== 'consent') return
                setPending(true)
                setResult(await redeem(data.token))
                setPending(false)
              }}
            >
              {pending ? 'Pairing…' : 'Pair this browser'}
            </button>
          </>
        )}
        {status === 'paired' && (
          <>
            <p>This browser is paired</p>
            {remoteTransport() && <a href="/now">Open Score</a>}
          </>
        )}
        {status !== 'paired' && <PasskeySignIn />}
        {status === 'expired' && (
          <p>
            This pairing link is invalid or expired.{' '}
            {remoteTransport()
              ? 'Type pair in the server terminal for a new link.'
              : 'Restart the server for a new link.'}
          </p>
        )}
        {status === 'missing' && (
          <p>
            Open the pairing link printed in the server terminal at startup to pair this browser.
          </p>
        )}
        {status === 'failed' && (
          <p>
            Pairing failed.{' '}
            {remoteTransport()
              ? 'Type pair in the server terminal for a new link and try again.'
              : 'Restart the server for a new link and try again.'}
          </p>
        )}
      </div>
    </>
  )
}
