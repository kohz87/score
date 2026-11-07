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
- `apps/web/src/bold/` — the new dark shell: screens, navigation, room, look, settings section styles, colocated tests and other bold-only styles.
- `apps/web/src/bold/` — the new dark shell: screens, navigation, room, look, settings section styles and other bold-only styles; Team tests are split by feature under `bold-team-*.test.tsx`.
- `apps/web/src/bold/bold-team-fixtures.ts` — shared Team test agents, runtimes, operations and response fixtures.
- `apps/web/src/bold/bold-team-helpers.tsx` — shared Team test fetch stub, render setup, lifecycle state and removal helpers.
- `apps/web/src/bold/` — the new dark shell: screens, navigation, room, look, settings section styles, recipe test suites and other bold-only styles.
- `apps/web/src/bold/agent-more/` — per-agent detail cards for settings, access, routines and removal.
- `apps/web/src/bold/chats/` — bold chat list, chat information and run controls.
- `apps/web/src/bold/direct/` — one-to-one chat with an agent.
- `apps/web/src/bold/jobmap/` — job map and step graph for a running job.
- `apps/web/src/bold/room/` — team room, message stream, needs-you cards, menus, room state, split room styles and the split BoldTeamRoom integration tests.
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
- `apps/web/src/bold/BoldShell-*.test.tsx` — bold shell suites split by feature: frame, navigation, side panel, run graph and files/results.
- `apps/web/src/bold/BoldShell-helpers.tsx` — shared bold shell test harness: state, fetch fixtures, router render and cleanup.
- `apps/web/src/bold/BoldShell-run-fixtures.ts` — shared run topic and run summary fixtures for the bold shell suites.
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
- `apps/web/src/bold/BoldRecipes-helpers.tsx` — shared fetch setup, mount and fixtures helpers for the Recipes test suites.
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
- `apps/web/src/bold/BoldStartJob-helpers.tsx` — shared fixtures, fake fetch server and render helpers for the split start-job tests.
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
- `apps/web/src/bold/room/BoldTeamRoom-helpers.tsx` — shared fixtures, setup and DOM probes for the split BoldTeamRoom tests.
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
- `apps/server/src/domain/orchestration/` — orchestrator state, executor method modules, lead commands, human decisions, journal, fences and checks.
- `apps/server/src/domain/orchestration/` — orchestrator state, executor method modules, helper and vote machinery, state transitions, journal, fences and checks.
- `apps/server/src/domain/triggers/` — webhook triggers, signatures, queue and report-back.
- `apps/server/src/domain/orchestration/` — orchestrator state, executor method modules, journal, fences and checks.
- `apps/server/src/domain/triggers/` — webhook triggers, signatures, call intake, queue, lifecycle, payload rendering and report-back.
- `apps/server/src/domain/workflows/` — workflow definitions, planner, runs and views.
- `apps/server/src/domain/workflows/` — workflow definitions, planner pass modules, runs and split view modules.
- `apps/server/src/hermes/` — the Node-side Hermes boundary and its public adapter surface.
- `apps/server/src/hermes/bridge/` — Python bridge producers, routes, ingest and retention.
- `apps/server/src/hermes/fake/` — scripted fake Hermes for development, tests and e2e: state, providers, settings, agents, tasks, runs and run control.
- `apps/server/src/hermes/live/` — live Hermes adapter: gateway, SQLite, CLI, profiles and tasks.
- `apps/server/src/hermes/live/kanban-attempts/` — read, project and associate Kanban attempts.
- `apps/server/src/http/` — API routes, one file per contract section.
- `apps/server/src/http/rooms/` — split room catalogue, message, rewind, summary and version route groups.
- `apps/server/src/hub/` — ordered event ingest, projections, SSE fan-out, snapshots and retention.
- `apps/server/src/knowledge/` — vault files, notes, document index/uploads/scanning/zip, links, extraction, export and staging.
- `apps/server/src/locks/` — OS-level lock helpers.
- `apps/server/src/mcp/` — MCP access control, routes and tools.
- `apps/server/src/media/` — upload storage, multipart parsing and type sniffing.
- `apps/server/src/runtimes/` — agent runtime implementations.
- `apps/server/src/runtimes/check/` — spawn-based check command runner.
- `apps/server/src/runtimes/coding/` — coding-agent drivers, split process supervisor, translation and units, quotas and the split coding runtime service.
- `apps/server/src/shares/` — public share pages, markdown and rate limits.
- `apps/server/src/terminal/` — PTY terminal manager, tickets and environment.
- `apps/server/src/themes/` — theme packages, built-ins, CSS validation and split storage.
- `apps/server/src/workspace/` — workspace roots, git, policy and per-agent workspaces.
- `apps/server/src/themes/` — theme packages, built-ins, CSS validation and storage.
- `apps/server/src/workspace/` — workspace roots, git, policy, per-agent workspaces, and workspace file access, reads and mutations.
- `apps/server/migrations/` — forward-only numbered SQL migrations.
- `apps/server/scripts/` — server maintenance scripts.
- `apps/server/test/` — server integration tests and recorded fixtures; terminal tests are split by access/transport, shell session and live agent with a shared harness.
- `apps/server/test/runtimes/` — coding runtime integration tests split by feature; shared setup lives in `coding-runtime-helpers.ts`.
- `apps/server/test/themes/` — theme route tests split by access/assets, import, recovery, custom saves, export/look/built-ins and revisions/events, plus shared package fixtures.

