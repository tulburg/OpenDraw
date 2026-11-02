import { useEffect, useRef, useState } from 'react'

import type { DesignNode } from '../../shared/document'
import type { DocumentStore } from '../document/store'
import { PagesList } from './PagesList'
import { TokensPanel } from './TokensPanel'

interface LayersPanelProps {
  nodes: DesignNode[]
  selection: string[]
  /** `additive` (shift + click) adds or removes the layer instead of replacing the selection. */
  onSelect: (id: string, additive: boolean) => void
}

const INDENT_PX = 12

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

function LayerRows({ nodes, depth, selection, onSelect }: LayersPanelProps & { depth: number }) {
  return nodes.map((node) => (
    <li key={node.id}>
      <button
        type="button"
        className="layer-row"
        data-layer-id={node.id}
        data-selected={selection.includes(node.id) || undefined}
        style={{ paddingLeft: 8 + depth * INDENT_PX }}
        onClick={(event) => onSelect(node.id, event.shiftKey)}
      >
        <LayerIcon type={node.type} />
        <span className="layer-name">{node.name}</span>
      </button>
      {node.children.length > 0 && (
        <ul className="layer-list nested">
          <LayerRows nodes={node.children} depth={depth + 1} selection={selection} onSelect={onSelect} />
        </ul>
      )}
    </li>
  ))
}

export function LayersPanel({ store, nodes, selection, onSelect }: LayersPanelProps & { store: DocumentStore }) {
  // Keep the first selected layer in view when the selection changes on the canvas (S-6 Req 7).
  const ref = useRef<HTMLElement>(null)
  const [tab, setTab] = useState<'layers' | 'tokens'>('layers')
  useEffect(() => {
    if (!selection[0]) return
    ref.current?.querySelector(`[data-layer-id="${CSS.escape(selection[0])}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selection])
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
      </div>
      {tab === 'tokens' ? (
        <TokensPanel store={store} />
      ) : nodes.length === 0 ? (
        <div className="panel-empty">No layers on this page</div>
      ) : (
        <ul className="layer-list">
          <LayerRows nodes={nodes} depth={0} selection={selection} onSelect={onSelect} />
        </ul>
      )}
    </aside>
  )
}
