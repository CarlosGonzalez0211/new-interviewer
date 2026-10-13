// Core request handler with injected dependencies. No Deno globals.
import { parseChatRequest } from "./validate.ts";
import { buildSystemInstruction, trimHistory, HISTORY_LIMIT } from "./prompt.ts";
import type { CodeFile, HistoryMessage, QuestionInfo } from "./prompt.ts";
import { buildGeminiRequest, parseGeminiResponse, GeminiError } from "./gemini.ts";
import type { GeminiRequestInit } from "./gemini.ts";
import {
  FALLBACK_MODELS,
  MODELS_CACHE_TTL_MS,
  buildAttemptChain,
  collectModels,
  createModelsCache,
  effectiveModel,
  isRetryable,
} from "./models.ts";
import type { ModelOption, ModelsCache } from "./models.ts";

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
      model?: string,
    ): Promise<{ id: string }>;
  };
  callGemini(req: GeminiRequestInit): Promise<{ status: number; json: unknown }>;
  /** GET a Google API URL with the given headers (ListModels). Without it the models action degrades. */
  fetchJson?(url: string, headers: Record<string, string>): Promise<{ status: number; json: unknown }>;
  /** In-memory ListModels cache; defaults to a module-level one. Injected in tests. */
  modelsCache?: ModelsCache;
  now(): Date;
  env: { GEMINI_API_KEY?: string; GEMINI_MODEL?: string; GEMINI_FALLBACK_MODEL?: string };
  /** Pause between retries; injected so tests do not wait. */
  sleep?(ms: number): Promise<void>;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

const defaultModelsCache = createModelsCache();

/** `{ action: 'models' }`: usable Gemini chat models straight from Google's ListModels (cached 10 min). */
async function handleModels(deps: Deps): Promise<Response> {
  const defaultId = effectiveModel(deps.env.GEMINI_MODEL);
  const cache = deps.modelsCache ?? defaultModelsCache;
  const nowMs = deps.now().getTime();
  if (cache.value && nowMs - cache.at < MODELS_CACHE_TTL_MS) {
    return json(200, { models: cache.value, default: defaultId });
  }
  const apiKey = deps.env.GEMINI_API_KEY;
  let models: ModelOption[] | null = null;
  if (apiKey && deps.fetchJson) {
    const fetchJson = deps.fetchJson;
    try {
      models = await collectModels((url) => fetchJson(url, { "x-goog-api-key": apiKey }));
    } catch {
      models = null;
    }
  }
  if (!models) {
    console.error(JSON.stringify({ event: "list_models_failed" }));
    return json(200, { models: FALLBACK_MODELS, default: defaultId, degraded: true });
  }
  cache.value = models;
  cache.at = nowMs;
  return json(200, { models, default: defaultId });
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
    if (body !== null && typeof body === "object" && (body as { action?: unknown }).action === "models") {
      return await handleModels(deps);
    }
    const parsed = parseChatRequest(body);
    if (!parsed.ok) return json(400, { error: parsed.error });
    const { session_id, message, model: requestedModel } = parsed.value;

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

    const buildReq = (model: string | undefined) =>
      buildGeminiRequest({
        apiKey,
        model,
        systemInstruction: buildSystemInstruction(question, files),
        history: trimHistory(history),
        userMessage: message,
      });

    // Overload, per-model quota, retired model and server errors are often transient or model-specific:
    // retry the primary model once (after a pause), then walk a chain of fallback models.
    // The primary is the model the caller picked, else the server default.
    const primary = requestedModel ?? deps.env.GEMINI_MODEL;
    const attempts = buildAttemptChain(primary, deps.env.GEMINI_FALLBACK_MODEL);
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    let reply = "";
    let answeredBy = effectiveModel(primary);
    try {
      for (let i = 0; i < attempts.length; i++) {
        try {
          const res = await deps.callGemini(buildReq(attempts[i]));
          reply = parseGeminiResponse(res.status, res.json);
          answeredBy = effectiveModel(attempts[i]);
          break;
        } catch (err) {
          if (!isRetryable(err) || i === attempts.length - 1) throw err;
          console.error(
            JSON.stringify({ event: "gemini_retry", session_id, attempt: i + 1, model: attempts[i], detail: (err as Error).message }),
          );
          // Same model again (i === 0): pause. Switching to a different model: go straight on.
          if (i === 0) await sleep(800);
        }
      }
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
    const saved = await deps.data.insertMessage(session_id, "model", reply, answeredBy);
    return json(200, {
      reply,
      message_id: saved.id,
      model: answeredBy,
      fallback_used: answeredBy !== effectiveModel(primary),
    });
  } catch (e) {
    console.error("ai-chat internal error:", e instanceof Error ? e.message : "unknown");
    return json(500, { error: "Internal error." });
  }
}
