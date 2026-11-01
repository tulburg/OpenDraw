// Snapping while dragging, resizing and drawing (S-11): edges and centers snap to siblings and the
// parent, with guide lines, and a moved layer snaps to equal spacing between its siblings. All
// geometry is in canvas-relative screen px.
import type { Rect } from './viewport'

/** Snapping reaches this far, in screen px. */
export const SNAP_DISTANCE = 5

export interface Guide {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** A spacing marker: the gap between two layers, drawn as a line across it. */
export type SpacingMarker = Guide

export interface SnapResult {
  dx: number
  dy: number
  guides: Guide[]
  spacing: SpacingMarker[]
}

type Axis = 'x' | 'y'

const start = (r: Rect, axis: Axis) => (axis === 'x' ? r.x : r.y)
const size = (r: Rect, axis: Axis) => (axis === 'x' ? r.width : r.height)
const end = (r: Rect, axis: Axis) => start(r, axis) + size(r, axis)
const lines = (r: Rect, axis: Axis) => [start(r, axis), start(r, axis) + size(r, axis) / 2, end(r, axis)]
const other = (axis: Axis): Axis => (axis === 'x' ? 'y' : 'x')
const overlaps = (a: Rect, b: Rect, axis: Axis) => start(a, axis) < end(b, axis) && start(b, axis) < end(a, axis)

export function unionRect(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null
  const x = Math.min(...rects.map((r) => r.x))
  const y = Math.min(...rects.map((r) => r.y))
  const right = Math.max(...rects.map((r) => r.x + r.width))
  const bottom = Math.max(...rects.map((r) => r.y + r.height))
  return { x, y, width: right - x, height: bottom - y }
}

const moved = (r: Rect, dx: number, dy: number): Rect => ({ ...r, x: r.x + dx, y: r.y + dy })

interface Candidate {
  shift: number
  /** For edge snaps: the line the layer snapped to. */
  line?: number
  /** For spacing snaps: the gaps to mark, given the shifted rectangle. */
  gaps?: (shifted: Rect) => [number, number][]
}

/** The smallest shift along `axis` that puts one of `values` on a target line. */
function edgeCandidates(values: number[], targets: Rect[], axis: Axis): Candidate[] {
  const out: Candidate[] = []
  for (const target of targets) {
    for (const line of lines(target, axis)) {
      for (const value of values) out.push({ shift: line - value, line })
    }
  }
  return out
}

/**
 * Shifts that make the gaps on both sides of `box` equal (between two neighbours), or repeat the gap
 * between two siblings (after or before a pair), among siblings in the same row or column.
 */
function spacingCandidates(box: Rect, siblings: Rect[], axis: Axis): Candidate[] {
  const row = siblings.filter((s) => overlaps(s, box, other(axis))).sort((a, b) => start(a, axis) - start(b, axis))
  const out: Candidate[] = []
  const before = row.filter((s) => end(s, axis) <= start(box, axis) + 1)
  const after = row.filter((s) => start(s, axis) >= end(box, axis) - 1)
  const a = before[before.length - 1]
  const b = after[0]
  if (a && b) {
    const at = (end(a, axis) + start(b, axis) - size(box, axis)) / 2
    out.push({ shift: at - start(box, axis), gaps: (r) => [[end(a, axis), start(r, axis)], [end(r, axis), start(b, axis)]] })
  }
  if (before.length >= 2) {
    const [p, q] = before.slice(-2)
    const gap = start(q, axis) - end(p, axis)
    if (gap > 0) out.push({ shift: end(q, axis) + gap - start(box, axis), gaps: (r) => [[end(p, axis), start(q, axis)], [end(q, axis), start(r, axis)]] })
  }
  if (after.length >= 2) {
    const [p, q] = after.slice(0, 2)
    const gap = start(q, axis) - end(p, axis)
    if (gap > 0) out.push({ shift: start(p, axis) - gap - end(box, axis), gaps: (r) => [[end(r, axis), start(p, axis)], [end(p, axis), start(q, axis)]] })
  }
  return out
}

function best(candidates: Candidate[]): Candidate | null {
  let found: Candidate | null = null
  for (const c of candidates) {
    if (Math.abs(c.shift) <= SNAP_DISTANCE && (!found || Math.abs(c.shift) < Math.abs(found.shift))) found = c
  }
  return found
}

/** Guide lines for every target line that the box now sits on along `axis`. */
function guidesFor(box: Rect, targets: Rect[], axis: Axis): Guide[] {
  const guides: Guide[] = []
  for (const value of lines(box, axis)) {
    const hits = targets.filter((t) => lines(t, axis).some((line) => Math.abs(line - value) < 0.5))
    if (hits.length === 0) continue
    const cross = other(axis)
    const from = Math.min(start(box, cross), ...hits.map((h) => start(h, cross)))
    const to = Math.max(end(box, cross), ...hits.map((h) => end(h, cross)))
    guides.push(axis === 'x' ? { x1: value, y1: from, x2: value, y2: to } : { x1: from, y1: value, x2: to, y2: value })
  }
  return guides
}

/**
 * Snaps a box being moved by (dx, dy). `siblings` are the layers beside it; `parent` is its
 * container (null for artboards). `lock` keeps one axis still.
 */
export function snapMove(box: Rect, dx: number, dy: number, siblings: Rect[], parent: Rect | null, lock: Axis | null = null): SnapResult {
  const targets = parent ? [...siblings, parent] : siblings
  const shifted = moved(box, dx, dy)
  const result: SnapResult = { dx, dy, guides: [], spacing: [] }
  const spacingByAxis: Partial<Record<Axis, Candidate>> = {}
  for (const axis of ['x', 'y'] as Axis[]) {
    if (lock === axis) continue
    // Equal spacing wins ties, since an edge often lines up at the same spot.
    const choice = best([...spacingCandidates(shifted, siblings, axis), ...edgeCandidates(lines(shifted, axis), targets, axis)])
    if (!choice) continue
    if (axis === 'x') result.dx += choice.shift
    else result.dy += choice.shift
    if (choice.gaps) spacingByAxis[axis] = choice
  }
  const final = moved(box, result.dx, result.dy)
  for (const axis of ['x', 'y'] as Axis[]) {
    if (lock === axis) continue
    result.guides.push(...guidesFor(final, targets, axis))
    const spacing = spacingByAxis[axis]
    if (spacing?.gaps) {
      const middle = start(final, other(axis)) + size(final, other(axis)) / 2
      for (const [from, to] of spacing.gaps(final)) {
        result.spacing.push(axis === 'x' ? { x1: from, y1: middle, x2: to, y2: middle } : { x1: middle, y1: from, x2: middle, y2: to })
      }
    }
  }
  return result
}

/** Snaps single moving values (a resized edge, a drawing corner) along one axis. */
export function snapValue(value: number, targets: Rect[], axis: Axis): number {
  const choice = best(edgeCandidates([value], targets, axis))
  return choice ? value + choice.shift : value
}

/** Guides for a box whose edges were snapped by resizing or drawing. */
export function guidesForBox(box: Rect, targets: Rect[]): Guide[] {
  return [...guidesFor(box, targets, 'x'), ...guidesFor(box, targets, 'y')]
}
