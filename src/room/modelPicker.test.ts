import { describe, expect, it } from 'vitest'
import {
  defaultOptionLabel,
  fallbackNotice,
  mergeModelOptions,
  modelStorageKey,
  parseModelList,
  readStoredModel,
  STATIC_MODELS,
  writeStoredModel,
} from './modelPicker'

function memStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    map: m,
  }
}

describe('model storage helpers', () => {
  it('uses the ai-model:<sessionId> key and round-trips per session', () => {
    const st = memStorage()
    expect(modelStorageKey('abc')).toBe('ai-model:abc')
    writeStoredModel('s1', 'gemini-2.5-pro', st)
    writeStoredModel('s2', 'gemini-flash-latest', st)
    expect(st.map.get('ai-model:s1')).toBe('gemini-2.5-pro')
    expect(readStoredModel('s1', st)).toBe('gemini-2.5-pro')
    expect(readStoredModel('s2', st)).toBe('gemini-flash-latest')
    expect(readStoredModel('s3', st)).toBe('')
  })
  it('Default (empty) clears the stored value', () => {
    const st = memStorage({ 'ai-model:s1': 'gemini-x' })
    writeStoredModel('s1', '', st)
    expect(st.map.has('ai-model:s1')).toBe(false)
    expect(readStoredModel('s1', st)).toBe('')
  })
  it('ignores a corrupt stored value', () => {
    expect(readStoredModel('s1', memStorage({ 'ai-model:s1': '../../x' }))).toBe('')
  })
  it('never throws when storage throws or is missing', () => {
    const boom = () => {
      throw new Error('blocked')
    }
    const bad = { getItem: boom, setItem: boom, removeItem: boom }
    expect(readStoredModel('s', bad)).toBe('')
    expect(() => writeStoredModel('s', 'gemini-x', bad)).not.toThrow()
    expect(() => writeStoredModel('s', '', bad)).not.toThrow()
    expect(readStoredModel('s', null)).toBe('')
    expect(() => writeStoredModel('s', 'gemini-x', null)).not.toThrow()
  })
})

describe('mergeModelOptions', () => {
  it('returns the list unchanged for default or listed selections', () => {
    expect(mergeModelOptions(STATIC_MODELS, '')).toEqual(STATIC_MODELS)
    expect(mergeModelOptions(STATIC_MODELS, 'gemini-flash-latest')).toEqual(STATIC_MODELS)
  })
  it('keeps a remembered model that is no longer listed, first, without mutating the input', () => {
    const list = [...STATIC_MODELS]
    const out = mergeModelOptions(list, 'gemini-old')
    expect(out[0]).toEqual({ id: 'gemini-old', label: 'gemini-old (not listed)' })
    expect(out).toHaveLength(list.length + 1)
    expect(list).toEqual(STATIC_MODELS)
  })
})

describe('parseModelList', () => {
  it('parses, dedupes and drops invalid entries', () => {
    const out = parseModelList({
      models: [{ id: 'gemini-a', label: 'A' }, { id: 'gemini-a', label: 'dup' }, { id: 'Bad Id' }, { id: 'gemini-b' }, null],
      default: 'gemini-a',
      degraded: true,
    })
    expect(out).toEqual({
      models: [
        { id: 'gemini-a', label: 'A' },
        { id: 'gemini-b', label: 'gemini-b' },
      ],
      default: 'gemini-a',
      degraded: true,
    })
  })
  it('returns null for unusable payloads', () => {
    expect(parseModelList(null)).toBeNull()
    expect(parseModelList({})).toBeNull()
    expect(parseModelList({ models: [] })).toBeNull()
    expect(parseModelList({ models: [{ id: 'X' }] })).toBeNull()
  })
  it('defaults degraded to false and default to null', () => {
    expect(parseModelList({ models: [{ id: 'gemini-a', label: 'A' }] })).toEqual({
      models: [{ id: 'gemini-a', label: 'A' }],
      default: null,
      degraded: false,
    })
  })
})

describe('labels', () => {
  it('formats the default option and the fallback notice', () => {
    expect(defaultOptionLabel(null)).toBe('Default')
    expect(defaultOptionLabel('gemini-3.8-flash')).toBe('Default (gemini-3.8-flash)')
    expect(fallbackNotice('gemini-flash-latest')).toBe('The selected model was unavailable; answered by gemini-flash-latest.')
    expect(fallbackNotice(null)).toContain('another model')
  })
})
