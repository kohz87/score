import type { AgentQuestion, AgentSummary } from '@score/contract'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import {
  questionDeadline,
  questionNeedsYou,
  questionOutcome,
  useAnswerQuestion,
} from '../../data/question-queries.ts'
import { agentDisplayName, agentNameColor } from '../bold-agents.ts'
import { PinCard } from './PinCards.tsx'

const MAX_ANSWER = 16384
const MAX_TEXTAREA_PX = 240

/**
 * An agent's question as a needs-you card (decision 128): the agent's glyph, the question as plain text, then pills for
 * its options or a text box. Nothing here is an approval; Guardian and rules never answer it. The card never takes
 * focus on arrival; its question text is the label of the first input, so opening it (a click, a tap) moves focus there.
 */
export function QuestionCard({
  question,
  agent,
  jobTitle,
}: {
  question: AgentQuestion
  agent: AgentSummary | undefined
  jobTitle?: string | undefined
}) {
  const { posted, busy, error, answer } = useAnswerQuestion(question.id)
  const [picked, setPicked] = useState<string[]>([])
  const [text, setText] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)
  const inputId = useId()
  // The POST response is fresher than the list until the stream catches up.
  const current = posted && question.delivery === 'none' ? posted : question
  const name = agent ? agentDisplayName(agent) : current.agentId
  const delivering = busy || current.delivery === 'delivering'
  const failed = current.delivery === 'failed' && !delivering
  const deadline = questionDeadline(current)
  const free = current.options.length === 0

  useEffect(() => {
    const element = box.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, MAX_TEXTAREA_PX)}px`
  }, [text])

  if (!questionNeedsYou(current) && !delivering) return null

  function send(value: string | string[]) {
    void answer(value)
  }
  function sendText() {
    const value = text.trim()
    if (value && !delivering) send(value)
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    sendText()
  }
  function toggle(option: string) {
    setPicked((now) =>
      now.includes(option) ? now.filter((item) => item !== option) : [...now, option],
    )
  }

  return (
    <PinCard
      pinKey={`question:${question.id}`}
      since={question.createdAt}
      label={`${name} asks`}
      variant="question"
      region
    >
      <div className="bold-request-head">
        {agent && <AgentGlyph agent={agent} size="xs" decorative mood="needs" />}
        <b style={agent ? { color: agentNameColor(agent) } : undefined}>{name} asks</b>
        {jobTitle && <span className="bold-request-job">{jobTitle}</span>}
      </div>
      {free ? (
        <label className="bold-question-text" htmlFor={inputId}>
          {current.question}
        </label>
      ) : (
        <p className="bold-question-text">{current.question}</p>
      )}
      {free ? (
        <div className="bold-request-form bold-question-form">
          <textarea
            id={inputId}
            ref={box}
            rows={2}
            maxLength={MAX_ANSWER}
            value={text}
            disabled={delivering}
            placeholder="Type your answer"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <span className="row wrap">
            <button
              type="button"
              className="btn sm"
              disabled={delivering || !text.trim()}
              onClick={sendText}
            >
              Send
            </button>
          </span>
        </div>
      ) : current.multiSelect ? (
        <span className="row wrap bold-question-options" role="group" aria-label="Options">
          {current.options.map((option) => (
            <button
              key={option}
              type="button"
              className={`btn sm bold-question-pill${picked.includes(option) ? '' : ' ghost'}`}
              aria-pressed={picked.includes(option)}
              disabled={delivering}
              onClick={() => toggle(option)}
            >
              {option}
            </button>
          ))}
          <button
            type="button"
            className="btn sm"
            disabled={delivering || picked.length === 0}
            onClick={() => send(current.options.filter((option) => picked.includes(option)))}
          >
            Send
          </button>
        </span>
      ) : (
        <span className="row wrap bold-question-options" role="group" aria-label="Options">
          {current.options.map((option) => (
            <button
              key={option}
              type="button"
              className="btn sm bold-question-pill"
              disabled={delivering}
              onClick={() => send(option)}
            >
              {option}
            </button>
          ))}
        </span>
      )}
      {delivering && (
        <span className="bold-request-sent" role="status">
          Delivering…
        </span>
      )}
      {failed && (
        <span className="bold-request-failed" role="alert">
          Couldn’t deliver, try again
        </span>
      )}
      {error && (
        <span className="bold-request-error" role="alert">
          {error}
        </span>
      )}
      {deadline && <span className="small muted bold-question-deadline">{deadline}</span>}
    </PinCard>
  )
}

/** The muted line where an ended question was asked: "builder asked: … — you answered: …". */
export function QuestionNote({
  question,
  agents,
}: {
  question: AgentQuestion
  agents: AgentSummary[]
}) {
  const agent = agents.find((item) => item.id === question.agentId)
  const asked =
    question.question.length > 140 ? `${question.question.slice(0, 140)}…` : question.question
  return (
    <p className="bold-question-note" data-question-id={question.id}>
      {agent ? agentDisplayName(agent) : question.agentId} asked: {asked} —{' '}
      {questionOutcome(question)}
    </p>
  )
}

/**
 * One live-region sentence ("builder has a question") the first time a pending question shows up after the first read,
 * once per question. Questions that were already waiting when the room opened are not announced.
 */
export function useQuestionAnnouncement(
  pending: AgentQuestion[],
  ready: boolean,
  agents: AgentSummary[],
): string {
  const seen = useRef<Set<string> | null>(null)
  const [text, setText] = useState('')
  useEffect(() => {
    if (!ready) return
    if (seen.current === null) {
      seen.current = new Set(pending.map((item) => item.id))
      return
    }
    // Nothing left to answer: the sentence goes, so the strip's own "N need you" is announced again.
    if (pending.length === 0) queueMicrotask(() => setText(''))
    const fresh = pending.filter((item) => !seen.current!.has(item.id))
    for (const item of fresh) seen.current.add(item.id)
    const first = fresh[0]
    if (!first) return
    const agent = agents.find((item) => item.id === first.agentId)
    const sentence = `${agent ? agentDisplayName(agent) : first.agentId} has a question`
    // A status region only announces text that changes: clear it first so the same sentence can announce again.
    setText('')
    queueMicrotask(() => setText(sentence))
  }, [agents, pending, ready])
  return text
}
