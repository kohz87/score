# Score code map

Use this map before searching the tree. Each section lists source folders first, then the files most
likely to be the entry point for a change.

## I want to change …

- App startup, routing or shell choice → `apps/web/src/main.tsx`, `apps/web/src/App.tsx`
- The bold frame, navigation or screen shell → `apps/web/src/bold/BoldShell.tsx`
- A bold screen → `apps/web/src/bold/`
- The team room, messages or needs-you cards → `apps/web/src/bold/room/`
- Starting a job → `apps/web/src/bold/BoldStartJob.tsx`, `apps/web/src/bold/bold-start-job.ts`, `apps/web/src/bold/use-start-job-view.ts`
- Chat messages or the composer → `apps/web/src/routes/chat/`
- The live browser stream → `apps/web/src/data/stream.ts`
- API calls and cache keys → `apps/web/src/data/api.ts`, `apps/web/src/data/query-client.ts`
- Styles, tokens or protected surfaces → `apps/web/src/styles/`
- Themes and the customizer → `apps/web/src/themes/`, `apps/server/src/themes/`
- Knowledge notes and files → `apps/web/src/routes/knowledge/`, `apps/server/src/knowledge/`
- Workflows and orchestration runs → `apps/web/src/routes/workflows/`, `apps/server/src/domain/workflows/`
- The orchestration executor → `apps/server/src/domain/orchestration/executor.ts`
- A server API route → `apps/server/src/http/`
- Server startup and route registration → `apps/server/src/index.ts`, `apps/server/src/start-server.ts`, `apps/server/src/app.ts`
- Live event ingest and fan-out → `apps/server/src/hub/`
- The Hermes adapter boundary → `apps/server/src/hermes/index.ts`
- Fake Hermes for tests and e2e → `apps/server/src/hermes/fake/`
- The Python bridge plugin → `hermes-plugin/score_bridge/`
- A shared request or event schema → `packages/contract/src/`
- A database migration → `apps/server/migrations/`
- Repo checks and tooling → `scripts/`
- Browser end-to-end coverage → `e2e/`

## apps/web/src

### Folders

- `apps/web/src/` — SPA bootstrap, root router and the classic/bold shell choice.
- `apps/web/src/bold/` — the new dark shell: screens, navigation, room, look, settings section styles and other bold-only styles.
- `apps/web/src/bold/agent-more/` — per-agent detail cards for settings, access, routines and removal.
- `apps/web/src/bold/chats/` — bold chat list, chat information and run controls.
- `apps/web/src/bold/direct/` — one-to-one chat with an agent.
- `apps/web/src/bold/jobmap/` — job map and step graph for a running job.
- `apps/web/src/bold/room/` — team room, message stream, needs-you cards, menus, room state and split room styles.
- `apps/web/src/bold/take-over/` — leased Hermes bot desktop screen and input handling.
- `apps/web/src/bold/triggers/` — trigger cards, secret display and the four-step trigger wizard.
- `apps/web/src/components/` — shared UI: agent identity, glyphs, model pickers, editor and uploads.
- `apps/web/src/components/flow-layout/` — workflow node placement helpers.
- `apps/web/src/components/model-settings/` — model aliases, effort, speech and fallback controls.
- `apps/web/src/data/` — REST and SSE clients, session, query helpers, app-wide data utilities and their feature-split tests.
- `apps/web/src/live/` — live status, activity and recently-resolved widgets.
- `apps/web/src/motion/` — animation helpers and arrival/tween components.
- `apps/web/src/notifications/` — browser notifications, preferences and click routing.
- `apps/web/src/pwa/` — service worker and update banner.
- `apps/web/src/routes/` — destination pages mounted by the app router.
- `apps/web/src/routes/attempts/` — attempt detail and replay page.
- `apps/web/src/routes/chat/` — classic chat page, composer, message rendering, dialogs and ordered stylesheets.
- `apps/web/src/routes/customizer/` — theme customizer and its live preview.
- `apps/web/src/routes/knowledge/` — knowledge browser, note editor, files, images and tables.
- `apps/web/src/routes/orchestrations/` — orchestration run panels, decisions and live diagram.
- `apps/web/src/routes/pair/` — pairing and sign-in page.
- `apps/web/src/routes/reports/` — reports pages and journey chart.
- `apps/web/src/routes/runs/` — helpers for opening a brief as a run.
- `apps/web/src/routes/settings/` — settings sections for providers, logs, backup and notifications.
- `apps/web/src/routes/team/` — team and agent pages, coding agent, model and workspace tabs.
- `apps/web/src/routes/terminal/` — browser terminal page and key handling.
- `apps/web/src/routes/watch/` — watch replay timeline, stage and replay model.
- `apps/web/src/routes/workflows/` — workflow editor, nodes, runs, recipes and previews.
- `apps/web/src/shell/` — classic-shell navigation and frame helpers.
- `apps/web/src/styles/` — global tokens, select and protected styles, built-in packs.
- `apps/web/src/styles/packs/` — dense, night and paper display packs.
- `apps/web/src/test/` — web test setup, controlled XHR and shared fixtures.
- `apps/web/src/themes/` — theme engine, look runtime, contrast, sanitising and guards.
- `apps/web/src/themes/customizer/` — customizer draft, package, zip, save and measurement helpers.

### Key files

