// Layers as HTML with inline styles (S-18 Req 7, Copy as HTML), in the form write_html reads back.
import type { CSSStyle, DesignNode } from './document'

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const kebab = (key: string) => (key.startsWith('--') ? key : key.replace(/^(Webkit|Moz|Ms)/, (v) => `-${v.toLowerCase()}`).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`))

export function styleAttribute(style: CSSStyle | undefined): string {
  const entries = Object.entries(style ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '')
  return entries.map(([k, v]) => `${kebab(k)}: ${v}`).join('; ')
}

const attrs = (node: DesignNode, style: CSSStyle) => {
  const css = styleAttribute(style)
  return ` layer-name="${escape(node.name)}"${css ? ` style="${escape(css)}"` : ''}`
}

const textHTML = (text: string) => escape(text).replace(/\n/g, '<br>')

/** One node and its descendants; `includePosition` false leaves out an artboard's canvas position. */
export function toHTML(node: DesignNode, indent = '', includePosition = false): string {
  let style = node.style
  if (node.type === 'artboard' && !includePosition) {
    const { left: _l, top: _t, ...rest } = style
    style = rest
  }
  if (node.type === 'image') return `${indent}<img${attrs(node, style)} src="${escape(node.src ?? '')}" />`
  if (node.type === 'svg') return `${indent}<div${attrs(node, style)}>${(node.svg ?? '').replace(/ style="display: block"/, '')}</div>`
  if (node.type === 'text') {
    const inner = node.spans
      ? node.spans.map((s) => (s.style && Object.keys(s.style).length ? `<span style="${escape(styleAttribute(s.style))}">${textHTML(s.text)}</span>` : textHTML(s.text))).join('')
      : textHTML(node.text ?? '')
    return `${indent}<div${attrs(node, style)}>${inner}</div>`
  }
  if (node.children.length === 0) return `${indent}<div${attrs(node, style)}></div>`
  const children = node.children.map((c) => toHTML(c, `${indent}  `, true)).join('\n')
  return `${indent}<div${attrs(node, style)}>\n${children}\n${indent}</div>`
}
