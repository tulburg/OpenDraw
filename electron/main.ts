import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow, ipcMain, Menu, screen } from 'electron'

import type { DesignDocument, Viewport } from '../shared/document'
import { closeRenderWindow, renderTargetFor } from './mcp/render'
import { startMcpServer } from './mcp/server'
import * as resources from './resource-tools'
import {
  fileMoved,
  flushState,
  openFileById,
  openInitialTabs,
  readState,
  saveDocument,
  saveDocumentSync,
  saveViewport,
  setTabs,
  updateState,
  workspace
} from './workspace'

const here = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_SIZE = { width: 1440, height: 900 }
const MIN_SIZE = { width: 960, height: 600 }
const SAVE_BOUNDS_DELAY_MS = 300

// Tests point these at throwaway folders so a launch starts from a clean profile.
if (process.env.OPENDRAW_USER_DATA) app.setPath('userData', process.env.OPENDRAW_USER_DATA)

app.setName('OpenDraw')

/** The saved bounds, if they still fit on a connected display. */
async function restoredBounds() {
  const saved = (await readState()).window
  if (!saved) return null
  const area = screen.getDisplayMatching(saved).workArea
  const fits =
    saved.x >= area.x &&
    saved.y >= area.y &&
    saved.x + saved.width <= area.x + area.width &&
    saved.y + saved.height <= area.y + area.height
  return fits ? saved : null
}

/** Sends an edit command to the focused window's renderer, which decides between document and text undo. */
function sendEdit(command: 'undo' | 'redo') {
  BrowserWindow.getFocusedWindow()?.webContents.send('edit:command', command)
}

// No zoom roles: cmd/ctrl + plus, minus and 0 belong to the canvas, not to page zoom.
// Undo and Redo show their shortcuts but do not register them, so the keys reach the renderer.
function buildMenu() {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', registerAccelerator: false, click: () => sendEdit('undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', registerAccelerator: false, click: () => sendEdit('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function createWindow() {
  const bounds = await restoredBounds()
  const win = new BrowserWindow({
    ...(bounds ?? DEFAULT_SIZE),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    title: 'OpenDraw',
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true
    }
  })
  // Keep the window title fixed; the file name is shown in the top bar.
  win.on('page-title-updated', (event) => event.preventDefault())
  win.once('ready-to-show', () => win.show())

  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
    // The hidden render window would otherwise keep the app running.
    closeRenderWindow()
  })

  // Bounds are saved as the window moves and resizes, since not every way of closing emits 'close'.
  let saveTimer: NodeJS.Timeout | undefined
  const saveBounds = () => {
    clearTimeout(saveTimer)
    if (win.isDestroyed()) return
    const normal = win.getNormalBounds()
    void updateState((state) => {
      state.window = normal
    })
  }
  const scheduleSaveBounds = () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(saveBounds, SAVE_BOUNDS_DELAY_MS)
  }
  win.on('resize', scheduleSaveBounds)
  win.on('move', scheduleSaveBounds)
  win.on('close', saveBounds)

  // Before the window goes away, ask the renderer to write any pending autosave (S-3 Req 6).
  let documentFlushed = false
  win.on('close', (event) => {
    if (documentFlushed) return
    event.preventDefault()
    void flushRenderer(win).finally(() => {
      documentFlushed = true
      if (quitting) app.quit()
      else win.close()
    })
  })

  const devServer = process.env.VITE_DEV_SERVER_URL
  if (devServer) await win.loadURL(devServer)
  else await win.loadFile(path.join(here, '../dist/index.html'))
}

let mainWindow: BrowserWindow | null = null
let stopMcpServer: (() => void) | null = null

const FLUSH_TIMEOUT_MS = 3000
let quitting = false
app.on('before-quit', () => {
  quitting = true
})

/** Resolves when the renderer reports its pending save is written, or after a timeout. */
function flushRenderer(win: BrowserWindow): Promise<void> {
  if (win.webContents.isDestroyed() || win.webContents.isCrashed()) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, FLUSH_TIMEOUT_MS)
    function done() {
      clearTimeout(timer)
      ipcMain.removeListener('document:flushed', onFlushed)
      resolve()
    }
    function onFlushed(event: Electron.IpcMainEvent) {
      if (event.sender === win.webContents) done()
    }
    ipcMain.on('document:flushed', onFlushed)
    win.webContents.send('document:flush')
  })
}

ipcMain.handle('workspace:open-initial', () => openInitialTabs())
ipcMain.handle('workspace:open', (_event, id: string) => openFileById(id))
ipcMain.handle('workspace:tabs', (_event, ids: string[], activeId: string | null) => setTabs(ids, activeId))
// The file browser (S-13 Req 2) uses the same operations as the MCP resource tools.
ipcMain.handle('workspace:list', (_event, args) => resources.listResources(args))
ipcMain.handle('workspace:create-file', (_event, args) => resources.createFile(args, () => mainWindow))
ipcMain.handle('workspace:create-folder', (_event, args) => resources.createFolder(args))
ipcMain.handle('workspace:move', (_event, args) => resources.moveResources(args))
ipcMain.handle('workspace:rename', (_event, args) => resources.renameResource(args))
ipcMain.handle('workspace:archive', (_event, args, archived: boolean) => resources.setArchived(args, archived))
ipcMain.handle('workspace:read-file', (_event, id: string) => resources.readSavedDocument(id))
workspace().onFileMoved = (id, from, to) => {
  fileMoved(from, to)
  mainWindow?.webContents.send('workspace:file-moved', id, to)
}
ipcMain.handle('document:save', (_event, file: string, document: DesignDocument) => saveDocument(file, document))
ipcMain.on('document:save-sync', (event, file: string, document: DesignDocument) => {
  try {
    saveDocumentSync(file, document)
    event.returnValue = null
  } catch (err) {
    event.returnValue = String(err)
  }
})
ipcMain.handle('viewport:save', (_event, file: string, pageId: string, viewport: Viewport) =>
  saveViewport(file, pageId, viewport)
)

if (process.env.OPENDRAW_TEST) {
  ipcMain.handle('test:window', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)!
    return { title: win.getTitle(), bounds: win.getBounds(), minimumSize: win.getMinimumSize() }
  })
  ipcMain.handle('test:set-size', (event, width: number, height: number) => {
    const win = BrowserWindow.fromWebContents(event.sender)!
    win.setSize(width, height)
    return win.getBounds()
  })
  ipcMain.handle('test:set-position', (event, x: number, y: number) => {
    BrowserWindow.fromWebContents(event.sender)!.setPosition(x, y)
  })
  ipcMain.handle('test:quit', () => {
    setImmediate(() => app.quit())
  })
}

app.whenReady().then(async () => {
  buildMenu()
  await createWindow()
  try {
    const server = await startMcpServer({ getWindow: () => mainWindow, renderTarget: renderTargetFor(here) })
    stopMcpServer = server.stop
  } catch (err) {
    console.error('[mcp] could not start the MCP server', err)
  }
  app.on('activate', () => {
    if (!mainWindow) void createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || process.env.OPENDRAW_TEST) app.quit()
})

// The window's bounds are written as it closes; hold the quit until that write lands.
let flushed = false
app.on('will-quit', (event) => {
  stopMcpServer?.()
  stopMcpServer = null
  if (flushed) return
  event.preventDefault()
  void flushState().finally(() => {
    flushed = true
    app.quit()
  })
})
