import { useState } from 'react'
import { AliasNameSchema, type AliasInput, type ModelAlias } from '@score/contract'
import { tabFailure } from '../../routes/team/tab-errors.ts'
import {
  useModelSettings,
  useUpdateModelSettings,
} from '../../routes/team/model-settings-queries.ts'
import { ModelPicker, type ModelChoice } from '../ModelPicker.tsx'
import './model-settings.css'

const toInput = (alias: ModelAlias): AliasInput => ({
  name: alias.name,
  model: alias.model,
  provider: alias.provider,
})

/** Short names for provider/model pairs (Hermes `model_aliases`, kept per profile). Usable as `/model <alias>`. */
export function AliasEditor({ agentId }: { agentId: string }) {
  const settings = useModelSettings(agentId)
  const update = useUpdateModelSettings(agentId)
  const [name, setName] = useState('')
  const [target, setTarget] = useState<ModelChoice>({ model: '', provider: null })
  const aliases = settings.data?.aliases ?? []
  const editable = aliases.filter((alias) => alias.editable).map(toInput)
  const key = name.trim().toLowerCase()
  const nameValid = AliasNameSchema.safeParse(key).success
  const taken = aliases.some((alias) => alias.name === key)

  return (
    <div className="ms-block" role="group" aria-labelledby={`ms-alias-heading-${agentId}`}>
      <h3 id={`ms-alias-heading-${agentId}`}>Aliases</h3>
      <p className="ms-note">
        A short name for a model, for example <code>fast</code>. Type <code>/model fast</code> in
        Chat or search for it in the model picker.
      </p>
      {settings.isPending && <p role="status">Loading aliases…</p>}
      {settings.isError && <p role="alert">Could not load this agent&apos;s aliases.</p>}
      {settings.data && aliases.length === 0 && <p className="ms-note">No aliases yet.</p>}
      {aliases.length > 0 && (
        <ul className="ms-list" aria-label="Aliases">
          {aliases.map((alias) => (
            <li key={alias.name} className="ms-row">
              <span className="ms-row-name">{alias.name}</span>
              <span className="ms-row-detail">
                {alias.model}
                {alias.provider ? ` through ${alias.provider}` : ''}
              </span>
              {alias.editable ? (
                <button
                  type="button"
                  className="ms-button"
                  aria-label={`Remove alias ${alias.name}`}
                  disabled={update.isPending}
                  onClick={() =>
                    update.mutate({ aliases: editable.filter((item) => item.name !== alias.name) })
                  }
                >
                  Remove
                </button>
              ) : (
                <span className="ms-row-detail">Has its own endpoint; edit in Hermes</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {settings.data && (
        <form
          className="ms-block"
          aria-label="Add alias"
          onSubmit={(event) => {
            event.preventDefault()
            if (!nameValid || taken || !target.model.trim()) return
            update.mutate(
              {
                aliases: [
                  ...editable,
                  { name: key, model: target.model.trim(), provider: target.provider },
                ],
              },
              {
                onSuccess: () => {
                  setName('')
                  setTarget({ model: '', provider: null })
                },
              },
            )
          }}
        >
          <label className="ms-field">
            Alias name
            <input
              value={name}
              maxLength={32}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <ModelPicker
            label="Model it stands for"
            value={target}
            onChange={setTarget}
            maxLength={200}
            required
          />
          {name.trim() !== '' && !nameValid && (
            <p className="ms-note">
              Use lowercase letters, digits, - and _ (up to 32, starting with a letter or digit).
            </p>
          )}
          {taken && (
            <p className="ms-note">
              That alias exists already; remove it first to point it somewhere else.
            </p>
          )}
          <div className="ms-actions">
            <button
              type="submit"
              className="ms-button"
              data-primary=""
              disabled={!nameValid || taken || !target.model.trim() || update.isPending}
            >
              {update.isPending ? 'Saving…' : 'Add alias'}
            </button>
          </div>
        </form>
      )}
      {update.isError && <p role="alert">{tabFailure(update.error, 'save the alias')}</p>}
    </div>
  )
}
