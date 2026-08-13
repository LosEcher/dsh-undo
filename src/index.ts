/**
 * dsh-undo: context undo/redo for DeepSeek Harness agents. The `undo` tool
 * rolls the model context back to the end of the last completed step (the
 * durable log keeps every rolled-back event); `redo` restores them.
 *
 * @module dsh-undo
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import { UndoRuntime } from './runtime.ts'
import { registerUndoTools } from './tools.ts'

export type * from './types.ts'
export { UndoRuntime } from './runtime.ts'
export { registerUndoTools } from './tools.ts'
export {
  appendRedoCopies,
  appendUndoMarker,
  computeUndoRange,
  currentStep,
  lastCompletedStep,
  type RedoEntry,
  type UndoRange,
} from './domain.ts'
export { flushUndoPersistence, UndoPersistenceError } from './persistence.ts'

/** Cordis function-plugin name. */
export const name = 'undo'
/** Services required before agents can receive undo/redo. */
export const inject = ['agents', 'sessions', 'tools']

type OwnerCleanup = () => void | Promise<void>

/** Install undo/redo only for root agents published after this plugin loads. */
export function apply(ctx: Context): void {
  const runtimes = new Map<Agent, OwnerCleanup>()
  let stopping = false

  ctx.effect(() => {
    const stopCreated = ctx.on('agent/created', ({ agent }) => {
      if (stopping || runtimes.has(agent) || !ctx.agents.roots().includes(agent)) return
      const runtime = new UndoRuntime(ctx, agent)
      const cleanup: OwnerCleanup = agent.ctx.effect(() => {
        const disposeTools = registerUndoTools(ctx, agent.ctx, agent, runtime)
        const disposeInvalidation = runtime.installInvalidation()
        return async () => {
          disposeInvalidation()
          disposeTools()
          if (runtimes.get(agent) === cleanup) runtimes.delete(agent)
        }
      }, 'undo.runtime()')
      runtimes.set(agent, cleanup)
    })

    return async () => {
      stopping = true
      stopCreated()
      const cleanups = [...runtimes.values()]
      runtimes.clear()
      await Promise.allSettled(cleanups.map(cleanup => Promise.resolve(cleanup())))
    }
  }, 'undo.lifecycle()')
}
