import type { DesignNode } from '../../shared/document'

/** Read-only for now: style editing is a later spec. */
export function StylesPanel({ node }: { node: DesignNode | null }) {
  return (
    <aside className="panel styles-panel" data-testid="styles-panel">
      {node ? (
        <>
          <div className="panel-title">{node.name}</div>
          <dl className="style-list">
            {Object.entries(node.style).map(([property, value]) => (
              <div key={property} className="style-row">
                <dt>{property}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : (
        <div className="panel-empty">Select a layer to see its styles</div>
      )}
    </aside>
  )
}
