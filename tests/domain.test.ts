import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  activeRewindSeqs,
  appendSurfaceRestore,
  appendSurfaceRewind,
  computeUndoRange,
  lastVisibleMessage,
  lastVisibleText,
  supportsSurfaceRewind,
} from '../src/domain.ts'

function user(session: Session, text: string, kind: 'user' | 'plugin' = 'user'): number {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: kind === 'user' ? { kind: 'user' } : { kind: 'plugin', plugin: 'test' },
  }), { surfaceOp: 'append' }).seq
}

function assistant(session: Session, text: string, turn: number): number {
  return session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text }],
      source: { provider: 'test', model: 'test' },
    }),
  }, { surfaceOp: 'append' }).seq
}

describe('computeUndoRange', () => {
  it('selects the latest real user message and the complete surface suffix', () => {
    const session = Session.create(SessionId('latest'))
    user(session, 'first')
    assistant(session, 'one', 1)
    const second = user(session, 'second')
    user(session, 'injected context', 'plugin')
    assistant(session, 'two', 2)

    expect(computeUndoRange(session)).toEqual({
      userSeq: second,
      shadowedSeqs: [second, second + 1, second + 2],
    })
  })

  it('can target an older visible user message', () => {
    const session = Session.create(SessionId('target'))
    const first = user(session, 'first')
    assistant(session, 'one', 1)
    user(session, 'second')
    assistant(session, 'two', 2)

    expect(computeUndoRange(session, first)).toEqual({
      userSeq: first,
      shadowedSeqs: [0, 1, 2, 3],
    })
  })

  it('undoes a trailing user prompt even before a reply exists', () => {
    const session = Session.create(SessionId('trailing-user'))
    const seq = user(session, 'pending')
    expect(computeUndoRange(session)).toEqual({ userSeq: seq, shadowedSeqs: [seq] })
  })

  it('ignores plugin user-role messages as undo anchors', () => {
    const session = Session.create(SessionId('plugin-only'))
    user(session, 'context', 'plugin')
    expect(computeUndoRange(session)).toBeUndefined()
  })
})

describe('surface control operations', () => {
  it('fails closed on Harness versions without rewind support', () => {
    const session = Session.create(SessionId('legacy'))
    user(session, 'message')
    expect(supportsSurfaceRewind(session)).toBe(false)
    expect(activeRewindSeqs(session)).toEqual([])
  })

  it('appends the exact rewind and restore payloads', () => {
    const calls: Array<{ type: string; data: unknown }> = []
    const fake = {
      append(type: string, data: unknown) {
        calls.push({ type, data })
        return { type, seq: calls.length - 1, time: 0, data }
      },
    } as unknown as Session

    const rewind = appendSurfaceRewind(fake, { userSeq: 3, shadowedSeqs: [3, 4, 5] })
    appendSurfaceRestore(fake, rewind.seq)
    expect(calls).toEqual([
      {
        type: 'surface/rewind',
        data: { start: 3, end: 5, shadowedSeqs: [3, 4, 5] },
      },
      { type: 'surface/restore', data: { rewindSeq: 0 } },
    ])
  })
})

describe('visible message helpers', () => {
  it('reports the latest visible message and user preview', () => {
    const session = Session.create(SessionId('visible'))
    user(session, 'a'.repeat(40))
    const answer = assistant(session, 'answer', 1)
    expect(lastVisibleMessage(session)).toEqual({
      seq: answer,
      type: 'assistant/message',
      turn: 1,
    })
    expect(lastVisibleText(session, 10)).toBe(`${'a'.repeat(10)}…`)
  })
})
