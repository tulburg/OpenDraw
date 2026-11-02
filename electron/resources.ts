// Files and folders in the workspace (S-13). Files and folders are real .opendraw files and
// directories; a small index in the workspace gives each a stable ID and keeps archive flags and
// creation times. A file's ID is its document ID; a file's name is its file name.
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { createFirstDocument, type DesignDocument, type DesignNode, DOCUMENT_EXTENSION, newId } from '../shared/document'

export const INDEX_FILE = '.opendraw-index.json'
const MAX_NAME = 500
export const DEFAULT_FILE_NAME = 'Untitled'
export const DEFAULT_FOLDER_NAME = 'Untitled project'

export class ResourceError extends Error {}

interface IndexEntry {
  /** Path relative to the workspace, with forward slashes. */
  path: string
  createdAt: string
  archived?: boolean
  /** A display name too long for the disk, kept while the file or folder keeps the name `stem`. */
  name?: string
  stem?: string
}

interface WorkspaceIndex {
  folders: Record<string, IndexEntry>
  files: Record<string, IndexEntry>
}

export interface Resource {
  id: string
  type: 'file' | 'folder'
  name: string
  /** The folder it sits in; absent at the top level. */
  parentId?: string
  /** Absolute path on disk. */
  path: string
  /** Archived itself or inside an archived folder. */
  archived: boolean
  createdAt: string
  updatedAt: string
}

const toRel = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join('/')

export function cleanName(name: string | undefined, fallback: string): string {
  const trimmed = (name ?? '').trim().slice(0, MAX_NAME).replace(/[/\\:]/g, '-')
  return trimmed || fallback
}

/** File systems cap a name at 255 bytes; longer display names are cut on disk and kept in the index. */
const MAX_DISK_BYTES = 200

function diskName(name: string): string {
  let out = name
  while (Buffer.byteLength(out) > MAX_DISK_BYTES) out = out.slice(0, -1)
  return out.trimEnd()
}

/** Keeps a long display name while the item still has the stem it was given on disk. */
function longName(known: IndexEntry | undefined, stem: string): Pick<IndexEntry, 'name' | 'stem'> {
  return known?.name && known.stem === stem ? { name: known.name, stem } : {}
}

