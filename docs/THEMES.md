# Writing a Score theme

A theme changes how Score looks and how its pages are arranged: colours, fonts, corners, spacing, where the navigation
sits, what Now shows and in which order, how chat messages look, and a picture behind the page. This guide is for the
person writing one. The rules behind it are in `docs/briefs/9-themes.md` (design) and `docs/API-CONTRACT.md` § 16
(routes); the fields below are checked against the schema in `packages/contract/src/themes.ts` by a test
(`apps/server/test/themes/guide.test.ts`), so this page can’t drift from what Score accepts.

Score ships seven themes: Score, Paper, Night shift and Dense (the original four) and **Harbour**, **Ledger** and
**Studio**. The last three are ordinary theme packages, so you can export one from `GET /api/themes/<id>/export`, read
it and start from it.

## What a theme is, and isn’t

A theme is **data**: a manifest, an optional stylesheet, and some fonts and pictures. **No theme code runs.** A theme
can’t contain scripts, can’t call Score’s API, can’t add a button that does something and can’t read your agents’,
rooms’ or tasks’ data. It can only change how things look and where they sit.

A theme also can’t change what a few things *mean*. Approvals, the Needs-you marker, agent shapes, permission and
password screens and the way back to the default look are **protected** (see “Protected surfaces”). Whatever a theme
does, you can always see and answer an approval and always get back.

## The package

A theme package is a `.zip` of at most 5 MB with this layout and nothing else:

```
theme.json          required: the manifest
style.css           optional, at most 256 KB: your CSS
assets/fonts/*.woff2   optional: fonts
assets/img/*           optional: pictures (png, jpg, webp or avif)
LICENSE, OFL.txt       optional: licence texts for what you ship (see “Licence files”)
```

- At most 40 files. No SVG, HTML, scripts, archives inside the zip, links or absolute paths; Score refuses the whole
  package and tells you which entries it didn’t like.
- Fonts are `woff2` only. Pictures are raster only. The file contents must match the file name’s type.
- Refer to a file as `asset:fonts/name.woff2` or `asset:img/name.webp`, in `theme.json` and in `style.css`. Score
  turns those into its own addresses when it serves the theme; nothing is ever loaded from another site.
- Import a package with `POST /api/themes/import` (the Customizer adds the buttons for it in Settings › Look). It is
  stored but not switched on. An id that
  belongs to a built-in theme (`score`, `paper`, `night`, `dense`, `harbour`, `ledger`, `studio`) is refused.

### Licence files

If your package ships a font or a picture that has a licence, put its text in the package. Score accepts at most two
files at the root for this, named exactly `LICENSE` and `OFL.txt` (the SIL Open Font License that most open fonts
come with). Each is plain UTF-8 text of at most 64 KB; anything else at the root, or a file with these names
anywhere else, is refused. Score keeps them with the theme, puts them back into its export and keeps them when you
import that export again. Ledger and Studio carry the `OFL.txt` of the fonts they ship, so an export of either one is
a complete, redistributable starting point.

## The manifest, `theme.json`

Only `format`, `id` and `name` are required; every setting you leave out stays as Score’s own. Unknown keys are
refused, so a typo is an error, not a silent no-op. `format` is `1`; a newer format is refused with a plain message.

The table lists every field. Arrays are written `field[]`, and `views.user` takes every look field above it
(colours, fonts, shape, layout and background) to override them for the chat-first user view.

<!-- fields:start -->

