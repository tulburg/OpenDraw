// Arrange commands on layers (S-18 Req 7, S-19). Positions come from the canvas DOM, in layout units.
import { type CSSStyle, type DesignNode, newId } from '../../shared/document'
import { type DocumentStore, EditError, Transaction } from '../document/store'

const px = (v: number) => `${Math.round(v)}px`

function siblings(store: DocumentStore, ids: string[]): { parentId: string; parent: DesignNode | null; nodes: DesignNode[] } {
  // A read-only transaction: it only looks nodes up.
  const tx = new Transaction(store.getState().document)
  let parentId: string | null = null
  const nodes: DesignNode[] = []
  for (const id of ids) {
    const where = tx.locate(id)
    if (parentId !== null && where.parentId !== parentId) throw new EditError('Wrap works on layers that share a parent')
    parentId = where.parentId
    nodes.push(tx.node(id))
  }
  const parent = tx.document.pages.some((p) => p.id === parentId) ? null : tx.node(parentId!)
  return { parentId: parentId!, parent, nodes }
}

/** Whether the selection can be wrapped: sibling layers that are not artboards. */
export function canWrap(store: DocumentStore, ids: string[]): boolean {
  if (ids.length === 0) return false
  try {
    const { parent, nodes } = siblings(store, ids)
    return parent !== null && nodes.every((n) => n.type !== 'artboard')
  } catch {
    return false
  }
}

/**
 * Puts sibling layers in a new frame at their place. In-flow layers get a flex frame that takes their
 * place in the flow, with the parent's direction and gap; absolutely positioned layers get a positioned
 * frame at their combined bounds and keep their canvas positions.
 */
export function wrapInFrame(store: DocumentStore, ids: string[], canvas: ParentNode = document): string {
  const { parentId, parent, nodes } = siblings(store, ids)
  if (!parent) throw new EditError('Artboards cannot be wrapped in a frame')
  const element = (id: string) => canvas.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`)
  const positioned = nodes.every((n) => n.style.position === 'absolute')
  const frame: DesignNode = { id: newId(), type: 'frame', name: 'Frame', style: {}, children: [] }
  const moves: Record<string, CSSStyle> = {}
  if (positioned) {
    const boxes = nodes.map((n) => {
      const el = element(n.id)
      return el ? { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight } : { x: Number.parseFloat(String(n.style.left)) || 0, y: Number.parseFloat(String(n.style.top)) || 0, w: 0, h: 0 }
    })
    const x = Math.min(...boxes.map((b) => b.x))
    const y = Math.min(...boxes.map((b) => b.y))
    const right = Math.max(...boxes.map((b) => b.x + b.w))
    const bottom = Math.max(...boxes.map((b) => b.y + b.h))
    frame.style = { position: 'absolute', left: px(x), top: px(y), width: px(right - x), height: px(bottom - y) }
    nodes.forEach((n, i) => (moves[n.id] = { left: px(boxes[i].x - x), top: px(boxes[i].y - y) }))
  } else {
    const parentEl = element(parent.id)
    const parentStyle = parentEl ? getComputedStyle(parentEl) : null
    const flex = parentStyle?.display === 'flex' || parent.style.display === 'flex'
    const direction = String(parent.style.flexDirection ?? (flex ? 'row' : 'column'))
    frame.style = { display: 'flex', flexDirection: direction, ...(flex && parent.style.gap ? { gap: parent.style.gap } : {}) }
  }
  const order = new Transaction(store.getState().document).childrenOf(parentId).map((c) => c.id)
  const sorted = [...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b))
  const index = order.indexOf(sorted[0])
  store.transact('Wrap in frame', (tx) => {
    tx.insertNodes(parentId, index, [frame])
    tx.moveNodes(sorted, frame.id)
    for (const [id, style] of Object.entries(moves)) tx.updateStyles([id], style)
    if (positioned && !parent.style.position && parent.type === 'frame') tx.updateStyles([parent.id], { position: 'relative' })
    tx.select([frame.id])
  })
  return frame.id
}
