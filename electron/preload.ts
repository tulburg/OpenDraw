import { contextBridge, ipcRenderer } from 'electron'

import type { DesignDocument, OpenedDocument, Viewport } from '../shared/document'

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
  openInitialDocument: (): Promise<OpenedDocument> => ipcRenderer.invoke('document:open-initial'),
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
    quit: () => ipcRenderer.invoke('test:quit')
  })
}

export type OpenDrawAPI = typeof api
