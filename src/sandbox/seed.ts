import type { FakeDb } from './fake/db'
import { stableUuid } from './fake/ids'

/** Raw question sources keyed by their path below supabase/questions/ (e.g. "potluck-raffle/buggy/raffle.py"). */
export type QuestionSources = Record<string, string>

interface QuestionMeta {
  title: string
  prompt: string
  constraints?: string
  language?: string
  checklist?: string[]
  followups?: string[]
  rubric?: { id: string; label: string; weight: number }[]
  bugs?: { title: string; description: string; file_path: string; hint?: string }[]
}

const norm = (s: string) => s.replace(/\r\n/g, '\n')

/**
 * Vite inlines the real question sources at build time. Kept in a function so importing this module in a plain
 * Node script (without Vite) still works until the glob is actually needed.
 */
export function bundledQuestionSources(): QuestionSources {
  const raw = import.meta.glob('../../supabase/questions/**/*.{py,json}', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>
  const out: QuestionSources = {}
  const marker = '/supabase/questions/'
  for (const [path, text] of Object.entries(raw)) {
    const i = path.indexOf(marker)
    if (i >= 0) out[path.slice(i + marker.length)] = text
  }
  return out
}

/**
 * Mirror of supabase/scripts/build_seed.py: questions, question_private, question_files (buggy/tests),
 * question_reference_files (reference/ plus acceptance/ paths) and question_bugs, with stable ids.
 * Returns the question slugs that were seeded, in alphabetical order.
 */
export function seedQuestions(db: FakeDb, sources: QuestionSources): string[] {
  const bySlug = new Map<string, Map<string, string>>()
  for (const [path, text] of Object.entries(sources)) {
    const [slug, ...rest] = path.split('/')
    if (!slug || rest.length === 0) continue
    if (!bySlug.has(slug)) bySlug.set(slug, new Map())
    bySlug.get(slug)!.set(rest.join('/'), norm(text))
  }

  const slugs = [...bySlug.keys()].filter((s) => bySlug.get(s)!.has('question.json')).sort()
  for (const slug of slugs) {
    const files = bySlug.get(slug)!
    const meta = JSON.parse(files.get('question.json')!) as QuestionMeta
    const qid = stableUuid('question', slug)
    db.insert('questions', {
      id: qid,
      slug,
      title: meta.title,
      prompt: meta.prompt,
      constraints: meta.constraints ?? '',
      language: meta.language ?? 'python',
    })
    db.insert('question_private', {
      question_id: qid,
      checklist: meta.checklist ?? [],
      followups: meta.followups ?? [],
      rubric: meta.rubric ?? [],
    })

    const inDir = (dir: string) =>
      [...files.entries()]
        .filter(([p]) => p.startsWith(`${dir}/`) && p.endsWith('.py') && !p.slice(dir.length + 1).includes('/'))
        .map(([p, content]) => ({ name: p.slice(dir.length + 1), content }))
        .sort((a, b) => (a.name < b.name ? -1 : 1))

    for (const [kind, dir] of [['buggy', 'buggy'], ['test', 'tests']] as const) {
      for (const f of inDir(dir)) {
        db.insert('question_files', {
          id: stableUuid('file', slug, kind, f.name),
          question_id: qid,
          path: f.name,
          content: f.content,
          kind,
        })
      }
    }
    const reference = [
      ...inDir('reference'),
      ...inDir('acceptance').map((f) => ({ name: `acceptance/${f.name}`, content: f.content })),
    ].sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const f of reference) {
      db.insert('question_reference_files', {
        id: stableUuid('ref', slug, f.name),
        question_id: qid,
        path: f.name,
        content: f.content,
      })
    }
    ;(meta.bugs ?? []).forEach((b, i) => {
      db.insert('question_bugs', {
        id: stableUuid('bug', slug, String(i)),
        question_id: qid,
        title: b.title,
        description: b.description,
        file_path: b.file_path,
        hint: b.hint ?? '',
      })
    })
  }
  return slugs
}
