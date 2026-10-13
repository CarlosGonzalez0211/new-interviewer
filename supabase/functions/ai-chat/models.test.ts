import { describe, it, expect, vi } from "vitest";
import { parseChatRequest } from "./validate.ts";
import { handleChat } from "./handler.ts";
import type { Deps } from "./handler.ts";
import { FALLBACK_MODELS, buildAttemptChain, collectModels, createModelsCache, filterModels } from "./models.ts";

const SID = "123e4567-e89b-42d3-a456-426614174000";
const USER = "user-1";
const T0 = Date.parse("2026-01-01T00:00:00Z");

type Json = { status: number; json: unknown };

function makeDeps(
  over: {
    user?: string | null;
    env?: Record<string, string>;
    gemini?: (req: any) => Promise<Json>;
    fetchJson?: (url: string, headers: Record<string, string>) => Promise<Json>;
    now?: () => Date;
  } = {},
) {
  const inserted: { role: string; content: string; model?: string }[] = [];
  const callGemini = vi.fn(
    over.gemini ??
      (async () => ({ status: 200, json: { candidates: [{ content: { parts: [{ text: "r" }] } }] } })),
  );
  const deps: Deps = {
    getUser: async () => (over.user === null ? null : { id: over.user ?? USER }),
    data: {
      getSession: async () => ({ id: SID, question_id: "q1", interviewee_id: USER, phase: "debugging" }),
      getQuestion: async () => ({ title: "T", prompt: "P", constraints: "C" }),
      getSessionFiles: async () => [],
      getHistory: async () => [],
      countUserMessagesSince: async () => 0,
      insertMessage: async (_s, role, content, model) => {
        inserted.push(model === undefined ? { role, content } : { role, content, model });
        return { id: `msg-${inserted.length}` };
      },
    },
    callGemini: callGemini as any,
    fetchJson: over.fetchJson,
    modelsCache: createModelsCache(),
    now: over.now ?? (() => new Date(T0)),
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

const listed = (name: string, methods: string[] = ["generateContent"], displayName?: string) => ({
  name: `models/${name}`,
  supportedGenerationMethods: methods,
  ...(displayName ? { displayName } : {}),
});

describe("validate model param", () => {
  it("accepts an optional valid model and omits it otherwise", () => {
    expect(parseChatRequest({ session_id: SID, message: "hi", model: "gemini-2.5-pro" })).toEqual({
      ok: true,
      value: { session_id: SID, message: "hi", model: "gemini-2.5-pro" },
    });
    expect(parseChatRequest({ session_id: SID, message: "hi", model: null })).toEqual({
      ok: true,
      value: { session_id: SID, message: "hi" },
    });
  });
  it.each([[""], ["Gemini"], ["-x"], ["a/b"], ["a b"], ["models/gemini-x"], ["a".repeat(65)], [5], [{}], ["a?b=1"]])(
    "rejects model %j",
    (model) => {
      expect(parseChatRequest({ session_id: SID, message: "hi", model }).ok).toBe(false);
    },
  );
  it("allows 64 chars and dotted ids", () => {
    expect(parseChatRequest({ session_id: SID, message: "hi", model: "a".repeat(64) }).ok).toBe(true);
    expect(parseChatRequest({ session_id: SID, message: "hi", model: "gemini-3.8-flash" }).ok).toBe(true);
  });
  it("handler answers 400 for a bad model and never calls Gemini", async () => {
    const { deps, callGemini } = makeDeps();
    const r = await handleChat(post({ ...good, model: "../evil" }), deps);
    expect(r.status).toBe(400);
    expect(callGemini).not.toHaveBeenCalled();
  });
});

describe("models filtering", () => {
  it("keeps usable gemini chat models, strips the prefix, flash first then alphabetical", () => {
    const out = filterModels([
      listed("gemini-2.5-pro"),
      listed("gemini-3.8-flash", ["generateContent", "countTokens"], "Gemini 3.8 Flash"),
      listed("gemini-embedding-001", ["embedContent"]),
      listed("gemini-2.5-flash-image"),
      listed("gemini-2.5-flash-preview-tts"),
      listed("gemini-live-2.5-flash"),
      listed("gemini-2.5-flash-native-audio"),
      listed("gemini-robotics-er-1.5"),
      listed("gemini-2.5-computer-use"),
      listed("aqa"),
      listed("gemma-3-27b-it"),
      listed("gemini-no-methods", ["countTokens"]),
      listed("gemini-flash-latest"),
      listed("gemini-2.5-flash-lite"),
      listed("gemini-2.5-flash-lite"),
      { name: 5 },
      null,
    ]);
    expect(out.map((m) => m.id)).toEqual([
      "gemini-2.5-flash-lite",
      "gemini-3.8-flash",
      "gemini-flash-latest",
      "gemini-2.5-pro",
    ]);
    expect(out.find((m) => m.id === "gemini-3.8-flash")?.label).toBe("Gemini 3.8 Flash");
    expect(out.find((m) => m.id === "gemini-2.5-pro")?.label).toBe("Gemini 2.5 Pro");
    expect(filterModels("nope")).toEqual([]);
  });
  it("collectModels follows nextPageToken up to 4 pages", async () => {
    const urls: string[] = [];
    const out = await collectModels(async (url) => {
      urls.push(url);
      return { status: 200, json: { models: [listed(`gemini-p${urls.length}-flash`)], nextPageToken: "more" } };
    });
    expect(urls).toHaveLength(4);
    expect(urls[0]).toBe("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200");
    expect(urls[1]).toContain("pageToken=more");
    expect(out).toHaveLength(4);
  });
  it("collectModels returns null when the first page fails or nothing is usable", async () => {
    expect(await collectModels(async () => ({ status: 500, json: {} }))).toBeNull();
    expect(
      await collectModels(async () => {
        throw new Error("net");
      }),
    ).toBeNull();
    expect(
      await collectModels(async () => ({ status: 200, json: { models: [listed("gemini-embedding-1", ["embedContent"])] } })),
    ).toBeNull();
  });
  it("buildAttemptChain skips the primary in the fallbacks", () => {
    expect(buildAttemptChain("gemini-flash-latest")).toEqual([
      "gemini-flash-latest",
      "gemini-flash-latest",
      "gemini-flash-lite-latest",
    ]);
    expect(buildAttemptChain(undefined, "x,y")).toEqual([undefined, undefined, "x", "y"]);
  });
});

describe("handler models action", () => {
  const ok = (models: unknown[], next?: string): Json => ({
    status: 200,
    json: { models, ...(next ? { nextPageToken: next } : {}) },
  });
  const modelsReq = (auth: string | null = "Bearer tok") => post({ action: "models" }, auth);

  it("401 without a valid JWT", async () => {
    const fetchJson = vi.fn();
    expect((await handleChat(modelsReq(null), makeDeps({ fetchJson }).deps)).status).toBe(401);
    expect((await handleChat(modelsReq(), makeDeps({ user: null, fetchJson }).deps)).status).toBe(401);
    expect(fetchJson).not.toHaveBeenCalled();
  });
  it("returns the filtered list from Google with the effective default, sending the key as a header", async () => {
    const fetchJson = vi.fn(async (_url: string, _h: Record<string, string>) =>
      ok([
        listed("gemini-2.5-pro"),
        listed("gemini-3.8-flash", ["generateContent"], "Gemini 3.8 Flash"),
        listed("gemini-embedding-001", ["embedContent"]),
      ]),
    );
    const r = await handleChat(modelsReq(), makeDeps({ fetchJson }).deps);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      models: [
        { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
        { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      ],
      default: "gemini-3.8-flash",
    });
    const [url, headers] = fetchJson.mock.calls[0];
    expect(url).not.toContain("SECRET-KEY");
    expect(headers["x-goog-api-key"]).toBe("SECRET-KEY");
  });
  it("reports GEMINI_MODEL as the default and follows pagination", async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce(ok([listed("gemini-a-flash")], "t2"))
      .mockResolvedValueOnce(ok([listed("gemini-b-pro")]));
    const { deps } = makeDeps({ fetchJson, env: { GEMINI_API_KEY: "K", GEMINI_MODEL: "gemini-b-pro" } });
    const body = (await (await handleChat(modelsReq(), deps)).json()) as any;
    expect(fetchJson).toHaveBeenCalledTimes(2);
    expect(body.models.map((m: any) => m.id)).toEqual(["gemini-a-flash", "gemini-b-pro"]);
    expect(body.default).toBe("gemini-b-pro");
  });
  it("caches for 10 minutes, then refetches", async () => {
    let t = T0;
    const fetchJson = vi.fn(async () => ok([listed("gemini-x-flash")]));
    const { deps } = makeDeps({ fetchJson, now: () => new Date(t) });
    await handleChat(modelsReq(), deps);
    t += 9 * 60_000;
    await handleChat(modelsReq(), deps);
    expect(fetchJson).toHaveBeenCalledTimes(1);
    t += 2 * 60_000;
    await handleChat(modelsReq(), deps);
    expect(fetchJson).toHaveBeenCalledTimes(2);
  });
  it("degrades to the static list when listing fails (not cached), also without a key", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ status: 500, json: {} })
      .mockResolvedValueOnce(ok([listed("gemini-x-flash")]));
    const { deps } = makeDeps({ fetchJson });
    const first = (await (await handleChat(modelsReq(), deps)).json()) as any;
    expect(first).toEqual({ models: FALLBACK_MODELS, default: "gemini-3.8-flash", degraded: true });
    expect(first.models.map((m: any) => m.id)).toEqual([
      "gemini-3.8-flash",
      "gemini-flash-latest",
      "gemini-flash-lite-latest",
    ]);
    const second = (await (await handleChat(modelsReq(), deps)).json()) as any;
    expect(second.degraded).toBeUndefined();
    expect(second.models.map((m: any) => m.id)).toEqual(["gemini-x-flash"]);

    const noKey = makeDeps({ env: {}, fetchJson });
    expect(((await (await handleChat(modelsReq(), noKey.deps)).json()) as any).degraded).toBe(true);

    const throwing = makeDeps({
      fetchJson: async () => {
        throw new Error("net SECRET-KEY");
      },
    });
    const th = await handleChat(modelsReq(), throwing.deps);
    expect(th.status).toBe(200);
    expect(await th.text()).not.toContain("SECRET-KEY");
    spy.mockRestore();
  });
});

