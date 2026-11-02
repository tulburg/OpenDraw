// Design tokens (S-14): typed CSS custom properties. Styles keep `var(--name)` as written; the
// canvas sets every token on each artboard, so references resolve like plain CSS.
import type { CSSStyle, DesignDocument, DesignNode, Token, TokenType } from './document'

export const MAX_DESCRIPTION = 1024

const NAME = /^--[A-Za-z0-9_-]+$/
const ALIAS = /^var\(\s*(--[A-Za-z0-9_-]+)\s*\)$/
const PX = /^-?\d+(\.\d+)?px$/
const NUMBER = /^-?\d+(\.\d+)?$/

const SIZE_TYPES = new Set<TokenType>(['spacing', 'radius', 'fontSize', 'container', 'breakpoint'])

function isColor(value: string): boolean {
  if (typeof CSS !== 'undefined' && CSS.supports) return CSS.supports('color', value)
  // Outside a browser (tests of shared code), accept the common notations.
  return /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\(.+\)|[a-z]+)$/i.test(value)
}

/** Checks a token name. Returns an error message, or null. */
export function nameError(name: string): string | null {
  return NAME.test(name) ? null : `${name} is not a CSS custom property name like --color-primary`
}

/**
 * Checks and normalizes a value for its type: colors are CSS colors, sizes px strings, fontWeight a
 * number, opacity 0-1 or a percent. `var(--other)` aliases another token of any value.
 */
export function normalizeValue(type: TokenType, raw: unknown, tokens: Token[]): { value: string } | { error: string } {
  if (typeof raw !== 'string' && typeof raw !== 'number') return { error: 'value must be a string or a number' }
  const value = String(raw).trim()
  const alias = value.match(ALIAS)
  if (alias) {
    return tokens.some((t) => t.name === alias[1]) ? { value: `var(${alias[1]})` } : { error: `${alias[1]} is not a token in this file` }
  }
  switch (type) {
    case 'color':
      return isColor(value) ? { value } : { error: `${value} is not a CSS color` }
    case 'fontWeight':
      return NUMBER.test(value) && Number(value) >= 1 && Number(value) <= 1000 ? { value } : { error: `${value} is not a font weight (1-1000)` }
    case 'opacity': {
      if (NUMBER.test(value) && Number(value) >= 0 && Number(value) <= 1) return { value }
      const percent = value.match(/^(\d+(\.\d+)?)%$/)
      return percent && Number(percent[1]) <= 100 ? { value } : { error: `${value} is not an opacity (0-1 or a percent)` }
    }
    case 'lineHeight':
    case 'letterSpacing':
      return NUMBER.test(value) || PX.test(value) || /^-?\d+(\.\d+)?(em|%)$/.test(value) ? { value } : { error: `${value} is not a ${type} (a number, px, em or %)` }
    case 'fontFamily':
      return value ? { value } : { error: 'fontFamily needs a value' }
    default:
      if (SIZE_TYPES.has(type)) return PX.test(value) ? { value } : { error: `${value} is not a px size like 8px` }
      return { error: `Unknown token type ${type}` }
  }
}

/** The custom properties for every token, to set on an artboard. */
export function tokenStyle(tokens: Token[] | undefined): CSSStyle {
  const style: CSSStyle = {}
  for (const token of tokens ?? []) style[token.name] = token.value
  return style
}

/** The token a value refers to when it is exactly `var(--name)`. */
export function tokenRef(value: string | number | undefined): string | null {
  return typeof value === 'string' ? (value.trim().match(ALIAS)?.[1] ?? null) : null
}

const refPattern = (name: string) => new RegExp(`var\\(\\s*${name.replace(/[-]/g, '\\-')}(?=\\s*[,)])`, 'g')

/** `value` with var() references to `from` pointing at `to`. */
export function renameRefs(value: string, from: string, to: string): string {
  return value.replace(refPattern(from), `var(${to}`)
}

function walk(nodes: DesignNode[], visit: (node: DesignNode) => void) {
  for (const node of nodes) {
    visit(node)
    walk(node.children, visit)
  }
}

/** Every node style and token that refers to `name`. */
export function tokenUsages(doc: DesignDocument, name: string): { nodes: string[]; tokens: string[] } {
  const pattern = refPattern(name)
  const uses = (v: unknown) => typeof v === 'string' && v.search(pattern) !== -1
  const nodes: string[] = []
  for (const page of doc.pages) walk(page.nodes, (n) => Object.values(n.style).some(uses) && nodes.push(n.id))
  const tokens = (doc.tokens ?? []).filter((t) => t.name !== name && uses(t.value)).map((t) => t.name)
  return { nodes, tokens }
}

/** Case-insensitive glob over full names, `*` matching anything. */
export function matchesPattern(name: string, pattern: string): boolean {
  const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i')
  return re.test(name)
}

export function tokensAsCss(tokens: Token[]): string {
  const lines = tokens.map((t) => `  ${t.name}: ${t.value};${t.description ? ` /* ${t.description.replace(/\*\//g, '* /')} */` : ''}`)
  return `:root {\n${lines.join('\n')}\n}`
}

// Tailwind v4 theme namespaces per token type.
const TAILWIND_NAMESPACE: Record<TokenType, string> = {
  color: 'color',
  spacing: 'spacing',
  radius: 'radius',
  fontFamily: 'font',
  fontSize: 'text',
  fontWeight: 'font-weight',
  letterSpacing: 'tracking',
  lineHeight: 'leading',
  breakpoint: 'breakpoint',
  container: 'container',
  opacity: 'opacity'
}

