// The layer context menu (S-18 Req 7, S-19 Req 6), shared by the layers panel and the canvas.
import { useEffect } from 'react'

import type { DesignNode } from '../../shared/document'
import { toHTML } from '../../shared/html-out'
import { ALIGN_COMMANDS, type ArrangeCommand, arrangeLabel, arrangeState, runArrange } from '../canvas/arrange'
import { deleteSelection, duplicateSelection } from '../canvas/commands'
import type { DocumentStore } from '../document/store'
import { findNode } from '../document/tree'
import { measureNode } from '../Editor'
import { showNotice } from './notice'

interface Props {
  store: DocumentStore
  x: number
  y: number
  onClose: () => void
  /** Starts renaming in the layers panel; the canvas menu leaves Rename out. */
  onRename?: (id: string) => void
}

const ARRANGE_GROUPS: ArrangeCommand[][] = [
  ['wrap', 'unwrap'],
  [...ALIGN_COMMANDS],
  ['distribute-horizontal', 'distribute-vertical'],
  ['bring-to-front', 'bring-forward', 'send-backward', 'send-to-back']
]

export function LayerMenu({ store, x, y, onClose, onRename }: Props) {
  const { selection, document, pageId } = store.getState()
  const page = document.pages.find((p) => p.id === pageId)
  const nodes = selection.map((id) => (page ? findNode(page.nodes, id) : null)).filter((n): n is DesignNode => !!n)
  const allHidden = nodes.length > 0 && nodes.every((n) => n.style.display === 'none')
  const allLocked = nodes.length > 0 && nodes.every((n) => n.locked)
  const enabled = arrangeState(store, selection)

  useEffect(() => {
    const down = (event: PointerEvent) => !(event.target as Element).closest('.layer-menu') && onClose()
    const key = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key)
    }
  }, [onClose])

  const act = (run: () => void) => () => {
    onClose()
    try {
      run()
    } catch (err) {
      showNotice(err instanceof Error ? err.message : String(err))
    }
  }

  if (nodes.length === 0) return null
  // Keep the menu on screen near the bottom and right edges.
  const top = Math.min(y, window.innerHeight - 560)
  const left = Math.min(x, window.innerWidth - 220)
  return (
    <div className="page-menu layer-menu" data-testid="layer-menu" style={{ left, top: Math.max(8, top) }}
      onContextMenu={(e) => e.preventDefault()}
      // Inside the canvas, a pointerdown would start a canvas gesture and capture the pointer.
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      {onRename && (
        <button type="button" data-testid="layer-menu-rename" disabled={nodes.length !== 1} onClick={act(() => onRename(nodes[0].id))}>
          Rename
        </button>
      )}
      <button type="button" data-testid="layer-menu-duplicate" onClick={act(() => duplicateSelection(store, measureNode))}>
        Duplicate
      </button>
      <button type="button" data-testid="layer-menu-hide" onClick={act(() => store.transact(allHidden ? 'Show' : 'Hide', (tx) => tx.setHidden(selection, !allHidden)))}>
        {allHidden ? 'Show' : 'Hide'}
      </button>
      <button type="button" data-testid="layer-menu-lock" onClick={act(() => store.transact(allLocked ? 'Unlock' : 'Lock', (tx) => tx.setLocked(selection, !allLocked)))}>
        {allLocked ? 'Unlock' : 'Lock'}
      </button>
      <button type="button" data-testid="layer-menu-copy-html" onClick={act(() => void navigator.clipboard.writeText(nodes.map((n) => toHTML(n)).join('\n')))}>
        Copy as HTML
      </button>
      {ARRANGE_GROUPS.map((group, i) => (
        <div className="menu-group" key={i}>
          {group.map((command) => (
            <button
              key={command}
              type="button"
              data-testid={command === 'wrap' ? 'layer-menu-wrap' : `menu-${command}`}
              disabled={!enabled[command]}
              onClick={act(() => {
                const message = runArrange(store, command)
                if (message) showNotice(message)
              })}
            >
              {arrangeLabel(command)}
            </button>
          ))}
        </div>
      ))}
      <div className="menu-group">
        <button type="button" className="danger" data-testid="layer-menu-delete" onClick={act(() => deleteSelection(store))}>
          Delete
        </button>
      </div>
    </div>
  )
}
