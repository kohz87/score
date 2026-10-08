import { describe, expect, test } from 'vitest'
import { COMMANDS, parseMessage } from '../../src/domain/parse.ts'
import type { CommandName, ParsedCommand } from '../../src/domain/parse.ts'

const agents = Object.freeze([
  'lead',
  'builder',
  'reviewer',
  'designer',
  'builder-2',
  'build_bot',
  '2d',
])

describe('mentions', () => {
  const cases: [string, string[], string[]?][] = [
    ['', []],
    ['plain text', []],
    ['@builder', ['builder']],
    ['@builder, please', ['builder']],
    ['@builder.', ['builder']],
    ['(@builder)', ['builder']],
    ['[@builder]', ['builder']],
    ['@builder!', ['builder']],
    ['@builder? @reviewer:', ['builder', 'reviewer']],
    ['@builder; @reviewer…', ['builder', 'reviewer']],
    ['@builder:please review', ['builder']],
    ['你好，@builder。', ['builder']],
    ['👋 @designer ✅', ['designer']],
    ['@builder @reviewer @builder @lead', ['builder', 'reviewer', 'lead']],
    ['@builder-2 @build_bot @2d', ['builder-2', 'build_bot', '2d']],
    ['\t@lead\r\n@builder', ['lead', 'builder']],
    ['@unknown @builder @unknown @other', ['builder'], ['unknown', 'other']],
    ['@Builder @BUILDER @builder', ['builder']],
    ['@builderX @builderé @builder界', []],
    ['@builder\u0301', []],
    ['@_builder @-builder @', []],
    ['@@builder', []],
    ['hello@builder', []],
    ['你好@builder', []],
    ['a@builder.com', []],
    ['a.b+tag@builder.com', []],
    ['a@builder', []],
    ['@builder.com', []],
    ['@unknown.example', []],
    ['user@unknown.test @builder', ['builder']],
    ['name@build_bot.example @reviewer', ['reviewer']],
    ['https://example.test/@builder @reviewer', ['reviewer']],
    ['https://@builder@example.test', []],
    ['http://example.test?q=@builder#@reviewer', []],
    ['ftp://example.test/@builder', []],
    ['mailto:person@builder.test', []],
    ['www.example.test/@builder', []],
    ['//example.test/@builder', []],
    ['example.test/@builder @lead', ['lead']],
    ['example.test?user=@builder @lead', ['lead']],
    ['example.test#@builder @lead', ['lead']],
    ['<https://example.test/@builder>', []],
    ['[site](https://example.test/@builder)', []],
    ['[site](/people/@builder)', []],
    ['[site](<https://example.test/@unknown>) @lead', ['lead']],
    ['[@builder](https://example.test/@reviewer)', ['builder']],
    ['`@builder` @reviewer', ['reviewer']],
    ['``@builder ` @unknown`` @lead', ['lead']],
    ['`` @builder ``', []],
    ['`@builder\n@reviewer` @lead', ['lead']],
    ['`@builder\r\n@reviewer` @lead', ['lead']],
    ['`@builder` and `@reviewer` @designer', ['designer']],
    ['`@builder', ['builder']],
    ['\\`@builder', ['builder']],
    ['`@builder\\` @lead', ['lead']],
    ['\\@builder @reviewer', ['reviewer']],
    ['\\\\@builder', ['builder']],
    ['```\n@builder\n```\n@lead', ['lead']],
    ['```ts\r\n@unknown\r\n```\r\n@reviewer', ['reviewer']],
    ['~~~text\n@builder\n~~~\n@designer', ['designer']],
    ['   ```js\n@builder\n   ```\n@lead', ['lead']],
    ['````\n```\n@builder\n````\n@lead', ['lead']],
    ['```\n@builder\n~~~\n@reviewer', []],
    ['```\n@builder\n``` still code\n@reviewer\n```\n@lead', ['lead']],
    ['```\n@unknown', []],
    ['~~~\n@builder', []],
    ['before\n```\n@builder\n```\nafter @lead', ['lead']],
    ['@builder\n~~~\n@reviewer\n~~~\n@builder @designer', ['builder', 'designer']],
    ['`@unknown` @other', [], ['other']],
    ['@builder-more', [], ['builder-more']],
    ['@build_bot_2 @9-agent', [], ['build_bot_2', '9-agent']],
  ]

  test.each(cases)('%j', (text, mentions, unknownMentions = []) => {
    expect(parseMessage(text, agents)).toEqual({ text, mentions, unknownMentions, command: null })
  })

  test('known ids are supplied by the caller and must match the token grammar', () => {
    expect(
      parseMessage('@builder @reviewer @Builder @bad.id', ['reviewer', 'Builder', 'bad.id']),
    ).toMatchObject({ mentions: ['reviewer'], unknownMentions: ['builder'] })
  })

  test('no known agents still reports unknown mentions', () => {
    expect(parseMessage('@builder @builder @lead', [])).toMatchObject({
      mentions: [],
      unknownMentions: ['builder', 'lead'],
    })
  })
})

