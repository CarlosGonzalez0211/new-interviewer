// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ listPublicQuestions: vi.fn() }))
vi.mock('../lib/api', () => api)

import Home from './Home'

beforeEach(() => {
  api.listPublicQuestions.mockReset()
})
afterEach(cleanup)

function setup() {
  render(
    <MemoryRouter>
      <Home />
    </MemoryRouter>,
  )
}

describe('Home', () => {
  it('lists questions as links to their pages', async () => {
    api.listPublicQuestions.mockResolvedValue([
      { id: 'q1', slug: 'potluck', title: 'Potluck raffle', prompt: 'Fix the raffle', constraints: 'No libs', language: 'python' },
    ])
    setup()
    const link = (await screen.findByText('Potluck raffle')).closest('a')
    expect(link?.getAttribute('href')).toBe('/questions/potluck')
    expect(screen.getByText('Fix the raffle')).toBeTruthy()
    expect(screen.getByText(/No libs/)).toBeTruthy()
  })

  it('shows an error when loading fails', async () => {
    api.listPublicQuestions.mockRejectedValue(new Error('Could not load questions: boom'))
    setup()
    expect((await screen.findByRole('alert')).textContent).toMatch(/boom/)
  })
})
