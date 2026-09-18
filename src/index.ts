/**
 * dsh-undo: user-side undo/redo for DeepSeek Harness. Registers the `/undo`
 * and `/redo` slash commands (never sent to the model): `/undo` rewinds one
 * real user turn from model context and restores its workspace changes, while
 * the durable log keeps every rolled-back event for `/redo`.
 *
 * @module dsh-undo
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session'
import { UndoRuntime } from './runtime.ts'
import type { UndoTarget } from './runtime.ts'
import { WorkspaceUndoTracker } from './workspace.ts'

export { UndoRuntime } from './runtime.ts'
export type { UndoTarget } from './runtime.ts'
export {
  activeRewindSeqs,
  appendSurfaceRestore,
  appendSurfaceRewind,
  computeUndoRange,
  lastVisibleMessage,
  lastVisibleText,
  supportsSurfaceRewind,
  turnForAssistantMessage,
  userSeqForTurn,
  type LastVisibleMessage,
  type UndoRange,
} from './domain.ts'
export { flushUndoPersistence, UndoPersistenceError } from './persistence.ts'
export { WorkspaceUndoTracker, type WorkspaceOperationResult } from './workspace.ts'

/** Cordis function-plugin name. */
export const name = 'undo'
/** Services required before the undo/redo commands can work. */
export const inject = ['commands', 'agents', 'sessions', 'tools']

/** Accepted `/undo` argument forms, used for usage copy and the command hint. */
export const UNDO_USAGE = '/undo | /undo <用户消息 seq> | /undo turn:<轮次> | /undo message:<助手消息 id>'

/**
 * Parse one `/undo` argument. The bare form targets the latest user input; the
 * `turn:` and `message:` forms are what the Web UI sends, because the model-facing
 * surface exposes Turn identity and durable message ids rather than raw seqs.
 * @param raw - trimmed raw command input.
 * @returns the parsed target, or `undefined` when the form is not accepted.
 */
export function parseUndoTarget(raw: string): UndoTarget | undefined {
  if (raw === '') return { kind: 'latest' }
  if (/^\d+$/.test(raw)) {
    const seq = Number(raw)
    return Number.isSafeInteger(seq) ? { kind: 'user-seq', seq } : undefined
  }
  const turn = /^turn:(\d+)$/i.exec(raw)
  if (turn !== null) {
    const parsed = Number(turn[1])
    return Number.isSafeInteger(parsed) ? { kind: 'turn', turn: parsed } : undefined
  }
  const message = /^message:(\S+)$/i.exec(raw)
  if (message !== null && message[1] !== '') return { kind: 'message', messageId: message[1] as string }
  return undefined
}

/**
 * Install the global `/undo` and `/redo` commands for every agent.
 * Per-agent runtimes are created lazily on first use.
 */
export function apply(ctx: Context): void {
  const runtimes = new WeakMap<Agent, UndoRuntime>()
  const workspaces = new WeakMap<Agent, WorkspaceUndoTracker>()

  const workspaceFor = (agent: Agent): WorkspaceUndoTracker => {
    let tracker = workspaces.get(agent)
    if (tracker === undefined) {
      tracker = new WorkspaceUndoTracker(ctx, agent)
      workspaces.set(agent, tracker)
    }
    return tracker
  }

  const runtimeFor = (agent: Agent): UndoRuntime => {
    let runtime = runtimes.get(agent)
    if (runtime === undefined) {
      runtime = new UndoRuntime(ctx, agent, workspaceFor(agent))
      runtimes.set(agent, runtime)
    }
    return runtime
  }

  ctx.effect(() => {
    const disposeWorkspace = ctx.on('tools/execute', (exec, next) =>
      exec.agent === undefined ? next() : workspaceFor(exec.agent).around(exec, next))
    const disposeUndo = ctx.commands.register({
      name: 'undo',
      description: 'Remove the latest user turn from model context (/redo restores it)',
      input: { hint: 'latest | <用户消息 seq> | turn:<轮次> | message:<助手消息 id>' },
      handler: async (invocation) => {
        const target = parseUndoTarget(invocation.rawInput.trim())
        if (target === undefined) return { kind: 'error', text: `用法：${UNDO_USAGE}。` }
        return runtimeFor(invocation.agent).undo(invocation.signal, target)
      },
    })
    const disposeRedo = ctx.commands.register({
      name: 'redo',
      description: 'Restore the messages the most recent /undo removed',
      handler: async (invocation) => runtimeFor(invocation.agent).redo(invocation.signal),
    })
    return () => {
      disposeWorkspace()
      disposeUndo()
      disposeRedo()
    }
  }, 'undo.commands()')
}
