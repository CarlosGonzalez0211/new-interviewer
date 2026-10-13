import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import type { SessionPhase } from '../types/db'
import { bytesToBase64, tryBase64ToBytes } from './b64'
import { DocSync } from './docSync'
import { ORIGIN_DB, ORIGIN_SEED } from './origins'
import { createSaver } from './saver'
import { applySeed, ensureFilesSeeded } from './seed'
import { sessionBus } from './supabaseBus'
import type { BusHandle } from './bus'
import type { Collab, CollabStatus, CollabUser } from './types'
import {
  loadSessionFilesForSeed,
  loadWorkspace,
  updateFileContent,
  updateFileKeepalive,
  upsertWorkspace,
  upsertWorkspaceKeepalive,
  watchAccessToken,
} from './workspaceApi'

export const PERSIST_DELAY_MS = 2000

export interface CollabHandle {
  collab: Collab
  setPhase(phase: SessionPhase): void
  setUser(user: CollabUser): void
  destroy(): void
}

export interface StartArgs {
  sessionId: string
  phase: SessionPhase
  user: CollabUser
  /** Called whenever status/editable changed so a React hook can re-render. */
  onChange: () => void
}

/**
 * Load order: (1) session_workspace.yjs_state, else (2) deterministic seed from session_files + notes,
 * (3) join the channel and run sync step 1/2 with peers. Persistence is a 2s trailing debounce to
 * session_workspace (+ session_files.content while debugging), flushed on destroy and on page hide.
 */
