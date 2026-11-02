// Autosave (S-3 Req 6): writes the document about 500 ms after the last change. The main process
// asks for a flush before a window closes or the app quits, and a reload saves synchronously.
// Each open tab runs its own autosave (S-13); `file` is read at save time, since a rename moves it.
import type { DocumentStore } from './store'

const AUTOSAVE_DELAY_MS = 500

const flushers = new Set<() => Promise<void>>()
let registered = false

export function startAutosave(store: DocumentStore, file: () => string): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = false
  let saving = Promise.resolve()

  const flush = (): Promise<void> => {
    clearTimeout(timer)
    if (!pending) return saving
    pending = false
    const document = store.getState().document
    saving = saving
      .then(() => window.opendraw.saveDocument(file(), document))
      .catch((err: unknown) => {
        pending = true
        console.error('Autosave failed', err)
      })
    return saving
  }

  const unsubscribe = store.subscribe((kind) => {
    if (kind !== 'document') return
    pending = true
    clearTimeout(timer)
    timer = setTimeout(() => void flush(), AUTOSAVE_DELAY_MS)
  })

  const onUnload = () => {
    if (!pending) return
    clearTimeout(timer)
    pending = false
    const error = window.opendraw.saveDocumentSync(file(), store.getState().document)
    if (error) console.error('Save on unload failed', error)
  }
  window.addEventListener('beforeunload', onUnload)

  flushers.add(flush)
  if (!registered) {
    registered = true
    window.opendraw.onFlushRequest(async () => void (await Promise.all([...flushers].map((f) => f()))))
  }

  return () => {
    flushers.delete(flush)
    void flush()
    unsubscribe()
    window.removeEventListener('beforeunload', onUnload)
  }
}
