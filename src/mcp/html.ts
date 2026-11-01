// HTML with inline CSS to design nodes, following Paper's rules (S-5 Req 2): flex, padding and gap
// for layout, absolute positioning for decoration, layer-name for layer names, <img>, <svg> and <pre>.
// Margins, grid, inline display and tables are dropped, and every drop is reported back.
import { type CSSStyle, type DesignNode, newId } from '../../shared/document'
import { safeImageSrc, sanitizeSvg } from '../document/media'
import { applyStyleUpdate } from '../document/styles'

export interface ParsedHTML {
  nodes: DesignNode[]
  /** One line per element or property that was left out, with the reason. */
  dropped: string[]
}

/** Elements whose content reads as one run of text. */
const INLINE_TAGS = new Set([
  'span', 'b', 'strong', 'i', 'em', 'u', 's', 'a', 'br', 'code', 'small', 'sub', 'sup', 'label', 'mark',
  'abbr', 'time', 'q', 'cite', 'del', 'ins', 'kbd'
])

const DROPPED_TAGS: Record<string, string> = {
  table: 'tables are not supported; use flex rows and columns',
  thead: 'tables are not supported; use flex rows and columns',
  tbody: 'tables are not supported; use flex rows and columns',
  tr: 'tables are not supported; use flex rows and columns',
  td: 'tables are not supported; use flex rows and columns',
  th: 'tables are not supported; use flex rows and columns',
  script: 'scripts are not supported',
  style: 'style elements are not supported; use inline styles',
  link: 'stylesheets are not supported; use inline styles',
  meta: 'not part of a design',
  title: 'not part of a design',
  iframe: 'embedded pages are not supported',
  object: 'embedded content is not supported',
  embed: 'embedded content is not supported',
  video: 'video is not supported',
  audio: 'audio is not supported',
  canvas: 'canvas elements are not supported',
  input: 'form controls are not supported; draw them with divs',
  select: 'form controls are not supported; draw them with divs',
  textarea: 'form controls are not supported; draw them with divs',
  'x-paper-clone': 'the clone tag is not supported yet; use duplicate_nodes'
}

/** What a plain browser would show for these tags, so the design matches the HTML as written. */
const TAG_DEFAULTS: Record<string, CSSStyle> = {
  h1: { fontSize: '2em', fontWeight: 'bold' },
  h2: { fontSize: '1.5em', fontWeight: 'bold' },
  h3: { fontSize: '1.17em', fontWeight: 'bold' },
  h4: { fontWeight: 'bold' },
  h5: { fontSize: '0.83em', fontWeight: 'bold' },
  h6: { fontSize: '0.67em', fontWeight: 'bold' },
  b: { fontWeight: 'bold' },
  strong: { fontWeight: 'bold' },
  th: { fontWeight: 'bold' },
  i: { fontStyle: 'italic' },
  em: { fontStyle: 'italic' },
  cite: { fontStyle: 'italic' },
  u: { textDecoration: 'underline' },
  ins: { textDecoration: 'underline' },
  s: { textDecoration: 'line-through' },
  del: { textDecoration: 'line-through' },
  a: { color: '#0000ee', textDecoration: 'underline' },
  code: { fontFamily: 'monospace' },
  kbd: { fontFamily: 'monospace' },
  pre: { fontFamily: 'monospace', whiteSpace: 'pre' },
  small: { fontSize: 'smaller' },
  mark: { backgroundColor: 'yellow', color: 'black' }
}

const TAG_NAMES: Record<string, string> = { div: 'Frame', img: 'Image', svg: 'SVG', a: 'Link', p: 'Paragraph' }

const MAX_NAME = 50

