// Requests from the main process to a renderer, answered through the preload's handleMainRequest.
import { ipcMain, type WebContents } from 'electron'

const DEFAULT_TIMEOUT_MS = 10_000

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

let nextId = 1
const pending = new Map<number, Pending>()

ipcMain.on('renderer:response', (_event, id: number, ok: boolean, value: unknown) => {
  const waiter = pending.get(id)
  if (!waiter) return
  pending.delete(id)
  clearTimeout(waiter.timer)
  if (ok) waiter.resolve(value)
  else waiter.reject(new Error(String(value)))
})

export function requestRenderer<T>(
  contents: WebContents,
  channel: string,
  payload?: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  if (contents.isDestroyed()) return Promise.reject(new Error('The window is closed'))
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`The window did not answer ${channel} within ${timeoutMs} ms`))
    }, timeoutMs)
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
    contents.send('renderer:request', id, channel, payload)
  })
}
