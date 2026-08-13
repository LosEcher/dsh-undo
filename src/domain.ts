/**
 * Pure undo/redo domain logic over the session event log and surface.
 *
 * The session log is append-only, so "undo" never deletes events. Instead it
 * appends one empty-content `assistant/message` marker whose surface
 * `replace` op shadows the target step's model-visible nodes; empty-content
 * assistant messages derive to nothing, so the model context is exactly the
 * pre-step context. "Redo" re-appends fresh copies of the shadowed events as
 * ordinary surface appends, restoring the step's messages.
 *
 * @module dsh-undo
 */

import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/** The completed step whose model-visible messages an undo will shadow. */
export interface UndoRange {
  /** Surface node seqs to shadow, in surface order. */
  readonly shadowedSeqs: readonly number[]
  /** The completed step the range belongs to. */
  readonly turn: number
  readonly step: number
}

/** One redoable rollback: the seqs of the messages the marker shadowed. */
export interface RedoEntry {
  /** Surface node seqs the associated undo marker shadowed, in surface order. */
  readonly shadowedSeqs: readonly number[]
}

/**
 * Locate the most recently ENDED step from the log, if any.
 * @param events - the session event log.
 * @returns the last `step/end`'s coordinates, or undefined when no step has completed.
 */
export function lastCompletedStep(
  events: readonly SessionEvent[],
): { readonly turn: number; readonly step: number } | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type === 'step/end') {
      return { turn: event.data.turn, step: event.data.step }
    }
  }
  return undefined
}

/**
 * Locate the currently OPEN step from the log, if any — the step the undo/redo
 * tool itself is executing in.
 * @param events - the session event log.
 * @returns the last `step/start`'s coordinates, or undefined when no step is open.
 */
export function currentStep(
  events: readonly SessionEvent[],
): { readonly turn: number; readonly step: number } | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type === 'step/start') {
      return { turn: event.data.turn, step: event.data.step }
    }
  }
  return undefined
}

/**
 * Compute the undo range: the model-visible surface nodes of the newest
 * completed step that still has visible assistant/tool nodes, excluding
 * user-role messages (a user prompt is never rolled back). Steps whose nodes
 * were already shadowed by an earlier undo (or a compaction replacement) are
 * skipped, so repeated undos walk back one step at a time. The current step's
 * own messages are never included because the range is anchored at steps that
 * have already ended.
 * @param session - the live session.
 * @returns the range, or undefined when no undoable step remains.
 */
export function computeUndoRange(session: Session): UndoRange | undefined {
  const events = session.events
  const visibleByStep = new Map<string, number[]>()
  for (const seq of session.surface.nodes) {
    const event = events[seq]
    if (event === undefined) continue
    if (event.type === 'user/message') continue
    if (event.type === 'assistant/message' || event.type === 'tool/result') {
      const key = `${event.data.turn}:${event.data.step}`
      const seqs = visibleByStep.get(key)
      if (seqs === undefined) visibleByStep.set(key, [seq])
      else seqs.push(seq)
    }
  }
  // Walk step/end events from the newest; the first whose step still has
  // visible nodes is the undoable step. A step/end whose nodes were shadowed
  // by a previous undo must not block the next undo.
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== 'step/end') continue
    const seqs = visibleByStep.get(`${event.data.turn}:${event.data.step}`)
    if (seqs !== undefined && seqs.length > 0) {
      return { shadowedSeqs: seqs, turn: event.data.turn, step: event.data.step }
    }
  }
  return undefined
}

/**
 * Roll the context back to before the given surface nodes by appending one
 * empty-content `assistant/message` marker that replaces them on the surface.
 * Empty assistant content derives to no message, so the marker is invisible in
 * the model context while the log keeps every shadowed event for `redo`.
 * @param session - the live session.
 * @param shadowedSeqs - the surface node seqs to shadow, in surface order (non-empty, contiguous).
 * @param provider - provider route recorded on the marker's model source.
 * @param model - model id recorded on the marker's model source.
 * @returns the appended marker event.
 */
export function appendUndoMarker(
  session: Session,
  shadowedSeqs: readonly number[],
  provider: string,
  model: string,
): SessionEvent<'assistant/message'> {
  const first = shadowedSeqs[0]
  const last = shadowedSeqs[shadowedSeqs.length - 1]
  if (first === undefined || last === undefined) {
    throw new Error('undo marker requires a non-empty shadowed range')
  }
  const step = currentStep(session.events)
  const message = createAssistantMessage({
    content: [],
    source: { provider, model },
  })
  return session.append(
    'assistant/message',
    {
      turn: step?.turn ?? 0,
      step: step?.step ?? 0,
      message,
    },
    {
      surfaceOp: { op: 'replace', start: first, end: last },
      sourceEventSeqs: [...shadowedSeqs],
    },
  )
}

/**
 * Restore one undone step by re-appending fresh copies of its shadowed events
 * as ordinary surface appends. Message identities are re-minted (the shadowed
 * originals keep theirs); tool results keep their call correlation so the
 * assistant tool-call → tool-result adjacency in the transcript is preserved.
 * @param session - the live session.
 * @param seqs - the shadowed node seqs to restore, in surface order.
 * @returns how many events were restored.
 */
export function appendRedoCopies(session: Session, seqs: readonly number[]): number {
  const events = session.events
  let restored = 0
  for (const seq of seqs) {
    const source = events[seq]
    if (source === undefined) continue
    switch (source.type) {
      case 'assistant/message': {
        const message = createAssistantMessage({
          content: source.data.message.content,
          source: {
            provider: source.data.message.source.provider,
            model: source.data.message.source.model,
          },
        })
        session.append(
          'assistant/message',
          { turn: source.data.turn, step: source.data.step, message },
          { surfaceOp: 'append' },
        )
        restored += 1
        break
      }
      case 'tool/result': {
        const block = source.data.message.content[0]
        const message = createToolResultMessage({
          callId: source.data.message.source.callId,
          content: block.content,
          isError: block.isError ?? false,
        })
        session.append(
          'tool/result',
          { turn: source.data.turn, step: source.data.step, message },
          { surfaceOp: 'append' },
        )
        restored += 1
        break
      }
      case 'user/message': {
        // Defensive: undo ranges never include user-role nodes, but a future
        // caller may pass one; restore it rather than dropping the content.
        const message = createUserMessage({
          content: source.data.content,
          source: source.data.source,
        })
        session.append('user/message', message, { surfaceOp: 'append' })
        restored += 1
        break
      }
      default:
        // Log-only events never enter the surface and are not copied.
        break
    }
  }
  return restored
}