| Field                    | Allowed values                                                                | What it does                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `format`                 | `1`                                                                           | The manifest format.                                                                          |
| `id`                     | 1–40 characters: lower-case letters, digits and `-`, starting with a letter or digit | The theme’s name inside Score. Can’t be a built-in id.                                 |
| `name`                   | 1–60 characters                                                               | The name shown in Settings › Look.                                                            |
| `version`                | `major.minor.patch`, for example `1.0.0` (default `1.0.0`)                    | Your own version number.                                                                      |
| `author`                 | up to 80 characters                                                           | Shown before you install.                                                                     |
| `description`            | up to 400 characters                                                          | The line under the name in the picker.                                                        |
| `colors`                 | an object with `light` and `dark`                                             | Colours, one set for each mode.                                                               |
| `colors.light`           | token name → colour, from the token list below                                | Colours in light mode.                                                                        |
| `colors.dark`            | token name → colour, from the token list below                                | Colours in dark mode.                                                                         |
| `fonts`                  | an object                                                                     | Fonts.                                                                                        |
| `fonts.heading`          | a font family name, up to 60 characters of letters, digits, spaces, `_` and `-` | The family for headings.                                                                    |
| `fonts.body`             | a font family name (same rules)                                               | The family for text.                                                                          |
| `fonts.code`             | a font family name (same rules)                                               | The family for code and commands.                                                             |
| `fonts.faces`            | up to 12 faces                                                                | Font files your theme brings.                                                                 |
| `fonts.faces[]`          | an object                                                                     | One font file.                                                                                |
| `fonts.faces[].family`   | a font family name (same rules)                                               | The family this file belongs to. Use it in `heading`, `body` or `code`.                       |
| `fonts.faces[].src`      | `asset:fonts/<file>.woff2`                                                    | Where the file is in the package.                                                             |
| `fonts.faces[].weight`   | `400`, or a range such as `400 700` (default `400`)                           | The weight (or range) the file covers.                                                        |
| `fonts.faces[].style`    | `normal` · `italic` (default `normal`)                                        | Upright or italic.                                                                            |
| `shape`                  | an object                                                                     | Corners, spacing and how cards are drawn.                                                     |
| `shape.radius`           | `sharp` · `soft` · `round`, or a whole number of pixels, 0–40                 | How round corners are. A number sets the card radius; smaller sizes follow it.                |
| `shape.density`          | `compact` · `comfortable` · `airy`                                            | How much room there is between things (about 0.85, 1 and 1.2 times).                          |
| `shape.border`           | `none` · `hairline` · `strong`                                                | The line round cards and panels.                                                              |
| `shape.elevation`        | `flat` · `raised` · `floating`                                                | The shadow under cards and panels.                                                            |
| `shape.surface`          | `solid` · `glass`                                                             | Solid cards, or translucent cards that blur what is behind them.                              |
| `layout`                 | an object                                                                     | How pages are arranged.                                                                       |
| `layout.nav`             | `top` · `left` · `right` · `launcher`                                         | Where the navigation is. `launcher` is one menu button (and the command palette).             |
| `layout.contentWidth`    | `narrow` · `wide` · `full`                                                    | How wide the page content gets.                                                               |
| `layout.menu`            | up to 7 entries                                                               | The order, names and visibility of the destinations. Anything left out is hidden.             |
| `layout.menu[]`          | an object                                                                     | One entry of the menu.                                                                        |
| `layout.menu[].to`       | `/now` · `/chat` · `/tasks` · `/team` · `/knowledge` · `/reports` · `/settings` | The destination.                                                                            |
| `layout.menu[].label`    | 1–24 characters                                                               | Your own name for it.                                                                         |
| `layout.now`             | an object                                                                     | The cards on Now, in a grid.                                                                  |
| `layout.now.columns`     | a whole number, 1–4                                                           | How many columns the grid has.                                                                |
| `layout.now.cards`       | up to 12 cards                                                                | The cards, in order.                                                                          |
| `layout.now.cards[]`     | an object                                                                     | One card.                                                                                     |
| `layout.now.cards[].card` | `timeline` · `room` · `needs-you` · `made-today` · `todo` · `composer`       | Which card. Each shows once.                                                                  |
| `layout.now.cards[].span` | a whole number, 1–4 (default 1)                                              | How many columns it takes.                                                                    |
| `layout.chat`            | an object                                                                     | Chat.                                                                                         |
| `layout.chat.messages`   | `plain` · `bubbles`                                                           | Plain messages, or yours in a bubble on the right.                                            |
| `layout.chat.roomList`   | `left` · `right` · `hidden-until-opened`                                      | Where the list of rooms is.                                                                   |
| `background`             | an object                                                                     | A picture behind the page.                                                                    |
| `background.image`       | `asset:img/<file>` (png, jpg, webp or avif)                                   | The picture.                                                                                  |
| `background.fit`         | `cover` · `tile` (default `cover`)                                            | One big picture, or a repeating one.                                                          |
| `background.dim`         | a whole number, 0–80 (default 0)                                              | How strongly the page’s ground colour is laid over the picture, in per cent.                  |
| `views`                  | an object                                                                     | Overrides for other front ends.                                                               |
| `views.user`             | any look field above                                                          | Overrides for the chat-first user view (`/u`): colours, fonts, shape, layout and background.  |

