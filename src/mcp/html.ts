// HTML with inline CSS to design nodes, following Paper's rules (S-5 Req 2): flex, padding and gap
// for layout, absolute positioning for decoration, layer-name for layer names, <img>, <svg> and <pre>.
// Margins, grid, inline display and tables are dropped, and every drop is reported back.
import { type CSSStyle, type DesignNode, newId, type TextSpan } from '../../shared/document'
import { safeImageSrc, sanitizeSvg } from '../document/media'
import { normalizeSpans, plainText, spanStyle } from '../document/richtext'
import { applyStyleUpdate } from '../document/styles'
import { cloneWithNewIds } from '../document/tree'

/** An <x-paper-clone> that names a node that does not exist; the whole write fails (S-17 Req 3). */
export class CloneError extends Error {}

/** Finds the node an <x-paper-clone node-id> copies. */
export type CloneSource = (id: string) => DesignNode | null

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
  textarea: 'form controls are not supported; draw them with divs'
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

/**
 * The runs of text inside `el` as a browser shows them: whitespace collapsed across runs (unless
 * preserved), <br> as a line break, and each inline element's text styles on its run. Properties a
 * run cannot have go to `drop`.
 */
function runSpans(el: Element, preserve: boolean, drop: (line: string) => void): TextSpan[] {
  const spans: TextSpan[] = []
  const push = (text: string, style: CSSStyle) => {
    if (!preserve) {
      const before = spans.map((span) => span.text).join('')
      text = text.replace(/[ \t\r\n\f]+/g, ' ')
      if (text.startsWith(' ') && (before === '' || /[ \n]$/.test(before))) text = text.slice(1)
    }
    if (text) spans.push({ text, style })
  }
  const lineBreak = (style: CSSStyle) => {
    if (!preserve) {
      const last = spans[spans.length - 1]
      if (last) last.text = last.text.replace(/ +$/, '')
    }
    spans.push({ text: '\n', style })
  }
  const visit = (node: Node, style: CSSStyle) => {
    if (node.nodeType === Node.TEXT_NODE) return push(node.textContent ?? '', style)
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const element = node as Element
    if (element.localName === 'br') return lineBreak(style)
    const own: CSSStyle = spanStyle(TAG_DEFAULTS[element.localName] ?? {}).style
    const inline: CSSStyle = {}
    for (const [property, value] of parseStyleAttribute(element.getAttribute('style') ?? '')) {
      inline[camelProperty(property)] = value
    }
    const { style: kept, dropped } = spanStyle(inline)
    for (const [property, reason] of Object.entries(dropped)) drop(`${property} on ${describe(element)}: ${reason}`)
    const next = { ...style, ...own, ...kept }
    for (const child of element.childNodes) visit(child, next)
  }
  for (const child of el.childNodes) visit(child, {})
  if (preserve) {
    if (spans[0]?.text.startsWith('\n')) spans[0].text = spans[0].text.slice(1)
  } else {
    while (spans.length > 0 && !/\S/.test(spans[spans.length - 1].text) && spans[spans.length - 1].text !== '\n') spans.pop()
    const last = spans[spans.length - 1]
    if (last) last.text = last.text.replace(/[ \n]+$/, '')
  }
  return spans
}

/** A text node's `text`, plus `spans` when part of it is formatted. */
function richText(spans: TextSpan[]): Pick<DesignNode, 'text' | 'spans'> {
  const normalized = normalizeSpans(spans)
  return normalized ? { text: plainText(spans), spans: normalized } : { text: plainText(spans) }
}

class Converter {
  dropped: string[] = []

  constructor(private cloneSource?: CloneSource) {}

  /** A copy of an existing node with new IDs; style and layer-name on the tag override its root. */
  clone(el: Element): DesignNode {
    const id = el.getAttribute('node-id')?.trim() ?? ''
    const source = id ? this.cloneSource?.(id) : null
    if (!source) throw new CloneError(id ? `<x-paper-clone>: no node with ID ${id}` : '<x-paper-clone> needs a node-id attribute')
    const copy = cloneWithNewIds(source)
    if (copy.type === 'artboard') {
      // An artboard copied into a layer becomes a frame; its canvas position no longer applies.
      const { left: _l, top: _t, ...style } = copy.style
      copy.type = 'frame'
      copy.style = style
    }
    if (el.hasAttribute('style')) copy.style = this.style(el, copy.type, copy.style)
    const layerName = el.getAttribute('layer-name')
    if (layerName) copy.name = truncate(layerName)
    return copy
  }

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
    if (tag === 'x-paper-clone') return this.clone(el)

    if (tag === 'img') {
      const style = this.sizeFromAttributes(el, this.style(el, 'image'))
      const src = el.getAttribute('src') ?? ''
      const safe = safeImageSrc(src)
      if (src && !safe) this.dropped.push(`src on ${describe(el)}: only http, https, paper-asset and data: image URLs are supported`)
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
      const content = richText(runSpans(el, true, (line) => this.dropped.push(line)))
      const name = layerName ?? content.text?.split('\n')[0] ?? 'Code'
      return { id: newId(), type: 'text', name: truncate(name), style, children: [], ...content }
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
   * on part of the text becomes spans.
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
    const content = richText(runSpans(inner, false, (line) => this.dropped.push(line)))
    const text = content.text ?? ''
    if (text.includes('\n') && !style.whiteSpace) style = { ...style, whiteSpace: 'pre-line' }
    const name = el.getAttribute('layer-name') ?? text.split('\n')[0]
    return { id: newId(), type: 'text', name: truncate(name), style, children: [], ...content }
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

export function parseHTML(html: string, cloneSource?: CloneSource): ParsedHTML {
  // HTML has no self-closing custom elements; <x-paper-clone /> would swallow its siblings.
  const source = html.replace(/<x-paper-clone\b([^>]*?)\/>/gi, '<x-paper-clone$1></x-paper-clone>')
  const doc = new DOMParser().parseFromString(`<body>${source}</body>`, 'text/html')
  const converter = new Converter(cloneSource)
  const nodes = converter.children(doc.body)
  return { nodes, dropped: converter.dropped }
}

/**
 * Text for set_text_content: whitespace kept as written (pre-wrap, as Paper parses it), <br> as a
 * line break, inline formatting as spans. `dropped` lists run properties that were left out.
 */
export function parseInlineText(html: string): { text: string; spans: TextSpan[]; dropped: string[] } {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const dropped: string[] = []
  const spans = runSpans(doc.body, true, (line) => dropped.push(line))
  return { text: plainText(spans), spans, dropped }
}

/** The part of clipboard HTML that was copied: between the fragment markers browsers add, or the body. */
export function pastedFragment(html: string): string {
  const marked = html.match(/<!--StartFragment-->([\s\S]*)<!--EndFragment-->/)
  return marked ? marked[1] : new DOMParser().parseFromString(html, 'text/html').body.innerHTML
}

/** Formatted runs from pasted HTML, laid out as a browser shows it (whitespace collapsed). */
export function parsePastedText(html: string): TextSpan[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return runSpans(doc.body, false, () => {})
}
