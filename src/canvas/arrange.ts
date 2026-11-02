// Arrange commands on layers (S-18 Req 7, S-19). Positions come from the canvas DOM, in layout units.
import { type CSSStyle, type DesignNode, newId } from '../../shared/document'
import { type DocumentStore, EditError, Transaction } from '../document/store'

const px = (v: number) => `${Math.round(v)}px`

/** The canvas's world element: layers are measured inside it, and it carries the zoom. */
const canvasWorld = (): ParentNode => document.querySelector('.canvas-world') ?? document

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
export function wrapInFrame(store: DocumentStore, ids: string[], canvas: ParentNode = canvasWorld()): string {
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

export type ArrangeCommand =
  | 'wrap'
  | 'unwrap'
  | 'align-left'
  | 'align-center'
  | 'align-right'
  | 'align-top'
  | 'align-middle'
  | 'align-bottom'
  | 'distribute-horizontal'
  | 'distribute-vertical'
  | 'bring-forward'
  | 'send-backward'
  | 'bring-to-front'
  | 'send-to-back'

export const ALIGN_COMMANDS = ['align-left', 'align-center', 'align-right', 'align-top', 'align-middle', 'align-bottom'] as const
type Align = (typeof ALIGN_COMMANDS)[number]

const num = (v: unknown) => Number.parseFloat(String(v ?? 0)) || 0
const placed = (n: DesignNode) => n.type === 'artboard' || n.style.position === 'absolute'

interface Box {
  id: string
  x: number
  y: number
  w: number
  h: number
}

/** A placed layer's box in its parent's coordinates (an artboard's on the canvas). */
function boxOf(node: DesignNode, canvas: ParentNode): Box {
  const el = canvas.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(node.id)}"]`)
  if (node.type === 'artboard') return { id: node.id, x: num(node.style.left), y: num(node.style.top), w: el?.offsetWidth ?? num(node.style.width), h: el?.offsetHeight ?? num(node.style.height) }
  return { id: node.id, x: el?.offsetLeft ?? num(node.style.left), y: el?.offsetTop ?? num(node.style.top), w: el?.offsetWidth ?? 0, h: el?.offsetHeight ?? 0 }
}

function selectionInfo(store: DocumentStore, ids: string[]) {
  try {
    return ids.length > 0 ? siblings(store, ids) : null
  } catch {
    return null
  }
}

/** Which commands apply to the selection; the menus disable the rest. */
export function arrangeState(store: DocumentStore, ids: string[]): Record<ArrangeCommand, boolean> {
  const info = selectionInfo(store, ids)
  const all = info?.nodes ?? []
  const allPlaced = all.length > 0 && all.every(placed)
  const single = all.length === 1 ? all[0] : null
  const align = (allPlaced && (all.length >= 2 || (single?.type !== 'artboard' && !!info?.parent))) || (!!single && !placed(single) && !!info?.parent)
  const order = !!info && new Transaction(store.getState().document).childrenOf(info.parentId).length > ids.length
  return {
    wrap: canWrap(store, ids),
    unwrap: !!single && single.type === 'frame' && !!info?.parent,
    ...(Object.fromEntries(ALIGN_COMMANDS.map((c) => [c, align])) as Record<Align, boolean>),
    'distribute-horizontal': allPlaced && all.length >= 3,
    'distribute-vertical': allPlaced && all.length >= 3,
    'bring-forward': order,
    'send-backward': order,
    'bring-to-front': order,
    'send-to-back': order
  }
}