- `apps/web/src/main.tsx` — browser bootstrap: routers, providers, stream, theme and service worker.
- `apps/web/src/App.tsx` — route table and classic/bold shell choice.
- `apps/web/src/bold/BoldLibrary.tsx` — Library page: state, queries and the layout of nav, main and dialogs.
- `apps/web/src/bold/BoldLibraryNav.tsx` — Library folder tree, note groups and drag-and-drop.
- `apps/web/src/bold/BoldLibraryMain.tsx` — Library main pane: the selected note or folder and its actions.
- `apps/web/src/bold/BoldLibraryDialogs.tsx` — Library dialogs: new note, new folder, move and delete (notes and folders).
- `apps/web/src/bold/BoldLibrarySearchResults.tsx` — Library search results list.
- `apps/web/src/bold/BoldLibraryByline.tsx` — who wrote a note, and the selected note's byline.
- `apps/web/src/bold/bold-library-model.ts` — Library types, layout constants, collapsed-state storage and grouping helpers.
- `apps/web/src/bold/BoldShell.tsx` — bold frame, navigation and route outlet.
- `apps/web/src/bold/bold.css` — bold shell style entry; imports the area stylesheets in cascade order.
- `apps/web/src/bold/bold-base.css` — scoped resets, shared utilities and the button and icon controls.
- `apps/web/src/bold/bold-topbar.css` — top bar, section links, wordmark, navigation, dock, search and avatar.
- `apps/web/src/bold/bold-room-layout.css` — room grid, header, stream, page frame and the info side panel.
- `apps/web/src/bold/bold-menus.css` — floating menu primitives and room-picker preview rows.
- `apps/web/src/bold/bold-fit.css` — full-window room layout under `body.fit`.
- `apps/web/src/bold/bold-motion.css` — live and pulse animations with the reduced-motion reset.
- `apps/web/src/bold/bold-responsive.css` — laptop, phone and tablet shell, room layout and touch targets.
- `apps/web/src/bold/bold-notices.css` — fence and update notices, project and archive surfaces, and the classic primary-button fix.
- `apps/web/src/bold/BoldRecipes.tsx` — recipes library route and page entry.
- `apps/web/src/bold/BoldRecipeRoute.tsx` — one recipe's loading states, new/built-in choices and editor hand-off.
- `apps/web/src/bold/BoldRecipeEditor.tsx` — recipe editor composition and export dialog.
- `apps/web/src/bold/BoldRecipeEditorHeader.tsx` — recipe name, view tabs, preview, save and More menu.
- `apps/web/src/bold/BoldRecipeEditorStatus.tsx` — problems, notices, conflicts, version-view note and delete-with-runs dialog.
- `apps/web/src/bold/BoldRecipeWorkspace.tsx` — graph and text panels, recipe details and settings pane.
- `apps/web/src/bold/BoldRecipeInspector.tsx` — selected graph node or text step settings.
- `apps/web/src/bold/DeleteWithRunsDialog.tsx` — name-confirmed recipe and runs deletion dialog.
- `apps/web/src/bold/bold-recipe-editor-model.ts` — editor props, problem types, deduplication and error copy.
- `apps/web/src/bold/use-bold-recipe-editor-state.ts` — editor draft, queries, validation, history and derived state.
- `apps/web/src/bold/use-bold-recipe-editor-focus.ts` — step focus, card focus and narrow-sheet behaviour.
- `apps/web/src/bold/use-bold-recipe-editor-actions.ts` — recipe edits, save, version, archive and delete commands.
- `apps/web/src/bold/BoldAddAgent.tsx` — Add agent trigger, dialog flow and coding tool panel.
- `apps/web/src/bold/BoldAddAgentAdded.tsx` — joined-team result and where-an-agent-runs summary.
- `apps/web/src/bold/BoldAddAgentAppearance.tsx` — agent shape and colour picker with live glyph preview.
- `apps/web/src/bold/BoldAddAgentImportPanel.tsx` — Hermes profile archive upload, inspection and import form.
- `apps/web/src/bold/BoldAddAgentNewPanel.tsx` — new Hermes agent form and review-changes block.
- `apps/web/src/bold/BoldAddAgentRuns.tsx` — where-an-agent-runs fields, save hook and progress state.
- `apps/web/src/bold/bold-add-agent-types.ts` — Add agent dialog, runs and result types with option labels.
- `apps/web/src/bold/BoldStartJob.tsx` — start-job public entry, protected surfaces and dialog composition.
- `apps/web/src/bold/BoldStartJobFields.tsx` — chat, work description and recipe fields.
- `apps/web/src/bold/BoldStartJobPlanFields.tsx` — lead, agents allowed, when, approvals and advisor fields.
- `apps/web/src/bold/BoldStartJobHelperFields.tsx` — helpers, automatic votes/audits and coding launches.
- `apps/web/src/bold/BoldStartJobCheckFields.tsx` — pre-finish command check fields.
- `apps/web/src/bold/BoldStartJobLimitFields.tsx` — limits, deadline, workflow options, unknown cost and inputs.
- `apps/web/src/bold/BoldStartJobParts.tsx` — checklist rows, auth fields, result cards and dialog actions.
- `apps/web/src/bold/use-start-job-view.ts` — composes the start-job state, queries, model and actions.
- `apps/web/src/bold/use-start-job-state.ts` — start-job form state and refs.
- `apps/web/src/bold/use-start-job-refs.ts` — start-job dialog, auth and attempt refs.
- `apps/web/src/bold/use-start-job-data.ts` — start-job queries and room/agent derivation.
- `apps/web/src/bold/start-job-derive.ts` — start-job checks, validation and request-visible model.
- `apps/web/src/bold/start-job-model.ts` — recipe preselection effect over the derived model.
- `apps/web/src/bold/start-job-form-actions.ts` — dialog close, recipe and keyboard actions.
- `apps/web/src/bold/start-job-start-actions.ts` — run, job, recipe, routine, trigger and auth actions.
- `apps/web/src/bold/start-job-types.ts` — start-job options, recipe choice, result and limit types.
- `apps/web/src/bold/start-job-context.ts` — start-job opener context and hook.
- `apps/web/src/bold/start-job-checks.ts` — room and preflight check conversion.
- `apps/web/src/bold/start-job-copy.ts` — size text and start/auth error messages.
- `apps/web/src/bold/bold-start-job.ts` — start-job model and request shaping.
- `apps/web/src/bold/bold-recipes.css` — Recipes style entry; imports the area stylesheets in cascade order.
- `apps/web/src/bold/bold-recipes-list.css` — Recipes view switch, badges, page actions, columns, step rows and route controls.
- `apps/web/src/bold/bold-recipes-settings.css` — Recipe route fields, step settings, gate/rules, conflict and graph surfaces.
- `apps/web/src/bold/bold-recipes-editor.css` — Recipe editor page: tokens, header, problems, graph body, settings sidebar and narrow layout.
- `apps/web/src/bold/bold-recipes-sheets.css` — Archived-recipe deletion dialog, add-to-step controls and phone settings sheet.
- `apps/web/src/bold/bold-recipes-library.css` — Recipe library cards and responsive grid, plus the detached run sheet.
- `apps/web/src/bold/bold-settings-shell.css` — Settings frame and shared classic card, form and control surfaces.
- `apps/web/src/bold/bold-settings-rules.css` — Rules mode, columns, forms and save surfaces.
- `apps/web/src/bold/bold-settings-advanced.css` — Advanced search, staged values, tray and diff.
- `apps/web/src/bold/bold-settings-security.css` — Remote access and security lists, password and customize link.
- `apps/web/src/bold/bold-settings-system.css` — System cards, logs, pause and about facts.
- `apps/web/src/bold/bold-settings-usage.css` — Usage summary, charts, tables and spending bars.
- `apps/web/src/bold/bold-settings-connections.css` — Connection lists, statuses, local models and phone pairing.
- `apps/web/src/bold/bold-settings-tools.css` — Tool servers, shared buttons and chips, and textarea controls.
- `apps/web/src/bold/bold-settings-triggers.css` — Webhook trigger cards and the trigger creation wizard.
- `apps/web/src/bold/triggers/wizard-model.ts` — trigger wizard types, defaults, request shaping and error/display copy.
- `apps/web/src/bold/triggers/SecretCard.tsx` — signing-secret card and copy action.
- `apps/web/src/bold/triggers/TriggerCard.tsx` — trigger card actions and trigger state summary.
- `apps/web/src/bold/triggers/WizardBody.tsx` — trigger wizard shell, step indicator and step dispatch.
- `apps/web/src/bold/triggers/WizardSetupStep.tsx` — trigger name, app and team setup step.
- `apps/web/src/bold/triggers/WizardTestStep.tsx` — webhook address, secret and test-call step.
- `apps/web/src/bold/triggers/WizardMapStep.tsx` — payload field mapping and job wording step.
- `apps/web/src/bold/triggers/WizardReportStep.tsx` — report-back mode, tool and argument template step.
- `apps/web/src/bold/bold-settings-look.css` — Visually hidden utility and Look modes, themes, scale and currency controls.
- `apps/web/src/bold/bold-settings-responsive.css` — Settings frame, grid and section-page responsive rules.
- `apps/web/src/bold/bold-settings-workspaces.css` — Workspace cards, agent chips and shared folders.
- `apps/web/src/bold/chats/chats.css` — bold chats style entry; imports the area stylesheets in cascade order.
- `apps/web/src/bold/chats/chats-list.css` — chat list column, rail, search, rows, tiles, needs pill and chat meta.
- `apps/web/src/bold/chats/chats-info.css` — Info section folds, members, topics and Chat info controls.
- `apps/web/src/bold/chats/chats-layout.css` — desktop and phone chat layout, chat bar and side-column sizing.
- `apps/web/src/bold/chats/chats-conversation.css` — topic divider, system line, composer palette, context bar, side tabs and top-bar links.
- `apps/web/src/bold/chats/chats-topic.css` — This topic, context details, Graph tab, phone chat menu and phone topic targets.
- `apps/web/src/bold/chats/chats-files.css` — Info files rows and the viewer sheet.
- `apps/web/src/bold/room/BoldTeamRoom.tsx` — team room composition.
- `apps/web/src/bold/room/RoomMessageStream.tsx` — room message stream rendering and follow behaviour.
- `apps/web/src/bold/room/RoomMenus.tsx` — compatibility barrel for the room, job and chat menu exports.
- `apps/web/src/bold/room/menu-primitives.tsx` — menu dots, focus and Escape lifecycle, and arrow-key navigation.
- `apps/web/src/bold/room/room-menu-model.ts` — the older-room predicate shared by the room title and switcher.
- `apps/web/src/bold/room/RoomSwitcher.tsx` — older, team, imported and elsewhere-session room list.
- `apps/web/src/bold/room/ArchivedBadge.tsx` — archived-room badge and unarchive action.
- `apps/web/src/bold/room/job-lifecycle-error.ts` — job and chat lifecycle error messages.
- `apps/web/src/bold/room/JobDialogs.tsx` — rename and delete job dialogs.
- `apps/web/src/bold/room/RoomDialogs.tsx` — team lead, rename, project and workspace room dialogs.
- `apps/web/src/bold/room/RoomMenu.tsx` — room actions menu and its organised-room dialogs.
- `apps/web/src/bold/room/JobMenu.tsx` — job actions menu.
- `apps/web/src/bold/room/RoomTitle.tsx` — desktop and phone room-title composition.
- `apps/web/src/bold/room/ChatMenu.tsx` — one-to-one chat actions menu.
- `apps/web/src/bold/room/ChatDialogs.tsx` — delete and clear one-to-one chat dialogs.
- `apps/web/src/bold/room/use-needs-you.ts` — needs-you selection and state.
- `apps/web/src/bold/room/bold-room.css` — team-room style entry; imports the area stylesheets in cascade order.
- `apps/web/src/bold/room/bold-room-header.css` — room tabs, job filters, tools and the deleted toggle.
- `apps/web/src/bold/room/bold-room-needs.css` — needs-you slots, jump chip, request cards, source and report-back.
- `apps/web/src/bold/room/bold-room-run-cards.css` — classic run request cards and run capsules.
- `apps/web/src/bold/room/bold-room-messages.css` — message stream, bubbles, actions, history, versions and results.
- `apps/web/src/bold/room/bold-room-states.css` — read-only agent chats and the empty-team-room onboarding.
- `apps/web/src/bold/room/bold-room-composer.css` — room composer shell, attachments, send controls and editing notice.
- `apps/web/src/bold/room/bold-room-responsive.css` — phone and narrow-screen room layout and touch targets.
- `apps/web/src/bold/room/bold-room-job-controls.css` — knowledge backdrop, job fold, questions, reply versions and team pickers.
- `apps/web/src/bold/room/bold-room-job-bar.css` — job bar, Next up, busy dialog and job-strip states.
- `apps/web/src/data/api.ts` — API request wrapper and session handling.
- `apps/web/src/data/stream.ts` — resumable browser SSE client.
- `apps/web/src/data/query-client.ts` — query client and stream context.
- `apps/web/src/data/stream-helpers.ts` — shared fake EventSource, stream fixtures and query-registry setup for the stream tests.
- `apps/web/src/routes/chat/Composer.tsx` — classic chat composer and send flow.
- `apps/web/src/routes/chat/composer-types.ts` — composer props, notice/snapshot types and shared draft types.
- `apps/web/src/routes/chat/composer-local-command.ts` — `/compress`, `/usage` and `/model` handling.
- `apps/web/src/routes/chat/composer-send.ts` — message posting, optimistic updates, rewind and send retries.
- `apps/web/src/routes/chat/ComposerNotice.tsx` — composer notice banner and command result text.
- `apps/web/src/routes/chat/ComposerMenu.tsx` — slash-command and agent mention menu.
- `apps/web/src/routes/chat/ComposerEditing.tsx` — edit notice and rewind confirmation.
- `apps/web/src/routes/chat/ComposerAttachments.tsx` — attachment tray, upload progress and Knowledge save chips.
- `apps/web/src/routes/chat/ComposerToPicker.tsx` — recipient chips, add-person menu and plan-first toggle.
- `apps/web/src/routes/chat/ComposerAttachControls.tsx` — file input, attach menu, voice button and command shortcuts.
- `apps/web/src/routes/chat/ComposerSendControls.tsx` — context rings, stop and send controls.
- `apps/web/src/routes/chat/use-composer-editing.ts` — edit session, draft stash and rewind state.
- `apps/web/src/routes/chat/use-composer-room.ts` — room message state, stop replies, subject and context-ring state.
- `apps/web/src/routes/chat/use-composer-menu.ts` — command query, slash/mention suggestions and menu selection.
- `apps/web/src/routes/chat/use-composer-voice.ts` — voice input lifecycle and draft updates.
- `apps/web/src/routes/chat/use-composer-uploads.ts` — uploads, attachment state, Knowledge saving and live draft ref.
- `apps/web/src/routes/chat/MessageItem.tsx` — chat message rendering.
- `apps/web/src/routes/chat/chat.css` — ordered entry for the classic chat stylesheets.
- `apps/web/src/routes/chat/chat-shell.css` — New chat actions, direct-room link, thread frame and title.
- `apps/web/src/routes/chat/chat-messages.css` — message rows and text, plan cards and approval cards.
- `apps/web/src/routes/chat/chat-composer.css` — composer frame and menus, side cards and early breakpoints.
- `apps/web/src/routes/chat/chat-message-actions.css` — attachments, images, message actions, editing and toasts.
- `apps/web/src/routes/chat/chat-markdown.css` — markdown replies, code blocks and tool/thinking cards.
- `apps/web/src/routes/chat/chat-composer-controls.css` — stop, voice and send controls plus the context meter.
- `apps/web/src/routes/chat/chat-conversations.css` — conversation search, share dialog, imported rooms, rewind and versions.
- `apps/web/src/routes/chat/chat-documents.css` — attach menus, file chips, document preview and workspace picker.
- `apps/web/src/routes/chat/chat-room.css` — room summary/status, compact layout, attachment saving and room actions.
- `apps/web/src/routes/chat/chat-theme.css` — theme overrides for room and message presentation.
- `apps/web/src/routes/orchestrations/orchestrations.css` — ordered entry for the orchestration stylesheets.
- `apps/web/src/routes/orchestrations/orchestrations-base.css` — shared controls, heading, status and badges.
- `apps/web/src/routes/orchestrations/orchestrations-decisions.css` — decisions, forms, preflight checks and dialog chrome.
- `apps/web/src/routes/orchestrations/orchestrations-diagram.css` — main run layout, canvas, edges, nodes and step states.
- `apps/web/src/routes/orchestrations/orchestrations-log-cards.css` — event log, replay bar, step cards, room header and fence list.
- `apps/web/src/routes/orchestrations/orchestrations-workflow.css` — workflow shapes, edge labels, node transitions and summary slot.
- `apps/web/src/routes/orchestrations/orchestrations-run-cards.css` — coding, check, stuck-step, advisor, helper and vote cards.
- `apps/web/src/routes/customizer/Customizer.tsx` — customizer composition: probe, derived values, early states and page layout.
- `apps/web/src/routes/customizer/CustomizerBar.tsx` — header, undo/save/export/import actions, messages and edit/preview switch.
- `apps/web/src/routes/customizer/CustomizerModals.tsx` — save-as, start-from confirmation, import and leave-without-saving dialogs.
- `apps/web/src/routes/customizer/CustomizerPanel.tsx` — section tabs and the active theme section panel.
- `apps/web/src/routes/customizer/CustomizerPreview.tsx` — preview page/size controls, frame, contrast checks and use buttons.
- `apps/web/src/routes/customizer/CustomizerTabs.tsx` — customizer tab list, ids and keyboard navigation.
- `apps/web/src/routes/customizer/customizer-helpers.ts` — system colour mode, zip download and manifest-settings check.
- `apps/web/src/routes/customizer/customizer-types.ts` — customizer target, source, busy and pane types.
- `apps/web/src/routes/customizer/theme-files.ts` — read a theme snapshot and rebuild the snapshot after a save.
- `apps/web/src/routes/customizer/use-customizer-actions.ts` — save, export, use, import, start-from and keyboard actions with their status state.
- `apps/web/src/routes/customizer/use-theme-loader.ts` — open the addressed theme, copy built-ins and own history/target/load state.
- `apps/web/src/routes/team/CodingAgent.tsx` — coding-agent detail page.
- `apps/web/src/routes/knowledge/NoteWorkspace.tsx` — note editor workspace.
- `apps/web/src/routes/knowledge/knowledge.css` — ordered entry for the classic knowledge stylesheets.
- `apps/web/src/routes/knowledge/knowledge-shell.css` — left tree/main card shells, headings, shared controls and actions.
- `apps/web/src/routes/knowledge/knowledge-note.css` — tree/list, note workspace and side-panel props/history.
- `apps/web/src/routes/knowledge/knowledge-dialogs.css` — dialog frame/form layout and Settings › Knowledge rows.
- `apps/web/src/routes/knowledge/knowledge-editor-frame.css` — CodeMirror host sizing and responsive page layout.
- `apps/web/src/routes/knowledge/knowledge-editor-preview.css` — live-preview typography, markdown widgets, rendered tables and resizers.
- `apps/web/src/routes/knowledge/knowledge-files.css` — file manager, document view, file tables and upload dialogs.
- `apps/web/src/routes/knowledge/knowledge-toolbar.css` — Source toggle and editor toolbar controls.
- `apps/web/src/routes/knowledge/knowledge-images.css` — embedded image rendering, alt editing and source chips.
- `apps/web/src/routes/knowledge/knowledge-cell-editing.css` — version-body sizing, in-place table-cell editing and editor focus.
- `apps/web/src/routes/knowledge/knowledge-upload.css` — upload progress card.
- `apps/web/src/routes/watch/watch-model.ts` — watch timeline and replay model.
- `apps/web/src/themes/guard.ts` — protected-surface and theme guard.
- `apps/web/src/styles/protected.css` — surfaces that themes may never hide or fake.
- `apps/web/src/components/AgentGlyph.tsx` — agent colour-and-shape identity.

