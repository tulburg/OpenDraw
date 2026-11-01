import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { DesignNode, Viewport } from '../../shared/document'
import { NodeView } from './NodeView'
import { nodeRect, type Rect, toScreen, zoomAt } from './viewport'

interface CanvasProps {
  nodes: DesignNode[]
  viewport: Viewport
  selectedId: string | null
  /** Artboards an agent is writing to, outlined with a working label. */
  workingIds: string[]
  onViewportChange: (viewport: Viewport) => void
  onSelect: (id: string | null) => void
  onResize: (size: { width: number; height: number }) => void
}

interface Pan {
  pointerId: number
  startX: number
  startY: number
  origin: Viewport
}

const WHEEL_ZOOM_SPEED = 0.01
const MAX_WHEEL_ZOOM_DELTA = 50

export function Canvas({
  nodes,
  viewport,
  selectedId,
  workingIds,
  onViewportChange,
  onSelect,
  onResize
}: CanvasProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [pan, setPan] = useState<Pan | null>(null)
  // The wheel listener is registered once, so it reads the latest viewport from a ref.
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport

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

  useEffect(() => {
    const isTyping = (target: EventTarget | null) =>
      target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target.tagName))
    const down = (event: KeyboardEvent) => {
      if (event.code === 'Space' && !isTyping(event.target)) {
        event.preventDefault()
        setSpaceHeld(true)
      }
    }
    const up = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpaceHeld(false)
    }
    const blur = () => setSpaceHeld(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button === 1 || (event.button === 0 && spaceHeld)) {
      event.preventDefault()
      ref.current!.setPointerCapture(event.pointerId)
      setPan({ pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: viewport })
      return
    }
    if (event.button !== 0) return
    const hit = (event.target as HTMLElement).closest<HTMLElement>('[data-select-id]')
    onSelect(hit?.dataset.selectId ?? null)
  }

  const onPointerMove = (event: React.PointerEvent) => {
    if (!pan || event.pointerId !== pan.pointerId) return
    onViewportChange({
      ...pan.origin,
      x: pan.origin.x + event.clientX - pan.startX,
      y: pan.origin.y + event.clientY - pan.startY
    })
  }

  const endPan = (event: React.PointerEvent) => {
    if (pan && event.pointerId === pan.pointerId) setPan(null)
  }

  // Measured from the DOM, so nested nodes laid out by flexbox get an accurate outline.
  const [selectedRect, setSelectedRect] = useState<Rect | null>(null)
  const [workingRects, setWorkingRects] = useState<{ id: string; rect: Rect }[]>([])
  useLayoutEffect(() => {
    const canvas = ref.current!
    const outer = canvas.getBoundingClientRect()
    const measure = (id: string): Rect | null => {
      const el = canvas.querySelector(`[data-node-id="${CSS.escape(id)}"]`)
      if (!el) return null
      const inner = el.getBoundingClientRect()
      return { x: inner.left - outer.left, y: inner.top - outer.top, width: inner.width, height: inner.height }
    }
    setSelectedRect(selectedId ? measure(selectedId) : null)
    setWorkingRects(
      workingIds.flatMap((id) => {
        const rect = measure(id)
        return rect ? [{ id, rect }] : []
      })
    )
  }, [selectedId, workingIds, nodes, viewport])

  return (
    <div
      ref={ref}
      className="canvas"
      data-panning={pan ? 'active' : spaceHeld ? 'ready' : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onAuxClick={(event) => event.preventDefault()}
    >
      <div
        className="canvas-world"
        data-x={viewport.x}
        data-y={viewport.y}
        data-zoom={viewport.zoom}
        style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}
      >
        {nodes.map((node) => (
          <div key={node.id} data-select-id={node.id}>
            <NodeView node={node} />
          </div>
        ))}
      </div>
      <div className="canvas-overlay">
        {nodes.map((node) => {
          const rect = toScreen(nodeRect(node), viewport)
          return (
            <div
              key={node.id}
              className="artboard-label"
              data-select-id={node.id}
              data-selected={node.id === selectedId || undefined}
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
        {selectedRect && (
          <div
            className="selection-outline"
            style={{ left: selectedRect.x, top: selectedRect.y, width: selectedRect.width, height: selectedRect.height }}
          />
        )}
      </div>
    </div>
  )
}
