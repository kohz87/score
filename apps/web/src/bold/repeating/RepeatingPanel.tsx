import type { AgentSummary, RepeatingJob, Room } from '@score/contract'
import { useState } from 'react'
import { agentDisplayName } from '../bold-agents.ts'
import { DeleteConfirm, LeftBehindNote, MoveNote } from './RepeatingNotes.tsx'
import { AssignField } from './RepeatingAssignField.tsx'
import { ModelField } from './RepeatingModelField.tsx'
import { ResultsField } from './RepeatingResultsField.tsx'
import { WhenField } from './RepeatingWhenField.tsx'
import {
  blankForm,
  createBody,
  directRoomId,
  deliverId,
  formOf,
  formProblem,
  patchBody,
  type RepeatingForm,
} from './repeating-form.ts'
import { useRepeatingActions } from './repeating-queries.ts'

// Tasks › Repeating (TR.2): the new / edit panel (mock-up 28-tasks-edit). Save sends only what changed; a changed
// agent moves the job first (contract §22), then the rest goes to the job's new id.

type Base = { job: RepeatingJob; form: RepeatingForm; target: string | null }

const say = (error: unknown, fallback: string) =>
  error instanceof Error && 'code' in error && error.code !== 'request_failed' && error.message
    ? error.message
    : fallback

