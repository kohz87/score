import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, NavLink, useLocation, useParams } from 'react-router'
import { NARROW_QUERY, useMediaQuery } from '../../data/use-media.ts'
import { useStreamQuery } from '../../data/query-client.ts'
import { agentsQuery } from '../team/team-queries.ts'
import { AdvancedSection } from './AdvancedSection.tsx'
import { ConnectionsSection } from './ConnectionsSection.tsx'
import { RulesSection } from './RulesSection.tsx'
import { LookSection } from './LookSection.tsx'
import { NotificationsSection } from './NotificationsSection.tsx'
import { ModelListSection } from './ModelListSection.tsx'
import { ProvidersSection } from './ProvidersSection.tsx'
import { HermesVersionBanner } from './HermesVersionBanner.tsx'
import { KnowledgeSection } from '../knowledge/KnowledgeSection.tsx'
import { AboutSection } from './AboutSection.tsx'
import { LogsSection } from './LogsSection.tsx'
import { SharesSection } from './SharesSection.tsx'
import { RemoteSection } from './RemoteSection.tsx'
import { BackupSection } from './BackupSection.tsx'
import { TerminalSection } from './TerminalSection.tsx'
import { firstSection, settingsPath, useSettingsSections } from './settings-sections.ts'
import './settings.css'

/** The cards of one section. Models and keys is two cards; every other section is one. */
function SectionContent({ id, agents }: { id: string; agents: ReturnType<typeof useAgents> }) {
  switch (id) {
    case 'models':
      return (
        <>
          <ProvidersSection agents={agents} />
          <ModelListSection agents={agents} />
        </>
      )
    case 'connections':
      return <ConnectionsSection agents={agents} />
    case 'rules':
      return <RulesSection agents={agents} />
    case 'look':
      return <LookSection />
    case 'notifications':
      return <NotificationsSection />
    case 'knowledge':
      return <KnowledgeSection />
    case 'shares':
      return <SharesSection />
    case 'advanced':
      return <AdvancedSection />
    case 'backup':
      return <BackupSection />
    case 'logs':
      return <LogsSection />
    case 'about':
      return <AboutSection />
    case 'remote-access':
      return <RemoteSection />
    case 'terminal':
      return <TerminalSection />
    default:
      return null
  }
}

function useAgents() {
  return useStreamQuery(agentsQuery).data ?? []
}

export function SettingsPage() {
  const agents = useAgents()
  const narrow = useMediaQuery(NARROW_QUERY)
  const [jumpOpen, setJumpOpen] = useState(false)
  const { section: requested } = useParams()
  const { search, hash } = useLocation()
  const { sections, terminalPending } = useSettingsSections()
  const content = useRef<HTMLDivElement>(null)
  const shown = useRef<string | null>(null)
  const current = sections.find((entry) => entry.id === requested)
  // A deep link to Terminal waits for the status read that says whether it exists.
  const waiting = terminalPending && (requested ?? hash.slice(1)) === 'terminal'
  const currentId = current?.id
  const currentLabel = current?.label
  useEffect(() => {
    if (currentId === undefined) return
    const previous = shown.current
    shown.current = currentId
    const title = document.title
    document.title = `${currentLabel} · Settings · Score`
    if (previous !== null && previous !== currentId) {
      // Moving between sections lands on the new content: the top of the page and the section's heading.
      window.scrollTo(0, 0)
      const heading = [...(content.current?.querySelectorAll<HTMLElement>('h2') ?? [])].find(
        (candidate) => !candidate.closest('.settings-banner'),
      )
      const target = heading ?? content.current
      target?.setAttribute('tabindex', '-1')
      target?.focus({ preventScroll: true })
    }
    return () => {
      document.title = title
    }
  }, [currentId, currentLabel])
  if (waiting) return null
  if (!current) {
    // `/settings` (and an unknown section) shows the first one; `/settings#<id>` is the old way to name a section.
    const fromHash = sections.find((entry) => entry.id === hash.slice(1))
    const target = requested === undefined ? (fromHash ?? firstSection) : firstSection
    return <Navigate replace to={{ pathname: settingsPath(target.id), search }} />
  }
  return (
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">
        <h1>Settings</h1>
        {narrow ? (
          <>
            <button
              type="button"
              className="settings-jump"
              aria-expanded={jumpOpen}
              aria-controls="settings-jump-list"
              onClick={() => setJumpOpen((open) => !open)}
            >
              <span>
                <small>Section</small>
                {current.label}
              </span>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path
                  d="M3 5 L7 9 L11 5"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            {jumpOpen && (
              <div id="settings-jump-list" className="settings-jump-list">
                {sections.map((section) => (
                  <Link
                    key={section.id}
                    to={settingsPath(section.id)}
                    aria-current={section.id === current.id ? 'page' : undefined}
                    onClick={() => setJumpOpen(false)}
                  >
                    {section.label}
                  </Link>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            {sections.map((section) => (
              <NavLink key={section.id} to={settingsPath(section.id)}>
                {section.label}
              </NavLink>
            ))}
            <p>Settings for one agent are on that agent’s page in Team.</p>
          </>
        )}
      </nav>
      <div className="settings-content" ref={content}>
        <HermesVersionBanner />
        <SectionContent id={current.id} agents={agents} />
      </div>
    </div>
  )
}
