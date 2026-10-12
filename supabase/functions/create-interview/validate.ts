// Pure request validation for create-interview. No Deno globals.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@,;<>()"]+@[^\s@,;<>()"]+\.[^\s@,;<>()"]{2,}$/;

export interface CreateInterviewRequest {
  question_id: string;
  interviewer_email: string;
  interviewee_email: string;
}

export type ValidationResult =
  | { ok: true; value: CreateInterviewRequest }
  | { ok: false; error: string };

export function normalizeEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase();
  if (e.length > 254 || !EMAIL_RE.test(e)) return null;
  return e;
}

export function parseCreateRequest(body: unknown): ValidationResult {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.question_id !== "string" || !UUID_RE.test(b.question_id)) {
    return { ok: false, error: "question_id must be a valid UUID." };
  }
  const interviewer = normalizeEmail(b.interviewer_email);
  if (!interviewer) return { ok: false, error: "interviewer_email must be a valid email address." };
  const interviewee = normalizeEmail(b.interviewee_email);
  if (!interviewee) return { ok: false, error: "interviewee_email must be a valid email address." };
  if (interviewer === interviewee) {
    return { ok: false, error: "The interviewer and interviewee must use different email addresses." };
  }
  return {
    ok: true,
    value: {
      question_id: b.question_id.toLowerCase(),
      interviewer_email: interviewer,
      interviewee_email: interviewee,
    },
  };
}
