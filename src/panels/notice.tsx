// A short message at the bottom of the canvas, for commands that could not apply (S-19 Req 3).
import { useEffect, useSyncExternalStore } from 'react'

let current: { text: string; at: number } | null = null
const listeners = new Set<() => void>()
const NOTICE_MS = 3500

export function showNotice(text: string) {
  current = { text, at: Date.now() }
  listeners.forEach((l) => l())
}

export function Notice() {
  const notice = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current
  )
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => {
      if (current === notice) {
        current = null
        listeners.forEach((l) => l())
      }
    }, NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])
  if (!notice) return null
  return (
    <div className="notice" role="status" data-testid="notice">
      {notice.text}
    </div>
  )
}
