// OpenDraw's document model is CSS-native: every node is an element with a CSS style object.
// Artboards sit directly on a page; their `left` and `top` styles are their canvas position.

export type CSSStyle = Record<string, string | number>

/** A run of text in a text node, with the text styles that apply only to it. */
export interface TextSpan {
  text: string
  style?: CSSStyle
}

export interface DesignNode {
  id: string
  type: 'artboard' | 'frame' | 'text' | 'image' | 'svg'
  name: string
  style: CSSStyle
  children: DesignNode[]
  /** Text nodes: the plain text, always present. */
  text?: string
  /** Text nodes with formatting on part of the text: the runs, whose texts join to `text`. */
  spans?: TextSpan[]
  /** Image nodes: the image URL (http, https or a data: image). */
  src?: string
  /** SVG nodes: the sanitized <svg> markup, drawn to fill the node. */
  svg?: string
  /** Export settings (S-15): one file per entry when the layer is exported. */
  exports?: ExportSetting[]
}

export const EXPORT_FORMATS = ['png', 'jpg', 'webp', 'avif', 'svg', 'pdf'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

export interface ExportSetting {
  format: ExportFormat
  /** Paper's scale notation: 1x, 2x, 0.5x, 720p (height), 512w (width) or 512h (height). */
  scale: string
  /** JPG, WEBP and AVIF: 0-100. */
  quality?: number
}

/** Paper's page icons (S-12 Req 4); a page without one shows the default. */
export const PAGE_ICONS = [
  'arrow',
  'padlock',
  'check',
  'cross',
  'info',
  'question',
  'design',
  'vector',
  'images',
  'table',
  'presentation',
  'blueprint',
  'swatches',
  'bar-chart',
  'line-chart',
  'pie-chart',
  'paper'
] as const

export type PageIcon = (typeof PAGE_ICONS)[number]

export interface Page {
  id: string
  name: string
  icon?: PageIcon
  nodes: DesignNode[]
}

/** A separator in the page list. `index` is the number of pages above it. */
export interface PageDivider {
  id: string
  index: number
}

/** Paper's design token types (S-14). */
export const TOKEN_TYPES = [
  'breakpoint',
  'color',
  'container',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'letterSpacing',
  'lineHeight',
  'opacity',
  'radius',
  'spacing'
] as const

export type TokenType = (typeof TOKEN_TYPES)[number]

/** A design token: a typed CSS custom property that styles use with var(--name). */
export interface Token {
  name: string
  type: TokenType
  value: string
  description?: string
}

export interface DesignDocument {
  format: 'opendraw'
  version: 1
  id: string
  name: string
  pages: Page[]
  /** Dividers in the page list, in order. */
  dividers?: PageDivider[]
  /** Design tokens, in the order they were defined. */
  tokens?: Token[]
  /** Comment threads (S-16), oldest first. */
  comments?: CommentThread[]
}

/** The local user's ID: OpenDraw is single-user, and agents only read comments. */
export const LOCAL_USER_ID = 'local-user'

export interface CommentMessage {
  id: string
  authorId: string
  authorName: string
  text: string
  createdAt: string
  /** Emoji to the IDs of users who reacted with it. */
  reactions?: Record<string, string[]>
  deleted?: boolean
}

export interface CommentThread {
  id: string
  pageId: string
  /** The layer it is pinned to, with the pin's offset from the layer's top-left corner. */
  nodeId?: string
  /** World position of the pin: the offset from the layer when pinned to one, else a canvas point. */
  x: number
  y: number
  status: 'open' | 'resolved'
  createdAt: string
  updatedAt: string
  messages: CommentMessage[]
  deleted?: boolean
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
