// The canvas toolbar (S-9 Req 1): one button per tool, with its name and shortcut on hover.
import type { ReactNode } from 'react'

import { type Tool, TOOLS } from './tools'

const ICONS: Record<Tool, ReactNode> = {
  select: <path d="M5 3l11 6.5-5 1.2L8.6 16z" />,
  hand: (
    <path d="M7 10V5.5a1.2 1.2 0 012.4 0V9m0-4.5V4a1.2 1.2 0 012.4 0v5m0-4a1.2 1.2 0 012.4 0v5m0-3a1.2 1.2 0 012.4 0v5.5a5.5 5.5 0 01-5.5 5.5h-.6a5 5 0 01-4-2L4 12.4a1.3 1.3 0 012-1.6L7 12" />
  ),
  artboard: <path d="M6 3v14M14 3v14M3 6h14M3 14h14" />,
  frame: <rect x="4" y="4" width="12" height="12" rx="1" />,
  text: <path d="M5 5h10M10 5v11M7.5 16h5" />,
  image: (
    <>
      <rect x="3.5" y="4.5" width="13" height="11" rx="1.5" />
      <path d="M4 14l4-4 3 3 2-2 3 3" />
      <circle cx="12.5" cy="8" r="1.2" />
    </>
  )
}

export function Toolbar({ tool, onSelect }: { tool: Tool; onSelect: (tool: Tool) => void }) {
  return (
    <div className="toolbar" onPointerDown={(event) => event.stopPropagation()}>
      {TOOLS.map(({ tool: t, name, key }) => (
        <button
          key={t}
          type="button"
          className="tool-button"
          data-tool={t}
          data-active={tool === t || undefined}
          title={`${name} (${key})`}
          aria-label={name}
          onClick={() => onSelect(t)}
        >
          <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            {ICONS[t]}
          </svg>
        </button>
      ))}
    </div>
  )
}