### Key files

- `apps/server/src/index.ts` — process entry and signal handling.
- `apps/server/src/start-server.ts` — server wiring orchestration and the public startup exports.
- `apps/server/src/start-server-background.ts` — hold recovery, delivery, retention and spend sweeps, certificate renewal and log rotation.
- `apps/server/src/start-server-guide.ts` — HTTPS setup-guide server.
- `apps/server/src/start-server-lifecycle.ts` — ordered shutdown of server resources and background jobs.
- `apps/server/src/start-server-options.ts` — startup options and the removed insecure-flag message.
- `apps/server/src/start-server-state.ts` — home and journal validation, installation resolution, database migration and event ingest startup.
- `apps/server/src/app.ts` — Fastify app and route registration.
- `apps/server/src/workspace/workspace.ts` — public Workspace facade, root opening and re-exported workspace constants, etag helper and write-event type.
- `apps/server/src/workspace/workspace-access.ts` — root containment checks and safe directory handles.
- `apps/server/src/workspace/workspace-content.ts` — file hashing, blocked-name checks, raw-media detection and text decoding.
- `apps/server/src/workspace/workspace-fs.ts` — filesystem error mapping, bounded reads and protected tree removal.
- `apps/server/src/workspace/workspace-mutations.ts` — write, upload, create, move and remove operations.
- `apps/server/src/workspace/workspace-reader.ts` — workspace listing and file reads.
- `apps/server/src/workspace/workspace-types.ts` — workspace limits and tree, read-result and write-event types.
- `apps/server/test/runtimes/coding-runtime-helpers.ts` — shared fake-CLI app, agent, room and process-recovery harness for the coding runtime tests.
- `apps/server/src/app.ts` — Fastify app composition root and public app exports.
- `apps/server/src/app-options.ts` — `buildApp` options and the Fastify instance decorator types.
- `apps/server/src/app-route-port.ts` — the route-visible Hermes port with the agent directory and coding agents.
- `apps/server/src/app-bridge.ts` — the loopback bridge and MCP Fastify app.
- `apps/server/src/app-routes-data.ts` — task, agent, profile, workspace, knowledge, MCP, settings and theme routes.
- `apps/server/src/app-routes-collaboration.ts` — rooms, triggers, workspace, conversation and pause-hold route setup.
- `apps/server/src/app-task-parking.ts` — the committed-event retry loop that parks tasks for paused owners.
- `apps/server/src/app-routes-work.ts` — brief, orchestration, workflow, team-pause and live team read routes.
- `apps/server/src/app-terminal.ts` — optional web terminal decoration and coding-agent CLI launch resolution.
- `apps/server/src/app-routes-system.ts` — coding-agent, session, share, system, update, logs, about, stream and asset routes.
- `apps/server/src/installation.ts` — installation identity public facade and exports.
- `apps/server/src/installation-types.ts` — registry, resolution and confirmation types.
- `apps/server/src/installation-identity.ts` — installation ids, namespaces, file names and legacy journal scopes.
- `apps/server/src/installation-io.ts` — durable file replacement and directory syncing.
- `apps/server/src/installation-json.ts` — registry entry parsing and JSON object guards.
- `apps/server/src/installation-home.ts` — the home's `installation.json` copy.
- `apps/server/src/installation-registry.ts` — the external registry, manifests, registry lock and legacy cutover reads.
- `apps/server/src/installation-resolve.ts` — registry recovery, path claims and installation resolution.
- `apps/server/src/installation-journal.ts` — journal checksums, copied-history inheritance and legacy scope closure.
- `apps/server/src/installation-confirm.ts` — confirmed moves and confirmed copies.
- `apps/server/src/installation-restore.ts` — restore-marker and restored-home registry lookups.
- `apps/server/test/terminal-helpers.ts` — shared TLS app setup, pairing, ticket, WebSocket, cleanup and process-exit harness for the terminal tests.
- `apps/server/src/config.ts` — environment configuration.
- `apps/server/src/db/index.ts` — database open and migration surface.
- `apps/server/test/themes/routes-helpers.ts` — shared Fastify app setup and request helpers for the theme route tests.
- `apps/server/src/themes/store.ts` — public theme store facade for built-in, imported and custom packages.
- `apps/server/src/themes/store-types.ts` — theme row and stored-package types, schemas, etag and lock error.
- `apps/server/src/themes/store-fs.ts` — theme filesystem interface, fsync, swap-path and non-throwing removal helpers.
- `apps/server/src/themes/store-records.ts` — theme rows, built-in lookup, summaries, upsert and revision counter.
- `apps/server/src/themes/store-assets.ts` — safe theme asset path resolution, listing and bounded reads.
- `apps/server/src/themes/store-reads.ts` — theme detail reads and unsettled-package lock checks.
- `apps/server/src/themes/store-journal.ts` — durable swap-note writes, erasure, settlement and rollback.
- `apps/server/src/themes/store-transactions.ts` — custom saves, imported asset swaps and journaled deletes.
- `apps/server/src/themes/store-recovery.ts` — interrupted swap recovery, built-in id reclaim and orphan-folder sweep.
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
- `apps/server/src/domain/approvals.ts` — approval public surface: decisions, signals and run approvals re-exported from their modules.
- `apps/server/src/domain/approval-schemas.ts` — gate signal and approval signal row schemas.
- `apps/server/src/domain/approval-writes.ts` — approval row insertion, change journal and choice recording.
- `apps/server/src/domain/approval-signals.ts` — bridge signal application, hidden-card folding, replay and tool completion claims.
- `apps/server/src/domain/approval-runs.ts` — Score-run approval request, response, close and expiry.
- `apps/server/src/domain/briefs.ts` — brief public surface and re-exports.
- `apps/server/src/domain/brief-types.ts` — brief, task-link and turn row schemas and types.
- `apps/server/src/domain/brief-queries.ts` — brief, task and turn reads plus title and actionability helpers.
- `apps/server/src/domain/brief-status.ts` — derived brief status, summaries, emission, last activity and listing.
- `apps/server/src/domain/brief-links.ts` — brief creation, task links and flow edges.
- `apps/server/src/domain/brief-holds.ts` — arrival holds for paused briefs, agents and the team.
- `apps/server/src/domain/brief-events.ts` — ingest hook that keeps brief links and blocks in step with events.
- `apps/server/src/domain/reports.ts` — public report facade for aggregation, range and row-read exports.
- `apps/server/src/domain/reports-types.ts` — report fact, input, run, attempt, approval and window types.
- `apps/server/src/domain/reports-time.ts` — local day keys, report ranges, day boundaries and custom-range checks.
- `apps/server/src/domain/reports-metrics.ts` — cache rates, medians, interval math, waits, percentages and scalar aggregates.
- `apps/server/src/domain/reports-compute.ts` — report aggregation over tasks, runs, attempts and approvals.
- `apps/server/src/domain/reports-read.ts` — run, approval and attempt row reads with their schemas.
- `apps/server/src/domain/rooms.ts` — public room and message facade for the split domain modules.
- `apps/server/src/domain/rooms-rows.ts` — room and message row schemas, name tags, import metadata and row lookup.
- `apps/server/src/domain/rooms-activity.ts` — compatibility state, stream/approval activity index, members and busy agents.
- `apps/server/src/domain/rooms-read.ts` — room, room-list and room-id reads.
- `apps/server/src/domain/rooms-write.ts` — room names, inserts, agent retirement and room-update events.
- `apps/server/src/domain/rooms-events.ts` — changed-room detection and ingest-driven room updates.
- `apps/server/src/domain/rooms-messages.ts` — message row mapping and store, update, delete and clear lifecycle.
- `apps/server/src/domain/rooms-pages.ts` — message cursors, pages, unread-job reads and mark-read updates.
- `apps/server/src/domain/watch-frames.ts` — public Watch frame facade for the split domain modules.
- `apps/server/src/domain/watch-types.ts` — frame, tool input, watch info and replay page types.
- `apps/server/src/domain/watch-sensitive.ts` — sensitive tool names and credential-file path detection.
- `apps/server/src/domain/watch-output.ts` — output byte cap and UTF-8-safe tail clipping.
- `apps/server/src/domain/watch-tool-frames.ts` — pure tool-hook frame derivation and captions.
- `apps/server/src/domain/watch-store.ts` — redacted frame persistence, call keys and media references.
- `apps/server/src/domain/watch-read.ts` — replay frame, marker and liveness reads.
- `apps/server/src/domain/orchestration/command-args.ts` — `orch.*` tool names, argument schemas, parsing and canonical payload hashes.
- `apps/server/src/domain/orchestration/command-assign.ts` — step and helper assignment rules, quota holds, gates and votes.
- `apps/server/src/domain/orchestration/command-finish.ts` — check, finish and receipt command handlers.
- `apps/server/src/domain/orchestration/command-handlers.ts` — tool-name to handler registry.
- `apps/server/src/domain/orchestration/command-plan.ts` — plan command and the advisor's first-plan consult.
- `apps/server/src/domain/orchestration/command-steps.ts` — shared step cancellation plus approval-request and cancel commands.
- `apps/server/src/domain/orchestration/command-support.ts` — shared command receipts, handler types, policy fields and storage refusal.
- `apps/server/src/domain/orchestration/command-talk.ts` — question and note command handlers.
- `apps/server/src/domain/orchestration/command-vote.ts` — helper vote command.
- `apps/server/src/domain/orchestration/commands.ts` — public command facade: capability admission, deduplication and receipt commit.
- `apps/server/src/domain/orchestration/decision-gates.ts` — gate and inquiry decisions.
- `apps/server/src/domain/orchestration/decision-guards.ts` — revision and live-run guards shared by human decisions.
- `apps/server/src/domain/orchestration/decision-limits.ts` — run limit changes and coding reserve growth.
- `apps/server/src/domain/orchestration/decision-quota.ts` — held-step quota answers and suspended-step resumption.
- `apps/server/src/domain/orchestration/decision-remap.ts` — agent and policy remap decisions for coding workers.
- `apps/server/src/domain/orchestration/decision-run-controls.ts` — pause, resume, stop, waiver and abandonment decisions.
- `apps/server/src/domain/orchestration/decisions.ts` — public human-decision facade.
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
- `apps/server/src/domain/orchestration/helpers.ts` — helper setup, votes and audits facade.
- `apps/server/src/domain/orchestration/helpers-audit.ts` — automatic audits after the lead's steps.
- `apps/server/src/domain/orchestration/helpers-auto-votes.ts` — automatic step votes and their cleanup.
- `apps/server/src/domain/orchestration/helpers-config.ts` — helper configuration, slots, scan setup and sizing.
- `apps/server/src/domain/orchestration/helpers-votes.ts` — vote records, tallies, settlement and read views.
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
- `apps/server/src/domain/orchestration/ops.ts` — shared state-transition facade.
- `apps/server/src/domain/orchestration/ops-admission.ts` — active capacity counts and admission revisions.
- `apps/server/src/domain/orchestration/ops-finish.ts` — finish barriers and control-history compaction.
- `apps/server/src/domain/orchestration/ops-refusal.ts` — refusal retry, wait and lifetime transitions.
- `apps/server/src/domain/orchestration/ops-steps.ts` — step, attempt and gate state transitions.
- `apps/server/src/domain/orchestration/ops-storage.ts` — storage accounting and coding reserve sizing.
- `apps/server/src/domain/exchanges/apply.ts` — applies accepted exchange results.
- `apps/server/src/domain/message-runs.ts` — run domain facade re-exporting turn, stream, card, completion, context and failure modules.
- `apps/server/src/domain/message-runs-turns.ts` — run schema, reservation, retry, cancellation and run-to-message attachment.
- `apps/server/src/domain/message-runs-stream.ts` — streamed reply redaction holding, append and progress.
- `apps/server/src/domain/message-runs-cards.ts` — approval, tool, reasoning and live activity message parts.
- `apps/server/src/domain/message-runs-complete.ts` — reply completion, plans, hand-offs, summaries and exchange settlement.
- `apps/server/src/domain/message-runs-context.ts` — room context input for a run.
- `apps/server/src/domain/message-runs-failure.ts` — failed turn notices and exchange settlement.
- `apps/server/src/domain/profiles.ts` — profile operations facade: class state, get and method installation.
- `apps/server/src/domain/profiles-runtime.ts` — profile operation method runtime, public typing and installation.
- `apps/server/src/domain/profiles-support.ts` — operation schemas, step lists, lifecycle helpers and retry rules.
- `apps/server/src/domain/profiles-preview.ts` — create, delete and import previews with their hashes.
- `apps/server/src/domain/profiles-begin.ts` — starting operations, imports and upload retention.
- `apps/server/src/domain/profiles-controls.ts` — recovery, retry, confirm, refresh, delete safety and close.
- `apps/server/src/domain/profiles-run.ts` — operation step execution, saving, rebaselining and retirement.
- `apps/server/src/domain/exchanges/apply.ts` — re-exports the exchange turn settlement, job state and stop entry points.
- `apps/server/src/domain/exchanges/agent-quote.ts` — quotes and redacts agent text handed to another agent.
- `apps/server/src/domain/exchanges/give.ts` — queues or holds the next turn of an exchange.
- `apps/server/src/domain/exchanges/settle-turn.ts` — settles a completed exchange turn and its staged actions.
- `apps/server/src/domain/exchanges/job-state.ts` — derives a job's working or waiting-on-you state.
- `apps/server/src/domain/exchanges/lead-decision.ts` — applies the room lead's decision on a budget pause.
- `apps/server/src/domain/exchanges/exchange-answers.ts` — answers, reviews, hand-offs and questions between agents.
- `apps/server/src/domain/exchanges/exchange-stops.ts` — stops exchanges and their queued or running turns.
- `apps/server/src/domain/exchanges/store.ts` — re-exports job and exchange rows, views, events, writes and lifecycle helpers.
- `apps/server/src/domain/exchanges/row-schemas.ts` — job and exchange row schemas and inferred types.
- `apps/server/src/domain/exchanges/row-reads.ts` — single job and exchange row reads.
- `apps/server/src/domain/exchanges/job-view.ts` — contract-shaped job views and job events.
- `apps/server/src/domain/exchanges/exchange-view.ts` — contract-shaped exchange views, pause options and exchange events.
- `apps/server/src/domain/exchanges/row-lists.ts` — job and exchange list queries.
- `apps/server/src/domain/exchanges/row-writes.ts` — job updates, exchange updates and exchange creation.
- `apps/server/src/domain/exchanges/job-store.ts` — active-job rules, job creation and latest-message lookup.
- `apps/server/src/domain/triggers/triggers.ts` — public trigger facade: lifecycle, call and secret re-exports.
- `apps/server/src/domain/triggers/trigger-rows.ts` — trigger row schema, reads and contract mapping.
- `apps/server/src/domain/triggers/trigger-content.ts` — payload value lookup, redaction, opening message, links and samples.
- `apps/server/src/domain/triggers/trigger-lifecycle.ts` — trigger listing, creation retry, update, deletion, secret read and rotation.
- `apps/server/src/domain/triggers/trigger-calls.ts` — signed call verification, idempotency, budgets, job source and queue hand-off.
- `apps/server/src/domain/workflows/planner.ts` — planner entry point and public facade.
- `apps/server/src/domain/workflows/planner-context.ts` — planner pass loading, state/token primitives and run failure.
- `apps/server/src/domain/workflows/planner-observe.ts` — executor-step observation and coding-hold handling.
- `apps/server/src/domain/workflows/planner-graph.ts` — local node resolution, graph ancestry and node gates.
- `apps/server/src/domain/workflows/planner-assign.ts` — assignment readiness, refusals and step creation.
- `apps/server/src/domain/workflows/planner-finish.ts` — terminal graph detection and finish receipt.
- `apps/server/src/domain/workflows/views.ts` — workflow view facade and public re-exports.
- `apps/server/src/domain/workflows/views-remap.ts` — remap planning for unsent workflow work.
- `apps/server/src/domain/workflows/views-waiting.ts` — per-node waiting reasons.
- `apps/server/src/domain/workflows/views-summary.ts` — run summaries, coding authorisation and Needs-you items.
- `apps/server/src/domain/workflows/views-storage.ts` — run storage inventory.
- `apps/server/src/domain/workflows/views-detail.ts` — full workflow run detail assembly.
- `apps/server/src/domain/workflows/views-events.ts` — workflow event derivation from history rows.
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
- `apps/server/src/knowledge/documents.ts` — public document upload facade; composition of the document modules.
- `apps/server/src/knowledge/knowledge-document-model.ts` — document row schemas, prepared/unpacked types and shared path/name helpers.
- `apps/server/src/knowledge/knowledge-document-index.ts` — document rows, reads, search and index maintenance.
- `apps/server/src/knowledge/knowledge-document-uploads.ts` — document validation, text extraction, single-file writes and history placement.
- `apps/server/src/knowledge/knowledge-document-files.ts` — document deletes, moves and scanner reconciliation.
- `apps/server/src/knowledge/knowledge-document-zip.ts` — zip preview and zip import placement.
- `apps/server/src/knowledge/code-ranges.ts` — Markdown code block and inline span ranges.
- `apps/server/src/knowledge/links.ts` — wikilink extraction, note index resolution and rewriting.
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
- `apps/server/src/runtimes/coding/coding-socket.ts` — public coding-socket import path and re-export facade.
- `apps/server/src/runtimes/coding/coding-socket-types.ts` — supervisor wire-protocol constants, frame schema, limits and public socket types.
- `apps/server/src/runtimes/coding/coding-socket-session.ts` — one launch's socket session: frames, output ingestion, backpressure and completeness.
- `apps/server/src/runtimes/coding/coding-socket-server.ts` — listener setup, authentication, launch tokens, reservations and shutdown.
- `apps/server/src/runtimes/coding/process.ts` — public CLI process import path and re-export facade.
- `apps/server/src/runtimes/coding/process-types.ts` — stop reasons and the public CLI run, outcome, spawn-error and spawn-options types.
- `apps/server/src/runtimes/coding/process-spawn.ts` — CLI spawning, output parsing, process-group supervision, Stop escalation and reaping.
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
- `apps/server/src/runtimes/coding/claude.ts` — public Claude Code driver import path and re-export facade.
- `apps/server/src/runtimes/coding/claude-schemas.ts` — Claude Code stream-json schemas and ignore lists.
- `apps/server/src/runtimes/coding/claude-helpers.ts` — Claude Code tool previews/details, result text and sub-agent status helpers.
- `apps/server/src/runtimes/coding/claude-parser.ts` — Claude Code stream-json parser, loss handling, sub-agents and quota events.
- `apps/server/src/runtimes/coding/claude-driver.ts` — Claude Code driver configuration, arguments, help checks and deny rules.
- `apps/server/src/runtimes/coding/codex.ts` — public Codex driver import path and re-export facade.
- `apps/server/src/runtimes/coding/codex-schemas.ts` — Codex JSONL record schemas and ignore lists.
- `apps/server/src/runtimes/coding/codex-helpers.ts` — Codex retry-notice and agent-message detection helpers.
- `apps/server/src/runtimes/coding/codex-parser.ts` — Codex JSONL parser, loss handling and command, file and search events.
- `apps/server/src/runtimes/coding/codex-driver.ts` — Codex driver configuration, arguments, help checks and worker policy.
- `apps/server/src/runtimes/coding/units.ts` — coding unit lifecycle.
- `apps/server/src/runtimes/coding/supervisor.mjs` — in-unit supervisor entry point, wire protocol and re-export facade.
- `apps/server/src/runtimes/coding/supervisor-child.mjs` — child-exit waiting and process-group signals.
- `apps/server/src/runtimes/coding/supervisor-cgroup.mjs` — the real cgroup boundary and payload controls.
- `apps/server/src/runtimes/coding/supervisor-drain.mjs` — payload draining, survivor cleanup and the ended receipt.
- `apps/server/src/runtimes/coding/supervisor-frames.mjs` — supervisor control-frame handling.
- `apps/server/src/runtimes/coding/supervisor-output.mjs` — CLI output pumping, chunking, EOF and backpressure.
- `apps/server/src/runtimes/coding/supervisor-protocol.mjs` — wire protocol constants, spec hash and process start time.
- `apps/server/src/runtimes/coding/supervisor-receipts.mjs` — durable receipt writers and readers.
- `apps/server/src/runtimes/coding/supervisor-run.mjs` — the supervised launch state machine and control loop.
- `apps/server/src/runtimes/coding/supervisor-spec.mjs` — supervisor spec loading and validation.
- `apps/server/src/runtimes/coding/supervisor-watchdog.mjs` — systemd watchdog notification.
- `apps/server/src/runtimes/coding/translate.ts` — coding event translation facade and re-exports.
- `apps/server/src/runtimes/coding/translate-events.ts` — CLI event observations, tool rows and sub-agent summaries.
- `apps/server/src/runtimes/coding/translate-frames.ts` — Watch frames from translated tool details.
- `apps/server/src/runtimes/coding/translate-runs.ts` — run status updates and the running observation.
- `apps/server/src/runtimes/coding/translate-terminal.ts` — terminal run results and room replies.
- `apps/server/src/runtimes/coding/translate-types.ts` — translation state types, sizes and constructors.
- `apps/server/src/runtimes/coding/units.ts` — coding unit plumbing facade and re-exports.
- `apps/server/src/runtimes/coding/unit-actions.ts` — InvocationID-gated stop and reset actions.
- `apps/server/src/runtimes/coding/unit-capability.ts` — manager identity and host capability checks.
- `apps/server/src/runtimes/coding/unit-cgroup.ts` — cgroup population parsing and reads.
- `apps/server/src/runtimes/coding/unit-launch.ts` — systemd-run properties and argv construction.
- `apps/server/src/runtimes/coding/unit-names.ts` — unit-name validation, prefixes and construction.
- `apps/server/src/runtimes/coding/unit-systemctl.ts` — systemctl output parsing, unit lookups and environment names.
- `apps/server/src/runtimes/coding/unit-systemd-types.ts` — systemd runner types, command paths and the environment deny list.
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

