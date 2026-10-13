/** Base64 helpers for Yjs binary updates (chunked so large updates do not overflow the call stack). */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[])
  }
  return btoa(bin)
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Like base64ToBytes but returns null for malformed input instead of throwing. */
export function tryBase64ToBytes(b64: unknown): Uint8Array | null {
  if (typeof b64 !== 'string') return null
  try {
    return base64ToBytes(b64)
  } catch {
    return null
  }
}
