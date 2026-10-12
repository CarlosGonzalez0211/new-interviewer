import { Link, Outlet } from 'react-router-dom'
import { useAuth } from '../auth/context'
import Button from './ui/Button'

export default function Layout() {
  const { user, loading, signOut } = useAuth()
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
          <Link to="/" className="btn btn-ghost">
            Questions
          </Link>
          {!loading && user && (
            <>
              <Link to="/dashboard" className="btn btn-ghost">
                My interviews
              </Link>
              {user.email && <span className="muted small hide-sm">{user.email}</span>}
              <Button variant="ghost" onClick={() => void signOut()}>
                Sign out
              </Button>
            </>
          )}
          {!loading && !user && (
            <Link to="/login" className="btn btn-ghost">
              Sign in
            </Link>
          )}
        </nav>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  )
}
