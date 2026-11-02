import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow, dialog, ipcMain, Menu, screen } from 'electron'

import { FILE_ITEMS, VIEW_ITEMS } from '../shared/commands'
import type { DesignDocument, Viewport } from '../shared/document'
import { closeRenderWindow, RENDER_PARTITION, renderTargetFor } from './mcp/render'
import { type DiscoveryInfo, startMcpServer } from './mcp/server'
import { appInfo } from './connect'
import { handleAssets, registerAssetScheme } from './assets'
import { googleFonts } from './fonts'
import { exportDir, type ExportItem, runExports } from './export'
import { exportNode } from './mcp/render'
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

registerAssetScheme()

const here = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_SIZE = { width: 1440, height: 900 }
const MIN_SIZE = { width: 960, height: 600 }
const SAVE_BOUNDS_DELAY_MS = 300

app.setName('OpenDraw')

// Tests point these at throwaway folders so a launch starts from a clean profile. A dev build keeps
// its own data, apart from the installed app's (S-20 Req 5); the workspace follows in workspace.ts.
if (process.env.OPENDRAW_USER_DATA) app.setPath('userData', process.env.OPENDRAW_USER_DATA)
else if (!app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'OpenDraw Dev'))

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
const ARRANGE_ITEMS: ({ command: string; label: string; accelerator?: string } | null)[] = [
  { command: 'wrap', label: 'Wrap in Frame', accelerator: 'CmdOrCtrl+Alt+G' },
  { command: 'unwrap', label: 'Unwrap', accelerator: 'CmdOrCtrl+Shift+G' },
  null,
  { command: 'align-left', label: 'Align Left' },
  { command: 'align-center', label: 'Align Center' },
  { command: 'align-right', label: 'Align Right' },
  { command: 'align-top', label: 'Align Top' },
  { command: 'align-middle', label: 'Align Middle' },
  { command: 'align-bottom', label: 'Align Bottom' },
  null,
  { command: 'distribute-horizontal', label: 'Distribute Horizontally' },
  { command: 'distribute-vertical', label: 'Distribute Vertically' },
  null,
  { command: 'bring-to-front', label: 'Bring to Front', accelerator: 'CmdOrCtrl+Shift+]' },
  { command: 'bring-forward', label: 'Bring Forward', accelerator: 'CmdOrCtrl+]' },
  { command: 'send-backward', label: 'Send Backward', accelerator: 'CmdOrCtrl+[' },
  { command: 'send-to-back', label: 'Send to Back', accelerator: 'CmdOrCtrl+Shift+[' }
]

ipcMain.on('arrange:state', (_event, state: Record<string, boolean>) => {
  const menu = Menu.getApplicationMenu()
  for (const [command, enabled] of Object.entries(state)) {
    const item = menu?.getMenuItemById(`arrange-${command}`)
    if (item) item.enabled = enabled
  }
})

function sendEdit(command: 'undo' | 'redo') {
  BrowserWindow.getFocusedWindow()?.webContents.send('edit:command', command)
}

// No zoom roles: cmd/ctrl + plus, minus and 0 belong to the canvas, not to page zoom.
// Undo and Redo, and the File and View items (S-24), show their shortcuts but do not register them,
// so the keys reach the renderer.
function buildMenu() {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { label: `About ${app.name}`, click: () => showAppDialog('about') },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: 'File',
      submenu: [
        ...FILE_ITEMS.map((item): Electron.MenuItemConstructorOptions =>
          item === null
            ? { type: 'separator' }
            : {
                label: item.label,
                ...(item.accelerator ? { accelerator: item.accelerator, registerAccelerator: false } : {}),
                click: (_menuItem, window) => {
                  const win = window instanceof BrowserWindow ? window : BrowserWindow.getFocusedWindow()
                  if (item.command === 'close-window') win?.close()
                  else win?.webContents.send('file:command', item.command)
                }
              }
        ),
        ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const }])
      ]
    },
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
      label: 'Arrange',
      // Shortcuts show here but reach the renderer, which runs them on the selection.
      submenu: ARRANGE_ITEMS.map((item) =>
        item === null
          ? { type: 'separator' as const }
          : {
              id: `arrange-${item.command}`,
              label: item.label,
              enabled: false,
              ...(item.accelerator ? { accelerator: item.accelerator, registerAccelerator: false } : {}),
              click: () => BrowserWindow.getFocusedWindow()?.webContents.send('arrange:command', item.command)
            }
      )
    },
    {
      label: 'View',
      submenu: [
        ...VIEW_ITEMS.map((item) => ({
          label: item.label,
          accelerator: item.accelerator,
          registerAccelerator: false,
          click: (_menuItem: Electron.MenuItem, window: Electron.BaseWindow | undefined) =>
            (window instanceof BrowserWindow ? window : BrowserWindow.getFocusedWindow())?.webContents.send('view:command', item.command)
        })),
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Connect an Agent...', click: () => showAppDialog('connect') },
        ...(isMac ? [] : [{ label: `About ${app.name}`, click: () => showAppDialog('about') }])
      ]
    }
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
      sandbox: true,
      // Tests measure frame times, which a window behind others would throttle.
      backgroundThrottling: !process.env.OPENDRAW_TEST
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
let mcpInfo: DiscoveryInfo | null = null

