import { useCallback, useEffect, useRef, useState } from 'react'

import type { OpenedDocument, Viewport } from '../shared/document'
import type { WriteToolName } from '../shared/mcp/definitions'
import { startAutosave } from './document/autosave'
import { DocumentStore } from './document/store'
import { Editor, measureNode } from './Editor'
import { FileBrowser } from './files/FileBrowser'
import { buildSnapshot } from './mcp/snapshot'
import { WorkingIndicators } from './mcp/working'
import { runWriteTool } from './mcp/write'
import { TopBar } from './panels/TopBar'

declare global {
  interface Window {
    /** Only set under tests (OPENDRAW_TEST), so they can drive edits directly. */
    opendrawStore?: DocumentStore
    opendrawTest?: unknown
  }
}

/** An open file (S-13 Req 3). Each tab keeps its own store, autosave and working indicators. */
export interface Tab {
  id: string
  opened: OpenedDocument
  store: DocumentStore
  working: WorkingIndicators
}

function makeTab(opened: OpenedDocument): Tab {
  return { id: opened.document.id, opened, store: new DocumentStore(opened.document, opened.pageId), working: new WorkingIndicators() }
}

export const fileNameOf = (path: string) => (path.split(/[\\/]/).pop() ?? '').replace(/\.opendraw$/, '')

export function App() {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [home, setHome] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  // The latest tabs for handlers that run outside React (MCP requests, autosave paths).
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const activeRef = useRef(activeId)
  activeRef.current = activeId
  const homeRef = useRef(home)
  homeRef.current = home
  useEffect(() => {
    let cancelled = false
    window.opendraw
      .openInitialTabs()
      .then(({ tabs: opened, activeId: active }) => {
        if (cancelled) return
        setTabs(opened.map(makeTab))
        setActiveId(active)
        setLoaded(true)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Report the tabs to the main process, which restores them on the next launch.
  useEffect(() => {
    if (loaded) void window.opendraw.setTabs(tabs.map((t) => t.id), activeId)
  }, [loaded, tabs, activeId])

  // One autosave per tab, for as long as it is open.
  const autosaves = useRef(new Map<string, () => void>())
  useEffect(() => {
    const running = autosaves.current
    for (const tab of tabs) {
      if (!running.has(tab.id)) running.set(tab.id, startAutosave(tab.store, () => tab.opened.path))
    }
    for (const [id, stop] of running) {
      if (!tabs.some((t) => t.id === id)) {
        stop()
        running.delete(id)
      }
    }
  }, [tabs])
  useEffect(() => () => autosaves.current.forEach((stop) => stop()), [])

  const active = tabs.find((t) => t.id === activeId) ?? null
  useEffect(() => {
    if (window.opendrawTest && active) window.opendrawStore = active.store
  }, [active])

  const openTab = useCallback((opened: OpenedDocument, activate: boolean) => {
    const id = opened.document.id
    if (!tabsRef.current.some((t) => t.id === id)) {
      const tab = makeTab(opened)
      // Updated now as well, so an MCP call right after open_file finds the tab before React renders.
      tabsRef.current = [...tabsRef.current, tab]
      setTabs((current) => (current.some((t) => t.id === id) ? current : [...current, tab]))
    }
    if (activate) {
      setActiveId(id)
      setHome(false)
    }
  }, [])

  const openFile = useCallback(
    async (id: string) => {
      if (tabsRef.current.some((t) => t.id === id)) {
        setActiveId(id)
        setHome(false)
        return
      }
      openTab(await window.opendraw.openFile(id), true)
    },
    [openTab]
  )

  const closeTab = useCallback((id: string) => {
    const current = tabsRef.current
    const index = current.findIndex((t) => t.id === id)
    if (index < 0) return
    current[index].working.release()
    const rest = current.filter((t) => t.id !== id)
    setTabs(rest)
    if (activeRef.current === id) {
      const next = rest[Math.min(index, rest.length - 1)]
      setActiveId(next?.id ?? null)
      if (!next) setHome(true)
    }
  }, [])

  const reorderTabs = useCallback((ids: string[]) => {
    setTabs((current) => ids.map((id) => current.find((t) => t.id === id)!).filter(Boolean))
  }, [])

  // The main process (MCP server) reaches tabs through these (S-13 Req 5).
  useEffect(() => {
    const tabFor = (fileId: string | undefined): Tab => {
      const current = tabsRef.current
      const tab = fileId === undefined ? current.find((t) => t.id === activeRef.current) : current.find((t) => t.id === fileId)
      if (tab) return tab
      if (fileId === undefined) throw new Error('No file is open in OpenDraw. Call open_file first.')
      throw new Error(`File ${fileId} is not open in OpenDraw. Call open_file with its ID first.`)
    }
    const isActive = (tab: Tab) => tab.id === activeRef.current && !homeRef.current
    const offSnapshot = window.opendraw.handleMainRequest('mcp:snapshot', (payload) => {
      const tab = tabFor((payload as { fileId?: string } | undefined)?.fileId)
      const snapshot = buildSnapshot(tab.store, tab.opened.path)
      // Only the tab in front is on the canvas; others have no measured layout.
      return isActive(tab) ? snapshot : { ...snapshot, layout: {} }
    })
    const offWrite = window.opendraw.handleMainRequest('mcp:write', (payload) => {
      const { tool, args } = payload as { tool: WriteToolName; args: { fileId?: string } }
      const tab = tabFor(args?.fileId)
      const measure = isActive(tab) ? measureNode : () => null
      return runWriteTool({ store: tab.store, working: tab.working, measure }, tool, args)
    })
    const offAdd = window.opendraw.handleMainRequest('workspace:add-tab', (payload) => {
      const { opened, activate } = payload as { opened: OpenedDocument; activate: boolean }
      openTab(opened, activate)
      return null
    })
    const offMoved = window.opendraw.onFileMoved((id, path) => {
      const tab = tabsRef.current.find((t) => t.id === id)
      if (tab) {
        tab.opened.path = path
        setTabs((current) => [...current])
      }
    })
    return () => {
      offSnapshot()
      offWrite()
      offAdd()
      offMoved()
    }
  }, [openTab])

  // A tab remembers where it was when another one comes to the front.
  const onViewState = useCallback((tab: Tab, viewport: Viewport | null) => {
    tab.opened.viewport = viewport
    tab.opened.pageId = tab.store.getState().pageId
  }, [])

  if (error) return <div className="app-error">Could not open a document: {error}</div>
  if (!loaded) return <div className="app" data-platform={window.opendraw.platform} />

  const topBar = (zoom: number | null) => (
    <TopBar
      tabs={tabs.map((t) => ({ id: t.id, name: fileNameOf(t.opened.path) }))}
      activeId={home ? null : activeId}
      home={home || !active}
      zoom={zoom}
      onHome={() => setHome(true)}
      onSelect={(id) => {
        setActiveId(id)
        setHome(false)
      }}
      onClose={closeTab}
      onReorder={reorderTabs}
    />
  )

  if (home || !active) {
    return (
      <div className="app app-home" data-platform={window.opendraw.platform}>
        {topBar(null)}
        <FileBrowser openIds={tabs.map((t) => t.id)} onOpen={(id) => void openFile(id)} />
      </div>
    )
  }
  return (
    <Editor
      key={active.id}
      opened={active.opened}
      store={active.store}
      working={active.working}
      topBar={topBar}
      onViewState={(viewport) => onViewState(active, viewport)}
    />
  )
}
