// Neutral example notes for fake mode (tests and e2e); no persona names (AGENTS.md rule 5).
export const SEED_NOTES: Record<string, string> = {
  'Welcome.md': `---
title: Welcome to the vault
tags: [start, overview]
---
# Welcome to the vault

This is the team's shared knowledge base. Start with the [[Projects/Roadmap]], look up terms in the [[Glossary]],
and keep decisions in [[Meeting notes]].

See also [[Ideas backlog]] (not written yet).
`,
  'Projects/Roadmap.md': `# Roadmap

The plan for the next quarter. Background in [[Welcome]]; terms are explained in the [[Glossary#Handoff|glossary]].

- Ship the first release candidate
- Review open questions from [[Meeting notes]]
`,
  'Glossary.md': `# Glossary

## Handoff

Passing a piece of work from one agent to another with an @mention.

## Brief

A goal the team works on together. See the [[Projects/Roadmap]].
`,
  'Meeting notes.md': `---
tags: [meetings]
---
# Meeting notes

## Planning

We agreed to review the [[Projects/Roadmap]] every week. Terms: [[Glossary]].
`,
}