describe('valid commands', () => {
  const cases: [string, ParsedCommand][] = [
    [
      '/assign @builder Build parser',
      { kind: 'assign', agentId: 'builder', title: 'Build parser', body: null },
    ],
    [
      '/assign @builder Build -- Include tests',
      { kind: 'assign', agentId: 'builder', title: 'Build', body: 'Include tests' },
    ],
    [
      '/assign @builder Build -- body -- more',
      { kind: 'assign', agentId: 'builder', title: 'Build', body: 'body -- more' },
    ],
    [
      '/assign @builder Build--fast',
      { kind: 'assign', agentId: 'builder', title: 'Build--fast', body: null },
    ],
    [
      '/assign @builder Build --flag',
      { kind: 'assign', agentId: 'builder', title: 'Build --flag', body: null },
    ],
    [
      '/assign @builder Use `--` flag -- Details',
      { kind: 'assign', agentId: 'builder', title: 'Use `--` flag', body: 'Details' },
    ],
    [
      '/assign\t@build_bot\t标题 ✅\r\n--\r\n细节',
      { kind: 'assign', agentId: 'build_bot', title: '标题 ✅', body: '细节' },
    ],
    [
      '/assign @builder-2\nBuild\nparser',
      { kind: 'assign', agentId: 'builder-2', title: 'Build\nparser', body: null },
    ],
    [
      '/routine @builder 5m Check status',
      { kind: 'routine', agentId: 'builder', schedule: '5m', prompt: 'Check status' },
    ],
    [
      '/routine @lead 1h Review progress',
      { kind: 'routine', agentId: 'lead', schedule: '1h', prompt: 'Review progress' },
    ],
    [
      '/routine @reviewer 2d Review changes',
      { kind: 'routine', agentId: 'reviewer', schedule: '2d', prompt: 'Review changes' },
    ],
    [
      '/routine @lead every 15m Check',
      { kind: 'routine', agentId: 'lead', schedule: 'every 15m', prompt: 'Check' },
    ],
    [
      '/routine @lead every\t2h Check',
      { kind: 'routine', agentId: 'lead', schedule: 'every\t2h', prompt: 'Check' },
    ],
    [
      '/routine @lead daily 09:30 Check',
      { kind: 'routine', agentId: 'lead', schedule: 'daily 09:30', prompt: 'Check' },
    ],
    [
      '/routine @lead daily 00:00 Check',
      { kind: 'routine', agentId: 'lead', schedule: 'daily 00:00', prompt: 'Check' },
    ],
    [
      '/routine @lead daily 23:59 Check',
      { kind: 'routine', agentId: 'lead', schedule: 'daily 23:59', prompt: 'Check' },
    ],
    [
      '/routine @lead "0 9 * * *" Check',
      { kind: 'routine', agentId: 'lead', schedule: '0 9 * * *', prompt: 'Check' },
    ],
    [
      '/routine @lead "0 9 * JAN-MAR MON,FRI" Check',
      { kind: 'routine', agentId: 'lead', schedule: '0 9 * JAN-MAR MON,FRI', prompt: 'Check' },
    ],
    [
      "/routine @lead '*/15 9-17 * * 1,3,5' Check",
      { kind: 'routine', agentId: 'lead', schedule: '*/15 9-17 * * 1,3,5', prompt: 'Check' },
    ],
    [
      '/routine @lead "0  9\t* * *" Check',
      { kind: 'routine', agentId: 'lead', schedule: '0  9\t* * *', prompt: 'Check' },
    ],
    [
      '/routine @lead "99 99 * * *" Check',
      { kind: 'routine', agentId: 'lead', schedule: '99 99 * * *', prompt: 'Check' },
    ],
    [
      '/routine @lead 5m\r\n检查\r\n进展 ✅',
      { kind: 'routine', agentId: 'lead', schedule: '5m', prompt: '检查\r\n进展 ✅' },
    ],
    ['/remember Keep tests pure', { kind: 'remember', agents: [], fact: 'Keep tests pure' }],
    [
      '/remember @lead Keep tests pure',
      { kind: 'remember', agents: ['lead'], fact: 'Keep tests pure' },
    ],
    [
      '/remember @builder @reviewer Use fixtures',
      { kind: 'remember', agents: ['builder', 'reviewer'], fact: 'Use fixtures' },
    ],
    [
      '/remember @builder @builder @lead Use fixtures',
      { kind: 'remember', agents: ['builder', 'lead'], fact: 'Use fixtures' },
    ],
    [
      '/remember @lead Ask @reviewer before merging',
      { kind: 'remember', agents: ['lead'], fact: 'Ask @reviewer before merging' },
    ],
    ['/remember Ask @builder later', { kind: 'remember', agents: [], fact: 'Ask @builder later' }],
    ['/remember `@builder` is code', { kind: 'remember', agents: [], fact: '`@builder` is code' }],
    [
      '/remember\r\n@lead\r\n保留\r\n格式 ✅',
      { kind: 'remember', agents: ['lead'], fact: '保留\r\n格式 ✅' },
    ],
    [
      '/skill @builder code-review',
      { kind: 'skill', action: 'use', agentId: 'builder', name: 'code-review' },
    ],
    [
      '/skill @build_bot team/review',
      { kind: 'skill', action: 'use', agentId: 'build_bot', name: 'team/review' },
    ],
    ['/skill install code-review', { kind: 'skill', action: 'install', name: 'code-review' }],
    ['/skill\tinstall\tteam/review\r\n', { kind: 'skill', action: 'install', name: 'team/review' }],
    [
      '/model provider/model Explain this',
      { kind: 'model', model: 'provider/model', message: 'Explain this' },
    ],
    [
      '/model local:model @builder 帮忙 ✅',
      { kind: 'model', model: 'local:model', message: '@builder 帮忙 ✅' },
    ],
    [
      '/model\tmodel-1\r\nFirst\r\nsecond  \r\n',
      { kind: 'model', model: 'model-1', message: 'First\r\nsecond  \r\n' },
    ],
    [
      '/model model-1 /assign @builder Build',
      { kind: 'model', model: 'model-1', message: '/assign @builder Build' },
    ],
  ]

  test.each(cases)('%j', (text, command) => {
    const result = parseMessage(text, agents)
    expect(result.command).toEqual(command)
    const expectedText = command.kind === 'model' ? command.message : text
    expect(result.text).toBe(expectedText)
    expect(result.mentions).toEqual(parseMessage(`plain ${expectedText}`, agents).mentions)
  })
})

