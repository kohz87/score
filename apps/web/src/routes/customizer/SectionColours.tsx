import { THEME_COLOR_TOKENS } from '@score/contract'
import { tokenWarnings } from '../../themes/customizer/checks.ts'
import { setColor } from '../../themes/customizer/draft.ts'
import { tokenGroups } from '../../themes/customizer/token-info.ts'
import { ColorField, Segmented } from './controls.tsx'
import type { SectionContext } from './section-context.ts'

export function SectionColours({ draft, edit, mode, setMode, defaults, problems }: SectionContext) {
  const set = draft.manifest.colors?.[mode] ?? {}
  const warnings = tokenWarnings(problems, mode)
  const count = Object.keys(set).length
  return (
    <div className="cz-section">
      <div className="cz-section-head">
        <Segmented
          label="Colours for"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
        <p className="cz-note">
          {count === 0
            ? `Nothing is changed in ${mode} mode: Score’s own colours show.`
            : `${count} ${count === 1 ? 'colour is' : 'colours are'} changed in ${mode} mode.`}
        </p>
      </div>
      {tokenGroups.map((group) => (
        <fieldset key={group.id} className="cz-group">
          <legend>{group.label}</legend>
          {group.tokens.map(({ token, label, hint }) => {
            if (!THEME_COLOR_TOKENS.includes(token)) return null
            const value = (set as Record<string, string | undefined>)[token]
            return (
              <ColorField
                key={`${mode}-${token}`}
                label={label}
                hint={hint}
                value={value}
                fallback={defaults(token, mode)}
                {...(warnings[token] ? { warning: warnings[token] } : {})}
                onChange={(next) =>
                  edit(setColor(draft, mode, token, next), `color:${mode}:${token}`)
                }
                onReset={() => edit(setColor(draft, mode, token, undefined))}
              />
            )
          })}
        </fieldset>
      ))}
    </div>
  )
}
