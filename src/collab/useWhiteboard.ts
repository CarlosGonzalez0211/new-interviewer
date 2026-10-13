import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionPhase } from '../types/db'
import type { WbPointerEvent, WbSyncReplyEvent, WbUpdateEvent } from '../types/realtime'
import { createSaver } from './saver'
import type { Saver } from './saver'
import { sessionBus } from './supabaseBus'
import type { BusHandle } from './bus'
import type { CollabStatus, CollabUser } from './types'
import { filterElements, markKnown, mergeElements, shouldTakeRemote, takeChanged } from './wbMerge'
import type { VersionMap, WbElement } from './wbMerge'
import { loadWorkspace, upsertWorkspace, upsertWorkspaceKeepalive, watchAccessToken } from './workspaceApi'

export interface WhiteboardCollaborator {
  pointer?: { x: number; y: number; tool?: string }
  username: string
  color: { background: string; stroke: string }
}

export interface WhiteboardHandle {
  initialData: { elements: readonly unknown[]; appState?: Record<string, unknown> } | null
  onChange(elements: readonly unknown[], appState: Record<string, unknown>): void
  onPointerUpdate(p: { pointer: { x: number; y: number }; button: 'down' | 'up' }): void
  bindApi(api: unknown): void
  collaborators: Map<string, WhiteboardCollaborator>
  editable: boolean
  status: CollabStatus
}

const PERSIST_DELAY_MS = 2000
const SEND_THROTTLE_MS = 50
const POINTER_THROTTLE_MS = 40
const POINTER_TTL_MS = 15000

interface ExcalidrawApiLike {
  getSceneElementsIncludingDeleted(): readonly WbElement[]
  getAppState(): unknown
  updateScene(scene: Record<string, unknown>): void
}

type Reconcile = (local: readonly unknown[], remote: readonly unknown[], appState: unknown) => readonly WbElement[]

let excalidrawReconcile: Promise<Reconcile | null> | null = null
/** Lazy: never pulls the Excalidraw chunk until the board is actually in use. */
function loadReconcile(): Promise<Reconcile | null> {
  excalidrawReconcile ??= import('@excalidraw/excalidraw')
    .then((m) => ((m as { reconcileElements?: Reconcile }).reconcileElements ?? null))
    .catch(() => null)
  return excalidrawReconcile
}

type BoardData = { elements: readonly unknown[]; appState?: Record<string, unknown> }

