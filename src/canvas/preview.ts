// Style overrides drawn while a gesture is in progress (a drag, a resize, a burst of nudges). They
// change only what is rendered; the document changes once, in one undo step, when the gesture ends.
import { createContext, useContext, useSyncExternalStore } from 'react'

import type { CSSStyle } from '../../shared/document'

export type Preview = Record<string, CSSStyle>

/**
 * Previews by layer, each layer subscribed to its own entry: a drag frame re-renders the layers it
 * moves, not every layer on the page (S-21).
 */
export class PreviewStore {
  private current: Preview = {}
  private listeners = new Map<string, Set<() => void>>()

  get = (id: string): CSSStyle | undefined => this.current[id]

  subscribe = (id: string, listener: () => void) => {
    let set = this.listeners.get(id)
    if (!set) this.listeners.set(id, (set = new Set()))
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(id)
    }
  }

  /** Replaces the previews and notifies the layers whose entry changed. */
  set(next: Preview) {
    const prev = this.current
    this.current = next
    for (const id of new Set([...Object.keys(prev), ...Object.keys(next)])) {
      if (sameStyle(prev[id], next[id])) {
        // Keep the old object so the layer's snapshot stays the same.
        if (prev[id]) next[id] = prev[id]
        continue
      }
      for (const listener of this.listeners.get(id) ?? []) listener()
    }
  }
}

function sameStyle(a: CSSStyle | undefined, b: CSSStyle | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
}

export const PreviewContext = createContext(new PreviewStore())

export function usePreview(id: string): CSSStyle | undefined {
  const store = useContext(PreviewContext)
  return useSyncExternalStore(
    (listener) => store.subscribe(id, listener),
    () => store.get(id)
  )
}
