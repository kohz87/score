import { AgentIdSchema } from '@score/contract'
import { useLoaderData } from 'react-router'
import { ApiError, apiFetch } from '../../data/api.ts'

export async function pairBrowser() {
  const token = window.location.hash.slice(1)
  if (!token) return { status: 'missing' as const }
  window.history.replaceState(
    window.history.state,
    '',
    window.location.pathname + window.location.search,
  )
  try {
    await apiFetch('/session/pair', {
      method: 'POST',
      body: JSON.stringify({ token: AgentIdSchema.parse(token) }),
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

export function PairPage() {
  const { status } = useLoaderData<typeof pairBrowser>()
  return (
    <>
      <h1>Pair this browser</h1>
      <div className="pair-card" role="status">
        {status === 'paired' && <p>This browser is paired</p>}
        {status === 'expired' && (
          <p>This pairing link is invalid or expired. Restart the server for a new link.</p>
        )}
        {status === 'missing' && (
          <p>
            Open the pairing link printed in the server terminal at startup to pair this browser.
          </p>
        )}
        {status === 'failed' && (
          <p>Pairing failed. Restart the server for a new link and try again.</p>
        )}
      </div>
    </>
  )
}
