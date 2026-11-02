// Paper's file and folder tools (S-13 Req 4), shared by the MCP server and the file browser.
import { readFile } from 'node:fs/promises'

import type { BrowserWindow } from 'electron'

import type { DesignDocument, OpenedDocument } from '../shared/document'
import type { Snapshot } from '../shared/mcp/snapshot'
import { type Resource, ResourceError } from './resources'
import { requestRenderer } from './rpc'
import { openFileById, tabs, workspace } from './workspace'

export interface ListedResource {
  type: 'file' | 'folder'
  id: string
  name: string
  parentId?: string
  createdAt: string
  updatedAt: string
  open?: true
  active?: true
  archived?: true
}

const DEFAULT_LIMIT = 50

function listed(r: Resource): ListedResource {
  return {
    type: r.type,
    id: r.id,
    name: r.name,
    ...(r.parentId ? { parentId: r.parentId } : {}),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    ...(tabs.ids.includes(r.id) ? { open: true as const } : {}),
    ...(tabs.activeId === r.id ? { active: true as const } : {}),
    ...(r.archived ? { archived: true as const } : {})
  }
}

const brief = (r: Resource) => ({ id: r.id, name: r.name, type: r.type, ...(r.parentId ? { parentId: r.parentId } : {}) })

/** Open files first (in tab order), then files and folders by most recently updated. */
export async function listResources(args: { parentId?: string; includeArchived?: boolean; limit?: number }) {
  const all = await workspace().scan()
  const limit = args.limit ?? DEFAULT_LIMIT
  const inScope = all.filter((r) => (args.includeArchived || !r.archived) && (args.parentId === undefined || r.parentId === args.parentId))
  const open = tabs.ids.map((id) => inScope.find((r) => r.id === id)).filter((r): r is Resource => !!r)
  const rest = inScope.filter((r) => !tabs.ids.includes(r.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const ordered = [...open, ...rest]
  const items = ordered.slice(0, limit).map(listed)
  return ordered.length > limit ? { items, truncated: true } : { items }
}

/** The latest content of a file: from its tab when open (unsaved edits included), else from disk. */
async function latestDocument(id: string, getWindow: () => BrowserWindow | null): Promise<DesignDocument> {
  const resource = workspace().get(id)
  if (!resource || resource.type !== 'file') throw new ResourceError(`No file with ID ${id}`)
  const win = getWindow()
  if (win && tabs.ids.includes(id)) {
    return (await requestRenderer<Snapshot>(win.webContents, 'mcp:snapshot', { fileId: id })).document
  }
  return JSON.parse(await readFile(resource.path, 'utf8')) as DesignDocument
}

/** A file's saved document, for thumbnails. */
export async function readSavedDocument(id: string): Promise<DesignDocument> {
  const resource = workspace().get(id) ?? (await workspace().scan(), workspace().get(id))
  if (!resource || resource.type !== 'file') throw new ResourceError(`No file with ID ${id}`)
  return JSON.parse(await readFile(resource.path, 'utf8')) as DesignDocument
}

export async function createFile(args: { name?: string; parentId?: string; cloneFileId?: string }, getWindow: () => BrowserWindow | null) {
  await workspace().scan()
  const clone = args.cloneFileId ? await latestDocument(args.cloneFileId, getWindow) : undefined
  return brief(await workspace().createFile({ name: args.name, parentId: args.parentId, clone }))
}

export async function createFolder(args: { name?: string; parentId?: string }) {
  await workspace().scan()
  return brief(await workspace().createFolder(args))
}

export async function moveResources(args: { resourceIds: string[]; parentId: string }) {
  await workspace().scan()
  const { moved, alreadyThere } = await workspace().moveResources(args.resourceIds, args.parentId)
  return { moved: moved.map(brief), ...(alreadyThere.length > 0 ? { alreadyInFolder: alreadyThere.map(brief) } : {}) }
}

export async function renameResource(args: { resourceId: string; name: string }) {
  await workspace().scan()
  const r = await workspace().renameResource(args.resourceId, args.name)
  return { name: r.name, type: r.type }
}

export async function setArchived(args: { resourceIds: string[] }, archived: boolean) {
  await workspace().scan()
  const items = await workspace().setArchived(args.resourceIds, archived)
  return { [archived ? 'archived' : 'unarchived']: items.map(brief) }
}

/** A bare ID, a /file/<id> path, or a URL ending in one. */
export function parseFileId(value: string): string {
  const match = value.match(/\/file\/([^/?#]+)/)
  return match ? decodeURIComponent(match[1]) : value.trim()
}

/**
 * Opens a file as a tab, behind the one in front, and returns its ID. A file already open keeps its
 * page; `pageId` applies only to a file being opened now.
 */
export async function openFile(args: { fileId: string; pageId?: string }, getWindow: () => BrowserWindow | null): Promise<string> {
  const id = parseFileId(args.fileId)
  const win = getWindow()
  if (!win) throw new ResourceError('OpenDraw has no window open.')
  if (tabs.ids.includes(id)) return id
  const opened: OpenedDocument = await openFileById(id)
  if (args.pageId) {
    if (!opened.document.pages.some((p) => p.id === args.pageId)) throw new ResourceError(`No page with ID ${args.pageId} in file ${id}`)
    opened.pageId = args.pageId
    opened.viewport = null
  }
  await requestRenderer(win.webContents, 'workspace:add-tab', { opened, activate: false })
  return id
}
