import { NavLink } from 'react-router'
import './tasks-tabs.css'

/**
 * The Tasks views (decision 183, mock-up 28-tasks-main): Board, Repeating and Recipes, one row under the page title.
 * Every Tasks page renders this nav, so a person moves between the three without going back to the main bar.
 */
export function TasksTabs() {
  return (
    <nav className="bold-tt" aria-label="Tasks views">
      <NavLink to="/b/tasks" end className="bold-tt-tab">
        Board
      </NavLink>
      <NavLink to="/b/tasks/repeating" className="bold-tt-tab">
        Repeating
      </NavLink>
      <NavLink to="/b/tasks/recipes" className="bold-tt-tab">
        Recipes
      </NavLink>
    </nav>
  )
}