/** Runs an arrange command on the selection. Returns a message when it could not apply. */
export function runArrange(store: DocumentStore, command: ArrangeCommand, canvas: ParentNode = canvasWorld()): string | null {
  const ids = store.getState().selection
  const info = selectionInfo(store, ids)
  if (!info) return ids.length === 0 ? 'Select layers first' : 'Arrange works on layers that share a parent'
  try {
    switch (command) {
      case 'wrap':
        wrapInFrame(store, ids, canvas)
        return null
      case 'unwrap':
        return unwrap(store, info.nodes[0], info.parentId, canvas)
      case 'distribute-horizontal':
      case 'distribute-vertical':
        return distribute(store, info.nodes, command === 'distribute-horizontal' ? 'x' : 'y', canvas)
      case 'bring-forward':
      case 'send-backward':
      case 'bring-to-front':
      case 'send-to-back':
        return reorder(store, ids, info.parentId, command)
      default:
        return align(store, info.nodes, info.parent, command, canvas)
    }
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

const LABELS: Record<ArrangeCommand, string> = {
  wrap: 'Wrap in frame',
  unwrap: 'Unwrap',
  'align-left': 'Align left',
  'align-center': 'Align center',
  'align-right': 'Align right',
  'align-top': 'Align top',
  'align-middle': 'Align middle',
  'align-bottom': 'Align bottom',
  'distribute-horizontal': 'Distribute horizontally',
  'distribute-vertical': 'Distribute vertically',
  'bring-forward': 'Bring forward',
  'send-backward': 'Send backward',
  'bring-to-front': 'Bring to front',
  'send-to-back': 'Send to back'
}
export const arrangeLabel = (command: ArrangeCommand) => LABELS[command]

/** The command a key press asks for: Cmd+Opt+G wraps, Cmd+Shift+G unwraps, Cmd+] and Cmd+[ reorder. */
export function arrangeShortcut(event: KeyboardEvent): ArrangeCommand | null {
  if (!(event.metaKey || event.ctrlKey)) return null
  if (event.code === 'KeyG' && event.altKey && !event.shiftKey) return 'wrap'
  if (event.code === 'KeyG' && event.shiftKey && !event.altKey) return 'unwrap'
  if (event.code === 'BracketRight') return event.shiftKey ? 'bring-to-front' : 'bring-forward'
  if (event.code === 'BracketLeft') return event.shiftKey ? 'send-to-back' : 'send-backward'
  return null
}

/** Moves a frame's children into its parent at its place and removes it; positioned children keep their canvas place. */
function unwrap(store: DocumentStore, frame: DesignNode, parentId: string, canvas: ParentNode): string | null {
  if (frame.type !== 'frame') return 'Only frames can be unwrapped'
  const el = (id: string) => canvas.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`)
  const parentEl = el(parentId)
  const zoom = Number((canvas as Element).closest?.('.canvas-world')?.getAttribute('data-zoom') ?? (canvas as HTMLElement).dataset?.zoom) || 1
  const moves: Record<string, CSSStyle> = {}
  if (parentEl) {
    const origin = parentEl.getBoundingClientRect()
    for (const child of frame.children) {
      const childEl = el(child.id)
      if (child.style.position !== 'absolute' || !childEl) continue
      const r = childEl.getBoundingClientRect()
      moves[child.id] = { left: px((r.left - origin.left) / zoom - parentEl.clientLeft), top: px((r.top - origin.top) / zoom - parentEl.clientTop) }
    }
  }
  const index = new Transaction(store.getState().document).childrenOf(parentId).findIndex((c) => c.id === frame.id)
  const kids = frame.children.map((c) => c.id)
  store.transact('Unwrap', (tx) => {
    if (kids.length > 0) tx.moveNodes(kids, parentId, index)
    for (const [id, style] of Object.entries(moves)) tx.updateStyles([id], style)
    tx.deleteNodes([frame.id])
    if (Object.keys(moves).length > 0) {
      const parent = tx.node(parentId)
      if (parent.type === 'frame' && !parent.style.position) tx.updateStyles([parentId], { position: 'relative' })
    }
    tx.select(kids)
  })
  return null
}

function align(store: DocumentStore, nodes: DesignNode[], parent: DesignNode | null, command: Align, canvas: ParentNode): string | null {
  const horizontal = command === 'align-left' || command === 'align-center' || command === 'align-right'
  // One child of a flex container aligns on the cross axis with align-self.
  if (nodes.length === 1 && !placed(nodes[0])) {
    const parentEl = parent && canvas.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(parent.id)}"]`)
    const direction = parentEl ? getComputedStyle(parentEl).flexDirection : String(parent?.style.flexDirection ?? 'row')
    const crossIsHorizontal = direction.startsWith('column')
    if (horizontal !== crossIsHorizontal) {
      return `In a flex ${crossIsHorizontal ? 'column' : 'row'}, ${horizontal ? 'horizontal' : 'vertical'} alignment comes from the parent's justify-content`
    }
    const value = command === 'align-left' || command === 'align-top' ? 'flex-start' : command === 'align-right' || command === 'align-bottom' ? 'flex-end' : 'center'
    store.transact('Align', (tx) => tx.updateStyles([nodes[0].id], { alignSelf: value }))
    return null
  }
  if (!nodes.every(placed)) return 'Align works on absolutely positioned layers, artboards, or one child of a flex container'
  const boxes = nodes.map((n) => boxOf(n, canvas))
  let bounds: { x: number; y: number; w: number; h: number }
  if (boxes.length === 1) {
    const parentEl = parent && canvas.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(parent.id)}"]`)
    if (!parentEl) return 'Nothing to align to'
    bounds = { x: 0, y: 0, w: parentEl.clientWidth, h: parentEl.clientHeight }
  } else {
    const x = Math.min(...boxes.map((b) => b.x))
    const y = Math.min(...boxes.map((b) => b.y))
    bounds = { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y }
  }
  store.transact('Align', (tx) => {
    for (const b of boxes) {
      const style: CSSStyle = {}
      if (command === 'align-left') style.left = px(bounds.x)
      if (command === 'align-center') style.left = px(bounds.x + (bounds.w - b.w) / 2)
      if (command === 'align-right') style.left = px(bounds.x + bounds.w - b.w)
      if (command === 'align-top') style.top = px(bounds.y)
      if (command === 'align-middle') style.top = px(bounds.y + (bounds.h - b.h) / 2)
      if (command === 'align-bottom') style.top = px(bounds.y + bounds.h - b.h)
      tx.updateStyles([b.id], style)
    }
  })
  return null
}