/** Splits a style attribute into declarations, keeping semicolons inside url(...) and quotes. */
export function parseStyleAttribute(css: string): [string, string][] {
  const declarations: [string, string][] = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let i = 0; i <= css.length; i++) {
    const c = css[i]
    if (quote) {
      if (c === quote && css[i - 1] !== '\\') quote = ''
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '(') depth++
    else if (c === ')') depth--
    else if (i === css.length || (c === ';' && depth === 0)) {
      const declaration = css.slice(start, i)
      start = i + 1
      const colon = declaration.indexOf(':')
      if (colon === -1) continue
      const property = declaration.slice(0, colon).trim()
      const value = declaration
        .slice(colon + 1)
        .trim()
        .replace(/\s*!important$/i, '')
      if (property && value) declarations.push([property, value])
    }
  }
  return declarations
}

/** kebab-case CSS property to the camelCase key React uses (custom properties stay as written). */
export function camelProperty(property: string): string {
  if (property.startsWith('--')) return property
  const lower = property.toLowerCase()
  const vendor = lower.match(/^-(webkit|moz|ms)-(.*)$/)
  const camel = (text: string) => text.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
  if (vendor) return camel(`${vendor[1][0].toUpperCase()}${vendor[1].slice(1)}-${vendor[2]}`)
  return camel(lower)
}

function describe(el: Element): string {
  const name = el.getAttribute('layer-name')
  return `<${el.localName}${name ? ` "${name}"` : ''}>`
}

function truncate(text: string): string {
  return text.length > MAX_NAME ? `${text.slice(0, MAX_NAME - 1)}…` : text
}

function hasText(el: Element): boolean {
  return (el.textContent ?? '').trim().length > 0 || el.querySelector('br') !== null
}

/** True when everything inside `el` is text or inline formatting, so it becomes one text node. */
function isTextRun(el: Element): boolean {
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) continue
    if (child.nodeType !== Node.ELEMENT_NODE) continue
    const element = child as Element
    if (!INLINE_TAGS.has(element.localName) || !isTextRun(element)) return false
  }
  return hasText(el)
}

function isFlexContainer(el: Element): boolean {
  return parseStyleAttribute(el.getAttribute('style') ?? '').some(
    ([property, value]) => property.trim().toLowerCase() === 'display' && value.trim() === 'flex'
  )
}

/** Text as a browser shows it: whitespace collapsed (unless preserved), <br> as a line break. */
function runText(el: Element, preserve: boolean): string {
  let text = ''
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? ''
    else if ((node as Element).localName === 'br') text += '\n'
    else for (const child of node.childNodes) visit(child)
  }
  visit(el)
  if (preserve) return text.replace(/^\n/, '')
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t\r\f]+/g, ' '))
    .join('\n')
    .replace(/ *\n */g, '\n')
    .trim()
}

class Converter {
  dropped: string[] = []

  /** The element's tag defaults, then its inline style, with inert properties dropped and reported. */
  style(el: Element, type: DesignNode['type'], base: CSSStyle = {}): CSSStyle {
    const update: CSSStyle = { ...(TAG_DEFAULTS[el.localName] ?? {}) }
    for (const [property, value] of parseStyleAttribute(el.getAttribute('style') ?? '')) {
      update[camelProperty(property)] = value
    }
    const node: DesignNode = { id: '', type, name: '', style: base, children: [] }
    const { style, ignored } = applyStyleUpdate(node, update)
    for (const [property, reason] of Object.entries(ignored)) {
      this.dropped.push(`${property} on ${describe(el)}: ${reason}`)
    }
    return style
  }

