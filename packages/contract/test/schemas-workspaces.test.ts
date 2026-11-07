import { describe, expect, test } from 'vitest'
import * as contract from '../src/index.ts'
import * as f from './fixtures.ts'
import { workspaceCases } from './schemas-cases-workspaces.ts'

describe.each(workspaceCases)('%s', (name, valid, invalid) => {
  const schema = contract[name]
  test('round-trips a valid JSON fixture', () => {
    expect(schema.parse(JSON.parse(JSON.stringify(valid)))).toEqual(valid)
  })
  test('rejects an invalid fixture', () => {
    expect(schema.safeParse(invalid).success).toBe(false)
  })
})

describe('shared workspaces (3.20.0)', () => {
  test('a workspace, its requests, and the optional room field', () => {
    const w = {
      id: 'w1',
      name: 'activity-feed',
      path: '/work/activity-feed',
      agentIds: ['lead', 'builder'],
      roomIds: ['r1'],
    }
    expect(contract.SharedWorkspaceSchema.parse(w)).toEqual(w)
    expect(contract.SharedWorkspaceListSchema.parse({ workspaces: [w] }).workspaces).toHaveLength(1)
    expect(
      contract.SharedWorkspaceCreateRequestSchema.parse({ name: ' a ', path: '/x', create: true }),
    ).toEqual({ name: 'a', path: '/x', create: true })
    expect(() =>
      contract.SharedWorkspaceCreateRequestSchema.parse({ name: '', path: '/x' }),
    ).toThrow()
    expect(() => contract.SharedWorkspaceUpdateRequestSchema.parse({})).toThrow()
    expect(contract.RoomWorkspaceRequestSchema.parse({ workspaceId: null })).toEqual({
      workspaceId: null,
    })
    expect(contract.UseAsFolderRequestSchema.parse({ agentId: 'builder' })).toEqual({
      agentId: 'builder',
    })
    const room = contract.RoomSchema.parse({ ...f.room, workspaceId: 'w1' })
    expect(room.workspaceId).toBe('w1')
    expect(contract.RoomSchema.parse(f.room).workspaceId).toBeUndefined()
  })
})
