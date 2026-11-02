// The home view (S-13 Req 2): folders and files in the workspace, newest first, with thumbnails.
// Files and folders are created, renamed, moved (drag onto a folder) and archived here; the
// Archive view restores them. It uses the same operations as the MCP resource tools.
import { type CSSProperties, useCallback, useEffect, useState } from 'react'

import type { DesignDocument, DesignNode } from '../../shared/document'
import type { ListedResource } from '../../electron/resource-tools'
import { tokenStyle } from '../../shared/tokens'
import { NodeView, TokensContext } from '../canvas/NodeView'

const THUMB = { width: 220, height: 140 }
const LIST_LIMIT = 200

function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return 'Edited just now'
  const units: [number, string][] = [
    [60 * 60 * 24 * 365, 'year'],
    [60 * 60 * 24 * 30, 'month'],
    [60 * 60 * 24, 'day'],
    [60 * 60, 'hour'],
    [60, 'minute']
  ]
  for (const [size, unit] of units) {
    if (seconds >= size) {
      const n = Math.floor(seconds / size)
      return `Edited ${n} ${unit}${n === 1 ? '' : 's'} ago`
    }
  }
  return ''
}

/** A scaled-down render of a file's first artboard. */
function Thumbnail({ id, updatedAt }: { id: string; updatedAt: string }) {
  const [artboard, setArtboard] = useState<DesignNode | null>(null)
  const [tokens, setTokens] = useState<DesignDocument['tokens']>()
  useEffect(() => {
    let cancelled = false
    window.opendraw
      .readFile(id)
      .then((doc: DesignDocument) => {
        if (cancelled) return
        setArtboard(doc.pages[0]?.nodes.find((n) => n.type === 'artboard') ?? null)
        setTokens(doc.tokens)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [id, updatedAt])
  if (!artboard) return <div className="thumb" />
  const width = parseFloat(String(artboard.style.width)) || 1440
  const height = parseFloat(String(artboard.style.height)) || 900
  const scale = Math.min(THUMB.width / width, THUMB.height / height)
  const node = { ...artboard, style: { ...artboard.style, left: '0px', top: '0px' } }
  const inner: CSSProperties = {
    position: 'absolute',
    left: (THUMB.width - width * scale) / 2,
    top: (THUMB.height - height * scale) / 2,
    width,
    height,
    transform: `scale(${scale})`,
    transformOrigin: '0 0',
    pointerEvents: 'none'
  }
  return (
    <div className="thumb">
      <div style={inner}>
        <TokensContext.Provider value={tokenStyle(tokens)}>
          <NodeView node={node} />
        </TokensContext.Provider>
      </div>
    </div>
  )
}

function Name({ item, onRename }: { item: ListedResource; onRename: (name: string) => void }) {
  const [editing, setEditing] = useState(false)
  if (editing) {
    return (
      <input
        className="resource-name-input"
        data-testid="rename-input"
        defaultValue={item.name}
        autoFocus
        onFocus={(event) => event.currentTarget.select()}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onBlur={(event) => {
          setEditing(false)
          if (event.currentTarget.value.trim() && event.currentTarget.value !== item.name) onRename(event.currentTarget.value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') {
            event.currentTarget.value = item.name
            event.currentTarget.blur()
          }
        }}
      />
    )
  }
  return (
    <div
      className="resource-name"
      data-testid="resource-name"
      title="Double-click to rename"
      onDoubleClick={(event) => {
        event.stopPropagation()
        setEditing(true)
      }}
    >
      {item.name}
    </div>
  )
}

interface FileBrowserProps {
  openIds: string[]
  onOpen: (id: string) => void
  onConnect: () => void
}

export function FileBrowser({ openIds, onOpen, onConnect }: FileBrowserProps) {
  const [folderId, setFolderId] = useState<string | undefined>(undefined)
  const [archive, setArchive] = useState(false)
  const [all, setAll] = useState<ListedResource[]>([])
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const { items } = await window.opendraw.listResources({ includeArchived: true, limit: LIST_LIMIT })
    setAll(items)
  }, [])
  useEffect(() => {
    void refresh()
    // Agents change files too; keep the view current while it is shown.
    const timer = setInterval(() => void refresh(), 2000)
    return () => clearInterval(timer)
  }, [refresh])

  const act = async (run: () => Promise<unknown>) => {
    try {
      setError(null)
      await run()
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '') : String(err))
    }
    await refresh()
  }

  const byId = new Map(all.map((r) => [r.id, r]))
  const sorted = (items: ListedResource[]) =>
    [...items].sort((a, b) => (a.type === b.type ? b.updatedAt.localeCompare(a.updatedAt) : a.type === 'folder' ? -1 : 1))
  const shown = archive
    ? // The archive lists what was archived, not each item inside an archived folder.
      sorted(all.filter((r) => r.archived && !(r.parentId && byId.get(r.parentId)?.archived)))
    : sorted(all.filter((r) => !r.archived && r.parentId === folderId))

  const trail: ListedResource[] = []
  for (let id = folderId; id; id = byId.get(id)?.parentId) {
    const folder = byId.get(id)
    if (!folder) break
    trail.unshift(folder)
  }

  return (
    <main className="file-browser" data-testid="file-browser">
      <nav className="browser-sidebar">
        <button type="button" className={!archive ? 'active' : ''} data-testid="browser-all" onClick={() => (setArchive(false), setFolderId(undefined))}>
          All files
        </button>
        <button type="button" className={archive ? 'active' : ''} data-testid="browser-archive" onClick={() => setArchive(true)}>
          Archive
        </button>
        <button type="button" className="browser-connect" data-testid="browser-connect" onClick={onConnect}>
          Connect an agent
        </button>
      </nav>
      <section className="browser-main">
        <header className="browser-header">
          <div className="breadcrumbs" data-testid="breadcrumbs">
            {archive ? (
              <span>Archive</span>
            ) : (
              <>
                <button type="button" onClick={() => setFolderId(undefined)}>
                  All files
                </button>
                {trail.map((folder) => (
                  <span key={folder.id}>
                    <span className="crumb-sep">/</span>
                    <button type="button" onClick={() => setFolderId(folder.id)}>
                      {folder.name}
                    </button>
                  </span>
                ))}
              </>
            )}
          </div>
          {!archive && (
            <div className="browser-actions">
              <button type="button" data-testid="new-folder" onClick={() => void act(() => window.opendraw.createFolder({ parentId: folderId }))}>
                New folder
              </button>
              <button
                type="button"
                className="primary"
                data-testid="new-file"
                onClick={() =>
                  void act(async () => {
                    const file = await window.opendraw.createFile({ parentId: folderId })
                    onOpen(file.id)
                  })
                }
              >
                New file
              </button>
            </div>
          )}
        </header>
        {error && (
          <div className="browser-error" data-testid="browser-error">
            {error}
          </div>
        )}
        {shown.length === 0 ? (
          <div className="browser-empty">{archive ? 'Nothing is archived.' : 'No files here yet.'}</div>
        ) : (
          <div className="resource-grid" data-testid="resource-grid">
            {shown.map((item) => (
              <div
                key={item.id}
                className={`resource-card ${item.type}${dropTarget === item.id ? ' drop-target' : ''}${openIds.includes(item.id) ? ' open' : ''}`}
                data-testid="resource"
                data-resource-id={item.id}
                data-resource-type={item.type}
                draggable={!archive}
                onDragStart={(event) => {
                  event.dataTransfer.setData('text/plain', item.id)
                  setDragging(item.id)
                }}
                onDragEnd={() => (setDragging(null), setDropTarget(null))}
                onDragOver={(event) => {
                  if (item.type !== 'folder' || !dragging || dragging === item.id) return
                  event.preventDefault()
                  setDropTarget(item.id)
                }}
                onDragLeave={() => setDropTarget((t) => (t === item.id ? null : t))}
                onDrop={(event) => {
                  event.preventDefault()
                  const id = dragging
                  setDragging(null)
                  setDropTarget(null)
                  if (id && item.type === 'folder') void act(() => window.opendraw.moveResources({ resourceIds: [id], parentId: item.id }))
                }}
                onDoubleClick={() => {
                  if (archive) return
                  if (item.type === 'folder') setFolderId(item.id)
                  else onOpen(item.id)
                }}
              >
                {item.type === 'file' ? (
                  <Thumbnail id={item.id} updatedAt={item.updatedAt} />
                ) : (
                  <div className="thumb folder-thumb">
                    <svg width="40" height="32" viewBox="0 0 40 32" aria-hidden="true">
                      <path d="M2 5a3 3 0 0 1 3-3h10l4 4h16a3 3 0 0 1 3 3v18a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3z" fill="currentColor" />
                    </svg>
                  </div>
                )}
                <div className="resource-meta">
                  <Name item={item} onRename={(name) => void act(() => window.opendraw.renameResource({ resourceId: item.id, name }))} />
                  <div className="resource-time">{item.type === 'folder' ? 'Folder' : timeAgo(item.updatedAt)}</div>
                </div>
                <button
                  type="button"
                  className="resource-action"
                  data-testid={archive ? 'restore' : 'archive'}
                  title={archive ? 'Restore' : 'Archive'}
                  onClick={(event) => {
                    event.stopPropagation()
                    void act(() => window.opendraw.setArchived({ resourceIds: [item.id] }, !archive))
                  }}
                >
                  {archive ? 'Restore' : 'Archive'}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  )
}
