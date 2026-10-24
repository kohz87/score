import { useCallback, useEffect, useId, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ReportBack, Trigger, TriggerMapping } from '@score/contract'
import { ApiError } from '../data/api.ts'
import { copyText } from '../data/clipboard.ts'
import { failure } from '../routes/settings/TerminalCommand.tsx'
import {
  MAPPING_SLOTS,
  cleanMapping,
  flattenPayload,
  guessMapping,
  renderTemplate,
  valueAtPath,
  type MappingSlot,
} from './trigger-model.ts'
import {
  createTrigger,
  deleteTrigger,
  rotateTrigger,
  showTriggerSecret,
  triggersKey,
  updateTrigger,
  useTriggers,
  type TriggerCreateRequest,
} from './trigger-queries.ts'

type ReportMode = ReportBack['mode']

type Wizard = {
  mode: 'create' | 'edit'
  step: 1 | 2 | 3 | 4
  triggerId: string | null
  url: string | null
  name: string
  app: string
  mapping: Record<MappingSlot, string>
  template: string
  reportMode: ReportMode
  tool: string
  args: string
  sample: unknown | null
  activeSlot: MappingSlot
  problem: string
  busy: boolean
}

type Secret = { triggerId: string; name: string; value: string }
const CONFIRM_TITLE: Record<'rotate' | 'delete' | 'unfinished', string> = {
  rotate: 'Rotate the secret?',
  delete: 'Delete this trigger?',
  unfinished: 'Keep this unfinished trigger?',
}

type Confirmation = {
  /** `unfinished`: the wizard closed after its address went live but before the mapping was saved. */
  kind: 'rotate' | 'delete' | 'unfinished'
  trigger: Pick<Trigger, 'id' | 'name'>
}

const STEPS = ['Set up', 'Test call', 'Map fields', 'Report back'] as const
const DEFAULT_ARGS = '{\n  "id": "{{source.ref}}"\n}'

function slotsOf(mapping: TriggerMapping): Record<MappingSlot, string> {
  return {
    ref: mapping.ref,
    title: mapping.title ?? '',
    link: mapping.link ?? '',
    details: mapping.details ?? '',
  }
}

function blankWizard(): Wizard {
  return {
    mode: 'create',
    step: 1,
    triggerId: null,
    url: null,
    name: '',
    app: '',
    mapping: { ref: '', title: '', link: '', details: '' },
    template: '',
    reportMode: 'off',
    tool: '',
    args: DEFAULT_ARGS,
    sample: null,
    activeSlot: 'ref',
    problem: '',
    busy: false,
  }
}

function editWizard(trigger: Trigger): Wizard {
  return {
    mode: 'edit',
    step: 3,
    triggerId: trigger.id,
    url: trigger.url,
    name: trigger.name,
    app: trigger.app,
    mapping: slotsOf(trigger.mapping),
    template: trigger.template,
    reportMode: trigger.reportBack.mode,
    tool: trigger.reportBack.mode === 'off' ? '' : trigger.reportBack.tool,
    args: trigger.reportBack.mode === 'off' ? DEFAULT_ARGS : trigger.reportBack.args,
    sample: trigger.sample,
    activeSlot: 'ref',
    problem: '',
    busy: false,
  }
}

function reportBackOf(wizard: Wizard): ReportBack {
  if (wizard.reportMode === 'off') return { mode: 'off' }
  return {
    mode: wizard.reportMode,
    tool: wizard.tool.trim(),
    args: wizard.args,
  }
}

function plainProblem(error: unknown, action: string): string {
  if (error instanceof ApiError) {
    if (error.code === 'bad_template')
      return 'The report-back arguments must be JSON, and every {{…}} must be inside a quoted string.'
    if (error.code === 'not_paired')
      return `Pair this browser using the link in the server terminal to ${action}.`
    if (error.code === 'not_found') return 'That trigger no longer exists.'
    if (error.code === 'gone') return 'That trigger was deleted.'
  }
  return failure(error, action)
}

function when(value: string | null): string {
  if (!value) return 'never'
  return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

function preview(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value) ?? '—'
}