<!-- fields:end -->

Two rules the table can’t show:

- **Settings can be renamed or moved, never hidden.** If `layout.menu` leaves it out, Score adds it last. If you hide
  every destination Score still shows Settings.
- **Needs-you is always on Now.** If `layout.now.cards` leaves it out, Score adds it first. You can move it and make
  it wider, not remove it.

### Pictures and readable text

A picture lies behind the page, so text drawn straight on it (headings, the room list, hints) must stay readable
wherever the picture is dark or light. `dim` lays your `ground` colour over the picture to calm it down. Check the
darkest and the lightest spot of the picture with your text colours **and with Score’s four agent text colours** (they
appear in room lists and status lines, and a theme can’t change them), in both modes. In practice that means a
picture with no dark spots in light mode and no light spots in dark mode, under a strong veil (`dim` 80); Harbour’s test
(`apps/server/test/themes/builtin-art.test.ts`) does exactly that and is a good one to copy. With `shape.surface:
glass`, cards are the card colour at 70 % over the blurred picture, so check that too.

## Colour tokens

A theme sets colours through a fixed list of tokens (the only ones the manifest accepts). Colours are `#rgb`,
`#rrggbb`, `#rrggbbaa`, or `rgb()`, `rgba()`, `hsl()`, `hsla()` or `oklch()` with plain numbers; never `var()` or
`url()`. Agent colours and the colours of Rules (go, ask, never) aren’t on the list: they carry meaning, so a theme
can’t change them.

<!-- tokens:start -->

| Token                 | What it colours                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `ground`              | The page behind everything; also the veil laid over a background picture.                        |
| `card`                | Cards, panels and inputs; also the text on an `ink` button.                                      |
| `ink`                 | Main text, primary buttons, the current navigation item and the focus ring.                      |
| `ink-muted`           | Secondary text.                                                                                  |
| `muted`               | Hints, captions and timestamps.                                                                  |
| `hairline`            | The thin line round cards and between rows.                                                      |
| `line-strong`         | The outline of inputs and controls (needs 3:1 against `card`).                                   |
| `subtle`              | Soft fills: chips, hovered rows, the track of a toggle.                                          |
| `subtle-2`            | A second soft fill, a little stronger.                                                           |
| `track`               | The empty part of bars and meters.                                                               |
| `track-2`             | A stronger track and pressed states.                                                             |
| `link-hover`          | A link when you point at it.                                                                     |
| `on-dark`             | Text and rings on `ink`, coloured and scrimmed fills (white in every built-in theme).            |
| `panel-card`          | The background of inverse panels in Score’s own pairing (approvals and Rules keep their own).    |
| `panel-ink`           | The text on those panels.                                                                        |
| `chat-text`           | Message text in chat.                                                                            |
| `chat-secondary`      | Secondary text in chat.                                                                          |
| `chat-soft`           | Soft fills in chat: quoted text, file chips, tool cards.                                         |
| `chat-card-border`    | The border of cards in chat.                                                                     |
| `chat-dark-border`    | The border of cards on dark panels.                                                              |
| `bubble-own`          | Your message bubble when `layout.chat.messages` is `bubbles`.                                    |
| `bubble-own-ink`      | The text in it.                                                                                  |
| `flow-canvas`         | The Flow canvas.                                                                                 |
| `flow-canvas-dot`     | The dots on the canvas.                                                                          |
| `flow-edge`           | Lines between steps (needs 3:1 against `flow-canvas`).                                           |
| `flow-edge-planned`   | Lines to steps that are planned.                                                                 |
| `flow-edge-sent-back` | Lines for work sent back.                                                                        |
| `flow-done-border`    | The border of finished steps.                                                                    |
| `flow-log-border`     | The line between entries of the Flow log.                                                        |
| `tasks-ground`        | The Tasks board behind the cards.                                                                |
| `tasks-border`        | Borders on the Tasks board.                                                                      |
| `tasks-done`          | A finished task’s card.                                                                          |
| `tasks-note`          | Notes on a finished task.                                                                        |
| `profile-dashed`      | The dashed outline of the “Add agent” tile.                                                      |
| `profile-add-ink`     | The text of that tile.                                                                           |
| `watch-stage`         | The stage behind a Watch replay.                                                                 |
| `watch-window`        | The replayed window, and the terminal.                                                           |
| `watch-text`          | Text inside a Watch replay.                                                                      |

