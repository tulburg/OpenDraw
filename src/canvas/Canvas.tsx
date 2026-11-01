import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { CSSStyle, DesignNode, Viewport } from '../../shared/document'
import type { DocumentStore } from '../document/store'
import { findNode } from '../document/tree'
import { CLIPBOARD_TYPE, copySelection, deleteSelection, duplicateSelection, paste, selectAll } from './commands'
import { NodeView } from './NodeView'
import { type Preview, PreviewContext } from './preview'
import { deeper, nodeElement, parentIdOf, pathAt, pickAtDepth } from './selection'
import { nodeRect, type Rect, toScreen, zoomAt } from './viewport'

interface CanvasProps {
  store: DocumentStore
  nodes: DesignNode[]
  viewport: Viewport
  selection: string[]
  /** Artboards an agent is writing to, outlined with a working label. */
  workingIds: string[]
  onViewportChange: (viewport: Viewport) => void
  onResize: (size: { width: number; height: number }) => void
}

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

interface Box {
  left: number
  top: number
  width: number
  height: number
}

type Offsets = Record<string, { left: number; top: number }>

type Gesture = { pointerId: number; startX: number; startY: number; active: boolean } & (
  | { kind: 'pan'; origin: Viewport }
  | { kind: 'move'; origins: Offsets }
  | { kind: 'reorder'; id: string; parentId: string; axis: 'x' | 'y'; from: number; index: number }
  | { kind: 'resize'; id: string; handle: Handle; origin: Box; positioned: boolean }
  | { kind: 'marquee'; base: string[]; rect: Rect }
)

const WHEEL_ZOOM_SPEED = 0.01
const MAX_WHEEL_ZOOM_DELTA = 50
/** Pointer travel, in screen px, before a press becomes a drag. */
const DRAG_THRESHOLD = 3
/** A burst of arrow-key nudges becomes one undo step once the keys rest this long. */
const NUDGE_COMMIT_MS = 500

const px = (value: number) => `${Math.round(value)}px`

function isTyping(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target.tagName))
}

function isPositionedNode(node: DesignNode | null): boolean {
  return !!node && (node.type === 'artboard' || node.style.position === 'absolute')
}

function offsetStyles(origins: Offsets, dx: number, dy: number): Preview {
  return Object.fromEntries(Object.entries(origins).map(([id, o]) => [id, { left: px(o.left + dx), top: px(o.top + dy) }]))
}

/** New size (and position, for positioned layers) for a resize-handle drag of dx, dy world units. */
function resized(origin: Box, handle: Handle, dx: number, dy: number, keepRatio: boolean, fromCenter: boolean): Box {
  const sx = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0
  const sy = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0
  const k = fromCenter ? 2 : 1
  let width = origin.width + sx * dx * k
  let height = origin.height + sy * dy * k
  if (keepRatio && origin.width > 0 && origin.height > 0) {
    const ratio = origin.width / origin.height
    if (sx && sy) {
      if (Math.abs(width / origin.width) > Math.abs(height / origin.height)) height = width / ratio
      else width = height * ratio
    } else if (sx) height = width / ratio
    else width = height * ratio
  }
  width = Math.max(1, Math.round(width))
  height = Math.max(1, Math.round(height))
  if (fromCenter) {
    return { width, height, left: origin.left - (width - origin.width) / 2, top: origin.top - (height - origin.height) / 2 }
  }
  return {
    width,
    height,
    left: sx === -1 ? origin.left + origin.width - width : origin.left,
    top: sy === -1 ? origin.top + origin.height - height : origin.top
  }
}

