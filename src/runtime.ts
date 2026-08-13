/**
 * Per-agent undo/redo runtime: owns the process-local redo stack and applies
 * rollback/restore operations to the agent's session log.
 *
 * The undo history is process-local by design (like a browser's undo stack):
 * the LOG stays consistent across restarts (markers remain shadowed, copies
 * remain restored), but the redo stack itself is not persisted.
 *
 * @module dsh-undo
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  appendRedoCopies,
  appendUndoMarker,
  computeUndoRange,
  type RedoEntry,
} from './domain.ts'
import { flushUndoPersistence } from './persistence.ts'
import {
  INTERNAL_ERROR_MESSAGE,
  PERSISTENCE_UNCERTAIN_MESSAGE,
  type RedoResult,
  type UndoResult,
} from './types.ts'
/** Stable model account for a completed rollback. */
function rolledBackNote(range: { readonly turn: number; readonly step: number }, count: number): string {
  return `Rolled back ${count} message(s) from turn ${range.turn}, step ${range.step}. `
    + 'The context now ends before that step; the rolled-back messages stay in the durable log and can be restored with redo.'
}

/** Stable model account for a completed restore. */
function restoredNote(count: number): string {
  return `Restored ${count} message(s) that the most recent undo had removed.`
}

/**
 * One live root agent's undo/redo state and operations. Registered through the
 * agent's scoped context; disposed together with the agent.
 */
export class UndoRuntime {
  /** Redoable rollbacks in undo order (LIFO). Not persisted. */
  readonly redoStack: RedoEntry[] = []

  constructor(
    private readonly rootCtx: Context,
    private readonly agent: Agent,
  ) {}

  /**
   * Model-source identity recorded on rewind markers. The agent's own route
   * when configured; a stable placeholder otherwise (markers are invisible to
   * the model, so the identity is purely archival).
   */
  private markerSource(): { provider: string; model: string } {
    return {
      provider: this.agent.options.provider ?? 'dsh-undo',
      model: this.agent.options.model ?? 'undo-marker',
    }
  }

  /**
   * Invalidate the redo stack when a new user-role message enters the surface:
   * ordinary undo/redo semantics say fresh input makes undone work unreachable.
   * Assistant/tool appends do NOT invalidate (the undo/redo tools' own calls,
   * results, and redo copies all append those event types).
   * @returns the exact disposer.
   */
  installInvalidation(): () => void {
    return this.agent.ctx.on('session/event', (_session, event) => {
      if (event.type === 'user/message' && event.surfaceOp === 'append') {
        this.redoStack.length = 0
      }
    })
  }

  /**
   * Roll the context back to the end of the last completed step.
   * @param signal - caller cancellation; observed at operation boundaries.
   * @returns the closed canonical value.
   */
  async undo(signal: AbortSignal): Promise<UndoResult> {
    if (signal.aborted) {
      return { status: 'internal_error', message: 'The undo call was cancelled before it ran.' }
    }
    try {
      await flushUndoPersistence(this.rootCtx, this.agent.session)
    } catch {
      return { status: 'persistence_uncertain', message: PERSISTENCE_UNCERTAIN_MESSAGE }
    }
    const range = computeUndoRange(this.agent.session)
    if (range === undefined) return { status: 'nothing_to_undo' }
    if (signal.aborted) {
      return { status: 'internal_error', message: 'The undo call was cancelled before it committed.' }
    }
    let markerSeq: number
    try {
      const { provider, model } = this.markerSource()
      markerSeq = appendUndoMarker(this.agent.session, range.shadowedSeqs, provider, model).seq
    } catch (error: unknown) {
      this.rootCtx.logger.warn(`undo: marker append failed: ${error instanceof Error ? error.message : String(error)}`)
      return { status: 'internal_error', message: INTERNAL_ERROR_MESSAGE }
    }
    // The stack mirrors the in-session state (the marker is already applied);
    // the durability barrier below only decides how confidently we report it.
    this.redoStack.push({ shadowedSeqs: [...range.shadowedSeqs] })
    try {
      await flushUndoPersistence(this.rootCtx, this.agent.session)
    } catch {
      return { status: 'persistence_uncertain', message: PERSISTENCE_UNCERTAIN_MESSAGE }
    }
    return {
      status: 'rolled_back',
      shadowedCount: range.shadowedSeqs.length,
      markerSeq,
      turn: range.turn,
      step: range.step,
      note: rolledBackNote(range, range.shadowedSeqs.length),
    }
  }

  /**
   * Restore the most recently undone step by re-appending fresh copies of its
   * shadowed messages.
   * @param signal - caller cancellation; observed at operation boundaries.
   * @returns the closed canonical value.
   */
  async redo(signal: AbortSignal): Promise<RedoResult> {
    if (signal.aborted) {
      return { status: 'internal_error', message: 'The redo call was cancelled before it ran.' }
    }
    const entry = this.redoStack[this.redoStack.length - 1]
    if (entry === undefined) return { status: 'nothing_to_redo' }
    try {
      await flushUndoPersistence(this.rootCtx, this.agent.session)
    } catch {
      return { status: 'persistence_uncertain', message: PERSISTENCE_UNCERTAIN_MESSAGE }
    }
    if (signal.aborted) {
      return { status: 'internal_error', message: 'The redo call was cancelled before it committed.' }
    }
    let restoredCount: number
    try {
      restoredCount = appendRedoCopies(this.agent.session, entry.shadowedSeqs)
    } catch (error: unknown) {
      this.rootCtx.logger.warn(`undo: redo append failed: ${error instanceof Error ? error.message : String(error)}`)
      return { status: 'internal_error', message: INTERNAL_ERROR_MESSAGE }
    }
    // The copies are already in the session; pop so a retry cannot duplicate
    // them, then confirm durability.
    this.redoStack.pop()
    try {
      await flushUndoPersistence(this.rootCtx, this.agent.session)
    } catch {
      return { status: 'persistence_uncertain', message: PERSISTENCE_UNCERTAIN_MESSAGE }
    }
    return { status: 'restored', restoredCount, note: restoredNote(restoredCount) }
  }
}
