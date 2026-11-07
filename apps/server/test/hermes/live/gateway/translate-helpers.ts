import { rmSync } from 'node:fs'
import { afterEach, beforeEach } from 'vitest'
import { reserveMessageRun } from '../../../../src/domain/message-runs.ts'
import { insertRoom, messageFromRow, storeMessage } from '../../../../src/domain/rooms.ts'
import { messageTurnId } from '../../../../src/domain/routing.ts'
import { setup } from './helpers.ts'

export type TranslateEnv = ReturnType<typeof setup>

export let env: TranslateEnv

export function installTranslateHooks() {
  beforeEach(() => {
    env = setup()
  })
  afterEach(async () => {
    await env.ingest.close()
    env.db.close()
    rmSync(env.home, { recursive: true, force: true })
  })
}

export async function admitted() {
  const { runId } = await env.intents.startRunIntent(
    { profile: 'builder', input: 'fixture' },
    'fixture-turn',
  )
  return { profile: 'builder', runId, credentialGeneration: 1 }
}

export async function admittedMessageFor(testEnv: TranslateEnv) {
  await testEnv.ingest.submit({
    source: 'test',
    identity: 'room-message',
    apply({ sqlite, now }) {
      insertRoom(
        sqlite,
        {
          id: 'chat',
          name: '#chat',
          kind: 'room',
          leadAgentId: 'builder',
          members: ['builder'],
          routing: 'mentions', // D3.2 @mention routing, kept for rooms still on mentions (orchestration runs)
        },
        now,
      )
      const drafts = storeMessage(
        sqlite,
        {
          id: 'human',
          roomId: 'chat',
          author: { kind: 'you' },
          to: [],
          parts: [{ kind: 'text', text: 'fixture' }],
          refs: [],
          streaming: false,
          createdAt: now,
        },
        now,
      )
      reserveMessageRun(
        sqlite,
        {
          parentMessageId: 'human',
          roomId: 'chat',
          agentId: 'builder',
          chainId: 'human',
          hop: 0,
          input: 'fixture',
          agents: ['builder', 'reviewer'],
        },
        now,
      )
      return drafts
    },
  })
  const { runId } = await testEnv.intents.startRunIntent(
    { profile: 'builder', input: 'fixture' },
    messageTurnId('human', 'builder'),
  )
  return { profile: 'builder', runId, credentialGeneration: 1 }
}

export const admittedMessage = () => admittedMessageFor(env)

export function replyMessageFrom(testEnv: TranslateEnv) {
  return messageFromRow(
    testEnv.db.sqlite.prepare("SELECT * FROM messages WHERE author_kind = 'agent'").get(),
  )
}

export const replyMessage = () => replyMessageFrom(env)
