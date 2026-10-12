// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext } from '../auth/context'
import type { AuthState } from '../auth/context'

const api = vi.hoisted(() => ({
  listQuestions: vi.fn(),
  createSession: vi.fn(),
  sendMagicLink: vi.fn(),
}))
vi.mock('../lib/api', () => ({ ...api, sessionLink: (id: string) => `http://x/session/${id}` }))

import NewSession from './NewSession'

const user = { id: 'u1', email: 'me@example.com' } as AuthState['user']

function setup() {
  render(
    <AuthContext.Provider value={{ session: null, user, loading: false, signOut: async () => {} }}>
      <MemoryRouter>
        <NewSession />
      </MemoryRouter>
    </AuthContext.Provider>,
  )
}

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset())
  api.listQuestions.mockResolvedValue([
    { id: 'q1', slug: 'a', title: 'Potluck raffle', prompt: 'Fix the raffle', constraints: '', language: 'python' },
  ])
})
afterEach(cleanup)

describe('NewSession', () => {
  it('validates question and email before creating', async () => {
    setup()
    await screen.findByText('Potluck raffle')
    fireEvent.click(screen.getByRole('button', { name: /create and send invite/i }))
    expect(screen.getByText('Pick a question.')).toBeTruthy()
    expect(screen.getByText(/enter the other person/i)).toBeTruthy()
    expect(api.createSession).not.toHaveBeenCalled()
  })

  it('rejects inviting yourself', async () => {
    setup()
    fireEvent.click(await screen.findByLabelText(/potluck raffle/i))
    fireEvent.change(screen.getByLabelText(/interviewer email/i), { target: { value: 'ME@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: /create and send invite/i }))
    expect(screen.getByText(/someone other than yourself/i)).toBeTruthy()
    expect(api.createSession).not.toHaveBeenCalled()
  })

  it('creates the session, sends the link, and shows the direct link', async () => {
    api.createSession.mockResolvedValue({ id: 's1' })
    api.sendMagicLink.mockResolvedValue(undefined)
    setup()
    fireEvent.click(await screen.findByLabelText(/potluck raffle/i))
    fireEvent.change(screen.getByLabelText(/interviewer email/i), { target: { value: 'friend@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: /create and send invite/i }))
    await screen.findByText('Invite sent')
    expect(api.createSession).toHaveBeenCalledWith({
      questionId: 'q1',
      myRole: 'interviewee',
      otherEmail: 'friend@example.com',
    })
    expect(api.sendMagicLink).toHaveBeenCalledWith('friend@example.com', 's1')
    expect((screen.getByLabelText('Direct link') as HTMLInputElement).value).toBe('http://x/session/s1')
  })

  it('keeps the created session when the email fails', async () => {
    api.createSession.mockResolvedValue({ id: 's1' })
    api.sendMagicLink.mockRejectedValue(new Error('email rate limit exceeded'))
    setup()
    fireEvent.click(await screen.findByLabelText(/potluck raffle/i))
    fireEvent.change(screen.getByLabelText(/interviewer email/i), { target: { value: 'friend@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: /create and send invite/i }))
    await waitFor(() => expect(screen.getByText(/email not sent/i)).toBeTruthy())
    expect(screen.getByRole('alert').textContent).toMatch(/rate limit/)
    expect((screen.getByLabelText('Direct link') as HTMLInputElement).value).toContain('s1')
  })
})
