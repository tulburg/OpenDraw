// Off-screen artboards skip rendering work (S-21 Req 3): their wrappers get `content-visibility:
// hidden`, so style, layout, paint and hit testing leave their layers alone. Code that measures layers
// anywhere on the page runs inside `measuringAll`, which lays every artboard out for that moment.
import type { DesignNode, Viewport } from '../../shared/document'
import { nodeRect, toScreen } from './viewport'

/** Off-screen artboards within this many viewport widths or heights still render, so panning finds them ready. */
const MARGIN = 0.5

/** The artboards far enough outside the canvas to skip. `keep` are never skipped (the selection's artboards). */
export function offscreenArtboards(nodes: DesignNode[], viewport: Viewport, size: { width: number; height: number } | null, keep: Set<string>): Set<string> {
  const skipped = new Set<string>()
  if (!size) return skipped
  const mx = size.width * MARGIN
  const my = size.height * MARGIN
  for (const node of nodes) {
    if (keep.has(node.id)) continue
    const rect = toScreen(nodeRect(node), viewport)
    // A height that is not in px (fit-content) is unknown: only skip by what is known.
    const height = rect.height > 0 ? rect.height : Number.POSITIVE_INFINITY
    const outside = rect.x + rect.width < -mx || rect.x > size.width + mx || rect.y + height < -my || rect.y > size.height + my
    if (outside) skipped.add(node.id)
  }
  return skipped
}

/** Runs `measure` with every artboard laid out, so measurements match a canvas with nothing skipped. */
export function measuringAll<T>(measure: () => T): T {
  const root = document.documentElement
  if (root.hasAttribute('data-measure-all')) return measure()
  root.setAttribute('data-measure-all', '')
  try {
    return measure()
  } finally {
    root.removeAttribute('data-measure-all')
  }
}

const idsByArtboard = new WeakMap<DesignNode, Set<string>>()

/** Every layer ID in an artboard, itself included; kept per artboard, which edits replace when they change it. */
export function idsIn(artboard: DesignNode): Set<string> {
  let ids = idsByArtboard.get(artboard)
  if (!ids) {
    const found = new Set<string>()
    const visit = (node: DesignNode) => {
      found.add(node.id)
      node.children.forEach(visit)
    }
    visit(artboard)
    idsByArtboard.set(artboard, (ids = found))
  }
  return ids
}
