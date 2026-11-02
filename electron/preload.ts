import { contextBridge, ipcRenderer } from 'electron'

import type { DesignDocument, OpenedDocument, Viewport } from '../shared/document'
import type { ExportedFile, ExportItem } from './export'
import type { ListedResource } from './resource-tools'

type MainRequestHandler = (payload: unknown) => unknown | Promise<unknown>
const mainRequestHandlers = new Map<string, MainRequestHandler>()

ipcRenderer.on('renderer:request', async (_event, id: number, channel: string, payload: unknown) => {
  const handler = mainRequestHandlers.get(channel)
  try {
    if (!handler) throw new Error(`Nothing in this window answers ${channel}`)
    ipcRenderer.send('renderer:response', id, true, await handler(payload))
  } catch (err) {
    ipcRenderer.send('renderer:response', id, false, err instanceof Error ? err.message : String(err))
  }
})

const api = {
  /** Answers requests the main process sends with requestRenderer (electron/rpc.ts). */
  handleMainRequest: (channel: string, handler: MainRequestHandler): (() => void) => {
    mainRequestHandlers.set(channel, handler)
    return () => {
      if (mainRequestHandlers.get(channel) === handler) mainRequestHandlers.delete(channel)
    }
  },
  openInitialTabs: (): Promise<{ tabs: OpenedDocument[]; activeId: string }> => ipcRenderer.invoke('workspace:open-initial'),
  openFile: (id: string): Promise<OpenedDocument> => ipcRenderer.invoke('workspace:open', id),
  /** Reports the open tabs in order and the one in front, so they come back on the next launch. */
  setTabs: (ids: string[], activeId: string | null): Promise<void> => ipcRenderer.invoke('workspace:tabs', ids, activeId),
  listResources: (args: { parentId?: string; includeArchived?: boolean; limit?: number }): Promise<{ items: ListedResource[]; truncated?: boolean }> =>
    ipcRenderer.invoke('workspace:list', args),
  createFile: (args: { name?: string; parentId?: string; cloneFileId?: string }): Promise<{ id: string; name: string }> =>
    ipcRenderer.invoke('workspace:create-file', args),
  createFolder: (args: { name?: string; parentId?: string }): Promise<{ id: string; name: string }> =>
    ipcRenderer.invoke('workspace:create-folder', args),
  moveResources: (args: { resourceIds: string[]; parentId: string }): Promise<unknown> => ipcRenderer.invoke('workspace:move', args),
  renameResource: (args: { resourceId: string; name: string }): Promise<unknown> => ipcRenderer.invoke('workspace:rename', args),
  setArchived: (args: { resourceIds: string[] }, archived: boolean): Promise<unknown> =>
    ipcRenderer.invoke('workspace:archive', args, archived),
  /** A file's saved document, for thumbnails in the file browser. */
  readFile: (id: string): Promise<DesignDocument> => ipcRenderer.invoke('workspace:read-file', id),
  /** The export folder the user picked, or null before they pick one (S-15). */
  googleFonts: (): Promise<{ family: string; faces: { weight: number; style: 'normal' | 'italic' }[] }[] | null> => ipcRenderer.invoke('fonts:google'),
  userName: (): Promise<string | null> => ipcRenderer.invoke('user:name'),
  setUserName: (name: string): Promise<void> => ipcRenderer.invoke('user:set-name', name),
  exportDir: (): Promise<string | null> => ipcRenderer.invoke('export:dir'),
  chooseExportDir: (): Promise<string | null> => ipcRenderer.invoke('export:choose-dir'),
  runExport: (items: ExportItem[]): Promise<{ files?: ExportedFile[]; cancelled?: boolean }> => ipcRenderer.invoke('export:run', items),
  /** A 1x PNG of the layer alone, base64. */
  exportPreview: (item: ExportItem): Promise<string> => ipcRenderer.invoke('export:preview', item),
  /** A file was renamed or moved on disk; its tab saves to the new path. */
  onFileMoved: (handler: (id: string, path: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, id: string, path: string) => handler(id, path)
    ipcRenderer.on('workspace:file-moved', listener)
    return () => ipcRenderer.removeListener('workspace:file-moved', listener)
  },
  saveDocument: (file: string, document: DesignDocument): Promise<void> =>
    ipcRenderer.invoke('document:save', file, document),
  /** Blocks until written; only for page unload. Returns an error message, or null. */
  saveDocumentSync: (file: string, document: DesignDocument): string | null =>
    ipcRenderer.sendSync('document:save-sync', file, document),
  /** The app asks for pending saves to be written before a window closes or the app quits. */
  onFlushRequest: (flush: () => Promise<void>) => {
    ipcRenderer.on('document:flush', () => {
      void flush().finally(() => ipcRenderer.send('document:flushed'))
    })
  },
  /** Undo and Redo picked from the Edit menu. */
  onEditCommand: (handler: (command: 'undo' | 'redo') => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, command: 'undo' | 'redo') => handler(command)
    ipcRenderer.on('edit:command', listener)
    return () => ipcRenderer.removeListener('edit:command', listener)
  },
  saveViewport: (file: string, pageId: string, viewport: Viewport): Promise<void> =>
    ipcRenderer.invoke('viewport:save', file, pageId, viewport),
  platform: process.platform
}

contextBridge.exposeInMainWorld('opendraw', api)

if (process.env.OPENDRAW_TEST) {
  contextBridge.exposeInMainWorld('opendrawTest', {
    window: () => ipcRenderer.invoke('test:window'),
    setSize: (width: number, height: number) => ipcRenderer.invoke('test:set-size', width, height),
    setPosition: (x: number, y: number) => ipcRenderer.invoke('test:set-position', x, y),
    setExportDir: (dir: string) => ipcRenderer.invoke('test:set-export-dir', dir),
    quit: () => ipcRenderer.invoke('test:quit')
  })
}

export type OpenDrawAPI = typeof api
