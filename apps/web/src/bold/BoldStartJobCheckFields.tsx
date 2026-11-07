import type { StartJobView } from './use-start-job-view.ts'

export function CheckFields({ view }: { view: StartJobView }) {
  return (
    <div className="start-clear">
      <label className="start-field">
        <span>Command</span>
        <input
          className="field start-check-command"
          value={view.checkCommand}
          placeholder="pnpm test"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            view.setCheckCommand(event.target.value)
            view.setAuthNeeded(false)
            view.touch()
          }}
        />
      </label>
      <label className="start-field">
        <span>Folder</span>
        <input
          className="field start-check-command"
          value={view.checkFolderNow}
          placeholder="/home/you/project"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            view.setCheckFolder(event.target.value)
            view.setAuthNeeded(false)
            view.touch()
          }}
        />
      </label>
      <label className="check small">
        <input
          type="checkbox"
          checked={view.checkEachStep}
          onChange={(event) => {
            view.setCheckEachStep(event.target.checked)
            view.touch()
          }}
        />
        Also run after every step
      </label>
      <label className="start-field">
        <span>Timeout (minutes, 1 to 60)</span>
        <input
          className="field"
          type="number"
          min={1}
          max={60}
          value={view.checkMinutes}
          aria-invalid={!view.checkMinutesValid}
          onChange={(event) => {
            view.setCheckMinutes(event.target.value)
            view.touch()
          }}
        />
      </label>
      <span className="small muted">
        Score runs this command in the folder, without a shell, as your user (it runs the project’s
        own code, as when you run the tests yourself). The job can only finish as a success after it
        passes. Only you can change it.
      </span>
      {view.checkProblem && (
        <span className="small" role="alert">
          {view.checkProblem}
        </span>
      )}
    </div>
  )
}
