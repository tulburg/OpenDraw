// Turning what the user types in the styles panel into CSS values, and CSS values into what fields show.
import type { CSSStyle, DesignNode } from '../../shared/document'
import { camelProperty, parseStyleAttribute } from '../mcp/html'

export const MIXED = Symbol('mixed')
export type Shared = string | typeof MIXED

/** Properties whose plain numbers stay unitless; every other number gets px. */
const UNITLESS = new Set(['opacity', 'zIndex', 'fontWeight', 'flexGrow', 'flexShrink', 'flex', 'order'])
/** Properties whose plain numbers are angles. */
const DEGREES = new Set(['rotate'])

const defaultUnit = (property: string) => (UNITLESS.has(property) ? '' : DEGREES.has(property) ? 'deg' : 'px')

/** The value the selected layers share for `property`, '' if none set it, or MIXED. */
export function sharedValue(nodes: DesignNode[], property: string): Shared {
  const values = new Set(nodes.map((node) => String(node.style[property] ?? '')))
  return values.size === 1 ? [...values][0] : MIXED
}

/** Evaluates + - * / and parentheses over numbers. Returns null if `expr` is anything else. */
function evaluate(expr: string): number | null {
  const tokens = expr.match(/\d*\.?\d+|[-+*/()]/g)
  if (!tokens || tokens.join('') !== expr.replace(/\s+/g, '')) return null
  let i = 0
  const primary = (): number => {
    const token = tokens[i++]
    if (token === '(') {
      const value = sum()
      if (tokens[i++] !== ')') throw new Error('unbalanced')
      return value
    }
    if (token === '-') return -primary()
    if (token === '+') return primary()
    const value = Number(token)
    if (Number.isNaN(value)) throw new Error('not a number')
    return value
  }
  const product = (): number => {
    let value = primary()
    while (tokens[i] === '*' || tokens[i] === '/') value = tokens[i++] === '*' ? value * primary() : value / primary()
    return value
  }
  const sum = (): number => {
    let value = product()
    while (tokens[i] === '+' || tokens[i] === '-') value = tokens[i++] === '+' ? value + product() : value - product()
    return value
  }
  try {
    const value = sum()
    return i === tokens.length && Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000

/**
 * Reads a number field: `16` is 16px (or 16 for unitless properties), `1.5em` keeps its unit and
 * `24 * 2` is worked out. Anything that is not arithmetic (`auto`, `fit-content`, `calc(...)`) is
 * kept as typed. Returns null for an empty field.
 */
export function parseNumberInput(property: string, input: string): string | number | null {
  const text = input.trim()
  if (!text) return null
  const unit = text.match(/(px|rem|em|%|vw|vh|deg|ms|s|fr)\b/)?.[1] ?? ''
  const value = evaluate(text.replace(/(px|rem|em|%|vw|vh|deg|ms|s|fr)\b/g, ''))
  if (value === null) return text
  if (unit) return `${round(value)}${unit}`
  return UNITLESS.has(property) ? round(value) : `${round(value)}${defaultUnit(property)}`
}

/** Steps a number value by `delta`, keeping its unit. Returns null if the value is not a plain number. */
export function stepValue(property: string, value: string, delta: number): string | number | null {
  const match = value.trim().match(/^(-?\d*\.?\d+)([a-z%]*)$/i)
  if (!match && value.trim() !== '') return null
  const number = match ? Number(match[1]) : 0
  const unit = match ? match[2] : ''
  const next = round(number + delta)
  if (unit) return `${next}${unit}`
  return UNITLESS.has(property) ? next : `${next}${defaultUnit(property)}`
}

export interface RGBA {
  r: number
  g: number
  b: number
  a: number
}

let probe: CanvasRenderingContext2D | null = null

/** Any CSS color to RGBA, using the browser's own parser. Null if it is not a color. */
export function parseColor(value: string): RGBA | null {
  if (!value || !CSS.supports('color', value)) return null
  probe ??= document.createElement('canvas').getContext('2d')
  if (!probe) return null
  probe.fillStyle = '#000000'
  probe.fillStyle = value
  const normalized = String(probe.fillStyle)
  if (normalized.startsWith('#')) {
    return {
      r: Number.parseInt(normalized.slice(1, 3), 16),
      g: Number.parseInt(normalized.slice(3, 5), 16),
      b: Number.parseInt(normalized.slice(5, 7), 16),
      a: 1
    }
  }
  const parts = normalized.match(/[\d.]+/g)?.map(Number)
  if (!parts || parts.length < 3) return null
  return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 }
}

const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, '0')

