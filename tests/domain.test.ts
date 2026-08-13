/**
 * Pure domain tests: undo range computation and the surface effects of the
 * undo marker and redo copies, exercised against detached sessions (no store,
 * no persistence backend needed).
 */

import { describe, expect, it } from 'vitest'
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type CallId,
} from '@deepseek-ai/dsh-llm'
import {
  deriveEventMessage,
  foldSurface,
  Session,
  SessionId,
  type SessionEvent,
  type SessionEventMap,
} from '@deepseek-ai/dsh-session'
import {
  appendRedoCopies,
  appendUndoMarker,
  computeUndoRange,
  currentStep,
  lastCompletedStep,
} from '../src/domain.ts'

type SurfaceOp = 'append' | { op: 'replace'; start: number; end: number }

let nextSeq = 0

function resetSeq(): void {
  nextSeq = 0
}

/** Build one log event with the given coordinates, stamped by the builder. */
function ev<K extends keyof SessionEventMap>(
  type: K,
  data: SessionEventMap[K],
  surfaceOp?: SurfaceOp,
): SessionEvent {
  return {
    type,
    seq: nextSeq++,
    time: 1000 + nextSeq,
    data,
    ...surfaceOp === undefined ? {} : { surfaceOp },
  } as SessionEvent
}

function userMessage(turn: number, step: number, text: string): SessionEvent<'user/message'> {
  return ev('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'test' },
  }), 'append') as SessionEvent<'user/message'>
}

function assistantMessage(turn: number, step: number, text: string): SessionEvent<'assistant/message'> {
  return ev('assistant/message', {
    turn,
    step,
    message: createAssistantMessage({
      content: [{ type: 'text', text }],
      source: { provider: 'test-provider', model: 'test-model' },
    }),
  }, 'append') as SessionEvent<'assistant/message'>
}

function toolResult(turn: number, step: number, callId: string, text: string): SessionEvent<'tool/result'> {
  return ev('tool/result', {
    turn,
    step,
    message: createToolResultMessage({
      callId: callId as CallId,
      content: [{ type: 'text', text }],
      isError: false,
    }),
  }, 'append') as SessionEvent<'tool/result'>
}

function stepStart(turn: number, step: number): SessionEvent<'step/start'> {
  return ev('step/start', { turn, step }) as SessionEvent<'step/start'>
}

function stepEnd(turn: number, step: number): SessionEvent<'step/end'> {
  return ev('step/end', { turn, step }) as SessionEvent<'step/end'>
}

function createSession(seed: readonly SessionEvent[]): Session {
  return Session.create(SessionId(`test-${nextSeq}`), seed)
}

describe('lastCompletedStep / currentStep', () => {
  it('returns undefined for an empty log', () => {
    resetSeq()
    const session = createSession([])
    expect(lastCompletedStep(session.events)).toBeUndefined()
    expect(currentStep(session.events)).toBeUndefined()
  })

  it('finds the newest step/end and step/start', () => {
    resetSeq()
    const session = createSession([
      stepStart(1, 1),
      userMessage(1, 1, 'hello'),
      stepEnd(1, 1),
      stepStart(2, 1),
      userMessage(2, 1, 'again'),
      stepEnd(2, 1),
      stepStart(3, 1),
    ])
    expect(lastCompletedStep(session.events)).toEqual({ turn: 2, step: 1 })
    expect(currentStep(session.events)).toEqual({ turn: 3, step: 1 })
  })
})

describe('computeUndoRange', () => {
  it('returns undefined when no step has completed', () => {
    resetSeq()
    const session = createSession([
      stepStart(1, 1),
      userMessage(1, 1, 'hello'),
      assistantMessage(1, 1, 'hi'),
    ])
    expect(computeUndoRange(session)).toBeUndefined()
  })

  it('returns the completed step’s assistant/tool nodes, never the user message', () => {
    resetSeq()
    const session = createSession([
      stepStart(1, 1),
      userMessage(1, 1, 'fix it'),
      assistantMessage(1, 1, 'Let me read the file.'),
      toolResult(1, 1, 'call-1', 'file contents'),
      stepEnd(1, 1),
    ])
    const range = computeUndoRange(session)
    expect(range).toEqual({ shadowedSeqs: [2, 3], turn: 1, step: 1 })
  })

  it('targets the last completed step mid-turn', () => {
    resetSeq()
    const session = createSession([
      stepStart(1, 1),
      userMessage(1, 1, 'fix it'),
      assistantMessage(1, 1, 'step one'),
      toolResult(1, 1, 'call-1', 'ok'),
      stepEnd(1, 1),
      stepStart(1, 2),
      assistantMessage(1, 2, 'step two (calls undo)'),
    ])
    const range = computeUndoRange(session)
    expect(range).toEqual({ shadowedSeqs: [2, 3], turn: 1, step: 1 })
  })

  it('walks back one step at a time after an undo shadows the newest step', () => {
    resetSeq()
    const session = createSession([
      stepStart(1, 1),
      userMessage(1, 1, 'task'),
      assistantMessage(1, 1, 'first'),
      toolResult(1, 1, 'call-1', 'a'),
      stepEnd(1, 1),
      stepStart(1, 2),
      assistantMessage(1, 2, 'second'),
      toolResult(1, 2, 'call-2', 'b'),
      stepEnd(1, 2),
      stepStart(1, 3),
      assistantMessage(1, 3, 'calls undo'),
    ])
    const first = computeUndoRange(session)
    expect(first).toEqual({ shadowedSeqs: [6, 7], turn: 1, step: 2 })

    appendUndoMarker(session, first!.shadowedSeqs, 'test-provider', 'test-model')

    const second = computeUndoRange(session)
    expect(second).toEqual({ shadowedSeqs: [2, 3], turn: 1, step: 1 })
  })

  it('returns undefined when every completed step is already shadowed', () => {
    resetSeq()
    const session = createSession([
      stepStart(1, 1),
      userMessage(1, 1, 'task'),
      assistantMessage(1, 1, 'work'),
      stepEnd(1, 1),
      stepStart(1, 2),
      assistantMessage(1, 2, 'calls undo'),
    ])
    const first = computeUndoRange(session)
    expect(first).toEqual({ shadowedSeqs: [2], turn: 1, step: 1 })
    appendUndoMarker(session, first!.shadowedSeqs, 'test-provider', 'test-model')
    expect(computeUndoRange(session)).toBeUndefined()
  })
})

