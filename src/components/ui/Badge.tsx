import type { ReactNode } from 'react'

export type BadgeTone = 'neutral' | 'blue' | 'green' | 'amber' | 'purple'

export default function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>
}
