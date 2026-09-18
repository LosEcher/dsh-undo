/**
 * Host API drift gate.
 *
 * A `link:`-installed plugin resolves its OWN vendored `@deepseek-ai/*`
 * packages, so the rest of this suite can stay green while the host half is
 * broken against the harness that actually runs it. Real case: the running
 * harness removed `Session.events` (0.1.5-rc.x) while this repo declares
 * dsh-session 0.1.0-rc.x, whose copy still has it — every /undo threw at
 * runtime with the suite at 30/30 green.
 *
 * This gate loads the RUNNING harness's `dsh-session` (not the vendored one)
 * and drives the plugin's real domain helpers with a Session that harness
 * built, so the drift fails here instead of in production.
 *
 * Skipped when no harness library can be resolved, which is the honest answer
 * on a machine without one — not a silent pass.
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  computeUndoRange,
  eventCount,
  lastVisibleText,
  sessionEvents,
  turnForAssistantMessage,
  userSeqForTurn,
} from '../src/domain.ts'

interface HarnessEvent {
  readonly type: string
  readonly seq: number
  readonly data: Record<string, any>
}

interface HarnessSession {
  readonly seq: number
  readonly surface: { readonly nodes: readonly number[] }
  append(type: string, data: unknown, options?: unknown): { readonly seq: number }
  eventAt(seq: number): HarnessEvent | undefined
  deriveMessages(): readonly unknown[]
}

interface HarnessSessionModule {
  Session: { create(id: unknown): HarnessSession }
  SessionId(value: string): unknown
}

interface HarnessLlmModule {
  createUserMessage(input: unknown): unknown
  createAssistantMessage(input: unknown): unknown
}

/**
 * Resolve `@deepseek-ai/dsh-session` from a running harness rather than from
 * this package's own (older) dependency tree.
 * @returns the resolved module path, or undefined when none is available.
 */
function resolveHarnessSession(): string | undefined {
  const roots = [
    process.env.DSH_PROFILE_ROOT === undefined
      ? undefined
      : join(process.env.DSH_PROFILE_ROOT, 'node_modules'),
    process.env.DSH_SOURCE === undefined
      ? undefined
      : join(process.env.DSH_SOURCE, 'apps/cli/node_modules'),
    join(homedir(), '.dsh/profiles/node_modules'),
  ].filter((root): root is string => root !== undefined && existsSync(root))
  for (const root of roots) {
    try {
      return createRequire(join(root, 'noop.js')).resolve('@deepseek-ai/dsh-session')
    } catch {
      // Try the next candidate root.
    }
  }
  return undefined
}

const harnessSessionPath = resolveHarnessSession()

describe.skipIf(harnessSessionPath === undefined)('host API compatibility', () => {
  it('resolves Turn and message anchors on a Session the running harness built', async () => {
    const sessionModule = (await import(pathToFileURL(harnessSessionPath as string).href)) as unknown as HarnessSessionModule
    const llmPath = createRequire(harnessSessionPath as string).resolve('@deepseek-ai/dsh-llm')
    const llm = (await import(pathToFileURL(llmPath).href)) as unknown as HarnessLlmModule

    const session = sessionModule.Session.create(sessionModule.SessionId('harness-compat'))

    const openTurn = (turn: number, prompt: string, answer: string): { userSeq: number; messageId: string } => {
      session.append('turn/start', { turn })
      const userSeq = session.append('user/message', llm.createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' }).seq
      const assistantSeq = session.append('assistant/message', {
        turn,
        step: 1,
        message: llm.createAssistantMessage({
          content: [{ type: 'text', text: answer }],
          source: { provider: 'test', model: 'test' },
        }),
        stream: [],
      }, { surfaceOp: 'append' }).seq
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
      const event = session.eventAt(assistantSeq)
      if (event === undefined) throw new Error('harness-compat: assistant event missing')
      return { userSeq, messageId: String(event.data['message'].id) }
    }

    const first = openTurn(1, 'first', 'one')
    const second = openTurn(2, 'second', 'two')

    // The whole point of this gate is to drive the plugin's typed helpers with a
    // Session built by a DIFFERENT dsh-session build, so the structural cast is
    // the assertion under test rather than a shortcut around it.
    const asSession = session as unknown as Parameters<typeof eventCount>[0]

    // Keep the gate non-vacuous: this run is only meaningful because the harness
    // build lacks the accessor the plugin used to rely on. If a future harness
    // restores a synchronous log accessor, fail loudly here and re-derive the gate.
    expect((session as unknown as { events?: unknown }).events).toBeUndefined()

    // The plugin's helpers must read this harness's log, whatever accessor it has.
    expect(eventCount(asSession)).toBe(session.seq)
    expect(sessionEvents(asSession)).toHaveLength(session.seq)
    expect(userSeqForTurn(asSession, 1)).toBe(first.userSeq)
    expect(userSeqForTurn(asSession, 2)).toBe(second.userSeq)
    expect(turnForAssistantMessage(asSession, second.messageId)).toBe(2)
    expect(computeUndoRange(asSession, first.userSeq)?.userSeq).toBe(first.userSeq)
    expect(lastVisibleText(asSession)).toBe('second')
  })
})

it('reports which harness library the gate used', () => {
  // Printed so a green run states what it actually verified.
  expect(typeof harnessSessionPath === 'string' || harnessSessionPath === undefined).toBe(true)
  console.log(`[harness-compat] dsh-session = ${harnessSessionPath ?? '(none resolved — gate skipped)'}`)
})
