import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { CSSStyle, DesignNode, Viewport } from '../../shared/document'
import { type DocumentStore, setNodeLocator } from '../document/store'
import { findNode } from '../document/tree'
import { CLIPBOARD_TYPE, copySelection, deleteSelection, duplicateSelection, paste, selectAll } from './commands'
import { NodeView } from './NodeView'
import { type Preview, PreviewContext, PreviewStore } from './preview'
import { type Editing, EditingContext } from './TextEditor'
import {
  CORNER_PROPERTIES,
  CORNERS,
  type Corner,
  type Frame,
  frameOf,
  type Handle,
  type HandleInfo,
  halfExtent,
  handleInfoOf,
  OPPOSITE,
  PADDING_PROPERTIES,
  rotateVector,
  SelectionFrame,
  SIDES,
  type Side
} from './handles'
import { type Guide, guidesForBox, snapMove, snapValue, type SpacingMarker, unionRect } from './snap'
import { CommentLayer, layerOrigin, type Pin } from './Comments'
import { idsIn, measuringAll, offscreenArtboards } from './offscreen'
import { LayerMenu } from '../panels/LayerMenu'
import { Toolbar } from './Toolbar'
import {
  containerOn,
  drawArtboard,
  drawFrame,
  drawShape,
  drawText,
  isPlaceableImage,
  type Placement,
  placeImage,
  placeLayers,
  replaceImage,
  textLayer,
  type Tool,
  TOOL_BY_KEY
} from './tools'
import { parseHTML, pastedFragment } from '../mcp/html'
import { showNotice } from '../panels/notice'
import { deeper, nodeElement, parentIdOf, pathAt, pickAtDepth } from './selection'
import { nodeRect, type Rect, toScreen, zoomAt } from './viewport'

interface CanvasProps {
  store: DocumentStore
  nodes: DesignNode[]
  viewport: Viewport
  selection: string[]
  /** Artboards an agent is writing to, outlined with a working label. */
  workingIds: string[]
  /** Live overrides from outside the canvas, such as scrubbing a value in the styles panel. */
  externalPreview: Preview
  onViewportChange: (viewport: Viewport) => void
  onResize: (size: { width: number; height: number }) => void
  /** The comment thread whose popover is open (S-16), shared with the Comments panel. */
  openThread: string | null
  onOpenThread: (id: string | null) => void
}


interface Box {
  left: number
  top: number
  width: number
  height: number
}

type Offsets = Record<string, { left: number; top: number }>

type Gesture = { pointerId: number; startX: number; startY: number; active: boolean } & (
  | { kind: 'pan'; origin: Viewport }
  | {
      kind: 'move'
      origins: Offsets
      /** Snapping context, in canvas-relative screen px: the moved layers' bounds and what they snap to. */
      box: Rect
      siblings: Rect[]
      parent: Rect | null
      /** Alt + drag: the layers moving are copies made when the drag began. */
      duplicated: boolean
      /** The artboard under the pointer, when the layers would move into it. */
      dropArtboard: string | null
    }
  | { kind: 'reorder'; id: string; parentId: string; target: string; axis: 'x' | 'y'; from: number; index: number }
  | { kind: 'resize'; id: string; handle: Handle; origin: Box; positioned: boolean; angle: number; screen: Rect; targets: Rect[] }
  | { kind: 'rotate'; id: string; center: { x: number; y: number }; start: number; origin: number }
  | { kind: 'radius'; id: string; corner: Corner; origin: Record<Corner, number>; max: number; angle: number }
  | { kind: 'padding'; id: string; side: Side; origin: Record<Side, number>; angle: number }
  | { kind: 'gap'; id: string; axis: 'x' | 'y'; origin: number; angle: number }
  | { kind: 'marquee'; base: string[]; rect: Rect }
  | { kind: 'draw'; tool: 'artboard' | 'frame' | 'rectangle' | 'circle' | 'text' | 'image'; parentId: string | null; rect: Rect; start: { x: number; y: number }; targets: Rect[] }
)

/** Gestures that end by writing their preview styles, with their undo labels. */
const STYLE_GESTURES: Partial<Record<Gesture['kind'], string>> = {
  move: 'Move',
  resize: 'Resize',
  rotate: 'Rotate',
  radius: 'Corner radius',
  padding: 'Padding',
  gap: 'Gap'
}

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