<!-- tokens:end -->

### Contrast

Aim for WCAG AA (4.5:1 for text, 3:1 for outlines, focus rings and lines in graphics) for every pair that is drawn:
`ink` on `ground` and `card`, `ink-muted` and `muted` on both, `muted` on `subtle`, `chat-text` on `chat-soft`,
`tasks-note` on `tasks-done`, and `card` on `ink` (the current menu item). `apps/web/src/styles/contrast-pairs.ts` lists
the pairs Score’s own tests check for the built-in themes; copy it for yours.

Score also checks the pairs a protected surface draws, at run time. If your colours fail 4.5:1 there, that surface
keeps Score’s own colours (the page then carries `data-contrast-fallback`), so a low-contrast theme can’t make an
approval unreadable. It doesn’t fix the rest of your theme, so check it yourself.

## Custom CSS, `style.css`

CSS is for finishing touches of **appearance**. Where things sit, how big they are and how text is spaced come from the
manifest (`shape`, `layout`, `fonts`, `background`), which Score renders itself. It loads after Score’s own CSS and the
token sheet, as a separate stylesheet, so ordinary cascade rules apply: write the selector you want and, if needed, a
more specific one. There is **no `!important`** (it is refused), so keep your selectors specific instead.

What you can use:

- Score’s own class names, such as `.now-card`, `.chat-thread`, `.chat-message`, `.chat-composer-box`, `.settings-card`,
  `.task-card`, `.team-card`, `.top-bar` and `.page-content`. They are not a stable interface: open the browser’s
  inspector to find the one you want, and expect to adjust when Score changes.
- Attribute selectors for the current look: `:root[data-theme='dark']` (dark mode; unset when the mode is System, where
  `@media (prefers-color-scheme: dark)` applies), `:root[data-nav='left']`, `:root[data-chat='bubbles']` and the
  other `data-*` attributes the manifest turns on.
- `@media`, `@supports`, `@container`, `@layer`, and nested rules. There is no animation: see below.
- `url(asset:img/name.webp)` for your own images, in `background-image` and `background`.

### The allowlist: what a declaration may set

A declaration is kept only if its property is on this list **and** its value is one the list accepts (a colour, a
gradient, a length in range). Everything else is dropped by the browser and the Customizer’s Custom CSS section lists it
with the reason; the server **refuses** a package or save that contains one (`422 theme_rejected`, naming the property).
The browser and the server read the same list (`packages/contract/src/theme-css.ts`).

- Colours: `color`, `background-color`, `accent-color`, `caret-color`. A colour is `#rgb`/`#rrggbb`/`#rrggbbaa`, a
  keyword, `rgb()`, `hsl()`, `hwb()`, `lab()`, `lch()`, `oklab()`, `oklch()`, `color()` or `color-mix()`; `var(--token)` of
  a public colour token also works (`var(--card)`), `calc()`, `attr()` and every other `var()` do not.
- Background: `background-image`, `background-position`, `background-size`, `background-repeat`,
  `background-attachment`, `background-origin`, `background-clip`, `background-blend-mode` and the `background`
  shorthand. Pictures only as `url(asset:img/…)`; gradients of colours.
- Borders: `border`, `border-top`, `border-right`, `border-bottom`, `border-left`, `border-block`, `border-inline`,
  `border-block-start`, `border-block-end`, `border-inline-start`, `border-inline-end`, the same with `-color`, `-style`
  and `-width` (`border-color`, `border-style`, `border-width`, `border-top-color`, `border-left-width`, …, at most 8px
  wide), and `border-radius`, `border-top-left-radius`, `border-top-right-radius`, `border-bottom-left-radius`,
  `border-bottom-right-radius`, `border-start-start-radius`, `border-start-end-radius`, `border-end-start-radius`,
  `border-end-end-radius` (at most 999px).
- Outline: `outline-color` and `outline-style` (not its width or offset).
- Shadows: `box-shadow` and `text-shadow`, kept small (offset up to 32px, blur up to 64px, spread up to 8px) because a
  shadow paints outside its element.
- Type: `font-family`, `font-weight`, `font-style` (not the size, line height, spacing or case).
- Text decoration: `text-decoration-line` (`none` or `underline`), `text-decoration-color`, `text-decoration-style`
  and the `text-decoration` shorthand of those.
