import { stableUuid } from './fake/ids'

export interface SandboxUser {
  id: string
  email: string
  name: string
}

export const SANDBOX_INTERVIEWER: SandboxUser = {
  id: stableUuid('sandbox', 'user', 'interviewer'),
  email: 'interviewer@sandbox.test',
  name: 'Interviewer',
}

export const SANDBOX_INTERVIEWEE: SandboxUser = {
  id: stableUuid('sandbox', 'user', 'interviewee'),
  email: 'interviewee@sandbox.test',
  name: 'Interviewee',
}
