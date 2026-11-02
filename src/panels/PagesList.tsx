// The page list above the layers (S-12): switch, add, rename, reorder by drag, icons, dividers.
// Every change is one undo step through the store.
import { useEffect, useState } from 'react'

import { PAGE_ICONS, type PageIcon } from '../../shared/document'
import { type PageListItem, pageList } from '../../shared/pages'
import { type DocumentStore, useStore } from '../document/store'

const ICON_PATHS: Record<PageIcon | 'default', string> = {
  default: 'M4 2.5h5.5L12 5v8.5H4zM9.5 2.5V5H12',
  arrow: 'M2.5 6h6V3l5 5-5 5v-3h-6z',
  padlock: 'M4 7.5h8v6H4zM5.5 7.5V5.5a2.5 2.5 0 0 1 5 0v2',
  check: 'M3 8.5l3 3 7-7',
  cross: 'M4 4l8 8M12 4l-8 8',
  info: 'M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8zM8 7v4.5M8 4.6v.4',
  question: 'M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8zM6.2 6.2a1.8 1.8 0 1 1 2.6 1.6c-.5.3-.8.7-.8 1.3v.4M8 11.2v.4',
  design: 'M3 13l7.5-7.5 2 2L5 15H3zM2.5 3.5l3-1 8 8-1 3',
  vector: 'M3 13C5 5 11 11 13 3M2 12h2v2H2zM12 2h2v2h-2z',
  images: 'M2.5 3.5h11v9h-11zM2.5 10.5l3-3 3 3 2-2 3 3M10.5 6.5h.1',
  table: 'M2.5 3.5h11v9h-11zM2.5 6.5h11M2.5 9.5h11M6.5 3.5v9',
  presentation: 'M2 3h12M3 3v7h10V3M8 10v3M5.5 14.5L8 13l2.5 1.5',
  blueprint: 'M2.5 2.5h11v11h-11zM2.5 7h5V2.5M7.5 7v6.5M10.5 7h3',
  swatches: 'M3 2.5h4v10a2 2 0 0 1-4 0zM7 5l3-2 2.5 3.5L7 11M7 13.5h6.5v-4H9',
  'bar-chart': 'M2.5 13.5h11M4.5 13.5v-4M8 13.5v-8M11.5 13.5v-6',
  'line-chart': 'M2.5 2.5v11h11M4.5 10l3-3.5 2.5 2 3.5-4.5',
  'pie-chart': 'M8 2a6 6 0 1 0 6 6H8zM10 1v5h5a5 5 0 0 0-5-5z',
  paper: 'M3.5 3l3-1 2.5 1.5L12.5 2l1 4-1.5 2.5 1 4-3.5 1.5-2.5-1L4 14 2.5 10 4 7.5z'
}

export function PageIconView({ icon }: { icon?: PageIcon }) {
  return (
    <svg className="page-icon" viewBox="0 0 16 16" aria-hidden="true" data-icon={icon ?? 'default'}>
      <path d={ICON_PATHS[icon ?? 'default']} />
    </svg>
  )
}

type Menu = { id: string; type: 'page' | 'divider'; x: number; y: number; icons?: boolean }

