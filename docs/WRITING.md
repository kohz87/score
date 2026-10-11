# Writing in Score

Every word a person reads in Score (labels, buttons, headings, hints, empty states, errors, confirmations, tooltips,
aria-labels, notifications) follows this guide. Owner request 2026-10-11: "vet through all the writings in the
application, make sure they are coherent."

## Voice
- Plain, calm, short. Say what happened and what the person can do next. One idea per sentence.
- Talk to the person as **you**; Score speaks as itself ("Score keeps…"), never "we".
- **British spelling** (colour, organise, cancelled, behaviour, licence as a noun).
- **Sentence case** for everything (headings, buttons, menu items, tabs): "New orchestration", not "New Orchestration".
  Product names keep their own case (Hermes, Claude Code, Codex, Antigravity, Tailscale, MCP, Kanban).
- Buttons are verbs: "Add agent", "Save as new version", "Stop", "Approve". Avoid "OK", "Submit", "Yes/No".
- No internal words in the UI: no ids like `orchestration_owned`, `send_started`, `incarnation`, `attempt`, `fence`,
  `planner`, `token` (except AI tokens), `brief`, `ingest`, `bridge` (say "Score's plugin in Hermes" where needed),
  `payload`, `projection`, `revision`, `409`. Error codes may appear only inside a "Details" disclosure.
- Contractions in errors and notes (couldn’t, can’t, isn’t, doesn’t); full forms only for emphasis.
- Sizes in KB/MB/GB (not KiB/MiB). Technical names that the person types or looks for stay literal in code style:
  `scripts/score …`, environment variables, `.env`, file names.
- Numbers: digits ("3 steps"), thousands separators ("27,751 tokens"), units spaced ("25 MB", "30 s" only in compact
  meters; prose says "30 seconds").
- Times: relative for recent ("12 min ago"), absolute with a date otherwise.
- Ellipsis "…" (one character) for actions that open something more ("Rename…", "Delete room…"); "Loading…".
- Punctuation: full stops on sentences, none on labels/buttons/headings; curly apostrophes and quotes in prose (’ “ ”);
  en dash for ranges (1–3); colon before an explanation, not a dash.
- Errors: what went wrong + what to do, no blame: "Couldn’t save the note. Check the connection and try again."
  Start with "Couldn’t …" for failures, "Can’t …" for things not allowed.
- Empty states: say what will appear here and how to start ("No workflows yet. Draw one with New workflow.").
- Confirmations for destructive actions name the thing and the consequence ("Delete #launch? Its messages are removed
  from Score; your agents’ own Hermes history stays.").

## Glossary (use exactly these words)
| Say | Meaning | Not |
|---|---|---|
| agent | a Hermes profile in Score's team | profile (except in setup/advanced text that must name Hermes profiles), bot |
| coding agent | Claude Code, Codex or Antigravity added to the team | CLI agent, runtime |
| room | a Chat conversation with one or more agents | channel (channels are messaging apps), thread (a thread is a reply chain) |
| direct room | a room with one agent | DM, direct |
| message, reply | what you send / what an agent answers | turn (internal), response |
| task | a Kanban card | ticket, job |
| step | one piece of work inside a run, orchestration or workflow | node (canvas wording "step" too), attempt |
| run | one message and everything it caused (Flow); one execution of an orchestration or workflow | brief |
| orchestration | a lead agent working through a goal | orchestrator run |
| workflow | a drawn pipeline; a **run** of a workflow | workflow run is fine as "run" in context |
| gate | an approval point in a workflow | node gate |
| approval | something waiting for your yes/no | request, permission prompt |
| needs you | the label for items waiting on the person | action required |
| pause / resume / stop | pause = hold new work; stop = end it | cancel (allowed only to back out of a form, dialog or an in-progress canvas gesture), kill, abort |
| Knowledge, note, document | the vault; a Markdown note; an uploaded file | vault (only in setup), doc |
| workspace | an agent's working folder | cwd, directory (in UI) |
| context | what fills an agent's model window | tokens window |
| compact | summarise older turns in an agent's context | compress (except quoting Hermes's `/compress`) |
| pair / paired browser | a browser allowed to control Score | session, logged in |
| security password | the host-set password for sensitive actions | admin password, master password |
| spend | money used (with "not settled" when unknown) | cost (fine in tables), bill |
| the lead | the room's or orchestration's lead agent | coordinator |
| exchange | one message and its reply inside an agent's Hermes session (what Hermes calls a turn) | turn |
| lead turn | one round of an orchestration's lead thinking and handing out work | — (kept; it is visible in the log) |
| run (Kanban) | one time an agent worked on a task | attempt |
| try | one go at a workflow or orchestration step; retries make more tries | attempt |
| stop waiting for | giving up on work Hermes hasn't confirmed as ended | abandon |
| not confirmed as ended | Score can't prove the work stopped | unknown, unconfirmed |
| block / review list | Score holding all new orchestration and workflow work until you review what may be missing after a restore | fence, reconciliation |
| source: confirmed / source unclear | whether Score can prove which agent did something | proven, provenance |
| unknown agent | work Score can't tie to an agent | unattributed |
| agent version | the exact set-up of an agent a step was planned for | incarnation |
| reference name | a workflow step's short id used in references | id |
| Score (the view) | the timeline on Now; say "the Score timeline" where it could mean the app | — |
| access key | a key Score creates for MCP or an agent gateway | token (except platform field names such as "Bot token", which come from the platform) |
| Knowledge folder | the folder on disk that holds Knowledge | vault folder |
| end (a pairing) | sign a paired browser out | terminate, revoke (share links keep "Revoke") |
| Score's plugin in Hermes | the bridge plugin, in UI text | bridge, score_bridge |
| task run | a Kanban run, where "run" alone could be unclear | attempt |

## Where it applies
All user-facing text in `apps/web/src` (JSX text, `aria-label`, `title`, `placeholder`, alt text, toasts, errors mapped
from API codes), server error `message`s that reach the page (`HttpError(…, message)`), notification texts, the PWA
manifest, and the agent-facing tool descriptions in `hermes-plugin/score_bridge` and `apps/server/src/mcp` (plain,
precise, no marketing). Docs (README, USER-GUIDE) follow the same glossary.
