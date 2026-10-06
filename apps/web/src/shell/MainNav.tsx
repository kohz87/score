import { NavLink } from 'react-router'
import { destinations } from './destinations.ts'
import { useNeedsYou } from './use-needs-you.ts'

export function MainNav() {
  const needsYou = useNeedsYou()
  return (
    <nav className="main-nav" aria-label="Main">
      {destinations.map(({ path, title }) => (
        <NavLink key={path} to={path} className="main-nav-link">
          {title}
          {path === '/now' && needsYou && (
            <span className="needs-you-dot" role="img" aria-label="Needs you" />
          )}
        </NavLink>
      ))}
    </nav>
  )
}
