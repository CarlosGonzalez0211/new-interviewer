import { describe, it, expect, vi } from "vitest";
import { parseChatRequest } from "./validate.ts";
import { buildSystemInstruction, formatCodeContext, trimHistory } from "./prompt.ts";
import { buildGeminiRequest, parseGeminiResponse, GeminiError } from "./gemini.ts";
import { handleChat, RATE_LIMIT_PER_MINUTE } from "./handler.ts";
import type { Deps } from "./handler.ts";

const SID = "123e4567-e89b-42d3-a456-426614174000";
const USER = "user-1";

describe("validate", () => {
  it("accepts and trims a valid body", () => {
    const r = parseChatRequest({ session_id: SID, message: "  hi  " });
    expect(r).toEqual({ ok: true, value: { session_id: SID, message: "hi" } });
  });
  it.each([
    [null], ["x"], [[]], [{}],
    [{ session_id: "nope", message: "hi" }],
    [{ session_id: SID }],
    [{ session_id: SID, message: 5 }],
    [{ session_id: SID, message: "   \n " }],
    [{ session_id: SID, message: "a".repeat(4001) }],
    [{ session_id: 42, message: "hi" }],
  ])("rejects %j", (body) => {
    expect(parseChatRequest(body).ok).toBe(false);
  });
  it("allows exactly 4000 chars", () => {
    expect(parseChatRequest({ session_id: SID, message: "a".repeat(4000) }).ok).toBe(true);
  });
});

describe("prompt", () => {
  const q = { title: "Raffle", prompt: "Fix the raffle.", constraints: "Price is 5." };
  const files = [
    { path: "raffle.py", content: "def draw(): return CURRENT_CODE_MARKER", kind: "code" },
    { path: "test_raffle.py", content: "def test_x(): pass", kind: "test" },
  ];
  it("contains the current code, brief and constraints", () => {
    const s = buildSystemInstruction(q, files);
    expect(s).toContain("CURRENT_CODE_MARKER");
    expect(s).toContain("raffle.py");
    expect(s).toContain("test_raffle.py");
    expect(s).toContain("Fix the raffle.");
    expect(s).toContain("Price is 5.");
    expect(s).toContain("CURRENT");
  });
  it("states there is no reference solution and never contains one", () => {
    const s = buildSystemInstruction(q, files);
    expect(s).toMatch(/no knowledge of any hidden reference solution/);
    expect(s).toMatch(/concise/i);
    expect(s).toMatch(/write or fix code/);
  });
  it("formats files deterministically", () => {
    expect(formatCodeContext([])).toBe("(no files)");
    const out = formatCodeContext([files[1], files[0]]);
    expect(out.indexOf("raffle.py (source")).toBeLessThan(out.indexOf("test_raffle.py (test"));
  });
  it("trimHistory limits, drops leading model turns and alternates", () => {
    const msgs = [
      { role: "model" as const, content: "m0" },
      { role: "user" as const, content: "u1" },
      { role: "user" as const, content: "u2" },
      { role: "model" as const, content: "m1" },
    ];
    expect(trimHistory(msgs)).toEqual([
      { role: "user", content: "u1\n\nu2" },
      { role: "model", content: "m1" },
    ]);
    const many = Array.from({ length: 100 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "model") as "user" | "model",
      content: `c${i}`,
    }));
    const t = trimHistory(many, 30);
    expect(t.length).toBeLessThanOrEqual(30);
    expect(t[0].role).toBe("user");
  });
});

describe("gemini request", () => {
  it("builds the REST request", () => {
    const r = buildGeminiRequest({
      apiKey: "KEY",
      model: "gemini-x",
      systemInstruction: "SYS",
      history: [
        { role: "user", content: "a" },
        { role: "model", content: "b" },
      ],
      userMessage: "c",
    });
    expect(r.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent",
    );
    expect(r.init.method).toBe("POST");
    expect(r.init.headers["x-goog-api-key"]).toBe("KEY");
    expect(r.url).not.toContain("KEY");
    const body = JSON.parse(r.init.body);
    expect(body.systemInstruction.parts[0].text).toBe("SYS");
    expect(body.contents.map((c: any) => c.role)).toEqual(["user", "model", "user"]);
    expect(body.contents[2].parts[0].text).toBe("c");
  });
  it("defaults the model and merges a trailing user turn", () => {
    const r = buildGeminiRequest({
      apiKey: "K",
      systemInstruction: "S",
      history: [{ role: "user", content: "a" }],
      userMessage: "b",
    });
    expect(r.url).toContain("/models/gemini-3.8-flash:generateContent");
    const body = JSON.parse(r.init.body);
    expect(body.contents).toHaveLength(1);
    expect(body.contents[0].parts[0].text).toBe("a\n\nb");
  });
});

