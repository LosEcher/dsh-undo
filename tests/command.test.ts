import { describe, expect, it } from 'vitest'
import { parseUndoTarget } from '../src/index.ts'

describe('parseUndoTarget', () => {
  it('defaults to the latest user input', () => {
    expect(parseUndoTarget('')).toEqual({ kind: 'latest' })
  })

  it('accepts an explicit user-message seq', () => {
    expect(parseUndoTarget('42')).toEqual({ kind: 'user-seq', seq: 42 })
  })

  it('accepts the two anchors the Web action can address', () => {
    expect(parseUndoTarget('turn:7')).toEqual({ kind: 'turn', turn: 7 })
    expect(parseUndoTarget('TURN:7')).toEqual({ kind: 'turn', turn: 7 })
    expect(parseUndoTarget('message:msg-abc_1')).toEqual({ kind: 'message', messageId: 'msg-abc_1' })
  })

  it('rejects malformed input instead of guessing', () => {
    for (const raw of ['-1', '1.5', 'turn:', 'turn:x', 'message:', 'message:a b', 'turn', 'latest', '0x10']) {
      expect(parseUndoTarget(raw), raw).toBeUndefined()
    }
  })
})
