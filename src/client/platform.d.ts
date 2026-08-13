declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ComponentType, ReactNode } from 'react'

  export const IconRefreshOutline16: ComponentType<{ size?: number; className?: string }>
  export const Tooltip: ComponentType<{
    label: ReactNode
    side?: 'top' | 'right' | 'bottom' | 'left'
    children: ReactNode
  }>
}