describe('invalid commands', () => {
  const cases: [string, CommandName, RegExp][] = [
    ['/assign', 'assign', /@agent/],
    ['/assign Build', 'assign', /@agent/],
    ['/assign @unknown Build', 'assign', /Unknown agent/],
    ['/assign @Builder Build', 'assign', /@agent/],
    ['/assign @builder, Build', 'assign', /@agent/],
    ['/assign `@builder` Build', 'assign', /@agent/],
    ['/assign @builder', 'assign', /title/],
    ['/assign @builder   ', 'assign', /title/],
    ['/assign @builder -- body', 'assign', /title/],
    ['/assign @builder Title --', 'assign', /body/],
    ['/routine', 'routine', /@agent/],
    ['/routine @unknown 5m Check', 'routine', /Unknown agent/],
    ['/routine lead 5m Check', 'routine', /@agent/],
    ['/routine @lead', 'routine', /schedule/],
    ['/routine @lead 5m', 'routine', /prompt/],
    ['/routine @lead every 15m', 'routine', /prompt/],
    ['/routine @lead daily 09:00', 'routine', /prompt/],
    ['/routine @lead "0 9 * * *"', 'routine', /prompt/],
    ['/routine @lead 0m Check', 'routine', /schedule/],
    ['/routine @lead -5m Check', 'routine', /schedule/],
    ['/routine @lead 1.5h Check', 'routine', /schedule/],
    ['/routine @lead 5s Check', 'routine', /schedule/],
    ['/routine @lead 5M Check', 'routine', /schedule/],
    ['/routine @lead every 0m Check', 'routine', /schedule/],
    ['/routine @lead every five Check', 'routine', /schedule/],
    ['/routine @lead daily 24:00 Check', 'routine', /schedule/],
    ['/routine @lead daily 12:60 Check', 'routine', /schedule/],
    ['/routine @lead daily 9:00 Check', 'routine', /schedule/],
    ['/routine @lead daily 09:00:00 Check', 'routine', /schedule/],
    ['/routine @lead "0 9 * *" Check', 'routine', /schedule/],
    ['/routine @lead "0 9 * * * *" Check', 'routine', /schedule/],
    ['/routine @lead "five 9 * * *" Check', 'routine', /schedule/],
    ['/routine @lead "0 9 * FOO MON" Check', 'routine', /schedule/],
    ['/routine @lead "0 9 * JAN15 MON" Check', 'routine', /schedule/],
    ['/routine @lead "0 9 * * */MON" Check', 'routine', /schedule/],
    ['/routine @lead "0 9 JAN * *" Check', 'routine', /schedule/],
    ['/routine @lead "0 9 * * * Check', 'routine', /schedule/],
    ['/routine @lead "0 9 * * *\' Check', 'routine', /schedule/],
    ['/routine @lead 0 9 * * * Check', 'routine', /schedule/],
    ['/routine @lead "5m" Check', 'routine', /schedule/],
    ['/routine @lead "" Check', 'routine', /schedule/],
    ['/remember', 'remember', /fact/],
    ['/remember   ', 'remember', /fact/],
    ['/remember @lead', 'remember', /fact/],
    ['/remember @lead @builder', 'remember', /fact/],
    ['/remember @unknown Fact', 'remember', /Unknown agent/],
    ['/remember @lead @unknown Fact', 'remember', /Unknown agent/],
    ['/remember @Builder Fact', 'remember', /@agent/],
    ['/skill', 'skill', /@agent/],
    ['/skill review', 'skill', /@agent/],
    ['/skill @unknown review', 'skill', /Unknown agent/],
    ['/skill @builder', 'skill', /name/],
    ['/skill install', 'skill', /name/],
    ['/skill @builder name extra', 'skill', /one skill name/],
    ['/skill install name extra', 'skill', /one skill name/],
    ['/model', 'model', /model/],
    ['/model model-1', 'model', /message/],
    ['/model model-1 \r\n\t', 'model', /message/],
  ]

  test.each(cases)('%j', (text, command, error) => {
    const result = parseMessage(text, agents)
    expect(result.text).toBe(text)
    expect(result.command).toEqual({
      kind: 'invalid',
      command,
      error: expect.stringMatching(error),
      usage: COMMANDS.find(({ name }) => name === command)!.usage,
    })
  })
})

