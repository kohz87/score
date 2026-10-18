import {
  addNowCard,
  moveNowCard,
  nowCardNames,
  removeNowCard,
  resetNow,
  setNowColumns,
  setNowSpan,
  startNow,
} from '../../themes/customizer/draft.ts'
import type { NowCardKind } from '../../themes/layout.ts'
import { Field, MoveButtons, Segmented, SortableList } from './controls.tsx'
import type { SectionContext } from './section-context.ts'

const ALL: NowCardKind[] = ['timeline', 'room', 'needs-you', 'made-today', 'todo', 'composer']

export function SectionNow({ draft, edit, announce }: SectionContext) {
  const now = draft.manifest.layout?.now
  if (!now)
    return (
      <div className="cz-section">
        <p className="cz-note">
          Score lays out the Now page itself. Arrange it yourself to choose the columns, the order
          of the cards and how wide each one is.
        </p>
        <button
          type="button"
          className="cz-btn cz-btn--primary"
          onClick={() => edit(startNow(draft))}
        >
          Arrange the cards
        </button>
      </div>
    )
  const missing = ALL.filter((card) => !now.cards.some((item) => item.card === card))
  function move(from: number, to: number) {
    const card = now?.cards[from]
    if (!card) return
    edit(moveNowCard(draft, from, to))
    announce(`${nowCardNames[card.card]} moved to position ${to + 1} of ${now?.cards.length}.`)
  }
  return (
    <div className="cz-section">
      <Field label="Columns" hint="How many cards fit side by side">
        <Segmented
          label="Columns"
          value={String(now.columns)}
          options={['1', '2', '3', '4'].map((n) => ({ value: n, label: n }))}
          onChange={(next) => edit(setNowColumns(draft, Number(next)))}
        />
      </Field>
      <fieldset className="cz-group">
        <legend>Cards</legend>
        <p className="cz-note">
          Drag the handle to reorder, or use the arrow buttons. Needs you always stays on Now.
        </p>
        <SortableList
          items={now.cards}
          getId={(item) => item.card}
          label="Card order"
          handleLabel={(item) => `Reorder ${nowCardNames[item.card]}`}
          onMove={move}
          renderItem={(item, index, handle) => (
            <>
              {handle}
              <span className="cz-card-name">{nowCardNames[item.card]}</span>
              <label className="cz-span">
                <span className="cz-visually-hidden">Width of {nowCardNames[item.card]}</span>
                <select
                  className="score-select cz-select"
                  value={item.span}
                  onChange={(event) =>
                    edit(setNowSpan(draft, item.card, Number(event.target.value)))
                  }
                >
                  {Array.from({ length: now.columns }, (_, i) => i + 1).map((span) => (
                    <option key={span} value={span}>
                      {span === 1 ? '1 column' : `${span} columns`}
                    </option>
                  ))}
                </select>
              </label>
              <MoveButtons
                name={nowCardNames[item.card]}
                index={index}
                count={now.cards.length}
                onMove={(to) => move(index, to)}
              />
              {item.card === 'needs-you' ? (
                <span className="cz-always">Always shown</span>
              ) : (
                <button
                  type="button"
                  className="cz-link"
                  aria-label={`Remove ${nowCardNames[item.card]} from Now`}
                  onClick={() => {
                    edit(removeNowCard(draft, item.card))
                    announce(`${nowCardNames[item.card]} removed from Now.`)
                  }}
                >
                  Remove
                </button>
              )}
            </>
          )}
        />
        {missing.length > 0 && (
          <div className="cz-add-cards">
            {missing.map((card) => (
              <button
                key={card}
                type="button"
                className="cz-btn cz-btn--quiet"
                onClick={() => {
                  edit(addNowCard(draft, card))
                  announce(`${nowCardNames[card]} added to Now.`)
                }}
              >
                Add {nowCardNames[card]}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          className="cz-btn cz-btn--quiet"
          onClick={() => edit(resetNow(draft))}
        >
          Use Score’s arrangement
        </button>
      </fieldset>
    </div>
  )
}