- `opacity` from 0 to 1, on elements **without a protected element inside them** (the sanitiser adds that condition to
  the selector).
- Custom properties: the public colour tokens `--hairline`, `--line-strong`, `--subtle`, `--subtle-2`, `--track`,
  `--track-2`, `--link-hover`, `--on-dark`, `--chat-text`, `--chat-secondary`, `--chat-soft`, `--chat-card-border`,
  `--chat-dark-border`, `--bubble-own`, `--bubble-own-ink`, `--flow-canvas`, `--flow-canvas-dot`, `--flow-edge`,
  `--flow-edge-planned`, `--flow-edge-sent-back`, `--flow-done-border`, `--flow-log-border`, `--tasks-ground`,
  `--tasks-border`, `--tasks-done`, `--tasks-note`, `--profile-dashed`, `--profile-add-ink`, `--watch-stage`,
  `--watch-window`, `--watch-text` (a plain colour), and the corner scale `--radius-xs`, `--radius-s`, `--radius-m`,
  `--radius-l`, `--radius-card` (0 to 40px). The pairs a protected surface draws (`--ground`, `--card`, `--ink`,
  `--ink-muted`, `--muted`, `--panel-ink`, `--panel-card`) are set in the manifest, where the contrast check sees them.

The complete list, exactly as Score checks it (a test keeps this section and the code the same):

- Colours: `color`, `background-color`, `accent-color`, `caret-color`
- Background: `background-image`, `background-position`, `background-size`, `background-repeat`, `background-attachment`, `background-origin`, `background-clip`, `background-blend-mode`, `background`
- Borders: `border`, `border-top`, `border-right`, `border-bottom`, `border-left`, `border-block`, `border-inline`, `border-block-start`, `border-block-end`, `border-inline-start`, `border-inline-end`, `border-color`, `border-top-color`, `border-right-color`, `border-bottom-color`, `border-left-color`, `border-block-color`, `border-inline-color`, `border-block-start-color`, `border-block-end-color`, `border-inline-start-color`, `border-inline-end-color`, `border-style`, `border-top-style`, `border-right-style`, `border-bottom-style`, `border-left-style`, `border-block-style`, `border-inline-style`, `border-block-start-style`, `border-block-end-style`, `border-inline-start-style`, `border-inline-end-style`, `border-width`, `border-top-width`, `border-right-width`, `border-bottom-width`, `border-left-width`, `border-block-width`, `border-inline-width`, `border-block-start-width`, `border-block-end-width`, `border-inline-start-width`, `border-inline-end-width`, `border-radius`, `border-top-left-radius`, `border-top-right-radius`, `border-bottom-left-radius`, `border-bottom-right-radius`, `border-start-start-radius`, `border-start-end-radius`, `border-end-start-radius`, `border-end-end-radius`
- Outline: `outline-color`, `outline-style`
- Shadows: `box-shadow`, `text-shadow`
- Type: `font-family`, `font-weight`, `font-style`
- Text decoration: `text-decoration-line`, `text-decoration-color`, `text-decoration-style`, `text-decoration`
- Opacity: `opacity`
- Custom properties: `--hairline`, `--line-strong`, `--subtle`, `--subtle-2`, `--track`, `--track-2`, `--link-hover`, `--on-dark`, `--chat-text`, `--chat-secondary`, `--chat-soft`, `--chat-card-border`, `--chat-dark-border`, `--bubble-own`, `--bubble-own-ink`, `--flow-canvas`, `--flow-canvas-dot`, `--flow-edge`, `--flow-edge-planned`, `--flow-edge-sent-back`, `--flow-done-border`, `--flow-log-border`, `--tasks-ground`, `--tasks-border`, `--tasks-done`, `--tasks-note`, `--profile-dashed`, `--profile-add-ink`, `--watch-stage`, `--watch-window`, `--watch-text`, `--radius-xs`, `--radius-s`, `--radius-m`, `--radius-l`, `--radius-card`

