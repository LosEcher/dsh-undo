import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { WorkspaceUndoTracker } from '../src/workspace.ts'

const execFileAsync = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{
  root: string
  file: string
  userSeq: number
  tracker: WorkspaceUndoTracker
  exec: ToolDispatchExecution
  agent: Agent
  ctx: Context
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-undo-workspace-'))
  roots.push(root)
  await execFileAsync('git', ['init', root])
  const file = join(root, 'tracked.txt')
  await writeFile(file, 'before\n')

  const id = SessionId(`workspace-${Date.now()}`)
  const session = Session.create(id, undefined, {
    version: 0,
    id,
    createdAt: Date.now(),
    cwd: root,
  })
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const userSeq = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'change it' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
  const callId = CallId('workspace-call')
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'write', arguments: '{}' })

  const agent = { session } as Agent
  const ctx = { logger: { warn: () => undefined } } as unknown as Context
  const tracker = new WorkspaceUndoTracker(ctx, agent)
  const exec = {
    callId,
    rootCallId: callId,
    name: 'write',
    arguments: {},
    agent,
    signal: new AbortController().signal,
    token: Symbol('tool'),
  } as unknown as ToolDispatchExecution
  return { root, file, userSeq, tracker, exec, agent, ctx }
}

function missing(path: string): Promise<boolean> {
  return access(path).then(() => false, () => true)
}

const success: ToolExecutionResult = {
  isError: false,
  value: null,
  content: [],
}

