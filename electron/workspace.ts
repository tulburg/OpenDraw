import { existsSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { app } from 'electron'

import type { DesignDocument, OpenedDocument, Viewport } from '../shared/document'
import { createFirstDocument, DOCUMENT_EXTENSION } from '../shared/document'

interface AppState {
  lastFile?: string
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

async function newestDocument(dir: string): Promise<string | null> {
  const names = existsSync(dir) ? await readdir(dir) : []
  const files = names.filter((name) => name.endsWith(DOCUMENT_EXTENSION)).map((name) => path.join(dir, name))
  const withTimes = await Promise.all(files.map(async (file) => ({ file, mtime: (await stat(file)).mtimeMs })))
  withTimes.sort((a, b) => b.mtime - a.mtime)
  return withTimes[0]?.file ?? null
}

async function uniquePath(dir: string, base: string): Promise<string> {
  let candidate = path.join(dir, `${base}${DOCUMENT_EXTENSION}`)
  for (let n = 2; existsSync(candidate); n++) candidate = path.join(dir, `${base} ${n}${DOCUMENT_EXTENSION}`)
  return candidate
}

let opening: Promise<unknown> = Promise.resolve()

/**
 * Reopens the last file, else the newest file in the workspace, else creates the first-run file:
 * an untitled document with one 1440x900 Desktop artboard (S-2 Req 6 and 7).
 * Calls run one at a time, so overlapping requests (a reload, React StrictMode) never create two files.
 */
export function openInitialDocument(): Promise<OpenedDocument> {
  const next = opening.then(openInitialDocumentNow, openInitialDocumentNow)
  opening = next.catch(() => undefined)
  return next
}

async function openInitialDocumentNow(): Promise<OpenedDocument> {
  const state = await readState()
  const dir = workspaceDir()
  await mkdir(dir, { recursive: true })

  let file = state.lastFile && existsSync(state.lastFile) ? state.lastFile : await newestDocument(dir)
  let document: DesignDocument
  if (file) {
    document = JSON.parse(await readFile(file, 'utf8')) as DesignDocument
  } else {
    document = createFirstDocument()
    file = await uniquePath(dir, document.name)
    await writeDocument(file, document)
  }

  openedFiles.add(file)
  const saved = state.viewports[file]
  const page = document.pages.find((p) => p.id === saved?.pageId) ?? document.pages[0]
  await updateState((s) => {
    s.lastFile = file
  })
  return { path: file, document, pageId: page.id, viewport: saved?.pageId === page.id ? saved.viewport : null }
}

export function saveViewport(file: string, pageId: string, viewport: Viewport): Promise<void> {
  return updateState((s) => {
    s.viewports[file] = { pageId, viewport }
  })
}
