# Phase 9: Themes and the Customizer (design v1; decision 90)

Owner 2026-10-17: "like joomla etc cms or wordpress, freely configure the outlook". Chosen: **declarative theme packages
with a live Customizer** (no theme scripts), stored in Score and applied **everywhere, with a per-device override**.
Builds on 8.3 (tokens, packs, `data-pack/-layout/-density`) and 8.4 (user view). Supersedes decision 84's "no editor or
import".

## 1. What a theme is
A **theme package** is a `.zip` (≤ 5 MB) with:
- `theme.json` (required): metadata + settings (§2). Validated with zod; unknown keys rejected (`strict`).
- `style.css` (optional, ≤ 256 KB): free CSS, sanitised (§4), loaded in the `theme` cascade layer.
- `assets/` (optional): fonts (`woff2`) and images (`png`, `jpg`, `webp`, `avif`) only; ≤ 40 files. **No SVG, no HTML, no
  JS.** Referenced from `theme.json` or `style.css` as `asset:<path>`, rewritten to Score URLs on apply.
No code runs from a theme. A theme can't call the API, can't add buttons that do things, can't read data.

## 2. `theme.json` (schema `ThemeManifest`, `packages/contract/src/themes.ts`)
```jsonc
{
  "format": 1,                       // bump only for breaking changes; Score refuses newer formats with a plain message
  "id": "harbour",                   // [a-z0-9-]{1,40}; built-ins reserve score, paper, night, dense
  "name": "Harbour", "version": "1.0.0", "author": "…", "description": "…",
  "colors": { "light": { "<token>": "<color>", … }, "dark": { … } },   // only tokens on the public token list (§3)
  "fonts": { "heading": "<family>", "body": "<family>", "code": "<family>",
             "faces": [{ "family": "…", "src": "asset:fonts/x.woff2", "weight": "400 700", "style": "normal" }] },
  "shape": { "radius": "sharp|soft|round|<0-40px>", "density": "compact|comfortable|airy", "border": "none|hairline|strong",
             "elevation": "flat|raised|floating", "surface": "solid|glass" },
  "layout": {
    "nav": "top|left|right|launcher",            // launcher = a single menu button (+ ⌘K palette), maximum content
    "contentWidth": "narrow|wide|full",
    "menu": [{ "to": "/now" }, { "to": "/chat", "label": "Talk" }, …],  // order, optional label, omit = hidden
    "now": { "columns": 1-4, "cards": [{ "card": "timeline|room|needs-you|made-today|todo|composer", "span": 1-4 }] },
    "chat": { "messages": "plain|bubbles", "roomList": "left|right|hidden-until-opened" }
  },
  "background": { "image": "asset:img/bg.webp", "fit": "cover|tile", "dim": 0-80 },
  "views": { "user": { …same keys as above, overriding for the chat-first view… } }
}
```
Everything is optional except `format`, `id`, `name`; omitted settings fall back to the Score default. Protected
destinations: Settings can be relabelled or moved but never hidden; `needs-you` is always on Now (themes may move it).

## 3. Public token list
The tokens a theme may set are a documented, versioned subset of `tokens.css` (≈ 60: ground, card, ink, ink-muted,
hairline, accents, agent colour *tints* but not agent identity hues, status colours, focus ring, chat bubble colours,
code colours). Exposed as `--t-*` aliases so internal token renames don't break themes. Listed with descriptions in
`docs/THEMES.md` (theme author guide, generated from the contract list).

## 4. Safety (the reason there are no scripts)
Score holds approvals, permissions and the security password; a shared theme must not be able to trick the owner.
1. **CSS sanitiser (web, `themes/sanitise.ts`)**: the browser parses `style.css` with `new CSSStyleSheet().replaceSync()`
   (escapes resolved by the real parser), walks the rules and drops: `@import`, `@namespace`, `@font-face` outside
   `fonts.faces`, any `url()` that isn't `asset:`, the `content` property, `position: fixed|sticky`, `z-index` above 50,
   `pointer-events`, `-webkit-user-modify`, selectors containing `[data-protected]` or the protected class list, `:has()`
   that reaches a protected element, and any rule with `!important`. The cleaned `cssText` (re-serialised) is what is
   stored and applied — on import, on save in the Customizer and again on apply (defence in depth). A report lists what was
   dropped.
