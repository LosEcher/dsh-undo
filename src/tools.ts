/**
 * Model-facing `undo` and `redo` tools, registered in one exact agent scope.
 * @module dsh-undo
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { UndoRuntime } from './runtime.ts'
import type { RedoResult, UndoResult } from './types.ts'

const UNDO_DESCRIPTION =
  'Roll the conversation context back to the end of the last completed step: every '
  + 'assistant message and tool result of that step is removed from your visible context '
  + '(the durable log keeps them, and the redo tool restores them). Call this when the '
  + 'user asks you to undo, rewind, or roll back your latest action, or when you need to '
  + 'retry from a clean state. User messages are never removed. Returns nothing_to_undo '
  + 'when no step has completed yet.'

const REDO_DESCRIPTION =
  'Restore the messages that the most recent undo removed, re-adding them to your visible '
  + 'context exactly as they were. Call this when the user asks you to redo or restore '
  + 'what was just undone, or when an undo removed content you still need. Returns '
  + 'nothing_to_redo when there is nothing to restore (no undo happened, it was already '
  + 'redone, or new user input arrived).'

const ROLLED_BACK_VALUE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', required: true, const: 'rolled_back' },
    shadowedCount: { type: 'integer', required: true },
    markerSeq: { type: 'integer', required: true },
    turn: { type: 'integer', required: true },
    step: { type: 'integer', required: true },
    note: { type: 'string', required: true },
  },
} as const

const RESTORED_VALUE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', required: true, const: 'restored' },
    restoredCount: { type: 'integer', required: true },
    note: { type: 'string', required: true },
  },
} as const

const NOTHING_VALUE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', required: true, const: 'nothing_to_undo' },
  },
} as const

const ERROR_VALUE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', required: true, const: 'persistence_uncertain' },
    message: { type: 'string', required: true },
  },
} as const

const UNDO_OUTPUT_SCHEMA = {
  oneOf: [
    ROLLED_BACK_VALUE,
    NOTHING_VALUE,
    ERROR_VALUE,
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', required: true, const: 'internal_error' },
        message: { type: 'string', required: true },
      },
    },
  ],
} as const

const REDO_OUTPUT_SCHEMA = {
  oneOf: [
    RESTORED_VALUE,
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', required: true, const: 'nothing_to_redo' },
      },
    },
    ERROR_VALUE,
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', required: true, const: 'internal_error' },
        message: { type: 'string', required: true },
      },
    },
  ],
} as const

/** Deterministic model content for every canonical value. */
function renderValue(_args: unknown, value: unknown): ContentBlock[] {
  const text = JSON.stringify(value)
  return [{ type: 'text', text }]
}

/** Pure generic pending card. */
function present(title: string): GenericCallView {
  return { card: 'generic', title, kind: 'other' }
}

/**
 * Register the `undo` and `redo` tools in one exact agent scope.
 * @param rootCtx - Global service context owning sessions and durability.
 * @param toolCtx - Exact agent-scoped context receiving the definitions.
 * @param agent - Exact live agent whose session the tools mutate.
 * @param runtime - The agent's undo/redo runtime.
 * @returns Idempotent aggregate disposer for the two registrations.
 */
export function registerUndoTools(
  rootCtx: Context,
  toolCtx: Context,
  agent: Agent,
  runtime: UndoRuntime,
): () => void {
  const disposers: Array<() => void> = []

  try {
    disposers.push(toolCtx.tools.register(defineTool({
      name: 'undo',
      description: UNDO_DESCRIPTION,
      parameters: {},
      output: { schema: UNDO_OUTPUT_SCHEMA, render: renderValue },
      async execute(_args, exec): Promise<UndoResult> {
        if (exec.agent !== agent) {
          return { status: 'internal_error', message: 'The undo call did not target its owning agent.' }
        }
        return runtime.undo(exec.signal)
      },
      presentCall: () => present('Undo context'),
    })))

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'redo',
      description: REDO_DESCRIPTION,
      parameters: {},
      output: { schema: REDO_OUTPUT_SCHEMA, render: renderValue },
      async execute(_args, exec): Promise<RedoResult> {
        if (exec.agent !== agent) {
          return { status: 'internal_error', message: 'The redo call did not target its owning agent.' }
        }
        return runtime.redo(exec.signal)
      },
      presentCall: () => present('Redo context'),
    })))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }

  let active = true
  return () => {
    if (!active) return
    active = false
    for (const dispose of disposers.reverse()) dispose()
  }
}
