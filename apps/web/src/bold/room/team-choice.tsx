import { useId, useMemo, useState } from 'react'
import type { Room } from '@score/contract'
import { useStreamQuery } from '../../data/query-client.ts'
import { roomJobsQuery, teamRoomsQuery } from './room-queries.ts'

const NO_ROOMS: Room[] = []

export interface TeamChoice {
  /** The choosable teams (the first/everyone room first, archived ones left out). */
  teams: Room[]
  /** True only with more than one team: with one, nothing about the team shows on screen. */
  several: boolean
  /** The chosen team; null while there is a single team (callers use their own team-room read then). */
  chosen: Room | null
  choose: (id: string) => void
}

/** 3.6.0: the team a piece of work goes to. One team room means no choice and no change on screen. */
export function useTeamChoice(): TeamChoice {
  const all = useStreamQuery(teamRoomsQuery).data ?? NO_ROOMS
  const teams = useMemo(() => all.filter((room) => !room.archived), [all])
  const [picked, setPicked] = useState<string | null>(null)
  const several = teams.length > 1
  const chosen = several ? (teams.find((room) => room.id === picked) ?? teams[0] ?? null) : null
  return { teams, several, chosen, choose: setPicked }
}

/** The open jobs of the chosen team; empty until a team is chosen (several teams only). */
export function useChosenTeamJobs(choice: TeamChoice) {
  const definition = useMemo(() => roomJobsQuery(choice.chosen?.id ?? null), [choice.chosen?.id])
  return useStreamQuery(definition).data
}

export function TeamSelect({
  choice,
  label,
  disabled,
}: {
  choice: TeamChoice
  label: string
  disabled?: boolean
}) {
  const id = useId()
  if (!choice.several || !choice.chosen) return null
  return (
    <label className="bold-team-choice" htmlFor={id}>
      <span className="small muted">{label}</span>
      <select
        id={id}
        className="field"
        value={choice.chosen.id}
        disabled={disabled}
        onChange={(event) => choice.choose(event.target.value)}
      >
        {choice.teams.map((team) => (
          <option key={team.id} value={team.id}>
            {team.name}
          </option>
        ))}
      </select>
    </label>
  )
}
