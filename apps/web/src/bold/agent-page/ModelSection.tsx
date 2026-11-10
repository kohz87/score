import { useState } from 'react'
import { useOpenState } from './OpenCard.tsx'
import type { AgentDetail, ModelSettings } from '@score/contract'
import { AliasEditor } from '../../components/model-settings/AliasEditor.tsx'
import { EffortSetting } from '../../components/model-settings/EffortSetting.tsx'
import { FallbackChain } from '../../components/model-settings/FallbackChain.tsx'
import { SpeechModels } from '../../components/model-settings/SpeechModels.tsx'
import { useModelSettings } from '../../routes/team/model-settings-queries.ts'
import { SubagentsCard } from '../agent-more/SubagentsCard.tsx'
import { EffortChatsCard } from '../efforts/EffortChatsCard.tsx'
import { useAgentEfforts } from '../efforts/effort-queries.ts'
import { ModelChatsCard } from '../models/ModelChatsCard.tsx'
import { useAgentChatModels } from '../models/model-queries.ts'
import { useRoutines } from '../../routes/team/routine-queries.ts'
import { useAgentSubagents } from '../subagents/subagent-queries.ts'
import { ModelChangeForm } from './ModelChangeForm.tsx'
import { ModelRow } from './ModelRow.tsx'
import {
  aliasSummary,
  fallbackSummary,
  speechSummary,
  subagentsSummary,
} from './model-summaries.ts'

type RowId = 'model' | 'effort' | 'fallback' | 'aliases' | 'voice' | 'subagents'

/**
 * Model (mock-up 26): one summary row per setting, each opening today's form for it in place. Rows open independently,
 * so opening one never drops another's unsaved draft.
 */
export function ModelSection({ agent, initialOpen }: { agent: AgentDetail; initialOpen?: string }) {
  const [open, setOpen] = useState<ReadonlySet<RowId>>(new Set())
  // A link to `#agent-subagents` opens that row, also when it arrives on a page that is already open.
  const [subagentsLinked, setSubagentsLinked] = useOpenState(initialOpen === 'subagents')
  const [chats, setChats] = useState(false)
  const [modelChats, setModelChats] = useState(false)
  const settings = useModelSettings(agent.id)
  const efforts = useAgentEfforts(agent.id).data
  const subagents = useAgentSubagents(agent.id).data
  const modelDiffering = useAgentChatModels(agent.id).data?.chats.length ?? 0
  // Repeating jobs with no model of their own follow the agent's, so they change when the agent's model does.
  const following = (useRoutines(agent.id).data ?? []).filter((routine) => !routine.model).length
  const data: ModelSettings | undefined = settings.data
  const isOpen = (row: RowId) => open.has(row) || (row === 'subagents' && subagentsLinked)
  const toggle = (row: RowId) => {
    const next = !isOpen(row)
    if (row === 'subagents') setSubagentsLinked(false)
    setOpen((now) => {
      const copy = new Set(now)
      if (next) copy.add(row)
      else copy.delete(row)
      return copy
    })
  }
  // A form that needs the Hermes settings says why it is empty instead of opening blank.
  const pending = settings.isError ? (
    <p role="alert" className="small">
      Couldn’t read this from Hermes. Try again later.
    </p>
  ) : (
    <p role="status" className="small muted">
      Reading Hermes…
    </p>
  )
  const differing = efforts?.chats.length ?? 0
  return (
    <section className="bold-agent-section" id="agent-model" aria-labelledby="agent-model-title">
      <h2 id="agent-model-title">Model</h2>
      <div className="bold-model-rows">
        <ModelRow
          id="agent-model-model"
          label="Model"
          summary={
            <>
              <b>{agent.model?.label ?? 'Model unavailable'}</b>
              {agent.model && (
                <span className="muted">
                  {' '}
                  · {agent.model.via ? `Through ${agent.model.via}.` : 'Provider unavailable.'}
                </span>
              )}
              <span className="small muted bold-model-note">
                Every chat uses this unless it sets its own with /model.
                {following > 0 && (
                  <>
                    {' '}
                    {following} repeating {following === 1 ? 'job follows' : 'jobs follow'} it.
                  </>
                )}
                {modelDiffering > 0 && (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="link"
                      aria-expanded={modelChats}
                      onClick={() => setModelChats((value) => !value)}
                    >
                      Set differently in {modelDiffering} {modelDiffering === 1 ? 'chat' : 'chats'}
                    </button>
                  </>
                )}
              </span>
            </>
          }
          action="Change"
          actionLabel="Change the model"
          open={isOpen('model')}
          onToggle={() => toggle('model')}
        >
          <ModelChangeForm agent={agent} />
        </ModelRow>
        {modelChats && modelDiffering > 0 && (
          <ModelChatsCard agentId={agent.id} own={agent.model?.id} />
        )}
        <ModelRow
          id="agent-model-effort"
          label="Default effort"
          summary={
            <>
              {data ? (data.effort ?? '') || 'The model’s default' : 'Reading Hermes…'}
              <span className="small muted bold-model-note">
                Every chat uses this unless it sets its own with /effort.
                {differing > 0 && (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="link"
                      aria-expanded={chats}
                      onClick={() => setChats((value) => !value)}
                    >
                      Set differently in {differing} {differing === 1 ? 'chat' : 'chats'}
                    </button>
                  </>
                )}
              </span>
            </>
          }
          action="Change"
          actionLabel="Change default effort"
          open={isOpen('effort')}
          onToggle={() => toggle('effort')}
        >
          {data ? (
            <EffortSetting key={data.effort ?? ''} agentId={agent.id} settings={data} />
          ) : (
            pending
          )}
        </ModelRow>
        {chats && differing > 0 && <EffortChatsCard agentId={agent.id} />}
        <ModelRow
          id="agent-model-fallback"
          label="If it’s unavailable"
          summary={fallbackSummary(agent, data)}
          action={data && data.fallbacks.length > 0 ? 'Edit' : 'Add fallback'}
          actionLabel={data && data.fallbacks.length > 0 ? 'Edit fallback models' : 'Add fallback'}
          open={isOpen('fallback')}
          onToggle={() => toggle('fallback')}
        >
          {data ? (
            <FallbackChain
              key={JSON.stringify(data.fallbacks)}
              agentId={agent.id}
              settings={data}
            />
          ) : (
            pending
          )}
        </ModelRow>
        <ModelRow
          id="agent-model-aliases"
          label="Model aliases"
          summary={aliasSummary(data)}
          action="Edit"
          actionLabel="Edit model aliases"
          open={isOpen('aliases')}
          onToggle={() => toggle('aliases')}
        >
          <AliasEditor agentId={agent.id} />
        </ModelRow>
        <ModelRow
          id="agent-model-voice"
          label="Voice"
          summary={speechSummary(data)}
          action="Edit"
          actionLabel="Edit voice"
          open={isOpen('voice')}
          onToggle={() => toggle('voice')}
        >
          {data ? (
            <SpeechModels key={JSON.stringify(data.speech)} agentId={agent.id} settings={data} />
          ) : (
            pending
          )}
        </ModelRow>
        <ModelRow
          id="agent-subagents"
          label="Subagents"
          summary={subagentsSummary(subagents)}
          action="Edit"
          actionLabel="Edit subagents"
          open={isOpen('subagents')}
          onToggle={() => toggle('subagents')}
        >
          <SubagentsCard agent={agent} />
        </ModelRow>
      </div>
      {settings.isError && (
        <p role="alert">
          Couldn’t read this agent’s fallback, alias and speech settings from Hermes.
        </p>
      )}
    </section>
  )
}