function SecretCard({ secret, onClose }: { secret: Secret; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <section
      className="card bold-trigger-secret"
      data-protected="flex"
      aria-label={`Secret for ${secret.name}`}
    >
      <div className="row wrap">
        <h3>Signing secret</h3>
        <button type="button" className="link" onClick={onClose}>
          Close secret
        </button>
      </div>
      <span className="small muted">
        Copy it before closing this card. Write it where the app keeps credentials, never in a
        command or a message.
      </span>
      <code className="bold-trigger-secret-value" data-trigger-secret>
        {secret.value}
      </code>
      <div className="row wrap">
        <button
          type="button"
          className="btn sm"
          onClick={async () => {
            if (await copyText(secret.value)) setCopied(true)
          }}
        >
          {copied ? 'Copied' : 'Copy secret'}
        </button>
      </div>
    </section>
  )
}

function TriggerCard({
  trigger,
  busy,
  onEdit,
  onReveal,
  onRotate,
  onDelete,
}: {
  trigger: Trigger
  busy: boolean
  onEdit: () => void
  onReveal: () => void
  onRotate: () => void
  onDelete: () => void
}) {
  return (
    <article className="card bold-trigger-card" data-protected="flex" data-trigger-id={trigger.id}>
      <div className="row wrap">
        <b>{trigger.name}</b>
        <span className="small muted">
          {trigger.app} · reference <code>{trigger.mapping.ref}</code> · last call{' '}
          {when(trigger.lastCalledAt)}
        </span>
        <button type="button" className="link bold-trigger-push" onClick={onEdit} disabled={busy}>
          Edit
        </button>
      </div>
      {trigger.url ? (
        <div className="row wrap">
          <code className="small grow bold-trigger-url">{trigger.url}</code>
          <button
            type="button"
            className="btn sm"
            aria-label={`Copy address for ${trigger.name}`}
            onClick={() => void copyText(trigger.url!)}
          >
            Copy address
          </button>
        </div>
      ) : (
        <span className="small muted">
          Score is reachable only on this machine, so an outside app can’t call this address yet.
          Use an HTTPS tunnel or remote mode; the address appears here when it is reachable.
        </span>
      )}
      <div className="row wrap">
        <button type="button" className="btn sm" onClick={onReveal} disabled={busy}>
          Show secret again
        </button>
        <button type="button" className="btn sm" onClick={onRotate} disabled={busy}>
          Rotate secret
        </button>
        <button
          type="button"
          className="btn sm bold-trigger-danger"
          onClick={onDelete}
          disabled={busy}
        >
          Delete
        </button>
        <span className="small muted bold-trigger-push">
          {trigger.reportBack.mode === 'off'
            ? 'Results stay in Score.'
            : `Reports back with ${trigger.reportBack.tool}.`}
        </span>
      </div>
      <span className="small muted">
        Calls must be signed with the secret (Standard Webhooks headers) and arrive within five
        minutes.
      </span>
    </article>
  )
}

