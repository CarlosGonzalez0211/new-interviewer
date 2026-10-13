// Model discovery (Google ListModels) and fallback-chain helpers. Pure: no Deno globals, shared with the browser sandbox.
import { DEFAULT_MODEL, GeminiError } from "./gemini.ts";

export interface ModelOption {
  id: string;
  label: string;
}

/** Used when Google's ListModels cannot be reached. */
export const FALLBACK_MODELS: ModelOption[] = [
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  { id: "gemini-flash-latest", label: "Gemini Flash (latest)" },
  { id: "gemini-flash-lite-latest", label: "Gemini Flash-Lite (latest)" },
];

export const LIST_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200";
export const MAX_LIST_PAGES = 4;
export const MODELS_CACHE_TTL_MS = 10 * 60_000;

/** Same rule the request validator applies to the optional `model` field. */
export const MODEL_ID_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;

/** Not usable as a text chat model. */
const NON_CHAT_RE = /embedding|tts|image|live|audio|robotics|computer|aqa|vision/;

export const DEFAULT_FALLBACK_MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest"];
/** Statuses where trying again or switching model can help (overload, per-model quota, retired model, server error). */
export const RETRYABLE_STATUSES = new Set([404, 429, 500, 503]);

/** "gemini-3.8-flash" -> "Gemini 3.8 Flash" (used when Google gives no displayName). */
export function labelFromId(id: string): string {
  return id
    .split("-")
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p))
    .join(" ");
}

/** Keep usable Gemini chat models from a ListModels `models` array; flash family first, then alphabetical. */
export function filterModels(raw: unknown): ModelOption[] {
  if (!Array.isArray(raw)) return [];
  const byId = new Map<string, ModelOption>();
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const m = item as { name?: unknown; displayName?: unknown; supportedGenerationMethods?: unknown };
    if (typeof m.name !== "string" || !m.name.startsWith("models/gemini")) continue;
    const methods = m.supportedGenerationMethods;
    if (!Array.isArray(methods) || !methods.includes("generateContent")) continue;
    const id = m.name.slice("models/".length);
    if (!MODEL_ID_RE.test(id) || NON_CHAT_RE.test(id)) continue;
    const label = typeof m.displayName === "string" && m.displayName.trim() ? m.displayName.trim() : labelFromId(id);
    if (!byId.has(id)) byId.set(id, { id, label });
  }
  const isFlash = (o: ModelOption) => o.id.includes("flash");
  return [...byId.values()].sort((a, b) => {
    const fa = isFlash(a);
    const fb = isFlash(b);
    if (fa !== fb) return fa ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export type FetchPage = (url: string) => Promise<{ status: number; json: unknown }>;

/**
 * Walk ListModels pages (max MAX_LIST_PAGES) and return the filtered list, or null when the first page fails
 * or no usable model is found (caller then degrades to FALLBACK_MODELS). A failure on a later page keeps what we have.
 */
export async function collectModels(fetchPage: FetchPage): Promise<ModelOption[] | null> {
  const raw: unknown[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const url = token ? `${LIST_MODELS_URL}&pageToken=${encodeURIComponent(token)}` : LIST_MODELS_URL;
    let res: { status: number; json: unknown };
    try {
      res = await fetchPage(url);
    } catch {
      if (page === 0) return null;
      break;
    }
    if (res.status < 200 || res.status >= 300) {
      if (page === 0) return null;
      break;
    }
    const data = (res.json ?? {}) as { models?: unknown; nextPageToken?: unknown };
    if (Array.isArray(data.models)) raw.push(...data.models);
    if (typeof data.nextPageToken === "string" && data.nextPageToken) token = data.nextPageToken;
    else break;
  }
  const out = filterModels(raw);
  return out.length ? out : null;
}

export interface ModelsCache {
  value: ModelOption[] | null;
  at: number;
}
export const createModelsCache = (): ModelsCache => ({ value: null, at: 0 });

/** Effective model name actually sent to Google for a given attempt entry. */
export function effectiveModel(m: string | undefined): string {
  return (m && m.trim()) || DEFAULT_MODEL;
}

/** Primary (tried twice, to ride out a transient error) followed by the fallback chain, skipping the primary itself. */
export function buildAttemptChain(primary: string | undefined, fallbackEnv?: string): (string | undefined)[] {
  const configured = (fallbackEnv ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const wanted = effectiveModel(primary);
  const fallbacks = (configured.length ? configured : DEFAULT_FALLBACK_MODELS).filter(
    (m) => effectiveModel(m) !== wanted,
  );
  return [primary, primary, ...fallbacks];
}

export function isRetryable(err: unknown): boolean {
  return (
    err instanceof GeminiError &&
    (err.kind === "overloaded" ||
      err.kind === "rate_limited" ||
      (err.status !== undefined && RETRYABLE_STATUSES.has(err.status)))
  );
}
