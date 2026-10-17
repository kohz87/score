import { NavLink, useLocation } from 'react-router'
import { destinations } from './destinations.ts'
import { needsHermesCheck, useSystemStatus } from '../routes/settings/settings-queries.ts'
import { useNeedsYou } from './use-needs-you.ts'

// Only mounted where the query client exists (the pairing page renders outside it).
export function HermesCheckDot() {
  return needsHermesCheck(useSystemStatus().data) ? (
    <span
      className="needs-you-dot"
      role="img"
      aria-label="Hermes version needs a check"
      data-protected="block"
    />
  ) : null
}

export function NeedsYouDot() {
  return useNeedsYou() ? (
    <span className="needs-you-dot" role="img" aria-label="Needs you" data-protected="block" />
  ) : null
}

export function MainNav() {
  const { pathname } = useLocation()
  return (
    <nav className="main-nav" aria-label="Main">
      {destinations.map(({ path, title }) => (
        <NavLink key={path} to={path} className="main-nav-link">
          {title}
          {path === '/now' && pathname !== '/pair' && <NeedsYouDot />}
          {path === '/settings' && pathname !== '/pair' && <HermesCheckDot />}
        </NavLink>
      ))}
    </nav>
  )
}
