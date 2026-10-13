// Deno entrypoint: wires real dependencies into handleChat.
import { createClient } from "npm:@supabase/supabase-js@2";
import { handleChat } from "./handler.ts";
import type { Deps } from "./handler.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const anon = createClient(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// deno-lint-ignore no-explicit-any
function must<T>(res: { data: T | null; error: { message: string } | null }): T | null {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

const deps: Deps = {
  async getUser(jwt) {
    const { data, error } = await anon.auth.getUser(jwt);
    if (error || !data.user) return null;
    return { id: data.user.id };
  },
  data: {
    async getSession(id) {
      return must(
        await admin
          .from("sessions")
          .select("id, question_id, interviewee_id, phase")
          .eq("id", id)
          .maybeSingle(),
      );
    },
    async getQuestion(questionId) {
      return must(
        await admin
          .from("questions")
          .select("title, prompt, constraints")
          .eq("id", questionId)
          .maybeSingle(),
      );
    },
    async getSessionFiles(sessionId) {
      return must(
        await admin
          .from("session_files")
          .select("path, content, kind")
          .eq("session_id", sessionId),
      ) ?? [];
    },
    async getHistory(sessionId, limit) {
      const rows = must(
        await admin
          .from("ai_messages")
          .select("role, content")
          .eq("session_id", sessionId)
          .order("created_at", { ascending: false })
          .limit(limit),
      ) ?? [];
      return (rows as { role: "user" | "model"; content: string }[]).reverse();
    },
    async countUserMessagesSince(sessionId, sinceIso) {
      const { count, error } = await admin
        .from("ai_messages")
        .select("id", { count: "exact", head: true })
        .eq("session_id", sessionId)
        .eq("role", "user")
        .gte("created_at", sinceIso);
      if (error) throw new Error(error.message);
      return count ?? 0;
    },
    async insertMessage(sessionId, role, content) {
      const row = must(
        await admin
          .from("ai_messages")
          .insert({ session_id: sessionId, role, content })
          .select("id")
          .single(),
      );
      return { id: (row as { id: string }).id };
    },
  },
  async callGemini(req) {
    const res = await fetch(req.url, req.init);
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, json: body };
  },
  now: () => new Date(),
  env: {
    GEMINI_API_KEY: Deno.env.get("GEMINI_API_KEY") ?? undefined,
    GEMINI_MODEL: Deno.env.get("GEMINI_MODEL") ?? undefined,
    GEMINI_FALLBACK_MODEL: Deno.env.get("GEMINI_FALLBACK_MODEL") ?? undefined,
  },
};

Deno.serve((req) => handleChat(req, deps));
