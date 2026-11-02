// Edit commands on the selection (S-6 Req 6): delete, duplicate, copy, paste and select all. Each
// is one transaction, so one undo step.
import type { DesignNode } from '../../shared/document'
import { toJSX } from '../../shared/mcp/jsx'
import type { DocumentStore, Transaction } from '../document/store'
import { cloneWithNewIds, findNode } from '../document/tree'
import { placeArtboard } from '../mcp/placement'

type Measure = (id: string) => { width: number; height: number } | null

export const CLIPBOARD_TYPE = 'application/x-opendraw+json'

function pageNodes(store: DocumentStore): DesignNode[] {
  const { document, pageId } = store.getState()
  return document.pages.find((page) => page.id === pageId)?.nodes ?? []
}

export function deleteSelection(store: DocumentStore) {
  const { selection } = store.getState()
  if (selection.length === 0) return
  store.transact('Delete', (tx) => {
    tx.deleteNodes(selection)
    tx.select([])
  })
}

/** Copies go right after their originals; copied artboards go to an empty spot on the page. */
export function duplicateSelection(store: DocumentStore, measure: Measure) {
  const { selection, pageId } = store.getState()
  if (selection.length === 0) return
  store.transact('Duplicate', (tx) => {
    const copies = selection.map(
      (id) =>
        tx.duplicateNode(id, undefined, (copy) => {
          if (copy.type === 'artboard') placeArtboard(copy, tx.childrenOf(pageId), measure, id)
        }).newId
    )
    tx.select(copies)
  })
}

/** The selected layers as clipboard data: OpenDraw's own format, plus JSX for pasting into code. */
export function copySelection(store: DocumentStore): { json: string; text: string } | null {
  const { selection } = store.getState()
  const nodes = selection.map((id) => findNode(pageNodes(store), id)).filter((n): n is DesignNode => n !== null)
  if (nodes.length === 0) return null
  const text = nodes.map((node) => toJSX(node, { format: 'inline-styles', includeNodeIds: false, includeRootPositioning: false })).join('\n')
  return { json: JSON.stringify({ opendraw: 1, nodes }), text }
}

/**
 * Pastes copied layers with new IDs. Artboards go onto the page in an empty spot. Other layers go
 * into the selected frame or artboard, or right after a selected text, image or SVG layer.
 */
export function paste(store: DocumentStore, json: string, measure: Measure): boolean {
  let nodes: DesignNode[]
  try {
    const data = JSON.parse(json) as { opendraw?: number; nodes?: DesignNode[] }
    if (data.opendraw !== 1 || !Array.isArray(data.nodes)) return false
    nodes = data.nodes
  } catch {
    return false
  }
  const { selection, pageId } = store.getState()
  const target = selection[0] ? findNode(pageNodes(store), selection[0]) : null
  const layers = nodes.filter((n) => n.type !== 'artboard')
  if (layers.length > 0 && !target) return false

  store.transact('Paste', (tx: Transaction) => {
    const pasted: string[] = []
    for (const node of nodes.filter((n) => n.type === 'artboard')) {
      const copy = cloneWithNewIds(node)
      placeArtboard(copy, tx.childrenOf(pageId), measure, node.id)
      tx.insertNodes(pageId, undefined, [copy])
      pasted.push(copy.id)
    }
    if (target && layers.length > 0) {
      const copies = layers.map((node) => cloneWithNewIds(node))
      if (target.type === 'frame' || target.type === 'artboard') tx.insertNodes(target.id, undefined, copies)
      else {
        const { parentId, index } = tx.locate(target.id)
        tx.insertNodes(parentId, index + 1, copies)
      }
      pasted.push(...copies.map((c) => c.id))
    }
    tx.select(pasted)
  })
  return true
}

/** Selects the selection's siblings (all layers in the same parent), or all artboards. */
export function selectAll(store: DocumentStore, parentOf: (id: string) => string | null) {
  const { selection } = store.getState()
  const nodes = pageNodes(store)
  const parentId = selection[0] ? parentOf(selection[0]) : null
  const parent = parentId ? findNode(nodes, parentId) : null
  store.select((parent ? parent.children : nodes).filter((n) => !n.locked).map((n) => n.id))
}