Not on the list, so dropped: `position`, `inset`, `top`/`left`/`right`/`bottom`, `transform`, `translate`, `rotate`,
`scale`, `overflow*`, `clip*`, `mask*`, `width`/`height`/`min-*`/`max-*`, `margin`, `padding`, `display`, `flex*`,
`grid*`, `z-index`, `content`, `filter`, `backdrop-filter`, `font-size`, `font`, `line-height`, `letter-spacing`,
`word-spacing`, `text-indent`, `text-transform`, `writing-mode`, `direction`, `visibility`, `pointer-events`,
`animation*`, `transition*`, `outline`, `outline-width`, `outline-offset`, other custom properties, and anything else not
named above. Why: ancestors’ layout, spacing, transforms and clipping reach decisions through inheritance and
containment, so the only guarantee that a theme cannot hide an approval is that CSS cannot do those things at all.
Sizes, spacing and layout are manifest options (`shape.density`, `layout.*`), which Score renders itself.

Other things that are dropped, and why. The browser reads your CSS with its own parser (so `\63 ontent` is `content`),
drops these before it is applied, and keeps a report of what was dropped.

| Dropped                                                                          | Why                                                                                       |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `@import`, `@namespace`                                                          | They load other files; everything must be in the package.                                 |
| `@font-face`                                                                     | Use `fonts.faces` in the manifest, so the family name can’t replace one of Score’s own.   |
| any `url()` that isn’t `asset:img/…`, `image-set()`, `src()`, `element()`        | Nothing is fetched from, or sent to, another site.                                        |
| any rule with `!important`                                                       | Protected surfaces win with `!important` in their own layer; a theme can’t compete.       |
| selectors that name a protected surface (`[data-protected]`, `.chat-approval`, …) | See below.                                                                                |
| custom properties starting `--agent-`, `--rules-`, `--glyph-` and `--watch-live` | Agent identity and the Rules colours carry meaning.                                       |
| `@keyframes` and any other at-rule than `@media`, `@supports`, `@container`, `@layer` | Not needed by a theme; motion that starts later is how a rule could hide an approval.    |

When you import a package or save a theme, the **server** is stricter in form: it refuses (rather than edits) CSS that
contains, after resolving escapes and comments, a declaration off the allowlist (naming the property), a value the
list does not accept, an at-rule other than `@media`, `@supports`, `@container` and `@layer`, `@import`, `@namespace`,
a `url()` that isn’t `asset:`, `!important`, `expression(`, `behavior`, `-moz-binding`, `javascript:`, `image-set()`
and similar, so a hand-made upload can’t get around the browser’s checks.

## Protected surfaces

These keep their own look and can’t be hidden, covered, relabelled or restyled by a theme. Only the public colour
tokens apply inside them, and only while their contrast holds.

- Approval and decision cards (tool approvals in Chat, Now, Watch and the task drawer; gates, limits, unknown spend,
  coding-agent reach and the acknowledgements before a run).
- The Needs-you marker and card.
- The security-password dialogs and the permission and sandbox settings (Rules, Team permissions and the permission,
  warning and password fields when you add a coding agent).
- Agent shapes (`AgentGlyph`) and error toasts.
- The way back: the Settings link, the menu and search buttons with the command palette (and its “Reset look” entry),
  “Reset look” itself and the banner that appears when a theme is skipped.

**None of your rules match inside these.** Every selector of your CSS is applied as if it ended in
`:where(:not([data-protected], [data-protected] *))`, so `button`, `span`, `svg path`, `[role=alert]` or `div > div` never
reach an approval’s words, its buttons or a glyph’s shape, whatever you write. (This doesn’t change your selectors’
specificity.) Your manifest’s colour tokens still reach them, and what a parent hands down by inheritance does: the
fonts and colours of their parents. The things that could change how a decision *reads or sits*, such as size, spacing,
transforms, clipping, positioning and fading, are not on the CSS allowlist at all, so no rule can do them to a parent.
As a second wall, protected surfaces re-assert their own word spacing, writing direction, text shadows and (below the
components’ own rules) size, line height, letter spacing, case and wrapping, and the Settings link wears the card colour
as an opaque background of its own, so a translucent rail over a picture can’t take its contrast away.

Beyond the sanitiser, Score re-asserts these in a protected cascade layer, and at run time it watches them: a theme
that hides, fades, covers or blurs one of them from outside is switched off on that device, with a banner that says why.
It checks when the page changes, on hover, focus and press, when an animation ends, and at the moment you act on an
approval, an answer, a permission or a password: if the decision is hidden, unreadable (below 4.5:1, or 3:1 for large
text and icons, or a colour Score can’t measure) or covered at that moment, Score refuses the action, switches the
theme off and says nothing was sent. Text over a picture has to read against anything from black to white behind it,
except the page’s own picture, which is measured through its veil.