describe("gemini response", () => {
  it("returns text", () => {
    const j = { candidates: [{ content: { parts: [{ text: "Hel" }, { text: "lo" }] } }] };
    expect(parseGeminiResponse(200, j)).toBe("Hello");
  });
  const kind = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as GeminiError).kind;
    }
    return "none";
  };
  it("maps errors", () => {
    expect(kind(() => parseGeminiResponse(429, {}))).toBe("rate_limited");
    expect(kind(() => parseGeminiResponse(500, {}))).toBe("upstream");
    expect(kind(() => parseGeminiResponse(200, { promptFeedback: { blockReason: "SAFETY" } }))).toBe("blocked");
    expect(kind(() => parseGeminiResponse(200, { candidates: [] }))).toBe("empty");
    expect(kind(() => parseGeminiResponse(200, {}))).toBe("empty");
    expect(kind(() => parseGeminiResponse(200, { candidates: [{ finishReason: "SAFETY" }] }))).toBe("blocked");
    expect(kind(() => parseGeminiResponse(200, { candidates: [{ content: { parts: [{ text: "  " }] } }] }))).toBe("empty");
  });
});

function makeDeps(over: { user?: string | null; session?: any; env?: any; gemini?: any; count?: number } = {}) {
  const inserted: { role: string; content: string }[] = [];
  const session =
    over.session === undefined
      ? { id: SID, question_id: "q1", interviewee_id: USER, phase: "debugging" }
      : over.session;
  const callGemini = vi.fn(
    over.gemini ??
      (async () => ({
        status: 200,
        json: { candidates: [{ content: { parts: [{ text: "the reply" }] } }] },
      })),
  );
  const deps: Deps = {
    getUser: async () => (over.user === null ? null : { id: over.user ?? USER }),
    data: {
      getSession: async () => session,
      getQuestion: async () => ({ title: "T", prompt: "P", constraints: "C" }),
      getSessionFiles: async () => [{ path: "a.py", content: "x = 1", kind: "code" }],
      getHistory: async () => [],
      countUserMessagesSince: async () => over.count ?? 0,
      insertMessage: async (_s, role, content) => {
        inserted.push({ role, content });
        return { id: `msg-${inserted.length}` };
      },
    },
    callGemini: callGemini as any,
    now: () => new Date("2026-01-01T00:00:00Z"),
    env: over.env ?? { GEMINI_API_KEY: "SECRET-KEY" },
    sleep: async () => {},
  };
  return { deps, inserted, callGemini };
}

function post(body: unknown, auth: string | null = "Bearer tok") {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth) headers.Authorization = auth;
  return new Request("http://x/ai-chat", { method: "POST", headers, body: JSON.stringify(body) });
}
const good = { session_id: SID, message: "help" };

