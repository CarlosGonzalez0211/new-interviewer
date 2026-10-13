// Core request handler with injected dependencies. No Deno globals.
import { parseChatRequest } from "./validate.ts";
import { buildSystemInstruction, trimHistory, HISTORY_LIMIT } from "./prompt.ts";
import type { CodeFile, HistoryMessage, QuestionInfo } from "./prompt.ts";
import { buildGeminiRequest, parseGeminiResponse, GeminiError } from "./gemini.ts";
import type { GeminiRequestInit } from "./gemini.ts";

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

export const RATE_LIMIT_PER_MINUTE = 20;

export interface SessionRow {
  id: string;
  question_id: string;
  interviewee_id: string | null;
  phase: string;
}

export interface Deps {
  /** Verify the bearer JWT; return the user or null. */
  getUser(jwt: string): Promise<{ id: string } | null>;
  data: {
    getSession(id: string): Promise<SessionRow | null>;
    getQuestion(questionId: string): Promise<QuestionInfo | null>;
    getSessionFiles(sessionId: string): Promise<CodeFile[]>;
    getHistory(sessionId: string, limit: number): Promise<HistoryMessage[]>;
    countUserMessagesSince(sessionId: string, sinceIso: string): Promise<number>;
    insertMessage(
      sessionId: string,
      role: "user" | "model",
      content: string,
    ): Promise<{ id: string }>;
  };
  callGemini(req: GeminiRequestInit): Promise<{ status: number; json: unknown }>;
  now(): Date;
  env: { GEMINI_API_KEY?: string; GEMINI_MODEL?: string };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

export async function handleChat(req: Request, deps: Deps): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") return json(405, { error: "Method not allowed." });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(authHeader);
    if (!m) return json(401, { error: "Missing or invalid Authorization header." });
    const user = await deps.getUser(m[1].trim());
    if (!user) return json(401, { error: "Invalid or expired session." });

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "Request body must be valid JSON." });
    }
    const parsed = parseChatRequest(body);
    if (!parsed.ok) return json(400, { error: parsed.error });
    const { session_id, message } = parsed.value;

    const session = await deps.data.getSession(session_id);
    if (!session) return json(404, { error: "Session not found." });
    if (session.interviewee_id !== user.id) {
      return json(403, { error: "Only the interviewee of this session can use the assistant." });
    }
    if (session.phase !== "debugging") {
      return json(403, { error: "The assistant is only available during the debugging phase." });
    }

    const apiKey = deps.env.GEMINI_API_KEY;
    if (!apiKey) return json(500, { error: "Server is not configured for AI chat." });

    const since = new Date(deps.now().getTime() - 60_000).toISOString();
    const recent = await deps.data.countUserMessagesSince(session_id, since);
    if (recent >= RATE_LIMIT_PER_MINUTE) {
      return json(429, { error: "Too many messages. Please wait a moment." });
    }

    const [question, files, history] = await Promise.all([
      deps.data.getQuestion(session.question_id),
      deps.data.getSessionFiles(session_id),
      deps.data.getHistory(session_id, HISTORY_LIMIT),
    ]);
    if (!question) return json(404, { error: "Question not found." });

    const geminiReq = buildGeminiRequest({
      apiKey,
      model: deps.env.GEMINI_MODEL,
      systemInstruction: buildSystemInstruction(question, files),
      history: trimHistory(history),
      userMessage: message,
    });

    let reply: string;
    try {
      const res = await deps.callGemini(geminiReq);
      reply = parseGeminiResponse(res.status, res.json);
    } catch (e) {
      if (e instanceof GeminiError && e.kind === "rate_limited") {
        return json(429, { error: "The AI service is busy. Please try again shortly." });
      }
      const internal = e instanceof Error ? e.message.slice(0, 240) : "unknown";
      // Visible in Supabase Dashboard > Edge Functions > ai-chat > Logs.
      console.error(JSON.stringify({ event: "gemini_failed", session_id, detail: internal }));
      // Only Gemini's own error text (HTTP status + its message) is shown; anything else stays generic.
      const shown = e instanceof GeminiError ? e.message : "could not reach the AI service";
      return json(502, { error: `The AI service is unavailable (${shown}).` });
    }

    await deps.data.insertMessage(session_id, "user", message);
    const saved = await deps.data.insertMessage(session_id, "model", reply);
    return json(200, { reply, message_id: saved.id });
  } catch (e) {
    console.error("ai-chat internal error:", e instanceof Error ? e.message : "unknown");
    return json(500, { error: "Internal error." });
  }
}
