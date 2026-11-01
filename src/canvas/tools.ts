// Drawing tools (S-9): what each tool creates, written as plain CSS on the new layer.
import { type CSSStyle, type DesignNode, newId } from '../../shared/document'
import { sanitizeSvg } from '../document/media'
import type { DocumentStore } from '../document/store'
import { findNode } from '../document/tree'

export type Tool = 'select' | 'hand' | 'artboard' | 'frame' | 'text' | 'image'

export const TOOLS: { tool: Tool; name: string; key: string }[] = [
  { tool: 'select', name: 'Select', key: 'V' },
  { tool: 'hand', name: 'Hand', key: 'H' },
  { tool: 'artboard', name: 'Artboard', key: 'A' },
  { tool: 'frame', name: 'Frame', key: 'F' },
  { tool: 'text', name: 'Text', key: 'T' },
  { tool: 'image', name: 'Image', key: 'I' }
]

export const TOOL_BY_KEY: Record<string, Tool> = Object.fromEntries(TOOLS.map((t) => [t.key.toLowerCase(), t.tool]))

export const DEFAULT_ARTBOARD = { width: 1440, height: 900 }
export const DEFAULT_FRAME = { width: 100, height: 100 }
const FRAME_FILL = '#e5e5e5'

const px = (value: number) => `${Math.round(value)}px`

/** Where a drawn layer goes: a container (frame or artboard) and the box in its padding-box units. */
export interface Placement {
  /** The container's ID, or null for the page (artboards). */
  parentId: string | null
  /** Lays its children out with flexbox, so the new layer is appended as a flex child. */
  flex: boolean
  box: { left: number; top: number; width: number; height: number }
  /** A click without a drag: the tool's default size applies. */
  clicked: boolean
}

/** The deepest frame or artboard on a path of node IDs (outermost first). */
export function containerOn(path: string[], nodes: DesignNode[]): string | null {
  for (let i = path.length - 1; i >= 0; i--) {
    const type = findNode(nodes, path[i])?.type
    if (type === 'frame' || type === 'artboard') return path[i]
  }
  return null
}

/** The style for a layer placed at `placement`, positioned unless its container is a flex box. */
function placedStyle(placement: Placement, size: { width?: number; height?: number }): CSSStyle {
  const style: CSSStyle = {}
  if (!placement.flex) Object.assign(style, { position: 'absolute', left: px(placement.box.left), top: px(placement.box.top) })
  if (size.width !== undefined) style.width = px(size.width)
  if (size.height !== undefined) style.height = px(size.height)
  return style
}

/**
 * Inserts `node` at `placement` as one undo step and selects it. A positioned layer needs a
 * positioned container, so a static frame becomes `position: relative`.
 */
function insert(store: DocumentStore, placement: Placement, node: DesignNode): string {
  store.transact(`Add ${node.name}`, (tx) => {
    if (placement.parentId === null) tx.insertNodes(store.getState().pageId, undefined, [node])
    else {
      const parent = tx.node(placement.parentId)
      if (!placement.flex && parent.type === 'frame' && !parent.style.position) {
        tx.updateStyles([parent.id], { position: 'relative' })
      }
      tx.insertNodes(placement.parentId, undefined, [node])
    }
    tx.select([node.id])
  })
  return node.id
}

export function drawArtboard(store: DocumentStore, placement: Placement): string {
  const { left, top } = placement.box
  const { width, height } = placement.clicked ? DEFAULT_ARTBOARD : placement.box
  return insert(store, placement, {
    id: newId(),
    type: 'artboard',
    name: 'Artboard',
    style: { left: px(left), top: px(top), width: px(width), height: px(height), backgroundColor: '#ffffff' },
    children: []
  })
}

export function drawFrame(store: DocumentStore, placement: Placement): string {
  const size = placement.clicked ? DEFAULT_FRAME : placement.box
  return insert(store, placement, {
    id: newId(),
    type: 'frame',
    name: 'Frame',
    style: { ...placedStyle(placement, size), backgroundColor: FRAME_FILL },
    children: []
  })
}

/** An empty text layer, auto-width on a click or fixed-width on a drag. Editing starts right after. */
export function drawText(store: DocumentStore, placement: Placement): string {
  const size = placement.clicked ? {} : { width: placement.box.width }
  return insert(store, placement, { id: newId(), type: 'text', name: 'Text', text: '', style: placedStyle(placement, size), children: [] })
}

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|svg\+xml)$/

export function isPlaceableImage(file: File): boolean {
  return IMAGE_TYPES.test(file.type)
}

function readFile(file: File, as: 'text' | 'dataURL'): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    if (as === 'text') reader.readAsText(file)
    else reader.readAsDataURL(file)
  })
}

function naturalSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth || DEFAULT_FRAME.width, height: image.naturalHeight || DEFAULT_FRAME.height })
    image.onerror = () => reject(new Error('The image could not be read'))
    image.src = src
  })
}

/** An SVG's size from its width and height attributes, or its viewBox. */
function svgSize(markup: string): { width: number; height: number } {
  const svg = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement
  const number = (value: string | null) => (value && /^\d+(\.\d+)?(px)?$/.test(value.trim()) ? Number.parseFloat(value) : null)
  const viewBox = svg.getAttribute('viewBox')?.split(/[\s,]+/).map(Number)
  const width = number(svg.getAttribute('width')) ?? viewBox?.[2] ?? DEFAULT_FRAME.width
  const height = number(svg.getAttribute('height')) ?? viewBox?.[3] ?? DEFAULT_FRAME.height
  return { width, height }
}

/**
 * Places an image file at its natural size, scaled down to fit the container. SVG files become SVG
 * layers. On empty canvas the image gets an artboard of its own size.
 */
export async function placeImage(
  store: DocumentStore,
  file: File,
  placement: Placement,
  containerSize: { width: number; height: number } | null
): Promise<string> {
  const isSvg = file.type === 'image/svg+xml'
  const svg = isSvg ? sanitizeSvg(await readFile(file, 'text')) : ''
  const src = isSvg ? '' : await readFile(file, 'dataURL')
  let size = isSvg ? svgSize(svg) : await naturalSize(src)
  if (containerSize) {
    const room = { width: containerSize.width - (placement.flex ? 0 : placement.box.left), height: containerSize.height - (placement.flex ? 0 : placement.box.top) }
    const scale = Math.min(1, room.width / size.width, room.height / size.height)
    if (scale > 0 && scale < 1) size = { width: size.width * scale, height: size.height * scale }
  }
  const name = file.name.replace(/\.[^.]+$/, '') || (isSvg ? 'SVG' : 'Image')
  const layer: DesignNode = isSvg
    ? { id: newId(), type: 'svg', name, style: {}, children: [], svg }
    : { id: newId(), type: 'image', name, style: {}, children: [], src }
  if (placement.parentId === null) {
    layer.style = { width: px(size.width), height: px(size.height) }
    const artboard: DesignNode = {
      id: newId(),
      type: 'artboard',
      name,
      style: { left: px(placement.box.left), top: px(placement.box.top), width: px(size.width), height: px(size.height), backgroundColor: '#ffffff' },
      children: [layer]
    }
    insert(store, placement, artboard)
    store.select([layer.id])
    return layer.id
  }
  layer.style = placedStyle(placement, size)
  return insert(store, placement, layer)
}
