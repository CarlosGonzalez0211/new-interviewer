import { describe, it, expect, vi } from "vitest";
import { parseCreateRequest, normalizeEmail } from "./validate.ts";
import {
  handleCreateInterview,
  resolveSiteUrl,
  DEFAULT_SITE_URL,
  MAX_REQUESTS_PER_IP_PER_HOUR,
  MAX_SESSIONS_PER_EMAIL_PER_HOUR,
} from "./handler.ts";
import type { Deps } from "./handler.ts";

const Q = "123e4567-e89b-42d3-a456-426614174000";
const SID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const good = { question_id: Q, interviewer_email: "Alice@Example.com ", interviewee_email: "bob@example.com" };

function makeDeps(
  over: {
    question?: boolean;
    ipCount?: number;
    emailCounts?: Record<string, number>;
    send?: (email: string, url: string) => Promise<string | null>;
    env?: { SITE_URL?: string };
  } = {},
) {
  const sends: { email: string; url: string }[] = [];
  const requests: { ip: string; emails: string[] }[] = [];
  const created: any[] = [];
  const deps: Deps = {
    data: {
      questionExists: async () => over.question ?? true,
      countRequestsByIpSince: vi.fn(async () => over.ipCount ?? 0),
      countRequestsByEmailSince: vi.fn(async (e: string) => over.emailCounts?.[e] ?? 0),
      insertRequest: async (ip, emails) => void requests.push({ ip, emails }),
      createSession: async (a) => (created.push(a), { id: SID }),
    },
    sendMagicLink: async (email, url) => {
      sends.push({ email, url });
      return over.send ? over.send(email, url) : null;
    },
    now: () => new Date("2026-10-12T12:00:00Z"),
    env: over.env ?? {},
  };
  return { deps, sends, requests, created };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://x/create-interview", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("validate", () => {
  it("normalizes emails and question id", () => {
    expect(parseCreateRequest(good)).toEqual({
      ok: true,
      value: { question_id: Q, interviewer_email: "alice@example.com", interviewee_email: "bob@example.com" },
    });
  });
  it.each([
    [null], ["x"], [[]], [{}],
    [{ ...good, question_id: "nope" }],
    [{ ...good, interviewer_email: "not-an-email" }],
    [{ ...good, interviewee_email: "a b@c.com" }],
    [{ ...good, interviewee_email: 5 }],
    [{ ...good, interviewee_email: "ALICE@example.com" }],
  ])("rejects %j", (b) => {
    expect(parseCreateRequest(b).ok).toBe(false);
  });
  it("normalizeEmail rejects overly long values", () => {
    expect(normalizeEmail("a".repeat(250) + "@x.com")).toBeNull();
    expect(normalizeEmail(" X@Y.io ")).toBe("x@y.io");
  });
});

describe("resolveSiteUrl", () => {
  it("defaults, honours env, accepts only localhost:5173 or SITE_URL origin", () => {
    expect(resolveSiteUrl(null)).toBe(DEFAULT_SITE_URL);
    expect(resolveSiteUrl(null, "https://a.test/")).toBe("https://a.test");
    expect(resolveSiteUrl("http://localhost:5173")).toBe("http://localhost:5173");
    expect(resolveSiteUrl("https://a.test", "https://a.test")).toBe("https://a.test");
    expect(resolveSiteUrl("https://evil.example", "https://a.test")).toBe("https://a.test");
    expect(resolveSiteUrl("http://localhost:3000")).toBe(DEFAULT_SITE_URL);
  });
});

