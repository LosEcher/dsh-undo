/**
 * Canonical value types of the dsh-undo tools.
 *
 * @module dsh-undo
 */

/**
 * Successful result of an `undo` call: the last completed step's model-visible
 * messages were shadowed out of the context.
 */
export interface UndoRolledBackValue {
  /** Stable discriminator. */
  readonly status: 'rolled_back'
  /** How many model-visible messages the rollback removed from the context. */
  readonly shadowedCount: number
  /** Seq of the empty `assistant/message` rewind marker event that shadows the step. */
  readonly markerSeq: number
  /** The completed step whose messages were rolled back. */
  readonly turn: number
  readonly step: number
  /** Human-readable account for the model. */
  readonly note: string
}

/** Successful result of a `redo` call: the last undone step's messages were restored. */
export interface RedoRestoredValue {
  /** Stable discriminator. */
  readonly status: 'restored'
  /** How many model-visible messages were restored into the context. */
  readonly restoredCount: number
  /** Human-readable account for the model. */
  readonly note: string
}

/** A closed, non-error outcome for `undo`: no step was left to roll back. */
export interface UndoNoopValue {
  readonly status: 'nothing_to_undo'
}

/** A closed, non-error outcome for `redo`: nothing was left to restore. */
export interface RedoNoopValue {
  readonly status: 'nothing_to_redo'
}

/** The session log could not be proven durable; the operation may or may not have applied. */
export interface UndoUncertainValue {
  readonly status: 'persistence_uncertain'
  /** Instruction for the model. */
  readonly message: string
}

/** The operation failed while mutating the session log. */
export interface UndoInternalErrorValue {
  readonly status: 'internal_error'
  readonly message: string
}

/** The closed value union an `undo` call returns. */
export type UndoResult =
  | UndoRolledBackValue
  | UndoNoopValue
  | UndoUncertainValue
  | UndoInternalErrorValue

/** The closed value union a `redo` call returns. */
export type RedoResult =
  | RedoRestoredValue
  | RedoNoopValue
  | UndoUncertainValue
  | UndoInternalErrorValue

/** Stable account for an uncertainty failure, shared by both tools. */
export const PERSISTENCE_UNCERTAIN_MESSAGE =
  'Undo persistence is uncertain; check the session log before relying on this result.'

/** Stable account for an append failure, shared by both tools. */
export const INTERNAL_ERROR_MESSAGE = 'The undo/redo operation failed to update the session log.'
