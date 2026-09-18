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
  turnForAssistantMessage,
  userSeqForTurn,
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

describe('turn and message anchors', () => {
  /** Open a numbered Turn boundary the way the loop does, around its prompt. */
  function turn(session: Session, n: number, prompt: string, answer: string): { userSeq: number; messageId: string } {
    session.append('turn/start', { turn: n })
    const userSeq = user(session, prompt)
    const seq = assistant(session, answer, n)
    session.append('turn/end', { turn: n, reason: { kind: 'completed' } })
    const event = session.events[seq]
    if (event?.type !== 'assistant/message') throw new Error('fixture: expected assistant message')
    return { userSeq, messageId: event.data.message.id }
  }

  it('anchors a Turn on the prompt between its own boundaries', () => {
    const session = Session.create(SessionId('anchor'))
    const first = turn(session, 1, 'first', 'one')
    const second = turn(session, 2, 'second', 'two')

    expect(userSeqForTurn(session, 1)).toBe(first.userSeq)
    expect(userSeqForTurn(session, 2)).toBe(second.userSeq)
    expect(computeUndoRange(session, userSeqForTurn(session, 1))).toEqual({
      userSeq: first.userSeq,
      shadowedSeqs: [first.userSeq, first.userSeq + 1, second.userSeq, second.userSeq + 1],
    })
  })

  it('never borrows a later Turn prompt for a Turn that has none', () => {
    const session = Session.create(SessionId('empty-turn'))
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const second = turn(session, 2, 'second', 'two')

    expect(userSeqForTurn(session, 1)).toBeUndefined()
    expect(userSeqForTurn(session, 2)).toBe(second.userSeq)
    expect(userSeqForTurn(session, 99)).toBeUndefined()
  })

  it('resolves the Turn behind a durable assistant message id', () => {
    const session = Session.create(SessionId('message-turn'))
    const first = turn(session, 1, 'first', 'one')
    const second = turn(session, 2, 'second', 'two')

    expect(turnForAssistantMessage(session, second.messageId)).toBe(2)
    expect(turnForAssistantMessage(session, first.messageId)).toBe(1)
    expect(turnForAssistantMessage(session, 'missing')).toBeUndefined()
  })

  it('never borrows a real prompt that sits outside the Turn boundaries', () => {
    const session = Session.create(SessionId('outside-turn'))
    const stray = user(session, 'earlier prompt')
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const second = turn(session, 2, 'second', 'two')

    // Turn 1 opened and closed with no prompt of its own: the earlier real user
    // message is outside its boundaries and must not become its anchor.
    expect(userSeqForTurn(session, 1)).toBeUndefined()
    expect(userSeqForTurn(session, 2)).toBe(second.userSeq)
    expect(stray).toBeLessThan(second.userSeq)
  })
})
