import {
  MAPPING_SLOTS,
  flattenPayload,
  guessMapping,
  renderTemplate,
  valueAtPath,
  type MappingSlot,
} from '../trigger-model.ts'
import { preview, type Wizard } from './wizard-model.ts'

export function WizardMapStep({
  wizard,
  sample,
  onChange,
}: {
  wizard: Wizard
  sample: unknown | null
  onChange: (change: Partial<Wizard>) => void
}) {
  const leaves = sample === null ? [] : flattenPayload(sample)
  const setMapping = (slot: MappingSlot, path: string) => {
    const next = { ...wizard.mapping }
    for (const key of MAPPING_SLOTS) if (next[key.key] === path) next[key.key] = ''
    next[slot] = path
    const following = MAPPING_SLOTS.find((item) => !next[item.key] && item.key !== 'ref')
    onChange({ mapping: next, activeSlot: following?.key ?? slot, problem: '' })
  }
  const insert = (path: string) => {
    const text = wizard.template.replace(/\s*$/, '')
    onChange({ template: `${text}${text ? ' ' : ''}{{${path}}}`, problem: '' })
  }

  return (
    <div className="bold-trigger-map">
      <div className="row wrap">
        <span className="small muted grow">
          {sample === null
            ? 'No call has arrived yet. Send a test call before mapping its fields.'
            : 'Pick a slot on the right, then click the field it comes from.'}
        </span>
        {sample !== null && (
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              const guessed = guessMapping(sample)
              const text =
                wizard.template ||
                `Fix ${guessed.title ? `{{${guessed.title}}}` : 'the item'}: ${guessed.details ? `{{${guessed.details}}}` : 'see the details'}`
              onChange({ mapping: guessed, template: text, problem: '' })
            }}
          >
            Guess from field names
          </button>
        )}
      </div>
      <div className="row wrap">
        <span className="small muted">
          App it comes from: <b>{wizard.app}</b>
        </span>
      </div>
      <div className="bold-trigger-mapgrid">
        <div
          className="bold-trigger-inner mono small bold-trigger-payload"
          aria-label="What the app sent"
        >
          {leaves.length === 0 ? (
            <span className="muted">No fields yet.</span>
          ) : (
            leaves.map((leaf) => {
              const used = MAPPING_SLOTS.find((slot) => wizard.mapping[slot.key] === leaf.path)
              return (
                <button
                  key={leaf.path}
                  type="button"
                  className={`bold-trigger-leaf${used ? ' on' : ''}`}
                  data-payload-path={leaf.path}
                  aria-pressed={used !== undefined}
                  onClick={() => setMapping(wizard.activeSlot, leaf.path)}
                >
                  <span>{leaf.path}</span>
                  <span className="muted">{preview(leaf.value)}</span>
                  {used && <span className="bold-trigger-leaf-slot">{used.label}</span>}
                </button>
              )
            })
          )}
        </div>
        <div className="bold-trigger-slots">
          {MAPPING_SLOTS.map((slot) => {
            const path = wizard.mapping[slot.key]
            const value = path && sample !== null ? valueAtPath(sample, path) : undefined
            return (
              <div
                key={slot.key}
                className={`bold-trigger-slot${wizard.activeSlot === slot.key ? ' on' : ''}`}
              >
                <button
                  type="button"
                  className="bold-trigger-slotbtn"
                  data-mapping-slot={slot.key}
                  aria-pressed={wizard.activeSlot === slot.key}
                  onClick={() => onChange({ activeSlot: slot.key })}
                >
                  <span className="row">
                    <b>{slot.label}</b>
                    {slot.key === 'ref' && <span className="bold-trigger-required">required</span>}
                  </span>
                  {path ? (
                    <>
                      <code className="small">{path}</code>
                      <span className="small muted">{preview(value)}</span>
                    </>
                  ) : (
                    <span className="small muted">
                      {wizard.activeSlot === slot.key ? 'Now click a field on the left' : slot.hint}
                    </span>
                  )}
                </button>
                {path && (
                  <button
                    type="button"
                    className="link"
                    aria-label={`Clear ${slot.label}`}
                    onClick={() => onChange({ mapping: { ...wizard.mapping, [slot.key]: '' } })}
                  >
                    Clear
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>
      <label className="bold-trigger-template">
        <span>What the job asks the team to do</span>
        <textarea
          className="field"
          rows={3}
          placeholder="Fix {{ticket.title}}: {{ticket.body}}"
          value={wizard.template}
          onChange={(event) => onChange({ template: event.target.value, problem: '' })}
        />
      </label>
      <div className="row wrap">
        <span className="small muted">Insert</span>
        {MAPPING_SLOTS.filter((slot) => wizard.mapping[slot.key]).map((slot) => (
          <button
            key={slot.key}
            type="button"
            className="chip"
            onClick={() => insert(wizard.mapping[slot.key])}
          >
            + {slot.label}
          </button>
        ))}
        {MAPPING_SLOTS.every((slot) => !wizard.mapping[slot.key]) && (
          <span className="small muted">map a field first</span>
        )}
      </div>
      <div className="bold-trigger-inner">
        <span className="small muted">With this call, the job would read</span>
        <p>{renderTemplate(wizard.template, sample)}</p>
      </div>
      {wizard.problem && <p role="alert">{wizard.problem}</p>}
      <div className="row wrap bold-trigger-actions">
        <button
          type="button"
          className="btn ghost"
          onClick={() => onChange({ step: 2, problem: '' })}
        >
          Back
        </button>
        <button
          type="button"
          className="btn primary bold-trigger-push"
          disabled={!wizard.mapping.ref || !wizard.template.trim()}
          onClick={() => onChange({ step: 4, problem: '' })}
        >
          Next
        </button>
      </div>
    </div>
  )
}
