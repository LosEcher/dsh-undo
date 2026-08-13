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
import { WorkspaceUndoTracker } from './workspace.ts'

export { UndoRuntime } from './runtime.ts'
export {
  activeRewindSeqs,
  appendSurfaceRestore,
  appendSurfaceRewind,
  computeUndoRange,
  lastVisibleMessage,
  lastVisibleText,
  supportsSurfaceRewind,
  type LastVisibleMessage,
  type UndoRange,
} from './domain.ts'
export { flushUndoPersistence, UndoPersistenceError } from './persistence.ts'
export { WorkspaceUndoTracker, type WorkspaceOperationResult } from './workspace.ts'

/** Cordis function-plugin name. */
export const name = 'undo'
/** Services required before the undo/redo commands can work. */
export const inject = ['commands', 'agents', 'sessions', 'tools']

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
      input: { hint: 'optional user message seq' },
      handler: async (invocation) => {
        const raw = invocation.rawInput.trim()
        if (raw !== '' && !/^\d+$/.test(raw)) {
          return { kind: 'error', text: '用法：/undo 或 /undo <用户消息 seq>。' }
        }
        return runtimeFor(invocation.agent).undo(
          invocation.signal,
          raw === '' ? undefined : Number(raw),
        )
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