## Getting back

If a theme makes Score hard to use, any of these returns to Score’s own look:

- Open any address with `?look=safe` (for this visit only).
- Press **Ctrl+Shift+0** on any page.
- Press Ctrl+K (or ⌘K) and run **Reset look on this device**.
- Settings › Look › **Reset look on this device**; Settings can’t be hidden by a theme.
- On the computer Score runs on, `scripts/score look reset` (works with Score stopped; it also clears the theme every browser chose for itself, which each one drops the next time it reloads or regains focus).

A theme that fails validation, can’t be loaded or throws while it is applied is skipped, and a banner says so.

## Example: Sandbar

The finished files are in `docs/themes/example-theme/`. Here is how they come together.

**1. Make a folder.** `sandbar/` with `theme.json`, `style.css` and `assets/img/`.

**2. Start the manifest.** Only three fields are required.

```json
{ "format": 1, "id": "sandbar", "name": "Sandbar" }
```

**3. Add colours.** Light and dark are separate sets. Set the ground, the card, the text and the lines first, then
check each pair against the contrast notes above. Anything you leave out stays Score’s own, which is fine for a first
version.

**4. Choose a shape and a layout.** Soft corners, hairline borders and a raised card; navigation on the left; wide
content; and a menu in your own words (Settings is added for you).

**5. Add a picture.** Put `sand.png` in `assets/img/` and point at it with `asset:img/sand.png`. Use `dim` to calm it
down, then check your text colours against the picture’s darkest and lightest spot.

**6. Add a little CSS.** Heavier headings, and a lighter weight on phones.

**7. Zip it** from inside the folder, so `theme.json` is at the top of the zip (not inside a `sandbar/` folder):

```
cd sandbar && zip -r ../sandbar.zip theme.json style.css assets
```

**8. Install it.** Import `sandbar.zip` (`POST /api/themes/import`; the stored theme is not switched on yet). Then
pick it under “Style on this device” in Settings › Look to try it on this browser only, or “Theme for every device” to
use it everywhere.

The whole manifest of the example:

```json
{
  "format": 1,
  "id": "sandbar",
  "name": "Sandbar",
  "version": "1.0.0",
  "author": "Your name",
  "description": "Warm sand and deep teal, soft corners, a quiet picture behind the page and a menu in your own words.",
  "colors": {
    "light": {
      "ground": "#f7f1e5",
      "card": "#fffdf8",
      "ink": "#16302f",
      "ink-muted": "#3a4b47",
      "muted": "#3f504b",
      "hairline": "#ddd2bd",
      "line-strong": "#7f8575",
      "subtle": "#f6efe2",
      "subtle-2": "#f0e7d6",
      "link-hover": "#0f6b66",
      "chat-soft": "#f6efe2",
      "chat-card-border": "#ddd2bd",
      "tasks-ground": "#e6dcc9",
      "tasks-border": "#ddd2bd",
      "tasks-done": "#f6efe2"
    },
    "dark": {
      "ground": "#14110d",
      "card": "#1d1913",
      "ink": "#f1e9da",
      "ink-muted": "#b7ad9b",
      "muted": "#ada391",
      "hairline": "#332d22",
      "line-strong": "#7d7565",
      "subtle": "#25201a",
      "subtle-2": "#2a251d",
      "link-hover": "#8fd3c9",
      "chat-soft": "#221e17",
      "chat-card-border": "#332d22",
      "tasks-ground": "#17140f",
      "tasks-border": "#332d22",
      "tasks-done": "#1f1b15"
    }
  },
  "shape": {
    "radius": "soft",
    "density": "comfortable",
    "border": "hairline",
    "elevation": "raised",
    "surface": "solid"
  },
  "layout": {
    "nav": "left",
    "contentWidth": "wide",
    "menu": [
      { "to": "/now", "label": "Today" },
      { "to": "/chat", "label": "Talk" },
      { "to": "/tasks" },
      { "to": "/team" },
      { "to": "/knowledge" },
      { "to": "/reports", "label": "Numbers" }
    ]
  },
  "background": { "image": "asset:img/sand.png", "fit": "cover", "dim": 80 }
}
```

The picture was drawn by `apps/server/scripts/theme-art.ts`, which draws every picture Score ships (no stock art).
Make yours however you like, as long as you own it or its licence lets you ship it.
