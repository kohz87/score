# S1 Small design items (lead, 2026-10-18; noted during Phases 8–9)

Independent, small UI fixes. One commit per item ("S1 #n: …"), each with a test that fails before it.
1. **Settings › Look › Display currency**: the currency code and rate inputs are unstyled browser defaults. Style them
   like the other Settings inputs (tokens only), keep labels and validation.
2. **Watch: sub-agents nested.** Watch only prefixes "Sub-agent · " to captions (8.7). Show a sub-agent's frames grouped
   under the Agent tool frame like Chat and Flow do (use `parentCallId` / `subagent` already stored; follow
   `apps/web/src/components/subagent.ts`). Old rows without the fields stay flat.
3. **Chat-first view: workflow rooms** still show the admin `WorkflowRoomPanel` with an "Open the live diagram" link that
   doesn't switch views. In the user view, render a compact workflow header like `UserRunPanel` (title, status, Pause/Stop
   where the workflow supports them, "See full details" that switches to the admin view through the guard).
4. **README screenshots**: regenerate the README's per-function screenshots (fake mode, no persona names) with the
   current look — the existing generator is `pnpm screenshots` (e2e/readme/). Only replace images whose screen changed.
Rules: frontend only (no server/contract change; if one is needed, stop and report), tokens only, plain words
(docs/WRITING.md). Existing baselines may change only for the screens an item touches — list each.
