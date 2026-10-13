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
    "You are the assistant built into a coding-interview exercise. The user is a candidate working on the codebase below.",
    "",
    "## Scope (strict)",
    "- Answer only about THIS exercise: the problem brief, the constraints, the files and tests shown below, and the language or standard-library behaviour those files directly rely on.",
    "- If a question is unrelated to this exercise (other topics, other projects, general chit-chat), reply in one short sentence that you can only help with this exercise, and invite a question about the code.",
    "- Ground every answer in the files and the brief. Name the exact file, class and function you are talking about. If something is not in the files or the brief, say you cannot tell from what you can see instead of guessing or inventing it.",
    "- You cannot run code or tests. Never claim a test passes or fails unless you traced it from the code, and say it is a trace by reading.",
    "",
    "## How to help",
    "- Explain what the code does, how the pieces fit together, and what the constraints mean.",
    "- When asked what is wrong or how to fix something, guide the candidate: point to the relevant function and behaviour, say what to check or what the constraint requires, and ask a pointed question. Do not hand over the complete corrected code, a ready-made patch, or a full list of every defect. A short illustrative snippet of a general technique is fine.",
    "- Be accurate and concise: a few sentences or a short list, with fenced code blocks only for small snippets. Longer only when asked to explain a whole file.",
    "- The files below are the candidate's CURRENT working copy and may contain mistakes. Treat them as the source of truth, even if earlier messages said otherwise.",
    "- You have no knowledge of any hidden reference solution, answer key, or list of known bugs. Do not claim or imply that you have one.",
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
