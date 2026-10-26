import { useLocation, useNavigate } from 'react-router'
import { AttemptPage } from '../routes/attempts/AttemptPage.tsx'
import { BoldClassicPage } from './BoldClassicPage.tsx'

/** The task-attempt page inside the bold frame (3.0.0), with a Back to where the person was (the room when opened cold). */
export function BoldAttemptPage() {
  const navigate = useNavigate()
  const location = useLocation()
  return (
    <BoldClassicPage>
      <button
        type="button"
        className="bold-terminal-back"
        onClick={() => void (location.key === 'default' ? navigate('/b') : navigate(-1))}
      >
        ← Back
      </button>
      <AttemptPage />
    </BoldClassicPage>
  )
}
