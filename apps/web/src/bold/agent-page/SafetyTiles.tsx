import type { AgentDetail } from '@score/contract'
import { useRules } from '../../routes/settings/rules-queries.ts'
import { GoAheadCard, takenBackRules } from '../agent-more/GoAheadCard.tsx'
import { NeverAddForm, NeverCard } from '../agent-more/NeverCard.tsx'
import { runsOnLine, RunsOnCard } from '../BoldRunsOn.tsx'
import { useRunsOn } from '../runs-on-queries.ts'
import { AsksCard } from './AsksCard.tsx'
import { NameList } from './NameList.tsx'
import { OpenCard, useOpenState } from './OpenCard.tsx'

/*
 * The four Safety tiles (mock-up 26): a title, one line of state, one action. Each full card opens in place from its
 * tile's action; `initialOpen` opens it at once for a link made before the tidy-up. Each tile is a decision surface.
 */

export function RunsOnTile({ agent, initialOpen }: { agent: AgentDetail; initialOpen: boolean }) {
  const runsOn = useRunsOn(agent.id)
  const [open, setOpen] = useOpenState(initialOpen)
  return (
    <OpenCard
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      title="Where it works"
      protectedKind="block"
      summary={
        runsOn.isPending
          ? 'Reading Hermes…'
          : runsOn.isError
            ? 'Couldn’t read where it runs.'
            : runsOnLine(runsOn.data)
      }
      openLabel="Change where it works"
      openName="Change where it works"
    >
      <RunsOnCard agent={agent} />
    </OpenCard>
  )
}

export function AsksTile({ agent, initialOpen }: { agent: AgentDetail; initialOpen: boolean }) {
  const [open, setOpen] = useOpenState(initialOpen)
  const asks = agent.permissions.filter((row) => row.level === 'asks')
  return (
    <OpenCard
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      title="Asks you first before"
      protectedKind="block"
      summary={
        asks.length ? (
          <NameList names={asks.map((row) => row.label)} />
        ) : (
          'Nothing right now. The team rules apply.'
        )
      }
      openLabel={asks.length ? 'Change' : undefined}
      openName="Change what it asks you first about"
    >
      <AsksCard agent={agent} />
    </OpenCard>
  )
}

export function GoAheadTile({ agent, initialOpen }: { agent: AgentDetail; initialOpen: boolean }) {
  const rules = useRules()
  const [open, setOpen] = useOpenState(initialOpen)
  const goAhead = agent.permissions.filter((row) => row.level === 'allowed')
  const takenBack = takenBackRules(rules.data?.goAhead ?? [], goAhead)
  return (
    <OpenCard
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      title={`Goes ahead without asking · ${goAhead.length}`}
      protectedKind="block"
      summary={
        <>
          {goAhead.length ? (
            <NameList names={goAhead.map((row) => row.label)} />
          ) : (
            'Nothing. Risky commands follow the team’s approval style.'
          )}
          {takenBack.length > 0 && (
            <>
              {' '}
              · {takenBack.length} team {takenBack.length === 1 ? 'go-ahead' : 'go-aheads'} off here
            </>
          )}
        </>
      }
      openLabel={goAhead.length || takenBack.length ? 'Change' : undefined}
      openName="Change what goes ahead without asking"
    >
      <GoAheadCard agent={agent} />
    </OpenCard>
  )
}

export function NeverTile({ agent, initialOpen }: { agent: AgentDetail; initialOpen: boolean }) {
  const [open, setOpen] = useOpenState(initialOpen)
  const never = agent.permissions.filter((row) => row.level === 'never')
  return (
    <OpenCard
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      title={`Never rules · ${never.length}`}
      protectedKind="block"
      summary={
        <>
          <span>
            {never.length ? <NameList names={never.map((row) => row.label)} /> : 'Nothing yet.'}
          </span>
          <NeverAddForm agent={agent} />
        </>
      }
      openLabel={never.length ? 'Manage rules' : undefined}
      openName="Manage Never rules"
    >
      <NeverCard agent={agent} />
    </OpenCard>
  )
}
