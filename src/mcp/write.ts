// The MCP write tools (S-5), run in the editor window against the document store. Each call is one
// transaction, so one undo step, and shows on the canvas as soon as it commits.
import type { CSSStyle, DesignDocument, DesignNode } from '../../shared/document'
import { newId } from '../../shared/document'
import type { WriteToolName } from '../../shared/mcp/definitions'
import { pageList } from '../../shared/pages'
import { type DocumentStore, EditError, type Transaction } from '../document/store'
import { applyStyleUpdate, type StyleUpdate } from '../document/styles'
import { findNode } from '../document/tree'
import { parseHTML, parseInlineText } from './html'
import { placeArtboard } from './placement'
import type { WorkingIndicators } from './working'

const MAX_NAME = 50

export interface WriteContext {
  store: DocumentStore
  working: WorkingIndicators
  /** The rendered size of a node in world units, or null when it is not on the canvas. */
  measure: (id: string) => { width: number; height: number } | null
}

type Move = { nodeId: string } & ({ before: string } | { after: string } | { parentId: string; index?: number })

function px(value: string | number | undefined): number | null {
  if (typeof value === 'number') return value
  const match = value?.trim().match(/^(-?\d+(\.\d+)?)(px)?$/)
  return match ? Number(match[1]) : null
}

/** The artboard each node belongs to (an artboard is its own). */
function artboardsOf(document: DesignDocument, ids: string[]): string[] {
  const found = new Set<string>()
  for (const page of document.pages) {
    for (const artboard of page.nodes) {
      if (ids.some((id) => id === artboard.id || findNode(artboard.children, id))) found.add(artboard.id)
    }
  }
  return [...found]
}

function outline(node: DesignNode): object {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    ...(node.children.length > 0 ? { children: node.children.map(outline) } : {})
  }
}

