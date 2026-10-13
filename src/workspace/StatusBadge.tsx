import type { CollabStatus } from '../collab'
import { STATUS_DOT, STATUS_LABEL } from './logic'

export default function StatusBadge({ status }: { status: CollabStatus }) {
  return (
    <span className="room-badge" role="status" title={STATUS_LABEL[status]}>
      <span className={`room-dot ${STATUS_DOT[status]}`} aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  )
}
