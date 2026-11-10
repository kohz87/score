# Effort per chat (design note, decision 178)

The owner, 2026-11-10: "can we do effort setting in chat? direct chat, if it's in a group, it can be @agent /effort etc, so we can custom the
effort setting for that session". Then: Chat info's members show it, or people miss it. Mock-up approved the same day:
`docs/design/bold/mockups/25-effort-*.dc.html` (binding).

## What it is
- One agent, one chat. The level stays until changed there; other chats use the agent's own. It doesn't reset with a new job in the chat.
- It changes nothing in the agent's settings: Hermes gets it per run (`model_options.reasoning_effort`, which the API server already takes);
  Claude Code and Codex get their effort flag for that turn. An orchestration's or workflow's steps use the agent's own.
- Levels: what the agent's program takes. Hermes: `low, medium, high, xhigh, max` (Hermes accepts more; Score offers these, and Hermes
  ignores a level a model doesn't support). A level the agent no longer takes (it moved program) goes back to its own, and the chat says so.

## Where it shows (from the mock-up)
- `/effort` in the composer (group: `@agent /effort max`, or the addressed agent), with only that agent's levels, and "Back to its own".
- A one-line note with Undo when it changes.
- The context bar: "Effort max" beside the model for the agent being written to. `max` is amber.
- Chat info › Members: a tag on each agent set differently; no tag means its own. On a phone the tags are buttons.
- A direct chat's Info: "This chat" block with Change effort and Back to its own; a small tag in the chat list.
- Replies say "builder · effort high".
- Agent settings › Model: "Set differently in N chats", each with its level.

## Not doing
Per-message effort (`/model` covers a one-off model); effort for orchestration steps; levels per model (Score doesn't know them for
Hermes; the program's list is used).
