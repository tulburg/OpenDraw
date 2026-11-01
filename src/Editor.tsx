import { useCallback, useEffect, useRef, useState } from 'react'

import type { OpenedDocument, Viewport } from '../shared/document'
import { Canvas } from './canvas/Canvas'
import { fitViewport, nextZoomStep, zoomAt } from './canvas/viewport'
import { type DocumentStore, useStore } from './document/store'
import { findNode } from './document/tree'
import type { WriteToolName } from '../shared/mcp/definitions'
import { buildSnapshot } from './mcp/snapshot'
import { useWorking, WorkingIndicators } from './mcp/working'
import { runWriteTool } from './mcp/write'
import { LayersPanel } from './panels/LayersPanel'
import { StylesPanel } from './panels/StylesPanel'
import { TopBar } from './panels/TopBar'

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
function measureNode(id: string) {
  const world = document.querySelector<HTMLElement>('.canvas-world')
  const el = world?.querySelector(`[data-node-id="${CSS.escape(id)}"]`)
  if (!world || !el) return null
  const zoom = Number(world.dataset.zoom) || 1
  const box = el.getBoundingClientRect()
  return { width: box.width / zoom, height: box.height / zoom }
}

export function Editor({ opened, store }: { opened: OpenedDocument; store: DocumentStore }) {
  const doc = useStore(store, (s) => s.document)
  const pageId = useStore(store, (s) => s.pageId)
  const selection = useStore(store, (s) => s.selection)
  const [viewport, setViewport] = useState<Viewport | null>(opened.viewport)
  const canvasSize = useRef<{ width: number; height: number } | null>(null)
  const [working] = useState(() => new WorkingIndicators())
  const workingIds = useWorking(working)

  const nodes = doc.pages.find((p) => p.id === pageId)?.nodes ?? []
  const selectedId = selection[0] ?? null

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

  useEffect(() => {
    if (!viewport) return
    const timer = setTimeout(
      () => void window.opendraw.saveViewport(opened.path, pageId, viewport),
      SAVE_VIEWPORT_DELAY_MS
    )
    return () => clearTimeout(timer)
  }, [opened.path, pageId, viewport])

  useEffect(() => window.opendraw.onEditCommand((command) => runEditCommand(store, command)), [store])

  // The MCP server (main process) reads the document and live layout through this.
  useEffect(
    () => window.opendraw.handleMainRequest('mcp:snapshot', () => buildSnapshot(store, opened.path)),
    [store, opened.path]
  )
  useEffect(
    () =>
      window.opendraw.handleMainRequest('mcp:write', (payload) => {
        const { tool, args } = payload as { tool: WriteToolName; args: unknown }
        return runWriteTool({ store, working, measure: measureNode }, tool, args)
      }),
    [store, working]
  )
  useEffect(() => () => void working.release(), [working])

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
  const fileName = (opened.path.split(/[\\/]/).pop() ?? '').replace(/\.opendraw$/, '')
  const selected = selectedId ? findNode(nodes, selectedId) : null

  return (
    <div className="app" data-platform={window.opendraw.platform}>
      <TopBar fileName={fileName} zoom={viewport?.zoom ?? null} />
      <LayersPanel nodes={nodes} selection={selection} onSelect={selectLayer} />
      {/* Nodes stay hidden until the viewport is known, so a new file never flashes unfitted. */}
      <Canvas
        store={store}
        nodes={viewport ? nodes : []}
        viewport={viewport ?? { x: 0, y: 0, zoom: 1 }}
        selection={selection}
        workingIds={workingIds}
        onViewportChange={setViewport}
        onResize={onResize}
      />
      <StylesPanel node={selected} />
    </div>
  )
}
