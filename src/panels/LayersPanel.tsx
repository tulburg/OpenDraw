import { memo, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { DesignNode } from '../../shared/document'
import { type DocumentStore, type Transaction, useStore } from '../document/store'
import { CommentsPanel } from './CommentsPanel'
import { LayerMenu } from './LayerMenu'
import { PagesList } from './PagesList'
import { TokensPanel } from './TokensPanel'
import { useRowWindow } from './windowed'

interface LayersPanelProps {
  nodes: DesignNode[]
  selection: string[]
  /** `additive` (shift + click) adds or removes the layer instead of replacing the selection. */
  onSelect: (id: string, additive: boolean) => void
}

const INDENT_PX = 12
/** Matches `.layer-row` height in styles.css. */
const ROW_PX = 28

function LayerIcon({ type }: { type: DesignNode['type'] }) {
  const paths: Record<DesignNode['type'], string> = {
    artboard: 'M5 2v12M11 2v12M2 5h12M2 11h12',
    frame: 'M3 3h10v10H3z',
    text: 'M4 4h8M8 4v9',
    image: 'M3 3h10v10H3zM3 11l3-3 3 3 2-2 2 2',
    svg: 'M3 13L8 3l5 10z'
  }
  return (
    <svg className="layer-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d={paths[type]} />
    </svg>
  )
}

interface Row {
  node: DesignNode
  depth: number
  /** The parent's ID, or the page ID for artboards. */
  parentId: string
  index: number
  hiddenByParent: boolean
}

/** The rows in view, top to bottom: collapsed layers hide their descendants. */
function flatten(nodes: DesignNode[], parentId: string, collapsed: Set<string>, depth = 0, hiddenByParent = false, out: Row[] = []): Row[] {
  nodes.forEach((node, index) => {
    out.push({ node, depth, parentId, index, hiddenByParent })
    if (node.children.length > 0 && !collapsed.has(node.id)) {
      flatten(node.children, node.id, collapsed, depth + 1, hiddenByParent || node.style.display === 'none', out)
    }
  })
  return out
}

const isContainer = (node: DesignNode) => node.type === 'frame' || node.type === 'artboard'

function ancestorsOf(nodes: DesignNode[], id: string, path: string[] = []): string[] | null {
  for (const node of nodes) {
    if (node.id === id) return path
    const found = ancestorsOf(node.children, id, [...path, node.id])
    if (found) return found
  }
  return null
}

const collapsedKey = (fileId: string) => `opendraw.collapsed.${fileId}`

function loadCollapsed(fileId: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(collapsedKey(fileId)) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

type Drop = { rowId: string; where: 'before' | 'after' | 'inside' }

function ToggleIcon({ kind, on }: { kind: 'eye' | 'lock'; on: boolean }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      {kind === 'eye' ? (
        on ? (
          <path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4zM8 6.2a1.8 1.8 0 100 3.6 1.8 1.8 0 000-3.6z" />
        ) : (
          <path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4zM3 13L13 3" />
        )
      ) : on ? (
        <path d="M4.5 7.5h7v5.5h-7zM6 7.5V5.5a2 2 0 014 0v2" />
      ) : (
        <path d="M4.5 7.5h7v5.5h-7zM6 7.5V5.5a2 2 0 013.9-.6" />
      )}
    </svg>
  )
}

interface LayerTreeProps {
  store: DocumentStore
  nodes: DesignNode[]
  selection: string[]
  onSelect: (id: string, additive: boolean) => void
}

/** The layer tree (S-18): rename, drag to reorder or nest, hide, lock, collapse and a context menu. */
function LayerTree({ store, nodes, selection, onSelect, scroller }: LayerTreeProps & { scroller: RefObject<HTMLElement | null> }) {
  const fileId = useStore(store, (s) => s.document.id)
  const pageId = useStore(store, (s) => s.pageId)
  const [collapsed, setCollapsed] = useState(() => loadCollapsed(fileId))
  const [renaming, setRenaming] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string[] | null>(null)
  const [drop, setDrop] = useState<Drop | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const anchor = useRef<string | null>(null)

  useEffect(() => setCollapsed(loadCollapsed(fileId)), [fileId])
  const saveCollapsed = (next: Set<string>) => {
    setCollapsed(next)
    try {
      localStorage.setItem(collapsedKey(fileId), JSON.stringify([...next]))
    } catch {}
  }
  // A layer selected on the canvas comes into view: its ancestors expand (S-18 Req 5).
  useEffect(() => {
    const open = selection.flatMap((id) => ancestorsOf(nodes, id) ?? []).filter((id) => collapsed.has(id))
    if (open.length === 0) return
    const next = new Set(collapsed)
    for (const id of open) next.delete(id)
    saveCollapsed(next)
  }, [selection])

  const closeMenu = useCallback(() => setMenu(null), [])

  // Scrolling re-renders the tree; the rows change only with the layers or what is collapsed.
  const rows = useMemo(() => flatten(nodes, pageId, collapsed), [nodes, pageId, collapsed])
  const rowById = useMemo(() => new Map(rows.map((r) => [r.node.id, r])), [rows])
  const listRef = useRef<HTMLUListElement>(null)
  const view = useRowWindow(scroller, listRef, rows.length, ROW_PX)
  // Keep the first selected layer in view when the selection changes on the canvas (S-6 Req 7).
  const firstSelected = useMemo(() => (selection[0] ? rows.findIndex((r) => r.node.id === selection[0]) : -1), [rows, selection])
  useLayoutEffect(() => {
    if (firstSelected >= 0) view.reveal(firstSelected)
  }, [selection, firstSelected >= 0])
  const targets = (id: string) => (selection.includes(id) ? selection : [id])

  const click = (event: React.MouseEvent, id: string) => {
    if (event.shiftKey && anchor.current && rowById.has(anchor.current)) {
      const a = rows.findIndex((r) => r.node.id === anchor.current)
      const b = rows.findIndex((r) => r.node.id === id)
      store.select(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.node.id))
      return
    }
    anchor.current = id
    onSelect(id, event.metaKey || event.ctrlKey)
  }

  const run = <T,>(label: string, edit: (tx: Transaction) => T) => {
    setMenu(null)
    try {
      return store.transact(label, edit)
    } catch (err) {
      console.warn(err)
      return undefined
    }
  }

  /** Where the dragged layers would land, or null when that move is not allowed. */
  const dropTarget = (d: Drop): { parentId: string; index?: number } | null => {
    if (!dragging) return null
    const row = rowById.get(d.rowId)
    if (!row) return null
    const moving = dragging.map((id) => rowById.get(id)?.node).filter((n): n is DesignNode => !!n)
    if (moving.some((n) => n.id === row.node.id || ancestorsOf(n.children, row.node.id) !== null)) return null
    const artboards = moving.every((n) => n.type === 'artboard')
    if (!artboards && moving.some((n) => n.type === 'artboard')) return null
    if (artboards) return row.depth === 0 && d.where !== 'inside' ? { parentId: pageId, index: row.index + (d.where === 'after' ? 1 : 0) } : null
    if (d.where === 'inside') return isContainer(row.node) ? { parentId: row.node.id } : null
    if (row.depth === 0) return null
    return { parentId: row.parentId, index: row.index + (d.where === 'after' ? 1 : 0) }
  }

  const finishDrop = () => {
    const target = drop && dropTarget(drop)
    if (target && dragging) {
      const order = rows.map((r) => r.node.id)
      const ids = [...dragging].sort((a, b) => order.indexOf(a) - order.indexOf(b))
      run(ids.length > 1 ? 'Move layers' : 'Move layer', (tx) => {
        tx.moveNodes(ids, target.parentId, target.index)
        tx.select(ids)
      })
    }
    setDragging(null)
    setDrop(null)
  }


  return (
    <>
      <ul ref={listRef} className="layer-list" data-testid="layer-list" onDragOver={(event) => dragging && event.preventDefault()} onDrop={(event) => (event.preventDefault(), finishDrop())}>
        {view.before > 0 && <li aria-hidden="true" style={{ height: view.before }} />}
        {rows.slice(view.start, view.end).map((row) => {
          const { node } = row
          const hidden = node.style.display === 'none'
          const target = drop?.rowId === node.id && dropTarget(drop) ? drop.where : undefined
          return (
            <li key={node.id}>
              <div
                className="layer-row"
                role="treeitem"
                aria-expanded={node.children.length > 0 ? !collapsed.has(node.id) : undefined}
                data-layer-id={node.id}
                data-selected={selection.includes(node.id) || undefined}
                data-hidden={hidden || row.hiddenByParent || undefined}
                data-locked={node.locked || undefined}
                data-drop={target}
                style={{ paddingLeft: 4 + row.depth * INDENT_PX }}
                draggable={renaming !== node.id}
                onDragStart={(event) => {
                  event.dataTransfer.setData('text/plain', node.id)
                  event.dataTransfer.effectAllowed = 'move'
                  setDragging(targets(node.id))
                }}
                onDragEnd={() => {
                  setDragging(null)
                  setDrop(null)
                }}
                onDragOver={(event) => {
                  if (!dragging) return
                  event.preventDefault()
                  const box = event.currentTarget.getBoundingClientRect()
                  const y = (event.clientY - box.top) / box.height
                  const where = isContainer(node) ? (y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'inside') : y < 0.5 ? 'before' : 'after'
                  if (drop?.rowId !== node.id || drop.where !== where) setDrop({ rowId: node.id, where })
                }}
                onClick={(event) => click(event, node.id)}
                onDoubleClick={() => setRenaming(node.id)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  if (!selection.includes(node.id)) {
                    anchor.current = node.id
                    store.select([node.id])
                  }
                  setMenu({ x: event.clientX, y: event.clientY })
                }}
              >
                <button
                  type="button"
                  className="layer-chevron"
                  aria-label={collapsed.has(node.id) ? 'Expand' : 'Collapse'}
                  data-testid="layer-chevron"
                  style={{ visibility: node.children.length > 0 ? 'visible' : 'hidden' }}
                  onClick={(event) => {
                    event.stopPropagation()
                    const next = new Set(collapsed)
                    if (next.has(node.id)) next.delete(node.id)
                    else next.add(node.id)
                    saveCollapsed(next)
                  }}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d={collapsed.has(node.id) ? 'M6 4l4 4-4 4' : 'M4 6l4 4 4-4'} />
                  </svg>
                </button>
                <LayerIcon type={node.type} />
                {renaming === node.id ? (
                  <input
                    className="layer-name-input"
                    data-testid="layer-rename"
                    defaultValue={node.name}
                    autoFocus
                    onFocus={(event) => event.currentTarget.select()}
                    onClick={(event) => event.stopPropagation()}
                    onBlur={(event) => {
                      const name = event.currentTarget.value.trim()
                      setRenaming(null)
                      if (name && name !== node.name) run('Rename layer', (tx) => tx.rename(node.id, name))
                    }}
                    onKeyDown={(event) => {
                      event.stopPropagation()
                      if (event.key === 'Enter') event.currentTarget.blur()
                      if (event.key === 'Escape') {
                        event.currentTarget.value = node.name
                        event.currentTarget.blur()
                      }
                    }}
                  />
                ) : (
                  <span className="layer-name">{node.name}</span>
                )}
                <span className="layer-toggles">
                  <button
                    type="button"
                    className="layer-toggle"
                    data-testid="layer-lock"
                    data-on={node.locked || undefined}
                    aria-label={node.locked ? 'Unlock' : 'Lock'}
                    title={node.locked ? 'Unlock' : 'Lock'}
                    onClick={(event) => {
                      event.stopPropagation()
                      run(node.locked ? 'Unlock' : 'Lock', (tx) => tx.setLocked(targets(node.id), !node.locked))
                    }}
                  >
                    <ToggleIcon kind="lock" on={!!node.locked} />
                  </button>
                  <button
                    type="button"
                    className="layer-toggle"
                    data-testid="layer-visibility"
                    data-on={hidden || undefined}
                    aria-label={hidden ? 'Show' : 'Hide'}
                    title={hidden ? 'Show' : 'Hide'}
                    onClick={(event) => {
                      event.stopPropagation()
                      run(hidden ? 'Show' : 'Hide', (tx) => tx.setHidden(targets(node.id), !hidden))
                    }}
                  >
                    <ToggleIcon kind="eye" on={!hidden} />
                  </button>
                </span>
              </div>
            </li>
          )
        })}
        {view.after > 0 && <li aria-hidden="true" style={{ height: view.after }} />}
      </ul>
      {menu && <LayerMenu store={store} x={menu.x} y={menu.y} onClose={closeMenu} onRename={setRenaming} />}
    </>
  )
}

