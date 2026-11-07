# CS.5 — the specs that still fail in a full e2e run (brief)

Owner, 2026-11-07 (decisions 168–171). After CS.3, full runs still had a few intermittent failures, none in the ten specs
CS.3 fixed. Make each of these pass reliably in a full run, or prove it is an app bug and stop:

- `e2e/bold-room-tools.spec.ts` at 390 wide: the Unpin menu item is missing (failed in three runs; likely a shared pin
  limit — other specs pin in the same room).
- `e2e/orchestrations.spec.ts` "dots run along the job map" (also failed on main before CS.3).
- `e2e/themes-bold.spec.ts`, `e2e/themes-bold-visual.spec.ts`, `e2e/terminal.spec.ts`, `e2e/bold-room-files.spec.ts`.
- `e2e/bold-message-actions.spec.ts`, `e2e/bold-try-another.spec.ts`: match on "2 / 2" or a note that replies from
  other chats in the merged one-to-one stream can duplicate.
- `e2e/readme/readme-screenshots.spec.ts` clicks `button.side-toggle`, which no component renders any more (stale):
  find what replaced it and update the spec, or say why the spec should go.

## How
Same approach as CS.3 (read `docs/briefs/CS.3.md` and `git log --grep CS.3`): find the shared state each spec depends
on, give it its own (room, chat, session, pinned fixture), never reset what other specs use, keep every assertion. For a
pure timing flake, wait on the real condition the app exposes (an attribute, an aria state, a response), never a fixed
sleep, and never loosen what is checked.

## Rules
Follow AGENTS.md (450 lines and the code map; audit first). Only `e2e/` changes; if the app has a real bug, stop and report
it. Never weaken an assertion; never update a screenshot baseline unless the difference comes only from fixture data the
spec now owns (say which and why). Use port 6382 (`SCORE_WEB_PORT=6382 pnpm e2e …`), `--workers` at most 2, build once
with `pnpm build`. Never touch 8740/8741, never read ~/.hermes or ~/.score, never pkill/killall, never `SCORE_E2E_DEV=1`,
never git stash, don't commit. Before each full run check `node scripts/capacity.mjs` and wait while it is over 70%.

## Done when
The listed specs pass together, then two full runs (`SCORE_WEB_PORT=6382 pnpm e2e`) have none of them failing, and
`pnpm exec prettier --check e2e`, `pnpm lint` and `node scripts/structure-check.mjs` pass. Report each spec's cause and
fix, the full-run results, anything left.
