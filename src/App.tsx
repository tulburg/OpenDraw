import { useEffect, useState } from 'react'

import type { OpenedDocument } from '../shared/document'
import { startAutosave } from './document/autosave'
import { DocumentStore } from './document/store'
import { Editor } from './Editor'

declare global {
  interface Window {
    /** Only set under tests (OPENDRAW_TEST), so they can drive edits directly. */
    opendrawStore?: DocumentStore
    opendrawTest?: unknown
  }
}

export function App() {
  const [session, setSession] = useState<{ opened: OpenedDocument; store: DocumentStore } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.opendraw
      .openInitialDocument()
      .then((opened) => {
        if (!cancelled) setSession({ opened, store: new DocumentStore(opened.document, opened.pageId) })
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!session) return
    if (window.opendrawTest) window.opendrawStore = session.store
    return startAutosave(session.store, session.opened.path)
  }, [session])

  if (error) return <div className="app-error">Could not open a document: {error}</div>
  if (!session) return <div className="app" data-platform={window.opendraw.platform} />
  return <Editor opened={session.opened} store={session.store} />
}