export async function startCollabSession(args: StartArgs): Promise<CollabHandle> {
  const { sessionId, onChange } = args
  let phase = args.phase
  let user = args.user

  const doc = new Y.Doc()
  const awareness = new Awareness(doc)
  const notes = doc.getText('notes')
  const filesMap = doc.getMap<Y.Text>('files')

  const [row, files] = await Promise.all([loadWorkspace(sessionId), loadSessionFilesForSeed(sessionId)])
  const savedFiles: Record<string, string> = Object.fromEntries(files.map((f) => [f.path, f.content]))

  let loaded = false
  const stateBytes = row?.yjs_state ? tryBase64ToBytes(row.yjs_state) : null
  if (stateBytes) {
    try {
      Y.applyUpdate(doc, stateBytes, ORIGIN_DB)
      loaded = true
    } catch {
      loaded = false
    }
  }
  if (!loaded) applySeed(doc, files, row?.notes ?? '')
  else if (phase === 'debugging') ensureFilesSeeded(doc, files)

  let destroyed = false
  let connected = false
  let bus: BusHandle | null = null
  let sync: DocSync | null = null
  const cleanups: (() => void)[] = []

  const editable = () => phase !== 'completed'
  const computeStatus = (): CollabStatus => {
    if (!editable()) return 'readonly'
    return connected ? 'live' : bus ? 'offline' : 'connecting'
  }

  const collab: Collab = {
    doc,
    awareness,
    status: 'loading',
    editable: editable(),
    notes,
    fileText: (path) => filesMap.get(path),
    filePaths: () => [...filesMap.keys()].sort(),
    flush: () => {
      if (!editable()) return Promise.resolve()
      saver.mark()
      return saver.flush()
    },
    destroy: () => destroy(),
  }

  const refresh = () => {
    const status = computeStatus()
    const ed = editable()
    if (status !== collab.status || ed !== collab.editable) {
      collab.status = status
      collab.editable = ed
      onChange()
    }
  }

  // ---- persistence ----
  const changedFiles = (): { path: string; content: string }[] => {
    const out: { path: string; content: string }[] = []
    for (const path of filesMap.keys()) {
      const content = filesMap.get(path)!.toString()
      if (savedFiles[path] !== content) out.push({ path, content })
    }
    return out
  }

  const saver = createSaver({
    delayMs: PERSIST_DELAY_MS,
    save: async () => {
      if (!editable()) return
      // Merge whatever the other participant persisted before overwriting (Yjs state is a CRDT union).
      const current = await loadWorkspace(sessionId)
      const bytes = current?.yjs_state ? tryBase64ToBytes(current.yjs_state) : null
      if (bytes) {
        try {
          Y.applyUpdate(doc, bytes, ORIGIN_DB)
        } catch {
          // ignore a corrupt remote row; we overwrite it with our valid state
        }
      }
      await upsertWorkspace(sessionId, {
        notes: notes.toString(),
        yjs_state: bytesToBase64(Y.encodeStateAsUpdate(doc)),
      })
      if (phase === 'debugging') {
        for (const f of changedFiles()) {
          await updateFileContent(sessionId, f.path, f.content)
          savedFiles[f.path] = f.content
        }
      }
    },
  })

  const onDocUpdate = (_u: Uint8Array, origin: unknown) => {
    if (origin === ORIGIN_DB || origin === ORIGIN_SEED) return
    if (editable()) saver.mark()
  }
  doc.on('update', onDocUpdate)
  cleanups.push(() => doc.off('update', onDocUpdate))

  const keepaliveFlush = () => {
    if (destroyed || !editable() || !saver.isDirty()) return
    upsertWorkspaceKeepalive(sessionId, {
      notes: notes.toString(),
      yjs_state: bytesToBase64(Y.encodeStateAsUpdate(doc)),
    })
    if (phase === 'debugging') for (const f of changedFiles()) updateFileKeepalive(sessionId, f.path, f.content)
  }
  if (typeof window !== 'undefined') {
    watchAccessToken()
    window.addEventListener('pagehide', keepaliveFlush)
    window.addEventListener('beforeunload', keepaliveFlush)
    cleanups.push(() => {
      window.removeEventListener('pagehide', keepaliveFlush)
      window.removeEventListener('beforeunload', keepaliveFlush)
    })
  }

  // ---- awareness identity ----
  const publishUser = () =>
    awareness.setLocalStateField('user', { id: user.id, name: user.name, color: user.color, role: user.role })
  publishUser()

  // ---- realtime ----
  if (editable()) {
    bus = sessionBus.acquire(sessionId)
    sync = new DocSync({
      doc,
      awareness,
      selfId: user.id,
      transport: { send: (e, p) => bus!.send(e, p) },
      canWrite: editable,
    })
    cleanups.push(bus.onEvent((e, p) => sync!.handle(e, p)))
    cleanups.push(
      bus.onConnected((c) => {
        connected = c
        // (Re)connected: re-run sync step 1/2 so offline edits converge in both directions.
        if (c) sync!.start()
        refresh()
      }),
    )
  }

  // Anything in the doc that the plain session_files do not reflect yet gets written once.
  if (editable() && phase === 'debugging' && changedFiles().length > 0) {
    saver.mark()
  }
  refresh()
  collab.status = computeStatus()

  function destroy() {
    if (destroyed) return
    destroyed = true
    for (const c of cleanups.splice(0)) c()
    sync?.destroy()
    bus?.release()
    const finish = () => {
      saver.dispose()
      awareness.destroy()
      doc.destroy()
    }
    if (saver.isDirty() && editable()) void saver.flush().then(finish, finish)
    else finish()
  }

  return {
    collab,
    setPhase(next) {
      if (destroyed || next === phase) return
      phase = next
      if (next === 'debugging') {
        saver.mark() // push file contents now that RLS allows it
        // session_files may have just been created: add any file the shared doc does not have yet.
        void loadSessionFilesForSeed(sessionId)
          .then((fresh) => {
            if (destroyed || phase !== 'debugging') return
            for (const f of fresh) savedFiles[f.path] ??= f.content
            if (ensureFilesSeeded(doc, fresh).length > 0) {
              onChange()
              saver.mark()
            }
          })
          .catch(() => undefined)
      }
      refresh()
    },
    setUser(next) {
      user = next
      publishUser()
    },
    destroy,
  }
}
