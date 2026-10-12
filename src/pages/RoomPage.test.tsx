// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext } from '../auth/context'
import type { AuthState } from '../auth/context'

const api = vi.hoisted(() => ({ getSession: vi.fn(), claimSession: vi.fn() }))
vi.mock('../lib/api', () => api)
vi.mock('../lib/supabase', () => {
  const channel: Record<string, unknown> = {}
  channel.on = () => channel
  channel.subscribe = () => channel
  return { supabase: { channel: () => channel, removeChannel: async () => {} } }
})
vi.mock('../room/BriefingView', () => ({ default: ({ role }: { role: string }) => <div>briefing:{role}</div> }))
vi.mock('../room/IntervieweeRoom', () => ({ default: () => <div>interviewee-room</div> }))
vi.mock('../room/InterviewerRoom', () => ({ default: () => <div>interviewer-room</div> }))
vi.mock('../room/ReviewView', () => ({ default: ({ role }: { role: string }) => <div>review:{role}</div> }))

import RoomPage from './RoomPage'

const user = { id: 'me', email: 'me@example.com' } as AuthState['user']
const question = { id: 'q', slug: 's', title: 'T', prompt: 'P', constraints: '', language: 'python' }
const base = {
  id: 's1',
  question_id: 'q',
  created_by: 'me',
  interviewer_email: 'a@x.co',
  interviewee_email: 'b@x.co',
  question,
}

function setup() {
  render(
    <AuthContext.Provider value={{ session: null, user, loading: false, signOut: async () => {} }}>
      <MemoryRouter initialEntries={['/session/s1']}>
        <Routes>
          <Route path="/session/:id" element={<RoomPage />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  )
}

beforeEach(() => Object.values(api).forEach((f) => f.mockReset()))
afterEach(cleanup)

describe('RoomPage', () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ['briefing interviewer', { phase: 'briefing', interviewer_id: 'me', interviewee_id: 'o' }, 'briefing:interviewer'],
    ['briefing interviewee', { phase: 'briefing', interviewer_id: 'o', interviewee_id: 'me' }, 'briefing:interviewee'],
    ['debugging interviewee', { phase: 'debugging', interviewer_id: 'o', interviewee_id: 'me' }, 'interviewee-room'],
    ['debugging interviewer', { phase: 'debugging', interviewer_id: 'me', interviewee_id: 'o' }, 'interviewer-room'],
    ['completed interviewee', { phase: 'completed', interviewer_id: 'o', interviewee_id: 'me' }, 'review:interviewee'],
  ]
  for (const [name, fields, text] of cases) {
    it(`renders ${name}`, async () => {
      api.getSession.mockResolvedValue({ ...base, ...fields })
      setup()
      await screen.findByText(text)
      expect(api.claimSession).not.toHaveBeenCalled()
    })
  }

  it('claims the session when the user is not yet a participant', async () => {
    api.getSession
      .mockRejectedValueOnce(new Error('not visible'))
      .mockResolvedValueOnce({ ...base, phase: 'briefing', interviewer_id: 'o', interviewee_id: 'me' })
    api.claimSession.mockResolvedValue({})
    setup()
    await screen.findByText('briefing:interviewee')
    expect(api.claimSession).toHaveBeenCalledWith('s1')
  })

  it('shows an error when claiming fails', async () => {
    api.getSession.mockRejectedValue(new Error('nope'))
    api.claimSession.mockRejectedValue(new Error('Could not join the session: wrong email'))
    setup()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/wrong email/))
  })
})
