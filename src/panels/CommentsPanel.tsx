// The Comments tab (S-16 Req 4): threads by page, filtered by status and searched by text.
import { useState } from 'react'

import { listThreads } from '../../shared/comments'
import { type DocumentStore, useStore } from '../document/store'

type Filter = 'open' | 'resolved' | 'all'

export function CommentsPanel({ store, openThread, onOpenThread }: { store: DocumentStore; openThread: string | null; onOpenThread: (id: string | null) => void }) {
  const doc = useStore(store, (s) => s.document)
  const pageId = useStore(store, (s) => s.pageId)
  const [filter, setFilter] = useState<Filter>('open')
  const [search, setSearch] = useState('')
  const { threads } = listThreads(doc, pageId, { status: filter, search: search.trim() || undefined, limit: 10_000, previewLength: 120 })
  const pages: { id: string; name: string; threads: typeof threads }[] = []
  for (const t of threads) {
    const last = pages[pages.length - 1]
    if (last?.id === t.pageId) last.threads.push(t)
    else pages.push({ id: t.pageId, name: t.pageName ?? 'Page', threads: [t] })
  }
  return (
    <div className="comments-panel" data-testid="comments-panel">
      <div className="comments-filters">
        <div className="segmented" role="radiogroup" aria-label="Status">
          {(['open', 'resolved', 'all'] as Filter[]).map((f) => (
            <button key={f} type="button" role="radio" aria-checked={filter === f} data-active={filter === f || undefined} data-testid={`comments-filter-${f}`} onClick={() => setFilter(f)}>
              {f === 'open' ? 'Open' : f === 'resolved' ? 'Resolved' : 'All'}
            </button>
          ))}
        </div>
        <input className="comments-search" data-testid="comments-search" placeholder="Search comments" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {pages.length === 0 && <div className="panel-empty">{search ? 'No matching comments' : filter === 'resolved' ? 'No resolved comments' : 'No comments yet'}</div>}
      {pages.map((page) => (
        <section key={page.id} className="token-group">
          <div className="token-group-title">{page.name}</div>
          {page.threads.map((t) => (
            <button
              key={t.commentThreadId}
              type="button"
              className="comment-row"
              data-comment-thread-row={t.commentThreadId}
              data-status={t.status}
              aria-selected={t.commentThreadId === openThread}
              onClick={() => {
                store.setPage(t.pageId)
                store.select(t.nodeId ? [t.nodeId] : [])
                onOpenThread(t.commentThreadId)
              }}
            >
              <span className="comment-row-head">
                <span className="comment-avatar">{t.authorName.trim().charAt(0).toUpperCase() || '?'}</span>
                <span className="comment-author">{t.authorName}</span>
                {t.status === 'resolved' && <span className="comment-badge">Resolved</span>}
              </span>
              <span className="comment-row-preview">{t.preview}</span>
              <span className="comment-row-foot">
                {t.nodeName && <span>{t.nodeName}</span>}
                {t.replyCount > 0 && <span>{t.replyCount === 1 ? '1 reply' : `${t.replyCount} replies`}</span>}
              </span>
            </button>
          ))}
        </section>
      ))}
    </div>
  )
}