/** A token's name in Tailwind's namespace: --color-primary stays, --brand becomes --color-brand. */
function tailwindName(token: Token): string {
  const ns = TAILWIND_NAMESPACE[token.type]
  const bare = token.name.slice(2)
  return bare.startsWith(`${ns}-`) ? token.name : `--${ns}-${bare}`
}

export function tokensAsTailwind(tokens: Token[]): string {
  const names = new Map(tokens.map((t) => [t.name, tailwindName(t)]))
  const lines = tokens.map((t) => {
    const value = t.value.replace(/var\(\s*(--[A-Za-z0-9_-]+)/g, (m, ref: string) => (names.has(ref) ? `var(${names.get(ref)}` : m))
    return `  ${names.get(t.name)}: ${value};`
  })
  return `@theme {\n${lines.join('\n')}\n}`
}

export interface CreateEntry {
  type: TokenType
  name: string
  value: unknown
  description?: string
}

export type TokenResult = { name: string; result: string; message?: string; [key: string]: unknown }

const describe = (description: unknown): { description?: string } | { error: string } => {
  if (description === undefined || description === '') return {}
  if (typeof description !== 'string') return { error: 'description must be a string' }
  return description.length > MAX_DESCRIPTION ? { error: `description is longer than ${MAX_DESCRIPTION} characters` } : { description }
}

/** Adds tokens in order; each entry succeeds or fails on its own. */
export function createTokens(tokens: Token[], entries: CreateEntry[], types: readonly TokenType[]): { tokens: Token[]; results: TokenResult[] } {
  let next = [...tokens]
  const results = entries.map((entry): TokenResult => {
    const name = String(entry?.name ?? '')
    const fail = (message: string): TokenResult => ({ name, result: 'error', message })
    const badName = nameError(name)
    if (badName) return fail(badName)
    if (!types.includes(entry.type)) return fail(`type must be one of ${types.join(', ')}`)
    const value = normalizeValue(entry.type, entry.value, next)
    if ('error' in value) return fail(value.error)
    if (tokenRef(value.value) === name) return fail('a token cannot alias itself')
    const desc = describe(entry.description)
    if ('error' in desc) return fail(desc.error)
    next = [...next, { name, type: entry.type, value: value.value, ...desc }]
    return { name, result: 'created' }
  })
  return { tokens: next, results }
}

export interface SetEntry {
  name: string
  newName?: string
  value?: unknown
  description?: string
  delete?: boolean
}

/** Whether following aliases from `name` comes back to it. */
function cycles(tokens: Token[], name: string): boolean {
  const seen = new Set<string>()
  for (let at: string | null = name; at; ) {
    if (seen.has(at)) return true
    seen.add(at)
    at = tokenRef(tokens.find((t) => t.name === at)?.value)
  }
  return false
}

/**
 * Renames, updates or deletes tokens, in order, each entry on its own. A rename rewrites var()
 * references in node styles and other tokens. Deleting a token still in use is allowed and the
 * result lists its users.
 */
export function setTokens(doc: DesignDocument, entries: SetEntry[]): { document: DesignDocument; results: TokenResult[] } {
  let next = doc
  const results = entries.map((entry): TokenResult => {
    const name = String(entry?.name ?? '')
    const fail = (message: string): TokenResult => ({ name, result: 'error', message })
    const tokens = next.tokens ?? []
    const index = tokens.findIndex((t) => t.name === name)
    if (index === -1) return fail(`No token named ${name}`)
    if (entry.delete) {
      const usedBy = tokenUsages(next, name)
      next = { ...next, tokens: tokens.filter((_, i) => i !== index) }
      const inUse = usedBy.nodes.length + usedBy.tokens.length > 0
      return {
        name,
        result: 'deleted',
        ...(inUse ? { stillReferencedBy: usedBy, message: 'The token was deleted; these styles and tokens still refer to it.' } : {})
      }
    }
    let token = { ...tokens[index] }
    if (entry.value !== undefined) {
      const value = normalizeValue(token.type, entry.value, tokens)
      if ('error' in value) return fail(value.error)
      token.value = value.value
    }
    if (entry.description !== undefined) {
      const desc = describe(entry.description)
      if ('error' in desc) return fail(desc.error)
      const { description: _, ...rest } = token
      token = { ...rest, ...desc }
    }
    let updated = tokens.map((t, i) => (i === index ? token : t))
    if (cycles(updated, name)) return fail('this value would make aliases refer back to themselves')
    let document: DesignDocument = { ...next, tokens: updated }
    if (entry.newName !== undefined && entry.newName !== name) {
      const bad = nameError(entry.newName)
      if (bad) return fail(bad)
      if (updated.some((t) => t.name === entry.newName)) return fail(`A token named ${entry.newName} already exists`)
      const to = entry.newName
      updated = updated.map((t) => ({ ...t, name: t.name === name ? to : t.name, value: renameRefs(t.value, name, to) }))
      const rewrite = (nodes: DesignNode[]): DesignNode[] =>
        nodes.map((n) => {
          let style = n.style
          for (const [k, v] of Object.entries(n.style)) {
            if (typeof v !== 'string') continue
            const renamed = renameRefs(v, name, to)
            if (renamed !== v) style = { ...style, [k]: renamed }
          }
          const children = rewrite(n.children)
          return style === n.style && children.every((c, i) => c === n.children[i]) ? n : { ...n, style, children }
        })
      document = { ...document, tokens: updated, pages: document.pages.map((p) => ({ ...p, nodes: rewrite(p.nodes) })) }
      token = updated[index]
    }
    next = document
    return { name, result: 'updated', ...(token.name !== name ? { newName: token.name } : {}), value: token.value }
  })
  return { document: next, results }
}