async function writeAtomic(file: string, data: string) {
  const tmp = `${file}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, file)
}

/** A path for `name` in `dir` that is free, adding " 2", " 3" and so on. */
function uniquePath(dir: string, name: string, extension: string, except?: string): string {
  let candidate = path.join(dir, `${name}${extension}`)
  for (let n = 2; existsSync(candidate) && candidate !== except; n++) candidate = path.join(dir, `${name} ${n}${extension}`)
  return candidate
}

/** Gives every node and page a new ID, so a copy never shares IDs with its original. */
function renewIds(node: DesignNode): DesignNode {
  return { ...node, id: newId(), children: node.children.map(renewIds) }
}

export function cloneDocument(source: DesignDocument, name: string): DesignDocument {
  return {
    ...source,
    id: newId(),
    name,
    pages: source.pages.map((page) => ({ ...page, id: newId(), nodes: page.nodes.map(renewIds) }))
  }
}

export class Workspace {
  private index: WorkspaceIndex = { folders: {}, files: {} }
  private resources = new Map<string, Resource>()
  private queue: Promise<unknown> = Promise.resolve()
  /** Told when a file moves or is renamed on disk, so open tabs save to the new path. */
  onFileMoved: (id: string, from: string, to: string) => void = () => {}

  constructor(readonly root: string) {}

  /** Runs workspace changes one at a time, so the index never sees two writers. */
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async saveIndex() {
    await writeAtomic(path.join(this.root, INDEX_FILE), JSON.stringify(this.index, null, 2))
  }

  /** Reads the folder tree from disk, keeping IDs for paths the index knows (files by document ID). */
  scan(): Promise<Resource[]> {
    return this.serial(() => this.scanNow())
  }

  private async scanNow(): Promise<Resource[]> {
    await mkdir(this.root, { recursive: true })
    try {
      this.index = JSON.parse(await readFile(path.join(this.root, INDEX_FILE), 'utf8')) as WorkspaceIndex
      this.index.folders ??= {}
      this.index.files ??= {}
    } catch {
      this.index = { folders: {}, files: {} }
    }
    const folderIdByPath = new Map(Object.entries(this.index.folders).map(([id, e]) => [e.path, id]))
    const folders: WorkspaceIndex['folders'] = {}
    const files: WorkspaceIndex['files'] = {}
    const resources = new Map<string, Resource>()
    const now = new Date().toISOString()

    const walk = async (dir: string, parentId: string | undefined, archivedAbove: boolean) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue
        const abs = path.join(dir, entry.name)
        const rel = toRel(this.root, abs)
        const info = await stat(abs)
        if (entry.isDirectory()) {
          const id = folderIdByPath.get(rel) ?? newId()
          const known = this.index.folders[id]
          folders[id] = { path: rel, createdAt: known?.createdAt ?? info.birthtime.toISOString() ?? now, ...(known?.archived ? { archived: true } : {}), ...longName(known, entry.name) }
          const archived = archivedAbove || !!known?.archived
          resources.set(id, { id, type: 'folder', name: folders[id].name ?? entry.name, ...(parentId ? { parentId } : {}), path: abs, archived, createdAt: folders[id].createdAt, updatedAt: info.mtime.toISOString() })
          await walk(abs, id, archived)
        } else if (entry.name.endsWith(DOCUMENT_EXTENSION)) {
          let document: DesignDocument
          try {
            document = JSON.parse(await readFile(abs, 'utf8')) as DesignDocument
          } catch {
            continue
          }
          // A file copied by hand keeps its original's ID; give the copy its own.
          if (!document.id || files[document.id]) {
            document = { ...document, id: newId() }
            await writeAtomic(abs, JSON.stringify(document, null, 2))
          }
          const id = document.id
          const known = this.index.files[id]
          const stem = entry.name.slice(0, -DOCUMENT_EXTENSION.length)
          files[id] = { path: rel, createdAt: known?.createdAt ?? info.birthtime.toISOString(), ...(known?.archived ? { archived: true } : {}), ...longName(known, stem) }
          resources.set(id, {
            id,
            type: 'file',
            name: files[id].name ?? stem,
            ...(parentId ? { parentId } : {}),
            path: abs,
            archived: archivedAbove || !!known?.archived,
            createdAt: files[id].createdAt,
            updatedAt: info.mtime.toISOString()
          })
        }
      }
    }
    await walk(this.root, undefined, false)
    this.index = { folders, files }
    this.resources = resources
    await this.saveIndex()
    return [...resources.values()]
  }

  get(id: string): Resource | undefined {
    return this.resources.get(id)
  }

  all(): Resource[] {
    return [...this.resources.values()]
  }

  /** The file with this path, if it is in the workspace. */
  byPath(file: string): Resource | undefined {
    return this.all().find((r) => r.path === file)
  }

  private folderDir(parentId: string | undefined): string {
    if (!parentId) return this.root
    const folder = this.resources.get(parentId)
    if (!folder || folder.type !== 'folder') throw new ResourceError(`No folder with ID ${parentId}`)
    if (folder.archived) throw new ResourceError(`Folder ${parentId} is archived`)
    return folder.path
  }

  /** Writes a new file (or a copy of `clone`) into a folder and returns it. */
  createFile(args: { name?: string; parentId?: string; clone?: DesignDocument }): Promise<Resource> {
    return this.serial(async () => {
      const dir = this.folderDir(args.parentId)
      const base = cleanName(args.name ?? (args.clone ? `${args.clone.name} copy` : undefined), DEFAULT_FILE_NAME)
      const file = uniquePath(dir, diskName(base), DOCUMENT_EXTENSION)
      const name = base.length > diskName(base).length ? base : path.basename(file, DOCUMENT_EXTENSION)
      const document = args.clone ? cloneDocument(args.clone, name) : { ...createFirstDocument(), name }
      await writeAtomic(file, JSON.stringify(document, null, 2))
      await this.scanNow()
      return this.keepLongName(document.id, base, file)
    })
  }

  /** Writes a document that is not in the workspace yet (the first-run file). */
  async addDocument(document: DesignDocument): Promise<Resource> {
    return this.serial(async () => {
      const file = uniquePath(this.root, cleanName(document.name, DEFAULT_FILE_NAME), DOCUMENT_EXTENSION)
      await writeAtomic(file, JSON.stringify({ ...document, name: path.basename(file, DOCUMENT_EXTENSION) }, null, 2))
      await this.scanNow()
      return this.resources.get(document.id)!
    })
  }

  createFolder(args: { name?: string; parentId?: string }): Promise<Resource> {
    return this.serial(async () => {
      const dir = this.folderDir(args.parentId)
      const name = cleanName(args.name, DEFAULT_FOLDER_NAME)
      const folder = uniquePath(dir, diskName(name), '')
      await mkdir(folder)
      await this.scanNow()
      return this.keepLongName(this.all().find((r) => r.path === folder)!.id, name, folder)
    })
  }

  /** Records `name` as the display name when the disk could only take part of it. */
  private async keepLongName(id: string, name: string, file: string): Promise<Resource> {
    const resource = this.resources.get(id)!
    if (diskName(name) === name) return resource
    const entry = resource.type === 'file' ? this.index.files[id] : this.index.folders[id]
    entry.name = name
    entry.stem = path.basename(file, resource.type === 'file' ? DOCUMENT_EXTENSION : '')
    await this.saveIndex()
    resource.name = name
    return resource
  }

  /** Moves a path on disk and rewrites index paths under it, so IDs survive the move. */
  private async movePath(from: string, to: string) {
    await rename(from, to)
    const fromRel = toRel(this.root, from)
    const toRelPath = toRel(this.root, to)
    for (const entries of [this.index.folders, this.index.files]) {
      for (const entry of Object.values(entries)) {
        if (entry.path === fromRel) entry.path = toRelPath
        else if (entry.path.startsWith(`${fromRel}/`)) entry.path = toRelPath + entry.path.slice(fromRel.length)
      }
    }
    await this.saveIndex()
    for (const r of this.all()) {
      if (r.type !== 'file') continue
      if (r.path === from || r.path.startsWith(from + path.sep)) this.onFileMoved(r.id, r.path, to + r.path.slice(from.length))
    }
  }

  private requireAll(ids: string[]): Resource[] {
    const missing = ids.filter((id) => !this.resources.has(id))
    if (missing.length > 0) throw new ResourceError(`No file or folder with ID ${missing.join(', ')}`)
    return ids.map((id) => this.resources.get(id)!)
  }

  private isInside(resource: Resource, folderId: string): boolean {
    for (let p = resource.parentId; p; p = this.resources.get(p)?.parentId) if (p === folderId) return true
    return false
  }

  /** Moves files and folders into a folder. All are checked first; nothing moves if one cannot. */
  moveResources(ids: string[], parentId: string): Promise<{ moved: Resource[]; alreadyThere: Resource[] }> {
    return this.serial(async () => {
      const items = this.requireAll(ids)
      const target = this.resources.get(parentId)
      if (!target || target.type !== 'folder') throw new ResourceError(`No folder with ID ${parentId}`)
      if (target.archived) throw new ResourceError(`Folder ${parentId} is archived`)
      for (const item of items) {
        if (item.id === parentId || (item.type === 'folder' && this.isInside(target, item.id))) {
          throw new ResourceError(`${item.name} cannot move into itself`)
        }
        if (items.some((other) => other !== item && other.type === 'folder' && this.isInside(item, other.id))) {
          throw new ResourceError(`${item.name} is inside another folder being moved; pass the folder or its items, not both`)
        }
      }
      const alreadyThere = items.filter((i) => i.parentId === parentId)
      const moving = items.filter((i) => i.parentId !== parentId)
      for (const item of moving) {
        const extension = item.type === 'file' ? DOCUMENT_EXTENSION : ''
        await this.movePath(item.path, uniquePath(target.path, item.name, extension))
      }
      await this.scanNow()
      return { moved: moving.map((i) => this.resources.get(i.id)!), alreadyThere: alreadyThere.map((i) => this.resources.get(i.id)!) }
    })
  }

  /** Renames a file or folder on disk. An empty name leaves it unchanged. */
  renameResource(id: string, name: string): Promise<Resource> {
    return this.serial(async () => {
      const [item] = this.requireAll([id])
      const clean = name.trim().slice(0, MAX_NAME).replace(/[/\\:]/g, '-')
      if (!clean || clean === item.name) return item
      const extension = item.type === 'file' ? DOCUMENT_EXTENSION : ''
      const to = uniquePath(path.dirname(item.path), diskName(clean), extension, item.path)
      if (to !== item.path) await this.movePath(item.path, to)
      await this.scanNow()
      return this.keepLongName(id, clean, to)
    })
  }

  /** Archives or restores files and folders; a folder's contents follow it. All are checked first. */
  setArchived(ids: string[], archived: boolean): Promise<Resource[]> {
    return this.serial(async () => {
      const items = this.requireAll(ids)
      if (!archived) {
        // An item whose folder stays archived goes to the top level.
        for (const item of items) {
          const parent = item.parentId ? this.resources.get(item.parentId) : undefined
          if (parent?.archived && !ids.includes(parent.id)) {
            const extension = item.type === 'file' ? DOCUMENT_EXTENSION : ''
            await this.movePath(item.path, uniquePath(this.root, item.name, extension))
          }
        }
      }
      for (const item of items) {
        const entries = item.type === 'file' ? this.index.files : this.index.folders
        if (!entries[item.id]) continue
        if (archived) entries[item.id].archived = true
        else delete entries[item.id].archived
        // Restoring a folder restores everything inside it.
        if (!archived && item.type === 'folder') {
          for (const inner of this.all()) {
            if (!this.isInside(inner, item.id)) continue
            const innerEntries = inner.type === 'file' ? this.index.files : this.index.folders
            delete innerEntries[inner.id]?.archived
          }
        }
      }
      await this.saveIndex()
      await this.scanNow()
      return items.map((i) => this.resources.get(i.id)!)
    })
  }
}
