import { useState, type FormEvent } from 'react'
import { useHubSearch, useSkillActions, useSkills } from './agent-tab-queries.ts'
import { tabFailure } from './tab-errors.ts'

export function SkillsTab({ agentId, agentName }: { agentId: string; agentName: string }) {
  const skills = useSkills(agentId)
  const { toggle, install } = useSkillActions(agentId)
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const hub = useHubSearch(query)
  const [notice, setNotice] = useState('')
  const items = skills.data ?? []

  function search(event: FormEvent) {
    event.preventDefault()
    setQuery(draft.trim())
  }
  return (
    <div className="team-stack">
      <section className="team-card" aria-labelledby="team-skills-heading">
        <h2 id="team-skills-heading">Skills</h2>
        {skills.isPending && <p role="status">Loading skills…</p>}
        {skills.isError && (
          <p role="alert">
            Couldn’t load skills. <button onClick={() => void skills.refetch()}>Try again</button>
          </p>
        )}
        {skills.isSuccess && !items.length && (
          <p className="team-muted-strong">No skills installed.</p>
        )}
        {toggle.isError && <p role="alert">{tabFailure(toggle.error, 'change the skill')}</p>}
        <ul className="team-rows">
          {items.map((skill) => (
            <li key={skill.name}>
              <span>{skill.name}</span>
              <button
                type="button"
                role="switch"
                className="team-toggle"
                data-enabled={skill.enabled}
                aria-checked={skill.enabled}
                aria-label={`${skill.name} enabled for ${agentName}`}
                disabled={toggle.isPending}
                onClick={() => {
                  setNotice('')
                  toggle.mutate({ name: skill.name, enabled: !skill.enabled })
                }}
              />
            </li>
          ))}
        </ul>
      </section>

      <section className="team-card" aria-labelledby="team-hub-heading">
        <h2 id="team-hub-heading">Skills hub</h2>
        <form
          className="team-search"
          role="search"
          aria-label="Search the skills hub"
          onSubmit={search}
        >
          <input
            type="search"
            aria-label="Search skills"
            placeholder="Search for a skill"
            maxLength={200}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" disabled={!draft.trim()}>
            Search
          </button>
        </form>
        <p className="team-muted" role="status">
          {notice}
        </p>
        {hub.isFetching && <p role="status">Searching…</p>}
        {hub.isError && <p role="alert">Couldn’t search the skills hub. Try again.</p>}
        {hub.isSuccess && !hub.data.length && (
          <p className="team-muted-strong">No skills found for “{query}”.</p>
        )}
        {install.isError && <p role="alert">{tabFailure(install.error, 'install the skill')}</p>}
        <ul className="team-rows">
          {(hub.data ?? []).map((row) => {
            const installed = items.some((skill) => skill.name === row.name)
            return (
              <li key={row.identifier}>
                <span>
                  <strong>{row.name}</strong>
                  {row.source && <small> {row.source}</small>}
                  <span className="team-muted-strong team-block">{row.description}</span>
                </span>
                <button
                  type="button"
                  className="team-pill-button"
                  disabled={installed || install.isPending}
                  aria-label={`${installed ? 'Installed' : 'Install'} ${row.name}`}
                  onClick={() =>
                    install.mutate(row.identifier, {
                      onSuccess: () => setNotice(`Installed ${row.name} for ${agentName}.`),
                    })
                  }
                >
                  {installed ? 'Installed' : install.isPending ? 'Installing…' : 'Install'}
                </button>
              </li>
            )
          })}
        </ul>
      </section>
    </div>
  )
}
