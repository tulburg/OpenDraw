import type { DesignNode, Viewport } from '../../shared/document'

export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 64
const ZOOM_STEPS = [0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64]
const FIT_PADDING = 64

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

/** Zooms to `zoom`, keeping the canvas point under `anchor` (screen coordinates) in place. */
export function zoomAt(viewport: Viewport, zoom: number, anchor: { x: number; y: number }): Viewport {
  const next = clampZoom(zoom)
  const worldX = (anchor.x - viewport.x) / viewport.zoom
  const worldY = (anchor.y - viewport.y) / viewport.zoom
  return { zoom: next, x: anchor.x - worldX * next, y: anchor.y - worldY * next }
}

export function nextZoomStep(zoom: number, direction: 1 | -1): number {
  const steps = direction === 1 ? ZOOM_STEPS : [...ZOOM_STEPS].reverse()
  return steps.find((step) => (direction === 1 ? step > zoom + 1e-6 : step < zoom - 1e-6)) ?? clampZoom(zoom)
}

function px(value: string | number | undefined): number {
  return typeof value === 'number' ? value : Number.parseFloat(value ?? '0') || 0
}

/** An artboard's rectangle in canvas coordinates, from its CSS. */
export function nodeRect(node: DesignNode): Rect {
  return { x: px(node.style.left), y: px(node.style.top), width: px(node.style.width), height: px(node.style.height) }
}

export function toScreen(rect: Rect, viewport: Viewport): Rect {
  return {
    x: rect.x * viewport.zoom + viewport.x,
    y: rect.y * viewport.zoom + viewport.y,
    width: rect.width * viewport.zoom,
    height: rect.height * viewport.zoom
  }
}

/** Centers the nodes in a canvas of the given size, zoomed to fit with padding. */
export function fitViewport(nodes: DesignNode[], size: { width: number; height: number }): Viewport {
  if (nodes.length === 0) return { x: size.width / 2, y: size.height / 2, zoom: 1 }
  return fitRects(nodes.map(nodeRect), size)
}

/** Centers the rectangles (world units) in a canvas of the given size, zoomed to fit with padding. */
export function fitRects(rects: Rect[], size: { width: number; height: number }): Viewport {
  const left = Math.min(...rects.map((r) => r.x))
  const top = Math.min(...rects.map((r) => r.y))
  const right = Math.max(...rects.map((r) => r.x + r.width))
  const bottom = Math.max(...rects.map((r) => r.y + r.height))
  const zoom = clampZoom(
    Math.min((size.width - FIT_PADDING * 2) / (right - left), (size.height - FIT_PADDING * 2) / (bottom - top))
  )
  return {
    zoom,
    x: size.width / 2 - ((left + right) / 2) * zoom,
    y: size.height / 2 - ((top + bottom) / 2) * zoom
  }
}