## apps/server/test

### Folders

- `apps/server/test/hermes/` — fake and live Hermes adapter tests, split by feature, with shared helpers.
- `apps/server/test/runtimes/` — coding runtime, supervisor, socket, unit and systemd test suites and their fixtures.
- `apps/server/test/domain/` — domain tests split by feature, with shared approval, exchange, and budget harnesses.

### Key files

- `apps/server/test/runtimes/coding-units-runtime-helpers.ts` — shared runtime harness, boot helpers, row readers and seeded recovery fixtures.
- `apps/server/test/launcher-service-helpers.ts` — shared launcher rig, fake systemd/loginctl, command and prompt harnesses for the feature-split launcher suites.
- `apps/server/test/remote-helpers.ts` — shared remote config, app/pairing setup, cleanup and TLS fixtures for the feature-split remote suites.
- `apps/server/test/domain/approvals-helpers.ts` — shared approval app, outbox, pairing, request, decision and signal helpers.
- `apps/server/test/domain/exchanges-helpers.ts` — shared exchange database setup, room, turn, action and reply helpers.
- `apps/server/test/domain/exchange-budgets-helpers.ts` — shared exchange-budget harness and paused-review setup.
- `apps/server/test/domain/reports-helpers.ts` — shared report fixtures: timezone, timestamps, task, run, approval and report input factories.
- `apps/server/test/http/` — Fastify `inject()` route tests; the rooms API suites are split by feature with their shared fixture.

