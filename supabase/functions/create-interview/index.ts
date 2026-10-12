// Deno entrypoint: wires real dependencies into handleCreateInterview.
import { createClient } from "npm:@supabase/supabase-js@2";
import { handleCreateInterview } from "./handler.ts";
import type { Deps } from "./handler.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(url, serviceKey, opts);
const anon = createClient(url, anonKey, opts);

const deps: Deps = {
  data: {
    async questionExists(id) {
      const { data, error } = await admin.from("questions").select("id").eq("id", id).maybeSingle();
      if (error) throw new Error(error.message);
      return !!data;
    },
    async countRequestsByIpSince(ip, since) {
      const { count, error } = await admin
        .from("interview_requests")
        .select("id", { count: "exact", head: true })
        .eq("ip", ip)
        .gte("created_at", since);
      if (error) throw new Error(error.message);
      return count ?? 0;
    },
    async countRequestsByEmailSince(email, since) {
      const { count, error } = await admin
        .from("interview_requests")
        .select("id", { count: "exact", head: true })
        .contains("emails", [email])
        .gte("created_at", since);
      if (error) throw new Error(error.message);
      return count ?? 0;
    },
    async insertRequest(ip, emails) {
      const { error } = await admin.from("interview_requests").insert({ ip, emails });
      if (error) throw new Error(error.message);
    },
    async createSession(args) {
      const { data, error } = await admin
        .from("sessions")
        .insert({ ...args, phase: "briefing", created_by: null, interviewer_id: null, interviewee_id: null })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return { id: (data as { id: string }).id };
    },
  },
  async sendMagicLink(email, redirectTo) {
    const { error } = await anon.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true, emailRedirectTo: redirectTo },
    });
    return error ? `${error.code ?? error.status ?? "error"}: ${error.message}` : null;
  },
  now: () => new Date(),
  env: { SITE_URL: Deno.env.get("SITE_URL") ?? undefined },
};

Deno.serve((req) => handleCreateInterview(req, deps));
