import { useEffect, useRef, useState } from 'react'

import { shortcutLabel, VIEW_ITEMS, type ViewCommand } from '../../shared/commands'
import { setUserName, useUserName } from '../comments/user'

/** The zoom menu's commands reach the editor as this window event (S-24 Req 5). */
export const VIEW_COMMAND_EVENT = 'opendraw:view-command'

interface TopBarProps {
  tabs: { id: string; name: string }[]
  /** The tab in front, or null on the home view. */
  activeId: string | null
  home: boolean
  zoom: number | null
  onHome: () => void
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onReorder: (ids: string[]) => void
  /** The tab whose name is being edited (Rename File, S-24). */
  renamingId?: string | null
  onRename?: (id: string, name: string | null) => void
}

/** The home button and one tab per open file (S-13 Req 3); tabs close and reorder by dragging. */
export function TopBar({ tabs, activeId, home, zoom, onHome, onSelect, onClose, onReorder, renamingId, onRename }: TopBarProps) {
  const [dragging, setDragging] = useState<string | null>(null)

  const dropOn = (targetId: string) => {
    if (!dragging || dragging === targetId) return
    const ids = tabs.map((t) => t.id).filter((id) => id !== dragging)
    ids.splice(ids.indexOf(targetId) + (tabs.findIndex((t) => t.id === dragging) < tabs.findIndex((t) => t.id === targetId) ? 1 : 0), 0, dragging)
    onReorder(ids)
  }

  return (
    <header className="top-bar">
      <div className="tab-strip" data-testid="tabs">
        <button type="button" className={`home-button${home ? ' active' : ''}`} data-testid="home-button" title="All files" onClick={onHome}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M1.5 6.5 7 2l5.5 4.5V12a.5.5 0 0 1-.5.5H9V9H5v3.5H2a.5.5 0 0 1-.5-.5z" fill="none" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab${tab.id === activeId ? ' active' : ''}`}
            data-testid="tab"
            data-file-id={tab.id}
            draggable
            onDragStart={() => setDragging(tab.id)}
            onDragEnd={() => setDragging(null)}
            onDragOver={(event) => dragging && event.preventDefault()}
            onDrop={() => dropOn(tab.id)}
            onMouseDown={(event) => {
              if (event.button === 1) {
                event.preventDefault()
                onClose(tab.id)
              }
            }}
            onClick={() => onSelect(tab.id)}
          >
            {tab.id === renamingId ? (
              <input
                className="tab-rename"
                data-testid="tab-rename"
                autoFocus
                defaultValue={tab.name}
                onFocus={(event) => event.currentTarget.select()}
                onClick={(event) => event.stopPropagation()}
                onBlur={(event) => onRename?.(tab.id, event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur()
                  if (event.key === 'Escape') onRename?.(tab.id, null)
                }}
              />
            ) : (
              <span className="tab-name" {...(tab.id === activeId ? { 'data-testid': 'file-name' } : {})}>
                {tab.name}
              </span>
            )}
            <button
              type="button"
              className="tab-close"
              data-testid="tab-close"
              title="Close"
              onClick={(event) => {
                event.stopPropagation()
                onClose(tab.id)
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <UserButton />
      <ZoomMenu zoom={zoom} />
    </header>
  )
}

/** The zoom readout; clicking it lists the View menu's zoom commands (S-24 Req 5). */
function ZoomMenu({ zoom }: { zoom: number | null }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (event: PointerEvent) => !ref.current?.contains(event.target as Node) && setOpen(false)
    window.addEventListener('pointerdown', down, true)
    return () => window.removeEventListener('pointerdown', down, true)
  }, [open])
  const run = (command: ViewCommand) => {
    setOpen(false)
    window.dispatchEvent(new CustomEvent(VIEW_COMMAND_EVENT, { detail: command }))
  }
  const mac = window.opendraw.platform === 'darwin'
  return (
    <div className="zoom-menu" ref={ref}>
      <button type="button" className="zoom-readout" data-testid="zoom-readout" disabled={zoom === null} onClick={() => setOpen(!open)}>
        {zoom === null ? '' : `${Math.round(zoom * 100)}%`}
      </button>
      {open && zoom !== null && (
        <div className="zoom-popover" role="menu" data-testid="zoom-popover">
          {VIEW_ITEMS.map((item) => (
            <button key={item.command} type="button" role="menuitem" data-command={item.command} onClick={() => run(item.command)}>
              <span>{item.label}</span>
              {item.accelerator && <kbd>{shortcutLabel(item.accelerator, mac)}</kbd>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** The local user's name on comments (S-16 Req 2), changed in a small popover. */
function UserButton() {
  const name = useUserName()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (event: PointerEvent) => !ref.current?.contains(event.target as Node) && setOpen(false)
    window.addEventListener('pointerdown', down, true)
    return () => window.removeEventListener('pointerdown', down, true)
  }, [open])
  const save = () => {
    if (draft.trim()) setUserName(draft)
    setOpen(false)
  }
  return (
    <div className="user-menu" ref={ref}>
      <button
        type="button"
        className="user-button"
        data-testid="user-button"
        title={name ? `Commenting as ${name}` : 'Set your name'}
        onClick={() => {
          setDraft(name ?? '')
          setOpen(!open)
        }}
      >
        {name?.trim().charAt(0).toUpperCase() || '?'}
      </button>
      {open && (
        <div className="user-popover" data-testid="user-popover">
          <label htmlFor="user-name">Your name on comments</label>
          <input
            id="user-name"
            data-testid="user-name"
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') save()
              if (event.key === 'Escape') setOpen(false)
            }}
          />
          <button type="button" className="export-button" data-testid="user-save" onClick={save}>
            Save
          </button>
        </div>
      )}
    </div>
  )
}
