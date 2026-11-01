// Which CSS a node accepts. OpenDraw follows Paper's rules: flex, padding and gap for layout,
// absolute positioning for decoration; no margins, grid, inline display or tables.
import type { CSSStyle, DesignNode } from '../../shared/document'

export type StyleUpdate = Record<string, string | number | null>

const ALLOWED_DISPLAY = new Set(['flex', 'block', 'none'])
const OFFSETS = new Set(['left', 'top', 'right', 'bottom'])

function kebab(property: string): string {
  return property.startsWith('--') ? property : property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
}

function isValid(property: string, value: string | number): boolean {
  if (property.startsWith('--')) return true
  if (typeof CSS === 'undefined' || !CSS.supports) return true
  // Unitless numbers are only valid CSS for a few properties; React adds px for the rest.
  const text = typeof value === 'number' ? String(value) : value
  return CSS.supports(kebab(property), text) || (typeof value === 'number' && CSS.supports(kebab(property), `${value}px`))
}

function inertReason(property: string, value: string | number, node: DesignNode, merged: CSSStyle): string | null {
  if (/^margin/.test(property)) return 'margin is not supported; use padding and gap'
  if (/^grid/.test(property)) return 'grid is not supported; use flex'
  if (property === 'display' && !ALLOWED_DISPLAY.has(String(value))) {
    return `display: ${value} is not supported; use flex`
  }
  if (OFFSETS.has(property) && node.type !== 'artboard' && merged.position !== 'absolute') {
    return `${property} only applies to artboards and absolutely positioned nodes`
  }
  if (!isValid(property, value)) return `${value} is not a valid value for ${property}`
  return null
}

/**
 * Merges `update` into the node's style. `null` removes a property. Properties that would have no
 * effect in this node's context are left out and returned in `ignored` with the reason.
 */
export function applyStyleUpdate(node: DesignNode, update: StyleUpdate) {
  const merged: CSSStyle = { ...node.style }
  for (const [property, value] of Object.entries(update)) {
    if (value === null) delete merged[property]
    else merged[property] = value
  }
  const ignored: Record<string, string> = {}
  for (const [property, value] of Object.entries(update)) {
    if (value === null) continue
    const reason = inertReason(property, value, node, merged)
    if (reason) {
      ignored[property] = reason
      if (property in node.style) merged[property] = node.style[property]
      else delete merged[property]
    }
  }
  return { style: merged, ignored }
}