### Key files

- `apps/server/test/http/rooms-helpers.ts` — rooms test setup, contract schemas, writable fixture bindings and shared factories.
- `apps/server/test/runtimes/` — runtime tests and recorded coding-driver fixtures, split by parser output, configuration, verdicts, loss handling and sub-agents.

### Key files

- `apps/server/test/runtimes/coding-fixtures.ts` — recorded coding-driver CLI fixture lines.
- `apps/server/test/runtimes/coding-drivers-helpers.ts` — shared coding-driver test setup: fixture parsing, deny/base options, verdict extraction and Codex record factories.
- `apps/server/test/hermes/live/gateway/` — fake-gateway and live gateway tests, including the feature-split translate suites.

### Key files

- `apps/server/test/hermes/live/gateway/translate-helpers.ts` — shared setup, admitted run and room-reply fixtures for the translate suites.
- `apps/server/test/hermes/fake-helpers.ts` — shared fake-port test setup, scheduler state, event readers and scenario play helpers.
- `apps/server/test/hermes/live-port-helpers.ts` — shared live-port test setup, teardown and port factory.
- `apps/server/test/http/` — HTTP route tests for the server API, including agent profiles, rooms, tasks and settings.

### Key files

- `apps/server/test/http/profiles-helpers.ts` — shared profile-test app setup, pairing, operations and cleanup.

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

