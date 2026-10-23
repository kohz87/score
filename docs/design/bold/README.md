# Bold redesign: design sources

Mockups for the UI rework proposed in [`docs/proposals/ui-rework-bold.md`](../../proposals/ui-rework-bold.md).
The live, clickable canvas (owner's account, private): https://claude.ai/artifact/7zF2GJcnzUcArXiWeaRknh

| File | Screen |
|---|---|
| `1-team-room.dc.html` | The main screen: team room on the left (always on, jobs as tabs, "needs you" pinned), one side panel on the right that is either **Work** or a **one-to-one** with an agent (history, search, references, share to the room) |
| `2-job-wide.dc.html` | One job opened wide: the threaded chat beside **Results / Workbench** (Workbench = code with each agent's marks, the agent's screen, drafts) |
| `3-phone.dc.html` | The team room on a phone; the work peeks up as a bottom sheet |
| `4-team.dc.html` | Team: four agent cards (state, where its computer is, live screen glimpse, Message), the selected agent's four settings |
| `5-settings-usage.dc.html` | Settings in four groups; Usage replaces the Reports page |

These are `.dc.html` design-canvas files: plain HTML with **inline styles**, plus `<sc-if>` / `<sc-for>` / `{{ }}`
template tags and a small `class Component` script for the clickable states. They do not open standalone (they need
the canvas runtime). Read them as the source of truth for layout, copy, colours, radii and spacing, as AGENTS.md
says of `docs/design/html/`. Sample data in them (numbers, file names, messages) is illustrative.

## Visual system used in the mockups

- **Dark first.** Ground `#12131A`; raised panels `#1A1C23`; inner fields and agent bubbles `#23252E`; hairlines
  `#2C2F38`. Text `#ECEEF1`, secondary `#C9CCD4`, muted `#A9ADB8`.
- **Light objects mean "this is for you or it is the result".** Your messages, requests that need you (approvals,
  questions) and result cards are light (`#ECEEF1` / `#FFFFFF`) with ink `#12131A` text and ink buttons.
- **Agents are colour + shape** (AgentGlyph): lead violet circle `#6B4EFF`, builder jade triangle `#19C39A`, reviewer
  saffron diamond `#FFB61E`, designer coral rounded square `#FF6B8A`. On dark, agent name text uses the light tints
  `#B3A6FF`, `#5EE3BF`, `#FFC94D`, `#FF97AE`. A working agent glows in its colour (Score's halo tokens).
- **Charts on dark** use deeper agent tones that pass the palette validator (lightness band, CVD separation,
  contrast vs `#1A1C23`): lead `#7A61FF`, builder `#14A985`, reviewer `#C08A10`, designer `#E85A7A`. Every bar is
  also labelled with the agent's name and shape.
- **Type:** Bricolage Grotesque (headings, big numbers), Hanken Grotesk (body), JetBrains Mono (code, commands).
  The mockups load them from Google Fonts; the app must keep using `@fontsource`.
- **Shape:** pills (`999px`) for buttons and chips, `20–30px` radii for cards and panels, 44px minimum touch targets.
- Reduced motion turns off every animation (glows, typing dots, live dots).
