// A small tokenizer for fenced code in chat replies (PLAN 5.25). It colours comments, strings, numbers and keywords
// of the common languages; unknown languages come back as plain text. No dependency: a regex scanner is enough here.
export type Token = { text: string; type: 'plain' | 'comment' | 'string' | 'number' | 'keyword' }

const WORDS = {
  js: 'as async await break case catch class const continue default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of private protected public readonly return static super switch this throw true try type typeof undefined var void while yield',
  py: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield',
  sh: 'case do done elif else esac exit export fi for function if in local return then until while',
  sql: 'ALTER AND AS BY CREATE DELETE DROP FROM GROUP INSERT INTO JOIN LEFT LIMIT NOT NULL ON OR ORDER SELECT SET TABLE UPDATE VALUES WHERE',
  go: 'break case chan const continue default defer else for func go if import interface map package range return select struct switch type var',
  rust: 'as async await break const continue crate else enum fn for if impl in let loop match mod move mut pub ref return self struct trait type use where while',
  data: 'true false null',
} as const

type Family = {
  words: ReadonlySet<string>
  line: string | null
  block: boolean
  fold: boolean
}
const family = (words: string, line: string | null, block = false, fold = false): Family => ({
  words: new Set(words.split(' ')),
  line,
  block,
  fold,
})
const FAMILIES: Record<string, Family> = {
  js: family(WORDS.js, '//', true),
  py: family(WORDS.py, '#'),
  sh: family(WORDS.sh, '#'),
  sql: family(WORDS.sql, '--', true, true),
  go: family(WORDS.go, '//', true),
  rust: family(WORDS.rust, '//', true),
  data: family(WORDS.data, '#'),
  json: family(WORDS.data, null),
  css: family('', null, true),
}
const ALIASES: Record<string, string> = {
  javascript: 'js',
  jsx: 'js',
  ts: 'js',
  typescript: 'js',
  tsx: 'js',
  mjs: 'js',
  java: 'js',
  c: 'js',
  cpp: 'js',
  csharp: 'js',
  python: 'py',
  bash: 'sh',
  shell: 'sh',
  zsh: 'sh',
  yaml: 'data',
  yml: 'data',
  toml: 'data',
  golang: 'go',
  rs: 'rust',
}

export function normalizeLanguage(language: string | null | undefined): string | null {
  const name = (language ?? '').trim().toLowerCase()
  if (!name) return null
  const key = ALIASES[name] ?? name
  return key in FAMILIES ? key : null
}

const NUMBER = /^(?:0x[\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i
const WORD = /^[A-Za-z_$][\w$]*/

export function tokenize(code: string, language: string | null | undefined): Token[] {
  const key = normalizeLanguage(language)
  const rules = key ? FAMILIES[key]! : null
  if (!rules) return [{ text: code, type: 'plain' }]
  const tokens: Token[] = []
  let plain = ''
  const flush = () => {
    if (plain) tokens.push({ text: plain, type: 'plain' })
    plain = ''
  }
  const push = (text: string, type: Token['type']) => {
    flush()
    tokens.push({ text, type })
  }
  let index = 0
  while (index < code.length) {
    const rest = code.slice(index)
    if (rules.line && rest.startsWith(rules.line)) {
      const end = rest.indexOf('\n')
      const text = end === -1 ? rest : rest.slice(0, end)
      push(text, 'comment')
      index += text.length
      continue
    }
    if (rules.block && rest.startsWith('/*')) {
      const end = rest.indexOf('*/', 2)
      const text = end === -1 ? rest : rest.slice(0, end + 2)
      push(text, 'comment')
      index += text.length
      continue
    }
    const quote = rest[0]
    if (quote === '"' || quote === "'" || (quote === '`' && key !== 'sh')) {
      let end = 1
      while (end < rest.length && rest[end] !== quote) {
        if (rest[end] === '\\') end++
        // Only a template literal may span lines; a lone quote elsewhere must not swallow the rest of the block.
        else if (rest[end] === '\n' && quote !== '`') break
        end++
      }
      const text = rest.slice(0, rest[end] === quote ? end + 1 : end)
      push(text, 'string')
      index += text.length
      continue
    }
    const before = plain.slice(-1)
    if (!/[\w$]/.test(before)) {
      const number = NUMBER.exec(rest)
      if (number) {
        push(number[0], 'number')
        index += number[0].length
        continue
      }
    }
    const word = WORD.exec(rest)
    if (word) {
      const text = word[0]
      push(text, rules.words.has(rules.fold ? text.toUpperCase() : text) ? 'keyword' : 'plain')
      index += text.length
      continue
    }
    plain += quote
    index++
  }
  flush()
  // Adjacent plain pieces (words that are not keywords) merge so the DOM stays small.
  return tokens.reduce<Token[]>((merged, token) => {
    const last = merged.at(-1)
    if (last && last.type === 'plain' && token.type === 'plain') last.text += token.text
    else merged.push({ ...token })
    return merged
  }, [])
}