describe("handler", () => {
  it("OPTIONS returns CORS", async () => {
    const { deps } = makeDeps();
    const r = await handleChat(new Request("http://x", { method: "OPTIONS" }), deps);
    expect(r.status).toBe(204);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
  it("401 without auth header or with bad token", async () => {
    const a = await handleChat(post(good, null), makeDeps().deps);
    expect(a.status).toBe(401);
    expect(a.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const b = await handleChat(post(good), makeDeps({ user: null }).deps);
    expect(b.status).toBe(401);
  });
  it("400 on bad body", async () => {
    const r = await handleChat(post({ session_id: "x", message: "" }), makeDeps().deps);
    expect(r.status).toBe(400);
  });
  it("404 unknown session", async () => {
    const r = await handleChat(post(good), makeDeps({ session: null }).deps);
    expect(r.status).toBe(404);
  });
  it("403 for wrong user, no interviewee, wrong phase", async () => {
    expect((await handleChat(post(good), makeDeps({ user: "other" }).deps)).status).toBe(403);
    const noInt = { id: SID, question_id: "q", interviewee_id: null, phase: "debugging" };
    expect((await handleChat(post(good), makeDeps({ session: noInt }).deps)).status).toBe(403);
    for (const phase of ["briefing", "completed"]) {
      const s = { id: SID, question_id: "q", interviewee_id: USER, phase };
      const { deps, callGemini } = makeDeps({ session: s });
      expect((await handleChat(post(good), deps)).status).toBe(403);
      expect(callGemini).not.toHaveBeenCalled();
    }
  });
  it("200 stores both messages in order and sends code to Gemini", async () => {
    const { deps, inserted, callGemini } = makeDeps();
    const r = await handleChat(post(good), deps);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ reply: "the reply", message_id: "msg-2" });
    expect(inserted).toEqual([
      { role: "user", content: "help" },
      { role: "model", content: "the reply" },
    ]);
    const sent = JSON.parse(callGemini.mock.calls[0][0].init.body);
    expect(sent.systemInstruction.parts[0].text).toContain("x = 1");
  });
  it("maps Gemini 429 to 429 and stores nothing", async () => {
    const { deps, inserted } = makeDeps({ gemini: async () => ({ status: 429, json: {} }) });
    expect((await handleChat(post(good), deps)).status).toBe(429);
    expect(inserted).toHaveLength(0);
  });
  it("maps other upstream failures (incl. blocked, thrown) to generic 502", async () => {
    for (const g of [
      async () => ({ status: 500, json: {} }),
      async () => ({ status: 200, json: { candidates: [] } }),
      async () => ({ status: 200, json: { promptFeedback: { blockReason: "SAFETY" } } }),
      async () => {
        throw new Error("network SECRET-KEY");
      },
    ]) {
      const { deps, inserted } = makeDeps({ gemini: g });
      const r = await handleChat(post(good), deps);
      expect(r.status).toBe(502);
      expect(await r.text()).not.toContain("SECRET-KEY");
      expect(inserted).toHaveLength(0);
    }
  });
  it("retries on 503 overload and succeeds without storing duplicates", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let n = 0;
    const { deps, inserted, callGemini } = makeDeps({
      gemini: async () =>
        ++n < 2
          ? { status: 503, json: { error: { message: "high demand" } } }
          : { status: 200, json: { candidates: [{ content: { parts: [{ text: "ok after retry" }] } }] } },
    });
    const r = await handleChat(post(good), deps);
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).reply).toBe("ok after retry");
    expect(callGemini).toHaveBeenCalledTimes(2);
    expect(inserted).toHaveLength(2);
    spy.mockRestore();
  });
  it("falls back to another model on the third attempt and reports the 503 when all fail", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, callGemini } = makeDeps({
      env: { GEMINI_API_KEY: "SECRET-KEY", GEMINI_MODEL: "primary-model", GEMINI_FALLBACK_MODEL: "fallback-model" },
      gemini: async () => ({ status: 503, json: { error: { message: "high demand" } } }),
    });
    const r = await handleChat(post(good), deps);
    expect(r.status).toBe(502);
    expect(await r.text()).toContain("HTTP 503");
    expect(callGemini).toHaveBeenCalledTimes(3);
    const urls = callGemini.mock.calls.map((c: any[]) => c[0].url as string);
    expect(urls[0]).toContain("primary-model");
    expect(urls[1]).toContain("primary-model");
    expect(urls[2]).toContain("fallback-model");
    spy.mockRestore();
  });
  it("500 when key missing, without echoing anything secret", async () => {
    const { deps, callGemini } = makeDeps({ env: {} });
    const r = await handleChat(post(good), deps);
    expect(r.status).toBe(500);
    expect(callGemini).not.toHaveBeenCalled();
  });
  it("429 when rate limit exceeded", async () => {
    const { deps, callGemini } = makeDeps({ count: RATE_LIMIT_PER_MINUTE });
    expect((await handleChat(post(good), deps)).status).toBe(429);
    expect(callGemini).not.toHaveBeenCalled();
  });
  it("405 on GET", async () => {
    const r = await handleChat(new Request("http://x", { method: "GET" }), makeDeps().deps);
    expect(r.status).toBe(405);
  });
});