function WizardBody({
  wizard,
  sample,
  url,
  secret,
  appSuggestions,
  onChange,
  onClose,
  onCreate,
  onShowSecret,
  onSecretClose,
  onSave,
  onRefresh,
}: {
  wizard: Wizard
  sample: unknown | null
  url: string | null
  secret: Secret | null
  appSuggestions: string[]
  onChange: (change: Partial<Wizard>) => void
  onClose: () => void
  onCreate: () => void
  onShowSecret: () => void
  onSecretClose: () => void
  onSave: () => void
  onRefresh: () => void
}) {
  const appListId = useId()
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
    <>
      <div className="row wrap bold-trigger-wizard-head">
        <h3>{wizard.mode === 'edit' ? 'Edit trigger' : 'New trigger'}</h3>
        <button type="button" className="link bold-trigger-push" onClick={onClose}>
          Close
        </button>
      </div>
      <ol className="bold-trigger-steps" aria-label="Trigger setup steps">
        {STEPS.map((label, index) => {
          const number = (index + 1) as 1 | 2 | 3 | 4
          return (
            <li
              key={label}
              className={wizard.step === number ? 'on' : wizard.step > number ? 'done' : undefined}
              aria-current={wizard.step === number ? 'step' : undefined}
            >
              <span>{number}</span>
              {label}
            </li>
          )
        })}
      </ol>

      {wizard.step === 1 && (
        <div className="bold-trigger-form">
          <label>
            <span>Name</span>
            <input
              className="field"
              required
              maxLength={100}
              placeholder="e.g. New support ticket"
              value={wizard.name}
              onChange={(event) => onChange({ name: event.target.value, problem: '' })}
            />
          </label>
          <label>
            <span>App it comes from</span>
            <input
              className="field"
              required
              maxLength={100}
              list={appListId}
              placeholder="e.g. Tickets app"
              value={wizard.app}
              onChange={(event) => onChange({ app: event.target.value, problem: '' })}
            />
            <datalist id={appListId}>
              {appSuggestions.map((app) => (
                <option key={app} value={app} />
              ))}
            </datalist>
          </label>
          <span className="small muted">
            {wizard.mode === 'create' && !wizard.triggerId
              ? 'Score makes the address and shows its secret once. The app sends one signed test call before you map fields.'
              : 'The address and secret stay the same. Change the name or app, then check the mapping.'}
          </span>
          <div className="row wrap bold-trigger-actions">
            <button type="button" className="link" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary bold-trigger-push"
              disabled={wizard.busy || !wizard.name.trim() || !wizard.app.trim()}
              onClick={() => {
                if (wizard.mode === 'create' && !wizard.triggerId) onCreate()
                else onChange({ step: 2, problem: '' })
              }}
            >
              {wizard.busy
                ? 'Working…'
                : wizard.mode === 'create' && !wizard.triggerId
                  ? 'Create the address'
                  : 'Next'}
            </button>
          </div>
        </div>
      )}

      {wizard.step === 2 && (
        <div className="bold-trigger-test">
          <div className="bold-trigger-inner">
            <span className="small muted">
              Paste this address into {wizard.app || 'the app'}’s webhook settings.
            </span>
            {url ? (
              <div className="row wrap">
                <code className="small grow bold-trigger-url">{url}</code>
                <button
                  type="button"
                  className="btn sm"
                  aria-label="Copy webhook address"
                  onClick={() => void copyText(url)}
                >
                  Copy address
                </button>
              </div>
            ) : (
              <span className="small muted">
                Score is reachable only on this machine, so an outside app can’t call it yet. Use an
                HTTPS tunnel or remote mode; the address appears here when it is reachable.
              </span>
            )}
            {secret ? (
              <SecretCard secret={secret} onClose={onSecretClose} />
            ) : (
              <button type="button" className="link" onClick={onShowSecret}>
                Show secret again
              </button>
            )}
            <span className="small muted">
              Calls must be signed with the secret (Standard Webhooks headers) and arrive within
              five minutes.
            </span>
          </div>
          <div className="card bold-trigger-wait">
            {sample === null ? (
              <>
                <span className="bold-trigger-dots" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
                <b>Waiting for a test call</b>
                <span className="small muted">
                  Make the app send one, e.g. create a test ticket. Score shows what arrives so you
                  can pick the fields.
                </span>
                <button type="button" className="btn sm" onClick={onRefresh}>
                  Check again
                </button>
              </>
            ) : (
              <>
                <b>Test call received</b>
                <span className="small muted">This is the redacted payload Score will map:</span>
                <pre className="bold-trigger-sample">{JSON.stringify(sample, null, 2)}</pre>
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => {
                    onSecretClose()
                    onChange({ step: 3, problem: '' })
                  }}
                >
                  Map fields
                </button>
              </>
            )}
          </div>
          <div className="row wrap bold-trigger-actions">
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                onSecretClose()
                onChange({ step: 1, problem: '' })
              }}
            >
              Back
            </button>
            <button type="button" className="link bold-trigger-push" onClick={onClose}>
              Finish later
            </button>
          </div>
        </div>
      )}

      {wizard.step === 3 && (
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
                        {slot.key === 'ref' && (
                          <span className="bold-trigger-required">required</span>
                        )}
                      </span>
                      {path ? (
                        <>
                          <code className="small">{path}</code>
                          <span className="small muted">{preview(value)}</span>
                        </>
                      ) : (
                        <span className="small muted">
                          {wizard.activeSlot === slot.key
                            ? 'Now click a field on the left'
                            : slot.hint}
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
      )}

      {wizard.step === 4 && (
        <div className="bold-trigger-report">
          <span className="small muted">
            At the end, Score can ask the lead to call a tool of its Hermes profile with a fixed
            argument template. The app’s token stays in Hermes.
          </span>
          <fieldset className="bold-trigger-modes">
            <legend>Report back</legend>
            {(
              [
                [
                  'off',
                  'Don’t report back',
                  'Results stay in Score; the job still links to the item.',
                ],
                [
                  'fixed',
                  'Post with a tool every time',
                  'The lead calls this tool when the job is done.',
                ],
                [
                  'lead_decides',
                  'Let lead decide',
                  'Lead picks the tool; you confirm the first report-back.',
                ],
              ] as const
            ).map(([mode, label, hint]) => (
              <label key={mode} className="bold-trigger-mode">
                <input
                  type="radio"
                  name="trigger-report-mode"
                  value={mode}
                  checked={wizard.reportMode === mode}
                  onChange={() => onChange({ reportMode: mode, problem: '' })}
                />
                <span>
                  <b>{label}</b>
                  <span className="small muted">{hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {wizard.reportMode !== 'off' && (
            <div className="bold-trigger-form">
              <label>
                <span>Tool name</span>
                <input
                  className="field"
                  required
                  maxLength={200}
                  placeholder="e.g. add_comment"
                  value={wizard.tool}
                  onChange={(event) => onChange({ tool: event.target.value, problem: '' })}
                />
              </label>
              <label>
                <span>Arguments template (JSON)</span>
                <textarea
                  className="field mono"
                  required
                  rows={5}
                  value={wizard.args}
                  onChange={(event) => onChange({ args: event.target.value, problem: '' })}
                />
              </label>
              <span className="small muted">
                Use JSON paths as holes, e.g. <code>{'{"id": "{{source.ref}}"}'}</code>. Every hole
                must sit inside a quoted string.
              </span>
            </div>
          )}
          {wizard.problem && <p role="alert">{wizard.problem}</p>}
          <div className="row wrap bold-trigger-actions">
            <button
              type="button"
              className="btn ghost"
              onClick={() => onChange({ step: 3, problem: '' })}
            >
              Back
            </button>
            <button
              type="button"
              className="btn primary bold-trigger-push"
              disabled={
                wizard.busy ||
                !wizard.mapping.ref ||
                !wizard.template.trim() ||
                (wizard.reportMode !== 'off' && (!wizard.tool.trim() || !wizard.args.trim()))
              }
              onClick={onSave}
            >
              {wizard.busy ? 'Saving…' : wizard.mode === 'edit' ? 'Save changes' : 'Save trigger'}
            </button>
          </div>
        </div>
      )}

      {wizard.problem && wizard.step !== 3 && wizard.step !== 4 && (
        <p role="alert">{wizard.problem}</p>
      )}
    </>
  )
}

/** PLAN 11.9a: the prototype's vTriggerWizard and sTools triggers, backed by contract §17. */
export function BoldTriggers({ appSuggestions = [] }: { appSuggestions?: string[] }) {
  const queryClient = useQueryClient()
  const [wizard, setWizard] = useState<Wizard | null>(null)
  const [secret, setSecret] = useState<Secret | null>(null)
  const [confirm, setConfirm] = useState<Confirmation | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const triggers = useTriggers(wizard?.step === 2)
  const live = wizard?.triggerId
    ? triggers.data?.find((trigger) => trigger.id === wizard.triggerId)
    : undefined
  const sample = live?.sample ?? wizard?.sample ?? null
  const url = live?.url ?? wizard?.url ?? null

  // The contract has no draft trigger: once step 1 made the address it is live, and every call starts a job with the
  // placeholder wording. Closing before the mapping is saved asks whether to keep it.
  const closeWizard = useCallback(
    ({ saved = false }: { saved?: boolean } = {}) => {
      if (!saved && wizard?.mode === 'create' && wizard.triggerId)
        setConfirm({
          kind: 'unfinished',
          trigger: { id: wizard.triggerId, name: wizard.name.trim() },
        })
      setWizard(null)
      setSecret(null)
    },
    [wizard],
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (secret) setSecret(null)
      else if (confirm) setConfirm(null)
      else if (wizard) closeWizard()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [closeWizard, confirm, secret, wizard])

  const update = (change: Partial<Wizard>) =>
    setWizard((current) => (current ? { ...current, ...change } : current))
  const invalidate = () => queryClient.invalidateQueries({ queryKey: triggersKey })

  async function createAddress() {
    if (!wizard) return
    const request: TriggerCreateRequest = {
      name: wizard.name.trim(),
      app: wizard.app.trim(),
      // The contract has no draft trigger or test-call endpoint. This safe starting map lets the app make its one
      // signed test call; the mapping is replaced on the last step before the person shares the address.
      mapping: { ref: 'id' },
      template: 'A call from the app started a job.',
      reportBack: { mode: 'off' },
    }
    update({ busy: true, problem: '' })
    try {
      const made = await createTrigger(request)
      setWizard((current) =>
        current
          ? {
              ...current,
              triggerId: made.trigger.id,
              url: made.trigger.url,
              // The create request carries a safe starting map and template only because the contract has no draft
              // state; the person maps the real call and writes the job's wording from step 3.
              mapping: { ref: '', title: '', link: '', details: '' },
              template: '',
              sample: made.trigger.sample,
              step: 2,
              busy: false,
            }
          : current,
      )
      setSecret({ triggerId: made.trigger.id, name: made.trigger.name, value: made.secret })
      void invalidate()
    } catch (error) {
      update({ busy: false, problem: plainProblem(error, 'create this trigger') })
    }
  }

  async function saveTrigger() {
    if (!wizard?.triggerId) return
    update({ busy: true, problem: '' })
    try {
      await updateTrigger(wizard.triggerId, {
        name: wizard.name.trim(),
        app: wizard.app.trim(),
        mapping: cleanMapping(wizard.mapping),
        template: wizard.template.trim(),
        reportBack: reportBackOf(wizard),
      })
      setNotice(
        wizard.mode === 'edit'
          ? 'Trigger saved.'
          : `Trigger saved. The next call from ${wizard.app} starts a job in the team room.`,
      )
      closeWizard({ saved: true })
      void invalidate()
    } catch (error) {
      update({ busy: false, problem: plainProblem(error, 'save this trigger') })
    }
  }

  async function reveal(trigger: Trigger) {
    setPending(`secret:${trigger.id}`)
    setNotice('')
    try {
      const value = await showTriggerSecret(trigger.id)
      setSecret({ triggerId: trigger.id, name: trigger.name, value })
    } catch (error) {
      setNotice(plainProblem(error, 'show this secret'))
    } finally {
      setPending(null)
    }
  }

  async function showWizardSecret() {
    if (!wizard?.triggerId) return
    setPending('wizard-secret')
    try {
      const value = await showTriggerSecret(wizard.triggerId)
      setSecret({ triggerId: wizard.triggerId, name: wizard.name, value })
    } catch (error) {
      update({ problem: plainProblem(error, 'show this secret') })
    } finally {
      setPending(null)
    }
  }

  async function confirmAction() {
    if (!confirm) return
    const { kind, trigger } = confirm
    setPending(kind)
    setNotice('')
    try {
      if (kind === 'rotate') {
        const value = await rotateTrigger(trigger.id)
        setSecret({ triggerId: trigger.id, name: trigger.name, value })
        setNotice('Secret rotated. The old secret stops working now.')
      } else {
        await deleteTrigger(trigger.id)
        setNotice(`Deleted ${trigger.name}. Its address stops working.`)
      }
      setConfirm(null)
      void invalidate()
    } catch (error) {
      setNotice(
        plainProblem(error, kind === 'rotate' ? 'rotate this secret' : 'delete this trigger'),
      )
    } finally {
      setPending(null)
    }
  }

  return (
    <section className="card bold-triggers" aria-labelledby="bold-triggers-title">
      <div className="row wrap">
        <h3 id="bold-triggers-title">Triggers</h3>
        <span className="small muted">Let another app start a job by calling an address</span>
        <button
          type="button"
          className="btn sm primary bold-trigger-push"
          onClick={() => {
            setNotice('')
            setSecret(null)
            setWizard(blankWizard())
          }}
        >
          New trigger
        </button>
      </div>
      {triggers.isPending && <p role="status">Loading triggers…</p>}
      {triggers.isError && <p role="alert">Couldn’t load triggers. Try again later.</p>}
      {triggers.data?.length === 0 && (
        <span className="small muted">No triggers yet. Make one to let an app start a job.</span>
      )}
      <div className="bold-trigger-list">
        {triggers.data?.map((trigger) => (
          <TriggerCard
            key={trigger.id}
            trigger={trigger}
            busy={pending !== null}
            onEdit={() => {
              setNotice('')
              setSecret(null)
              setWizard(editWizard(trigger))
            }}
            onReveal={() => void reveal(trigger)}
            onRotate={() => setConfirm({ kind: 'rotate', trigger })}
            onDelete={() => setConfirm({ kind: 'delete', trigger })}
          />
        ))}
      </div>
      {notice && <p role="status">{notice}</p>}

      {wizard && (
        <div className="bold-trigger-scrim">
          <div
            className={`bold-trigger-dialog${wizard.step === 3 ? ' wide' : ''}`}
            data-trigger-step={wizard.step}
            role="dialog"
            aria-modal="true"
            aria-label={wizard.mode === 'edit' ? 'Edit trigger' : 'New trigger'}
          >
            <WizardBody
              wizard={wizard}
              sample={sample}
              url={url}
              secret={secret?.triggerId === wizard.triggerId ? secret : null}
              appSuggestions={appSuggestions}
              onChange={update}
              onClose={closeWizard}
              onCreate={() => void createAddress()}
              onShowSecret={() => void showWizardSecret()}
              onSecretClose={() => setSecret(null)}
              onSave={() => void saveTrigger()}
              onRefresh={() => void triggers.refetch()}
            />
          </div>
        </div>
      )}

      {!wizard && secret && (
        <div className="bold-trigger-scrim">
          <div
            className="bold-trigger-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Trigger secret"
          >
            <SecretCard secret={secret} onClose={() => setSecret(null)} />
          </div>
        </div>
      )}

      {confirm && (
        <div className="bold-trigger-scrim">
          <section
            className="card bold-trigger-confirm"
            data-protected="flex"
            role="alertdialog"
            aria-modal="true"
            aria-label={CONFIRM_TITLE[confirm.kind]}
          >
            <h3>{CONFIRM_TITLE[confirm.kind]}</h3>
            <p>
              {confirm.kind === 'rotate'
                ? 'The old secret stops working immediately. Every app sending this trigger must be updated with the new one.'
                : confirm.kind === 'unfinished'
                  ? `${confirm.trigger.name} is already live: until you finish it, every call to its address starts a job with placeholder wording. Delete it, or keep it and finish it later from its Edit button.`
                  : `Calls to ${confirm.trigger.name} will stop working. Past jobs stay in the team room.`}
            </p>
            {pending === confirm.kind && <p role="status">Working…</p>}
            <div className="row wrap bold-trigger-actions">
              <button
                type="button"
                className="link"
                onClick={() => setConfirm(null)}
                disabled={pending !== null}
              >
                {confirm.kind === 'unfinished' ? 'Keep it for now' : 'Cancel'}
              </button>
              <button
                type="button"
                className={`btn primary bold-trigger-push${confirm.kind === 'rotate' ? '' : ' bold-trigger-danger'}`}
                disabled={pending !== null}
                onClick={() => void confirmAction()}
              >
                {confirm.kind === 'rotate' ? 'Rotate secret' : 'Delete trigger'}
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  )
}