describe('appendUndoMarker', () => {
  it('replaces the step’s nodes with an invisible empty marker', () => {
    resetSeq()
    const session = createSession([
      stepStart(1, 1),
      userMessage(1, 1, 'fix it'),
      assistantMessage(1, 1, 'Let me read the file.'),
      toolResult(1, 1, 'call-1', 'file contents'),
      stepEnd(1, 1),
      stepStart(1, 2),
      assistantMessage(1, 2, 'calls undo'),
    ])
    const range = computeUndoRange(session)
    expect(range).toBeDefined()
    const marker = appendUndoMarker(session, range!.shadowedSeqs, 'test-provider', 'test-model')

    // The marker replaced nodes 2..3 and derives to nothing. Note the
    // constructor appends a `session/end-seed` event (seq 7), so the marker
    // lands at seq 8; the surface order is [user, marker, undo-call].
    expect(marker.data.message.content).toEqual([])
    expect(deriveEventMessage(marker)).toBeNull()
    expect(foldSurface(session.events).nodes).toEqual([1, marker.seq, 6])
    expect(session.deriveMessages().map(m => m.content[0])).toEqual([
      expect.objectContaining({ type: 'text', text: 'fix it' }),
      expect.objectContaining({ type: 'text', text: 'calls undo' }),
    ])
  })

  it('records every shadowed node in sourceEventSeqs', () => {
    resetSeq()
    const session = createSession([
      stepStart(1, 1),
      userMessage(1, 1, 'fix it'),
      assistantMessage(1, 1, 'a'),
      stepEnd(1, 1),
      stepStart(1, 2),
      assistantMessage(1, 2, 'calls undo'),
    ])
    const range = computeUndoRange(session)
    const marker = appendUndoMarker(session, range!.shadowedSeqs, 'p', 'm')
    expect(marker.sourceEventSeqs).toEqual([2])
  })
})

describe('appendRedoCopies', () => {
  it('restores fresh copies of the shadowed step at the surface tail', () => {
    resetSeq()
    const session = createSession([
      stepStart(1, 1),
      userMessage(1, 1, 'fix it'),
      assistantMessage(1, 1, 'Let me read the file.'),
      toolResult(1, 1, 'call-1', 'file contents'),
      stepEnd(1, 1),
      stepStart(1, 2),
      assistantMessage(1, 2, 'calls undo'),
    ])
    const range = computeUndoRange(session)
    const marker = appendUndoMarker(session, range!.shadowedSeqs, 'test-provider', 'test-model')
    expect(session.deriveMessages()).toHaveLength(2)

    const restored = appendRedoCopies(session, range!.shadowedSeqs)
    expect(restored).toBe(2)
    // Copies land right after the end-seed/marker events: marker + 1 and + 2.
    expect(foldSurface(session.events).nodes).toEqual([1, marker.seq, 6, marker.seq + 1, marker.seq + 2])
    const messages = session.deriveMessages()
    expect(messages).toHaveLength(4)
    expect(messages[2]?.content[0]).toEqual(expect.objectContaining({ type: 'text', text: 'Let me read the file.' }))
    // A tool-result message carries one tool-result block wrapping the text.
    expect(messages[3]?.content[0]).toEqual(expect.objectContaining({ type: 'tool-result' }))
    expect((messages[3]?.content[0] as { content: Array<{ text: string }> }).content[0]).toEqual(
      expect.objectContaining({ type: 'text', text: 'file contents' }),
    )
    // Fresh identities: the copies do not reuse the shadowed message ids.
    const originalAssistantId = (session.events[2] as SessionEvent<'assistant/message'>).data.message.id
    const copyAssistantId = (session.events[marker.seq + 1] as SessionEvent<'assistant/message'>).data.message.id
    expect(copyAssistantId).not.toBe(originalAssistantId)
  })

  it('restores an empty range as a no-op', () => {
    resetSeq()
    const session = createSession([stepStart(1, 1), stepEnd(1, 1)])
    expect(appendRedoCopies(session, [])).toBe(0)
  })
})
