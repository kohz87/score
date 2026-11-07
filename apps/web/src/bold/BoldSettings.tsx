import { lazy, Suspense, useEffect, useRef } from 'react'
import { Navigate, useLocation, useNavigate, useParams } from 'react-router'
import { useStreamQuery } from '../data/query-client.ts'
import { AdvancedSection } from '../routes/settings/AdvancedSection.tsx'
import { NotificationsSection } from '../routes/settings/NotificationsSection.tsx'
import { RulesSection } from '../routes/settings/RulesSection.tsx'
import { HermesVersionBanner } from '../routes/settings/HermesVersionBanner.tsx'
import { agentsQuery } from '../routes/team/team-queries.ts'
import { roomsQuery } from '../routes/chat/queries.ts'
import { BoldSecurity } from './BoldSecurity.tsx'
import { BoldConnections } from './BoldConnections.tsx'
import { BoldLook } from './BoldLook.tsx'
import { BoldSystem } from './BoldSystem.tsx'
import { BoldRecipesPage } from './BoldRecipes.tsx'
import { BoldTools } from './BoldTools.tsx'
import { BoldUsage } from './BoldUsage.tsx'
import { BoldWorkspaces } from './BoldWorkspaces.tsx'
import '../routes/settings/settings.css'
import './bold-settings-shell.css'
import './bold-settings-rules.css'
import './bold-settings-advanced.css'
import './bold-settings-security.css'
import './bold-settings-system.css'
import './bold-settings-usage.css'
import './bold-settings-connections.css'
import './bold-settings-tools.css'
import './bold-settings-triggers.css'
import './bold-settings-look.css'
import './bold-settings-responsive.css'
import './bold-settings-workspaces.css'

// The Customizer brings CodeMirror and the preview machinery: it loads when Look › Customizer is opened.
const Customizer = lazy(async () => ({
  default: (await import('../routes/customizer/Customizer.tsx')).Customizer,
}))

type SettingsSection =
  | 'connections'
  | 'workspaces'
  | 'tools'
  | 'recipes'
  | 'rules'
  | 'notifications'
  | 'look'
  | 'usage'
  | 'security'
  | 'advanced'
  | 'system'

type SettingsItem = {
  id: SettingsSection
  title: string
  description: string
  phase?: '11.9a' | '11.9b'
}

// Prototype SECS (docs/design/bold/prototype.html), which supersedes board 05's four groups.
export const SETTINGS_SECTIONS: readonly SettingsItem[] = [
  {
    id: 'connections',
    title: 'Connections',
    description: 'Hermes, models, channels',
    phase: '11.9a',
  },
  {
    id: 'workspaces',
    title: 'Workspaces',
    description: 'Folders agents share',
  },
  {
    id: 'tools',
    title: 'Tools and triggers',
    description: 'Apps agents use; webhooks that start jobs',
    phase: '11.9a',
  },
  {
    id: 'recipes',
    title: 'Recipes',
    description: 'Saved plans agents run',
  },
  { id: 'rules', title: 'Rules', description: 'What agents may do alone', phase: '11.9b' },
  {
    id: 'notifications',
    title: 'Notifications',
    description: 'What reaches you, where',
    phase: '11.9b',
  },
  { id: 'look', title: 'Look', description: 'Dark or light, motion, text', phase: '11.9a' },
  { id: 'usage', title: 'Usage', description: 'What got done, what it cost' },
  {
    id: 'security',
    title: 'Remote access and security',
    description: 'Paired devices, password, terminal',
    phase: '11.9b',
  },
  { id: 'advanced', title: 'Advanced', description: 'Every Hermes setting', phase: '11.9b' },
  { id: 'system', title: 'System', description: 'Service, backups, logs', phase: '11.9b' },
]

function isSettingsSection(value: string | undefined): value is SettingsSection {
  return SETTINGS_SECTIONS.some((section) => section.id === value)
}

function Section({
  section,
  agents,
}: {
  section: SettingsSection
  agents: ReturnType<typeof useAgents>
}) {
  const rooms = useStreamQuery(roomsQuery).data?.rooms ?? []
  switch (section) {
    case 'connections':
      return <BoldConnections agents={agents} />
    case 'workspaces':
      return <BoldWorkspaces agents={agents} rooms={rooms} />
    case 'tools':
      return <BoldTools agents={agents} />
    case 'recipes':
      return <BoldRecipesPage />
    case 'look':
      return <BoldLook />
    case 'rules':
      return <RulesSection agents={agents} heading="Rules" />
    case 'notifications':
      return <NotificationsSection />
    case 'security':
      return <BoldSecurity />
    case 'advanced':
      return <AdvancedSection />
    case 'system':
      return <BoldSystem />
    case 'usage':
      return <BoldUsage />
    default:
      return <BoldUsage />
  }
}

function useAgents() {
  return useStreamQuery(agentsQuery).data ?? []
}

/** PLAN 11.9a–c: the bold shell's Settings frame. */
export function BoldSettings() {
  const params = useParams()
  const navigate = useNavigate()
  const agents = useAgents()
  const location = useLocation()
  // Decision 131 E: /b/settings/look/customize[/:themeId] is the Customizer, framed by Settings with Look selected.
  const customizing = /^\/b\/settings\/look\/customize(\/|$)/.test(location.pathname)
  // 3.27.0: /b/settings/recipes/:workflowId is a recipe in the Recipes section (that route has no :section).
  const recipe = /^\/b\/settings\/recipes(\/|$)/.test(location.pathname)
  // 3.29.0: the editor (a recipe, or a new one) fills the page without the Settings list; the library steps the list aside on a phone.
  const recipeEditor = /^\/b\/settings\/recipes\/[^/]+/.test(location.pathname)
  const section = customizing
    ? 'look'
    : recipe
      ? 'recipes'
      : isSettingsSection(params.section)
        ? params.section
        : 'usage'
  // A section is a page of its own: moving to another one starts at its top (a #hash link keeps its anchor).
  const shown = useRef(section)
  useEffect(() => {
    if (shown.current === section) return
    shown.current = section
    if (!location.hash) window.scrollTo(0, 0)
  }, [section, location.hash])
  // An unknown section is not silently Usage under its own name.
  if (params.section !== undefined && !isSettingsSection(params.section))
    return <Navigate to="/b/settings/usage" replace />
  return (
    <div className={`page bold-settings-page${recipeEditor ? ' page--wide' : ''}`}>
      <div
        className="setgrid"
        data-section-page={
          customizing ? true : recipeEditor ? 'editor' : recipe ? 'library' : undefined
        }
      >
        <nav className="setnav" aria-label="Settings">
          <h1>Settings</h1>
          {SETTINGS_SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={section === item.id ? 'on' : undefined}
              aria-current={section === item.id ? 'page' : undefined}
              onClick={() => void navigate(`/b/settings/${item.id}`)}
            >
              <b>{item.title}</b>
              <span className="small muted">{item.description}</span>
            </button>
          ))}
        </nav>
        <div className="setmain">
          {customizing && (
            <button
              type="button"
              className="bold-settings-all"
              onClick={() => void navigate('/b/settings')}
            >
              ‹ All settings
            </button>
          )}
          <HermesVersionBanner />
          {customizing ? (
            <Suspense fallback={<p role="status">Opening the Customizer…</p>}>
              <Customizer />
            </Suspense>
          ) : (
            <Section section={section} agents={agents} />
          )}
        </div>
      </div>
    </div>
  )
}