  /** Converts the children of `parent`, wrapping loose text in text nodes. */
  children(parent: Element): DesignNode[] {
    const nodes: DesignNode[] = []
    for (const child of parent.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = (child.textContent ?? '').replace(/\s+/g, ' ').trim()
        if (text) nodes.push({ id: newId(), type: 'text', name: truncate(text), style: {}, children: [], text })
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const node = this.element(child as Element)
        if (node) nodes.push(node)
      }
    }
    return nodes
  }

  element(el: Element): DesignNode | null {
    const tag = el.localName
    const layerName = el.getAttribute('layer-name')
    if (tag in DROPPED_TAGS) {
      this.dropped.push(`${describe(el)}: ${DROPPED_TAGS[tag]}`)
      return null
    }

    if (tag === 'img') {
      const style = this.sizeFromAttributes(el, this.style(el, 'image'))
      const src = el.getAttribute('src') ?? ''
      const safe = safeImageSrc(src)
      if (src && !safe) this.dropped.push(`src on ${describe(el)}: only http, https and data: image URLs are supported`)
      const name = layerName ?? el.getAttribute('alt') ?? 'Image'
      return { id: newId(), type: 'image', name: truncate(name), style, children: [], ...(safe ? { src: safe } : {}) }
    }

    if (tag === 'svg') {
      const style = this.sizeFromAttributes(el, this.style(el, 'svg'))
      const copy = el.cloneNode(true) as Element
      copy.removeAttribute('style')
      copy.removeAttribute('layer-name')
      const svg = sanitizeSvg(new XMLSerializer().serializeToString(copy))
      if (!svg) this.dropped.push(`${describe(el)}: the SVG could not be read`)
      return { id: newId(), type: 'svg', name: truncate(layerName ?? 'SVG'), style, children: [], svg }
    }

    if (tag === 'pre') {
      const style = this.style(el, 'text')
      const text = runText(el, true)
      return { id: newId(), type: 'text', name: truncate(layerName ?? text.split('\n')[0] ?? 'Code'), style, children: [], text }
    }

    // A flex container lays its children out as separate items, even when they are all text.
    if (!isFlexContainer(el) && isTextRun(el)) return this.textNode(el)

    const style = this.style(el, 'frame')
    const name = layerName ?? TAG_NAMES[tag] ?? `${tag[0].toUpperCase()}${tag.slice(1)}`
    return { id: newId(), type: 'frame', name: truncate(name), style, children: this.children(el) }
  }

  /**
   * One text node for an element holding a run of text. When the text sits in a single inline child
   * (a <span> or <a> inside a <button>, say), that child's styles apply to the whole node; formatting
   * on part of the text is flattened and reported, since rich text is not supported yet.
   */
  textNode(el: Element): DesignNode {
    let style = this.style(el, 'text')
    let inner = el
    for (;;) {
      const elements = [...inner.children]
      const loose = [...inner.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim())
      if (elements.length !== 1 || loose || elements[0].localName === 'br') break
      inner = elements[0]
      style = { ...style, ...this.style(inner, 'text', style) }
    }
    const formatted = inner.querySelector(':scope *:not(br)')
    if (formatted) {
      this.dropped.push(`formatting inside ${describe(el)}: rich text is not supported yet; the text was kept as plain text`)
    }
    const text = runText(inner, false)
    if (text.includes('\n') && !style.whiteSpace) style = { ...style, whiteSpace: 'pre-line' }
    const name = el.getAttribute('layer-name') ?? text.split('\n')[0]
    return { id: newId(), type: 'text', name: truncate(name), style, children: [], text }
  }

  /** width and height attributes on <img> and <svg> become styles unless the style sets them. */
  sizeFromAttributes(el: Element, style: CSSStyle): CSSStyle {
    const next = { ...style }
    for (const dimension of ['width', 'height'] as const) {
      const value = el.getAttribute(dimension)
      if (value && !(dimension in next) && /^\d+(\.\d+)?(px)?$/.test(value.trim())) {
        next[dimension] = `${Number.parseFloat(value)}px`
      }
    }
    return next
  }
}

export function parseHTML(html: string): ParsedHTML {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const converter = new Converter()
  const nodes = converter.children(doc.body)
  return { nodes, dropped: converter.dropped }
}

/**
 * Text for set_text_content: whitespace kept as written (pre-wrap, as Paper parses it), <br> as a
 * line break, inline formatting flattened.
 */
export function parseInlineText(html: string): { text: string; flattened: boolean } {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const flattened = doc.body.querySelector('*:not(br)') !== null
  return { text: runText(doc.body, true), flattened }
}
