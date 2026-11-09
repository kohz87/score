import { useLocation, useSearchParams } from 'react-router'

/**
 * Changes the room's URL query in place, with no new history entry: the job, the message and the command offers.
 */
export function useEditRoomParams() {
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  return (change: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(params)
    change(next)
    setParams(next, { replace: true, state: location.state })
  }
}