export function useWhiteboard(session: { id: string; phase: SessionPhase }, user: CollabUser): WhiteboardHandle {
  const [initialData, setInitialData] = useState<BoardData | null>(null)
  const [collaborators, setCollaborators] = useState<Map<string, WhiteboardCollaborator>>(new Map())
  const [conn, setConn] = useState<'connecting' | 'live' | 'offline'>('connecting')

  const editable = session.phase !== 'completed'
  const editableRef = useRef(editable)
  const userRef = useRef(user)
  const apiRef = useRef<ExcalidrawApiLike | null>(null)
  const collaboratorsRef = useRef(collaborators)
  const apiAppliedRef = useRef<() => void>(() => undefined)
  const localRef = useRef<{
    onChange(elements: readonly unknown[], appState: Record<string, unknown>): void
    pointer(x: number, y: number, tool: string): void
    bind(api: ExcalidrawApiLike): void
  } | null>(null)

  useEffect(() => {
    editableRef.current = editable
  }, [editable])
  useEffect(() => {
    userRef.current = user
  }, [user])

  useEffect(() => {
    collaboratorsRef.current = collaborators
    apiAppliedRef.current()
  }, [collaborators])

  useEffect(() => {
    let cancelled = false
    const sessionId = session.id
    const selfId = user.id
    const latest = new Map<string, WbElement>()
    const known: VersionMap = new Map()
    const pending = new Map<string, WbElement>()
    const lastSeen = new Map<string, number>()
    let background: string | undefined
    let bus: BusHandle | null = null
    let sendTimer: ReturnType<typeof setTimeout> | null = null
    let pointerTimer: ReturnType<typeof setTimeout> | null = null
    let pendingPointer: { x: number; y: number; tool: string } | null = null
    let pruneTimer: ReturnType<typeof setInterval> | null = null
    let applyChain: Promise<void> = Promise.resolve()
    const cleanups: (() => void)[] = []
    let saver: Saver | null = null

    setInitialData(null)
    setConn('connecting')
    setCollaborators(new Map())

    const allElements = () => [...latest.values()]

    /** Push elements into the live scene with Excalidraw's reconcile semantics (no undo entry). */
    const pushToScene = (elements: readonly WbElement[]) => {
      const api = apiRef.current
      if (!api || elements.length === 0) return
      applyChain = applyChain
        .then(async () => {
          const reconcile = await loadReconcile()
          if (cancelled || apiRef.current !== api) return
          const local = api.getSceneElementsIncludingDeleted()
          const next = reconcile
            ? reconcile(local, elements, api.getAppState())
            : mergeElements(local, elements)
          api.updateScene({ elements: next, captureUpdate: 'NEVER' })
        })
        .catch(() => undefined)
    }

    /** Remote elements: keep the newer version of each, remember them as known, push to the scene. */
    const applyRemote = (incoming: readonly WbElement[]): WbElement[] => {
      const accepted: WbElement[] = []
      for (const r of incoming) {
        if (shouldTakeRemote(latest.get(r.id), r)) {
          latest.set(r.id, r)
          accepted.push(r)
        }
      }
      if (accepted.length > 0) {
        markKnown(known, accepted)
        pushToScene(accepted)
        saver?.mark()
      }
      return accepted
    }

    const flushPending = () => {
      sendTimer = null
      if (!bus || pending.size === 0) return
      const payload: WbUpdateEvent = { elements: [...pending.values()], from: selfId }
      if (bus.send('wb_update', payload)) pending.clear()
    }

    const flushPointer = () => {
      pointerTimer = null
      const p = pendingPointer
      pendingPointer = null
      if (!p || !bus) return
      const u = userRef.current
      const payload: WbPointerEvent & { name: string; color: string } = {
        x: p.x,
        y: p.y,
        tool: p.tool,
        from: selfId,
        name: u.name,
        color: u.color,
      }
      bus.send('wb_pointer', payload)
    }

    const publishCollaborators = () => {
      apiAppliedRef.current()
    }
    apiAppliedRef.current = () => {
      const api = apiRef.current
      if (!api) return
      const map = new Map<string, WhiteboardCollaborator>()
      collaboratorsRef.current.forEach((c, k) => map.set(k, c))
      try {
        api.updateScene({ collaborators: map })
      } catch {
        // scene not ready
      }
    }

    const makeSaver = (): Saver =>
      createSaver({
        delayMs: PERSIST_DELAY_MS,
        save: async () => {
          if (!editableRef.current) return
          // Merge what the other participant persisted before overwriting (element-level, version wins).
          const row = await loadWorkspace(sessionId)
          const dbEls = filterElements(row?.whiteboard?.elements)
          if (dbEls.length > 0) applyRemote(dbEls)
          const merged = mergeElements(dbEls, allElements())
          await upsertWorkspace(sessionId, {
            whiteboard: { elements: merged, ...(background ? { appState: { viewBackgroundColor: background } } : {}) },
          })
        },
      })

    localRef.current = {
      onChange(elements, appState) {
        if (!editableRef.current) return
        const bg = appState?.viewBackgroundColor
        if (typeof bg === 'string' && bg !== background) {
          background = bg
          saver?.mark()
        }
        const changed = takeChanged(known, filterElements(elements))
        if (changed.length === 0) return
        for (const c of changed) {
          latest.set(c.id, c)
          pending.set(c.id, c)
        }
        saver?.mark()
        sendTimer ??= setTimeout(flushPending, SEND_THROTTLE_MS)
      },
      pointer(x, y, tool) {
        if (!editableRef.current) return
        pendingPointer = { x, y, tool }
        pointerTimer ??= setTimeout(flushPointer, POINTER_THROTTLE_MS)
      },
      bind(api) {
        apiRef.current = api
        // Anything that arrived before the board mounted (or changed since initialData): reconcile it in.
        pushToScene(allElements())
        publishCollaborators()
      },
    }

    void (async () => {
      let row: Awaited<ReturnType<typeof loadWorkspace>> = null
      try {
        row = await loadWorkspace(sessionId)
      } catch {
        row = null
      }
      if (cancelled) return
      const els = filterElements(row?.whiteboard?.elements)
      for (const e of els) latest.set(e.id, e)
      markKnown(known, els)
      const bg = row?.whiteboard?.appState?.viewBackgroundColor
      if (typeof bg === 'string') background = bg
      setInitialData({
        elements: els,
        ...(row?.whiteboard?.appState ? { appState: row.whiteboard.appState } : {}),
      })

      if (!editableRef.current) {
        setConn('offline')
        return
      }
      saver = makeSaver()
      watchAccessToken()
      const hide = () => {
        if (!saver?.isDirty() || !editableRef.current) return
        upsertWorkspaceKeepalive(sessionId, { whiteboard: { elements: allElements() } })
      }
      window.addEventListener('pagehide', hide)
      window.addEventListener('beforeunload', hide)
      cleanups.push(() => {
        window.removeEventListener('pagehide', hide)
        window.removeEventListener('beforeunload', hide)
      })

      bus = sessionBus.acquire(sessionId)
      cleanups.push(
        bus.onEvent((event, payload) => {
          if (!payload || typeof payload !== 'object') return
          const p = payload as Record<string, unknown>
          if (p.from === selfId) return
          switch (event) {
            case 'wb_update':
              applyRemote(filterElements(p.elements))
              break
            case 'wb_sync_request': {
              if (typeof p.from !== 'string') return
              const reply: WbSyncReplyEvent = { elements: allElements(), to: p.from, from: selfId }
              bus?.send('wb_sync_reply', reply)
              break
            }
            case 'wb_sync_reply':
              if (p.to === selfId) applyRemote(filterElements(p.elements))
              break
            case 'wb_pointer': {
              if (typeof p.from !== 'string' || typeof p.x !== 'number' || typeof p.y !== 'number') return
              const color = typeof p.color === 'string' ? p.color : '#ff8800'
              const next = new Map(collaboratorsRef.current)
              next.set(p.from, {
                pointer: { x: p.x, y: p.y, tool: typeof p.tool === 'string' ? p.tool : 'pointer' },
                username: typeof p.name === 'string' && p.name ? p.name : 'Guest',
                color: { background: color, stroke: color },
              })
              lastSeen.set(p.from, Date.now())
              setCollaborators(next)
              break
            }
          }
        }),
      )
      cleanups.push(
        bus.onConnected((c) => {
          if (c) {
            setConn('live')
            bus?.send('wb_sync_request', { from: selfId })
            flushPending() // whatever we drew while offline
          } else {
            setConn((prev) => (prev === 'live' ? 'offline' : prev))
          }
        }),
      )
      pruneTimer = setInterval(() => {
        const now = Date.now()
        let changed = false
        const next = new Map(collaboratorsRef.current)
        for (const [id, t] of lastSeen) {
          if (now - t > POINTER_TTL_MS) {
            next.delete(id)
            lastSeen.delete(id)
            changed = true
          }
        }
        if (changed) setCollaborators(next)
      }, 5000)
    })()

    return () => {
      cancelled = true
      localRef.current = null
      apiRef.current = null
      for (const c of cleanups.splice(0)) c()
      if (sendTimer) clearTimeout(sendTimer)
      if (pointerTimer) clearTimeout(pointerTimer)
      if (pruneTimer) clearInterval(pruneTimer)
      flushPending()
      bus?.release()
      const s = saver
      if (s) {
        if (s.isDirty() && editableRef.current) void s.flush().finally(() => s.dispose())
        else s.dispose()
      }
    }
  }, [session.id, user.id])

  const onChange = useCallback((elements: readonly unknown[], appState: Record<string, unknown>) => {
    localRef.current?.onChange(elements, appState)
  }, [])
  const onPointerUpdate = useCallback((p: { pointer: { x: number; y: number }; button: 'down' | 'up' }) => {
    const tool = (p.pointer as { tool?: string }).tool ?? 'pointer'
    localRef.current?.pointer(p.pointer.x, p.pointer.y, tool)
  }, [])
  const bindApi = useCallback((api: unknown) => {
    if (!api) {
      apiRef.current = null
      return
    }
    if (localRef.current) localRef.current.bind(api as ExcalidrawApiLike)
    else apiRef.current = api as ExcalidrawApiLike
  }, [])

  const status: CollabStatus = initialData === null ? 'loading' : !editable ? 'readonly' : conn === 'live' ? 'live' : conn
  return useMemo(
    () => ({ initialData, onChange, onPointerUpdate, bindApi, collaborators, editable, status }),
    [initialData, onChange, onPointerUpdate, bindApi, collaborators, editable, status],
  )
}
