import { Link } from 'react-router'

export function OtherAppsCard() {
  return (
    <section className="card" aria-labelledby="bold-other-apps-title">
      <h3 id="bold-other-apps-title">Other apps</h3>
      <span className="bold-connect-detail">
        Apps your agents use are <b>tool servers</b>. Apps that start jobs use{' '}
        <b>webhook triggers</b>.
      </span>
      <Link className="btn sm" to="/b/settings/tools">
        Open Tools and triggers
      </Link>
    </section>
  )
}