## apps/server/src

### Folders

- `apps/server/src/` — Fastify bootstrap, configuration and app composition.
- `apps/server/src/auth/` — pairing, sessions, passkeys, CSRF, passwords and remote security.
- `apps/server/src/db/` — Score SQLite open, migrate, lock, FTS and epochs.
- `apps/server/src/domain/` — room, task, approval, report, profile and other domain rules.
- `apps/server/src/domain/exchanges/` — exchange requests, budgets, results and workbench state.
- `apps/server/src/domain/orchestration/` — orchestrator state, executor method modules, journal, fences and checks.
- `apps/server/src/domain/triggers/` — webhook triggers, signatures, queue and report-back.
- `apps/server/src/domain/workflows/` — workflow definitions, planner, runs and views.
- `apps/server/src/hermes/` — the Node-side Hermes boundary and its public adapter surface.
- `apps/server/src/hermes/bridge/` — Python bridge producers, routes, ingest and retention.
- `apps/server/src/hermes/fake/` — scripted fake Hermes for development, tests and e2e: state, providers, settings, agents, tasks, runs and run control.
- `apps/server/src/hermes/live/` — live Hermes adapter: gateway, SQLite, CLI, profiles and tasks.
- `apps/server/src/hermes/live/kanban-attempts/` — read, project and associate Kanban attempts.
- `apps/server/src/http/` — API routes, one file per contract section.
- `apps/server/src/http/rooms/` — split room catalogue, message, rewind, summary and version route groups.
- `apps/server/src/hub/` — ordered event ingest, projections, SSE fan-out, snapshots and retention.
- `apps/server/src/knowledge/` — vault files, notes, extraction, links, export and staging.
- `apps/server/src/locks/` — OS-level lock helpers.
- `apps/server/src/mcp/` — MCP access control, routes and tools.
- `apps/server/src/media/` — upload storage, multipart parsing and type sniffing.
- `apps/server/src/runtimes/` — agent runtime implementations.
- `apps/server/src/runtimes/check/` — spawn-based check command runner.
- `apps/server/src/runtimes/coding/` — coding-agent drivers, process supervisor, units, quotas and the split coding runtime service.
- `apps/server/src/shares/` — public share pages, markdown and rate limits.
- `apps/server/src/terminal/` — PTY terminal manager, tickets and environment.
- `apps/server/src/themes/` — theme packages, built-ins, CSS validation and storage.
- `apps/server/src/workspace/` — workspace roots, git, policy and per-agent workspaces.
- `apps/server/migrations/` — forward-only numbered SQL migrations.
- `apps/server/scripts/` — server maintenance scripts.

