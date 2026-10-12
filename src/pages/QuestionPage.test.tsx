// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getQuestionBySlug: vi.fn(), createInterview: vi.fn() }))
vi.mock('../lib/api', () => ({ ...api, sessionLink: (id: string) => `http://x/session/${id}` }))

import QuestionPage from './QuestionPage'

function setup() {
  render(
    <MemoryRouter initialEntries={['/questions/potluck']}>
      <Routes>
        <Route path="/questions/:slug" element={<QuestionPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

function fill(a: string, b: string) {
  fireEvent.change(screen.getByLabelText(/interviewer email/i), { target: { value: a } })
  fireEvent.change(screen.getByLabelText(/interviewee email/i), { target: { value: b } })
  fireEvent.click(screen.getByRole('button', { name: /send magic links/i }))
}

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset())
  api.getQuestionBySlug.mockResolvedValue({
    id: 'q1',
    slug: 'potluck',
    title: 'Potluck raffle',
    prompt: 'Fix the raffle',
    constraints: 'No libs',
    language: 'python',
  })
})
afterEach(cleanup)

describe('QuestionPage', () => {
  it('shows the question and validates emails', async () => {
    setup()
    await screen.findByText('Potluck raffle')
    expect(screen.getByText('No libs')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /send magic links/i }))
    expect(screen.getByText(/enter the interviewer/i)).toBeTruthy()
    expect(screen.getByText(/enter the interviewee/i)).toBeTruthy()
    fill('not-an-email', 'b@example.com')
    expect(screen.getByText(/valid email/i)).toBeTruthy()
    expect(api.createInterview).not.toHaveBeenCalled()
  })

  it('rejects identical emails', async () => {
    setup()
    await screen.findByText('Potluck raffle')
    fill('a@example.com', 'A@Example.com')
    expect(screen.getByText(/must be different/i)).toBeTruthy()
    expect(api.createInterview).not.toHaveBeenCalled()
  })

  it('shows confirmation with per-email status and the direct link', async () => {
    api.createInterview.mockResolvedValue({ session_id: 's1', sent: { interviewer: true, interviewee: false } })
    setup()
    await screen.findByText('Potluck raffle')
    fill('a@example.com', 'b@example.com')
    await screen.findByText('Interview created')
    expect(api.createInterview).toHaveBeenCalledWith({
      questionId: 'q1',
      interviewerEmail: 'a@example.com',
      intervieweeEmail: 'b@example.com',
    })
    expect(screen.getByText('sent')).toBeTruthy()
    expect(screen.getByText('not sent')).toBeTruthy()
    expect((screen.getByLabelText('Direct session link') as HTMLInputElement).value).toBe('http://x/session/s1')
  })

  it('says magic links were sent to both when both succeed', async () => {
    api.createInterview.mockResolvedValue({ session_id: 's1', sent: { interviewer: true, interviewee: true } })
    setup()
    await screen.findByText('Potluck raffle')
    fill('a@example.com', 'b@example.com')
    await screen.findByText('Magic links sent to both people')
  })

  it('surfaces server errors such as 429', async () => {
    api.createInterview.mockRejectedValue(new Error('Rate limit exceeded, try again in an hour'))
    setup()
    await screen.findByText('Potluck raffle')
    fill('a@example.com', 'b@example.com')
    expect((await screen.findByRole('alert')).textContent).toMatch(/rate limit exceeded/i)
    expect(screen.getByRole('button', { name: /send magic links/i })).toBeTruthy()
  })

  it('handles an unknown slug', async () => {
    api.getQuestionBySlug.mockResolvedValue(null)
    setup()
    await screen.findByText('Question not found')
  })
})
