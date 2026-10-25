import { useState, type FormEvent } from 'react'
import type { AgentDetail } from '@score/contract'
import { useHubSearch, useSkillActions, useSkills } from '../../routes/team/agent-tab-queries.ts'
import { tabFailure } from '../../routes/team/tab-errors.ts'
import { CloseIcon, PlusIcon } from '../BoldIcons.tsx'
import { Fail, Loading, MoreCard, useFoldedList } from './MoreCard.tsx'

/** Skills are switched off rather than deleted (Hermes keeps them installed), so ✕ turns one off and + turns it on. */
export function SkillsCard({ agent }: { agent: AgentDetail }) {
  const skills = useSkills(agent.id)
  const { toggle, install } = useSkillActions(agent.id)
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const hub = useHubSearch(query)
  const items = skills.data ?? []
  const list = useFoldedList(`skills:${agent.id}`, items, 12)

  function search(event: FormEvent) {
    event.preventDefault()
    setQuery(draft.trim())
  }
  return (
    <MoreCard id="agent-skills" title="Skills">
      {skills.isPending && <Loading what="skills" />}
      {skills.isError && (
        <Fail>
          Couldn’t load skills.{' '}
          <button type="button" className="link" onClick={() => void skills.refetch()}>
            Try again
          </button>
        </Fail>
      )}
      {skills.isSuccess && !items.length && <p className="small muted">No skills installed.</p>}
      {toggle.isError && <Fail>{tabFailure(toggle.error, 'change the skill')}</Fail>}
      <div id={list.id} className="row wrap">
        {list.shown.map((skill) => (
          <span className={`chip${skill.enabled ? '' : ' bold-mc-off'}`} key={skill.name}>
            {skill.name}
            <button
              type="button"
              className="act"
              aria-label={`${skill.enabled ? 'Turn off' : 'Turn on'} ${skill.name}`}
              disabled={toggle.isPending}
              onClick={() => toggle.mutate({ name: skill.name, enabled: !skill.enabled })}
            >
              {skill.enabled ? <CloseIcon size={12} /> : <PlusIcon size={12} />}
            </button>
          </span>
        ))}
      </div>
      {list.toggle}
      <form className="row" onSubmit={search} role="search" aria-label="Search the skills hub">
        <label htmlFor={`newskill-${agent.id}`} className="sr">
          Find a skill
        </label>
        <input
          id={`newskill-${agent.id}`}
          className="field"
          maxLength={200}
          placeholder="Search the skills hub"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="btn sm" disabled={!draft.trim()}>
          Search
        </button>
      </form>
      {hub.isFetching && (
        <p role="status" className="small muted">
          Searching…
        </p>
      )}
      {hub.isError && <Fail>Couldn’t search the skills hub. Try again.</Fail>}
      {hub.isSuccess && !hub.data.length && (
        <p className="small muted">No skills found for “{query}”.</p>
      )}
      {install.isError && <Fail>{tabFailure(install.error, 'install the skill')}</Fail>}
      {(hub.data ?? []).map((row) => {
        const installed = items.some((skill) => skill.name === row.name)
        return (
          <div className="listrow wrap" key={row.identifier}>
            <span className="grow small">
              <b>{row.name}</b> <span className="muted">{row.description}</span>
            </span>
            <button
              type="button"
              className="btn sm"
              disabled={installed || install.isPending}
              aria-label={`${installed ? 'Installed' : 'Add'} ${row.name}`}
              onClick={() => install.mutate(row.identifier)}
            >
              {installed ? 'Added' : 'Add'}
            </button>
          </div>
        )
      })}
    </MoreCard>
  )
}
