// Core request handler with injected dependencies. No Deno globals.
import { parseCreateRequest } from "./validate.ts";

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

export const MAX_REQUESTS_PER_IP_PER_HOUR = 8;
export const MAX_SESSIONS_PER_EMAIL_PER_HOUR = 3;
export const DEFAULT_SITE_URL = "https://new-interviewer.vercel.app";
const HOUR_MS = 3_600_000;

export interface Deps {
  data: {
    questionExists(id: string): Promise<boolean>;
    countRequestsByIpSince(ip: string, sinceIso: string): Promise<number>;
    countRequestsByEmailSince(email: string, sinceIso: string): Promise<number>;
    insertRequest(ip: string, emails: string[]): Promise<void>;
    createSession(args: {
      question_id: string;
      interviewer_email: string;
      interviewee_email: string;
    }): Promise<{ id: string }>;
  };
  /** Sends a magic link; returns an error message (never surfaced) or null on success. */
  sendMagicLink(email: string, redirectTo: string): Promise<string | null>;
  now(): Date;
  env: { SITE_URL?: string };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function stripSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

export function resolveSiteUrl(origin: string | null, envSite?: string): string {
  const site = stripSlash(envSite || DEFAULT_SITE_URL);
  if (origin) {
    const o = stripSlash(origin);
    if (o === site || o === "http://localhost:5173") return o;
  }
  return site;
}

export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  return first || req.headers.get("x-real-ip")?.trim() || "unknown";
}

export async function handleCreateInterview(req: Request, deps: Deps): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") return json(405, { error: "Method not allowed." });

  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "Request body must be valid JSON." });
    }
    const parsed = parseCreateRequest(body);
    if (!parsed.ok) return json(400, { error: parsed.error });
    const { question_id, interviewer_email, interviewee_email } = parsed.value;

    if (!(await deps.data.questionExists(question_id))) {
      return json(404, { error: "Question not found." });
    }

    const ip = clientIp(req);
    const since = new Date(deps.now().getTime() - HOUR_MS).toISOString();
    if ((await deps.data.countRequestsByIpSince(ip, since)) >= MAX_REQUESTS_PER_IP_PER_HOUR) {
      return json(429, {
        error: "Too many interview requests from your network. Please try again in an hour.",
      });
    }
    for (const email of [interviewer_email, interviewee_email]) {
      if ((await deps.data.countRequestsByEmailSince(email, since)) >= MAX_SESSIONS_PER_EMAIL_PER_HOUR) {
        return json(429, {
          error: "That email address has received too many interview invitations. Please try again in an hour.",
        });
      }
    }

    await deps.data.insertRequest(ip, [interviewer_email, interviewee_email]);
    const session = await deps.data.createSession({ question_id, interviewer_email, interviewee_email });

    const siteUrl = resolveSiteUrl(req.headers.get("Origin"), deps.env.SITE_URL);
    const redirectTo = `${siteUrl}/session/${session.id}`;
    const send = async (email: string): Promise<string | null> => {
      try {
        return await deps.sendMagicLink(email, redirectTo);
      } catch {
        return "send failed";
      }
    };
    const [errA, errB] = await Promise.all([send(interviewer_email), send(interviewee_email)]);

    const sent = { interviewer: errA === null, interviewee: errB === null };
    const result: { session_id: string; sent: typeof sent; errors?: Record<string, string> } = {
      session_id: session.id,
      sent,
    };
    const errors: Record<string, string> = {};
    if (errA !== null) errors.interviewer = "The sign-in email could not be sent. Use the direct link instead.";
    if (errB !== null) errors.interviewee = "The sign-in email could not be sent. Use the direct link instead.";
    if (Object.keys(errors).length > 0) result.errors = errors;
    return json(200, result);
  } catch (e) {
    console.error("create-interview internal error:", e instanceof Error ? e.message : "unknown");
    return json(500, { error: "Internal error." });
  }
}
