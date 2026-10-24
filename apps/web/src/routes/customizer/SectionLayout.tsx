import {
  hideMenuRow,
  menuLabel,
  menuRows,
  moveMenuRow,
  renameMenuRow,
  resetMenu,
  setLayoutKey,
  type MenuRow,
} from '../../themes/customizer/draft.ts'
import { Field, MoveButtons, OptionalSegmented, SortableList } from './controls.tsx'
import type { SectionContext } from './section-context.ts'

const titles: Record<string, string> = {
  '/chat': 'Chat',
  '/team': 'Team',
  '/knowledge': 'Knowledge',
  '/reports': 'Reports',
  '/settings': 'Settings',
}

export function SectionLayout(context: SectionContext) {
  const { draft, edit, announce } = context
  const layout = draft.manifest.layout ?? {}
  const rows = menuRows(draft.manifest)
  const shown = rows.filter((row) => !row.hidden)
  const hidden = rows.filter((row) => row.hidden)
  const custom = layout.menu !== undefined

  function move(from: number, to: number) {
    const row = shown[from]
    if (!row) return
    edit(moveMenuRow(draft, from, to))
    announce(`${menuLabel(row)} moved to position ${to + 1} of ${shown.length}.`)
  }

  return (
    <div className="cz-section">
      <Field label="Navigation" hint="Where the menu sits">
        <OptionalSegmented
          label="Navigation"
          value={layout.nav}
          options={[
            { value: 'top', label: 'Top' },
            { value: 'left', label: 'Left rail' },
            { value: 'right', label: 'Right rail' },
            { value: 'launcher', label: 'Menu button' },
          ]}
          onChange={(next) => edit(setLayoutKey(draft, 'nav', next))}
        />
      </Field>
      <Field label="Page width" hint="How wide the content may grow">
        <OptionalSegmented
          label="Page width"
          value={layout.contentWidth}
          options={[
            { value: 'narrow', label: 'Narrow' },
            { value: 'wide', label: 'Wide' },
            { value: 'full', label: 'Full' },
          ]}
          onChange={(next) => edit(setLayoutKey(draft, 'contentWidth', next))}
        />
      </Field>

      <fieldset className="cz-group">
        <legend>Menu</legend>
        <p className="cz-note">
          Drag the handle to reorder, or use the arrow buttons. Rename a page or hide it from the
          menu. Settings always stays, so you can find your way back.
        </p>
        <SortableList
          items={shown}
          getId={(row: MenuRow) => row.to}
          label="Menu order"
          handleLabel={(row: MenuRow) => `Reorder ${menuLabel(row)}`}
          onMove={move}
          renderItem={(row: MenuRow, index, handle) => (
            <>
              {handle}
              <label className="cz-menu-name">
                <span className="cz-visually-hidden">Name of {titles[row.to]} in the menu</span>
                <input
                  type="text"
                  className="cz-input"
                  maxLength={24}
                  placeholder={titles[row.to]}
                  defaultValue={row.label ?? ''}
                  key={`${row.to}:${row.label ?? ''}`}
                  onBlur={(event) => {
                    if ((event.target.value.trim() || '') !== (row.label ?? ''))
                      edit(renameMenuRow(draft, row.to, event.target.value))
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur()
                  }}
                />
              </label>
              <MoveButtons
                name={menuLabel(row)}
                index={index}
                count={shown.length}
                onMove={(to) => move(index, to)}
              />
              {row.to === '/settings' ? (
                <span className="cz-always">Always shown</span>
              ) : (
                <button
                  type="button"
                  className="cz-link"
                  aria-label={`Hide ${menuLabel(row)} from the menu`}
                  onClick={() => {
                    edit(hideMenuRow(draft, row.to, true))
                    announce(`${menuLabel(row)} hidden from the menu.`)
                  }}
                >
                  Hide
                </button>
              )}
            </>
          )}
        />
        {hidden.length > 0 && (
          <>
            <h4 className="cz-subhead">Hidden from the menu</h4>
            <ul className="cz-hidden-list" aria-label="Hidden from the menu">
              {hidden.map((row) => (
                <li key={row.to}>
                  <span>{titles[row.to]}</span>
                  <button
                    type="button"
                    className="cz-link"
                    aria-label={`Show ${titles[row.to]} in the menu`}
                    onClick={() => {
                      edit(hideMenuRow(draft, row.to, false))
                      announce(`${titles[row.to]} is back in the menu.`)
                    }}
                  >
                    Show
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        <button
          type="button"
          className="cz-btn cz-btn--quiet"
          disabled={!custom}
          onClick={() => edit(resetMenu(draft))}
        >
          Use Score’s menu
        </button>
      </fieldset>
    </div>
  )
}
