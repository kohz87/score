import { THEME_COLOR_TOKENS } from '@score/contract'
import { describe, expect, it } from 'vitest'
import { editableTokens, tokenGroups, tokenLabel } from './token-info.ts'

describe('the Colours groups of the new shell (decision 131 E)', () => {
  it('are the new shell’s areas, with no Flow or Tasks colours', () => {
    expect(tokenGroups.map((group) => group.label)).toEqual([
      'Ground and panels',
      'Text',
      'For you and results',
      'Lines',
      'Agent screen and code',
    ])
    expect(editableTokens.some((token) => /^(flow|tasks)-/.test(token))).toBe(false)
  })

  it('offer only public tokens, each once', () => {
    expect(new Set(editableTokens).size).toBe(editableTokens.length)
    for (const token of editableTokens) expect(THEME_COLOR_TOKENS).toContain(token)
  })

  it('still name a colour the old Customizer offered, for the checks', () => {
    expect(tokenLabel('chat-text')).toBe('Message text')
    expect(tokenLabel('ground')).toBe('Ground')
  })
})
