// Rich text in text nodes (S-8): a text node keeps its plain `text`, plus `spans` when part of the
// text has its own formatting. Spans carry only the text styles Paper allows on text runs.
import type { CSSStyle, TextSpan } from '../../shared/document'

const SPAN_PROPERTIES = new Set([
  'color',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'letterSpacing',
  'lineHeight',
  'textTransform',
  'textDecoration',
  'textDecorationLine',
  'textDecorationColor',
  'textDecorationStyle',
  'WebkitTextStroke',
  'WebkitTextStrokeWidth',
  'WebkitTextStrokeColor'
])
/** Backgrounds on a run only fill the text itself, so they need background-clip: text. */
const CLIPPED_BACKGROUNDS = new Set(['backgroundColor', 'backgroundImage', 'background'])
const CLIP_PROPERTIES = new Set(['backgroundClip', 'WebkitBackgroundClip'])

export function isSpanProperty(property: string): boolean {
  return SPAN_PROPERTIES.has(property) || CLIPPED_BACKGROUNDS.has(property) || CLIP_PROPERTIES.has(property)
}

/** Keeps the properties a text run may have. Returns the rest with the reason, for reporting. */
export function spanStyle(style: CSSStyle): { style: CSSStyle; dropped: Record<string, string> } {
  const clipped = [...CLIP_PROPERTIES].some((p) => String(style[p] ?? '') === 'text')
  const kept: CSSStyle = {}
  const dropped: Record<string, string> = {}
  for (const [property, value] of Object.entries(style)) {
    if (SPAN_PROPERTIES.has(property)) kept[property] = value
    else if (CLIPPED_BACKGROUNDS.has(property) || CLIP_PROPERTIES.has(property)) {
      if (clipped) kept[property] = value
      else dropped[property] = 'backgrounds on part of a text need background-clip: text'
    } else dropped[property] = 'not supported on part of a text; style the whole text layer instead'
  }
  return { style: kept, dropped }
}

const sameStyle = (a: CSSStyle = {}, b: CSSStyle = {}) => {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

/**
 * Merges neighbouring runs with the same style and drops empty ones. Returns undefined when the
 * text has no formatting left, so plain text layers stay plain.
 */
export function normalizeSpans(spans: TextSpan[]): TextSpan[] | undefined {
  const merged: TextSpan[] = []
  for (const span of spans) {
    if (!span.text) continue
    const style = span.style && Object.keys(span.style).length > 0 ? span.style : undefined
    const last = merged[merged.length - 1]
    if (last && sameStyle(last.style, style)) last.text += span.text
    else merged.push(style ? { text: span.text, style } : { text: span.text })
  }
  return merged.some((span) => span.style) ? merged : undefined
}

export function plainText(spans: TextSpan[]): string {
  return spans.map((span) => span.text).join('')
}

/** Removes `properties` from every run, so a style set on the whole layer reaches all of its text. */
export function clearFromSpans(spans: TextSpan[], properties: string[]): TextSpan[] | undefined {
  return normalizeSpans(
    spans.map((span) => {
      if (!span.style) return span
      const style = { ...span.style }
      for (const property of properties) delete style[property]
      return { text: span.text, style }
    })
  )
}
