import type { AgentSummary, Job, Room } from '@score/contract'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { agentDisplayName, canTalkTo } from '../bold-agents.ts'
import { CloseIcon, HistoryIcon, LockIcon } from '../BoldIcons.tsx'
import { createTeamJob, postChatHandOff, shareMessageToJob } from './direct-queries.ts'
import { TeamSelect, useChosenTeamJobs, useTeamChoice } from '../room/team-choice.tsx'

/**
 * Escape, a press outside, and focus returning to what opened it, for the popover and the two small dialogs. Escape is
 * taken in the capture phase and marked handled, so on a phone the sheet's own Escape (which closes the whole panel)
 * only sees the key when no dialog is open.
 */
export function useDialogDismiss(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  focusRef?: RefObject<HTMLElement | null>,
) {
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    ;(focusRef?.current ?? ref.current)?.focus()
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      close.current()
    }
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node
      if (ref.current?.contains(target) || opener?.contains(target)) return
      close.current()
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onPointerDown)
      if (!opener?.isConnected) return
      opener.focus()
      // 3.27.0 gate: a message's action row is hidden unless the message is hovered or focused, so the button that
      // opened the dialog may not take focus back: the message row (focusable, it shows the row again) takes it.
      if (document.activeElement !== opener) opener.closest<HTMLElement>('[tabindex]')?.focus()
    }
  }, [focusRef, ref])
}

/** The promise that a one-to-one is private; a protected label no theme may hide or relabel. */
export function PrivacyNote({ agent }: { agent: Pick<AgentSummary, 'id' | 'name'> }) {
  return (
    <span className="small muted side-privacy bold-dm-privacy" data-protected="inline-flex">
      <LockIcon />
      Only you and {agentDisplayName(agent)} see this
    </span>
  )
}

const STARTERS = ['What are you working on?', 'What do you need from me?', 'Show me your screen']

export function Starters({
  onAsk,
  disabled = false,
}: {
  onAsk: (text: string) => void
  disabled?: boolean
}) {
  return (
    <div className="bold-dm-starters">
      {STARTERS.map((question) => (
        <button
          key={question}
          type="button"
          className="btn sm ghost"
          disabled={disabled}
          onClick={() => onAsk(question)}
        >
          {question}
        </button>
      ))}
    </div>
  )
}