describe('command recognition and purity', () => {
  test.each([
    '/unknown @builder',
    '/assigning @builder',
    '/assign@builder Title',
    '/assign, @builder Title',
    '/ASSIGN @builder Title',
    ' /assign @builder Title',
    '\t/model model-1 Hello',
    '\r\n/remember Fact',
    'hello /assign @builder Title',
    '`/assign @builder Title`',
    '```\n/assign @builder Title\n```',
    '/',
    '//assign @builder Title',
  ])('%j is plain text', (text) => {
    expect(parseMessage(text, agents)).toMatchObject({ text, command: null })
  })

  test('model names do not become mention targets', () => {
    expect(parseMessage('/model @builder @reviewer hello @unknown', agents)).toEqual({
      text: '@reviewer hello @unknown',
      mentions: ['reviewer'],
      unknownMentions: ['unknown'],
      command: { kind: 'model', model: '@builder', message: '@reviewer hello @unknown' },
    })
  })

  test('mentions in command text obey the same exclusions', () => {
    expect(
      parseMessage('/assign @builder Ask @reviewer -- `@lead` @unknown', agents),
    ).toMatchObject({ mentions: ['builder', 'reviewer'], unknownMentions: ['unknown'] })
  })

  test('metadata describes all commands exactly once', () => {
    expect(COMMANDS.map(({ name }) => name)).toEqual([
      'assign',
      'routine',
      'remember',
      'skill',
      'model',
    ])
    for (const command of COMMANDS) {
      expect(command.usage).toContain(`/${command.name}`)
      expect(command.description.length).toBeGreaterThan(0)
    }
  })

  test('calls are deterministic with independent result arrays and no input mutation', () => {
    const text = '/remember @builder @lead Keep @reviewer informed'
    const first = parseMessage(text, agents)
    const second = parseMessage(text, agents)
    expect(first).toEqual(second)
    first.mentions.push('designer')
    first.unknownMentions.push('unknown')
    if (first.command?.kind === 'remember') first.command.agents.push('designer')
    expect(parseMessage(text, agents)).toEqual(second)
    expect(agents).toEqual([
      'lead',
      'builder',
      'reviewer',
      'designer',
      'builder-2',
      'build_bot',
      '2d',
    ])
  })
})
