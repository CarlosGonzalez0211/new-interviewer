import { applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import type { Awareness } from 'y-protocols/awareness'
import { base64ToBytes, bytesToBase64 } from './b64'

export function encodeAwarenessB64(awareness: Awareness, clients: number[]): string {
  return bytesToBase64(encodeAwarenessUpdate(awareness, clients))
}

export function applyAwarenessB64(awareness: Awareness, b64: string, origin: unknown): void {
  applyAwarenessUpdate(awareness, base64ToBytes(b64), origin)
}