## packages/contract/test

### Folders

- `packages/contract/test/` — Vitest contract specs with schema cases and fixtures split by feature.

### Key files

- `packages/contract/test/schemas-helpers.ts` — shared schema fixtures and case data.
- `packages/contract/test/schemas-cases.ts` — all cases, aggregated for the exported-schema coverage check.
- `packages/contract/test/schemas-coverage.test.ts` — the exported-schema coverage check.
- `packages/contract/test/schemas-cases-agents.ts` — agent, profile, room, chat and session cases.
- `packages/contract/test/schemas-agents.test.ts` — agent, profile, room, chat and session schema tests.
- `packages/contract/test/schemas-cases-now-tasks.ts` — Now, tasks, questions, approvals and attempts cases.
- `packages/contract/test/schemas-now-tasks.test.ts` — Now, tasks, questions, approvals and attempts schema tests.
- `packages/contract/test/schemas-cases-watch-stream.ts` — Watch, stream and bridge cases.
- `packages/contract/test/schemas-watch-stream.test.ts` — Watch, stream and bridge schema tests.
- `packages/contract/test/schemas-cases-security-settings.ts` — security, terminal, providers, connections, rules, skills and channels cases.
- `packages/contract/test/schemas-security-settings.test.ts` — security, terminal, providers, connections, rules, skills and channels schema tests.
- `packages/contract/test/schemas-cases-workspaces.ts` — shared workspaces, workbench and workspace files cases.
- `packages/contract/test/schemas-workspaces.test.ts` — shared workspaces, workbench and workspace files schema tests.
- `packages/contract/test/schemas-cases-knowledge.ts` — Knowledge notes, documents, history and bridge cases.
- `packages/contract/test/schemas-knowledge.test.ts` — Knowledge notes, documents, history and bridge schema tests.
- `packages/contract/test/schemas-cases-orchestration.ts` — orchestration, MCP and workflow cases.
- `packages/contract/test/schemas-orchestration.test.ts` — orchestration, MCP and workflow schema tests.
- `packages/contract/test/schemas-cases-model-config.ts` — model settings, agent history and config cases.
- `packages/contract/test/schemas-model-config.test.ts` — model settings, agent history and config schema tests.
- `packages/contract/test/schemas-cases-maintenance.ts` — Hermes updates, plugins, rewind and compaction cases.
- `packages/contract/test/schemas-maintenance.test.ts` — Hermes updates, plugins, rewind and compaction schema tests.
- `packages/contract/test/schemas-cases-coding.ts` — coding runtimes, quotas, agents and models cases.
- `packages/contract/test/schemas-coding.test.ts` — coding runtimes, quotas, agents and models schema tests.
- `packages/contract/test/schemas-cases-themes.ts` — theme manifests, saves and look settings cases.
- `packages/contract/test/schemas-themes.test.ts` — theme manifests, saves, protected labels and look settings schema tests.
- `packages/contract/test/schemas-cases-exchanges.ts` — jobs, exchanges, triggers and queues cases.
- `packages/contract/test/schemas-exchanges.test.ts` — jobs, exchanges, triggers and queues schema tests.

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
- `e2e/customizer-helpers.ts` — shared customizer session, cleanup, preview and package helpers.
- `e2e/customizer-editing.spec.ts` — customizer build, save, export, keyboard, discard, contrast and accessibility flows.
- `e2e/customizer-import-and-shell.spec.ts` — import preview and errors, roles/focus, settings shell and phone layout.
- `e2e/customizer-saves.spec.ts` — save conflicts, in-use state, replaced pictures and unsaved edits.
- `e2e/customizer-package-versions.spec.ts` — copies, package revisions, exports, cached looks and replaced assets.
- `e2e/bold-room-fixtures.ts` — rooms and agents used by bold-room specs.
- `e2e/themes-fixtures.ts` — theme packages and screenshots used by theme specs.
- `e2e/visual-fixtures.ts` — shared visual-test setup.
- `e2e/workflow-fixtures.ts` — workflow definitions and runs for e2e.
- `e2e/locks.ts` — cross-worker test locks.
- `e2e/global-teardown.ts` — shared fake-server teardown.
- `e2e/now-fixture.ts` — deterministic clock fixture.
