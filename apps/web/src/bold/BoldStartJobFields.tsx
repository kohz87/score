import type { KeyboardEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { sizeText } from './start-job-copy.ts'
import type { StartJobView } from './use-start-job-view.ts'

export function StartJobChatPick({ view }: { view: StartJobView }) {
  return (
    <div>
      <label htmlFor="start-chat" className="lab">
        Start it in
      </label>
      <select
        id="start-chat"
        className="field"
        value={view.chatPick ?? ''}
        onChange={(event) => {
          view.setChatPick(event.target.value)
          view.touch()
        }}
      >
        <option value="">Choose a chat…</option>
        {view.chatChoices.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
    </div>
  )
}

export function StartJobWhat({ view }: { view: StartJobView }) {
  return (
    <div>
      <label htmlFor="start-what" className="lab">
        What should the team do?
      </label>
      <textarea
        id="start-what"
        className="field start-what"
        rows={Math.min(
          14,
          Math.max(2, view.what.split('\n').length + Math.floor(view.what.length / 90)),
        )}
        aria-describedby="start-what-size"
        aria-invalid={view.whatProblem !== null}
        value={view.what}
        onChange={(event) => {
          view.setWhat(event.target.value)
          view.touch()
        }}
        autoFocus
      />
      {view.whatLimit.size > view.whatLimit.max * 0.75 && (
        <span
          id="start-what-size"
          className="small muted start-what-size"
          role={view.whatProblem ? 'alert' : undefined}
        >
          {view.whatProblem ??
            `${sizeText(view.whatLimit.size, view.whatLimit.unit)} of ${sizeText(view.whatLimit.max, view.whatLimit.unit)}`}
        </span>
      )}
    </div>
  )
}

export function StartJobRecipe({ view }: { view: StartJobView }) {
  const navigate = useNavigate()
  return (
    <div>
      <span className="lab">Recipe</span>
      {view.nameNotice && (
        <p className="small muted" role="status">
          {view.nameNotice}
        </p>
      )}
      {view.wantedArchived && (
        <p className="small muted" role="status">
          That recipe is archived. Unarchive it in Recipes to use it.
        </p>
      )}
      <div className="row wrap" role="radiogroup" aria-label="Recipe">
        {view.recipeOptions.map((option) => {
          const chosen =
            option.choice.kind === 'workflow'
              ? view.isSavedRecipe &&
                view.recipe.kind === 'workflow' &&
                view.recipe.id === option.choice.id
              : view.recipe.kind === option.choice.kind
          return (
            <RecipeChip
              key={option.key}
              chosen={chosen}
              label={option.label}
              tabIndex={chosen ? 0 : -1}
              buttonRef={(element) => view.setRecipeButton(option.key, element)}
              onKeyDown={(event) => view.onRecipeKeyDown(event, option.key)}
              onClick={() => view.chooseRecipe(option.choice)}
            />
          )
        })}
        <Link
          className="link"
          to="/b/tasks/recipes"
          onClick={() => {
            view.onClose()
            void navigate('/b/tasks/recipes')
          }}
        >
          Edit recipes
        </Link>
      </div>
      {view.isSavedRecipe && view.workflowDefinition && (
        <div className="inner start-recipe-preview">
          <span className="small muted">
            {view.recipe.kind === 'workflow' ? view.recipe.name : 'Recipe'} · version{' '}
            {view.workflowVersion}
          </span>
          <span className="small">
            {view.workflowDefinition.nodes
              .filter((node) => node.kind === 'agent')
              .map((node) => node.label)
              .join(' → ')}
          </span>
        </div>
      )}
    </div>
  )
}

function RecipeChip({
  chosen,
  label,
  onClick,
  tabIndex,
  buttonRef,
  onKeyDown,
}: {
  chosen: boolean
  label: string
  onClick: () => void
  tabIndex: number
  buttonRef: (element: HTMLButtonElement | null) => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`chip ${chosen ? 'on' : ''}`}
      role="radio"
      aria-checked={chosen}
      tabIndex={tabIndex}
      onClick={onClick}
      onKeyDown={onKeyDown}
      style={{ background: chosen ? undefined : 'var(--field)' }}
    >
      {label}
    </button>
  )
}
