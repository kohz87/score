# AG — Agent glyphs: nine shapes with their own eyes, bigger and borderless; no agent row in the top bar (decision 184)

Owner, 2026-11-10, on the mock-up "Agent icons and the top bar" (direction C, then "C, final"): agents are drawn as nine soft,
flat-colour bodies, each with its own simple eyes (dots, bars, squares, triangles, half-moons, capsules); no circle or tile behind
them; larger where they are clicked; and the top bar's agent row goes ("do we still need the agents listing?" → remove it).

Branch: your worktree was branched from `task/AG-agent-glyphs`, where the lead already added `OfferedShapes` to
`packages/contract/src/types.ts` (the nine names, in this order) and made the server default to it. Read that first.

## What changes

### 1. The nine bodies (`apps/web/src/components/agent-shapes.ts`)
The contract keeps all 22 shape names valid (stored looks don't change). Only the nine `OfferedShapes` are drawn; every other name
is drawn as one of them. Add and export:
- `drawnShape(shape: Shape): OfferedShape` with this map for the 13 others: circle-dot→ball, diamond→triangle, gem→triangle,
  hexagon→square, octagon→square, shield→blob, heart→blob, star→flower, bolt→cross, leaf→drop, moon→drop, cylinder→pill,
  bubble→pill (an offered name maps to itself).
- `shapeName(shape)`: the word people see, from the drawn shape: ball, drop, peak (triangle), cloud, pill, clover (cross), flower,
  pebble (square), bean (blob). Use it for `shapeLabel` in `routes/team/AgentAppearanceFields.tsx` and for `describeShape`.
- `agentShapes` holds the bodies for the nine (exact geometry below, 20-unit box, already fitted inside 1..19 and checked against
  `agent-shapes.test.ts`'s rules: every pair differs in ≥15% of occupied cells (smallest pair 17.2%), 45–320 cells, edge cells
  empty). Elements are plain circle/rect/path as today (no transforms; rotations are baked in).

### 2. The eyes (`agent-face.ts`, `AgentFace.tsx`, `agent-face.css`)
Each offered shape has two eyes of one kind, at the centres below (`tilt` in degrees, applied around the eye's own centre):
- `dot`: circle of radius r. `rect`: rounded rect w×h, corner r. `capsule`: rect w×h with r = w/2.
- `half-moon`: a half disc of radius r, flat edge on y, dome above: `M-r 0 A r r 0 0 1 r 0 Z` around the centre.
- `triangle` (cloud): this rounded triangle around the centre:
  `M0.49 -0.85 L1.09 0.19 A0.57 0.57 0 0 1 0.60 1.05 L-0.60 1.05 A0.57 0.57 0 0 1 -1.09 0.19 L-0.49 -0.85 A0.57 0.57 0 0 1 0.49 -0.85 Z`.

The moods (decision 127) keep their meaning on every shape, at the eye centres: **idle** = the shape's own eyes (above); **thinking** =
the flat line eyes as today; **needs** = the round "shocked" eyes as today, sized to fit; **working / resting** = the shape's own eyes
cut flat across at 48% of their height (the lid; generalise `lidPoints` to any outline's points); **done** = the happy ^ ^ arcs as
today. Blink, look-around, the pointer follow of a lively glyph and the greeting keep working; `lx`/`ly` per shape stay
small enough that no eye leaves its body (the test proves it). `faceHidesCentreDot` and the circle-dot ring go (circle-dot is now
drawn as the ball): remove them and their CSS once a search shows nothing else uses them.

Geometry (bodies are the AgentShapeElement list; eyes as described):
```json
{
 "ball": {
  "body": [
   {
    "tag": "circle",
    "cx": 10.0,
    "cy": 10.0,
    "r": 7.07
   }
  ],
  "eyes": [
   {
    "kind": "dot",
    "x": 7.58,
    "y": 9.44,
    "r": 1.63,
    "tilt": 0
   },
   {
    "kind": "dot",
    "x": 12.42,
    "y": 9.44,
    "r": 1.63,
    "tilt": 0
   }
  ]
 },
 "drop": {
  "body": [
   {
    "tag": "path",
    "d": "M7.58 2.37 C10.19 4.05 14.65 7.02 15.95 9.81 C17.44 13.16 15.02 17.63 10.37 17.63 C5.72 17.63 2.93 14.46 3.49 10.56 C3.86 7.95 5.72 5.16 7.58 2.37 Z"
   }
  ],
  "eyes": [
   {
    "kind": "capsule",
    "x": 8.42,
    "y": 11.86,
    "w": 1.67,
    "h": 3.35,
    "r": 0.84,
    "tilt": 0
   },
   {
    "kind": "capsule",
    "x": 11.95,
    "y": 11.86,
    "w": 1.67,
    "h": 3.35,
    "r": 0.84,
    "tilt": 0
   }
  ]
 },
 "triangle": {
  "body": [
   {
    "tag": "path",
    "d": "M12.41 6.14 L16.44 13.06 A2.42 2.42 0 0 1 14.35 16.7 L5.65 16.7 A2.42 2.42 0 0 1 3.56 13.06 L7.59 6.14 A2.79 2.79 0 0 1 12.41 6.14 Z"
   }
  ],
  "eyes": [
   {
    "kind": "rect",
    "x": 8.23,
    "y": 12.14,
    "w": 2.23,
    "h": 2.23,
    "r": 0.47,
    "tilt": 0
   },
   {
    "kind": "rect",
    "x": 11.77,
    "y": 12.14,
    "w": 2.23,
    "h": 2.23,
    "r": 0.47,
    "tilt": 0
   }
  ]
 },
 "cloud": {
  "body": [
   {
    "tag": "circle",
    "cx": 6.57,
    "cy": 11.55,
    "r": 3.72
   },
   {
    "tag": "circle",
    "cx": 10.43,
    "cy": 8.11,
    "r": 4.37
   },
   {
    "tag": "circle",
    "cx": 14.58,
    "cy": 10.24,
    "r": 3.53
   },
   {
    "tag": "circle",
    "cx": 12.7,
    "cy": 13.91,
    "r": 3.35
   },
   {
    "tag": "circle",
    "cx": 8.26,
    "cy": 14.41,
    "r": 3.07
   }
  ],
  "eyes": [
   {
    "kind": "triangle",
    "x": 8.42,
    "y": 11.42,
    "path_around_origin": null,
    "tilt": -4
   },
   {
    "kind": "triangle",
    "x": 12.69,
    "y": 11.12,
    "path_around_origin": null,
    "tilt": -4
   }
  ]
 },
 "pill": {
  "body": [
   {
    "tag": "path",
    "d": "M7.13 4.94 L12.33 4.66 A5.21 5.21 0 0 1 17.8 9.59 L17.8 9.59 A5.21 5.21 0 0 1 12.87 15.06 L7.67 15.34 A5.21 5.21 0 0 1 2.2 10.41 L2.2 10.41 A5.21 5.21 0 0 1 7.13 4.94 Z"
   }
  ],
  "eyes": [
   {
    "kind": "half-moon",
    "x": 7.44,
    "y": 10.88,
    "r": 2.05,
    "note": "flat edge at y, dome above",
    "tilt": -3
   },
   {
    "kind": "half-moon",
    "x": 12.64,
    "y": 10.61,
    "r": 2.05,
    "note": "flat edge at y, dome above",
    "tilt": -3
   }
  ]
 },
 "cross": {
  "body": [
   {
    "tag": "circle",
    "cx": 12.11,
    "cy": 14.15,
    "r": 3.44
   },
   {
    "tag": "circle",
    "cx": 5.85,
    "cy": 12.11,
    "r": 3.44
   },
   {
    "tag": "circle",
    "cx": 7.89,
    "cy": 5.85,
    "r": 3.44
   },
   {
    "tag": "circle",
    "cx": 14.15,
    "cy": 7.89,
    "r": 3.44
   },
   {
    "tag": "circle",
    "cx": 10.0,
    "cy": 10.0,
    "r": 3.35
   }
  ],
  "eyes": [
   {
    "kind": "capsule",
    "x": 8.41,
    "y": 9.48,
    "w": 1.67,
    "h": 3.35,
    "r": 0.84,
    "tilt": 18
   },
   {
    "kind": "capsule",
    "x": 11.59,
    "y": 10.52,
    "w": 1.67,
    "h": 3.35,
    "r": 0.84,
    "tilt": 18
   }
  ]
 },
 "flower": {
  "body": [
   {
    "tag": "circle",
    "cx": 10.0,
    "cy": 4.79,
    "r": 2.79
   },
   {
    "tag": "circle",
    "cx": 14.96,
    "cy": 8.39,
    "r": 2.79
   },
   {
    "tag": "circle",
    "cx": 13.06,
    "cy": 14.21,
    "r": 2.79
   },
   {
    "tag": "circle",
    "cx": 6.94,
    "cy": 14.21,
    "r": 2.79
   },
   {
    "tag": "circle",
    "cx": 5.04,
    "cy": 8.39,
    "r": 2.79
   },
   {
    "tag": "circle",
    "cx": 10.0,
    "cy": 10.0,
    "r": 4.09
   }
  ],
  "eyes": [
   {
    "kind": "dot",
    "x": 8.42,
    "y": 10.0,
    "r": 1.21,
    "tilt": 0
   },
   {
    "kind": "dot",
    "x": 11.58,
    "y": 10.0,
    "r": 1.21,
    "tilt": 0
   }
  ]
 },
 "square": {
  "body": [
   {
    "tag": "rect",
    "x": 2.0,
    "y": 2.19,
    "width": 16.0,
    "height": 15.62,
    "rx": 3.91
   }
  ],
  "eyes": [
   {
    "kind": "dot",
    "x": 7.4,
    "y": 9.81,
    "r": 1.58,
    "tilt": 0
   },
   {
    "kind": "dot",
    "x": 12.6,
    "y": 9.81,
    "r": 1.58,
    "tilt": 0
   }
  ]
 },
 "blob": {
  "body": [
   {
    "tag": "path",
    "d": "M5.72 4.42 C8.14 4.05 9.07 6.09 10.37 6.09 C11.67 6.09 12.79 4.05 15.39 4.61 C18 5.26 18.37 9.44 17.44 12.23 C16.32 15.39 13.16 16.7 10 16.7 C6.65 16.7 3.3 15.58 2.37 12.23 C1.54 9.07 2.75 4.88 5.72 4.42 Z"
   }
  ],
  "eyes": [
   {
    "kind": "half-moon",
    "x": 7.77,
    "y": 10.74,
    "r": 1.86,
    "note": "flat edge at y, dome above",
    "tilt": 0
   },
   {
    "kind": "half-moon",
    "x": 12.42,
    "y": 10.74,
    "r": 1.86,
    "note": "flat edge at y, dome above",
    "tilt": 0
   }
  ]
 }
}
```

### 3. Bigger and borderless (new shell only, `[data-ui='bold']`)
- No tinted tile or circle behind an agent glyph anywhere in the new shell: the body itself is the icon (the classic shell keeps its tile).
- Chats list (`bold/chats/ChatList.tsx`, `.bold-chat-avatar`): 56px glyph, no background circle; group tiles grow to 56px with a 16px
  radius so the column lines up. Row padding 6px 10px. The narrow rail keeps its own smaller size.
- A chat's header: 72px. An agent's message avatar: 40px. The Agents page cards and the Tasks agent filters: the same borderless glyph at
  their current size or larger (44px touch target either way).
- `xs` glyphs (inline mentions) stay flat with no eyes, as today.

### 4. No agent row in the top bar
Remove the desktop dock (`bold/BoldShellFrame.tsx` dock group, `bold/BoldShellDock.tsx`, its CSS, "Rings show progress"). Who needs
you stays on the Chats badge and the chat rows (check it does). Audit first: prove each removed file, export and class is unused.

### 5. The shape pickers
`routes/team/AgentAppearanceFields.tsx` and `bold/BoldAddAgentAppearance.tsx` offer only `OfferedShapes` (9), each drawn with its
eyes, labelled with `shapeName`. An agent on a retired name shows its drawn shape as the selected one; saving without a change keeps
the stored name.

## Tests
- `agent-shapes.test.ts`: the distinctness, fill and edge rules run over the nine drawn bodies; add tests for `drawnShape` (every
  ShapeSchema name maps to an offered one) and `shapeName`. The "22 shapes" and "diamond vs square" tests describe removed drawing:
  replace them with "22 names stay valid, nine are drawn" (list this in the report).
- `agent-face.test.ts`: every eye of every offered shape in every mood stays inside its body (raster check as today), arcs apart.
- e2e: update specs that look for the dock or the old picker count by reading them (`grep -rn "dock\|Your team\|ring-more\|22" e2e`);
  the lead runs them and refreshes screenshot baselines.

## Rules for every task
Follow AGENTS.md: bold tokens under `[data-ui='bold']`, `bold-` class names, theme tokens only; `data-protected` stays on AgentGlyph;
44px targets on a phone; no horizontal page scroll. **Every file at or under 450 lines** (split by job; `agent-face.ts` is 316 now:
put the eye outlines in their own file, e.g. `agent-eyes.ts`); `docs/CODEMAP.md` for every file added, moved or removed. **Never
weaken or delete an existing test assertion** except the two named above, which describe drawing that is gone; tests that find
something in its new place are updated, each listed. **Audit before removing**: prove with a search that what you remove is unused.
No new dependencies. Don't edit `docs/API-CONTRACT.md`, `docs/ARCHITECTURE.md`, `apps/server`, `packages/contract`,
`hermes-plugin`. Don't commit. Never run pkill or killall, never touch ports 8740 or 8741, never read `~/.hermes` or `~/.score`,
never run real hermes, claude or codex, never use `SCORE_E2E_DEV=1` or `git stash`.

Checks: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `node scripts/structure-check.mjs`, and the vitest files you change
or add (`pnpm --filter @score/web exec vitest run <files>`). No full run, no e2e. Report: files changed, tests added or changed
(with why), removals with proof, every difference from this brief, open questions.
