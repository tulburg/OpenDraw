// The hidden render window (loaded with #render) draws one artboard at its own size, at the origin,
// so screenshots and computed styles do not depend on the user's zoom, scroll or page. Exports
// (S-15) use it too: one layer shown alone, encoded, serialized to SVG, or printed to PDF pages.
import { useEffect, useLayoutEffect, useState } from 'react'

import type { DesignNode } from '../../shared/document'
import { familiesIn } from '../../shared/fonts'
import { NodeView } from '../canvas/NodeView'
import { ensureFonts } from '../fonts/loader'

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))

const TARGET = 'data-export-target'

interface PrintItem {
  artboard: DesignNode
  nodeId: string
}

/** Where each print item's layer sits in its artboard, once measured. */
interface PrintBox {
  x: number
  y: number
  width: number
  height: number
}

const atOrigin = (node: DesignNode): DesignNode => ({ ...node, style: { ...node.style, left: '0px', top: '0px' } })

function nodeElement(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`)
  if (!el) throw new Error(`No node ${id} in the render window`)
  return el
}

/** Marks the layer to export; CSS hides everything else, ancestors' backgrounds included. */
function isolate(id: string | null) {
  for (const el of document.querySelectorAll(`[${TARGET}]`)) el.removeAttribute(TARGET)
  document.documentElement.toggleAttribute('data-isolate', id !== null)
  if (id) nodeElement(id).setAttribute(TARGET, '')
}

// Properties a layer inherits from its parents, carried onto the SVG wrapper so text looks the same.
const INHERITED = [
  'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align',
  'text-transform', 'white-space', 'word-spacing', 'direction', 'visibility'
]

/** The layer as an SVG document: its HTML in a foreignObject, so text stays text. */
function toSVG(id: string): string {
  const el = nodeElement(id)
  const box = el.getBoundingClientRect()
  const width = Math.ceil(box.width)
  const height = Math.ceil(box.height)
  const parent = el.parentElement ? getComputedStyle(el.parentElement) : null
  const artboard = el.closest<HTMLElement>('[data-node-type="artboard"]')
  const wrapper = document.createElement('div')
  wrapper.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml')
  // Tokens are custom properties on the artboard; copy them so var() still resolves.
  if (artboard) {
    for (let i = 0; i < artboard.style.length; i++) {
      const name = artboard.style[i]
      if (name.startsWith('--')) wrapper.style.setProperty(name, artboard.style.getPropertyValue(name))
    }
  }
  if (parent) for (const p of INHERITED) wrapper.style.setProperty(p, parent.getPropertyValue(p))
  wrapper.style.width = `${width}px`
  wrapper.style.height = `${height}px`
  const copy = el.cloneNode(true) as HTMLElement
  copy.removeAttribute(TARGET)
  for (const p of ['position', 'left', 'top', 'right', 'bottom']) copy.style.removeProperty(p)
  wrapper.appendChild(copy)
  const html = new XMLSerializer().serializeToString(wrapper)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><foreignObject x="0" y="0" width="${width}" height="${height}">${html}</foreignObject></svg>`
}

/** Re-encodes a PNG as JPG or WEBP; JPG gets a white background, since it has no transparency. */
async function encode(png: string, type: string, quality: number): Promise<string> {
  const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob())
  const canvas = new OffscreenCanvas(image.width, image.height)
  const ctx = canvas.getContext('2d')!
  if (type === 'image/jpeg') {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, image.width, image.height)
  }
  ctx.drawImage(image, 0, 0)
  const blob = await canvas.convertToBlob({ type, quality: quality / 100 })
  if (blob.type !== type) throw new Error(`This build cannot encode ${type}`)
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

