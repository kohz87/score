import { useState } from 'react'
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
import { LogsSection } from './LogsSection.tsx'
import { SharesSection } from './SharesSection.tsx'
import { RemoteSection } from './RemoteSection.tsx'
import { BackupSection } from './BackupSection.tsx'
import { TerminalSection } from './TerminalSection.tsx'
import { remoteTransport } from '../../data/session.ts'
import './settings.css'

const sections = [
  { id: 'models', label: 'Models and keys', built: true },
  { id: 'connections', label: 'Connections', built: true },
  { id: 'rules', label: 'Rules and approvals', built: true },
  { id: 'look', label: 'Look', built: true },
  { id: 'notifications', label: 'Notifications', built: true },
  { id: 'knowledge', label: 'Knowledge', built: true },
  { id: 'shares', label: 'Shares', built: true },
  { id: 'advanced', label: 'Advanced', built: true },
  { id: 'backup', label: 'Backup', built: true },
  { id: 'logs', label: 'Logs', built: true },
] as const

export function SettingsPage() {
  const agents = useStreamQuery(agentsQuery).data ?? []
  const narrow = useMediaQuery(NARROW_QUERY)
  const [jumpOpen, setJumpOpen] = useState(false)
  const [current, setCurrent] = useState<string>(sections[0].label)
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
                {current}
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
                {[
                  ...sections,
                  ...(remoteTransport()
                    ? [{ id: 'remote-access', label: 'Remote access', built: true }]
                    : []),
                ].map((section) => (
                  <a
                    key={section.id}
                    href={`#${section.id}`}
                    onClick={() => {
                      setCurrent(section.label)
                      setJumpOpen(false)
                    }}
                  >
                    {section.label}
                  </a>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            {sections.map((section) => (
              <a key={section.id} href={`#${section.id}`}>
                {section.label}
              </a>
            ))}
            <p>Settings for one agent live on their page in Team.</p>
            {remoteTransport() && <a href="#remote-access">Remote access</a>}
          </>
        )}
      </nav>
      <div className="settings-content">
        <HermesVersionBanner />
        <ProvidersSection agents={agents} />
        <ModelListSection agents={agents} />
        <ConnectionsSection agents={agents} />
        <RulesSection agents={agents} />
        <LookSection />
        <NotificationsSection />
        <KnowledgeSection />
        <SharesSection />
        <AdvancedSection />
        <BackupSection />
        <LogsSection />
        <RemoteSection />
        <TerminalSection />
      </div>
    </div>
  )
}
