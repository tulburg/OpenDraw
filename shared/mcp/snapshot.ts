import type { DesignDocument, DesignNode, Page } from '../document'

/** A node's measured box, in canvas (world) coordinates and relative to its parent. */
export interface Layout {
  worldX: number
  worldY: number
  x: number
  y: number
  width: number
  height: number
}

/** What the read tools work from: the open document, what the user sees, and measured layout. */
export interface Snapshot {
  filePath: string
  document: DesignDocument
  /** The page the user is viewing. */
  pageId: string
  selection: string[]
  /** Measured layout for nodes on the page in view; nodes on other pages are not measured. */
  layout: Record<string, Layout>
}

export class ToolError extends Error {}

export interface Located {
  node: DesignNode
  page: Page
  parent: DesignNode | null
  /** The top-level artboard that holds the node (the node itself for an artboard). */
  artboard: DesignNode
}

export function locateNode(document: DesignDocument, id: string): Located | null {
  for (const page of document.pages) {
    for (const artboard of page.nodes) {
      const stack: { node: DesignNode; parent: DesignNode | null }[] = [{ node: artboard, parent: null }]
      while (stack.length > 0) {
        const { node, parent } = stack.pop()!
        if (node.id === id) return { node, page, parent, artboard }
        for (const child of node.children) stack.push({ node: child, parent: node })
      }
    }
  }
  return null
}

export function requireNode(snapshot: Snapshot, id: string): Located {
  const found = locateNode(snapshot.document, id)
  if (!found) throw new ToolError(`No node with ID ${id}`)
  return found
}

export function requirePage(snapshot: Snapshot, pageId: string | undefined): Page {
  const id = pageId ?? snapshot.pageId
  const page = snapshot.document.pages.find((p) => p.id === id)
  if (!page) throw new ToolError(`No page with ID ${id}`)
  return page
}

export function requireFile(snapshot: Snapshot, fileId: string | undefined) {
  if (fileId !== undefined && fileId !== snapshot.document.id) {
    throw new ToolError(`No open file with ID ${fileId}. The open file is ${snapshot.document.id}.`)
  }
}

export function walk(nodes: DesignNode[], visit: (node: DesignNode, depth: number) => void, depth = 0) {
  for (const node of nodes) {
    visit(node, depth)
    walk(node.children, visit, depth + 1)
  }
}

const TYPE_NAMES: Record<DesignNode['type'], string> = {
  artboard: 'Artboard',
  frame: 'Frame',
  text: 'Text',
  image: 'Image',
  svg: 'SVG'
}

export function typeName(node: DesignNode): string {
  return TYPE_NAMES[node.type]
}

/** Layout fields for a node, null when it was not measured (its page is not in view). */
export function layoutOf(snapshot: Snapshot, id: string): Layout | Record<keyof Layout, null> {
  return (
    snapshot.layout[id] ?? { worldX: null, worldY: null, x: null, y: null, width: null, height: null }
  )
}
