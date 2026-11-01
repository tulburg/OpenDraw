// JSX output for get_jsx: inline styles, or Tailwind classes with inline styles for anything unmapped.
import type { CSSStyle, DesignNode } from '../document'

export interface JSXOptions {
  format: 'inline-styles' | 'tailwind'
  includeNodeIds: boolean
  includeRootPositioning: boolean
}

const ROOT_POSITIONING = ['position', 'top', 'left', 'right', 'bottom']
const INDENT = '  '

function escapeText(text: string): string {
  return text.replace(/[{}<>&]/g, (c) => `{${JSON.stringify(c)}}`)
}

function styleLiteral(style: CSSStyle): string {
  const entries = Object.entries(style).map(([key, value]) => {
    const name = /^[a-zA-Z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)
    return `${name}: ${typeof value === 'number' ? value : JSON.stringify(value)}`
  })
  return `{{ ${entries.join(', ')} }}`
}

// Tailwind classes for common properties, using arbitrary values so every value maps exactly.
const KEYWORD_CLASSES: Record<string, Record<string, string>> = {
  display: { flex: 'flex', block: 'block', none: 'hidden' },
  flexDirection: { row: 'flex-row', column: 'flex-col', 'row-reverse': 'flex-row-reverse', 'column-reverse': 'flex-col-reverse' },
  flexWrap: { wrap: 'flex-wrap', nowrap: 'flex-nowrap' },
  justifyContent: {
    'flex-start': 'justify-start', start: 'justify-start', center: 'justify-center', 'flex-end': 'justify-end',
    end: 'justify-end', 'space-between': 'justify-between', 'space-around': 'justify-around', 'space-evenly': 'justify-evenly'
  },
  alignItems: {
    'flex-start': 'items-start', start: 'items-start', center: 'items-center', 'flex-end': 'items-end', end: 'items-end',
    stretch: 'items-stretch', baseline: 'items-baseline'
  },
  position: { absolute: 'absolute', relative: 'relative' },
  textAlign: { left: 'text-left', center: 'text-center', right: 'text-right', justify: 'text-justify' },
  overflow: { hidden: 'overflow-hidden', visible: 'overflow-visible', auto: 'overflow-auto' }
}

const VALUE_PREFIXES: Record<string, string> = {
  width: 'w', height: 'h', minWidth: 'min-w', minHeight: 'min-h', maxWidth: 'max-w', maxHeight: 'max-h',
  gap: 'gap', rowGap: 'gap-y', columnGap: 'gap-x',
  padding: 'p', paddingTop: 'pt', paddingRight: 'pr', paddingBottom: 'pb', paddingLeft: 'pl',
  top: 'top', left: 'left', right: 'right', bottom: 'bottom',
  backgroundColor: 'bg', color: 'text', fontSize: 'text', fontWeight: 'font', lineHeight: 'leading',
  letterSpacing: 'tracking', borderRadius: 'rounded', opacity: 'opacity', flexGrow: 'grow', flexShrink: 'shrink'
}

/** Values that need a type hint in Tailwind's arbitrary syntax, since `text-[...]` covers color and size. */
const TYPE_HINTS: Record<string, string> = { color: 'color:', fontSize: 'length:', backgroundColor: 'color:' }

function tailwindClass(property: string, value: string | number): string | null {
  const keyword = KEYWORD_CLASSES[property]?.[String(value)]
  if (keyword) return keyword
  const prefix = VALUE_PREFIXES[property]
  if (!prefix) return null
  const text = String(value)
  if (/[\s_]/.test(text) && property !== 'padding') return null
  const arbitrary = text.replace(/\s+/g, '_')
  return `${prefix}-[${TYPE_HINTS[property] ?? ''}${arbitrary}]`
}

function splitTailwind(style: CSSStyle): { classes: string[]; rest: CSSStyle } {
  const classes: string[] = []
  const rest: CSSStyle = {}
  for (const [property, value] of Object.entries(style)) {
    const cls = tailwindClass(property, value)
    if (cls) classes.push(cls)
    else rest[property] = value
  }
  return { classes, rest }
}

/** Text runs as <span>s, with line breaks as <br />. */
function richText(node: DesignNode, options: JSXOptions): string {
  const lines = (text: string) => text.split('\n').map(escapeText).join('<br />')
  return (node.spans ?? [])
    .map((span) => {
      if (!span.style) return lines(span.text)
      let style = span.style
      const attributes: string[] = []
      if (options.format === 'tailwind') {
        const { classes, rest } = splitTailwind(style)
        if (classes.length > 0) attributes.push(`className=${JSON.stringify(classes.join(' '))}`)
        style = rest
      }
      if (Object.keys(style).length > 0) attributes.push(`style=${styleLiteral(style)}`)
      return `<span${attributes.map((a) => ` ${a}`).join('')}>${lines(span.text)}</span>`
    })
    .join('')
}

function tagFor(node: DesignNode): string {
  if (node.type === 'image') return 'img'
  return 'div'
}

function render(node: DesignNode, options: JSXOptions, depth: number, isRoot: boolean): string {
  const pad = INDENT.repeat(depth)
  let style: CSSStyle = { ...node.style }
  if (isRoot && !options.includeRootPositioning) for (const key of ROOT_POSITIONING) delete style[key]

  const attributes: string[] = []
  if (options.includeNodeIds) attributes.push(`id=${JSON.stringify(node.id)}`)
  attributes.push(`data-name=${JSON.stringify(node.name)}`)
  if (node.type === 'image' && node.src) attributes.push(`src=${JSON.stringify(node.src)}`)
  if (options.format === 'tailwind') {
    const { classes, rest } = splitTailwind(style)
    if (classes.length > 0) attributes.push(`className=${JSON.stringify(classes.join(' '))}`)
    style = rest
  }
  if (Object.keys(style).length > 0) attributes.push(`style=${styleLiteral(style)}`)

  const tag = tagFor(node)
  const open = `${pad}<${tag} ${attributes.join(' ')}`
  // SVG markup goes in as written; it is XML, which JSX accepts apart from attribute casing.
  const text =
    node.type === 'svg' ? (node.svg ?? '') : node.spans ? richText(node, options) : node.text ? escapeText(node.text) : ''
  if (node.children.length === 0 && !text) return `${open} />`
  if (node.children.length === 0 && !text.includes('\n')) return `${open}>${text}</${tag}>`
  const inner = [
    ...(text ? [`${pad}${INDENT}${text}`] : []),
    ...node.children.map((child) => render(child, options, depth + 1, false))
  ]
  return `${open}>\n${inner.join('\n')}\n${pad}</${tag}>`
}

export function toJSX(node: DesignNode, options: JSXOptions): string {
  return render(node, options, 0, true)
}
