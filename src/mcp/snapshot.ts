// Builds what the MCP read tools work from: the store's state plus layout measured on the live canvas.
import type { Layout, Snapshot } from '../../shared/mcp/snapshot'
import type { DocumentStore } from '../document/store'

const round = (n: number) => Math.round(n * 100) / 100

/** Measures every node rendered on the canvas, in world coordinates (independent of zoom and pan). */
function measureCanvas(): Record<string, Layout> {
  const world = document.querySelector<HTMLElement>('.canvas-world')
  if (!world) return {}
  const zoom = Number(world.dataset.zoom) || 1
  const origin = world.getBoundingClientRect()
  const layout: Record<string, Layout> = {}
  for (const el of world.querySelectorAll<HTMLElement>('[data-node-id]')) {
    const box = el.getBoundingClientRect()
    const worldX = (box.left - origin.left) / zoom
    const worldY = (box.top - origin.top) / zoom
    const parentId = el.parentElement?.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId
    const parent = parentId ? layout[parentId] : undefined
    layout[el.dataset.nodeId!] = {
      worldX: round(worldX),
      worldY: round(worldY),
      x: round(parent ? worldX - parent.worldX : worldX),
      y: round(parent ? worldY - parent.worldY : worldY),
      width: round(box.width / zoom),
      height: round(box.height / zoom)
    }
  }
  return layout
}

export function buildSnapshot(store: DocumentStore, filePath: string): Snapshot {
  const { document, pageId, selection } = store.getState()
  return { filePath, document, pageId, selection, layout: measureCanvas() }
}
