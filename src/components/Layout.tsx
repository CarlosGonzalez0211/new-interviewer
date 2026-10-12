import { Link, Outlet } from 'react-router-dom'
import { useAuth } from '../auth/context'
import Button from './ui/Button'

export default function Layout() {
  const { user, signOut } = useAuth()
  return (
    <div className="app-shell">
      <header className="app-header">
        <Link to="/" className="brand">
          <span className="brand-mark" aria-hidden="true">
            {'</>'}
          </span>{' '}
          Interview Lab
        </Link>
        <nav className="header-actions" aria-label="Main">
          {user?.email && <span className="muted small hide-sm">{user.email}</span>}
          <Button variant="ghost" onClick={() => void signOut()}>
            Sign out
          </Button>
        </nav>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  )
}