export type ColorFormat = 'hex' | 'rgb' | 'hsl'

export function formatColor({ r, g, b, a }: RGBA, format: ColorFormat): string {
  const alpha = Math.round(a * 100) / 100
  if (format === 'hex') return `#${hex2(r)}${hex2(g)}${hex2(b)}${alpha < 1 ? hex2(alpha * 255) : ''}`
  if (format === 'rgb') return alpha < 1 ? `rgba(${r}, ${g}, ${b}, ${alpha})` : `rgb(${r}, ${g}, ${b})`
  const [rn, gn, bn] = [r / 255, g / 255, b / 255]
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  const d = max - min
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  let h = 0
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6
    else if (max === gn) h = (bn - rn) / d + 2
    else h = (rn - gn) / d + 4
    h = Math.round(h * 60)
    if (h < 0) h += 360
  }
  const body = `${h}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%`
  return alpha < 1 ? `hsla(${body}, ${alpha})` : `hsl(${body})`
}

// Edits replace only the artboards they change, so scans of the whole page are kept per artboard and
// only changed artboards are scanned again (S-21).
const colorsByArtboard = new WeakMap<DesignNode, Map<string, number>>()
const fontsByArtboard = new WeakMap<DesignNode, string[]>()

/** Colors used anywhere in the document, most used first, as hex. */
export function documentColors(nodes: DesignNode[], limit = 16): string[] {
  const counts = new Map<string, number>()
  for (const artboard of nodes) {
    let own = colorsByArtboard.get(artboard)
    if (!own) {
      const found = new Map<string, number>()
      const visit = (node: DesignNode) => {
        for (const [property, value] of Object.entries(node.style)) {
          if (!/color$/i.test(property)) continue
          const rgba = parseColor(String(value))
          if (!rgba) continue
          const hex = formatColor(rgba, 'hex')
          found.set(hex, (found.get(hex) ?? 0) + 1)
        }
        node.children.forEach(visit)
      }
      visit(artboard)
      colorsByArtboard.set(artboard, (own = found))
    }
    for (const [hex, n] of own) counts.set(hex, (counts.get(hex) ?? 0) + n)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([hex]) => hex)
}

/** Font families used in the document, by first family name. */
export function documentFonts(nodes: DesignNode[]): string[] {
  const fonts = new Set<string>()
  for (const artboard of nodes) {
    let own = fontsByArtboard.get(artboard)
    if (!own) {
      const found = new Set<string>()
      const visit = (node: DesignNode) => {
        const family = node.style.fontFamily
        if (family) found.add(String(family).split(',')[0].trim().replace(/^["']|["']$/g, ''))
        node.children.forEach(visit)
      }
      visit(artboard)
      fontsByArtboard.set(artboard, (own = [...found]))
    }
    for (const font of own) fonts.add(font)
  }
  return [...fonts]
}

/** Splits a comma-separated list (box-shadow, font-family) at top-level commas. */
export function splitList(value: string): string[] {
  const items: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i <= value.length; i++) {
    const c = value[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (i === value.length || (c === ',' && depth === 0)) {
      const item = value.slice(start, i).trim()
      if (item) items.push(item)
      start = i + 1
    }
  }
  return items
}

/** kebab-case for the raw CSS view. */
export function kebab(property: string): string {
  return property.startsWith('--') ? property : property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
}

/** Raw CSS text (`prop: value;` lines) to a style object with camelCase keys. */
export function parseRawCSS(text: string): CSSStyle {
  const style: CSSStyle = {}
  for (const [property, value] of parseStyleAttribute(text.replace(/\n/g, ';'))) style[camelProperty(property)] = value
  return style
}

export function rawCSS(style: CSSStyle): string {
  return Object.entries(style)
    .map(([property, value]) => `${kebab(property)}: ${value};`)
    .join('\n')
}
