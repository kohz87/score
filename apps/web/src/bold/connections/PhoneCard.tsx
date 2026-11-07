import { Link } from 'react-router'
import { PairedBrowsersSchema } from '@score/contract'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'
import { useSecurityStatus } from '../../routes/settings/settings-queries.ts'

export function PhoneCard() {
  const browsers = useQuery({
    queryKey: ['session', 'browsers'],
    queryFn: async () => PairedBrowsersSchema.parse(await apiFetch('session/browsers')).items,
    retry: false,
  })
  const security = useSecurityStatus()
  const count = browsers.data?.length
  return (
    <section className="card bold-phone" aria-labelledby="bold-phone-title">
      <div className="grow">
        <h3 id="bold-phone-title">Your phone</h3>
        <span className="bold-connect-detail">
          Approvals reach you on any device paired with Score.
        </span>
        <span className="small muted">
          {count === undefined
            ? 'Reading paired devices…'
            : `${count} ${count === 1 ? 'device' : 'devices'} paired`}
          {security.data?.passwordSet ? ' · security password on' : ' · no security password'}
        </span>
        <Link className="link" to="/b/settings/security">
          Pair another device or manage devices
        </Link>
      </div>
      <span className="bold-phone-mark" aria-hidden="true">
        <svg
          width="46"
          height="46"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        >
          <rect x="6" y="2.5" width="12" height="19" rx="3" />
          <path d="M10 5.5h4M11 18.5h2" />
        </svg>
      </span>
    </section>
  )
}
