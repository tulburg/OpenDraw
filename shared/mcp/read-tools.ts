import { CommentError, getThread, type ListArgs, listAuthors, listThreads } from '../comments'
// The read tools from S-4, as pure functions over a snapshot. Screenshots and computed styles need
// a renderer and live in the main process.
import type { DesignNode } from '../document'
import { pageList } from '../pages'
import { matchesPattern, tokensAsCss, tokensAsTailwind } from '../tokens'
import { type JSXOptions, toJSX } from './jsx'
import {
  layoutOf,
  requireFile,
  requireNode,
  requirePage,
  type Snapshot,
  ToolError,
  typeName,
  walk
} from './snapshot'

const fileName = (snapshot: Snapshot) =>
  (snapshot.filePath.split(/[\\/]/).pop() ?? '').replace(/\.opendraw$/, '')

function fontFamilies(nodes: DesignNode[]): string[] {
  const families = new Set<string>()
  walk(nodes, (node) => {
    const family = node.style.fontFamily
    if (typeof family === 'string') families.add(family.split(',')[0].trim().replace(/^["']|["']$/g, ''))
  })
  return [...families].sort()
}

export function getBasicInfo(snapshot: Snapshot, args: { fileId?: string; pageId?: string }) {
  requireFile(snapshot, args.fileId)
  const page = requirePage(snapshot, args.pageId)
  let nodeCount = 0
  walk(page.nodes, () => nodeCount++)
  return {
    fileId: snapshot.document.id,
    fileName: fileName(snapshot),
    page: { id: page.id, name: page.name, isActive: page.id === snapshot.pageId },
    pages: pageList(snapshot.document).map((item) =>
      item.type === 'page'
        ? { id: item.id, name: item.name, type: 'page', icon: item.icon ?? null, isActive: item.id === snapshot.pageId }
        : { id: item.id, type: 'divider' }
    ),
    nodeCount,
    artboards: page.nodes.map((node) => {
      const { worldX, worldY, width, height } = layoutOf(snapshot, node.id)
      return { id: node.id, name: node.name, worldX, worldY, width, height }
    }),
    fontFamilies: fontFamilies(snapshot.document.pages.flatMap((p) => p.nodes)),
    tokens: (snapshot.document.tokens ?? []).map((t) => ({ name: t.name, type: t.type, value: t.value }))
  }
}

export function getSelection(snapshot: Snapshot, args: { fileId?: string }) {
  requireFile(snapshot, args.fileId)
  return {
    fileId: snapshot.document.id,
    pageId: snapshot.pageId,
    nodes: snapshot.selection.map((id) => {
      const { node, artboard } = requireNode(snapshot, id)
      const { width, height } = layoutOf(snapshot, id)
      return {
        id,
        name: node.name,
        component: typeName(node),
        width,
        height,
        artboard: { id: artboard.id, name: artboard.name }
      }
    })
  }
}

const MAX_TREE_DEPTH = 10

function size(value: number | null): string {
  return value === null ? '?' : String(Math.round(value))
}

export function getTreeSummary(snapshot: Snapshot, args: { fileId: string; nodeId: string; depth?: number }) {
  requireFile(snapshot, args.fileId)
  const { node: root } = requireNode(snapshot, args.nodeId)
  const maxDepth = Math.min(Math.max(1, args.depth ?? 3), MAX_TREE_DEPTH)
  const lines: string[] = []
  const visit = (node: DesignNode, depth: number) => {
    const { width, height } = layoutOf(snapshot, node.id)
    const pad = '  '.repeat(depth)
    const text = node.text ? ` "${node.text.length > 40 ? `${node.text.slice(0, 40)}...` : node.text}"` : ''
    lines.push(`${pad}${typeName(node)} "${node.name}" (${node.id}) ${size(width)}x${size(height)}${text}`)
    if (node.children.length === 0) return
    if (depth + 1 >= maxDepth) {
      lines.push(`${pad}  ... ${node.children.length} ${node.children.length === 1 ? 'child' : 'children'}`)
      return
    }
    for (const child of node.children) visit(child, depth + 1)
  }
  visit(root, 0)
  return lines.join('\n')
}

export function getNodeInfo(snapshot: Snapshot, args: { fileId: string; nodeId: string }) {
  requireFile(snapshot, args.fileId)
  const { node, parent, page, artboard, locked } = requireNode(snapshot, args.nodeId)
  return {
    id: node.id,
    name: node.name,
    component: typeName(node),
    pageId: page.id,
    parentId: parent?.id ?? null,
    artboardId: artboard.id,
    visible: node.style.display !== 'none',
    locked,
    childIds: node.children.map((child) => child.id),
    ...(node.type === 'text' ? { textContent: node.text ?? '' } : {}),
    ...layoutOf(snapshot, node.id)
  }
}

export function getChildren(snapshot: Snapshot, args: { fileId: string; nodeId: string }) {
  requireFile(snapshot, args.fileId)
  const { node } = requireNode(snapshot, args.nodeId)
  return node.children.map((child) => ({
    id: child.id,
    name: child.name,
    component: typeName(child),
    childCount: child.children.length,
    ...layoutOf(snapshot, child.id)
  }))
}

export function listCommentThreads(snapshot: Snapshot, args: ListArgs & { fileId?: string }) {
  requireFile(snapshot, args.fileId)
  return listThreads(snapshot.document, snapshot.pageId, args)
}

export function getCommentThread(snapshot: Snapshot, args: { fileId?: string; commentThreadId: string }) {
  requireFile(snapshot, args.fileId)
  try {
    return getThread(snapshot.document, args.commentThreadId)
  } catch (err) {
    if (err instanceof CommentError) throw new ToolError(err.message)
    throw err
  }
}

export function listCommentThreadAuthors(snapshot: Snapshot, args: { fileId?: string; pageId?: string }) {
  requireFile(snapshot, args.fileId)
  return listAuthors(snapshot.document, args.pageId)
}

export function getTokens(snapshot: Snapshot, args: { fileId?: string; format?: 'json' | 'css' | 'tailwind'; namePattern?: string; types?: string[] }) {
  requireFile(snapshot, args.fileId)
  const tokens = (snapshot.document.tokens ?? []).filter(
    (t) => (!args.namePattern || matchesPattern(t.name, args.namePattern)) && (!args.types || args.types.includes(t.type))
  )
  if (args.format === 'css') return tokensAsCss(tokens)
  if (args.format === 'tailwind') return tokensAsTailwind(tokens)
  return { tokens }
}

export function getJSX(
  snapshot: Snapshot,
  args: { fileId: string; nodeId: string; format?: JSXOptions['format']; includeNodeIds?: boolean; includeRootPositioning?: boolean }
) {
  requireFile(snapshot, args.fileId)
  const { node } = requireNode(snapshot, args.nodeId)
  return toJSX(node, {
    format: args.format ?? 'inline-styles',
    includeNodeIds: args.includeNodeIds ?? true,
    includeRootPositioning: args.includeRootPositioning ?? false
  })
}

// find_nodes ----------------------------------------------------------------

const NAMED_COLORS: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff',
  gray: '#808080', grey: '#808080', yellow: '#ffff00', orange: '#ffa500', purple: '#800080', transparent: '#00000000'
}

/** A comparable "r,g,b,a" for a CSS color, or null when the text is not a color this matcher understands. */
function normalizeColor(text: string): string | null {
  const value = NAMED_COLORS[text.trim().toLowerCase()] ?? text.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value)
  if (hex) {
    let digits = hex[1]
    if (digits.length <= 4) digits = [...digits].map((d) => d + d).join('')
    const n = (i: number) => Number.parseInt(digits.slice(i, i + 2), 16)
    const alpha = digits.length === 8 ? Math.round((n(6) / 255) * 1000) / 1000 : 1
    return `${n(0)},${n(2)},${n(4)},${alpha}`
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(value)
  if (rgb) {
    const alphaText = rgb[4] ?? '1'
    const alpha = alphaText.endsWith('%') ? Number.parseFloat(alphaText) / 100 : Number.parseFloat(alphaText)
    return `${Math.round(+rgb[1])},${Math.round(+rgb[2])},${Math.round(+rgb[3])},${Math.round(alpha * 1000) / 1000}`
  }
  return null
}

function wildcard(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

const camel = (name: string) => (name.startsWith('--') ? name : name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()))

const COLOR_IN_VALUE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\b[a-z]+\b/g

/** The part of `value` that matches `query`, or null. Colors match by equivalence, tokens by reference. */
function matchValue(value: string, query: string): string | null {
  if (query.startsWith('--') || query.startsWith('var(')) {
    const name = query.startsWith('var(') ? query.slice(4, -1).trim() : query
    return value.includes(`var(${name}`) ? `var(${name})` : null
  }
  if (wildcard(query).test(value)) return value
  const color = normalizeColor(query)
  if (color) {
    for (const fragment of value.match(COLOR_IN_VALUE) ?? []) if (normalizeColor(fragment) === color) return fragment
  }
  return null
}

interface FindArgs {
  fileId: string
  nodeId?: string
  pageId?: string
  textValue?: string
  filters?: { styleName?: string; styleValue?: string }[]
}

export function findNodes(snapshot: Snapshot, args: FindArgs) {
  requireFile(snapshot, args.fileId)
  if (!args.textValue && !args.filters?.length) throw new ToolError('Pass filters, textValue, or both')
  const roots = args.nodeId
    ? [requireNode(snapshot, args.nodeId).node]
    : args.pageId
      ? requirePage(snapshot, args.pageId).nodes
      : snapshot.document.pages.flatMap((page) => page.nodes)

  const results: { id: string; name: string; component: string; matched: object[] }[] = []
  walk(roots, (node) => {
    const matched: object[] = []
    for (const filter of args.filters ?? []) {
      const names = Object.keys(node.style).filter((p) => !filter.styleName || wildcard(camel(filter.styleName)).test(p))
      const hit = names
        .map((p) => ({ styleName: p, styleValue: filter.styleValue ? matchValue(String(node.style[p]), filter.styleValue) : String(node.style[p]) }))
        .find((m) => m.styleValue !== null)
      if (!hit) return
      matched.push(hit)
    }
    if (args.textValue) {
      if (node.type !== 'text' || !wildcard(args.textValue).test(node.text ?? '')) return
      matched.push({ textValue: node.text })
    }
    results.push({ id: node.id, name: node.name, component: typeName(node), matched })
  })
  return results
}
