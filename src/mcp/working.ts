// Which artboards an agent is writing to (S-5 Req 5). Each write marks its artboards for 30 s;
// finish_working_on_nodes releases them early. Not part of the document or its undo history.
import { useSyncExternalStore } from 'react'

export const WORKING_TIMEOUT_MS = 30_000

export class WorkingIndicators {
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private listeners = new Set<() => void>()
  private active: string[] = []

  constructor(private timeoutMs = WORKING_TIMEOUT_MS) {}

  getActive = (): string[] => this.active

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed() {
    const next = [...this.timers.keys()]
    if (next.join() === this.active.join()) return
    this.active = next
    for (const listener of this.listeners) listener()
  }

  touch(artboardIds: string[]) {
    for (const id of artboardIds) {
      clearTimeout(this.timers.get(id))
      this.timers.set(id, setTimeout(() => this.release([id]), this.timeoutMs))
    }
    this.changed()
  }

  /** Releases the given artboards, or all of them. Returns the IDs released. */
  release(artboardIds?: string[]): string[] {
    const ids = artboardIds ?? [...this.timers.keys()]
    const released = ids.filter((id) => this.timers.has(id))
    for (const id of released) {
      clearTimeout(this.timers.get(id))
      this.timers.delete(id)
    }
    this.changed()
    return released
  }
}

export function useWorking(working: WorkingIndicators): string[] {
  return useSyncExternalStore(working.subscribe, working.getActive)
}
