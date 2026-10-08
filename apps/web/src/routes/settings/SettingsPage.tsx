import { useStreamQuery } from '../../data/query-client.ts'
import { agentsQuery } from '../team/team-queries.ts'
import { AdvancedSection } from './AdvancedSection.tsx'
import { ConnectionsSection } from './ConnectionsSection.tsx'
import { RulesSection } from './RulesSection.tsx'
import { ProvidersSection } from './ProvidersSection.tsx'
import './settings.css'

const sections = [
  { id: 'models', label: 'Models and keys', built: true },
  { id: 'connections', label: 'Connections', built: true },
  { id: 'rules', label: 'Rules and approvals', built: true },
  { id: 'plugins', label: 'Plugins and look', built: false },
  { id: 'advanced', label: 'Advanced', built: true },
] as const

export function SettingsPage() {
  const agents = useStreamQuery(agentsQuery).data ?? []
  return (
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">
        <h1>Settings</h1>
        {sections.map((section) => (
          <a key={section.id} href={`#${section.id}`}>
            {section.label}
          </a>
        ))}
        <p>Settings for one agent live on their page in Team.</p>
      </nav>
      <div className="settings-content">
        <ProvidersSection agents={agents} />
        <ConnectionsSection agents={agents} />
        <RulesSection agents={agents} />
        {sections
          .filter((section) => !section.built)
          .map((section) => (
            <section
              key={section.id}
              id={section.id}
              className="settings-card"
              aria-labelledby={`settings-${section.id}`}
            >
              <h2 id={`settings-${section.id}`}>{section.label}</h2>
              <p className="settings-muted-strong">Coming soon.</p>
            </section>
          ))}
        <AdvancedSection />
      </div>
    </div>
  )
}
