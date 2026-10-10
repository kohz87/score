# Accessibility audit (lead, 2026-10-08), task 5.2

Method: WCAG 2.2 AA contrast computed for every token pair the UI uses for text and meaningful graphics; a Playwright
keyboard pass through every destination at 1440 px (40 Tabs each: visible focus, accessible names, one `h1` and one `main`);
labelled-control check; reduced-motion check of every CSS animation. axe-core was not used: it is MPL-2.0, outside the
dependency policy.

| # | Finding | Fix |
|---|---|---|
| 1 | `--muted` text on the grey grounds: 3.85–4.42:1 (below 4.5) | `#626670` (4.59–5.75 on every ground) |
| 2 | Flow edge lines 2.53:1 and the sent-back line 2.28:1 (below 3:1 for graphics) | `--flow-edge #8c9099`, `--flow-edge-sent-back #c28200` (≥ 3:1) |
| 3 | Unknown-agent grey 2.63:1 | `#8a909b` (≥ 3:1; it also carries a pattern) |
| 4 | The composer's text box shows no keyboard focus (Chat and Now) | `.chat-composer-box:focus-within` ring |

Clean: all agent text/tint pairs (5.3–6.7), the dark rules card (9–13), working blocks (5.0–10.6); every focusable element on
the seven destinations has a name and a visible focus style (inputs are labelled by their `<label>`s); one `h1` and one
`main` per page; the only infinite animation (the plan pulse) stops under `prefers-reduced-motion`.
Screenshot baselines stay within their 1% tolerance after the token changes.
