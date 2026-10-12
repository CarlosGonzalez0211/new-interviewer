// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext } from '../auth/context'

const signInWithOtp = vi.hoisted(() => vi.fn())
vi.mock('../lib/supabase', () => ({ supabase: { auth: { signInWithOtp } } }))

import Login from './Login'

function setup(path = '/login?next=%2Fsession%2Fabc') {
  render(
    <AuthContext.Provider value={{ session: null, user: null, loading: false, signOut: async () => {} }}>
      <MemoryRouter initialEntries={[path]}>
        <Login />
      </MemoryRouter>
    </AuthContext.Provider>,
  )
}

beforeEach(() => signInWithOtp.mockReset())
afterEach(cleanup)

describe('Login', () => {
  it('calls signInWithOtp with the next path as redirect and shows the sent state', async () => {
    signInWithOtp.mockResolvedValue({ error: null })
    setup()
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'Me@Example.com' } })
    fireEvent.click(screen.getByRole('button', { name: /send magic link/i }))
    await waitFor(() => expect(screen.getByText(/check your inbox/i)).toBeTruthy())
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: 'me@example.com',
      options: { emailRedirectTo: `${window.location.origin}/session/abc` },
    })
  })

  it('shows an error when sign-in fails', async () => {
    signInWithOtp.mockResolvedValue({ error: { message: 'boom' } })
    setup()
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'me@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: /send magic link/i }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('boom'))
  })

  it('rejects invalid emails without calling supabase', () => {
    setup()
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'nope' } })
    fireEvent.click(screen.getByRole('button', { name: /send magic link/i }))
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(signInWithOtp).not.toHaveBeenCalled()
  })
})
