// Pure request validation for ai-chat. No Deno globals.

export const MAX_MESSAGE_CHARS = 4000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ChatRequest {
  session_id: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; value: ChatRequest }
  | { ok: false; error: string };

export function parseChatRequest(body: unknown): ValidationResult {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }
  const { session_id, message } = body as Record<string, unknown>;
  if (typeof session_id !== "string" || !UUID_RE.test(session_id)) {
    return { ok: false, error: "session_id must be a valid UUID." };
  }
  if (typeof message !== "string") {
    return { ok: false, error: "message must be a string." };
  }
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "message must not be empty." };
  }
  if (trimmed.length > MAX_MESSAGE_CHARS) {
    return { ok: false, error: `message must be at most ${MAX_MESSAGE_CHARS} characters.` };
  }
  return { ok: true, value: { session_id: session_id.toLowerCase(), message: trimmed } };
}