export function RenderView() {
  const [artboard, setArtboard] = useState<DesignNode | null>(null)
  const [print, setPrint] = useState<{ items: PrintItem[]; boxes: PrintBox[] | null } | null>(null)
  const [painted, setPainted] = useState<(() => void) | null>(null)

  useEffect(() => {
    const offs = [
      window.opendraw.handleMainRequest('render:show', (payload) => {
        const node = payload as DesignNode
        return ensureFonts(familiesIn(node)).then(() => new Promise<void>((resolve) => {
          isolate(null)
          setPrint(null)
          setArtboard(atOrigin(node))
          setPainted(() => resolve)
        }))
      }),
      window.opendraw.handleMainRequest('render:isolate', async (payload) => {
        const { nodeId } = payload as { nodeId: string | null }
        isolate(nodeId)
        await nextFrame()
        await nextFrame()
        if (!nodeId) return null
        const r = nodeElement(nodeId).getBoundingClientRect()
        return { x: r.left, y: r.top, width: r.width, height: r.height }
      }),
      window.opendraw.handleMainRequest('render:svg', (payload) => toSVG((payload as { nodeId: string }).nodeId)),
      window.opendraw.handleMainRequest('render:encode', (payload) => {
        const { png, type, quality } = payload as { png: string; type: string; quality: number }
        return encode(png, type, quality)
      }),
      // Lays out one PDF page per item, each the size of its layer (S-15 Req 4 and 6).
      window.opendraw.handleMainRequest('render:print', (payload) => {
        const items = (payload as { items: PrintItem[] }).items
        return ensureFonts(familiesIn(items.map((i) => i.artboard))).then(() => new Promise<void>((resolve) => {
          isolate(null)
          setArtboard(null)
          setPrint({ items: items.map((i) => ({ ...i, artboard: atOrigin(i.artboard) })), boxes: null })
          setPainted(() => resolve)
        }))
      })
    ]
    return () => offs.forEach((off) => off())
  }, [])

  // Print pages are measured once drawn, then each artboard is shifted so its layer starts the page.
  useLayoutEffect(() => {
    if (!print || print.boxes) return
    const boxes = print.items.map((item, index) => {
      const page = document.querySelector<HTMLElement>(`[data-print-page="${index}"]`)!
      const origin = page.getBoundingClientRect()
      const r = page.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(item.nodeId)}"]`)!.getBoundingClientRect()
      return { x: r.left - origin.left, y: r.top - origin.top, width: r.width, height: r.height }
    })
    setPrint({ ...print, boxes })
  }, [print])

  // Resolve once the new tree is committed (and measured, for print), fonts and images are loaded and two frames have painted.
  useEffect(() => {
    if (!painted || (print && !print.boxes)) return
    void (async () => {
      await document.fonts.ready
      // Images load after the tree commits; a failed one just stays empty.
      await Promise.all([...document.querySelectorAll<HTMLImageElement>('.render-root img')].map((img) => img.decode().catch(() => {})))
      await nextFrame()
      await nextFrame()
      painted()
      setPainted(null)
    })()
  }, [painted, artboard, print])

  if (print) {
    const sizes = print.boxes
    return (
      <div className="render-root print-root">
        {sizes && (
          <style>
            {sizes.map((b, i) => `@page p${i} { size: ${b.width}px ${b.height}px; margin: 0 }`).join('\n')}
          </style>
        )}
        {print.items.map((item, i) => {
          const box = sizes?.[i]
          return (
            <div
              key={i}
              className="print-page"
              data-print-page={i}
              style={box ? ({ width: box.width, height: box.height, page: `p${i}` } as React.CSSProperties) : undefined}
            >
              <div className="print-shift" style={box ? { transform: `translate(${-box.x}px, ${-box.y}px)` } : undefined}>
                <PrintTarget item={item} index={i} />
              </div>
            </div>
          )
        })}
      </div>
    )
  }
  return <div className="render-root">{artboard && <NodeView node={artboard} />}</div>
}

/** One print page's artboard, with only its layer visible. */
function PrintTarget({ item, index }: { item: PrintItem; index: number }) {
  useLayoutEffect(() => {
    const page = document.querySelector(`[data-print-page="${index}"]`)
    page?.querySelector(`[data-node-id="${CSS.escape(item.nodeId)}"]`)?.setAttribute(TARGET, '')
    document.documentElement.setAttribute('data-isolate', '')
  }, [item, index])
  return <NodeView node={item.artboard} />
}
