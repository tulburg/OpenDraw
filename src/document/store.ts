// The one path for changing a document (S-3): edits run inside transactions, each transaction is one
// undo step, and listeners re-render and autosave from the committed state.
import { useSyncExternalStore } from 'react'

import { type CommentThread, type DesignDocument, type DesignNode, type ExportSetting, newId, type Page, type PageIcon, type TextSpan, TOKEN_TYPES } from '../../shared/document'
import { arrangePages, nextPageName, PageError } from '../../shared/pages'
import { type CreateEntry, createTokens, type SetEntry, setTokens, type TokenResult } from '../../shared/tokens'
import { clearFromSpans } from './richtext'
import { applyStyleUpdate, type StyleUpdate } from './styles'
import * as tree from './tree'
import { EditError } from './tree'

export { EditError }

const MAX_UNDO = 200

/** A layer's top-left corner in world units, measured by the canvas showing it (S-16 Req 5). */
let nodeLocator: ((id: string) => { x: number; y: number } | null) | null = null
export function setNodeLocator(locator: typeof nodeLocator) {
  nodeLocator = locator
}

export interface Author {
  id: string
  name: string
}

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

function sameStyle(a: DesignNode['style'], b: DesignNode['style']): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

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
      const node = this.node(id)
      const { style, ignored } = applyStyleUpdate(node, update)
      if (!sameStyle(style, node.style)) this.update(id, (page) => tree.setStyles(page, id, style))
      // A text style set on the whole layer reaches all of its text, so runs stop overriding it.
      if (node.spans) {
        const spans = clearFromSpans(node.spans, Object.keys(update))
        const unchanged = JSON.stringify(spans) === JSON.stringify(node.spans)
        if (!unchanged) this.update(id, (page) => tree.setRichText(page, id, spans ?? [{ text: node.text ?? '' }]))
      }
      if (Object.keys(ignored).length > 0) ignoredByNode[id] = ignored
    }
    return ignoredByNode
  }

  setText(id: string, text: string) {
    this.update(id, (page) => tree.setText(page, id, text))
  }

  setRichText(id: string, spans: TextSpan[]) {
    this.update(id, (page) => tree.setRichText(page, id, spans))
  }

  rename(id: string, name: string) {
    this.update(id, (page) => tree.rename(page, id, name))
  }

  setExports(id: string, exports: ExportSetting[]) {
    this.update(id, (page) => tree.setExports(page, id, exports))
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
    this.unpinThreads(ids)
    for (const id of ids) this.update(id, (page) => tree.deleteNodes(page, [id]))
  }

  /** Threads pinned to these layers (or inside them) stay where the layer was, as canvas points. */
  private unpinThreads(ids: string[]) {
    const threads = this.document.comments
    if (!threads?.some((t) => t.nodeId)) return
    const doomed = new Set<string>()
    const collect = (node: DesignNode) => {
      doomed.add(node.id)
      node.children.forEach(collect)
    }
    for (const page of this.document.pages) for (const id of ids) {
      const node = tree.findNode(page.nodes, id)
      if (node) collect(node)
    }
    const origin = (id: string) => {
      const measured = nodeLocator?.(id)
      if (measured) return measured
      const page = this.document.pages.find((p) => tree.findNode(p.nodes, id))
      const artboard = page?.nodes.find((a) => a.id === id || tree.findNode(a.children, id))
      return artboard ? { x: Number.parseFloat(String(artboard.style.left ?? 0)) || 0, y: Number.parseFloat(String(artboard.style.top ?? 0)) || 0 } : { x: 0, y: 0 }
    }
    let changed = false
    const comments = threads.map((t) => {
      if (!t.nodeId || !doomed.has(t.nodeId)) return t
      changed = true
      const at = origin(t.nodeId)
      const { nodeId: _, ...rest } = t
      return { ...rest, x: Math.round(at.x + t.x), y: Math.round(at.y + t.y) }
    })
    if (changed) this.document = { ...this.document, comments }
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

  private pageIndex(pageId: string): number {
    const index = this.document.pages.findIndex((p) => p.id === pageId)
    if (index === -1) throw new EditError(`No page with ID ${pageId}`)
    return index
  }

  /** Puts `page` at `index` among the pages; dividers below it move down with the pages. */
  private insertPage(index: number, page: Page) {
    const pages = [...this.document.pages]
    pages.splice(index, 0, page)
    const dividers = this.document.dividers?.map((d) => (d.index >= index ? { ...d, index: d.index + 1 } : d))
    this.document = { ...this.document, pages, ...(dividers ? { dividers } : {}) }
  }

  /** Adds a page after `afterId` (or at the end) and returns its ID (S-12). */
  addPage(args: { name?: string; icon?: PageIcon; afterId?: string } = {}): string {
    const index = args.afterId ? this.pageIndex(args.afterId) + 1 : this.document.pages.length
    const page: Page = { id: newId(), name: args.name?.trim() || nextPageName(this.document), ...(args.icon ? { icon: args.icon } : {}), nodes: [] }
    this.insertPage(index, page)
    return page.id
  }

  /** Renames a page or changes its icon; `icon: null` restores the default. */
  updatePage(pageId: string, change: { name?: string; icon?: PageIcon | null }) {
    const index = this.pageIndex(pageId)
    const page = { ...this.document.pages[index] }
    if (change.name !== undefined && change.name.trim()) page.name = change.name.trim()
    if (change.icon === null) delete page.icon
    else if (change.icon !== undefined) page.icon = change.icon
    const before = this.document.pages[index]
    if (page.name === before.name && page.icon === before.icon) return
    const pages = [...this.document.pages]
    pages[index] = page
    this.document = { ...this.document, pages }
  }

  /** Copies a page and everything on it, with new IDs, right after it. */
  duplicatePage(pageId: string): string {
    const index = this.pageIndex(pageId)
    const source = this.document.pages[index]
    const idMap: Record<string, string> = {}
    const page: Page = { ...source, id: newId(), name: `${source.name} copy`, nodes: source.nodes.map((n) => tree.cloneWithNewIds(n, idMap)) }
    this.insertPage(index + 1, page)
    return page.id
  }

  /** Deletes a page; the last page cannot go. */
  deletePage(pageId: string) {
    const index = this.pageIndex(pageId)
    if (this.document.pages.length === 1) throw new EditError('A file needs at least one page')
    const pages = this.document.pages.filter((p) => p.id !== pageId)
    const dividers = this.document.dividers?.map((d) => (d.index > index ? { ...d, index: d.index - 1 } : d))
    this.document = { ...this.document, pages, ...(dividers ? { dividers } : {}) }
  }

  /** Adds a divider below `afterPageId` and returns its ID. */
  addDivider(afterPageId: string): string {
    const index = this.pageIndex(afterPageId) + 1
    const id = newId()
    const dividers = [...(this.document.dividers ?? [])]
    const at = dividers.findIndex((d) => d.index > index)
    dividers.splice(at === -1 ? dividers.length : at, 0, { id, index })
    this.document = { ...this.document, dividers }
    return id
  }

  removeDivider(id: string) {
    if (!this.document.dividers?.some((d) => d.id === id)) throw new EditError(`No divider with ID ${id}`)
    this.document = { ...this.document, dividers: this.document.dividers.filter((d) => d.id !== id) }
  }

  /** Reorders pages and dividers (shared/pages.ts `arrangePages`); returns new divider IDs. */
  arrangePages(order: (string | { type: 'divider' })[], removeDividerIds?: string[]): string[] {
    try {
      const result = arrangePages(this.document, order, removeDividerIds)
      const same = JSON.stringify(result.document.pages.map((p) => p.id)) === JSON.stringify(this.document.pages.map((p) => p.id)) &&
        JSON.stringify(result.document.dividers ?? []) === JSON.stringify(this.document.dividers ?? [])
      if (!same) this.document = result.document
      return result.newDividerIds
    } catch (err) {
      if (err instanceof PageError) throw new EditError(err.message)
      throw err
    }
  }

  /** Adds design tokens (S-14); each entry succeeds or fails on its own. */
  createTokens(entries: CreateEntry[]): TokenResult[] {
    const { tokens, results } = createTokens(this.document.tokens ?? [], entries, TOKEN_TYPES)
    if (results.some((r) => r.result !== 'error')) this.document = { ...this.document, tokens }
    return results
  }

  /** Renames, updates or deletes tokens in order. */
  setTokens(entries: SetEntry[]): TokenResult[] {
    const { document, results } = setTokens(this.document, entries)
    if (results.some((r) => r.result !== 'error')) this.document = document
    return results
  }

  private updateThread(id: string, change: (thread: CommentThread) => CommentThread) {
    const threads = this.document.comments ?? []
    const index = threads.findIndex((t) => t.id === id && !t.deleted)
    if (index === -1) throw new EditError(`No comment thread with ID ${id}`)
    const comments = [...threads]
    comments[index] = change(threads[index])
    this.document = { ...this.document, comments }
  }

  /** Starts a thread (S-16): pinned to a layer at an offset from its corner, or to a canvas point. */
  addThread(args: { pageId: string; nodeId?: string; x: number; y: number; text: string; author: Author }): string {
    const now = new Date().toISOString()
    const thread: CommentThread = {
      id: newId(),
      pageId: args.pageId,
      ...(args.nodeId ? { nodeId: args.nodeId } : {}),
      x: Math.round(args.x),
      y: Math.round(args.y),
      status: 'open',
      createdAt: now,
      updatedAt: now,
      messages: [{ id: newId(), authorId: args.author.id, authorName: args.author.name, text: args.text, createdAt: now }]
    }
    this.document = { ...this.document, comments: [...(this.document.comments ?? []), thread] }
    return thread.id
  }

  reply(threadId: string, text: string, author: Author): string {
    const now = new Date().toISOString()
    const id = newId()
    this.updateThread(threadId, (t) => ({
      ...t,
      updatedAt: now,
      messages: [...t.messages, { id, authorId: author.id, authorName: author.name, text, createdAt: now }]
    }))
    return id
  }

  setThreadStatus(threadId: string, status: CommentThread['status']) {
    this.updateThread(threadId, (t) => (t.status === status ? t : { ...t, status, updatedAt: new Date().toISOString() }))
  }

  /** Moves a pin: onto a layer (an offset from its corner) or to a canvas point. */
  movePin(threadId: string, pin: { nodeId?: string; x: number; y: number }) {
    this.updateThread(threadId, ({ nodeId: _, ...t }) => ({ ...t, ...(pin.nodeId ? { nodeId: pin.nodeId } : {}), x: Math.round(pin.x), y: Math.round(pin.y) }))
  }

  /** Toggles a user's reaction on a message. */
  react(threadId: string, messageId: string, emoji: string, userId: string) {
    this.updateThread(threadId, (t) => ({
      ...t,
      messages: t.messages.map((m) => {
        if (m.id !== messageId) return m
        const reactions = { ...m.reactions }
        const users = reactions[emoji] ?? []
        reactions[emoji] = users.includes(userId) ? users.filter((u) => u !== userId) : [...users, userId]
        if (reactions[emoji].length === 0) delete reactions[emoji]
        return { ...m, reactions }
      })
    }))
  }

  /** Deletes are soft: the record stays in the file but no view or tool shows it (S-16 Req 5). */
  deleteThread(threadId: string) {
    this.updateThread(threadId, (t) => ({ ...t, deleted: true, updatedAt: new Date().toISOString() }))
  }

  deleteMessage(threadId: string, messageId: string) {
    this.updateThread(threadId, (t) => {
      const messages = t.messages.map((m) => (m.id === messageId ? { ...m, deleted: true } : m))
      // Deleting the first message deletes the thread.
      return { ...t, messages, deleted: t.messages[0].id === messageId || t.deleted, updatedAt: new Date().toISOString() }
    })
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
    const document = change.document ?? this.state.document
    const pageId = change.pageId ?? this.state.pageId
    // An undo can take away the page in view; show the first page then.
    if (!document.pages.some((p) => p.id === pageId)) change = { ...change, pageId: document.pages[0].id }
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
   * Edits that leave the document unchanged add no undo step. With `merge`, the edit joins the last
   * undo step instead of adding one (typing into a text layer that was just drawn, say).
   */
  transact<T>(label: string, edit: (tx: Transaction) => T, merge = false): T {
    const tx = new Transaction(this.state.document)
    const result = edit(tx)
    const selection = tx.selectionAfter(this.state.selection)
    if (tx.document === this.state.document) {
      if (selection.join() !== this.state.selection.join()) this.set({ selection }, 'selection')
      return result
    }
    const last = merge ? this.undoStack.pop() : undefined
    this.undoStack.push({
      label: last?.label ?? label,
      before: last?.before ?? { document: this.state.document, selection: this.state.selection },
      after: { document: tx.document, selection }
    })
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift()
    this.redoStack = []
    this.set({ document: tx.document, selection }, 'document')
    return result
  }

  /** Takes back the last undo step for good: it cannot be redone (a drawn text layer left empty). */
  dropLastStep() {
    const entry = this.undoStack.pop()
    if (entry) this.set(entry.before, 'document')
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
