// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthContext, type AuthState } from './context'
import ProtectedRoute from './ProtectedRoute'

afterEach(cleanup)

function LoginProbe() {
  const loc = useLocation()
  return <div>login:{loc.search}</div>
}

function setup(auth: Partial<AuthState>, path = '/session/abc?x=1') {
  const value: AuthState = { session: null, user: null, loading: false, signOut: async () => {}, ...auth }
  return render(
    <AuthContext.Provider value={value}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/login" element={<LoginProbe />} />
          <Route
            path="/session/:id"
            element={
              <ProtectedRoute>
                <div>secret</div>
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  )
}

describe('ProtectedRoute', () => {
  it('redirects anonymous users to /login preserving the intended path', () => {
    setup({})
    expect(screen.getByText(/^login:/).textContent).toBe(`login:?next=${encodeURIComponent('/session/abc?x=1')}`)
    expect(screen.queryByText('secret')).toBeNull()
  })

  it('shows a spinner while loading', () => {
    setup({ loading: true })
    expect(screen.getByRole('status')).toBeTruthy()
    expect(screen.queryByText('secret')).toBeNull()
  })

  it('renders children for signed-in users', () => {
    setup({ user: { id: 'u1', email: 'a@b.co' } as AuthState['user'] })
    expect(screen.getByText('secret')).toBeTruthy()
  })
})
