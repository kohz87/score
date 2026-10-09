import { useState } from 'react'
import type { ModelRef, ModelSettings } from '@score/contract'
import { tabFailure } from '../../routes/team/tab-errors.ts'
import { useUpdateModelSettings } from '../../routes/team/model-settings-queries.ts'
import { ModelPicker, type ModelChoice } from '../ModelPicker.tsx'
import './model-settings.css'

const sameChain = (a: ModelRef[], b: ModelRef[]) =>
  a.length === b.length &&
  a.every((ref, i) => ref.provider === b[i]!.provider && ref.model === b[i]!.model)

/** Team › agent › Model: the ordered fallback chain Hermes tries when the model is unavailable. */
export function FallbackChain({ agentId, settings }: { agentId: string; settings: ModelSettings }) {
  const update = useUpdateModelSettings(agentId)
  const [draft, setDraft] = useState<ModelRef[] | null>(null)
  const [next, setNext] = useState<ModelChoice>({ model: '', provider: null })
  const chain = draft ?? settings.fallbacks
  const changed = draft !== null && !sameChain(draft, settings.fallbacks)

  function move(from: number, to: number) {
    const copy = [...chain]
    const [item] = copy.splice(from, 1)
    copy.splice(to, 0, item!)
    setDraft(copy)
  }
  function add() {
    const model = next.model.trim()
    // A name Score can't match to a provider (typed by hand) has no provider to store: ask for a picked model.
    if (!model || !next.provider) return
    setDraft([...chain, { provider: next.provider, model }])
    setNext({ model: '', provider: null })
  }

  return (
    <div className="ms-block" role="group" aria-labelledby="ms-fallback-heading">
      <h3 id="ms-fallback-heading">Fallback models</h3>
      <p className="ms-note">
        Tried in this order when the model above is unavailable (Hermes supports a chain of any
        length).
      </p>
      {chain.length === 0 ? (
        <p className="ms-note">No fallback configured.</p>
      ) : (
        <ol className="ms-list" aria-label="Fallback chain">
          {chain.map((ref, index) => (
            <li key={`${ref.provider}/${ref.model}/${index}`} className="ms-row">
              <span className="ms-row-name">
                {index + 1}. {ref.model}
              </span>
              <span className="ms-row-detail">through {ref.provider}</span>
              {settings.fallbacksEditable && (
                <span className="ms-actions">
                  <button
                    type="button"
                    className="ms-button"
                    disabled={index === 0}
                    aria-label={`Move ${ref.model} up`}
                    onClick={() => move(index, index - 1)}
                  >
                    Up
                  </button>
                  <button
                    type="button"
                    className="ms-button"
                    disabled={index === chain.length - 1}
                    aria-label={`Move ${ref.model} down`}
                    onClick={() => move(index, index + 1)}
                  >
                    Down
                  </button>
                  <button
                    type="button"
                    className="ms-button"
                    aria-label={`Remove ${ref.model}`}
                    onClick={() => setDraft(chain.filter((_, i) => i !== index))}
                  >
                    Remove
                  </button>
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      {settings.fallbacksEditable ? (
        <>
          <ModelPicker
            label="Add a fallback model"
            value={next}
            onChange={setNext}
            agentId={agentId}
            maxLength={200}
          />
          <div className="ms-actions">
            <button
              type="button"
              className="ms-button"
              disabled={!next.provider || !next.model.trim()}
              onClick={add}
            >
              Add to chain
            </button>
            <button
              type="button"
              className="ms-button"
              data-primary=""
              disabled={!changed || update.isPending}
              onClick={() =>
                update.mutate({ fallbacks: chain }, { onSuccess: () => setDraft(null) })
              }
            >
              {update.isPending ? 'Saving…' : 'Save fallbacks'}
            </button>
          </div>
          {!next.provider && next.model.trim() !== '' && (
            <p className="ms-note">
              Pick a model from the list so Score knows which provider it belongs to.
            </p>
          )}
        </>
      ) : (
        <p className="ms-note">
          This chain has custom endpoints or keys, so Score shows it but does not change it. Edit it
          in Hermes.
        </p>
      )}
      {update.isError && <p role="alert">{tabFailure(update.error, 'save the fallback chain')}</p>}
    </div>
  )
}
