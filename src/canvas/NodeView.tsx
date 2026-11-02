import { createContext, type CSSProperties, memo, useContext, useMemo } from 'react'

import type { CSSStyle, DesignNode } from '../../shared/document'
import { safeImageSrc, sanitizeSvg } from '../document/media'
import { usePreview } from './preview'
import { EditingContext, TextEditor } from './TextEditor'

/** The file's design tokens as custom properties, set on every artboard (S-14 Req 2). */
export const TokensContext = createContext<CSSStyle>({})

const CORNERS = ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'] as const

/**
 * Writes border-radius as its four corners. React sets and clears style properties one by one, so a
 * shorthand next to corners being cleared (a corner-radius drag ending) can wipe the shorthand's
 * corners on screen. A value with a slash (elliptical corners) is left as it is.
 */
function cornerRadii(style: CSSProperties): CSSProperties {
  const shorthand = style.borderRadius
  const out = Object.fromEntries(Object.entries(style).filter(([, value]) => value !== undefined)) as CSSProperties
  if (shorthand === undefined || String(shorthand).includes('/')) return out
  const v = String(shorthand).trim().split(/\s+/)
  // CSS order: top-left, top-right, bottom-right, bottom-left, with missing values copied across.
  const values = [v[0], v[1] ?? v[0], v[2] ?? v[0], v[3] ?? v[1] ?? v[0]]
  delete out.borderRadius
  CORNERS.forEach((corner, i) => {
    if (out[corner] === undefined) (out as Record<string, unknown>)[corner] = typeof shorthand === 'number' ? shorthand : values[i]
  })
  return out
}

/**
 * Renders a node as a real DOM element with its stored CSS. Memoized: edits replace only the nodes on
 * the changed path, so panning and zooming re-render nothing below the world (S-21).
 */
export const NodeView = memo(function NodeView({ node }: { node: DesignNode }) {
  const preview = usePreview(node.id)
  const editing = useContext(EditingContext)
  const tokens = useContext(TokensContext)
  const style = cornerRadii({ boxSizing: 'border-box', ...(node.style as CSSProperties), ...(preview as CSSProperties) })
  if (node.type === 'artboard') {
    for (const [name, value] of Object.entries(tokens)) if (!(name in style)) (style as CSSStyle)[name] = value
    style.position = 'absolute'
    style.overflow ??= 'hidden'
  }
  if (node.type === 'image') return <ImageNode node={node} style={style} />
  if (node.type === 'svg') return <SvgNode node={node} style={style} />
  if (node.type === 'text' && editing.id === node.id) return <TextEditor node={node} style={style} editing={editing} />
  return (
    <div data-node-id={node.id} data-node-type={node.type} data-locked={node.locked || undefined} style={style}>
      {node.spans ? <Spans node={node} /> : node.text}
      {node.children.map((child) => (
        <NodeView key={child.id} node={child} />
      ))}
    </div>
  )
})

/** Formatted runs of a text node. Line breaks are newlines, laid out by the node's white-space. */
export function Spans({ node }: { node: DesignNode }) {
  return (
    <>
      {node.spans?.map((span, i) =>
        span.style ? (
          <span key={i} style={span.style as CSSProperties}>
            {span.text}
          </span>
        ) : (
          span.text
        )
      )}
    </>
  )
}

function ImageNode({ node, style }: { node: DesignNode; style: CSSProperties }) {
  const src = safeImageSrc(node.src)
  if (!src) return <div data-node-id={node.id} data-node-type="image" data-locked={node.locked || undefined} style={style} />
  return <img data-node-id={node.id} data-node-type="image" data-locked={node.locked || undefined} src={src} alt="" draggable={false} style={style} />
}

// Files on disk can be edited by hand, so the markup is sanitized again before it is drawn.
function SvgNode({ node, style }: { node: DesignNode; style: CSSProperties }) {
  const markup = useMemo(() => (node.svg ? sanitizeSvg(node.svg) : ''), [node.svg])
  return (
    <div data-node-id={node.id} data-node-type="svg" data-locked={node.locked || undefined} style={style} dangerouslySetInnerHTML={{ __html: markup }} />
  )
}