ipcMain.handle('app:info', () => appInfo(here, mcpInfo))

/** Opens the Connect an agent dialog or the About window in the focused window (S-20). */
function showAppDialog(which: 'connect' | 'about') {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow
  win?.webContents.send('app:show-dialog', which)
}

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
// Exports from the styles panel (S-15 Req 2): to the folder the user picked, asking the first time.
const exportTarget = renderTargetFor(here)
async function chooseExportDir(win: BrowserWindow | null): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'Export to folder',
    defaultPath: await exportDir(),
    properties: ['openDirectory', 'createDirectory']
  }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  if (result.canceled || !result.filePaths[0]) return null
  const dir = result.filePaths[0]
  await updateState((s) => {
    s.exportDir = dir
  })
  return dir
}
ipcMain.handle('fonts:google', async () => {
  try {
    return [...(await googleFonts()).values()]
  } catch {
    return null
  }
})
ipcMain.handle('user:name', async () => (await readState()).userName ?? null)
ipcMain.handle('user:set-name', (_event, name: string) =>
  updateState((s) => {
    s.userName = name
  })
)
ipcMain.handle('export:dir', async () => ((await readState()).exportDir ? exportDir() : null))
ipcMain.handle('export:choose-dir', (event) => chooseExportDir(BrowserWindow.fromWebContents(event.sender)))
ipcMain.handle('export:run', async (event, items: ExportItem[]) => {
  const dir = (await readState()).exportDir ?? (await chooseExportDir(BrowserWindow.fromWebContents(event.sender)))
  if (!dir) return { cancelled: true }
  return { files: await runExports(exportTarget, items, dir) }
})
ipcMain.handle('export:preview', async (_event, item: ExportItem) =>
  (await exportNode(exportTarget, item.artboard, item.nodeId, { format: 'png', scale: '1x' })).toString('base64')
)

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
  ipcMain.handle('test:set-export-dir', (_event, dir: string) =>
    updateState((s) => {
      s.exportDir = dir
    })
  )
  ipcMain.handle('test:show-dialog', (_event, which: 'connect' | 'about') => showAppDialog(which))
  /** Clicks an application menu item by its labels, e.g. ['View', 'Zoom In'], as the user would. */
  ipcMain.handle('test:menu', (event, labels: string[]) => {
    let items = Menu.getApplicationMenu()?.items ?? []
    let item: Electron.MenuItem | undefined
    for (const label of labels) {
      item = items.find((i) => i.label === label)
      items = item?.submenu?.items ?? []
    }
    if (!item) throw new Error(`No menu item ${labels.join(' > ')}`)
    item.click(undefined, BrowserWindow.fromWebContents(event.sender) ?? undefined, event.sender)
    return true
  })
  ipcMain.handle('test:quit', () => {
    setImmediate(() => app.quit())
  })
}

app.whenReady().then(async () => {
  handleAssets([RENDER_PARTITION])
  buildMenu()
  await createWindow()
  try {
    const server = await startMcpServer({ getWindow: () => mainWindow, renderTarget: exportTarget })
    stopMcpServer = server.stop
    mcpInfo = server.info
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
