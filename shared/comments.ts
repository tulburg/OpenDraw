// Comment threads (S-16): the read side shared by the MCP tools and the Comments panel.
import { type CommentThread, type DesignDocument, type DesignNode, LOCAL_USER_ID } from './document'
import { pageList } from './pages'

export class CommentError extends Error {}

/** Threads and messages that were not deleted. */
export function visibleThreads(doc: DesignDocument): CommentThread[] {
  return (doc.comments ?? [])
    .filter((t) => !t.deleted && doc.pages.some((p) => p.id === t.pageId))
    .map((t) => ({ ...t, messages: t.messages.filter((m) => !m.deleted) }))
    .filter((t) => t.messages.length > 0)
}

function findNode(nodes: DesignNode[], id: string): DesignNode | null {
  for (const node of nodes) {
    if (node.id === id) return node
    const found = findNode(node.children, id)
    if (found) return found
  }
  return null
}

const userId = (id: string | undefined) => (id === 'current-user' ? LOCAL_USER_ID : id)

export interface ListArgs {
  pageId?: string
  currentPageOnly?: boolean
  nodeId?: string
  status?: 'open' | 'resolved' | 'all'
  participantUserId?: string
  threadAuthorUserId?: string
  search?: string
  searchScope?: 'first-message' | 'all-messages'
  sortField?: 'page' | 'createdAt' | 'updatedAt'
  sortDirection?: 'asc' | 'desc'
  limit?: number
  offset?: number
  previewLength?: number
}

/** Threads matching Paper's list_comment_threads filters, sorted and paged. */
export function listThreads(doc: DesignDocument, viewingPageId: string, args: ListArgs) {
  const pageOrder = new Map(pageList(doc).filter((p) => p.type === 'page').map((p, i) => [p.id, i]))
  const pageId = args.pageId ?? (args.currentPageOnly ? viewingPageId : undefined)
  const status = args.status ?? 'open'
  const participant = userId(args.participantUserId)
  const author = userId(args.threadAuthorUserId)
  const search = args.search?.toLowerCase()
  let threads = visibleThreads(doc).filter(
    (t) =>
      (!pageId || t.pageId === pageId) &&
      (!args.nodeId || t.nodeId === args.nodeId) &&
      (status === 'all' || t.status === status) &&
      (!participant || t.messages.some((m) => m.authorId === participant)) &&
      (!author || t.messages[0].authorId === author) &&
      (!search ||
        (args.searchScope === 'first-message' ? [t.messages[0]] : t.messages).some(
          (m) => m.text.toLowerCase().includes(search) || m.authorName.toLowerCase().includes(search)
        ))
  )
  const field = args.sortField ?? 'page'
  const key = (t: CommentThread) => (field === 'page' ? `${String(pageOrder.get(t.pageId) ?? 0).padStart(6, '0')} ${t.createdAt}` : t[field])
  threads = threads.sort((a, b) => key(a).localeCompare(key(b)))
  if (args.sortDirection === 'desc') threads.reverse()
  const offset = args.offset ?? 0
  const limit = args.limit ?? 50
  const previewLength = args.previewLength ?? 240
  const page = threads.slice(offset, offset + limit)
  const pageName = (id: string) => doc.pages.find((p) => p.id === id)?.name
  return {
    threads: page.map((t) => {
      const first = t.messages[0]
      const node = t.nodeId ? findNode(doc.pages.find((p) => p.id === t.pageId)?.nodes ?? [], t.nodeId) : null
      return {
        commentThreadId: t.id,
        status: t.status,
        pageId: t.pageId,
        pageName: pageName(t.pageId),
        ...(node ? { nodeId: node.id, nodeName: node.name } : {}),
        authorUserId: first.authorId,
        authorName: first.authorName,
        preview: first.text.length > previewLength ? `${first.text.slice(0, previewLength)}...` : first.text,
        replyCount: t.messages.length - 1,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt
      }
    }),
    total: threads.length,
    ...(offset + limit < threads.length ? { nextOffset: offset + limit } : {})
  }
}

export function getThread(doc: DesignDocument, id: string) {
  const thread = visibleThreads(doc).find((t) => t.id === id)
  if (!thread) throw new CommentError(`No comment thread with ID ${id}`)
  const page = doc.pages.find((p) => p.id === thread.pageId)
  const node = thread.nodeId && page ? findNode(page.nodes, thread.nodeId) : null
  return {
    commentThreadId: thread.id,
    status: thread.status,
    page: page ? { id: page.id, name: page.name } : null,
    node: node ? { id: node.id, name: node.name, type: node.type } : null,
    position: thread.nodeId && node ? { offsetX: thread.x, offsetY: thread.y } : { x: thread.x, y: thread.y },
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    messages: thread.messages.map((m) => ({
      id: m.id,
      authorUserId: m.authorId,
      authorName: m.authorName,
      text: m.text,
      createdAt: m.createdAt,
      reactions: Object.entries(m.reactions ?? {}).map(([emoji, users]) => ({ emoji, count: users.length, userIds: users })),
      attachments: []
    }))
  }
}

export function listAuthors(doc: DesignDocument, pageId?: string) {
  const authors = new Map<string, { userId: string; displayName: string; threadCount: number; messageCount: number; lastActivityAt: string }>()
  for (const thread of visibleThreads(doc)) {
    if (pageId && thread.pageId !== pageId) continue
    thread.messages.forEach((m, i) => {
      const entry = authors.get(m.authorId) ?? { userId: m.authorId, displayName: m.authorName, threadCount: 0, messageCount: 0, lastActivityAt: m.createdAt }
      entry.displayName = m.authorName
      entry.messageCount++
      if (i === 0) entry.threadCount++
      if (m.createdAt > entry.lastActivityAt) entry.lastActivityAt = m.createdAt
      authors.set(m.authorId, entry)
    })
  }
  return { authors: [...authors.values()].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)), currentUserId: LOCAL_USER_ID }
}