2. **Cascade order**: Score's own CSS stays unlayered (so the default stays pixel-identical); the theme's generated token
   sheet and its CSS load **after** it as separate same-origin stylesheets (`<link>` to `/api/themes/<id>/style.css`, not
   inline, so a stray `}` can't escape anything), overriding by normal cascade order like a child theme. Protected
   surfaces (§4.3) are re-asserted in `@layer score-protected` with `!important`: a layered `!important` beats every
   unlayered declaration, and theme CSS can never use `!important` (the sanitiser drops it), so a theme can't override
   them.
3. **Protected surfaces** (`data-protected`): approval and decision cards (tool approvals, gates, limits, unknown cost,
   coding reach), password dialogs, permission/sandbox settings, the Needs-you badge and card, AgentGlyph shape, toasts
   about errors, and the "Reset look" control. Inside them only the public colour tokens apply, and contrast is
   enforced: if a theme's colours fail WCAG AA there, Score falls back to the default pair for that surface.
4. **CSP stays**: no external `img-src`/`font-src`/`style-src`; theme assets are served by Score
   (`/api/themes/<id>/assets/…`) with `nosniff`, exact content types, `content-disposition: inline` and
   `cache-control: private`.
5. **Escape hatches**: `?look=safe` on any URL, `Ctrl+Shift+0` (also in ⌘K: "Reset look on this device"), and
   `scripts/score look reset` on the host: all return to the Score default. A theme that fails validation or throws on
   apply is skipped with a banner.
6. **Import shows what you're installing**: name, author, preview, the list of settings it changes, and the sanitiser
   report; nothing applies until "Install".

## 5. Storage and API (server; migration 0071)
- Table `themes(id, name, version, manifest_json, css, created_at, updated_at, source: builtin|imported|custom)`, assets in
  `$SCORE_HOME/themes/<id>/assets/` (0700/0600). Setting `look.activeTheme` + `look.mode` (light/dark/system).
- `GET /api/themes` → summaries · `GET /api/themes/:id` → manifest + sanitised CSS + asset list · `PUT /api/themes/:id`
  (custom themes; etag) · `POST /api/themes/import` (multipart zip) → `{ theme, report }` · `GET /api/themes/:id/export`
  (zip) · `DELETE /api/themes/:id` (not built-ins, not the active one) · `PUT /api/look` `{ activeTheme, mode }` ·
  `GET /api/themes/:id/assets/*` · event `look.changed` so other open devices switch live.
- Server validates the manifest (zod), sizes, file types (magic bytes), zip paths (no traversal, no symlinks, no nested
  zips), and keeps the CSS sanitiser's output as given by the browser **only after re-checking the cheap rules
  server-side** (`url(`, `@import`, `content`, `!important`, `position: fixed`) after unescaping — belt and braces.

**Import flow (v1.1):** the server unpacks and validates the zip and **rejects** (422 `theme_rejected` with the reasons)
any package whose CSS still contains, after unescaping, `@import`, a non-`asset:` `url(`, `content`, `!important`,
`position: fixed|sticky`, `expression(`, `behavior`, `-moz-binding` or `javascript:`; it never stores CSS it had to change.
The browser sanitiser (§4.1) runs on every apply and drops what only the browser can judge reliably (protected selectors,
`:has()` reaching protected elements, `z-index` > 50, `pointer-events`, unknown at-rules); its report is shown in the
install preview and the Customizer. `asset:` references in CSS are rewritten by the server when it serves the stylesheet.

## 6. Applying (web)
- `ThemeEngine`: turns a manifest into `<html>` attributes (`data-nav`, `data-width`, `data-radius`, `data-elevation`,
  `data-surface`, `data-border`, `data-chat`), a generated token stylesheet (layer `theme`), font-faces, the theme CSS
  link, and layout config consumed by components (menu order, Now cards, chat options) via a `useLook()` hook.
- Before first paint: `boot-look.js` (8.3) applies the cached attributes + token sheet from `localStorage`
  (`score.look.cache`), so there is no flash; the server copy refreshes it after load.
- Per-device override: Settings › Look › "On this device: use the shared theme / <theme>" (localStorage).
- 8.3's packs become built-in theme packages (`score`, `paper`, `night`, `dense`), pixel-identical.

## 7. Layout model (components)
- **Shell**: `nav` = top (today), left/right rail (8.3's rail, mirrored for right), launcher (top-left menu button
  opening the drawer; ⌘K). Menu from `layout.menu`.
- **Now**: a CSS grid with `columns`; cards rendered from `layout.now.cards` (each card is already its own component).
- **Chat**: `messages: bubbles` (own messages right-aligned in a bubble, agents left with glyph) vs `plain` (today).
  `roomList` position.
- **Component variants** by attributes, written once in `score-base` (cards: flat/raised/floating, solid/glass with
  `backdrop-filter`, border none/hairline/strong; radius scale; density scale 0.85/1/1.2).
- **User view** (8.4) reads `views.user` overrides.

## 8. Customizer (Settings › Look › Customize)
A full-screen editor: live preview of the real app on the left (the actual routes, in fake-safe "preview" mode reading
the same data, interactions disabled), controls on the right in sections: Theme (start from…), Colours (light/dark,
with contrast warnings), Fonts (built-ins + upload woff2), Shape, Layout (nav, width, menu editor with drag to reorder
and hide), Now (drag cards, set spans), Chat, Background, Custom CSS (code editor with the sanitiser report live), and
Save as / Export / Import. Undo/redo; "Discard" returns to the saved theme. Keyboard-accessible drag (buttons for move
up/down) besides pointer drag.

## 9. Tasks (PLAN 9.1–9.6)
- **9.1 Contract + storage + API + import/export** (server; migration 0071).
- **9.2 Theme engine + safety** (web): manifest → attributes/tokens/fonts/CSS layers; sanitiser; protected surfaces;
  escape hatches; boot cache; packs as built-in themes (pixel-identical).
- **9.3 Layout model**: nav positions (top/left/right/launcher), content width, menu config, Now card grid, chat
  bubbles/room list, component variants, user-view overrides.
- **9.4 Customizer**: live preview editor, save/export/import UI, menu and Now drag-and-drop.
- **9.5 Themes and guide**: 3 new built-in themes that look clearly different (e.g. "Harbour" glass + left rail +
  bubbles; "Ledger" flat, sharp, compact, launcher nav; "Studio" airy, serif, right rail), `docs/THEMES.md` (author
  guide with the token list and examples), an example theme zip in `docs/themes/`.
- **9.6 Phase gate**: lead review of the whole phase + adversarial review of §4 (the lead does it; Codex audit if
  available), e2e for every escape hatch and every protected surface.

Dependencies: 9.1 ∥ 9.2 (the contract schemas are written first by the lead); 9.3 after 9.2; 9.4 after 9.1 + 9.3; 9.5
after 9.3. Visual baselines: the Score default stays pixel-identical throughout.

## Review log
- v1 (lead, 2026-10-17): self-review below (§10) before builders start.

## 10. Lead adversarial review of v1 (2026-10-17)
1. *Theme CSS overlays a fake "Approve" on top of a real "Deny"* — pseudo-element `content` dropped; `position:
   fixed/sticky` and high `z-index` dropped; protected cards re-assert `position: relative; z-index` and `isolation:
   isolate` in `score-protected`. Residual: a theme could visually *hide* non-protected text (accepted: not a safety
   decision).
2. *CSS escapes bypass the server's string checks* (`\63 ontent`) — the browser parser normalises; the server unescapes
   CSS escapes before its checks and rejects (not strips) anything that still matches, so a hand-crafted upload via the
   API without the browser fails closed.
3. *Exfiltration via attribute selectors + `url()`* — `url()` only `asset:` (rewritten to same-origin static assets);
   CSP blocks external loads anyway; asset requests carry no data from the page.
4. *Zip bombs / traversal* — size caps on compressed and uncompressed totals, per-file caps, entry count cap, path
   normalisation, reject absolute/`..`/backslash paths, symlink entries and nested archives (reuse Knowledge's import
   guards).
5. *A broken theme locks the owner out of Settings* — Settings can't be hidden; `?look=safe`, the shortcut, ⌘K entry and
   the host command; a theme that fails to apply is skipped automatically.
6. *Fonts as an attack surface* — woff2 only, magic-byte check, size cap; the browser's font sanitiser (OTS) handles the
   rest.
7. *Per-device override diverges silently* — Settings › Look shows "This device uses <theme> instead of the shared
   <theme>" with a one-click "Use the shared theme".
8. *Live `look.changed` re-theming mid-task is jarring* — applied on next navigation if a dialog is open.
9. *(found while writing v1)* Putting theme CSS in a cascade layer would make it lose to Score's unlayered CSS, so themes
   couldn't override anything; moving Score's CSS into a layer risks the default look. → §4.2 v1.1: theme CSS unlayered
   and loaded last; protected rules as layered `!important`, which theme CSS can't match.
