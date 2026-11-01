// The hidden render window (loaded with #render) draws one artboard at its own size, at the origin,
// so screenshots and computed styles do not depend on the user's zoom, scroll or page.
import { useEffect, useState } from 'react'

import type { DesignNode } from '../../shared/document'
import { NodeView } from '../canvas/NodeView'

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))

export function RenderView() {
  const [artboard, setArtboard] = useState<DesignNode | null>(null)
  const [painted, setPainted] = useState<(() => void) | null>(null)

  useEffect(
    () =>
      window.opendraw.handleMainRequest('render:show', (payload) => {
        const node = payload as DesignNode
        return new Promise<void>((resolve) => {
          setArtboard({ ...node, style: { ...node.style, left: '0px', top: '0px' } })
          setPainted(() => resolve)
        })
      }),
    []
  )

  // Resolve once the new tree is committed, fonts are loaded and two frames have painted.
  useEffect(() => {
    if (!painted) return
    void (async () => {
      await document.fonts.ready
      await nextFrame()
      await nextFrame()
      painted()
      setPainted(null)
    })()
  }, [painted, artboard])

  return <div className="render-root">{artboard && <NodeView node={artboard} />}</div>
}