export function ShareMenu({
  messageId,
  jobs,
  onClose,
  onShared,
}: {
  messageId: string
  jobs: Job[]
  onClose: () => void
  onShared: (messageId: string) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  useDialogDismiss(box, onClose)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const choice = useTeamChoice()
  const chosenJobs = useChosenTeamJobs(choice)
  const listed = choice.several ? (chosenJobs ?? []) : jobs

  async function share(jobId: string) {
    setBusy(jobId)
    setError(null)
    try {
      await shareMessageToJob(messageId, jobId)
      onShared(messageId)
      onClose()
    } catch {
      setError('Couldn’t share it. Try again.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      ref={box}
      tabIndex={-1}
      className="bold-dm-share-menu"
      role="dialog"
      aria-label={choice.several ? 'Share to a team' : 'Share to the team room'}
      data-protected="block"
    >
      <div className="bold-dm-share-head">
        <b>{choice.several ? 'Share to a team' : 'Share to the team room'}</b>
        <button
          type="button"
          className="icon-btn sm"
          aria-label="Close share menu"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>
      <TeamSelect choice={choice} label="Team" disabled={busy !== null} />
      <p className="small muted">Choose the job that should get a frozen copy of this reply.</p>
      {listed.length === 0 ? (
        <p className="small muted">
          {choice.chosen ? `${choice.chosen.name} has` : 'The team room has'} no open jobs yet.
        </p>
      ) : (
        listed.map((job) => (
          <button
            key={job.id}
            type="button"
            className="mi"
            disabled={busy !== null}
            onClick={() => void share(job.id)}
          >
            <span className="bold-dm-share-job">
              <b>{job.title}</b>
              <span className="small muted">{job.isDefault ? 'Team room thread' : job.state}</span>
            </span>
            {busy === job.id && <span className="small muted">Sharing…</span>}
          </button>
        ))
      )}
      {error && (
        <p className="small bold-dm-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/**
 * Adding someone to a one-to-one starts a team-room job, so the dialog says what leaves before anything does: the job's
 * title and the summary that travels with it. A failed hand-off message keeps the job and offers a retry of just the
 * message, never a second job.
 */
export function AddSomeone({
  agents,
  agent,
  chat,
  team,
  onClose,
  onMoved,
}: {
  agents: AgentSummary[]
  agent: AgentSummary
  chat: Job
  team: { room: Room; jobs: Job[] } | null | undefined
  onClose: () => void
  onMoved: (job: Job) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  useDialogDismiss(box, onClose)
  const [target, setTarget] = useState<AgentSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The job exists once step one worked; a retry only repeats the message.
  const [job, setJob] = useState<Job | null>(null)
  const teams = useTeamChoice()
  // Only the chosen team's members can be added; with one team room every agent is a member, as before.
  const choices = agents.filter(
    (item) =>
      item.id !== agent.id &&
      canTalkTo(item) &&
      (!teams.chosen || teams.chosen.members.includes(item.id)),
  )
  const title = chat.title || 'New chat'
  const startRoom = teams.chosen ?? team?.room ?? null
  const startName = teams.chosen ? teams.chosen.name : 'the team room'

  async function confirm() {
    if (!startRoom || !target) {
      setError('The team room isn’t ready yet.')
      return
    }
    setBusy(true)
    setError(null)
    let made = job
    try {
      if (!made) {
        made = await createTeamJob(startRoom.id, chat)
        setJob(made)
      }
    } catch {
      setError('Couldn’t start the team chat. Try again.')
      setBusy(false)
      return
    }
    try {
      await postChatHandOff(startRoom.id, made.id, chat, [agent.id, target.id])
      onMoved(made)
    } catch {
      setError(
        `The job “${made.title}” is in ${startName}, but the message to ${target.id} didn’t send.`,
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      ref={box}
      tabIndex={-1}
      className="bold-dm-add"
      role="dialog"
      aria-label="Add someone to this one-to-one"
      data-protected="block"
      data-decision
    >
      <div className="bold-dm-share-head">
        <b>Add someone</b>
        <button
          type="button"
          className="icon-btn sm"
          aria-label="Close Add someone"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>
      <p>
        A one-to-one has no room for a third. Adding someone starts a new job in {startName} with
        this chat referenced, not copied; everyone there sees the frozen summary. This chat stays as
        it is.
      </p>
      <TeamSelect choice={teams} label="Starts in" disabled={busy || target !== null} />
      {!target ? (
        <div className="bold-dm-add-list">
          {choices.map((item) => (
            <button
              key={item.id}
              type="button"
              className="btn sm"
              disabled={!startRoom}
              onClick={() => setTarget(item)}
            >
              <AgentGlyph agent={item} size="xs" bare decorative />
              {`Add ${agentDisplayName(item)}`}
            </button>
          ))}
        </div>
      ) : (
        <div className="bold-dm-add-confirm">
          <p>
            <b>What leaves this chat</b>
          </p>
          <p className="small">
            Starts in {startName}: <b>{title}</b>
          </p>
          <p className="small muted bold-dm-add-summary">
            {chat.summary ? `Summary shared: ${chat.summary}` : 'A summary of this chat is shared.'}
          </p>
          <p className="small muted">
            The first message asks {agentDisplayName(agent)} and {agentDisplayName(target)}; both
            see the summary.
          </p>
          <div className="bold-dm-add-list">
            <button
              type="button"
              className="btn sm bold-dm-primary"
              disabled={busy || !startRoom}
              onClick={() => void confirm()}
            >
              {busy
                ? 'Starting…'
                : job
                  ? `Retry the message to ${target.id}`
                  : `Add ${target.id} and share a summary`}
            </button>
            <button
              type="button"
              className="btn sm ghost"
              disabled={busy}
              onClick={() => {
                setTarget(null)
                setError(null)
              }}
            >
              Back
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="small bold-dm-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

export function ReferenceChip({
  agent,
  title,
  onClear,
}: {
  agent: AgentSummary
  title: string
  onClear: () => void
}) {
  return (
    <span className="bold-dm-ref" style={{ borderColor: agent.style.color }}>
      <HistoryIcon />
      Referring to <b>{title}</b>
      <button type="button" aria-label="Remove reference" onClick={onClear}>
        <CloseIcon size={12} />
      </button>
    </span>
  )
}
