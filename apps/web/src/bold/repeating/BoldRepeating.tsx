import type { AgentSummary } from '@score/contract'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { useStreamQuery } from '../../data/query-client.ts'
import { useMediaQuery } from '../../data/use-media.ts'
import { agentsQuery, roomsQuery } from '../../routes/chat/queries.ts'
import { agentDisplayName, onTeam } from '../bold-agents.ts'
import { Chips } from '../BoldTasksFilters.tsx'
import { Sheet } from '../BoldTasksSheet.tsx'
import { isCodingAgent } from '../models/model-model.ts'
import { RepeatingCards, RepeatingTable } from './RepeatingList.tsx'
import { RepeatingPanel } from './RepeatingPanel.tsx'
import { TasksHeader } from '../tasks-tabs/TasksHeader.tsx'
import {
  RECIPES_FILTER,
  agentCounts,
  filterRows,
  jobRow,
  recipeRow,
  type Row,
  type RowFilter,
} from './repeating-rows.ts'
import { useRecipeSchedules, useRepeatingActions, useRepeatingJobs } from './repeating-queries.ts'
import './bold-repeating.css'

// Tasks › Repeating (TR.2, decision 183): one list of every repeating job, an agent's Hermes cron job or a recipe's
// schedule. Mock-ups: docs/design/bold/mockups/28-tasks-main, 28-tasks-edit, 28-tasks-phone (.dc.html).

const PHONE = '(max-width: 600px)'
const WIDE = '(min-width: 1280px)'

/** `null` is the "New repeating job" panel; a row is the job being edited. */
type Open = { job: NonNullable<Row['job']> | null } | null