describe('WorkspaceUndoTracker', () => {
  it('round-trips modified files through undo and redo', async () => {
    const { file, userSeq, tracker, exec } = await fixture()
    expect((tracker as unknown as { userSeqForCall(callId: string): number | undefined })
      .userSeqForCall(String(exec.rootCallId))).toBe(userSeq)
    await tracker.around(exec, async () => {
      await writeFile(file, 'after\n')
      return success
    })

    const undone = await tracker.undo([userSeq], 99)
    expect(undone.files).toBe(1)
    expect(await readFile(file, 'utf8')).toBe('before\n')
    expect((await tracker.redo(99)).files).toBe(1)
    expect(await readFile(file, 'utf8')).toBe('after\n')
    await tracker.commitRedo(99)
  })

  it('records file side effects even when the tool throws', async () => {
    const { file, userSeq, tracker, exec } = await fixture()
    expect((tracker as unknown as { userSeqForCall(callId: string): number | undefined })
      .userSeqForCall(String(exec.rootCallId))).toBe(userSeq)
    await expect(tracker.around(exec, async () => {
      await writeFile(file, 'partial\n')
      throw new Error('tool failed')
    })).rejects.toThrow('tool failed')

    const undone = await tracker.undo([userSeq], 100)
    expect(undone.files).toBe(1)
    expect(await readFile(file, 'utf8')).toBe('before\n')
  })

  it('round-trips created and deleted files', async () => {
    const { root, file, userSeq, tracker, exec } = await fixture()
    const created = join(root, 'created.txt')
    await tracker.around(exec, async () => {
      await rm(file)
      await writeFile(created, 'created\n')
      return success
    })

    expect((await tracker.undo([userSeq], 101)).files).toBe(2)
    expect(await readFile(file, 'utf8')).toBe('before\n')
    expect(await missing(created)).toBe(true)
    expect((await tracker.redo(101)).files).toBe(2)
    expect(await missing(file)).toBe(true)
    expect(await readFile(created, 'utf8')).toBe('created\n')
    await tracker.commitRedo(101)
  })

  it('treats restore filenames as literal pathspecs', async () => {
    const { root, userSeq, tracker, exec } = await fixture()
    const magic = join(root, 'file[1].txt')
    const sibling = join(root, 'file1.txt')
    await writeFile(magic, 'magic-before\n')
    await writeFile(sibling, 'sibling-before\n')
    await tracker.around(exec, async () => {
      await writeFile(magic, 'magic-after\n')
      return success
    })
    await writeFile(sibling, 'sibling-user-change\n')

    expect((await tracker.undo([userSeq], 110)).files).toBe(1)
    expect(await readFile(magic, 'utf8')).toBe('magic-before\n')
    expect(await readFile(sibling, 'utf8')).toBe('sibling-user-change\n')
  })

  it('restores the earliest state when several tools change the same file', async () => {
    const { file, userSeq, tracker, exec, agent } = await fixture()
    await tracker.around(exec, async () => {
      await writeFile(file, 'first\n')
      return success
    })
    const secondId = CallId('workspace-call-2')
    agent.session.append('tool/call', { turn: 1, step: 1, callId: secondId, name: 'write', arguments: '{}' })
    const secondExec = { ...exec, callId: secondId, rootCallId: secondId } as ToolDispatchExecution
    await tracker.around(secondExec, async () => {
      await writeFile(file, 'second\n')
      return success
    })

    expect((await tracker.undo([userSeq], 102)).files).toBe(1)
    expect(await readFile(file, 'utf8')).toBe('before\n')
    await tracker.redo(102)
    expect(await readFile(file, 'utf8')).toBe('second\n')
    await tracker.commitRedo(102)
  })

  it('restores files changed by parallel tools in the same user turn', async () => {
    const { root, userSeq, tracker, exec, agent } = await fixture()
    const first = join(root, 'parallel-a.txt')
    const second = join(root, 'parallel-b.txt')
    const secondId = CallId('workspace-parallel-call')
    agent.session.append('tool/call', { turn: 1, step: 1, callId: secondId, name: 'write', arguments: '{}' })
    const secondExec = { ...exec, callId: secondId, rootCallId: secondId } as ToolDispatchExecution
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    await Promise.all([
      tracker.around(exec, async () => {
        await gate
        await writeFile(first, 'a\n')
        return success
      }),
      tracker.around(secondExec, async () => {
        await writeFile(second, 'b\n')
        release?.()
        return success
      }),
    ])

    expect((await tracker.undo([userSeq], 109)).files).toBe(2)
    expect(await missing(first)).toBe(true)
    expect(await missing(second)).toBe(true)
  })

  it('leaves ignored and oversized untracked files untouched', async () => {
    const { root, file, userSeq, tracker, exec } = await fixture()
    const ignored = join(root, 'ignored.txt')
    const large = join(root, 'large.bin')
    await writeFile(join(root, '.gitignore'), 'ignored.txt\n')
    await tracker.around(exec, async () => {
      await writeFile(file, 'after\n')
      await writeFile(ignored, 'ignored\n')
      await writeFile(large, Buffer.alloc(2 * 1024 * 1024 + 1, 1))
      return success
    })

    expect((await tracker.undo([userSeq], 103)).files).toBe(1)
    expect(await readFile(file, 'utf8')).toBe('before\n')
    expect(await readFile(ignored, 'utf8')).toBe('ignored\n')
    expect((await readFile(large)).byteLength).toBe(2 * 1024 * 1024 + 1)
  })

  it('does not restore a captured file after it becomes ignored', async () => {
    const { root, userSeq, tracker, exec, agent } = await fixture()
    const ignored = join(root, 'later-ignored.txt')
    await tracker.around(exec, async () => {
      await writeFile(ignored, 'first\n')
      return success
    })
    const secondId = CallId('workspace-ignore-call')
    agent.session.append('tool/call', { turn: 1, step: 1, callId: secondId, name: 'write', arguments: '{}' })
    await tracker.around({ ...exec, callId: secondId, rootCallId: secondId } as ToolDispatchExecution, async () => {
      await writeFile(join(root, '.gitignore'), 'later-ignored.txt\n')
      await writeFile(ignored, 'ignored-change\n')
      return success
    })

    await tracker.undo([userSeq], 108)
    expect(await readFile(ignored, 'utf8')).toBe('ignored-change\n')
  })

  it('loads workspace redo state in a new tracker instance', async () => {
    const { file, userSeq, tracker, exec, agent, ctx } = await fixture()
    await tracker.around(exec, async () => {
      await writeFile(file, 'after\n')
      return success
    })
    await tracker.undo([userSeq], 104)

    const restarted = new WorkspaceUndoTracker(ctx, agent)
    expect((await restarted.redo(104)).files).toBe(1)
    expect(await readFile(file, 'utf8')).toBe('after\n')
    await restarted.commitRedo(104)
  })

  it('compensates an undo journal when no durable rewind exists', async () => {
    const { file, userSeq, tracker, exec, agent, ctx } = await fixture()
    await tracker.around(exec, async () => {
      await writeFile(file, 'after\n')
      return success
    })
    await tracker.undo([userSeq], 111)
    expect(await readFile(file, 'utf8')).toBe('before\n')

    await new WorkspaceUndoTracker(ctx, agent).reconcile()
    expect(await readFile(file, 'utf8')).toBe('after\n')
  })

  it('completes an undo journal when the durable rewind exists', async () => {
    const { file, userSeq, tracker, exec, agent, ctx } = await fixture()
    await tracker.around(exec, async () => {
      await writeFile(file, 'after\n')
      return success
    })
    await tracker.undo([userSeq], 112)
    ;(agent.session.surface as unknown as { activeRewinds: number[] }).activeRewinds = [112]
    await new WorkspaceUndoTracker(ctx, agent).reconcile()

    expect(await readFile(file, 'utf8')).toBe('before\n')
  })

  it('preserves work that diverged after an interrupted undo', async () => {
    const { file, userSeq, tracker, exec, agent, ctx } = await fixture()
    await tracker.around(exec, async () => {
      await writeFile(file, 'after\n')
      return success
    })
    await tracker.undo([userSeq], 115)
    await writeFile(file, 'new-work\n')

    await new WorkspaceUndoTracker(ctx, agent).reconcile()
    expect(await readFile(file, 'utf8')).toBe('new-work\n')
  })

  it('rolls back an uncommitted redo and keeps it retryable', async () => {
    const { file, userSeq, tracker, exec } = await fixture()
    await tracker.around(exec, async () => {
      await writeFile(file, 'after\n')
      return success
    })
    await tracker.undo([userSeq], 107)
    await tracker.redo(107)
    expect(await readFile(file, 'utf8')).toBe('after\n')

    await tracker.rollbackRedo(107)
    expect(await readFile(file, 'utf8')).toBe('before\n')
    expect((await tracker.redo(107)).files).toBe(1)
    expect(await readFile(file, 'utf8')).toBe('after\n')
  })

  it('compensates a redo journal while the durable rewind remains active', async () => {
    const { file, userSeq, tracker, exec, agent, ctx } = await fixture()
    await tracker.around(exec, async () => {
      await writeFile(file, 'after\n')
      return success
    })
    await tracker.undo([userSeq], 113)
    ;(agent.session.surface as unknown as { activeRewinds: number[] }).activeRewinds = [113]
    await tracker.commitUndo(113)
    await tracker.redo(113)
    expect(await readFile(file, 'utf8')).toBe('after\n')

    await new WorkspaceUndoTracker(ctx, agent).reconcile()
    expect(await readFile(file, 'utf8')).toBe('before\n')
  })

  it('completes a redo journal after the durable rewind is restored', async () => {
    const { file, userSeq, tracker, exec, agent, ctx } = await fixture()
    await tracker.around(exec, async () => {
      await writeFile(file, 'after\n')
      return success
    })
    await tracker.undo([userSeq], 114)
    ;(agent.session.surface as unknown as { activeRewinds: number[] }).activeRewinds = [114]
    await tracker.commitUndo(114)
    await tracker.redo(114)
    ;(agent.session.surface as unknown as { activeRewinds: number[] }).activeRewinds = []

    await new WorkspaceUndoTracker(ctx, agent).reconcile()
    expect(await readFile(file, 'utf8')).toBe('after\n')
  })

  it('isolates hidden snapshot state by session', async () => {
    const { file, userSeq, tracker, exec, agent, ctx } = await fixture()
    await tracker.around(exec, async () => {
      await writeFile(file, 'after\n')
      return success
    })
    const otherId = SessionId(`other-${Date.now()}`)
    const otherSession = Session.create(otherId, undefined, { ...agent.session.header, id: otherId })
    const other = new WorkspaceUndoTracker(ctx, { session: otherSession } as Agent)

    expect((await other.undo([userSeq], 105)).files).toBe(0)
    expect(await readFile(file, 'utf8')).toBe('after\n')
  })

  it('degrades to context-only undo outside a Git workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-undo-non-git-'))
    roots.push(root)
    const id = SessionId(`non-git-${Date.now()}`)
    const session = Session.create(id, undefined, { version: 0, id, createdAt: Date.now(), cwd: root })
    const tracker = new WorkspaceUndoTracker({ logger: { warn: () => undefined } } as unknown as Context, { session } as Agent)

    const result = await tracker.undo([], 106)
    expect(result.files).toBe(0)
    expect(result.warning).toContain('仅撤销模型上下文')
  })

  it('records and stops background jobs for the selected user turn', async () => {
    const { userSeq, tracker, exec, agent } = await fixture()
    const calls: unknown[][] = []
    const context = (tracker as unknown as { ctx: Context }).ctx
    context.get = () => ({
      kill: (...args: unknown[]) => {
        calls.push(args)
        return 'requested'
      },
    })
    await tracker.around(exec, async () => ({
      isError: false,
      value: { kind: 'background', jobId: 'bash-1' },
      content: [],
    }))

    expect(tracker.killJobs([userSeq])).toBe(1)
    expect(calls).toEqual([['bash-1', agent, 'undo']])
  })

  it('keeps failed background jobs retryable', async () => {
    const { userSeq, tracker, exec } = await fixture()
    let attempts = 0
    const context = (tracker as unknown as { ctx: Context }).ctx
    context.get = () => ({
      kill: () => {
        attempts++
        if (attempts === 1) throw new Error('temporary failure')
        return 'requested'
      },
    })
    await tracker.around(exec, async () => ({
      isError: false,
      value: { kind: 'background', jobId: 'bash-2' },
      content: [],
    }))

    expect(tracker.killJobs([userSeq])).toBe(0)
    expect(tracker.killJobs([userSeq])).toBe(1)
    expect(attempts).toBe(2)
  })

  it('rejects the workspace root as a restore path', async () => {
    const { tracker } = await fixture()
    await expect((tracker as unknown as { initialize(): Promise<boolean> }).initialize()).resolves.toBe(true)
    expect(() => (tracker as unknown as { workspacePath(file: string): string }).workspacePath('.'))
      .toThrow('unsafe workspace path')
  })
})
