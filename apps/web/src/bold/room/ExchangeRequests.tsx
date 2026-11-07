import type { AgentSummary, Exchange, ExchangeOption, Job } from '@score/contract'
import { useMemo, useState } from 'react'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { apiFetch } from '../../data/api.ts'
import { useStreamQuery, useStreamQueryRefetch } from '../../data/query-client.ts'
import { agentDisplayName, agentNameColor } from '../bold-agents.ts'
import { PinCard } from './PinCards.tsx'
import {
  exchangePauseAsk,
  exchangePauseTitle,
  exchangeTurns,
  needsYou,
  optionLabel,
} from './room-model.ts'
import { roomExchangesQuery } from './room-queries.ts'
import { decisionBody, decisionError, needsForm } from './room-request-decisions.ts'

type PendingOption = ExchangeOption | null

function ExchangeRequestCard({
  exchange,
  job,
  agents,
  onAnswered,
}: {
  exchange: Exchange
  job: Job
  agents: AgentSummary[]
  onAnswered?: () => void
}) {
  const from = agents.find((agent) => agent.id === exchange.from)
  const to = agents.find((agent) => agent.id === exchange.to)
  const [pending, setPending] = useState<PendingOption>(null)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<{ pause: string; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const options = exchange.pause?.options ?? []
  // The decision is applied (and the limits re-checked) in one server transaction that writes the exchange once, so any
  // later read has a newer updatedAt: either the pause is gone (the card leaves) or it was held again (the buttons come
  // back, even with the same reason and options). Until then the "sent" line stays.
  const pauseIdentity = exchange.pause ? `${exchange.id}|${exchange.updatedAt}` : null
  const sentMatchesPause = sent !== null && sent.pause === pauseIdentity
  if (sent !== null && !sentMatchesPause) setSent(null)
  const sentText = sentMatchesPause ? sent.text : null
  const reassignChoices = agents.filter(
    (agent) => agent.id !== exchange.from && agent.id !== exchange.to,
  )
  // Reassign never starts on the agent who has the turn (`exchange.to`): the first legal choice is the pick.
  const [form, setForm] = useState({
    note: '',
    text: '',
    agent: '',
    usd: '10',
    turns: '4',
  })

  async function choose(option: ExchangeOption) {
    if (needsForm(option)) {
      if (option === 'reassign')
        setForm((current) => ({ ...current, agent: reassignChoices[0]?.id ?? '' }))
      setPending(option)
      setError(null)
      return
    }
    await send(option)
  }

  async function send(option: ExchangeOption) {
    const body = decisionBody(option, form)
    if (option === 'send_back' && !('note' in body && body.note))
      return setError('Write a short note for the author.')
    if (option === 'step_in' && !('text' in body && body.text))
      return setError('Write what you want to happen.')
    if (option === 'reassign' && !('to' in body && body.to)) return setError('Choose an agent.')
    const turns = 'turns' in body ? body.turns : undefined
    if (
      option === 'more_turns' &&
      !(typeof turns === 'number' && Number.isInteger(turns) && turns >= 1 && turns <= 20)
    )
      return setError('Choose between 1 and 20 turns.')
    const usd = Number(form.usd)
    if (option === 'more_spend' && (!Number.isFinite(usd) || usd <= 0 || usd > 1000))
      return setError('Enter an amount above 0 and at most 1000 dollars.')
    setBusy(true)
    setError(null)
    try {
      await apiFetch(`exchanges/${encodeURIComponent(exchange.id)}/decision`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      if (pauseIdentity !== null)
        setSent({
          pause: pauseIdentity,
          text: option === 'send_back' ? 'Sent back with your note.' : 'Decision sent.',
        })
      setPending(null)
      onAnswered?.()
    } catch (failure) {
      setError(decisionError(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <PinCard
      pinKey={`exchange:${exchange.id}`}
      since={exchange.updatedAt}
      label={exchangePauseTitle(exchange)}
      anchor={{ job: job.id }}
    >
      <div className="bold-request-head">
        {from && <AgentGlyph agent={from} size="xs" decorative mood="needs" />}
        <b style={from ? { color: agentNameColor(from) } : undefined}>
          {from ? agentDisplayName(from) : exchange.from}
        </b>
        {to && (
          <>
            <span className="muted">with</span>
            <b style={{ color: agentNameColor(to) }}>{agentDisplayName(to)}</b>
          </>
        )}
        <span className="bold-request-job">{job.title}</span>
      </div>
      <b className="bold-request-title">{exchangePauseTitle(exchange)}</b>
      <span>{exchangePauseAsk(exchange)}</span>
      {exchange.pause?.droppedAgents?.length ? (
        <span className="small">
          Also held back while this waits:{' '}
          {exchange.pause.droppedAgents
            .map((id) => {
              const agent = agents.find((item) => item.id === id)
              return agent ? agentDisplayName(agent) : id
            })
            .join(', ')}
          . Their turns were dropped; ask them again once this is settled.
        </span>
      ) : null}
      <span className="small muted">{exchangeTurns(exchange)}</span>

      {pending !== null && (
        <div className="bold-request-form">
          {pending === 'send_back' && (
            <label>
              Note for the author
              <textarea
                value={form.note}
                onChange={(event) => setForm({ ...form, note: event.target.value })}
                placeholder="Say what needs to change"
              />
            </label>
          )}
          {pending === 'step_in' && (
            <label>
              What should happen next?
              <textarea
                value={form.text}
                onChange={(event) => setForm({ ...form, text: event.target.value })}
                placeholder="Write the step in"
              />
            </label>
          )}
          {pending === 'reassign' && (
            <label>
              Give the turn to
              <select
                value={form.agent}
                onChange={(event) => setForm({ ...form, agent: event.target.value })}
              >
                {reassignChoices.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agentDisplayName(agent)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {pending === 'more_spend' && (
            <label>
              More spend in dollars
              <input
                type="number"
                min="0.01"
                max="1000"
                step="0.01"
                value={form.usd}
                onChange={(event) => setForm({ ...form, usd: event.target.value })}
              />
            </label>
          )}
          {pending === 'more_turns' && (
            <label>
              More turns (1–20)
              <input
                type="number"
                min="1"
                max="20"
                step="1"
                value={form.turns}
                onChange={(event) => setForm({ ...form, turns: event.target.value })}
              />
            </label>
          )}
          <span className="row wrap">
            <button
              type="button"
              className="btn sm"
              disabled={busy}
              onClick={() => void send(pending)}
            >
              {busy
                ? 'Sending…'
                : pending === 'more_turns'
                  ? form.turns.trim()
                    ? `Give ${form.turns} more turns`
                    : 'Give more turns'
                  : optionLabel(pending)}
            </button>
            <button
              type="button"
              className="btn sm ghost"
              disabled={busy}
              onClick={() => setPending(null)}
            >
              Cancel
            </button>
          </span>
        </div>
      )}

      {pending === null && !sentText && (
        <span className="row wrap">
          {options.map((option, index) => (
            <button
              key={option}
              type="button"
              className={`btn sm${index === 0 ? '' : ' ghost'}`}
              disabled={busy}
              onClick={() => void choose(option)}
            >
              {optionLabel(option)}
            </button>
          ))}
        </span>
      )}
      {sentText && (
        <span className="bold-request-sent" role="status">
          {sentText}
        </span>
      )}
      {error && (
        <span className="bold-request-error" role="alert">
          {error}
        </span>
      )}
    </PinCard>
  )
}

export function RoomExchanges({ jobs, agents }: { jobs: Job[]; agents: AgentSummary[] }) {
  const definition = useMemo(() => roomExchangesQuery(jobs.map((job) => job.id)), [jobs])
  const exchanges = useStreamQuery(definition).data ?? []
  const refetch = useStreamQueryRefetch(definition)
  const visible = exchanges.filter(needsYou)
  return (
    <>
      {visible.map((exchange) => {
        const job = jobs.find((item) => item.id === exchange.jobId)
        return job ? (
          <ExchangeRequestCard
            key={exchange.id}
            exchange={exchange}
            job={job}
            agents={agents}
            onAnswered={() => void refetch()}
          />
        ) : null
      })}
    </>
  )
}
