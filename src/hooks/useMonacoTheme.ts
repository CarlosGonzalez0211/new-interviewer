import { useEffect, useState } from 'react'

/** Follows the OS colour scheme so Monaco matches whatever theme the shell renders. */
export function useMonacoTheme(): 'vs' | 'vs-dark' {
  const [dark, setDark] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = (e: MediaQueryListEvent) => setDark(e.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return dark ? 'vs-dark' : 'vs'
}