export function Canvas({ store, nodes, viewport, selection, workingIds, onViewportChange, onResize }: CanvasProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [spaceHeld, setSpaceHeld] = useState(false)
  // Pointer events can outrun rendering, so handlers read the gesture and preview from refs; the
  // state copies only drive what is drawn.
  const [gesture, setGestureState] = useState<Gesture | null>(null)
  const gestureRef = useRef<Gesture | null>(null)
  const setGesture = (next: Gesture | null) => {
    gestureRef.current = next
    setGestureState(next)
  }
  const [preview, setPreviewState] = useState<Preview>({})
  const previewRef = useRef<Preview>({})
  const setPreview = useCallback((next: Preview) => {
    previewRef.current = next
    setPreviewState(next)
  }, [])
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [insertLine, setInsertLine] = useState<Rect | null>(null)
  // Handlers registered once read the latest values from refs.
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  const nudge = useRef<{ origins: Offsets; dx: number; dy: number; timer?: ReturnType<typeof setTimeout> } | null>(null)

  const parentOf = useCallback((id: string) => parentIdOf(ref.current!, id), [])

  /** A layer's box in world units: its offset within its positioning parent and its rendered size. */
  const boxOf = (id: string): Box | null => {
    const el = nodeElement(ref.current!, id)
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const zoom = viewportRef.current.zoom
    return { left: el.offsetLeft, top: el.offsetTop, width: rect.width / zoom, height: rect.height / zoom }
  }
  const measure = useCallback((id: string) => {
    const el = ref.current && nodeElement(ref.current, id)
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return { width: rect.width / viewportRef.current.zoom, height: rect.height / viewportRef.current.zoom }
  }, [])
  const offsetsOf = (ids: string[]): Offsets =>
    Object.fromEntries(
      ids.flatMap((id) => {
        const el = nodeElement(ref.current!, id)
        return el ? [[id, { left: el.offsetLeft, top: el.offsetTop }]] : []
      })
    )

  const commitNudge = useCallback(() => {
    const pending = nudge.current
    if (!pending) return
    clearTimeout(pending.timer)
    nudge.current = null
    setPreview({})
    if (pending.dx === 0 && pending.dy === 0) return
    const styles = offsetStyles(pending.origins, pending.dx, pending.dy)
    store.transact('Nudge', (tx) => {
      for (const [id, update] of Object.entries(styles)) tx.updateStyles([id], update)
    })
  }, [store, setPreview])

  useEffect(() => {
    const el = ref.current!
    const observer = new ResizeObserver(([entry]) => {
      onResize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [onResize])

  // Trackpad scroll pans; pinch (reported as ctrl + wheel) and cmd/ctrl + scroll zoom around the cursor.
  useEffect(() => {
    const el = ref.current!
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const current = viewportRef.current
      if (event.ctrlKey || event.metaKey) {
        const bounds = el.getBoundingClientRect()
        const delta = Math.max(-MAX_WHEEL_ZOOM_DELTA, Math.min(MAX_WHEEL_ZOOM_DELTA, event.deltaY))
        const anchor = { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
        onViewportChange(zoomAt(current, current.zoom * Math.exp(-delta * WHEEL_ZOOM_SPEED), anchor))
        return
      }
      // A plain mouse wheel with shift scrolls sideways.
      const dx = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX
      const dy = event.shiftKey && event.deltaX === 0 ? 0 : event.deltaY
      onViewportChange({ ...current, x: current.x - dx, y: current.y - dy })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onViewportChange])

  // Keys that act on the selection. Text fields keep their own keys.
  useEffect(() => {
    const ARROWS: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1]
    }
    const down = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return
      const mod = event.metaKey || event.ctrlKey
      const selected = store.getState().selection
      if (event.code === 'Space') {
        event.preventDefault()
        setSpaceHeld(true)
        return
      }
      const arrow = ARROWS[event.key]
      if (arrow && !mod) {
        if (selected.length === 0 || !selected.every((id) => isPositionedNode(findNode(nodesRef.current, id)))) return
        event.preventDefault()
        const step = event.shiftKey ? 10 : 1
        nudge.current ??= { origins: offsetsOf(selected), dx: 0, dy: 0 }
        const pending = nudge.current
        pending.dx += arrow[0] * step
        pending.dy += arrow[1] * step
        setPreview(offsetStyles(pending.origins, pending.dx, pending.dy))
        clearTimeout(pending.timer)
        pending.timer = setTimeout(commitNudge, NUDGE_COMMIT_MS)
        return
      }
      commitNudge()
      if (event.key === 'Escape') {
        const parent = selected[0] ? parentIdOf(ref.current!, selected[0]) : null
        store.select(parent ? [parent] : [])
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && !mod) {
        event.preventDefault()
        deleteSelection(store)
      } else if (mod && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        duplicateSelection(store, measure)
      } else if (mod && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        selectAll(store, (id) => parentIdOf(ref.current!, id))
      }
    }
    const up = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpaceHeld(false)
    }
    const blur = () => setSpaceHeld(false)
    // Copy, cut and paste arrive as clipboard events from the keyboard and from the Edit menu alike.
    const onCopy = (event: ClipboardEvent) => {
      if (isTyping(document.activeElement)) return
      const data = copySelection(store)
      if (!data || !event.clipboardData) return
      event.preventDefault()
      event.clipboardData.setData(CLIPBOARD_TYPE, data.json)
      event.clipboardData.setData('text/plain', data.text)
      if (event.type === 'cut') deleteSelection(store)
    }
    const onPaste = (event: ClipboardEvent) => {
      if (isTyping(document.activeElement)) return
      const json = event.clipboardData?.getData(CLIPBOARD_TYPE)
      if (json && paste(store, json, measure)) event.preventDefault()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    document.addEventListener('copy', onCopy)
    document.addEventListener('cut', onCopy)
    document.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      document.removeEventListener('copy', onCopy)
      document.removeEventListener('cut', onCopy)
      document.removeEventListener('paste', onPaste)
    }
    // offsetsOf reads the DOM through refs, so it does not need to be a dependency.
  }, [store, commitNudge, measure, setPreview])

  const canvasPoint = (event: { clientX: number; clientY: number }) => {
    const bounds = ref.current!.getBoundingClientRect()
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
  }

  /** The layer a press or hover at this target picks: by depth, or the deepest with cmd/ctrl. */
  const pick = (target: EventTarget, deepest: boolean): string | null => {
    const label = target instanceof Element ? target.closest<HTMLElement>('.artboard-label') : null
    if (label) return label.dataset.selectId ?? null
    const path = pathAt(target)
    if (path.length === 0) return null
    return deepest ? path[path.length - 1] : pickAtDepth(path, store.getState().selection, parentOf)
  }

  const onPointerDown = (event: React.PointerEvent) => {
    const base = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, active: false }
    commitNudge()
    if (event.button === 1 || (event.button === 0 && spaceHeld)) {
      event.preventDefault()
      ref.current!.setPointerCapture(event.pointerId)
      setGesture({ ...base, kind: 'pan', origin: viewport, active: true })
      return
    }
    if (event.button !== 0) return
    ref.current!.setPointerCapture(event.pointerId)
    const target = event.target as HTMLElement

    const handle = target.closest<HTMLElement>('[data-handle]')?.dataset.handle as Handle | undefined
    if (handle && selection.length === 1) {
      const origin = boxOf(selection[0])
      const positioned = isPositionedNode(findNode(nodes, selection[0]))
      if (origin) setGesture({ ...base, kind: 'resize', id: selection[0], handle, origin, positioned })
      return
    }

    const picked = pick(target, event.metaKey || event.ctrlKey)
    if (!picked) {
      if (!event.shiftKey) store.select([])
      const point = canvasPoint(event)
      setGesture({ ...base, kind: 'marquee', base: event.shiftKey ? selection : [], rect: { ...point, width: 0, height: 0 } })
      return
    }
    if (event.shiftKey) {
      store.select(selection.includes(picked) ? selection.filter((id) => id !== picked) : [...selection, picked])
      return
    }
    const selected = selection.includes(picked) ? selection : [picked]
    if (selected !== selection) store.select(selected)

    if (selected.every((id) => isPositionedNode(findNode(nodes, id)))) {
      setGesture({ ...base, kind: 'move', origins: offsetsOf(selected) })
      return
    }
    const parentId = parentOf(picked)
    if (selected.length === 1 && parentId) {
      const parentStyle = getComputedStyle(nodeElement(ref.current!, parentId)!)
      const axis = parentStyle.display.includes('flex') && parentStyle.flexDirection.startsWith('row') ? 'x' : 'y'
      const from = findNode(nodes, parentId)!.children.findIndex((child) => child.id === picked)
      setGesture({ ...base, kind: 'reorder', id: picked, parentId, axis, from, index: from })
    }
  }

  const onPointerMove = (event: React.PointerEvent) => {
    const gesture = gestureRef.current
    if (!gesture) {
      if (event.buttons === 0) setHoveredId(pick(event.target, event.metaKey || event.ctrlKey))
      return
    }
    if (event.pointerId !== gesture.pointerId) return
    const screenDx = event.clientX - gesture.startX
    const screenDy = event.clientY - gesture.startY
    if (!gesture.active && Math.hypot(screenDx, screenDy) < DRAG_THRESHOLD) return
    const dx = screenDx / viewport.zoom
    const dy = screenDy / viewport.zoom
    let next: Gesture = gesture.active ? gesture : { ...gesture, active: true }
    if (!gesture.active) setHoveredId(null)

    switch (next.kind) {
      case 'pan':
        onViewportChange({ ...next.origin, x: next.origin.x + screenDx, y: next.origin.y + screenDy })
        break
      case 'move':
        setPreview(offsetStyles(next.origins, dx, dy))
        break
      case 'resize': {
        const box = resized(next.origin, next.handle, dx, dy, event.shiftKey, event.altKey)
        const style: CSSStyle = { width: px(box.width), height: px(box.height) }
        if (next.positioned) Object.assign(style, { left: px(box.left), top: px(box.top) })
        setPreview({ [next.id]: style })
        break
      }
      case 'reorder': {
        // The dragged layer goes before the first sibling whose middle is past the pointer.
        const parentEl = nodeElement(ref.current!, next.parentId)!
        const bounds = ref.current!.getBoundingClientRect()
        const x = next.axis === 'x'
        const draggedId = next.id
        const rects = [...parentEl.children]
          .filter((el): el is HTMLElement => el instanceof HTMLElement && !!el.dataset.nodeId && el.dataset.nodeId !== draggedId)
          .map((el) => el.getBoundingClientRect())
        const along = x ? event.clientX : event.clientY
        const index = rects.filter((r) => (x ? r.left + r.width / 2 : r.top + r.height / 2) < along).length
        const parentRect = parentEl.getBoundingClientRect()
        const last = rects[rects.length - 1]
        const edge =
          index < rects.length
            ? x ? rects[index].left : rects[index].top
            : last
              ? x ? last.right : last.bottom
              : x ? parentRect.left : parentRect.top
        setInsertLine(
          x
            ? { x: edge - bounds.left - 1, y: parentRect.top - bounds.top, width: 2, height: parentRect.height }
            : { x: parentRect.left - bounds.left, y: edge - bounds.top - 1, width: parentRect.width, height: 2 }
        )
        next = { ...next, index }
        setPreview({ [next.id]: { transform: `translate(${dx}px, ${dy}px)`, opacity: 0.6, zIndex: 1 } })
        break
      }
      case 'marquee': {
        const point = canvasPoint(event)
        const start = canvasPoint({ clientX: next.startX, clientY: next.startY })
        const rect = {
          x: Math.min(point.x, start.x),
          y: Math.min(point.y, start.y),
          width: Math.abs(point.x - start.x),
          height: Math.abs(point.y - start.y)
        }
        const bounds = ref.current!.getBoundingClientRect()
        const touched = nodes
          .filter((node) => {
            const r = nodeElement(ref.current!, node.id)?.getBoundingClientRect()
            if (!r) return false
            const left = r.left - bounds.left
            const top = r.top - bounds.top
            return left < rect.x + rect.width && left + r.width > rect.x && top < rect.y + rect.height && top + r.height > rect.y
          })
          .map((node) => node.id)
        store.select([...new Set([...next.base, ...touched])])
        next = { ...next, rect }
        break
      }
    }
    if (next !== gesture) setGesture(next)
  }

  const onPointerUp = (event: React.PointerEvent) => {
    const finished = gestureRef.current
    if (!finished || event.pointerId !== finished.pointerId) return
    const styles = previewRef.current
    setGesture(null)
    setPreview({})
    setInsertLine(null)
    if (!finished.active) return
    if (finished.kind === 'move' || finished.kind === 'resize') {
      const entries = Object.entries(styles)
      if (entries.length === 0) return
      store.transact(finished.kind === 'move' ? 'Move' : 'Resize', (tx) => {
        for (const [id, update] of entries) tx.updateStyles([id], update)
      })
    } else if (finished.kind === 'reorder' && finished.index !== finished.from) {
      store.transact('Reorder', (tx) => tx.moveNode(finished.id, finished.parentId, finished.index))
    }
  }

  // The pointer is captured during a press, so the double-click's target is the canvas itself; find
  // the layer under the cursor instead.
  const onDoubleClick = (event: React.MouseEvent) => {
    const next = deeper(pathAt(document.elementFromPoint(event.clientX, event.clientY)), store.getState().selection)
    if (next) store.select([next])
  }

  // Outlines are measured from the DOM, so layers laid out by flexbox get accurate bounds.
  const [selectedRects, setSelectedRects] = useState<{ id: string; rect: Rect }[]>([])
  const [hoverRect, setHoverRect] = useState<Rect | null>(null)
  const [workingRects, setWorkingRects] = useState<{ id: string; rect: Rect }[]>([])
  useLayoutEffect(() => {
    const canvas = ref.current!
    const outer = canvas.getBoundingClientRect()
    const screenRect = (id: string): Rect | null => {
      const el = nodeElement(canvas, id)
      if (!el) return null
      const inner = el.getBoundingClientRect()
      return { x: inner.left - outer.left, y: inner.top - outer.top, width: inner.width, height: inner.height }
    }
    const rects = (ids: string[]) =>
      ids.flatMap((id) => {
        const rect = screenRect(id)
        return rect ? [{ id, rect }] : []
      })
    setSelectedRects(rects(selection))
    setHoverRect(hoveredId && !selection.includes(hoveredId) ? screenRect(hoveredId) : null)
    setWorkingRects(rects(workingIds))
  }, [selection, hoveredId, workingIds, nodes, viewport, preview])

  const single = selection.length === 1 && selectedRects.length === 1 ? selectedRects[0] : null
  const dragging = !!gesture?.active && gesture.kind !== 'pan'

  return (
    <div
      ref={ref}
      className="canvas"
      data-panning={gesture?.kind === 'pan' ? 'active' : spaceHeld ? 'ready' : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => setHoveredId(null)}
      onDoubleClick={onDoubleClick}
      onAuxClick={(event) => event.preventDefault()}
    >
      <div
        className="canvas-world"
        data-x={viewport.x}
        data-y={viewport.y}
        data-zoom={viewport.zoom}
        style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}
      >
        <PreviewContext.Provider value={preview}>
          {nodes.map((node) => (
            <div key={node.id} data-select-id={node.id}>
              <NodeView node={node} />
            </div>
          ))}
        </PreviewContext.Provider>
      </div>
      <div className="canvas-overlay">
        {nodes.map((node) => {
          const rect = toScreen(nodeRect({ ...node, style: { ...node.style, ...preview[node.id] } }), viewport)
          return (
            <div
              key={node.id}
              className="artboard-label"
              data-select-id={node.id}
              data-selected={selection.includes(node.id) || undefined}
              style={{ left: rect.x, top: rect.y - 20, maxWidth: Math.max(rect.width, 40) }}
            >
              {node.name}
            </div>
          )
        })}
        {workingRects.map(({ id, rect }) => (
          <div
            key={id}
            className="working-indicator"
            data-artboard-id={id}
            style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
          >
            <span className="working-label">Agent working</span>
          </div>
        ))}
        {hoverRect && !dragging && (
          <div
            className="hover-outline"
            style={{ left: hoverRect.x, top: hoverRect.y, width: hoverRect.width, height: hoverRect.height }}
          />
        )}
        {selectedRects.map(({ id, rect }) => (
          <div
            key={id}
            className="selection-outline"
            data-outline-id={id}
            style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
          />
        ))}
        {single && gesture?.kind !== 'reorder' && (
          <>
            {HANDLES.map((handle) => {
              const { x, y, width, height } = single.rect
              const hx = handle.includes('w') ? x : handle.includes('e') ? x + width : x + width / 2
              const hy = handle.includes('n') ? y : handle.includes('s') ? y + height : y + height / 2
              return <div key={handle} className="resize-handle" data-handle={handle} style={{ left: hx, top: hy }} />
            })}
            <div
              className="size-label"
              style={{ left: single.rect.x + single.rect.width / 2, top: single.rect.y + single.rect.height + 8 }}
            >
              {Math.round(single.rect.width / viewport.zoom)} x {Math.round(single.rect.height / viewport.zoom)}
            </div>
          </>
        )}
        {insertLine && (
          <div
            className="insert-line"
            style={{ left: insertLine.x, top: insertLine.y, width: insertLine.width, height: insertLine.height }}
          />
        )}
        {gesture?.kind === 'marquee' && gesture.active && (
          <div
            className="marquee"
            style={{ left: gesture.rect.x, top: gesture.rect.y, width: gesture.rect.width, height: gesture.rect.height }}
          />
        )}
      </div>
    </div>
  )
}
