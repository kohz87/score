import { saveStageShown, useStageShown } from './stage-store.ts'

/** "Hide stage" / "Show stage": remembered on this device. */
export function StageToggle() {
  const shown = useStageShown()
  return (
    <button
      type="button"
      className="chat-stage-toggle"
      aria-expanded={shown}
      onClick={() => saveStageShown(!shown)}
    >
      {shown ? 'Hide stage' : 'Show stage'}
    </button>
  )
}
