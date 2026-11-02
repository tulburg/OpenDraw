// Comment pins and thread popovers on the canvas (S-16 Req 3). A pin on a layer sits at an offset
// from the layer's top-left corner, measured from the DOM, so it follows the layer as it moves.
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { type CommentThread, LOCAL_USER_ID, type Viewport } from '../../shared/document'
import { visibleThreads } from '../../shared/comments'
import { setUserName, localAuthor, useUserName } from '../comments/user'
import { type DocumentStore, useStore } from '../document/store'
import { nodeElement } from './selection'

const REACTIONS = ['👍', '❤️', '✅', '👀']

export interface Pin {
  nodeId?: string
  x: number
  y: number
}

/** A layer's top-left corner in world units, from its rendered box. */
export function layerOrigin(canvas: HTMLElement, id: string, viewport: Viewport): { x: number; y: number } | null {
  const el = nodeElement(canvas, id)
  if (!el) return null
  const outer = canvas.getBoundingClientRect()
  const box = el.getBoundingClientRect()
  return { x: (box.left - outer.left - viewport.x) / viewport.zoom, y: (box.top - outer.top - viewport.y) / viewport.zoom }
}

const formatTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

const initial = (name: string) => name.trim().charAt(0).toUpperCase() || '?'

interface Props {
  store: DocumentStore
  canvas: RefObject<HTMLDivElement | null>
  viewport: Viewport
  /** Changes whenever layers may have moved: the nodes and any live preview. */
  layoutKey: unknown
  openThread: string | null
  onOpenThread: (id: string | null) => void
  draft: Pin | null
  onDraft: (pin: Pin | null) => void
}

