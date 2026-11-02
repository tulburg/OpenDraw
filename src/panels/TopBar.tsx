import { useState } from 'react'

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
}

/** The home button and one tab per open file (S-13 Req 3); tabs close and reorder by dragging. */
export function TopBar({ tabs, activeId, home, zoom, onHome, onSelect, onClose, onReorder }: TopBarProps) {
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
            <span className="tab-name" {...(tab.id === activeId ? { 'data-testid': 'file-name' } : {})}>
              {tab.name}
            </span>
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
      <div className="zoom-readout" data-testid="zoom-readout">
        {zoom === null ? '' : `${Math.round(zoom * 100)}%`}
      </div>
    </header>
  )
}
