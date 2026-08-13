import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { WorkspaceUndoTracker } from '../src/workspace.ts'
import { INTERNAL_ERROR_TEXT, UndoRuntime } from '../src/runtime.ts'

function context(): Context {
  return {
    logger: { warn: vi.fn() },
    sessions: { flush: vi.fn(async () => true) },
  } as unknown as Context
}

function agent(activeRewinds: number[] = []): Agent {
  const events = [{
    seq: 0,
    type: 'user/message',
    data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text: 'change it' }] } },
  }]
  return {
    session: {
      seq: 1,
      events,
      surface: { nodes: [0], activeRewinds },
      append: vi.fn(() => { throw new Error('surface failure') }),
      deriveEventMessage: vi.fn(() => ({ content: [{ type: 'text', text: 'change it' }] })),
    },
    runMaintenance: vi.fn(async (operation: (signal: AbortSignal) => Promise<unknown>) =>
      operation(new AbortController().signal)),
  } as unknown as Agent
}

describe('UndoRuntime workspace compensation', () => {
  it('restores workspace changes when the surface rewind fails', async () => {
    const workspace = {
      undo: vi.fn(async () => ({ files: 1 })),
      reconcile: vi.fn(async () => undefined),
      rollbackUndo: vi.fn(async () => undefined),
      killJobs: vi.fn(() => 0),
    } as unknown as WorkspaceUndoTracker
    const result = await new UndoRuntime(context(), agent(), workspace)
      .undo(new AbortController().signal)

    expect(result).toEqual({ kind: 'error', text: INTERNAL_ERROR_TEXT })
    expect(workspace.undo).toHaveBeenCalledWith([0], 1)
    expect(workspace.rollbackUndo).toHaveBeenCalledWith(1)
    expect(workspace.killJobs).not.toHaveBeenCalled()
  })

  it('rolls back workspace redo when the surface restore fails', async () => {
    const workspace = {
      redo: vi.fn(async () => ({ files: 1 })),
      reconcile: vi.fn(async () => undefined),
      rollbackRedo: vi.fn(async () => undefined),
      commitRedo: vi.fn(async () => undefined),
    } as unknown as WorkspaceUndoTracker
    const result = await new UndoRuntime(context(), agent([7]), workspace)
      .redo(new AbortController().signal)

    expect(result).toEqual({ kind: 'error', text: INTERNAL_ERROR_TEXT })
    expect(workspace.redo).toHaveBeenCalledWith(7)
    expect(workspace.rollbackRedo).toHaveBeenCalledWith(7)
    expect(workspace.commitRedo).not.toHaveBeenCalled()
  })
})