export function runWriteTool(ctx: WriteContext, tool: WriteToolName, args: any): unknown {
  const { store, working } = ctx
  const state = store.getState()
  if (args.fileId !== state.document.id) {
    throw new EditError(`No open file ${args.fileId}. The open file is ${state.document.id}; get it from get_basic_info.`)
  }

  /** Moves `artboard` to an empty spot on the page. `sizeFrom` is the node whose rendered size to use if its size is not in px. */
  const placeOnPage = (tx: Transaction, pageId: string, artboard: DesignNode, sizeFrom = artboard.id) =>
    placeArtboard(artboard, tx.childrenOf(pageId), ctx.measure, sizeFrom)

  /** Runs the edit as one undo step and marks the artboards it touched as being worked on. */
  const write = <T>(label: string, edit: (tx: Transaction) => T, touched: (result: T) => string[]): T => {
    const result = store.transact(`Agent: ${label}`, edit)
    working.touch(artboardsOf(store.getState().document, touched(result)))
    return result
  }

  switch (tool) {
    case 'create_artboard': {
      const pageId: string = args.pageId ?? state.pageId
      if (!state.document.pages.some((page) => page.id === pageId)) throw new EditError(`No page ${pageId}`)
      const draft: DesignNode = { id: newId(), type: 'artboard', name: String(args.name).slice(0, MAX_NAME), style: {}, children: [] }
      const { style, ignored } = applyStyleUpdate(draft, {
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#ffffff',
        ...(args.styles as StyleUpdate)
      })
      const artboard = { ...draft, style }
      return write(
        'create artboard',
        (tx) => {
          if (px(style.left) === null || px(style.top) === null) placeOnPage(tx, pageId, artboard)
          tx.insertNodes(pageId, undefined, [artboard])
          return {
            id: artboard.id,
            name: artboard.name,
            pageId,
            left: artboard.style.left,
            top: artboard.style.top,
            ...(Object.keys(ignored).length > 0 ? { ignoredStyles: ignored } : {})
          }
        },
        (r) => [r.id]
      )
    }

    case 'write_html': {
      const { nodes, dropped } = parseHTML(String(args.html))
      if (nodes.length === 0) {
        throw new EditError(`The HTML produced no nodes.${dropped.length ? ` Dropped: ${dropped.join('; ')}` : ''}`)
      }
      if (state.document.pages.some((page) => page.id === args.targetNodeId)) {
        throw new EditError('targetNodeId is a page. Create an artboard with create_artboard, then write into it.')
      }
      const { parentId } = write(
        'write HTML',
        (tx) => {
          const target = tx.node(args.targetNodeId)
          if (args.mode === 'replace') {
            if (target.type === 'artboard') {
              // An artboard is replaced by one element, which becomes the artboard where the old one was.
              if (nodes.length !== 1 || nodes[0].type !== 'frame') {
                throw new EditError('Replacing an artboard takes exactly one container element.')
              }
              const root = nodes[0]
              root.type = 'artboard'
              root.style = { left: target.style.left, top: target.style.top, ...root.style } as CSSStyle
            }
            tx.replaceNode(target.id, nodes)
          } else {
            tx.insertNodes(target.id, undefined, nodes)
          }
          return { parentId: args.mode === 'replace' ? tx.locate(nodes[0].id).parentId : target.id }
        },
        () => nodes.map((n) => n.id)
      )
      return { parentId, created: nodes.map(outline), dropped }
    }

    case 'update_styles': {
      const ignoredStyles: Record<string, Record<string, string>> = {}
      const ids: string[] = args.updates.flatMap((u: { nodeIds: string[] }) => u.nodeIds)
      write(
        'update styles',
        (tx) => {
          for (const update of args.updates as { nodeIds: string[]; styles: StyleUpdate }[]) {
            for (const [id, ignored] of Object.entries(tx.updateStyles(update.nodeIds, update.styles))) {
              ignoredStyles[id] = { ...ignoredStyles[id], ...ignored }
            }
          }
        },
        () => ids
      )
      return { updated: [...new Set(ids)], ...(Object.keys(ignoredStyles).length > 0 ? { ignoredStyles } : {}) }
    }

    case 'set_text_content': {
      const notes: string[] = []
      const ids: string[] = args.updates.map((u: { nodeId: string }) => u.nodeId)
      write(
        'set text',
        (tx) => {
          for (const { nodeId, html } of args.updates as { nodeId: string; html: string }[]) {
            const { text, spans, dropped } = parseInlineText(html)
            tx.setRichText(nodeId, spans)
            const node = tx.node(nodeId)
            if (/\n| {2}/.test(text) && !node.style.whiteSpace) tx.updateStyles([nodeId], { whiteSpace: 'pre-wrap' })
            for (const line of dropped) notes.push(`${nodeId}: ${line}`)
          }
        },
        () => ids
      )
      return { updated: ids, ...(notes.length > 0 ? { notes } : {}) }
    }

    case 'rename_nodes': {
      const ids: string[] = args.updates.map((u: { nodeId: string }) => u.nodeId)
      write(
        'rename',
        (tx) => {
          for (const { nodeId, name } of args.updates as { nodeId: string; name: string }[]) {
            tx.rename(nodeId, name.slice(0, MAX_NAME))
          }
        },
        () => ids
      )
      return { renamed: ids }
    }

    case 'move_nodes': {
      return write(
        'move',
        (tx) => {
          const results: { nodeId: string; parentId: string; index: number }[] = []
          const parents = new Set<string>()
          for (const move of args.moves as Move[]) {
            const from = tx.locate(move.nodeId)
            parents.add(from.parentId)
            if ('before' in move || 'after' in move) {
              const siblingId = 'before' in move ? move.before : move.after
              if (siblingId === move.nodeId) throw new EditError('A node cannot be placed next to itself')
              const parentId = tx.locate(siblingId).parentId
              tx.moveNode(move.nodeId, parentId, Number.MAX_SAFE_INTEGER)
              // Now that the node has left its old place, put it beside the sibling.
              const at = tx.locate(siblingId).index + ('before' in move ? 0 : 1)
              tx.moveNode(move.nodeId, parentId, at)
            } else {
              const parentId = move.parentId === 'root' ? from.pageId : move.parentId
              const length = tx.childrenOf(parentId).filter((child) => child.id !== move.nodeId).length
              tx.moveNode(move.nodeId, parentId, move.index === undefined ? undefined : Math.min(move.index, length))
            }
            const to = tx.locate(move.nodeId)
            parents.add(to.parentId)
            results.push({ nodeId: move.nodeId, parentId: to.parentId, index: to.index })
          }
          const affectedParents = Object.fromEntries(
            [...parents].map((id) => [id, tx.childrenOf(id).map((child) => child.id)])
          )
          return { moves: results, affectedParents }
        },
        (r) => r.moves.map((m) => m.nodeId)
      )
    }

    case 'duplicate_nodes': {
      return write(
        'duplicate',
        (tx) => {
          const duplicates = (args.nodes as { id: string; parentId?: string }[]).map(({ id, parentId }) => {
            const { pageId } = tx.locate(id)
            const { newId: copyId, idMap } = tx.duplicateNode(id, parentId, (copy) => {
              if (copy.type === 'artboard') placeOnPage(tx, parentId ?? pageId, copy, id)
            })
            return { sourceId: id, newId: copyId, descendantIdMap: idMap }
          })
          return { duplicates }
        },
        (r) => r.duplicates.map((d) => d.newId)
      )
    }

    case 'delete_nodes': {
      const ids: string[] = args.nodeIds
      const artboards = artboardsOf(state.document, ids)
      store.transact('Agent: delete', (tx) => tx.deleteNodes(ids))
      // Artboards that were deleted stop showing the indicator; the rest were edited.
      const remaining = new Set(artboardsOf(store.getState().document, artboards))
      working.release(artboards.filter((id) => !remaining.has(id)))
      working.touch([...remaining])
      return { deleted: ids }
    }

    case 'finish_working_on_nodes': {
      const ids: string[] | undefined = args.nodeIds
      const released = working.release(ids ? artboardsOf(state.document, ids) : undefined)
      return { released }
    }

    // Page tools (S-12) never switch the page the user is viewing.
    case 'create_page': {
      const pageId = store.transact('Agent: create page', (tx) => tx.addPage({ name: args.name, icon: args.icon, afterId: state.pageId }))
      const page = store.getState().document.pages.find((p) => p.id === pageId)!
      return { pageId, name: page.name, ...(page.icon ? { icon: page.icon } : {}) }
    }

    case 'update_pages': {
      const updates: { pageId: string; name?: string; icon?: string | null }[] = args.updates
      store.transact('Agent: update pages', (tx) => {
        for (const u of updates) tx.updatePage(u.pageId, { name: u.name, icon: u.icon as never })
      })
      const pages = store.getState().document.pages
      return {
        pages: updates.map((u) => {
          const page = pages.find((p) => p.id === u.pageId)!
          return { pageId: page.id, name: page.name, icon: page.icon ?? null }
        })
      }
    }

    case 'arrange_pages': {
      const newDividerIds = store.transact('Agent: arrange pages', (tx) => tx.arrangePages(args.order, args.removeDividerIds))
      const viewing = store.getState().pageId
      return {
        pages: pageList(store.getState().document).map((item) => (item.type === 'page' ? { ...item, isActive: item.id === viewing } : item)),
        ...(newDividerIds.length > 0 ? { newDividerIds } : {})
      }
    }
  }
}
