// Pure prompt-building helpers. No Deno globals.

export interface QuestionInfo {
  title: string;
  prompt: string;
  constraints?: string | null;
}

export interface CodeFile {
  path: string;
  content: string;
  kind?: string; // 'code' | 'test'
}

export interface HistoryMessage {
  role: "user" | "model";
  content: string;
}

export const HISTORY_LIMIT = 30;

export function formatCodeContext(files: CodeFile[]): string {
  if (!files.length) return "(no files)";
  return [...files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => {
      const label = f.kind === "test" ? "test file" : "source file";
      return `=== ${f.path} (${label}) ===\n${f.content}\n=== end of ${f.path} ===`;
    })
    .join("\n\n");
}

export function buildSystemInstruction(
  question: QuestionInfo,
  files: CodeFile[] = [],
): string {
  const parts = [
    "You are a pair-programming assistant embedded in a coding exercise. The user is a candidate working on the codebase below.",
    "Help freely with the codebase: explain how it works, answer questions, suggest approaches, and write or fix code whenever asked.",
    "Be concise. Prefer short answers and focused code snippets over long essays.",
    "The code shown below is the candidate's CURRENT working copy of the files (it may differ from earlier messages in the conversation, and it may contain mistakes). Treat it as the source of truth.",
    "You have no knowledge of any hidden reference solution, answer key, or list of known bugs. Do not claim or imply that you have one; reason only from the problem brief, the code, and the tests.",
    "",
    "## Problem brief",
    `Title: ${question.title}`,
    question.prompt,
  ];
  if (question.constraints && question.constraints.trim()) {
    parts.push("", "## Constraints", question.constraints);
  }
  parts.push("", "## Current files", formatCodeContext(files));
  return parts.join("\n");
}

/**
 * Keep the last `limit` messages, drop leading model turns, and merge
 * consecutive same-role turns so the result strictly alternates user/model
 * starting with user (as Gemini expects).
 */
export function trimHistory(
  messages: HistoryMessage[],
  limit: number = HISTORY_LIMIT,
): HistoryMessage[] {
  const recent = limit > 0 ? messages.slice(-limit) : [];
  const out: HistoryMessage[] = [];
  for (const m of recent) {
    if (!m.content || !m.content.trim()) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content += "\n\n" + m.content;
    } else if (out.length === 0 && m.role !== "user") {
      continue;
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}
