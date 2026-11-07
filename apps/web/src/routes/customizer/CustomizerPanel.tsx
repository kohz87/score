import type { ThemeSummary } from '@score/contract'
import { freshId } from '../../themes/customizer/draft.ts'
import { Tabs, type TabId } from './CustomizerTabs.tsx'
import type { Target } from './customizer-types.ts'
import { SectionBackground } from './SectionBackground.tsx'
import { SectionColours } from './SectionColours.tsx'
import { SectionCss } from './SectionCss.tsx'
import { SectionFonts } from './SectionFonts.tsx'
import { SectionShape } from './SectionShape.tsx'
import { SectionSpacing } from './SectionSpacing.tsx'
import { SectionTheme } from './SectionTheme.tsx'
import type { SectionContext } from './section-context.ts'

type PanelProps = {
  tab: TabId
  setTab: (tab: TabId) => void
  context: SectionContext
  themes: ThemeSummary[]
  target: Target
  takenIds: string[]
  dirty: boolean
  setAskStart: (id: string | null) => void
  startFrom: (id: string) => void
}

export function CustomizerPanel({
  tab,
  setTab,
  context,
  themes,
  target,
  takenIds,
  dirty,
  setAskStart,
  startFrom,
}: PanelProps) {
  return (
    <section className="cz-controls" aria-label="Edit the theme">
      <Tabs value={tab} onChange={setTab} />
      <div
        className="cz-panel"
        role="tabpanel"
        id={`cz-panel-${tab}`}
        aria-labelledby={`cz-tab-${tab}`}
        tabIndex={-1}
      >
        {tab === 'theme' && (
          <SectionTheme
            {...context}
            themes={themes}
            exists={target.exists}
            source={target.source}
            idFor={(name) => freshId(name, takenIds)}
            startFrom={(id) => (dirty ? setAskStart(id) : void startFrom(id))}
          />
        )}
        {tab === 'colours' && <SectionColours {...context} />}
        {tab === 'background' && <SectionBackground {...context} />}
        {tab === 'fonts' && <SectionFonts {...context} />}
        {tab === 'shape' && <SectionShape {...context} />}
        {tab === 'spacing' && <SectionSpacing {...context} />}
        {tab === 'css' && <SectionCss {...context} />}
      </div>
    </section>
  )
}
