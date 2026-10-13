/** Random v4 UUID (crypto when available). */
export function uuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  const h = (n: number) => Math.floor(Math.random() * 16 ** n).toString(16).padStart(n, '0')
  return `${h(8)}-${h(4)}-4${h(3)}-8${h(3)}-${h(12)}`
}

// cyrb128: small, well-distributed 128-bit string hash (not cryptographic, only used for stable seed ids).
function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703
  let h2 = 3144134277
  let h3 = 1013904242
  let h4 = 2773480762
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i)
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067)
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233)
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213)
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179)
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067)
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233)
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213)
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179)
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0]
}

/** Deterministic UUID-shaped id derived from the given parts (stable across reloads). */
export function stableUuid(...parts: string[]): string {
  const [a, b, c, d] = cyrb128(parts.join('/')).map((n) => n.toString(16).padStart(8, '0'))
  return `${a}-${b.slice(0, 4)}-5${b.slice(5, 8)}-8${c.slice(1, 4)}-${c.slice(4, 8)}${d}`
}