export function Canvas({
  store,
  nodes,
  viewport,
  selection,
  workingIds,
  externalPreview,
  onViewportChange,
  onResize,
  openThread,
  onOpenThread
}: CanvasProps) {
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
  // The text layer being edited in place, if any; `fresh` when it was just drawn.
  const [editingState, setEditing] = useState<{ id: string; fresh: boolean } | null>(null)
  const editingId = editingState?.id ?? null
  const editing = useMemo<Editing>(
    () => ({ id: editingId, fresh: !!editingState?.fresh, store, done: () => setEditing(null) }),
    [editingId, editingState, store]
  )
  useEffect(() => {
    if (editingId && !(selection.length === 1 && selection[0] === editingId)) setEditing(null)
  }, [selection, editingId])
  const [insertLine, setInsertLine] = useState<Rect | null>(null)
  const [commentDraft, setCommentDraft] = useState<Pin | null>(null)
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number } | null>(null)
  const [layerMenu, setLayerMenu] = useState<{ x: number; y: number } | null>(null)
  const closeLayerMenu = useCallback(() => setLayerMenu(null), [])
  const [tool, setToolState] = useState<Tool>('select')
  const toolRef = useRef<Tool>('select')
  const setTool = useCallback((next: Tool) => {
    toolRef.current = next
    setToolState(next)
  }, [])
  // Keys held down right now: holding a tool's key while drawing keeps that tool afterwards.
  const heldKeys = useRef(new Set<string>())
  const imageInput = useRef<HTMLInputElement>(null)
  const pendingImage = useRef<{ placement: Placement; containerSize: { width: number; height: number } | null } | null>(null)
  // Handlers registered once read the latest values from refs.
  const viewportRef = useRef(viewport)
  const worldRef = useRef<HTMLDivElement>(null)
  // While the viewport moves, the world is its own compositor layer, so a pan or zoom frame only moves
  // pixels (S-21). It settles back a moment after the last change, sharp again.
  useLayoutEffect(() => {
    const world = worldRef.current
    if (!world) return
    world.setAttribute('data-moving', '')
    const settle = setTimeout(() => world.removeAttribute('data-moving'), 160)
    return () => clearTimeout(settle)
  }, [viewport])
  viewportRef.current = viewport
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  // Deleting a layer leaves its comment threads where it was, measured here (S-16 Req 5).
  useEffect(() => {
    setNodeLocator((id) => (ref.current ? measuringAll(() => layerOrigin(ref.current!, id, viewportRef.current)) : null))
    return () => setNodeLocator(null)
  }, [])
  const nudge = useRef<{ origins: Offsets; dx: number; dy: number; timer?: ReturnType<typeof setTimeout> } | null>(null)

  const parentOf = useCallback((id: string) => parentIdOf(ref.current!, id), [])

  /** A layer's box in world units: its offset within its positioning parent and its rendered size. */
  const boxOf = (id: string): Box | null => {
    const el = nodeElement(ref.current!, id)
    if (!el) return null
    const zoom = viewportRef.current.zoom
    const frame = frameOf(el, ref.current!.getBoundingClientRect(), zoom)
    return { left: el.offsetLeft, top: el.offsetTop, width: frame.width / zoom, height: frame.height / zoom }
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
      const next = { width: entry.contentRect.width, height: entry.contentRect.height }
      setCanvasSize(next)
      onResize(next)
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
      const toolKey = TOOL_BY_KEY[event.key.toLowerCase()]
      if (toolKey && !mod && !event.altKey && !event.repeat) {
        heldKeys.current.add(event.key.toLowerCase())
        setTool(toolKey)
        return
      }
      if (event.key === 'Escape' && toolRef.current !== 'select') {
        setTool('select')
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
      heldKeys.current.delete(event.key.toLowerCase())
      if (event.code === 'Space') setSpaceHeld(false)
    }
    const blur = () => {
      heldKeys.current.clear()
      setSpaceHeld(false)
    }
    // Copy, cut and paste arrive as clipboard events from the keyboard and from the Edit menu alike.
    const onCopy = (event: ClipboardEvent) => {
      if (isTyping(document.activeElement)) return
      const data = copySelection(store)
      if (!data || !event.clipboardData) return
      event.preventDefault()
      event.clipboardData.setData(CLIPBOARD_TYPE, data.json)
      event.clipboardData.setData('text/plain', data.text)
      event.clipboardData.setData('text/html', data.html)
      if (event.type === 'cut') deleteSelection(store)
    }
    const onPaste = (event: ClipboardEvent) => {
      if (isTyping(document.activeElement)) return
      const json = event.clipboardData?.getData(CLIPBOARD_TYPE)
      if (json && paste(store, json, measure)) event.preventDefault()
      else if (event.clipboardData && pasteExternal.current(event.clipboardData)) event.preventDefault()
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
  }, [store, commitNudge, measure, setPreview, setTool])

  const canvasPoint = (event: { clientX: number; clientY: number }) => {
    const bounds = ref.current!.getBoundingClientRect()
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
  }

  /** A layer's border box in canvas-relative screen px. */
  const screenRectOf = (id: string): Rect | null => {
    const el = nodeElement(ref.current!, id)
    if (!el) return null
    const outer = ref.current!.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    return { x: r.left - outer.left, y: r.top - outer.top, width: r.width, height: r.height }
  }
  /** What layers in `parentId` (a node, or null for the page) snap to: their siblings and the parent. */
  const snapTargets = (parentId: string | null, exclude: string[]) => {
    const children = parentId ? (findNode(nodesRef.current, parentId)?.children ?? []) : nodesRef.current
    const siblings = children.filter((c) => !exclude.includes(c.id)).flatMap((c) => screenRectOf(c.id) ?? [])
    return { siblings, parent: parentId ? screenRectOf(parentId) : null }
  }
  const snapOff = (event: { metaKey: boolean; ctrlKey: boolean }) => event.metaKey || event.ctrlKey
  /** The artboard whose bounds hold a canvas point. */
  const artboardAt = (point: { x: number; y: number }) =>
    [...nodesRef.current].reverse().find((n) => {
      const r = screenRectOf(n.id)
      return r && point.x >= r.x && point.x <= r.x + r.width && point.y >= r.y && point.y <= r.y + r.height
    })?.id ?? null

  /** A canvas point (screen px) in a container's padding-box units, or in page units for null. */
  const toLocal = (parentId: string | null, point: { x: number; y: number }) => {
    const zoom = viewportRef.current.zoom
    if (parentId === null) return { x: (point.x - viewportRef.current.x) / zoom, y: (point.y - viewportRef.current.y) / zoom }
    const el = nodeElement(ref.current!, parentId)!
    const bounds = ref.current!.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    return { x: (point.x + bounds.left - r.left) / zoom - el.clientLeft, y: (point.y + bounds.top - r.top) / zoom - el.clientTop }
  }

  /** Where a drawn rectangle (screen px, canvas-relative) lands in its container. */
  const placementFor = (parentId: string | null, rect: Rect, clicked: boolean): Placement => {
    const zoom = viewportRef.current.zoom
    const origin = toLocal(parentId, rect)
    const el = parentId ? nodeElement(ref.current!, parentId) : null
    const flex = !!el && getComputedStyle(el).display.includes('flex')
    return { parentId, flex, clicked, box: { left: origin.x, top: origin.y, width: rect.width / zoom, height: rect.height / zoom } }
  }

  /** The rectangle from the press to the pointer: shift keeps a square, alt draws from the center. */
  const drawnRect = (start: { x: number; y: number }, point: { x: number; y: number }, square: boolean, fromCenter: boolean): Rect => {
    let dx = point.x - start.x
    let dy = point.y - start.y
    if (square) {
      const side = Math.max(Math.abs(dx), Math.abs(dy))
      dx = (dx < 0 ? -1 : 1) * side
      dy = (dy < 0 ? -1 : 1) * side
    }
    if (fromCenter) return { x: start.x - Math.abs(dx), y: start.y - Math.abs(dy), width: Math.abs(dx) * 2, height: Math.abs(dy) * 2 }
    return { x: Math.min(start.x, start.x + dx), y: Math.min(start.y, start.y + dy), width: Math.abs(dx), height: Math.abs(dy) }
  }

  const containerSizeOf = (parentId: string | null) => {
    const el = parentId ? nodeElement(ref.current!, parentId) : null
    return el ? { width: el.clientWidth, height: el.clientHeight } : null
  }

  /**
   * Where layers pasted from another app go (S-23 Req 1): the selected frame or artboard, the container
   * of a selected layer, or the artboard at the middle of the view. They land at the middle of the view
   * when it is inside that container, otherwise at its top-left corner.
   */
  const pasteTarget = (): Placement => {
    const bounds = ref.current!.getBoundingClientRect()
    const center = { x: bounds.width / 2, y: bounds.height / 2 }
    const selected = store.getState().selection[0]
    const node = selected ? findNode(nodesRef.current, selected) : null
    let parentId = node && (node.type === 'frame' || node.type === 'artboard') ? node.id : selected ? parentIdOf(ref.current!, selected) : null
    parentId ??= containerOn(pathAt(document.elementFromPoint(bounds.left + center.x, bounds.top + center.y)), nodesRef.current)
    let point = center
    const el = parentId ? nodeElement(ref.current!, parentId) : null
    if (el) {
      const r = el.getBoundingClientRect()
      const inside = bounds.left + center.x >= r.left && bounds.left + center.x <= r.right && bounds.top + center.y >= r.top && bounds.top + center.y <= r.bottom
      if (!inside) point = { x: r.left - bounds.left, y: r.top - bounds.top }
    }
    return placementFor(parentId, { ...point, width: 0, height: 0 }, true)
  }

  /** Pastes images, SVG, HTML or text from another app (S-23). Returns false when there is nothing to paste. */
  const pasteExternal = useRef<(data: DataTransfer) => boolean>(() => false)
  pasteExternal.current = (data) => {
    const file = [...data.files].find(isPlaceableImage)
    const html = data.getData('text/html')
    const plain = data.getData('text/plain')
    const svg = data.getData('image/svg+xml') || (/^\s*<svg[\s>]/i.test(plain) ? plain : '')
    if (!file && !svg && !html.trim() && !plain.trim()) return false
    const placement = pasteTarget()
    if (file || svg) {
      void placeImage(store, file ?? new File([svg], 'SVG.svg', { type: 'image/svg+xml' }), placement, containerSizeOf(placement.parentId), true)
      return true
    }
    if (placement.parentId === null) {
      showNotice('Select a frame or artboard to paste into')
      return true
    }
    // Markup copied as text (from a code editor) is the HTML the user means; its text/html is only highlighting.
    const markup = /^\s*<[a-z][\s\S]*>\s*$/i.test(plain) ? plain : html ? pastedFragment(html) : ''
    let layers = [textLayer(plain)]
    if (markup) {
      const parsed = parseHTML(markup)
      if (parsed.nodes.length > 0) layers = parsed.nodes
      if (parsed.dropped.length > 0) {
        const more = parsed.dropped.length > 2 ? ` and ${parsed.dropped.length - 2} more` : ''
        showNotice(`Pasted. Left out: ${parsed.dropped.slice(0, 2).join('; ')}${more}`)
      }
    }
    if (!markup && !plain.trim()) return false
    placeLayers(store, { ...placement, parentId: placement.parentId }, layers)
    return true
  }

  const addImage = async (file: File, placement: Placement, containerSize: { width: number; height: number } | null) => {
    if (!isPlaceableImage(file)) return
    await placeImage(store, file, placement, containerSize)
  }

  /** Creates the drawn layer, selects it, and goes back to Select unless the tool's key is held. */
  const finishDraw = (draw: Extract<Gesture, { kind: 'draw' }>) => {
    const clicked = !draw.active
    const placement = placementFor(draw.parentId, draw.rect, clicked)
    if (draw.tool === 'image') {
      pendingImage.current = { placement, containerSize: containerSizeOf(draw.parentId) }
      imageInput.current?.click()
    } else if (draw.tool === 'artboard') drawArtboard(store, placement)
    else if (draw.tool === 'frame') drawFrame(store, placement)
    else if (draw.tool === 'rectangle' || draw.tool === 'circle') drawShape(store, placement, draw.tool)
    else {
      const id = drawText(store, placement)
      setEditing({ id, fresh: true })
    }
    const key = Object.entries(TOOL_BY_KEY).find(([, t]) => t === draw.tool)?.[0]
    if (!key || !heldKeys.current.has(key)) setTool('select')
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
    // Clicks inside the text being edited move the caret and select text.
    if ((event.target as HTMLElement).closest('[data-editing]')) return
    const base = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, active: false }
    commitNudge()
    if (event.button === 1 || (event.button === 0 && (spaceHeld || tool === 'hand'))) {
      event.preventDefault()
      ref.current!.setPointerCapture(event.pointerId)
      setGesture({ ...base, kind: 'pan', origin: viewport, active: true })
      return
    }
    if (event.button !== 0) return
    ref.current!.setPointerCapture(event.pointerId)
    const target = event.target as HTMLElement

    if (tool === 'comment') {
      // A click on a layer pins the thread to it; on empty canvas, to that point.
      const path = pathAt(target)
      const nodeId = path[path.length - 1]
      const p = canvasPoint(event)
      const world = { x: (p.x - viewport.x) / viewport.zoom, y: (p.y - viewport.y) / viewport.zoom }
      const origin = nodeId ? layerOrigin(ref.current!, nodeId, viewport) : null
      onOpenThread(null)
      setCommentDraft(origin ? { nodeId, x: world.x - origin.x, y: world.y - origin.y } : world)
      return
    }

    if (tool === 'artboard' || tool === 'frame' || tool === 'rectangle' || tool === 'circle' || tool === 'text' || tool === 'image') {
      const container = tool === 'artboard' ? null : containerOn(pathAt(target), nodes)
      // A frame drawn on empty canvas becomes an artboard; text needs a container.
      if (tool === 'text' && !container) return
      const drawTool = tool === 'frame' && !container ? 'artboard' : tool
      const { siblings, parent } = snapTargets(drawTool === 'artboard' ? null : container, [])
      const targets = parent ? [...siblings, parent] : siblings
      const point = canvasPoint(event)
      if (!snapOff(event)) Object.assign(point, { x: snapValue(point.x, targets, 'x'), y: snapValue(point.y, targets, 'y') })
      const parentId = drawTool === 'artboard' ? null : container
      setGesture({ ...base, kind: 'draw', tool: drawTool, parentId, rect: { ...point, width: 0, height: 0 }, start: point, targets })
      return
    }

    const zone = target.closest<HTMLElement>('[data-handle],[data-rotate],[data-radius],[data-padding],[data-gap]')
    const single = selection.length === 1 ? selectedFrames.find((f) => f.id === selection[0]) : undefined
    if (zone && single) {
      const id = single.id
      const { frame } = single
      if (zone.dataset.handle) {
        const origin = boxOf(id)
        const positioned = isPositionedNode(findNode(nodes, id))
        const handle = zone.dataset.handle as Handle
        const screen = screenRectOf(id)
        const { siblings, parent } = snapTargets(parentOf(id), [id])
        const targets = parent ? [...siblings, parent] : siblings
        if (origin && screen) setGesture({ ...base, kind: 'resize', id, handle, origin, positioned, angle: frame.angle, screen, targets })
      } else if (zone.dataset.rotate) {
        const bounds = ref.current!.getBoundingClientRect()
        const center = { x: bounds.left + frame.cx, y: bounds.top + frame.cy }
        const start = (Math.atan2(event.clientY - center.y, event.clientX - center.x) * 180) / Math.PI
        setGesture({ ...base, kind: 'rotate', id, center, start, origin: frame.angle })
      } else if (zone.dataset.radius && handleInfo) {
        const max = Math.min(frame.width, frame.height) / 2 / viewport.zoom
        const corner = zone.dataset.radius as Corner
        setGesture({ ...base, kind: 'radius', id, corner, origin: handleInfo.radii, max, angle: frame.angle })
      } else if (zone.dataset.padding && handleInfo?.flex) {
        const side = zone.dataset.padding as Side
        setGesture({ ...base, kind: 'padding', id, side, origin: handleInfo.flex.padding, angle: frame.angle })
      } else if (zone.dataset.gap && handleInfo?.flex) {
        const { axis, gap } = handleInfo.flex
        setGesture({ ...base, kind: 'gap', id, axis, origin: gap, angle: frame.angle })
      }
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
      const box = unionRect(selected.flatMap((id) => screenRectOf(id) ?? []))
      const { siblings, parent } = snapTargets(parentOf(selected[0]), selected)
      if (!box) return
      setGesture({ ...base, kind: 'move', origins: offsetsOf(selected), box, siblings, parent, duplicated: false, dropArtboard: null })
      return
    }
    const parentId = parentOf(picked)
    if (selected.length === 1 && parentId) {
      const parentStyle = getComputedStyle(nodeElement(ref.current!, parentId)!)
      const axis = parentStyle.display.includes('flex') && parentStyle.flexDirection.startsWith('row') ? 'x' : 'y'
      const from = findNode(nodes, parentId)!.children.findIndex((child) => child.id === picked)
      setGesture({ ...base, kind: 'reorder', id: picked, parentId, target: parentId, axis, from, index: from })
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
      case 'move': {
        // Alt + drag moves copies, made once as the drag begins.
        if (!gesture.active && event.altKey) {
          const ids = Object.keys(next.origins)
          const copies = store.transact('Duplicate', (tx) => {
            const made = ids.map((id) => tx.duplicateNode(id).newId)
            tx.select(made)
            return made
          })
          const origins = next.origins
          next = { ...next, duplicated: true, origins: Object.fromEntries(ids.map((id, i) => [copies[i], origins[id]])) }
        }
        let sdx = screenDx
        let sdy = screenDy
        // Shift keeps the drag on the axis it has moved most along.
        const lock = event.shiftKey ? (Math.abs(sdx) >= Math.abs(sdy) ? 'y' : 'x') : null
        if (lock === 'y') sdy = 0
        if (lock === 'x') sdx = 0
        if (snapOff(event)) {
          setGuides([])
          setSpacing([])
        } else {
          const snap = snapMove(next.box, sdx, sdy, next.siblings, next.parent, lock)
          sdx = snap.dx
          sdy = snap.dy
          setGuides(snap.guides)
          setSpacing(snap.spacing)
        }
        const offsets = offsetStyles(next.origins, sdx / viewport.zoom, sdy / viewport.zoom)
        // Layers (not artboards) dragged over another artboard move into it on release.
        // Read from the store: copies made by alt + drag are not rendered yet.
        const { document: doc, pageId } = store.getState()
        const pageNodes = doc.pages.find((p) => p.id === pageId)?.nodes ?? []
        const ids = Object.keys(next.origins)
        const layers = ids.every((id) => findNode(pageNodes, id)?.type !== 'artboard')
        const over = layers ? artboardAt(canvasPoint(event)) : null
        const home = layers ? pageNodes.find((a) => findNode(a.children, ids[0]))?.id : null
        next = { ...next, dropArtboard: over && over !== home ? over : null }
        // The home artboard stops clipping while layers are dragged, so they stay visible outside it.
        setPreview(home ? { ...offsets, [home]: { overflow: 'visible' } } : offsets)
        break
      }
      case 'resize': {
        // Along the layer's own axes, so rotated layers resize the way they are drawn.
        let rdx = screenDx
        let rdy = screenDy
        const snapping = !next.angle && !event.altKey && !event.shiftKey && !snapOff(event)
        if (snapping) {
          const s = next.screen
          if (next.handle.includes('e')) rdx = snapValue(s.x + s.width + rdx, next.targets, 'x') - s.x - s.width
          if (next.handle.includes('w')) rdx = snapValue(s.x + rdx, next.targets, 'x') - s.x
          if (next.handle.includes('s')) rdy = snapValue(s.y + s.height + rdy, next.targets, 'y') - s.y - s.height
          if (next.handle.includes('n')) rdy = snapValue(s.y + rdy, next.targets, 'y') - s.y
          const sx = next.handle.includes('e') ? 1 : next.handle.includes('w') ? -1 : 0
          const sy = next.handle.includes('s') ? 1 : next.handle.includes('n') ? -1 : 0
          const box = {
            x: sx === -1 ? s.x + rdx : s.x,
            y: sy === -1 ? s.y + rdy : s.y,
            width: s.width + sx * rdx,
            height: s.height + sy * rdy
          }
          setGuides(guidesForBox(box, next.targets).filter((g) => (g.x1 === g.x2 ? sx !== 0 : sy !== 0)))
        } else setGuides([])
        const local = rotateVector({ x: rdx / viewport.zoom, y: rdy / viewport.zoom }, -next.angle)
        const box = resized(next.origin, next.handle, local.x, local.y, event.shiftKey, event.altKey)
        if (next.angle) {
          // CSS rotates around the center: shift the box so the opposite edge stays put on screen.
          const o = next.origin
          const v = { x: o.left + o.width / 2 - (box.left + box.width / 2), y: o.top + o.height / 2 - (box.top + box.height / 2) }
          const turned = rotateVector(v, next.angle)
          box.left += v.x - turned.x
          box.top += v.y - turned.y
        }
        const style: CSSStyle = { width: px(box.width), height: px(box.height) }
        if (next.positioned) Object.assign(style, { left: px(box.left), top: px(box.top) })
        setPreview({ [next.id]: style })
        break
      }
      case 'rotate': {
        const pointer = (Math.atan2(event.clientY - next.center.y, event.clientX - next.center.x) * 180) / Math.PI
        let angle = next.origin + pointer - next.start
        angle = ((((angle + 180) % 360) + 360) % 360) - 180
        angle = event.shiftKey ? Math.round(angle / 15) * 15 : Math.round(angle * 10) / 10
        if (Object.is(angle, -0) || angle === -180) angle = Math.abs(angle)
        setPreview({ [next.id]: { rotate: `${angle}deg` } })
        setHandleLabel({ ...canvasPoint(event), text: `${angle}°` })
        break
      }
      case 'radius': {
        // Toward the center along the corner's diagonal.
        const local = rotateVector({ x: dx, y: dy }, -next.angle)
        const sx = next.corner.includes('w') ? 1 : -1
        const sy = next.corner.includes('n') ? 1 : -1
        const value = Math.round(Math.min(next.max, Math.max(0, next.origin[next.corner] + (local.x * sx + local.y * sy) / 2)))
        const preview: Record<string, string | undefined> = { borderRadius: event.altKey ? undefined : px(value) }
        for (const corner of CORNERS) {
          preview[CORNER_PROPERTIES[corner]] = event.altKey ? px(corner === next.corner ? value : next.origin[corner]) : undefined
        }
        setPreview({ [next.id]: preview as CSSStyle })
        setHandleLabel({ ...canvasPoint(event), text: `Radius ${value}` })
        break
      }
      case 'padding': {
        const local = rotateVector({ x: dx, y: dy }, -next.angle)
        const inward = { top: local.y, bottom: -local.y, left: local.x, right: -local.x }[next.side]
        const value = Math.round(Math.max(0, next.origin[next.side] + inward))
        const sides = event.shiftKey ? SIDES : event.altKey ? [next.side, OPPOSITE[next.side]] : [next.side]
        const preview: Record<string, string | undefined> = { padding: event.shiftKey ? px(value) : undefined }
        for (const side of SIDES) {
          preview[PADDING_PROPERTIES[side]] = event.shiftKey ? undefined : px(sides.includes(side) ? value : next.origin[side])
        }
        setPreview({ [next.id]: preview as CSSStyle })
        setHandleLabel({ ...canvasPoint(event), text: `Padding ${value}` })
        break
      }
      case 'gap': {
        const local = rotateVector({ x: dx, y: dy }, -next.angle)
        const value = Math.round(Math.max(0, next.origin + (next.axis === 'x' ? local.x : local.y)))
        setPreview({ [next.id]: { gap: px(value), rowGap: undefined, columnGap: undefined } as unknown as CSSStyle })
        setHandleLabel({ ...canvasPoint(event), text: `Gap ${value}` })
        break
      }
      case 'reorder': {
        // The flex container under the pointer takes the layer; it can be another container.
        const draggedId = next.id
        const under = pathAt(document.elementFromPoint(event.clientX, event.clientY))
        const target =
          [...under].reverse().find((id) => {
            if (id === draggedId) return false
            const n = findNode(nodes, id)
            const el = nodeElement(ref.current!, id)
            return (n?.type === 'frame' || n?.type === 'artboard') && !!el && getComputedStyle(el).display.includes('flex')
          }) ?? next.parentId
        if (target !== next.target) {
          const style = getComputedStyle(nodeElement(ref.current!, target)!)
          next = { ...next, target, axis: style.flexDirection.startsWith('row') ? 'x' : 'y' }
        }
        // The dragged layer goes before the first sibling whose middle is past the pointer.
        const parentEl = nodeElement(ref.current!, next.target)!
        const bounds = ref.current!.getBoundingClientRect()
        const x = next.axis === 'x'
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
        setPreview({ [next.id]: { transform: `translate(${dx}px, ${dy}px)`, opacity: 0.6, zIndex: 1, pointerEvents: 'none' } })
        break
      }
      case 'draw': {
        const point = canvasPoint(event)
        if (!snapOff(event)) Object.assign(point, { x: snapValue(point.x, next.targets, 'x'), y: snapValue(point.y, next.targets, 'y') })
        // Circles stay round, as in doop; Shift keeps other boxes square.
        const rect = drawnRect(next.start, point, event.shiftKey || next.tool === 'circle', event.altKey)
        setGuides(snapOff(event) ? [] : guidesForBox(rect, next.targets))
        next = { ...next, rect }
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
            if (node.locked) return false
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
    setHandleLabel(null)
    setGuides([])
    setSpacing([])
    if (finished.kind === 'draw') return finishDraw(finished)
    if (!finished.active) return
    if (STYLE_GESTURES[finished.kind]) {
      // Only the dragged layers' styles are written (a move also previews its artboard unclipped).
      const entries = Object.entries(styles).filter(([id]) => finished.kind !== 'move' || id in finished.origins)
      if (entries.length === 0) return
      // Layers dropped on another artboard move into it where they are on screen. The DOM still
      // shows the preview here, so positions are read before anything changes.
      const drop = finished.kind === 'move' ? finished.dropArtboard : null
      const dropped = drop
        ? entries.map(([id]) => {
            const el = nodeElement(ref.current!, id)!
            const frame = frameOf(el, ref.current!.getBoundingClientRect(), viewportRef.current.zoom)
            const at = toLocal(drop, { x: frame.cx - frame.width / 2, y: frame.cy - frame.height / 2 })
            return { id, left: px(at.x), top: px(at.y) }
          })
        : []
      // Previews mark removed properties as undefined; the document removes them with null.
      store.transact(
        STYLE_GESTURES[finished.kind]!,
        (tx) => {
          for (const [id, update] of entries) {
            tx.updateStyles([id], Object.fromEntries(Object.entries(update).map(([k, v]) => [k, v ?? null])))
          }
          for (const { id, left, top } of dropped) {
            tx.moveNode(id, drop!)
            tx.updateStyles([id], { left, top })
          }
        },
        finished.kind === 'move' && finished.duplicated
      )
    } else if (finished.kind === 'reorder' && finished.target !== finished.parentId) {
      store.transact('Move into', (tx) => tx.moveNode(finished.id, finished.target, finished.index))
    } else if (finished.kind === 'reorder' && finished.index !== finished.from) {
      store.transact('Reorder', (tx) => tx.moveNode(finished.id, finished.parentId, finished.index))
    }
  }

  // The pointer is captured during a press, so the double-click's target is the canvas itself; find
  // the layer under the cursor instead.
  // Double-clicking a selected text layer, or drilling into one, edits it in place.
  const onDoubleClick = (event: React.MouseEvent) => {
    const hit = document.elementFromPoint(event.clientX, event.clientY)
    if (hit?.closest('[data-editing]')) return
    const path = pathAt(hit)
    const selected = store.getState().selection
    const isText = (id: string) => findNode(nodesRef.current, id)?.type === 'text'
    const target = selected.length === 1 && path.includes(selected[0]) && isText(selected[0]) ? selected[0] : deeper(path, selected)
    if (!target) return
    store.select([target])
    if (isText(target)) setEditing({ id: target, fresh: false })
  }

  // Outlines are measured from the DOM, so layers laid out by flexbox get accurate bounds.
  // Selection and hover outlines follow each layer's rotation (S-10).
  const [selectedFrames, setSelectedFrames] = useState<{ id: string; frame: Frame }[]>([])
  const [hoverFrame, setHoverFrame] = useState<Frame | null>(null)
  const [handleInfo, setHandleInfo] = useState<HandleInfo | null>(null)
  const [guides, setGuides] = useState<Guide[]>([])
  const [spacing, setSpacing] = useState<SpacingMarker[]>([])
  const [handleLabel, setHandleLabel] = useState<{ x: number; y: number; text: string } | null>(null)
  const [workingRects, setWorkingRects] = useState<{ id: string; rect: Rect }[]>([])
  useLayoutEffect(() => {
    const canvas = ref.current!
    const outer = canvas.getBoundingClientRect()
    const zoom = viewport.zoom
    const frames = selection.flatMap((id) => {
      const el = nodeElement(canvas, id)
      return el ? [{ id, frame: frameOf(el, outer, zoom) }] : []
    })
    setSelectedFrames(frames)
    const hoverEl = hoveredId && !selection.includes(hoveredId) ? nodeElement(canvas, hoveredId) : null
    setHoverFrame(hoverEl ? frameOf(hoverEl, outer, zoom) : null)
    const singleEl = selection.length === 1 ? nodeElement(canvas, selection[0]) : null
    const singleNode = singleEl ? findNode(nodes, selection[0]) : null
    setHandleInfo(singleEl && singleNode ? handleInfoOf(singleEl, singleNode) : null)
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
    setWorkingRects(rects(workingIds))
  }, [selection, hoveredId, workingIds, nodes, viewport, preview, externalPreview])

  // Artboards holding the selection or being edited stay rendered, so their outlines and handles measure.
  const keepRendered = useMemo(() => {
    const ids = [...selection, ...(editingId ? [editingId] : []), ...Object.keys(preview), ...Object.keys(externalPreview)]
    return new Set(nodes.filter((a) => ids.some((id) => idsIn(a).has(id))).map((a) => a.id))
  }, [nodes, selection, editingId, preview, externalPreview])
  const offscreen = useMemo(() => offscreenArtboards(nodes, viewport, canvasSize, keepRendered), [nodes, viewport, canvasSize, keepRendered])

  const merged = useMemo(() => {
    const out: Preview = { ...externalPreview }
    for (const [id, style] of Object.entries(preview)) out[id] = { ...out[id], ...style }
    return out
  }, [preview, externalPreview])
  const [drawn] = useState(() => new PreviewStore())
  useLayoutEffect(() => drawn.set({ ...merged }), [drawn, merged])

  const single = selection.length === 1 && selectedFrames.length === 1 ? selectedFrames[0] : null
  const showHandles = !!single && gesture?.kind !== 'reorder' && !editingId
  const shade = gesture?.kind === 'padding' ? 'padding' : gesture?.kind === 'gap' ? 'gap' : null
  const dragging = !!gesture?.active && gesture.kind !== 'pan'

  return (
    <div
      ref={ref}
      className="canvas"
      data-panning={gesture?.kind === 'pan' ? 'active' : spaceHeld || tool === 'hand' ? 'ready' : undefined}
      data-tool={tool}
      onContextMenu={(event) => {
        // Right-click picks the layer under the cursor unless it is already selected (S-19 Req 6).
        event.preventDefault()
        const id = pick(event.target, false)
        if (!id) return
        if (!store.getState().selection.includes(id)) store.select([id])
        setLayerMenu({ x: event.clientX, y: event.clientY })
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => setHoveredId(null)}
      onDoubleClick={onDoubleClick}
      onAuxClick={(event) => event.preventDefault()}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault()
      }}
      onDrop={(event) => {
        const files = [...event.dataTransfer.files].filter(isPlaceableImage)
        if (files.length === 0) return
        event.preventDefault()
        // Alt/Option + drop on an image layer swaps its picture instead of adding a layer (S-26 Req 4).
        const onImage = (document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-node-type="image"]')
        if (event.altKey && onImage && !onImage.closest('[data-locked]')) {
          void replaceImage(store, onImage.dataset.nodeId!, files[0])
          return
        }
        const parentId = containerOn(pathAt(document.elementFromPoint(event.clientX, event.clientY)), nodes)
        const point = canvasPoint(event)
        void addImage(files[0], placementFor(parentId, { ...point, width: 0, height: 0 }, true), containerSizeOf(parentId))
      }}
    >
      <div
        ref={worldRef}
        className="canvas-world"
        data-x={viewport.x}
        data-y={viewport.y}
        data-zoom={viewport.zoom}
        style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}
      >
        <PreviewContext.Provider value={drawn}>
          <EditingContext.Provider value={editing}>
            {nodes.map((node) => (
              <div key={node.id} data-select-id={node.id} data-offscreen={offscreen.has(node.id) || undefined}>
                <NodeView node={node} />
              </div>
            ))}
          </EditingContext.Provider>
        </PreviewContext.Provider>
      </div>
      <div className="canvas-overlay">
        {nodes.map((node) => {
          const rect = toScreen(nodeRect({ ...node, style: { ...node.style, ...merged[node.id] } }), viewport)
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
        {hoverFrame && !dragging && (
          <div
            className="hover-outline"
            style={{
              left: hoverFrame.cx - hoverFrame.width / 2,
              top: hoverFrame.cy - hoverFrame.height / 2,
              width: hoverFrame.width,
              height: hoverFrame.height,
              transform: hoverFrame.angle ? `rotate(${hoverFrame.angle}deg)` : undefined
            }}
          />
        )}
        {selectedFrames.map(({ id, frame }) => (
          <SelectionFrame
            key={id}
            id={id}
            frame={frame}
            info={single?.id === id ? handleInfo : null}
            zoom={viewport.zoom}
            showHandles={showHandles}
            activeShade={shade}
          />
        ))}
        {showHandles && single && (
          <div
            className="size-label"
            style={{ left: single.frame.cx, top: single.frame.cy + halfExtent(single.frame).y + 8 }}
          >
            {Math.round(single.frame.width / viewport.zoom)} x {Math.round(single.frame.height / viewport.zoom)}
          </div>
        )}
        {guides.map((g, i) => (
          <div
            key={`g${i}`}
            className="snap-guide"
            style={{ left: Math.min(g.x1, g.x2), top: Math.min(g.y1, g.y2), width: Math.max(1, Math.abs(g.x2 - g.x1)), height: Math.max(1, Math.abs(g.y2 - g.y1)) }}
          />
        ))}
        {spacing.map((g, i) => (
          <div
            key={`s${i}`}
            className="spacing-marker"
            data-vertical={g.x1 === g.x2 || undefined}
            style={{ left: Math.min(g.x1, g.x2), top: Math.min(g.y1, g.y2), width: Math.max(1, Math.abs(g.x2 - g.x1)), height: Math.max(1, Math.abs(g.y2 - g.y1)) }}
          />
        ))}
        {gesture?.kind === 'move' && gesture.dropArtboard && (() => {
          const r = screenRectOf(gesture.dropArtboard)
          return r && <div className="drop-target" style={{ left: r.x, top: r.y, width: r.width, height: r.height }} />
        })()}
        {handleLabel && (
          <div className="handle-label" style={{ left: handleLabel.x + 14, top: handleLabel.y + 14 }}>
            {handleLabel.text}
          </div>
        )}
        {insertLine && (
          <div
            className="insert-line"
            style={{ left: insertLine.x, top: insertLine.y, width: insertLine.width, height: insertLine.height }}
          />
        )}
        {gesture?.kind === 'draw' && gesture.active && (
          <>
            <div
              className="draw-rect"
              style={{ left: gesture.rect.x, top: gesture.rect.y, width: gesture.rect.width, height: gesture.rect.height }}
            />
            <div className="size-label" style={{ left: gesture.rect.x + gesture.rect.width / 2, top: gesture.rect.y + gesture.rect.height + 8 }}>
              {Math.round(gesture.rect.width / viewport.zoom)} x {Math.round(gesture.rect.height / viewport.zoom)}
            </div>
          </>
        )}
        <CommentLayer
          store={store}
          canvas={ref}
          viewport={viewport}
          layoutKey={drawn}
          openThread={openThread}
          onOpenThread={onOpenThread}
          draft={commentDraft}
          onDraft={setCommentDraft}
        />
        {gesture?.kind === 'marquee' && gesture.active && (
          <div
            className="marquee"
            style={{ left: gesture.rect.x, top: gesture.rect.y, width: gesture.rect.width, height: gesture.rect.height }}
          />
        )}
      </div>
      <Toolbar tool={tool} onSelect={setTool} />
      {layerMenu && <LayerMenu store={store} x={layerMenu.x} y={layerMenu.y} onClose={closeLayerMenu} />}
      <input
        ref={imageInput}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
        data-image-input=""
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          const pending = pendingImage.current
          event.target.value = ''
          pendingImage.current = null
          if (file && pending) void addImage(file, pending.placement, pending.containerSize)
        }}
      />
    </div>
  )
}