describe("handleCreateInterview", () => {
  it("handles OPTIONS and rejects other methods", async () => {
    const { deps } = makeDeps();
    const o = await handleCreateInterview(new Request("http://x", { method: "OPTIONS" }), deps);
    expect(o.status).toBe(204);
    expect(o.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect((await handleCreateInterview(new Request("http://x"), deps)).status).toBe(405);
  });

  it("400 on bad JSON and invalid input, without touching the database", async () => {
    const { deps, requests, created } = makeDeps();
    expect((await handleCreateInterview(post("{nope"), deps)).status).toBe(400);
    const same = await handleCreateInterview(
      post({ ...good, interviewee_email: "alice@example.com" }),
      deps,
    );
    expect(same.status).toBe(400);
    expect(((await same.json()) as any).error).toMatch(/different/);
    expect((await handleCreateInterview(post({ ...good, interviewer_email: "x" }), deps)).status).toBe(400);
    expect(requests).toHaveLength(0);
    expect(created).toHaveLength(0);
  });

  it("404 for an unknown question", async () => {
    const { deps, created, sends } = makeDeps({ question: false });
    const r = await handleCreateInterview(post(good), deps);
    expect(r.status).toBe(404);
    expect(created).toHaveLength(0);
    expect(sends).toHaveLength(0);
  });

  it("429 once the IP limit is reached", async () => {
    const { deps, created, sends } = makeDeps({ ipCount: MAX_REQUESTS_PER_IP_PER_HOUR });
    const r = await handleCreateInterview(post(good), deps);
    expect(r.status).toBe(429);
    expect(((await r.json()) as any).error).toMatch(/try again/i);
    expect(created).toHaveLength(0);
    expect(sends).toHaveLength(0);
  });

  it("429 once a recipient email limit is reached (either slot)", async () => {
    for (const email of ["alice@example.com", "bob@example.com"]) {
      const { deps, created } = makeDeps({ emailCounts: { [email]: MAX_SESSIONS_PER_EMAIL_PER_HOUR } });
      const r = await handleCreateInterview(post(good), deps);
      expect(r.status).toBe(429);
      expect(created).toHaveLength(0);
    }
    const ok = makeDeps({ emailCounts: { "alice@example.com": MAX_SESSIONS_PER_EMAIL_PER_HOUR - 1 } });
    expect((await handleCreateInterview(post(good), ok.deps)).status).toBe(200);
  });

  it("uses the first x-forwarded-for hop for the IP and records the request", async () => {
    const { deps, requests } = makeDeps();
    await handleCreateInterview(post(good, { "x-forwarded-for": "1.2.3.4, 10.0.0.1" }), deps);
    expect(deps.data.countRequestsByIpSince).toHaveBeenCalledWith("1.2.3.4", "2026-10-12T11:00:00.000Z");
    expect(requests).toEqual([{ ip: "1.2.3.4", emails: ["alice@example.com", "bob@example.com"] }]);
  });

  it("creates the session and mails both links on success", async () => {
    const { deps, sends, created } = makeDeps({ env: { SITE_URL: "https://a.test" } });
    const r = await handleCreateInterview(post(good), deps);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ session_id: SID, sent: { interviewer: true, interviewee: true } });
    expect(created).toEqual([
      { question_id: Q, interviewer_email: "alice@example.com", interviewee_email: "bob@example.com" },
    ]);
    expect(sends.map((s) => s.email).sort()).toEqual(["alice@example.com", "bob@example.com"]);
    for (const s of sends) expect(s.url).toBe(`https://a.test/session/${SID}`);
  });

  it("redirects to localhost:5173 when that is the request origin", async () => {
    const { deps, sends } = makeDeps();
    await handleCreateInterview(post(good, { Origin: "http://localhost:5173" }), deps);
    expect(sends[0].url).toBe(`http://localhost:5173/session/${SID}`);
  });

  it("still returns 200 when one send fails, without leaking the error", async () => {
    const { deps } = makeDeps({
      send: async (email) => (email === "bob@example.com" ? "email rate limit exceeded: secret-internal" : null),
    });
    const r = await handleCreateInterview(post(good), deps);
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.session_id).toBe(SID);
    expect(body.sent).toEqual({ interviewer: true, interviewee: false });
    expect(Object.keys(body.errors)).toEqual(["interviewee"]);
    expect(JSON.stringify(body)).not.toMatch(/secret-internal/);
  });

  it("returns 200 with both flags false when sending throws", async () => {
    const { deps } = makeDeps({
      send: async () => {
        throw new Error("boom");
      },
    });
    const body = (await (await handleCreateInterview(post(good), deps)).json()) as any;
    expect(body.sent).toEqual({ interviewer: false, interviewee: false });
    expect(Object.keys(body.errors).sort()).toEqual(["interviewee", "interviewer"]);
  });

  it("500 with a generic message when storage fails", async () => {
    const { deps } = makeDeps();
    deps.data.createSession = async () => {
      throw new Error("db password leaked");
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await handleCreateInterview(post(good), deps);
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toMatch(/leaked/);
  });
});
