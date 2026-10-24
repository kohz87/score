import { useNavigate } from 'react-router'
import { saveUi } from './bold-ui.ts'

export function BoldSettings() {
  const navigate = useNavigate()

  return (
    <section className="bold-page" aria-label="Settings">
      <h1>Settings</h1>
      <p>Settings come in 11.9</p>
      <button
        type="button"
        className="btn"
        onClick={() => {
          saveUi('classic')
          void navigate('/now')
        }}
      >
        Use the classic view
      </button>
    </section>
  )
}
