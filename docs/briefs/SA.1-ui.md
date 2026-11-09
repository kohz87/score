# SA.1-ui — the Agents page's subagent setup card (brief)

Decisions 173–174; design docs/briefs/SA-subagents.md. Approved mock-up: `docs/design/bold/mockups/24-subagents-agent-settings.dc.html`, the
light card "3 agents need one setting changed". The mock-up is binding for this card: copy its values; where this brief and
the mock-up differ, the mock-up wins and you report the difference. Build only this card, not the rest of that screen.

## What it does
Read `docs/API-CONTRACT.md` section 19; the schemas are in `packages/contract/src/subagents.ts`, and the routes exist already.

- On the Agents page (the top-level Agents screen in the new shell; find it from `docs/CODEMAP.md`), fetch `GET /api/subagent-setup`.
- Show the card only when at least one agent has `inline: false`. When every agent is inline, show nothing at all.
- Heading: "1 agent needs one setting changed" or "N agents need one setting changed".
- Text: "Until then, their subagents can't report back, be stopped or ask for your approval. Score has refused them, so
  nothing runs unsafely."
- A monospace line: `delegation.gateway_mode: inline · ` then the agent ids, comma separated.
- Buttons: "Apply to all N" (primary, ink on the light card) and "Not now" (outline).
  - Apply: `POST /api/subagent-setup/apply` with those agents that have `guard: true`. On success the query refreshes, and the
    card goes away or shrinks. On an error, show the server's message in the card, in the page's existing error style, and
    keep the buttons. While it is posting, disable both buttons and show "Applying…".
  - "Not now" hides the card for this visit (component state only; it comes back on the next visit).
- Agents with `guard: false` can't be applied yet. List them below the line: "Waiting for the updated Score plugin: a, b". If
  no agent can be applied, leave out the Apply button.

## Rules
Follow AGENTS.md, including:
- **Design rules:** this card asks the person to decide, so it carries `data-protected`, and its class is added to the protected
  list (`styles/protected.css` and its test). Tokens scoped under `[data-ui='bold']`; class names prefixed `bold-`; theme tokens
  only, no hard-coded colours beyond what the existing light cards use (look at how a needs-you or approval card does it).
- **File size and the code map:** every file stays at or under 450 lines. A new component goes in its own file
  (`PascalCase.tsx`, a named export of the same name), with its test. Update `docs/CODEMAP.md` for every new file.
- **Audit first** (AGENTS.md): if you touch a file, note anything in scope that's unused; only remove what's proven unused.
- Use TanStack Query and `apiFetch` as the page's other sections do, and validate responses with the contract schema.
- Tests: a component test with fake responses for: all inline (no card), some not inline (heading count, ids), Apply posts only the
  agents with a guard and refreshes, Apply error shown, "Not now" hides it, an agent without a guard listed and no Apply when
  none can be applied.

No new dependencies. Don't edit docs/API-CONTRACT.md or docs/ARCHITECTURE.md, or anything under `apps/server` or `hermes-plugin`.
Don't commit. Never run pkill/killall, never touch ports 8740/8741, never read ~/.hermes or ~/.score, never git stash.

## Checks you run
`pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `node scripts/structure-check.mjs`. **No test runs, no e2e** (owner: no pre-fix checks;
your sandbox can't run them). Call tools only through the tool interface, never as text.

## Report
The files changed, the checks' results, any difference from the mock-up.
