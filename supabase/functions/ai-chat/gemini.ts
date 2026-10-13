// Gemini REST request/response mapping. No Deno globals.
import type { HistoryMessage } from "./prompt.ts";

export const DEFAULT_MODEL = "gemini-3.8-flash";
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export interface GeminiRequestInit {
  url: string;
  init: { method: "POST"; headers: Record<string, string>; body: string };
}

export function buildGeminiRequest(args: {
  apiKey: string;
  model?: string;
  systemInstruction: string;
  history: HistoryMessage[]; // already trimmed, alternating, starts with user
  userMessage: string;
}): GeminiRequestInit {
  const model = (args.model && args.model.trim()) || DEFAULT_MODEL;
  const contents = [
    ...args.history.map((m) => ({ role: m.role as string, parts: [{ text: m.content }] })),
    { role: "user", parts: [{ text: args.userMessage }] },
  ];
  // If history ended with a user turn, merge to keep strict alternation.
  const merged: { role: string; parts: { text: string }[] }[] = [];
  for (const c of contents) {
    const last = merged[merged.length - 1];
    if (last && last.role === c.role) {
      last.parts = [{ text: last.parts[0].text + "\n\n" + c.parts[0].text }];
    } else {
      merged.push({ role: c.role, parts: [...c.parts] });
    }
  }
  return {
    url: `${BASE}/${encodeURIComponent(model)}:generateContent`,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": args.apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: args.systemInstruction }] },
        contents: merged,
        generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
      }),
    },
  };
}

export type GeminiErrorKind = "rate_limited" | "overloaded" | "blocked" | "empty" | "upstream";

export class GeminiError extends Error {
  kind: GeminiErrorKind;
  constructor(kind: GeminiErrorKind, message: string) {
    super(message);
    this.name = "GeminiError";
    this.kind = kind;
  }
}

/** Returns the reply text or throws GeminiError. */
export function parseGeminiResponse(status: number, json: unknown): string {
  if (status === 429) throw new GeminiError("rate_limited", "Gemini rate limit exceeded");
  if (status === 503) {
    const m503 = (json as { error?: { message?: unknown } } | null)?.error?.message;
    throw new GeminiError(
      "overloaded",
      `Gemini returned HTTP 503${typeof m503 === "string" ? `: ${m503.slice(0, 200)}` : ""}`,
    );
  }
  if (status < 200 || status >= 300) {
    const msg = (json as { error?: { message?: unknown } } | null)?.error?.message;
    const detail = typeof msg === "string" ? `: ${msg.slice(0, 200)}` : "";
    throw new GeminiError("upstream", `Gemini returned HTTP ${status}${detail}`);
  }
  // deno-lint-ignore no-explicit-any
  const data = (json ?? {}) as any;
  const blockReason = data?.promptFeedback?.blockReason;
  if (blockReason) throw new GeminiError("blocked", `Prompt blocked: ${blockReason}`);
  const candidates = data?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new GeminiError("empty", "Gemini returned no candidates");
  }
  const cand = candidates[0];
  const text = (cand?.content?.parts ?? [])
    // deno-lint-ignore no-explicit-any
    .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
    .join("")
    .trim();
  if (!text) {
    if (cand?.finishReason === "SAFETY" || cand?.finishReason === "PROHIBITED_CONTENT") {
      throw new GeminiError("blocked", `Response blocked: ${cand.finishReason}`);
    }
    throw new GeminiError("empty", "Gemini returned an empty reply");
  }
  return text;
}
