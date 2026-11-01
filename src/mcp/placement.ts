// Where new artboards go (S-5 Req 3): the first empty spot, reading the page in rows from the top
// left, that keeps 80 px from every other artboard.
import type { DesignNode } from '../../shared/document'

export const ARTBOARD_GAP = 80

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

function clear(spot: Box, others: Box[]): boolean {
  return others.every(
    (b) =>
      spot.x >= b.x + b.width + ARTBOARD_GAP ||
      spot.x + spot.width + ARTBOARD_GAP <= b.x ||
      spot.y >= b.y + b.height + ARTBOARD_GAP ||
      spot.y + spot.height + ARTBOARD_GAP <= b.y
  )
}

export function findArtboardSpot(others: Box[], width: number, height: number): { x: number; y: number } {
  if (others.length === 0) return { x: 0, y: 0 }
  const top = Math.min(...others.map((b) => b.y))
  const left = Math.min(...others.map((b) => b.x))
  const right = Math.max(...others.map((b) => b.x + b.width))
  // Right of or below each artboard, plus the end of the top row, which is always free.
  const candidates = [
    { x: left, y: top },
    ...others.flatMap((b) => [
      { x: b.x + b.width + ARTBOARD_GAP, y: b.y },
      { x: b.x, y: b.y + b.height + ARTBOARD_GAP }
    ]),
    { x: right + ARTBOARD_GAP, y: top }
  ].sort((a, b) => a.y - b.y || a.x - b.x)
  return candidates.find((c) => clear({ ...c, width, height }, others))!
}

function px(value: string | number | undefined): number | null {
  if (typeof value === 'number') return value
  const match = value?.trim().match(/^(-?\d+(\.\d+)?)(px)?$/)
  return match ? Number(match[1]) : null
}

/**
 * Canvas boxes for artboards, from their CSS. A size that is not in px (such as `fit-content`) comes
 * from `measure`, the rendered size, when the artboard is on screen.
 */
export function artboardBoxes(
  artboards: DesignNode[],
  measure: (id: string) => { width: number; height: number } | null
): Box[] {
  return artboards.map((artboard) => ({
    x: px(artboard.style.left) ?? 0,
    y: px(artboard.style.top) ?? 0,
    width: px(artboard.style.width) ?? measure(artboard.id)?.width ?? 0,
    height: px(artboard.style.height) ?? measure(artboard.id)?.height ?? 0
  }))
}

/** Moves `artboard` (by setting `left` and `top`) to the first empty spot among `others`. */
export function placeArtboard(
  artboard: DesignNode,
  others: DesignNode[],
  measure: (id: string) => { width: number; height: number } | null,
  sizeFrom = artboard.id
) {
  const [own] = artboardBoxes([{ ...artboard, id: sizeFrom }], measure)
  const spot = findArtboardSpot(artboardBoxes(others, measure), own.width, own.height)
  artboard.style = { ...artboard.style, left: `${spot.x}px`, top: `${spot.y}px` }
}
