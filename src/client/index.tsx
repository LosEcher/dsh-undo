/** Browser half: undo action contributed to each finalized real user message. */

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { IconRefreshOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'

type SessionId = string

interface RemoteResult {
  readonly ok: boolean
  readonly error?: { readonly code: string; readonly message: string }
  readonly value?: unknown
}

interface UndoClientContext {
  readonly slots: {
    inject(name: string, install: () => () => void): void
    register(
      options: {
        name: string
        id: string
        order: number
        inject(sessionId: SessionId): UndoActionInjected
      },
      component: (props: UndoActionProps) => ReactNode,
    ): () => void
  }
  readonly remote: {
    readonly commands: {
      execute(sessionId: SessionId, line: string): Promise<RemoteResult>
    }
  }
}

interface UndoActionInjected {
  undo(seq: number): Promise<string | null>
}

interface UndoActionProps extends UndoActionInjected {
  readonly seq: number
}

const actionStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  padding: 6,
  border: 'none',
  borderRadius: 28,
  background: 'transparent',
  color: 'var(--dsw-alias-label-tertiary)',
  cursor: 'pointer',
}

/** Native message-strip action that rewinds from the addressed user message. */
function UndoUserAction({ seq, undo }: UndoActionProps): ReactNode {
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const label = failure ?? 'Undo from this message'

  useEffect(() => {
    setFailure(null)
    setPending(false)
  }, [seq])

  return (
    <Tooltip label={label} side="bottom">
      <button
        type="button"
        style={actionStyle}
        aria-label={label}
        aria-busy={pending || undefined}
        disabled={pending}
        onClick={() => {
          if (pending) return
          setPending(true)
          setFailure(null)
          void undo(seq).then((error) => {
            setPending(false)
            setFailure(error)
          })
        }}
      >
        <IconRefreshOutline16 />
      </button>
    </Tooltip>
  )
}

/** Services required by the browser half. */
export const inject = ['slots', 'remote', 'remote.commands']

/** Register one action entry in the user-message action slot. */
export function apply(ctx: UndoClientContext): void {
  ctx.slots.inject('conversation.chat.user-actions', () => ctx.slots.register({
    name: 'conversation.chat.user-actions',
    id: 'undo',
    order: 10,
    inject: (sessionId): UndoActionInjected => ({
      undo: async (seq) => {
        const result = await ctx.remote.commands.execute(sessionId, `/undo ${seq}`)
        if (!result.ok) return `${result.error?.message ?? 'command failed'}${result.error?.code === undefined ? '' : ` (${result.error.code})`}`
        if (result.value === undefined) return 'Undo command is unavailable'
        return null
      },
    }),
  }, UndoUserAction))
}