### Key files

- `apps/server/src/index.ts` — process entry and signal handling.
- `apps/server/src/start-server.ts` — server, database, adapter and background services wiring.
- `apps/server/src/app.ts` — Fastify app and route registration.
- `apps/server/src/config.ts` — environment configuration.
- `apps/server/src/db/index.ts` — database open and migration surface.
- `apps/server/src/hub/ingest.ts` — the single ordered event ingest path.
- `apps/server/src/hub/sse.ts` — browser SSE endpoint and fan-out.
- `apps/server/src/http/rooms.ts` — room route registration, shared setup and the commands catalogue.
- `apps/server/src/http/rooms/context.ts` — shared dependencies passed to the room route groups.
- `apps/server/src/http/rooms/route-schemas.ts` — zod schemas for room, message and query inputs.
- `apps/server/src/http/rooms/room-routes.ts` — room catalogue, team-room, create/update/delete and room-detail routes.
- `apps/server/src/http/rooms/message-read-routes.ts` — message page reads, deletion and clearing a direct thread.
- `apps/server/src/http/rooms/message-post-routes.ts` — posting a message, attachments, routing and message persistence.
- `apps/server/src/http/rooms/message-run-routes.ts` — retry and stop for a message's run.
- `apps/server/src/http/rooms/rewind-routes.ts` — rewind plan and rewind routes.
- `apps/server/src/http/rooms/rewind-guard.ts` — shared rewind-in-progress guard.
- `apps/server/src/http/rooms/summary-routes.ts` — room summary generate, edit and delete routes.
- `apps/server/src/http/rooms/version-routes.ts` — room version list and version-message reads.
- `apps/server/src/http/stream.ts` — stream route.
- `apps/server/src/domain/orchestration/executor.ts` — public Orchestrator facade, constructor state and re-exports.
- `apps/server/src/domain/orchestration/executor-admission.ts` — choosing queued work and admitting runs.
- `apps/server/src/domain/orchestration/executor-capacity.ts` — capacity and storage usage reads.
- `apps/server/src/domain/orchestration/executor-checks.ts` — check process lifecycle and the lead's check view.
- `apps/server/src/domain/orchestration/executor-coding.ts` — coding launch closure and reconciliation.
- `apps/server/src/domain/orchestration/executor-create.ts` — lead orchestration creation and its transaction.
- `apps/server/src/domain/orchestration/executor-decisions.ts` — human decisions on lead runs.
- `apps/server/src/domain/orchestration/executor-dispatch.ts` — attempt rows, dispatch and wake scheduling.
- `apps/server/src/domain/orchestration/executor-insert.ts` — orchestration, attempt and step row insertion.
- `apps/server/src/domain/orchestration/executor-lifecycle.ts` — start, pump, cycle, transactions and finalization.
- `apps/server/src/domain/orchestration/executor-maintenance.ts` — journal compaction and retention pruning.
- `apps/server/src/domain/orchestration/executor-observation.ts` — run evidence, reconciliation and accepted results.
- `apps/server/src/domain/orchestration/executor-preflight.ts` — lead-run preflight checks.
- `apps/server/src/domain/orchestration/executor-reads.ts` — lead-run reads and hold journaling.
- `apps/server/src/domain/orchestration/executor-recovery-repair.ts` — startup repairs and legacy backfills.
- `apps/server/src/domain/orchestration/executor-recovery.ts` — crash recovery and unknown-attempt marking.
- `apps/server/src/domain/orchestration/executor-release.ts` — send failures and release decisions.
- `apps/server/src/domain/orchestration/executor-run-facts.ts` — terminal run evidence helpers.
- `apps/server/src/domain/orchestration/executor-runtime.ts` — internal runtime shape and prototype assembly.
- `apps/server/src/domain/orchestration/executor-send.ts` — coding turn start, send handles and generation rows.
- `apps/server/src/domain/orchestration/executor-settling.ts` — per-run settling and pause helpers.
- `apps/server/src/domain/orchestration/executor-signals.ts` — agent readiness, admission changes and MCP tools.
- `apps/server/src/domain/orchestration/executor-stops.ts` — owed Stop delivery.
- `apps/server/src/domain/orchestration/executor-types.ts` — public executor options/types and quota constant.
- `apps/server/src/domain/orchestration/executor-workflow-create.ts` — workflow run creation.
- `apps/server/src/domain/orchestration/executor-workflow-decisions.ts` — human decisions on workflow runs.
- `apps/server/src/domain/orchestration/executor-workflow-preflight.ts` — workflow validation, preflight and reads.
- `apps/server/src/domain/orchestration/fence.ts` — decision fences and turn ownership.
- `apps/server/src/domain/orchestration/journal.ts` — execution journal facade: durable append, critical sections, reads, compaction and restore markers.
- `apps/server/src/domain/orchestration/journal-entry.ts` — execution journal entry schemas and body types.
- `apps/server/src/domain/orchestration/journal-history.ts` — history-reset and execution-freeze folding.
- `apps/server/src/domain/orchestration/journal-dispatch.ts` — latest dispatch state per attempt.
- `apps/server/src/domain/orchestration/journal-io.ts` — durable I/O seam, checksummed journal lines and shared read types.
- `apps/server/src/domain/orchestration/journal-files.ts` — journal parsing, torn-tail repair, tail numbering and directory sync.
- `apps/server/src/domain/orchestration/journal-markers.ts` — history and restore marker files plus launch-folder evidence.
- `apps/server/src/domain/orchestration/journal-folds.ts` — generation and coding-record folds used by compaction.
- `apps/server/src/domain/orchestration/journal-compaction.ts` — compaction planning and permanent tombstones.
- `apps/server/src/domain/orchestration/journal-paths.ts` — journal file names and the size-alarm constant.
- `apps/server/src/domain/exchanges/apply.ts` — applies accepted exchange results.
- `apps/server/src/hermes/index.ts` — the only server entry into Hermes code.
- `apps/server/src/hermes/port.ts` — Hermes adapter interface.
- `apps/server/src/hermes/live/live-port.ts` — live Hermes adapter.
- `apps/server/src/hermes/live/gateway.ts` — Hermes gateway client.
- `apps/server/src/hermes/live/sqlite.ts` — read-only Hermes SQLite access.
- `apps/server/src/hermes/fake/fake-port.ts` — public fake Hermes adapter entry.
- `apps/server/src/hermes/fake/fake-port-fixtures.ts` — deterministic fake scheduler, memory ids and skill hub.
- `apps/server/src/hermes/fake/fake-port-demo.ts` — demo question and reply phrase hooks.
- `apps/server/src/hermes/fake/fake-port-observations.ts` — applies scenario steps to projected state.
- `apps/server/src/hermes/fake/fake-port-state.ts` — fake adapter state, lifecycle and event plumbing.
- `apps/server/src/hermes/fake/fake-port-providers.ts` — fake models, providers, connections, config and files.
- `apps/server/src/hermes/fake/fake-port-settings.ts` — per-agent approvals, models, skills, memory, workspace and routines.
- `apps/server/src/hermes/fake/fake-port-agents.ts` — agent directory, profiles, outside sessions and reports.
- `apps/server/src/hermes/fake/fake-port-tasks.ts` — fake task board reads, writes and actions.
- `apps/server/src/hermes/fake/fake-port-runs.ts` — fake run start, streaming, questions and transitions.
- `apps/server/src/hermes/fake/fake-port-run-control.ts` — stop, MCP, bot screen, rewind, compaction, context and decisions.
- `apps/server/src/knowledge/vault.ts` — public vault facade: construction, fields, getters and method installation.
- `apps/server/src/knowledge/vault-types.ts` — vault options, row and move schemas, shared types and history outcomes.
- `apps/server/src/knowledge/vault-runtime.ts` — vault method-module runtime shape, public typing and installation.
- `apps/server/src/knowledge/vault-lifecycle.ts` — vault lock, publication, startup, watcher, timers and close.
- `apps/server/src/knowledge/vault-files.ts` — containment-checked path lookup, atomic writes, reads, hashes and streams.
- `apps/server/src/knowledge/vault-index.ts` — SQLite note index, scans, link updates, memory indexes and rebuild.
- `apps/server/src/knowledge/vault-reads.ts` — knowledge settings, info, tree, note reads, search and history reads.
- `apps/server/src/knowledge/vault-writes.ts` — git commits, note writes, moves, deletes and restores.
- `apps/server/src/knowledge/vault-move-plan.ts` — crash-safe move plans, recovery, retries and move issues.
- `apps/server/src/knowledge/vault-folders.ts` — folder creation, moving, pruning and deletion.
- `apps/server/src/runtimes/coding/service.ts` — public coding runtime import path and re-export facade.
- `apps/server/src/runtimes/coding/service-types.ts` — coding runtime dependencies, run/attempt types, row schemas and shared helpers.
- `apps/server/src/runtimes/coding/service-base.ts` — shared runtime state, backend status, accessors and shutdown assertion.
- `apps/server/src/runtimes/coding/service-cli.ts` — CLI refusal, version/help checks and policy deny lists.
- `apps/server/src/runtimes/coding/service-processes.ts` — process/member records, reaping, held groups and release.
- `apps/server/src/runtimes/coding/service-views.ts` — agent views/details, quota readings and model listings.
- `apps/server/src/runtimes/coding/service-workers.ts` — coding-worker facts, reports and policy checks.
- `apps/server/src/runtimes/coding/service-delivery.ts` — durable terminal-result delivery and retry.
- `apps/server/src/runtimes/coding/service-launch.ts` — room/job helpers, run wrapper and unit/process launch attempts.
- `apps/server/src/runtimes/coding/service-execution.ts` — the per-turn preparation, attempt loop and terminal decision.
- `apps/server/src/runtimes/coding/service-admission.ts` — idempotent run admission and unresolved-run checks.
- `apps/server/src/runtimes/coding/service-stops.ts` — Stop controls for live, recorded and queued runs.
- `apps/server/src/runtimes/coding/service-recovery.ts` — restart recovery, shutdown and the final `CodingRuntime` class.
- `apps/server/src/runtimes/coding/units.ts` — coding unit lifecycle.
- `apps/server/src/runtimes/coding/unit-backend.ts` — the systemd unit backend (`UnitBackend`), the end of the class chain below, and its public exports.
- `apps/server/src/runtimes/coding/unit-backend-types.ts` — unit backend types: status, deps, launch request, outcomes, recovery report.
- `apps/server/src/runtimes/coding/unit-backend-helpers.ts` — unit backend constants, file schemas and pure helpers (fence barrier, forced fallback, stop causes).
- `apps/server/src/runtimes/coding/unit-backend-core.ts` — unit backend base class: state, rows, projections, rate limit, routing and identity files.
- `apps/server/src/runtimes/coding/unit-backend-capability.ts` — whether units are usable: capability check, notify listener, receipts and the pause marker.
- `apps/server/src/runtimes/coding/unit-backend-launch.ts` — launching a supervised unit and recording its stop.
- `apps/server/src/runtimes/coding/unit-backend-drive.ts` — the drive loop that follows a running unit to its end.
- `apps/server/src/runtimes/coding/unit-backend-proof.ts` — stopping a unit and proving it ended: stop receipts, identity, manager and boot checks.
- `apps/server/src/runtimes/coding/unit-backend-lifecycle.ts` — settling runs and launches, holds, reaping and ending records.
- `apps/server/src/runtimes/coding/unit-backend-recovery.ts` — recovery after a restart and its report.

