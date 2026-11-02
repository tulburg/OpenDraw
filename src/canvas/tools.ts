// Parts copied from doop (https://github.com/kgoedecke/doop), Copyright (c) Kevin Goedecke and
// contributors. Licensed under the GNU Affero General Public License v3.0; see LICENSE-AGPL.
// Drawing tools (S-9): what each tool creates, written as plain CSS on the new layer.
import { type CSSStyle, type DesignNode, holdsLayers, newId } from '../../shared/document'
import { sanitizeSvg } from '../document/media'
import type { DocumentStore } from '../document/store'
import { findNode } from '../document/tree'

export type Tool = 'select' | 'hand' | 'artboard' | 'frame' | 'rectangle' | 'circle' | 'text' | 'image' | 'comment'

export const TOOLS: { tool: Tool; name: string; key: string }[] = [
  { tool: 'select', name: 'Select', key: 'V' },
  { tool: 'hand', name: 'Hand', key: 'H' },
  { tool: 'artboard', name: 'Artboard', key: 'A' },
  { tool: 'frame', name: 'Frame', key: 'F' },
  { tool: 'rectangle', name: 'Rectangle', key: 'R' },
  { tool: 'circle', name: 'Circle', key: 'O' },
  { tool: 'text', name: 'Text', key: 'T' },
  { tool: 'image', name: 'Image', key: 'I' },
  { tool: 'comment', name: 'Comment', key: 'C' }
]

export const TOOL_BY_KEY: Record<string, Tool> = Object.fromEntries(TOOLS.map((t) => [t.key.toLowerCase(), t.tool]))

export const DEFAULT_ARTBOARD = { width: 1440, height: 900 }
export const DEFAULT_FRAME = { width: 100, height: 100 }
const FRAME_FILL = '#e5e5e5'
/** Doop's shape fill and click size (src/lib/drawing.ts). */
const SHAPE_FILL = '#d9d9d9'
export const DEFAULT_SHAPE = { width: 120, height: 120 }

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

/** The deepest frame or artboard on a path of node IDs (outermost first); shapes are skipped. */
export function containerOn(path: string[], nodes: DesignNode[]): string | null {
  for (let i = path.length - 1; i >= 0; i--) {
    if (holdsLayers(findNode(nodes, path[i]))) return path[i]
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

/**
 * A rectangle or circle (S-35 Req 1): a frame with doop's fill, positioned where it was drawn. On empty
 * canvas it is an artboard of its own, as doop draws a standalone element.
 */
export function drawShape(store: DocumentStore, placement: Placement, shape: 'rectangle' | 'circle'): string {
  const size = placement.clicked ? DEFAULT_SHAPE : placement.box
  const look: CSSStyle = { backgroundColor: SHAPE_FILL, ...(shape === 'circle' ? { borderRadius: '50%' } : {}) }
  const name = shape === 'circle' ? 'Circle' : 'Rectangle'
  if (placement.parentId === null) {
    const { left, top } = placement.box
    return insert(store, placement, { id: newId(), type: 'artboard', name, style: { left: px(left), top: px(top), width: px(size.width), height: px(size.height), ...look }, children: [] })
  }
  return insert(store, placement, { id: newId(), type: 'frame', name, shape, style: { ...placedStyle(placement, size), ...look }, children: [] })
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
/** Replaces an image layer's picture with `file`; an SVG file becomes an SVG data URL in the image. */
export async function replaceImage(store: DocumentStore, id: string, file: File) {
  const src = file.type === 'image/svg+xml' ? `data:image/svg+xml,${encodeURIComponent(sanitizeSvg(await readFile(file, 'text')))}` : await readFile(file, 'dataURL')
  store.transact('Replace image', (tx) => tx.setImageSource(id, src))
}

export async function placeImage(
  store: DocumentStore,
  file: File,
  placement: Placement,
  containerSize: { width: number; height: number } | null,
  /** Pasting: fit the whole container and move the image back inside it, rather than fit the room past the point. */
  keepInside = false
): Promise<string> {
  const isSvg = file.type === 'image/svg+xml'
  const svg = isSvg ? sanitizeSvg(await readFile(file, 'text')) : ''
  const src = isSvg ? '' : await readFile(file, 'dataURL')
  let size = isSvg ? svgSize(svg) : await naturalSize(src)
  if (containerSize) {
    const from = placement.flex || keepInside ? { left: 0, top: 0 } : placement.box
    const room = { width: containerSize.width - from.left, height: containerSize.height - from.top }
    const scale = Math.min(1, room.width / size.width, room.height / size.height)
    if (scale > 0 && scale < 1) size = { width: size.width * scale, height: size.height * scale }
    if (keepInside) {
      const left = Math.max(0, Math.min(placement.box.left, containerSize.width - size.width))
      const top = Math.max(0, Math.min(placement.box.top, containerSize.height - size.height))
      placement = { ...placement, box: { ...placement.box, left, top } }
    }
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

/**
 * Adds layers pasted from another app (S-23) at `placement` as one undo step and selects them. In a
 * container that is not a flex box, layers without a position of their own are placed at the point.
 */
export function placeLayers(store: DocumentStore, placement: Placement & { parentId: string }, layers: DesignNode[]): string[] {
  store.transact('Paste', (tx) => {
    const parent = tx.node(placement.parentId)
    if (!placement.flex) {
      if (parent.type === 'frame' && !parent.style.position) tx.updateStyles([parent.id], { position: 'relative' })
      for (const layer of layers) {
        if (!layer.style.position) layer.style = { ...layer.style, position: 'absolute', left: px(placement.box.left), top: px(placement.box.top) }
      }
    }
    tx.insertNodes(placement.parentId, undefined, layers)
    tx.select(layers.map((l) => l.id))
  })
  return layers.map((l) => l.id)
}

/** A text layer holding pasted plain text. */
export function textLayer(text: string): DesignNode {
  return { id: newId(), type: 'text', name: text.trim().slice(0, 40) || 'Text', text, style: {}, children: [] }
}
