import { NavLink, useLocation } from 'react-router'
import { needsHermesCheck, useSystemStatus } from '../routes/settings/settings-queries.ts'
import { needsYouPath, useMenu } from '../themes/layout.ts'
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
  const menu = useMenu()
  const dotOn = needsYouPath(menu)
  return (
    <nav className="main-nav" aria-label="Main">
      {menu.map(({ path, title }) => (
        <NavLink key={path} to={path} className="main-nav-link">
          {title}
          {path === dotOn && pathname !== '/pair' && <NeedsYouDot />}
          {path === '/settings' && pathname !== '/pair' && <HermesCheckDot />}
        </NavLink>
      ))}
    </nav>
  )
}