export function CommentLayer({ store, canvas, viewport, layoutKey, openThread, onOpenThread, draft, onDraft }: Props) {
  const doc = useStore(store, (s) => s.document)
  const pageId = useStore(store, (s) => s.pageId)
  const threads = visibleThreads(doc).filter((t) => t.pageId === pageId && (t.status === 'open' || t.id === openThread))
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({})

  const screenOf = (pin: Pin, origins: Record<string, { x: number; y: number } | null>) => {
    const origin = pin.nodeId ? origins[pin.nodeId] : { x: 0, y: 0 }
    if (!origin) return null
    return { x: (origin.x + pin.x) * viewport.zoom + viewport.x, y: (origin.y + pin.y) * viewport.zoom + viewport.y }
  }

  useLayoutEffect(() => {
    const el = canvas.current
    if (!el) return
    const origins: Record<string, { x: number; y: number } | null> = {}
    const pins: Pin[] = [...threads, ...(draft ? [draft] : [])]
    for (const pin of pins) if (pin.nodeId && !(pin.nodeId in origins)) origins[pin.nodeId] = layerOrigin(el, pin.nodeId, viewport)
    const next: Record<string, { x: number; y: number }> = {}
    for (const t of threads) {
      const at = screenOf(t, origins)
      if (at) next[t.id] = at
    }
    if (draft) {
      const at = screenOf(draft, origins)
      if (at) next.draft = at
    }
    setPositions(next)
  }, [doc, pageId, viewport, layoutKey, draft, openThread])

  // A click anywhere outside the popover or a pin closes it.
  useEffect(() => {
    if (!openThread && !draft) return
    const down = (event: PointerEvent) => {
      const target = event.target as Element
      if (target.closest('.comment-popover, .comment-pin, [data-comment-thread-row]')) return
      onOpenThread(null)
      onDraft(null)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      onOpenThread(null)
      onDraft(null)
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key)
    }
  }, [openThread, draft, onOpenThread, onDraft])

  const open = threads.find((t) => t.id === openThread)
  return (
    <>
      {threads.map((t) => {
        const at = positions[t.id]
        if (!at) return null
        return (
          <button
            key={t.id}
            type="button"
            className="comment-pin"
            data-comment-pin={t.id}
            data-status={t.status}
            data-open={t.id === openThread || undefined}
            style={{ left: at.x, top: at.y }}
            title={`${t.messages[0].authorName}: ${t.messages[0].text}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => {
              onDraft(null)
              onOpenThread(t.id === openThread ? null : t.id)
            }}
          >
            {initial(t.messages[0].authorName)}
          </button>
        )
      })}
      {draft && positions.draft && (
        <>
          <div className="comment-pin" data-draft="" style={{ left: positions.draft.x, top: positions.draft.y }} />
          <Popover at={positions.draft}>
            <Composer
              placeholder="Add a comment"
              autoFocus
              onSubmit={(text, author) => {
                const id = store.transact('Add comment', (tx) => tx.addThread({ pageId, ...draft, text, author }))
                onDraft(null)
                onOpenThread(id)
              }}
            />
          </Popover>
        </>
      )}
      {open && positions[open.id] && (
        <Popover at={positions[open.id]}>
          <ThreadView store={store} thread={open} onClose={() => onOpenThread(null)} />
        </Popover>
      )}
    </>
  )
}

function Popover({ at, children }: { at: { x: number; y: number }; children: React.ReactNode }) {
  return (
    <div
      className="comment-popover"
      data-testid="comment-popover"
      style={{ left: at.x + 18, top: at.y - 8 }}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  )
}

function ThreadView({ store, thread, onClose }: { store: DocumentStore; thread: CommentThread; onClose: () => void }) {
  const [reacting, setReacting] = useState<string | null>(null)
  const resolved = thread.status === 'resolved'
  return (
    <div className="comment-thread" data-thread-id={thread.id}>
      <div className="comment-thread-actions">
        <button
          type="button"
          className="text-button"
          data-testid="comment-resolve"
          onClick={() => store.transact(resolved ? 'Reopen comment' : 'Resolve comment', (tx) => tx.setThreadStatus(thread.id, resolved ? 'open' : 'resolved'))}
        >
          {resolved ? 'Reopen' : 'Resolve'}
        </button>
        {thread.messages[0].authorId === LOCAL_USER_ID && (
          <button
            type="button"
            className="text-button"
            data-testid="comment-delete"
            onClick={() => {
              store.transact('Delete comment', (tx) => tx.deleteThread(thread.id))
              onClose()
            }}
          >
            Delete
          </button>
        )}
      </div>
      <div className="comment-messages">
        {thread.messages.map((m, i) => (
          <div className="comment-message" key={m.id} data-testid="comment-message">
            <div className="comment-meta">
              <span className="comment-avatar">{initial(m.authorName)}</span>
              <span className="comment-author">{m.authorName}</span>
              <span className="comment-time">{formatTime(m.createdAt)}</span>
              {i > 0 && m.authorId === LOCAL_USER_ID && (
                <button
                  type="button"
                  className="comment-remove"
                  aria-label="Delete reply"
                  onClick={() => store.transact('Delete reply', (tx) => tx.deleteMessage(thread.id, m.id))}
                >
                  Delete
                </button>
              )}
            </div>
            <div className="comment-text">{m.text}</div>
            <div className="comment-reactions">
              {Object.entries(m.reactions ?? {}).map(([emoji, users]) => (
                <button
                  key={emoji}
                  type="button"
                  className="comment-reaction"
                  data-mine={users.includes(LOCAL_USER_ID) || undefined}
                  onClick={() => store.transact('React', (tx) => tx.react(thread.id, m.id, emoji, LOCAL_USER_ID))}
                >
                  {emoji} {users.length}
                </button>
              ))}
              <button type="button" className="comment-reaction" aria-label="Add reaction" onClick={() => setReacting(reacting === m.id ? null : m.id)}>
                +
              </button>
              {reacting === m.id &&
                REACTIONS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    className="comment-reaction"
                    onClick={() => {
                      store.transact('React', (tx) => tx.react(thread.id, m.id, emoji, LOCAL_USER_ID))
                      setReacting(null)
                    }}
                  >
                    {emoji}
                  </button>
                ))}
            </div>
          </div>
        ))}
      </div>
      <Composer placeholder="Reply" onSubmit={(text, author) => store.transact('Reply', (tx) => tx.reply(thread.id, text, author))} />
    </div>
  )
}

/** The text box for a new comment or reply; the first time, it asks for the user's name. */
function Composer({ placeholder, autoFocus, onSubmit }: { placeholder: string; autoFocus?: boolean; onSubmit: (text: string, author: { id: string; name: string }) => void }) {
  const userName = useUserName()
  const [text, setText] = useState('')
  const [name, setName] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (autoFocus) input.current?.focus()
  }, [autoFocus])
  const needsName = !userName
  const ready = text.trim() !== '' && (!needsName || name.trim() !== '')
  const submit = () => {
    if (!ready) return
    const author = needsName ? name.trim() : userName!
    if (needsName) setUserName(author)
    onSubmit(text.trim(), localAuthor(author))
    setText('')
  }
  return (
    <div className="comment-composer">
      {needsName && (
        <input className="comment-name" data-testid="comment-name" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
      )}
      <textarea
        ref={input}
        data-testid="comment-input"
        placeholder={placeholder}
        rows={2}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') event.stopPropagation()
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            submit()
          }
        }}
      />
      <button type="button" className="export-button" data-testid="comment-submit" disabled={!ready} onClick={submit}>
        Post
      </button>
    </div>
  )
}