describe("handler answering model", () => {
  const okJson = { candidates: [{ content: { parts: [{ text: "r" }] } }] };
  it("uses the requested model first, reports it and stores it on the model message", async () => {
    const { deps, inserted, callGemini } = makeDeps({ env: { GEMINI_API_KEY: "K", GEMINI_MODEL: "server-default" } });
    const r = await handleChat(post({ ...good, model: "gemini-2.5-pro" }), deps);
    const body = (await r.json()) as any;
    expect(body).toMatchObject({ reply: "r", model: "gemini-2.5-pro", fallback_used: false });
    expect(callGemini.mock.calls[0][0].url).toContain("/models/gemini-2.5-pro:generateContent");
    expect(inserted).toEqual([
      { role: "user", content: "help" },
      { role: "model", content: "r", model: "gemini-2.5-pro" },
    ]);
  });
  it("reports the server default when no model is requested", async () => {
    const { deps } = makeDeps({ env: { GEMINI_API_KEY: "K", GEMINI_MODEL: "server-default" } });
    const body = (await (await handleChat(post(good), deps)).json()) as any;
    expect(body).toMatchObject({ model: "server-default", fallback_used: false });
  });
  it("a retry on the same model is not a fallback", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let n = 0;
    const { deps } = makeDeps({
      gemini: async () => (++n < 2 ? { status: 503, json: {} } : { status: 200, json: okJson }),
    });
    const body = (await (await handleChat(post({ ...good, model: "picked" }), deps)).json()) as any;
    expect(body).toMatchObject({ model: "picked", fallback_used: false });
    spy.mockRestore();
  });
  it("reports the fallback model that actually answered and stores it", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, inserted, callGemini } = makeDeps({
      env: { GEMINI_API_KEY: "K", GEMINI_FALLBACK_MODEL: "fb-1,fb-2" },
      gemini: async (req: any) =>
        req.url.includes("/fb-2:") ? { status: 200, json: okJson } : { status: 404, json: { error: { message: "gone" } } },
    });
    const r = await handleChat(post({ ...good, model: "retired-model" }), deps);
    expect(r.status).toBe(200);
    expect((await r.json()) as any).toMatchObject({ reply: "r", model: "fb-2", fallback_used: true });
    expect(callGemini).toHaveBeenCalledTimes(4);
    expect(inserted[1].model).toBe("fb-2");
    spy.mockRestore();
  });
  it("does not repeat the requested model inside the fallback chain", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, callGemini } = makeDeps({ gemini: async () => ({ status: 503, json: {} }) });
    const r = await handleChat(post({ ...good, model: "gemini-flash-latest" }), deps);
    expect(r.status).toBe(502);
    const urls = callGemini.mock.calls.map((c: any[]) => c[0].url as string);
    expect(urls.filter((u) => u.includes("/gemini-flash-latest:"))).toHaveLength(2);
    expect(urls).toHaveLength(3);
    spy.mockRestore();
  });
});