export function BoldRepeatingPage() {
  const phone = useMediaQuery(PHONE)
  const wide = useMediaQuery(WIDE)
  const jobs = useRepeatingJobs()
  const schedules = useRecipeSchedules()
  const agentsState = useStreamQuery(agentsQuery)
  const roomsState = useStreamQuery(roomsQuery)
  const actions = useRepeatingActions()
  // The agent page's Assigned links: ?agent={id} filters to that agent, ?new=1&agent={id} opens the new-job panel with
  // that agent assigned.
  const [params] = useSearchParams()
  const wanted = params.get('agent')
  const [filter, setFilter] = useState<RowFilter>(wanted)
  const [open, setOpen] = useState<Open>(null)
  const [wantsNew, setWantsNew] = useState(params.get('new') === '1')
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const agents = useMemo(() => (agentsState.data ?? []).filter(onTeam), [agentsState.data])
  const hermes = useMemo(() => agents.filter((agent) => !isCodingAgent(agent)), [agents])
  const rooms = useMemo(() => roomsState.data?.rooms ?? [], [roomsState.data])
  const directs = useMemo(() => roomsState.data?.directs ?? [], [roomsState.data])
  const directIds = useMemo(() => new Set(directs.map((room) => room.id)), [directs])
  const rows = useMemo(
    () => [
      ...(jobs.data?.items ?? []).map((job) => jobRow(job, agents, directIds)),
      ...(schedules.data?.items ?? []).map((item) => recipeRow(item, now)),
    ],
    [jobs.data, schedules.data, agents, directIds, now],
  )
  const active =
    filter !== null && (filter === RECIPES_FILTER || rows.some((row) => row.agentId === filter))
      ? filter
      : null
  const shown = filterRows(rows, active)
  const byId = (id: string) => agents.find((agent: AgentSummary) => agent.id === id)
  const recipeCount = rows.filter((row) => row.kind === 'recipe').length
  const options = [
    { id: null, label: `Everyone · ${rows.length}` },
    ...agentCounts(rows).map(([id, count]) => {
      const agent = byId(id)
      return {
        id,
        label: `${agent ? agentDisplayName(agent) : id} · ${count}`,
        ...(agent ? { agent } : {}),
      }
    }),
    ...(recipeCount > 0 ? [{ id: RECIPES_FILTER, label: `Recipes · ${recipeCount}` }] : []),
  ]
  const unreadable = jobs.data?.unreadable ?? []
  const loading = (jobs.isPending || schedules.isPending) && rows.length === 0
  const failed = jobs.isError && !jobs.data
  const [notice, setNotice] = useState<string | null>(null)

  const run = (row: Row) => {
    setNotice(null)
    const started =
      row.kind === 'recipe'
        ? actions.runRecipe.mutateAsync(row.id)
        : actions.run.mutateAsync(row.id)
    started.then(
      () => setNotice(`Started ${row.title}.`),
      () => setNotice(`Couldn’t start ${row.title}. Try again.`),
    )
  }
  const busy = actions.run.isPending || actions.runRecipe.isPending
  const preferred = [wanted, active].find((id) => id && hermes.some((a) => a.id === id))
  const firstAgentId = preferred ?? hermes[0]?.id ?? ''
  const close = () => {
    setOpen(null)
    setWantsNew(false)
  }
  // The link's panel opens once the agents are known, so the form starts with the right one.
  const opened: Open = open ?? (wantsNew && hermes.length > 0 ? { job: null } : null)
  const label = opened?.job ? `Edit ${opened.job.title}` : 'New repeating job'
  const panel = opened && (
    <RepeatingPanel
      key={opened.job?.id ?? 'new'}
      job={opened.job}
      agents={hermes}
      rooms={rooms}
      directs={directs}
      firstAgentId={firstAgentId}
      now={now}
      onClose={close}
    />
  )
  const list = {
    rows: shown,
    agents,
    now,
    busy,
    onRun: run,
    onEdit: (row: Row) => {
      setWantsNew(false)
      setOpen({ job: row.job })
    },
  }

  return (
    <div className="bold-page bold-tb bold-rj" data-ui-page="tasks">
      <TasksHeader
        action={
          <button
            type="button"
            className="bold-rj-new"
            aria-label="New repeating job"
            disabled={hermes.length === 0}
            onClick={() => {
              setWantsNew(false)
              setOpen({ job: null })
            }}
          >
            {phone ? '+' : '+ New repeating job'}
          </button>
        }
      >
        Work that runs on a schedule, across the team. Assign it to an agent, or to a recipe (Tasks
        › Recipes) when several agents take part.
      </TasksHeader>
      {loading && <p role="status">Reading repeating jobs…</p>}
      {failed && <p role="alert">Couldn’t read the repeating jobs. Try again in a moment.</p>}
      {unreadable.length > 0 && (
        <p role="alert" className="bold-rj-unreadable">
          Couldn’t read the jobs of{' '}
          {unreadable
            .map((id) => {
              const agent = byId(id)
              return agent ? agentDisplayName(agent) : id
            })
            .join(', ')}
          . They are missing from this list.
        </p>
      )}
      {schedules.isError && <p role="alert">Couldn’t read the recipe schedules.</p>}
      {notice && <p role="status">{notice}</p>}
      {!loading && !failed && rows.length === 0 && (
        <p className="bold-tb-none">No repeating jobs yet. Add one, and it runs on its schedule.</p>
      )}
      {rows.length > 0 && (
        <Chips label="Assigned to" options={options} value={active} onPick={setFilter} />
      )}
      <div className={`bold-rj-layout${opened && wide ? ' has-panel' : ''}`}>
        <div className="bold-rj-main">
          {rows.length > 0 && (phone ? <RepeatingCards {...list} /> : <RepeatingTable {...list} />)}
        </div>
        {opened && wide && (
          <aside className="bold-rj-aside" aria-label={label}>
            {panel}
          </aside>
        )}
      </div>
      {rows.length > 0 && (
        <p className="bold-rj-footnote">
          An agent’s job runs in Hermes even when Score is closed. A recipe’s runs are started by
          Score, so Score has to be running at that time; a run it missed shows here as missed, with
          Run now.
        </p>
      )}
      {opened && !wide && (
        <Sheet side={!phone} onClose={close} label={label} className="bold-rj-sheet">
          {panel}
        </Sheet>
      )}
    </div>
  )
}
