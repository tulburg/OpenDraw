import type { DesignNode } from '../../shared/document'

interface LayersPanelProps {
  nodes: DesignNode[]
  selectedId: string | null
  onSelect: (id: string) => void
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

function LayerRows({ nodes, depth, selectedId, onSelect }: LayersPanelProps & { depth: number }) {
  return nodes.map((node) => (
    <li key={node.id}>
      <button
        type="button"
        className="layer-row"
        data-layer-id={node.id}
        data-selected={node.id === selectedId || undefined}
        style={{ paddingLeft: 8 + depth * INDENT_PX }}
        onClick={() => onSelect(node.id)}
      >
        <LayerIcon type={node.type} />
        <span className="layer-name">{node.name}</span>
      </button>
      {node.children.length > 0 && (
        <ul className="layer-list nested">
          <LayerRows nodes={node.children} depth={depth + 1} selectedId={selectedId} onSelect={onSelect} />
        </ul>
      )}
    </li>
  ))
}

export function LayersPanel({ nodes, selectedId, onSelect }: LayersPanelProps) {
  return (
    <aside className="panel layers-panel" data-testid="layers-panel">
      <div className="panel-title">Layers</div>
      {nodes.length === 0 ? (
        <div className="panel-empty">No layers on this page</div>
      ) : (
        <ul className="layer-list">
          <LayerRows nodes={nodes} depth={0} selectedId={selectedId} onSelect={onSelect} />
        </ul>
      )}
    </aside>
  )
}