function distribute(store: DocumentStore, nodes: DesignNode[], axis: 'x' | 'y', canvas: ParentNode): string | null {
  if (nodes.length < 3 || !nodes.every(placed)) return 'Distribute needs three or more absolutely positioned layers or artboards'
  const size = axis === 'x' ? 'w' : 'h'
  const boxes = nodes.map((n) => boxOf(n, canvas)).sort((a, b) => a[axis] - b[axis])
  const start = boxes[0][axis]
  const end = Math.max(...boxes.map((b) => b[axis] + b[size]))
  const gap = (end - start - boxes.reduce((sum, b) => sum + b[size], 0)) / (boxes.length - 1)
  store.transact('Distribute', (tx) => {
    let at = start
    for (const b of boxes) {
      tx.updateStyles([b.id], axis === 'x' ? { left: px(at) } : { top: px(at) })
      at += b[size] + gap
    }
  })
  return null
}

/** Stacking order is sibling order: later siblings draw on top. */
function reorder(store: DocumentStore, ids: string[], parentId: string, command: ArrangeCommand): string | null {
  const order = new Transaction(store.getState().document).childrenOf(parentId).map((c) => c.id)
  const chosen = new Set(ids)
  let next = [...order]
  if (command === 'bring-to-front') next = [...order.filter((id) => !chosen.has(id)), ...order.filter((id) => chosen.has(id))]
  else if (command === 'send-to-back') next = [...order.filter((id) => chosen.has(id)), ...order.filter((id) => !chosen.has(id))]
  else if (command === 'bring-forward') {
    for (let i = next.length - 2; i >= 0; i--) if (chosen.has(next[i]) && !chosen.has(next[i + 1])) [next[i], next[i + 1]] = [next[i + 1], next[i]]
  } else {
    for (let i = 1; i < next.length; i++) if (chosen.has(next[i]) && !chosen.has(next[i - 1])) [next[i], next[i - 1]] = [next[i - 1], next[i]]
  }
  if (next.join() === order.join()) return null
  store.transact(LABELS[command], (tx) => {
    tx.moveNodes(next, parentId, 0)
    tx.select(ids)
  })
  return null
}
