/** Browser half: undo action contributed to each finalized assistant message. */

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { IconRefreshOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'

type SessionId = string
type MessageId = string

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
        inject(): UndoActionInjected
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
  undo(sessionId: SessionId, messageId: MessageId): Promise<string | null>
}

/** Owner share (`messageId`) plus the session-scoped standard kit. */
interface UndoActionProps extends UndoActionInjected {
  readonly messageId: MessageId
  readonly sessionId: SessionId
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

/** Native message-strip action that rewinds from the turn behind this answer. */
function UndoAssistantAction({ messageId, sessionId, undo }: UndoActionProps): ReactNode {
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const label = failure ?? 'Undo this turn'
  useEffect(() => {
    setFailure(null)
    setPending(false)
  }, [messageId])
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
          void undo(sessionId, messageId).then((error) => {
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

/**
 * Register one entry in the finalized assistant message's action list. The
 * action addresses the turn by the durable assistant message id, because the
 * model-facing surface exposes message identity rather than the user-message
 * seq the host command rewinds from.
 */
export function apply(ctx: UndoClientContext): void {
  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions',
    id: 'undo',
    order: 10,
    inject: (): UndoActionInjected => ({
      undo: async (sessionId, messageId) => {
        const result = await ctx.remote.commands.execute(sessionId, `/undo message:${messageId}`)
        if (!result.ok) return `${result.error?.message ?? 'command failed'}${result.error?.code === undefined ? '' : ` (${result.error.code})`}`
        if (result.value === undefined) return 'Undo command is unavailable'
        return null
      },
    }),
  }, UndoAssistantAction))
}
