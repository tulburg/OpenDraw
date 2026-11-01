// The one path for changing a document (S-3): edits run inside transactions, each transaction is one
// undo step, and listeners re-render and autosave from the committed state.
import { useSyncExternalStore } from 'react'

import type { DesignDocument, DesignNode, Page } from '../../shared/document'
import { applyStyleUpdate, type StyleUpdate } from './styles'
import * as tree from './tree'
import { EditError } from './tree'

export { EditError }

const MAX_UNDO = 200

export interface StoreState {
  document: DesignDocument
  /** The page the user is viewing. */
  pageId: string
  selection: string[]
  canUndo: boolean
  canRedo: boolean
}

interface Snapshot {
  document: DesignDocument
  selection: string[]
}

interface HistoryEntry {
  label: string
  before: Snapshot
  after: Snapshot
}

export type ChangeKind = 'document' | 'selection' | 'page'

/** Edits made inside one transaction. Nodes are found on whichever page holds them. */
export class Transaction {
  private selection: string[] | null = null

  constructor(public document: DesignDocument) {}

  private pageIndexOf(id: string): number {
    const index = this.document.pages.findIndex((page) => page.id === id || tree.findNode(page.nodes, id))
    if (index === -1) throw new EditError(`No node or page ${id}`)
    return index
  }

  private update(id: string, change: (page: Page) => Page) {
    const index = this.pageIndexOf(id)
    const pages = [...this.document.pages]
    pages[index] = change(pages[index])
    this.document = { ...this.document, pages }
  }

  node(id: string): DesignNode {
    const page = this.document.pages[this.pageIndexOf(id)]
    const node = tree.findNode(page.nodes, id)
    if (!node) throw new EditError(`No node ${id}`)
    return node
  }

  /** `parentId` is a node ID, or a page ID to place artboards on that page. */
  insertNodes(parentId: string, index: number | undefined, nodes: DesignNode[]) {
    this.update(parentId, (page) => tree.insertNodes(page, parentId, index, nodes))
  }

  /** Returns, per node, the properties that were left out and why (Paper's `ignoredStyles`). */
  updateStyles(ids: string[], update: StyleUpdate): Record<string, Record<string, string>> {
    const ignoredByNode: Record<string, Record<string, string>> = {}
    for (const id of ids) {
      const { style, ignored } = applyStyleUpdate(this.node(id), update)
      this.update(id, (page) => tree.setStyles(page, id, style))
      if (Object.keys(ignored).length > 0) ignoredByNode[id] = ignored
    }
    return ignoredByNode
  }

  setText(id: string, text: string) {
    this.update(id, (page) => tree.setText(page, id, text))
  }

  rename(id: string, name: string) {
    this.update(id, (page) => tree.rename(page, id, name))
  }

  moveNodes(ids: string[], parentId: string, index?: number) {
    const target = this.pageIndexOf(parentId)
    if (ids.some((id) => this.pageIndexOf(id) !== target)) throw new EditError('Nodes can only move within a page')
    this.update(parentId, (page) => tree.moveNodes(page, ids, parentId, index))
  }

  duplicateNodes(ids: string[]): string[] {
    const newIds: string[] = []
    for (const id of ids) {
      this.update(id, (page) => {
        const result = tree.duplicateNodes(page, [id])
        newIds.push(...result.newIds)
        return result.page
      })
    }
    return newIds
  }

  deleteNodes(ids: string[]) {
    for (const id of ids) this.update(id, (page) => tree.deleteNodes(page, [id]))
  }

  /** Where a node sits: its page, its parent (a node ID, or the page ID for artboards) and its index. */
  locate(id: string): { pageId: string; parentId: string; index: number } {
    const page = this.document.pages[this.pageIndexOf(id)]
    const location = tree.locate(page, id)
    if (!location) throw new EditError(`No node ${id}`)
    return { pageId: page.id, ...location }
  }

  /** The children of a node, or the artboards of a page. */
  childrenOf(parentId: string): DesignNode[] {
    const page = this.document.pages.find((p) => p.id === parentId)
    return page ? page.nodes : this.node(parentId).children
  }

