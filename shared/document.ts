// OpenDraw's document model is CSS-native: every node is an element with a CSS style object.
// Artboards sit directly on a page; their `left` and `top` styles are their canvas position.

export type CSSStyle = Record<string, string | number>

export interface DesignNode {
  id: string
  type: 'artboard' | 'frame' | 'text' | 'image' | 'svg'
  name: string
  style: CSSStyle
  children: DesignNode[]
  text?: string
  /** Image nodes: the image URL (http, https or a data: image). */
  src?: string
  /** SVG nodes: the sanitized <svg> markup, drawn to fill the node. */
  svg?: string
}

export interface Page {
  id: string
  name: string
  nodes: DesignNode[]
}

export interface DesignDocument {
  format: 'opendraw'
  version: 1
  id: string
  name: string
  pages: Page[]
}

export interface Viewport {
  x: number
  y: number
  zoom: number
}

/** What the renderer gets when it asks for the document to show. */
export interface OpenedDocument {
  path: string
  document: DesignDocument
  /** The viewport saved for this file, or null when it has never been shown (fit to content). */
  viewport: Viewport | null
  pageId: string
}

export const DOCUMENT_EXTENSION = '.opendraw'

export function newId(): string {
  return crypto.randomUUID()
}

export function createFirstDocument(): DesignDocument {
  return {
    format: 'opendraw',
    version: 1,
    id: newId(),
    name: 'Untitled',
    pages: [
      {
        id: newId(),
        name: 'Page 1',
        nodes: [
          {
            id: newId(),
            type: 'artboard',
            name: 'Desktop',
            style: {
              left: '0px',
              top: '0px',
              width: '1440px',
              height: '900px',
              backgroundColor: '#ffffff',
              display: 'flex',
              flexDirection: 'column'
            },
            children: []
          }
        ]
      }
    ]
  }
}
