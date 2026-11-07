import { Link } from 'react-router'
import { ApiError } from '../../data/api.ts'

export function problem(error: unknown, action: string) {
  if (error instanceof ApiError) {
    if (error.code === 'wrong_password') return <>That is not the security password.</>
    if (error.code === 'too_many_attempts')
      return <>Too many wrong passwords. Wait 15 minutes and try again.</>
    if (error.code === 'password_not_set')
      return (
        <>
          Set a security password first in{' '}
          <Link className="link" to="/b/settings/security">
            Settings › Remote access and security
          </Link>
          .
        </>
      )
    if (error.code === 'update_running') return <>An update is already running.</>
    // The server's own words for these (review).
    if (error.code === 'disk_full' || error.code === 'check_running') return <>{error.message}</>
    if (error.code === 'hermes_unavailable')
      return <>Hermes didn’t answer the check. Is the hermes command installed and working?</>
    if (error.status === 409 && error.code === 'conflict')
      return <>Hermes changed again since this update. Run Check for Hermes updates.</>
    if (error.code === 'not_paired')
      return <>Pair this browser using the link in the server terminal first.</>
  }
  return <>Couldn’t {action}. Try again.</>
}