## packages/contract/src

### Folders

- `packages/contract/src/` — shared zod schemas and types for every HTTP endpoint and stream event.

### Key files

- `packages/contract/src/index.ts` — public contract exports and version.
- `packages/contract/src/http.ts` — HTTP envelopes and shared request/response pieces.
- `packages/contract/src/stream.ts` — stream event types and envelopes.
- `packages/contract/src/bridge.ts` — Python bridge payloads.
- `packages/contract/src/types.ts` — shared domain types.
- `packages/contract/src/orchestration.ts` — orchestration schemas and types.
- `packages/contract/src/workflows.ts` — workflow schemas and types.
- `packages/contract/src/themes.ts` — theme schemas and types.

## hermes-plugin/score_bridge

### Folders

- `hermes-plugin/score_bridge/` — fail-open Hermes plugin: hooks, outbound sender, decisions and spool.

### Key files

- `hermes-plugin/score_bridge/__init__.py` — plugin entry and Hermes hook registration.
- `hermes-plugin/score_bridge/sender.py` — event batching and delivery.
- `hermes-plugin/score_bridge/client.py` — HTTP client for Score.
- `hermes-plugin/score_bridge/spool.py` — bounded on-disk spool for failed delivery.
- `hermes-plugin/score_bridge/hermes_private.py` — the only calls into private Hermes functions.
- `hermes-plugin/score_bridge/approvals.py` — gateway approval handling.
- `hermes-plugin/score_bridge/decisions.py` — decision delivery.
- `hermes-plugin/score_bridge/redact.py` — redaction before anything leaves a hook.
- `hermes-plugin/score_bridge/exchanges.py` — exchange tools exposed to agents.