  /**
   * Moves one node to `parentId` (a node or a page, on any page) at `index` among the parent's
   * children after the move, or to the end. Keeps the node's ID.
   */
  moveNode(id: string, parentId: string, index?: number) {
    const node = this.node(id)
    if (node.id === parentId || tree.findNode(node.children, parentId)) {
      throw new EditError(`Cannot move ${id} into itself`)
    }
    this.pageIndexOf(parentId)
    this.update(id, (page) => tree.deleteNodes(page, [id]))
    this.insertNodes(parentId, index, [node])
  }

  /** Removes a node and puts `nodes` where it was. */
  replaceNode(id: string, nodes: DesignNode[]) {
    const { parentId, index } = this.locate(id)
    this.update(id, (page) => tree.deleteNodes(page, [id]))
    this.insertNodes(parentId, index, nodes)
  }

  /**
   * Copies a node with new IDs, after the original or at the end of `parentId`. Returns the copy's ID
   * and the map from every original ID to its copy. `adjust` can change the copy before it is placed.
   */
  duplicateNode(id: string, parentId?: string, adjust?: (copy: DesignNode) => void) {
    const idMap: Record<string, string> = {}
    const copy = tree.cloneWithNewIds(this.node(id), idMap)
    adjust?.(copy)
    if (parentId) this.insertNodes(parentId, undefined, [copy])
    else {
      const location = this.locate(id)
      this.insertNodes(location.parentId, location.index + 1, [copy])
    }
    return { newId: copy.id, idMap }
  }

  /** Sets the selection that this step leaves behind (and that redo restores). */
  select(ids: string[]) {
    this.selection = ids
  }

  selectionAfter(previous: string[]): string[] {
    const exists = (id: string) => this.document.pages.some((page) => tree.findNode(page.nodes, id))
    return (this.selection ?? previous).filter(exists)
  }
}

export class DocumentStore {
  private state: StoreState
  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []
  private listeners = new Set<(kind: ChangeKind) => void>()

  constructor(document: DesignDocument, pageId: string) {
    this.state = { document, pageId, selection: [], canUndo: false, canRedo: false }
  }

  getState = (): StoreState => this.state

  subscribe = (listener: (kind: ChangeKind) => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(change: Partial<StoreState>, kind: ChangeKind) {
    this.state = {
      ...this.state,
      ...change,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0
    }
    for (const listener of this.listeners) listener(kind)
  }

  /**
   * Runs `edit` as one undo step. If it throws, nothing changes and the error is rethrown.
   * Edits that leave the document unchanged add no undo step.
   */
  transact<T>(label: string, edit: (tx: Transaction) => T): T {
    const tx = new Transaction(this.state.document)
    const result = edit(tx)
    const selection = tx.selectionAfter(this.state.selection)
    if (tx.document === this.state.document) {
      if (selection.join() !== this.state.selection.join()) this.set({ selection }, 'selection')
      return result
    }
    this.undoStack.push({
      label,
      before: { document: this.state.document, selection: this.state.selection },
      after: { document: tx.document, selection }
    })
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift()
    this.redoStack = []
    this.set({ document: tx.document, selection }, 'document')
    return result
  }

  select(ids: string[]) {
    if (ids.join() === this.state.selection.join()) return
    this.set({ selection: ids }, 'selection')
  }

  setPage(pageId: string) {
    if (!this.state.document.pages.some((page) => page.id === pageId)) throw new EditError(`No page ${pageId}`)
    this.set({ pageId, selection: [] }, 'page')
  }

  undo(): boolean {
    const entry = this.undoStack.pop()
    if (!entry) return false
    this.redoStack.push(entry)
    this.set(entry.before, 'document')
    return true
  }

  redo(): boolean {
    const entry = this.redoStack.pop()
    if (!entry) return false
    this.undoStack.push(entry)
    this.set(entry.after, 'document')
    return true
  }
}

export function useStore<T>(store: DocumentStore, select: (state: StoreState) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.getState()))
}
