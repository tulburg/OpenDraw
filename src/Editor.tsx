import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { CSSStyle, OpenedDocument, Viewport } from '../shared/document'
import { Canvas } from './canvas/Canvas'
import { TokensContext } from './canvas/NodeView'
import { tokenStyle } from '../shared/tokens'
import { fitViewport, nextZoomStep, zoomAt } from './canvas/viewport'
import { type DocumentStore, useStore } from './document/store'
import { useWorking, type WorkingIndicators } from './mcp/working'
import { LayersPanel } from './panels/LayersPanel'
import { StylesPanel } from './panels/StylesPanel'

const SAVE_VIEWPORT_DELAY_MS = 300

function isEditable(target: Element | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target.tagName))
}

/** Undo and redo act on text while a text field has focus, and on the document otherwise. */
function runEditCommand(store: DocumentStore, command: 'undo' | 'redo') {
  if (isEditable(document.activeElement)) document.execCommand(command)
  else if (command === 'undo') store.undo()
  else store.redo()
}

/** A node's rendered size in world units, or null when it is not on the canvas. */
export function measureNode(id: string) {
  const world = document.querySelector<HTMLElement>('.canvas-world')
  const el = world?.querySelector(`[data-node-id="${CSS.escape(id)}"]`)
  if (!world || !el) return null
  const zoom = Number(world.dataset.zoom) || 1
  const box = el.getBoundingClientRect()
  return { width: box.width / zoom, height: box.height / zoom }
}

interface EditorProps {
  opened: OpenedDocument
  store: DocumentStore
  working: WorkingIndicators
  /** The top bar, given the zoom to show. */
  topBar: (zoom: number | null) => ReactNode
  /** Called as the viewport changes, so the tab can come back to it. */
  onViewState: (viewport: Viewport | null) => void
}

export function Editor({ opened, store, working, topBar, onViewState }: EditorProps) {
  const doc = useStore(store, (s) => s.document)
  const pageId = useStore(store, (s) => s.pageId)
  const selection = useStore(store, (s) => s.selection)
  const [viewport, setViewport] = useState<Viewport | null>(opened.viewport)
  const [openThread, setOpenThread] = useState<string | null>(null)
  const canvasSize = useRef<{ width: number; height: number } | null>(null)
  const [panelPreview, setPanelPreview] = useState<Record<string, CSSStyle>>({})
  const onPanelPreview = useCallback((preview: Record<string, CSSStyle> | null) => setPanelPreview(preview ?? {}), [])
  const workingIds = useWorking(working)

  const nodes = doc.pages.find((p) => p.id === pageId)?.nodes ?? []
  const tokens = useMemo(() => tokenStyle(doc.tokens), [doc.tokens])

  const fit = useCallback(() => {
    if (canvasSize.current) setViewport(fitViewport(nodes, canvasSize.current))
  }, [nodes])

  // The first time a file is shown it has no saved viewport: fit once the canvas has a size.
  const onResize = useCallback(
    (size: { width: number; height: number }) => {
      canvasSize.current = size
      setViewport((current) => current ?? fitViewport(nodes, size))
    },
    [nodes]
  )

  useEffect(() => onViewState(viewport), [onViewState, viewport, pageId])

  // Each page keeps its own viewport while the file is open (S-12 Req 1); a page not seen yet is fitted.
  const pageViewports = useRef(new Map<string, Viewport>())
  const shownPage = useRef(pageId)
  useEffect(() => {
    if (shownPage.current === pageId) return
    setViewport((current) => {
      if (current) pageViewports.current.set(shownPage.current, current)
      const saved = pageViewports.current.get(pageId)
      if (saved) return saved
      return canvasSize.current ? fitViewport(nodes, canvasSize.current) : null
    })
    shownPage.current = pageId
  }, [pageId, nodes])

  useEffect(() => {
    if (!viewport) return
    const timer = setTimeout(
      () => void window.opendraw.saveViewport(opened.path, pageId, viewport),
      SAVE_VIEWPORT_DELAY_MS
    )
    return () => clearTimeout(timer)
  }, [opened.path, pageId, viewport])

  useEffect(() => window.opendraw.onEditCommand((command) => runEditCommand(store, command)), [store])


  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey
      const center = canvasSize.current
        ? { x: canvasSize.current.width / 2, y: canvasSize.current.height / 2 }
        : { x: 0, y: 0 }
      if (mod && event.key.toLowerCase() === 'z') {
        if (isEditable(document.activeElement)) return
        event.preventDefault()
        runEditCommand(store, event.shiftKey ? 'redo' : 'undo')
      } else if (mod && (event.key === '=' || event.key === '+')) {
        event.preventDefault()
        setViewport((v) => v && zoomAt(v, nextZoomStep(v.zoom, 1), center))
      } else if (mod && event.key === '-') {
        event.preventDefault()
        setViewport((v) => v && zoomAt(v, nextZoomStep(v.zoom, -1), center))
      } else if (mod && event.key === '0') {
        event.preventDefault()
        setViewport((v) => v && zoomAt(v, 1, center))
      } else if (event.shiftKey && !mod && event.code === 'Digit1') {
        event.preventDefault()
        fit()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [fit, store])

  const selectLayer = useCallback(
    (id: string, additive: boolean) => {
      const current = store.getState().selection
      if (!additive) store.select([id])
      else store.select(current.includes(id) ? current.filter((s) => s !== id) : [...current, id])
    },
    [store]
  )

  return (
    <div className="app" data-platform={window.opendraw.platform}>
      {topBar(viewport?.zoom ?? null)}
      <LayersPanel store={store} nodes={nodes} selection={selection} onSelect={selectLayer} openThread={openThread} onOpenThread={setOpenThread} />
      {/* Nodes stay hidden until the viewport is known, so a new file never flashes unfitted. */}
      <TokensContext.Provider value={tokens}>
      <Canvas
        store={store}
        nodes={viewport ? nodes : []}
        viewport={viewport ?? { x: 0, y: 0, zoom: 1 }}
        selection={selection}
        workingIds={workingIds}
        externalPreview={panelPreview}
        onViewportChange={setViewport}
        onResize={onResize}
        openThread={openThread}
        onOpenThread={setOpenThread}
      />
      </TokensContext.Provider>
      <StylesPanel store={store} nodes={nodes} selection={selection} measure={measureNode} onPreview={onPanelPreview} />
    </div>
  )
}
