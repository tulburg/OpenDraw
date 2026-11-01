import { type CSSProperties, useMemo } from 'react'

import type { DesignNode } from '../../shared/document'
import { safeImageSrc, sanitizeSvg } from '../document/media'

/** Renders a node as a real DOM element with its stored CSS. */
export function NodeView({ node }: { node: DesignNode }) {
  const style: CSSProperties = { boxSizing: 'border-box', ...(node.style as CSSProperties) }
  if (node.type === 'artboard') {
    style.position = 'absolute'
    style.overflow ??= 'hidden'
  }
  if (node.type === 'image') return <ImageNode node={node} style={style} />
  if (node.type === 'svg') return <SvgNode node={node} style={style} />
  return (
    <div data-node-id={node.id} data-node-type={node.type} style={style}>
      {node.text}
      {node.children.map((child) => (
        <NodeView key={child.id} node={child} />
      ))}
    </div>
  )
}

function ImageNode({ node, style }: { node: DesignNode; style: CSSProperties }) {
  const src = safeImageSrc(node.src)
  if (!src) return <div data-node-id={node.id} data-node-type="image" style={style} />
  return <img data-node-id={node.id} data-node-type="image" src={src} alt="" draggable={false} style={style} />
}

// Files on disk can be edited by hand, so the markup is sanitized again before it is drawn.
function SvgNode({ node, style }: { node: DesignNode; style: CSSProperties }) {
  const markup = useMemo(() => (node.svg ? sanitizeSvg(node.svg) : ''), [node.svg])
  return (
    <div data-node-id={node.id} data-node-type="svg" style={style} dangerouslySetInnerHTML={{ __html: markup }} />
  )
}
