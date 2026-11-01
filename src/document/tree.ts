// Immutable edits on a page's node tree. Every function returns a new page and copies only the
// nodes on the path to what changed, so undo snapshots share everything else.
import type { DesignNode, Page, TextSpan } from '../../shared/document'
import { newId } from '../../shared/document'
import { normalizeSpans, plainText } from './richtext'

export class EditError extends Error {}

/** The page itself is the parent of its artboards, so a parent ID is a node ID or the page ID. */
export interface Location {
  parentId: string
  index: number
}

export function findNode(nodes: DesignNode[], id: string): DesignNode | null {
  for (const node of nodes) {
    if (node.id === id) return node
    const found = findNode(node.children, id)
    if (found) return found
  }
  return null
}

export function locate(page: Page, id: string): Location | null {
  const search = (parentId: string, nodes: DesignNode[]): Location | null => {
    for (let index = 0; index < nodes.length; index++) {
      if (nodes[index].id === id) return { parentId, index }
      const found = search(nodes[index].id, nodes[index].children)
      if (found) return found
    }
    return null
  }
  return search(page.id, page.nodes)
}

function requireNode(page: Page, id: string): DesignNode {
  const node = findNode(page.nodes, id)
  if (!node) throw new EditError(`No node ${id}`)
  return node
}

/** Replaces the children of `parentId` (a node or the page) with `change(children)`. */
function withChildren(page: Page, parentId: string, change: (children: DesignNode[]) => DesignNode[]): Page {
  if (parentId === page.id) return { ...page, nodes: change(page.nodes) }
  let found = false
  const walk = (nodes: DesignNode[]): DesignNode[] =>
    nodes.map((node) => {
      if (found) return node
      if (node.id === parentId) {
        found = true
        return { ...node, children: change(node.children) }
      }
      const children = walk(node.children)
      return children === node.children || !found ? node : { ...node, children }
    })
  const nodes = walk(page.nodes)
  if (!found) throw new EditError(`No parent ${parentId}`)
  return { ...page, nodes }
}

function withNode(page: Page, id: string, change: (node: DesignNode) => DesignNode): Page {
  const location = locate(page, id)
  if (!location) throw new EditError(`No node ${id}`)
  return withChildren(page, location.parentId, (children) =>
    children.map((child, i) => (i === location.index ? change(child) : child))
  )
}

function clampIndex(index: number | undefined, length: number): number {
  return index === undefined || index < 0 || index > length ? length : index
}

function allIds(nodes: DesignNode[], into = new Set<string>()): Set<string> {
  for (const node of nodes) {
    into.add(node.id)
    allIds(node.children, into)
  }
  return into
}

export function insertNodes(page: Page, parentId: string, index: number | undefined, nodes: DesignNode[]): Page {
  const existing = allIds(page.nodes)
  for (const id of allIds(nodes)) if (existing.has(id)) throw new EditError(`Node ${id} already exists`)
  if (parentId === page.id && nodes.some((node) => node.type !== 'artboard')) {
    throw new EditError('Only artboards can sit directly on a page')
  }
  if (parentId !== page.id) {
    if (nodes.some((node) => node.type === 'artboard')) throw new EditError('Artboards can only sit on a page')
    const parent = requireNode(page, parentId)
    if (parent.type === 'text') throw new EditError('Text nodes cannot have children')
  }
  return withChildren(page, parentId, (children) => {
    const at = clampIndex(index, children.length)
    return [...children.slice(0, at), ...nodes, ...children.slice(at)]
  })
}

export function setStyles(page: Page, id: string, style: DesignNode['style']): Page {
  return withNode(page, id, (node) => ({ ...node, style }))
}

export function setText(page: Page, id: string, text: string): Page {
  if (requireNode(page, id).type !== 'text') throw new EditError(`Node ${id} is not a text node`)
  return withNode(page, id, (node) => {
    const { spans: _spans, ...plain } = node
    return { ...plain, text }
  })
}

/** Sets a text node's runs; `text` becomes their plain join. Unformatted runs leave a plain node. */
export function setRichText(page: Page, id: string, spans: TextSpan[]): Page {
  if (requireNode(page, id).type !== 'text') throw new EditError(`Node ${id} is not a text node`)
  const normalized = normalizeSpans(spans)
  return withNode(page, id, (node) => {
    const { spans: _spans, ...plain } = node
    const text = plainText(spans)
    return normalized ? { ...plain, text, spans: normalized } : { ...plain, text }
  })
}

export function rename(page: Page, id: string, name: string): Page {
  return withNode(page, id, (node) => ({ ...node, name }))
}

export function deleteNodes(page: Page, ids: string[]): Page {
  for (const id of ids) requireNode(page, id)
  const remove = new Set(ids)
  const walk = (nodes: DesignNode[]): DesignNode[] => {
    let changed = false
    const kept: DesignNode[] = []
    for (const node of nodes) {
      if (remove.has(node.id)) {
        changed = true
        continue
      }
      const children = walk(node.children)
      if (children !== node.children) changed = true
      kept.push(children === node.children ? node : { ...node, children })
    }
    return changed ? kept : nodes
  }
  return { ...page, nodes: walk(page.nodes) }
}

/** Moves nodes, in the given order, to `parentId` at `index`. */
export function moveNodes(page: Page, ids: string[], parentId: string, index: number | undefined): Page {
  const moving = ids.map((id) => requireNode(page, id))
  for (const node of moving) {
    if (node.id === parentId || findNode(node.children, parentId)) {
      throw new EditError(`Cannot move ${node.id} into itself`)
    }
  }
  // Index is counted among the target's children before the move; adjust for nodes leaving that list.
  let at = index
  if (at !== undefined) {
    const before = parentId === page.id ? page.nodes : requireNode(page, parentId).children
    at -= before.slice(0, at).filter((child) => ids.includes(child.id)).length
  }
  return insertNodes(deleteNodes(page, ids), parentId, at, moving)
}

/** A deep copy with new IDs. `idMap` collects old ID to new ID for every node copied. */
export function cloneWithNewIds(node: DesignNode, idMap: Record<string, string> = {}): DesignNode {
  const id = newId()
  idMap[node.id] = id
  return { ...node, id, children: node.children.map((child) => cloneWithNewIds(child, idMap)) }
}

/** Duplicates each node right after itself. Returns the page and the new top-level IDs, in order. */
export function duplicateNodes(page: Page, ids: string[]): { page: Page; newIds: string[] } {
  let next = page
  const newIds: string[] = []
  for (const id of ids) {
    const location = locate(next, id)
    if (!location) throw new EditError(`No node ${id}`)
    const copy = cloneWithNewIds(requireNode(next, id))
    if (copy.type === 'artboard') {
      // Place the copy to the right of the original so it does not cover it.
      const left = Number.parseFloat(String(copy.style.left ?? 0)) || 0
      const width = Number.parseFloat(String(copy.style.width ?? 0)) || 0
      copy.style = { ...copy.style, left: `${left + width + 80}px` }
    }
    next = insertNodes(next, location.parentId, location.index + 1, [copy])
    newIds.push(copy.id)
  }
  return { page: next, newIds }
}
