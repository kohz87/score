import { useState } from 'react'
import '../../components/plugin-cards.css'
import { saveTheme, readTheme, themeChoices, type ThemeChoice } from '../../data/theme.ts'

const themeLabels: Record<ThemeChoice, string> = { light: 'Light', dark: 'Dark', system: 'System' }

function ThemeCard() {
  const [theme, setTheme] = useState<ThemeChoice>(readTheme)
  return (
    <div className="plugins-card plugins-theme">
      <span className="plugins-card-name" id="plugins-theme-label">
        Theme
      </span>
      <div
        role="radiogroup"
        aria-labelledby="plugins-theme-label"
        className="plugins-theme-choices"
      >
        {themeChoices.map((choice) => (
          <button
            key={choice}
            type="button"
            role="radio"
            aria-checked={theme === choice}
            className="plugins-theme-choice"
            data-theme-choice={choice}
            onClick={() => {
              setTheme(choice)
              saveTheme(choice)
            }}
          >
            <span className="plugins-theme-swatch" data-choice={choice} aria-hidden="true" />
            {themeLabels[choice]}
          </button>
        ))}
      </div>
    </div>
  )
}

export function LookSection() {
  return (
    <section id="look" className="settings-card" aria-labelledby="settings-look">
      <div>
        <h2 id="settings-look">Look</h2>
        <p className="settings-muted-strong">How Score looks on this device.</p>
      </div>
      <div className="plugins-grid">
        <ThemeCard />
      </div>
    </section>
  )
}
