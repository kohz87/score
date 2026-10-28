# Job map (decision 151)

The owner approved the graph design on 2026-10-28 ("this is good"). These are the mock-up's two graph boards (desktop and phone),
built as Design Component pages on a claude.ai canvas: reference only, like the other boards here. Rebuild in React with the bold
tokens; never paste this markup. The data in them is a sample from the owner's job (agent names are the owner's own agents; never
ship them as defaults or in tests: AGENTS.md rule 5).

Layout, top to bottom: you (the prompt) → **Lead** (pulses while working; advisor's checkpoint marks) with the **Advisor** beside it
on a dashed "on call" line → **Fork layer · votes** (question, share bar, sharp/split) → fan-out to the **Swarm** (one node per
helper: role, status, last sign of life) → fan-in "back to the lead" → **Workers** (step chips, the stuck-step warning with Stop) →
**Check** ("runs the code, not an opinion") → **Session log** (the latest lines; clicking a node shows only its layer). Dots run
along the lines where work is flowing. Each layer is one node that summarises itself; layers a job doesn't use are not drawn.
