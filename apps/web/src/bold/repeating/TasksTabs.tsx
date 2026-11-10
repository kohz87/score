import { NavLink } from 'react-router'
import './bold-repeating-tabs.css'

// Tasks › Repeating (TR.2): Board · Repeating · Recipes under the Tasks header (mock-up 28-tasks-main). Links, not a
// tablist: the board's phone view has its own tablist of columns.

export function TasksTabs() {
  return (
    <nav className="bold-rj-tabs" aria-label="Tasks views">
      <NavLink to="/b/tasks" end>
        Board
      </NavLink>
      <NavLink to="/b/tasks/repeating">Repeating</NavLink>
      <NavLink to="/b/tasks/recipes">Recipes</NavLink>
    </nav>
  )
}