export function PagesList({ store }: { store: DocumentStore }) {
  const document = useStore(store, (s) => s.document)
  const pageId = useStore(store, (s) => s.pageId)
  const items = pageList(document)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)

  useEffect(() => {
    if (!menu) return
    const close = (event: MouseEvent) => {
      if (!(event.target as Element).closest('.page-menu')) setMenu(null)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  const addPage = () => {
    const id = store.transact('Add page', (tx) => tx.addPage({ afterId: pageId }))
    store.setPage(id)
  }

  const run = (label: string, edit: Parameters<DocumentStore['transact']>[1]) => {
    setMenu(null)
    return store.transact(label, edit)
  }

  const drop = (index: number) => {
    const id = dragging
    setDragging(null)
    setDropAt(null)
    if (!id) return
    const order = items.map((i) => i.id)
    const from = order.indexOf(id)
    order.splice(from, 1)
    order.splice(index > from ? index - 1 : index, 0, id)
    if (order.join() !== items.map((i) => i.id).join()) store.transact('Reorder pages', (tx) => tx.arrangePages(order))
  }

  const pageCount = document.pages.length
  const menuItem = menu && items.find((i) => i.id === menu.id)

  return (
    <div className="pages-section" data-testid="pages">
      <div className="panel-title pages-title">
        <span>Pages</span>
        <button type="button" className="icon-button" data-testid="add-page" title="Add page" onClick={addPage}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 3v10M3 8h10" />
          </svg>
        </button>
      </div>
      <ul className="page-list" onDragOver={(event) => dragging && event.preventDefault()}>
        {items.map((item, index) => (
          <li
            key={item.id}
            className={dropAt === index ? 'drop-before' : dropAt === index + 1 && index === items.length - 1 ? 'drop-after' : undefined}
            onDragOver={(event) => {
              if (!dragging) return
              event.preventDefault()
              const box = event.currentTarget.getBoundingClientRect()
              setDropAt(event.clientY < box.top + box.height / 2 ? index : index + 1)
            }}
            onDrop={(event) => {
              event.preventDefault()
              if (dropAt !== null) drop(dropAt)
            }}
          >
            {item.type === 'divider' ? (
              <div
                className="page-divider"
                data-testid="page-divider"
                data-divider-id={item.id}
                draggable
                onDragStart={(event) => (event.dataTransfer.setData('text/plain', item.id), setDragging(item.id))}
                onDragEnd={() => (setDragging(null), setDropAt(null))}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setMenu({ id: item.id, type: 'divider', x: event.clientX, y: event.clientY })
                }}
              >
                <hr />
              </div>
            ) : (
              <PageRow
                item={item}
                active={item.id === pageId}
                renaming={renaming === item.id}
                onSelect={() => item.id !== pageId && store.setPage(item.id)}
                onStartRename={() => setRenaming(item.id)}
                onRename={(name) => {
                  setRenaming(null)
                  if (name !== null) store.transact('Rename page', (tx) => tx.updatePage(item.id, { name }))
                }}
                onDragStart={() => setDragging(item.id)}
                onDragEnd={() => (setDragging(null), setDropAt(null))}
                onMenu={(x, y) => setMenu({ id: item.id, type: 'page', x, y })}
              />
            )}
          </li>
        ))}
      </ul>
      {menu && menuItem && (
        <div className="page-menu" data-testid="page-menu" style={{ left: menu.x, top: menu.y }}>
          {menu.type === 'divider' ? (
            <button type="button" data-testid="menu-remove-divider" onClick={() => run('Remove divider', (tx) => tx.removeDivider(menu.id))}>
              Remove divider
            </button>
          ) : menu.icons ? (
            <div className="icon-grid" data-testid="icon-grid">
              <button type="button" title="Default" data-icon="default" onClick={() => run('Change page icon', (tx) => tx.updatePage(menu.id, { icon: null }))}>
                <PageIconView />
              </button>
              {PAGE_ICONS.map((icon) => (
                <button type="button" key={icon} title={icon} data-icon={icon} onClick={() => run('Change page icon', (tx) => tx.updatePage(menu.id, { icon }))}>
                  <PageIconView icon={icon} />
                </button>
              ))}
            </div>
          ) : (
            <>
              <button type="button" data-testid="menu-rename" onClick={() => (setMenu(null), setRenaming(menu.id))}>
                Rename
              </button>
              <button
                type="button"
                data-testid="menu-duplicate"
                onClick={() => {
                  const id = run('Duplicate page', (tx) => tx.duplicatePage(menu.id)) as string
                  store.setPage(id)
                }}
              >
                Duplicate
              </button>
              <button type="button" data-testid="menu-icon" onClick={() => setMenu({ ...menu, icons: true })}>
                Change icon
              </button>
              <button type="button" data-testid="menu-add-divider" onClick={() => run('Add divider', (tx) => tx.addDivider(menu.id))}>
                Add divider below
              </button>
              {pageCount > 1 && (
                <button type="button" className="danger" data-testid="menu-delete" onClick={() => (setMenu(null), setConfirmDelete(menu.id))}>
                  Delete
                </button>
              )}
            </>
          )}
        </div>
      )}
      {confirmDelete && (
        <div className="confirm-backdrop" data-testid="confirm-delete">
          <div className="confirm-dialog">
            <p>Delete "{document.pages.find((p) => p.id === confirmDelete)?.name}" and everything on it?</p>
            <div className="confirm-actions">
              <button type="button" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="danger"
                data-testid="confirm-delete-button"
                onClick={() => {
                  const id = confirmDelete
                  setConfirmDelete(null)
                  if (id === pageId) {
                    const pages = document.pages
                    const i = pages.findIndex((p) => p.id === id)
                    store.setPage((pages[i + 1] ?? pages[i - 1]).id)
                  }
                  store.transact('Delete page', (tx) => tx.deletePage(id))
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

interface PageRowProps {
  item: Extract<PageListItem, { type: 'page' }>
  active: boolean
  renaming: boolean
  onSelect: () => void
  onStartRename: () => void
  /** The new name, or null when renaming was cancelled. */
  onRename: (name: string | null) => void
  onDragStart: () => void
  onDragEnd: () => void
  onMenu: (x: number, y: number) => void
}

function PageRow({ item, active, renaming, onSelect, onStartRename, onRename, onDragStart, onDragEnd, onMenu }: PageRowProps) {
  return (
    <div
      className="page-row"
      role="button"
      data-testid="page-row"
      data-page-id={item.id}
      data-active={active || undefined}
      draggable={!renaming}
      onDragStart={(event) => (event.dataTransfer.setData('text/plain', item.id), onDragStart())}
      onDragEnd={onDragEnd}
      onClick={onSelect}
      onDoubleClick={onStartRename}
      onContextMenu={(event) => {
        event.preventDefault()
        onMenu(event.clientX, event.clientY)
      }}
    >
      <PageIconView icon={item.icon} />
      {renaming ? (
        <input
          className="page-name-input"
          data-testid="page-rename"
          defaultValue={item.name}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onClick={(event) => event.stopPropagation()}
          onBlur={(event) => onRename(event.currentTarget.value.trim() ? event.currentTarget.value : null)}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') {
              event.currentTarget.value = ''
              event.currentTarget.blur()
            }
          }}
        />
      ) : (
        <span className="page-name">{item.name}</span>
      )}
    </div>
  )
}
