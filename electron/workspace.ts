import { renameSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { app } from 'electron'

import type { DesignDocument, OpenedDocument, Viewport } from '../shared/document'
import { createFirstDocument } from '../shared/document'
import { ResourceError, Workspace } from './resources'

interface AppState {
  lastFile?: string
  /** Open tabs by file ID, in order, and the one in front (S-13). */
  openFiles?: string[]
  activeFile?: string
  /** Last viewport per file path and page. */
  viewports: Record<string, { pageId: string; viewport: Viewport }>
  window?: { x: number; y: number; width: number; height: number }
}

export function workspaceDir(): string {
  return process.env.OPENDRAW_WORKSPACE ?? path.join(app.getPath('documents'), 'OpenDraw')
}

function statePath(): string {
  return path.join(app.getPath('userData'), 'state.json')
}

export async function readState(): Promise<AppState> {
  try {
    const state = JSON.parse(await readFile(statePath(), 'utf8')) as Partial<AppState>
    return { viewports: {}, ...state }
  } catch {
    return { viewports: {} }
  }
}

let writing = Promise.resolve()

/** Applies `change` to the stored state. Writes are serialized and atomic. */
export function updateState(change: (state: AppState) => void): Promise<void> {
  writing = writing.then(async () => {
    const state = await readState()
    change(state)
    await mkdir(path.dirname(statePath()), { recursive: true })
    const tmp = `${statePath()}.tmp`
    await writeFile(tmp, JSON.stringify(state, null, 2))
    await rename(tmp, statePath())
  })
  return writing
}

/** Resolves once every queued state write has landed on disk. */
export function flushState(): Promise<void> {
  return writing
}

async function writeDocument(file: string, document: DesignDocument): Promise<void> {
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(document, null, 2))
  await rename(tmp, file)
}

/** Files the app has opened. The renderer may only save to these. */
const openedFiles = new Set<string>()
let savingDocuments = Promise.resolve()

function requireOpened(file: string) {
  if (!openedFiles.has(file)) throw new Error(`Not an open document: ${file}`)
}

/** Autosave (S-3 Req 6): writes are serialized so an older save never lands after a newer one. */
export function saveDocument(file: string, document: DesignDocument): Promise<void> {
  requireOpened(file)
  const next = savingDocuments.then(() => writeDocument(file, document))
  savingDocuments = next.catch(() => undefined)
  return next
}

/** For a page reload, where the renderer cannot wait for an async save. */
export function saveDocumentSync(file: string, document: DesignDocument) {
  requireOpened(file)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(document, null, 2))
  renameSync(tmp, file)
}

let workspaceInstance: Workspace | null = null

/** The workspace folder's files and folders (S-13). */
export function workspace(): Workspace {
  workspaceInstance ??= new Workspace(workspaceDir())
  return workspaceInstance
}

/** Open tabs, as the renderer last reported them: file IDs in order and the one in front. */
export const tabs = { ids: [] as string[], activeId: null as string | null }

async function openDocument(file: string): Promise<OpenedDocument> {
  const state = await readState()
  const document = JSON.parse(await readFile(file, 'utf8')) as DesignDocument
  openedFiles.add(file)
  const saved = state.viewports[file]
  const page = document.pages.find((p) => p.id === saved?.pageId) ?? document.pages[0]
  return { path: file, document, pageId: page.id, viewport: saved?.pageId === page.id ? saved.viewport : null }
}

/** Opens a workspace file by ID for a new tab. */
export async function openFileById(id: string): Promise<OpenedDocument> {
  const resource = workspace().get(id) ?? (await workspace().scan(), workspace().get(id))
  if (!resource || resource.type !== 'file') throw new ResourceError(`No file with ID ${id}`)
  if (resource.archived) throw new ResourceError(`File ${id} is archived; unarchive it first`)
  return openDocument(resource.path)
}

let opening: Promise<unknown> = Promise.resolve()

/**
 * Restores the open tabs, else reopens the last file or the newest one, else creates the first-run
 * file: an untitled document with one 1440x900 Desktop artboard (S-2 Req 6 and 7). Calls run one
 * at a time, so overlapping requests (a reload, React StrictMode) never create two files.
 */
export function openInitialTabs(): Promise<{ tabs: OpenedDocument[]; activeId: string }> {
  const next = opening.then(openInitialTabsNow, openInitialTabsNow)
  opening = next.catch(() => undefined)
  return next
}

async function openInitialTabsNow(): Promise<{ tabs: OpenedDocument[]; activeId: string }> {
  const state = await readState()
  const resources = await workspace().scan()
  const usable = (id: string) => {
    const r = workspace().get(id)
    return r?.type === 'file' && !r.archived ? r : undefined
  }
  let ids = (state.openFiles ?? []).filter((id) => usable(id))
  if (ids.length === 0) {
    const last = state.lastFile ? workspace().byPath(state.lastFile) : undefined
    const newest = resources.filter((r) => r.type === 'file' && !r.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
    const file = (last && usable(last.id)) ?? newest ?? (await workspace().addDocument(createFirstDocument()))
    ids = [file.id]
  }
  const activeId = state.activeFile && ids.includes(state.activeFile) ? state.activeFile : ids[0]
  const opened = await Promise.all(ids.map((id) => openDocument(workspace().get(id)!.path)))
  await setTabs(ids, activeId)
  return { tabs: opened, activeId }
}

/** Records the open tabs (S-13 Req 3), so they come back on the next launch. */
export function setTabs(ids: string[], activeId: string | null): Promise<void> {
  tabs.ids = ids
  tabs.activeId = activeId
  const active = activeId ? workspace().get(activeId)?.path : undefined
  return updateState((s) => {
    s.openFiles = ids
    s.activeFile = activeId ?? undefined
    if (active) s.lastFile = active
  })
}

/** A file moved or was renamed on disk: saves and saved viewports follow it. */
export function fileMoved(from: string, to: string) {
  if (openedFiles.delete(from)) openedFiles.add(to)
  void updateState((s) => {
    if (s.viewports[from]) {
      s.viewports[to] = s.viewports[from]
      delete s.viewports[from]
    }
    if (s.lastFile === from) s.lastFile = to
  })
}

export function saveViewport(file: string, pageId: string, viewport: Viewport): Promise<void> {
  return updateState((s) => {
    s.viewports[file] = { pageId, viewport }
  })
}