## scripts

### Folders

- `scripts/` — repo checks, launchers, comparison tools and maintenance commands.
- `scripts/compare/` — screen comparisons against the bold prototype boards.
- `scripts/perf/` — Playwright performance configuration and specs.

### Key files

- `scripts/structure-check.mjs` — size-exception and code-map enforcement.
- `scripts/size-exceptions.json` — the shrinking list of files still over 450 lines.
- `scripts/license-check.mjs` — dependency license gate.
- `scripts/license-policy.mjs` — allowed license policy.
- `scripts/start.mjs` — production launcher for the built app.
- `scripts/bold-frame-compare.mjs` — browser entry for the bold prototype-versus-app screenshot and metric run.
- `scripts/bold-frame-paths.mjs` — output, build and prototype/board paths for the bold frame comparison.
- `scripts/bold-frame-fixtures.mjs` — visual, room, search and recipe fixtures that stand in for the server.
- `scripts/bold-frame-serve.mjs` — routes Chromium requests to comparison fixtures and built web files.
- `scripts/bold-frame-parts-frame.mjs` — shell, team-room and empty-room selector tables.
- `scripts/bold-frame-parts-settings.mjs` — usage, rules and system selector tables.
- `scripts/bold-frame-parts-dialogs.mjs` — search and recipe dialog selector tables.
- `scripts/bold-frame-measure.mjs` — computed-style measurement and prototype settings navigation.
- `scripts/bold-frame-report.mjs` — writes the comparison's JSON and Markdown metric reports.
- `scripts/restore.mjs` — backup restore command.
- `scripts/capacity.mjs` — machine load report.
- `scripts/set-password.mjs` — security-password setter.
- `scripts/codex-task.sh` — task worktree launcher.
- `scripts/load-test.ts` — local load test entry.

## e2e

### Folders

- `e2e/` — Playwright specs and shared fixtures run against the fake adapter.
- `e2e/readme/` — README screenshot configuration and spec.

### Key files

- `playwright.config.ts` — main end-to-end configuration.
- `e2e/bold-room-fixtures.ts` — rooms and agents used by bold-room specs.
- `e2e/themes-fixtures.ts` — theme packages and screenshots used by theme specs.
- `e2e/visual-fixtures.ts` — shared visual-test setup.
- `e2e/workflow-fixtures.ts` — workflow definitions and runs for e2e.
- `e2e/locks.ts` — cross-worker test locks.
- `e2e/global-teardown.ts` — shared fake-server teardown.
- `e2e/now-fixture.ts` — deterministic clock fixture.