interface CommentProps {
  store: DocumentStore
  openThread: string | null
  onOpenThread: (id: string | null) => void
}

/** Memoized: panning and zooming re-render the editor, and must not re-render every layer row (S-21). */
export const LayersPanel = memo(function LayersPanel({ store, nodes, selection, onSelect, openThread, onOpenThread }: LayersPanelProps & CommentProps) {
  const ref = useRef<HTMLElement>(null)
  const [tab, setTab] = useState<'layers' | 'tokens' | 'comments'>('layers')
  return (
    <aside ref={ref} className="panel layers-panel" data-testid="layers-panel">
      <PagesList store={store} />
      <div className="panel-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'layers'} data-testid="tab-layers" onClick={() => setTab('layers')}>
          Layers
        </button>
        <button type="button" role="tab" aria-selected={tab === 'tokens'} data-testid="tab-tokens" onClick={() => setTab('tokens')}>
          Tokens
        </button>
        <button type="button" role="tab" aria-selected={tab === 'comments'} data-testid="tab-comments" onClick={() => setTab('comments')}>
          Comments
        </button>
      </div>
      {tab === 'comments' ? (
        <CommentsPanel store={store} openThread={openThread} onOpenThread={onOpenThread} />
      ) : tab === 'tokens' ? (
        <TokensPanel store={store} />
      ) : nodes.length === 0 ? (
        <div className="panel-empty">No layers on this page</div>
      ) : (
        <LayerTree store={store} nodes={nodes} selection={selection} onSelect={onSelect} scroller={ref} />
      )}
    </aside>
  )
})
