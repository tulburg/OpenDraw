// The local user's display name on comments (S-16 Req 2), kept in app state and shared by every view.
import { useSyncExternalStore } from 'react'

import { LOCAL_USER_ID } from '../../shared/document'

let name: string | null = null
let loaded = false
const listeners = new Set<() => void>()

function load() {
  if (loaded) return
  loaded = true
  void window.opendraw.userName().then((saved) => {
    name = saved
    listeners.forEach((l) => l())
  })
}

export function useUserName(): string | null {
  load()
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => name
  )
}

export function setUserName(next: string) {
  name = next.trim()
  listeners.forEach((l) => l())
  void window.opendraw.setUserName(name)
}

export const localAuthor = (displayName: string) => ({ id: LOCAL_USER_ID, name: displayName })
