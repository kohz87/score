export function demoQuestion(
  message: string,
): { question: string; options: string[]; multiSelect: boolean } | null {
  if (/ask me to choose several/i.test(message))
    return {
      question: 'Which environments should I deploy to?',
      options: ['staging', 'production', 'preview'],
      multiSelect: true,
    }
  if (/ask me to pick/i.test(message))
    return {
      question: 'Which branch should I use?',
      options: ['main', 'develop'],
      multiSelect: false,
    }
  if (/ask me/i.test(message))
    return { question: 'What should the release be called?', options: [], multiSelect: false }
  return null
}

/** Demo hooks for the fake adapter: phrases in the message pick a Markdown reply or a long one (Stop). */
export function demoReply(
  input: string,
  base: { text: string; tools: string[] },
): { text: string; tools: string[] } {
  // The room summary run (PLAN 7.4a) starts with a fixed instruction.
  if (input.startsWith('Summarise the earlier messages of this room')) {
    const earlier = input.split('\n').filter((row) => /^(you|[a-z][\w-]*): /.test(row)).length
    return {
      text: `Summary of ${earlier} earlier messages: the team agreed on the plan, split the work and left the release date open.`,
      tools: [],
    }
  }
  const message = input.split('\n\nRoom context:')[0] ?? ''
  if (/markdown demo/i.test(message))
    return {
      text: '## Plan\n\nHere is **the change**:\n\n```ts\nconst pageSize = 25\n```\n\n- first\n- second\n',
      tools: ['terminal'],
    }
  if (/long reply/i.test(message))
    return { text: 'Working through the details. '.repeat(40), tools: [] }
  return base
}