export function RepeatingPanel({
  job,
  agents,
  rooms,
  directs,
  firstAgentId,
  now,
  onClose,
}: {
  job: RepeatingJob | null
  /** The agents a Hermes job can be assigned to. */
  agents: readonly AgentSummary[]
  rooms: readonly Room[]
  directs: readonly Room[]
  firstAgentId: string
  now: Date
  onClose: () => void
}) {
  const actions = useRepeatingActions()
  const [base, setBase] = useState<Base | null>(() =>
    job ? { job, form: formOf(job, rooms, directs), target: job.deliverTo?.roomId ?? null } : null,
  )
  const [form, setForm] = useState<RepeatingForm>(() => {
    if (base) return base.form
    // A job's results go to the agent's direct chat when it has one, else nowhere.
    const blank = blankForm(firstAgentId)
    return directRoomId(rooms, directs, firstAgentId) ? blank : { ...blank, deliver: 'none' }
  })
  const [recipes, setRecipes] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [left, setLeft] = useState<{ id: string; agentId: string } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const busy = Object.values(actions).some((action) => action.isPending)
  const change = (patch: Partial<RepeatingForm>) => setForm((now) => ({ ...now, ...patch }))
  const nameOf = (id: string) => {
    const found = agents.find((agent) => agent.id === id)
    return found ? agentDisplayName(found) : id
  }
  const agent = agents.find((item) => item.id === form.agentId)
  const directId = directRoomId(rooms, directs, form.agentId)
  const chats: { id: string; name: string }[] = rooms
    .filter((room) => room.kind !== 'direct' && room.role !== 'direct' && !room.archived)
    .map((room) => ({ id: room.id, name: room.name }))
  // A job's chat that isn't in the list (archived, or since renamed) stays choosable under the name it was saved with.
  const saved = base?.job.deliverTo
  if (saved && saved.roomId !== directId && !chats.some((room) => room.id === saved.roomId))
    chats.push({ id: saved.roomId, name: saved.roomName })
  const moving = base !== null && form.agentId !== base.form.agentId

  async function save() {
    const problem = formProblem(form, directId)
    if (problem) return setError(problem)
    setError(null)
    try {
      if (!base) {
        await actions.create.mutateAsync({
          agentId: form.agentId,
          body: createBody(form, directId),
        })
        return onClose()
      }
      let { job: current, form: before } = base
      let leftBehind: string | null = null
      if (form.agentId !== before.agentId) {
        const moved = await actions.move.mutateAsync({
          id: current.id,
          agentId: form.agentId,
          from: before.agentId,
        })
        current = moved.job
        leftBehind = moved.leftBehind
        if (leftBehind) setLeft({ id: leftBehind, agentId: before.agentId })
        before = { ...before, agentId: form.agentId }
        setBase({ ...base, job: current, form: before })
      }
      const body = patchBody(before, form, base.target, directId)
      if (Object.keys(body).length > 0)
        current = await actions.patch.mutateAsync({ id: current.id, body })
      setBase({ job: current, form, target: deliverId(form, directId) })
      if (!leftBehind) onClose()
    } catch (caught) {
      setError(say(caught, 'Couldn’t save that. Try again.'))
    }
  }

  async function attempt(run: () => Promise<unknown>, fallback: string) {
    setError(null)
    try {
      await run()
      return true
    } catch (caught) {
      setError(say(caught, fallback))
      return false
    }
  }

  const current = base?.job
  return (
    <div className="bold-rj-panel-body">
      <div className="bold-rj-panel-head">
        <h2>{current ? current.title : 'New repeating job'}</h2>
        <button type="button" className="bold-rj-quiet" onClick={onClose}>
          Close
        </button>
      </div>
      <label className="bold-rj-field">
        <span className="bold-rj-label">What it does</span>
        <textarea
          rows={4}
          value={form.prompt}
          // A prompt Score only has part of (long, or with something private in it) is never sent back cut.
          readOnly={current?.descriptionComplete === false}
          onChange={(event) => change({ prompt: event.target.value })}
        />
      </label>
      {current?.descriptionComplete === false && (
        <p className="bold-rj-hint">
          This prompt is long or holds something private, so Score shows only part of it and can’t
          change it. Edit it in Hermes.
        </p>
      )}
      <label className="bold-rj-field">
        <span className="bold-rj-label">Title</span>
        <input value={form.title} onChange={(event) => change({ title: event.target.value })} />
      </label>
      <WhenField form={form} now={now} onChange={change} />
      <AssignField
        agents={agents}
        agentId={form.agentId}
        choosingRecipe={recipes}
        onPick={(id) =>
          change({
            agentId: id,
            ...(form.deliver === 'direct' && !directRoomId(rooms, directs, id)
              ? { deliver: 'none' as const }
              : {}),
          })
        }
        onRecipes={setRecipes}
      />
      <ModelField
        agent={agent}
        mode={form.modelMode}
        pinned={form.pinned}
        onMode={(modelMode) => change({ modelMode })}
        onPin={(pinned) => change({ pinned })}
      />
      <ResultsField
        agentName={nameOf(form.agentId)}
        rooms={chats}
        deliver={form.deliver}
        roomId={form.roomId}
        onDeliver={(deliver) => change({ deliver })}
        onRoom={(roomId) => change({ roomId })}
      />
      {moving && <MoveNote from={nameOf(base.form.agentId)} to={nameOf(form.agentId)} />}
      {left && (
        <LeftBehindNote
          agent={nameOf(left.agentId)}
          busy={busy}
          onRemove={() =>
            void attempt(async () => {
              await actions.remove.mutateAsync({ id: left.id, agentId: left.agentId })
              setLeft(null)
              onClose()
            }, 'Couldn’t remove it. Try again.')
          }
        />
      )}
      {deleting && current && (
        <DeleteConfirm
          title={current.title}
          agent={nameOf(current.agentId)}
          busy={busy}
          onKeep={() => setDeleting(false)}
          onDelete={() =>
            void attempt(async () => {
              await actions.remove.mutateAsync({ id: current.id, agentId: current.agentId })
              onClose()
            }, 'Couldn’t delete it. Try again.')
          }
        />
      )}
      {error && (
        <p className="bold-rj-error" role="alert">
          {error}
        </p>
      )}
      <div className="bold-rj-foot">
        <button type="button" className="bold-rj-save" disabled={busy} onClick={() => void save()}>
          Save
        </button>
        {current && (
          <button
            type="button"
            className="bold-rj-quiet"
            disabled={busy}
            onClick={() =>
              void attempt(async () => {
                await actions.patch.mutateAsync({
                  id: current.id,
                  body: { enabled: !current.enabled },
                })
                onClose()
              }, 'Couldn’t change that. Try again.')
            }
          >
            {current.enabled ? 'Pause' : 'Resume'}
          </button>
        )}
        <span className="bold-rj-grow" />
        {current && (
          <button type="button" className="bold-rj-delete" onClick={() => setDeleting(true)}>
            Delete…
          </button>
        )}
      </div>
    </div>
  )
}
