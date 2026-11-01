// A hidden, offscreen window that renders one artboard at a time for get_screenshot and
// get_computed_styles. It loads the app page with #render (src/render/RenderView.tsx).
import path from 'node:path'

import { BrowserWindow, nativeImage } from 'electron'

import type { DesignNode } from '../../shared/document'
import { requestRenderer } from '../rpc'

let renderWindow: BrowserWindow | null = null
let loading: Promise<BrowserWindow> | null = null
/** Renders run one at a time; each one resizes and redraws the shared window. */
let queue: Promise<unknown> = Promise.resolve()

export interface RenderTarget {
  preload: string
  devServer?: string
  indexFile: string
}

function load(target: RenderTarget): Promise<BrowserWindow> {
  if (renderWindow && !renderWindow.isDestroyed()) return Promise.resolve(renderWindow)
  loading ??= (async () => {
    const win = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      // Lets the window grow past the screen size for large artboards.
      enableLargerThanScreen: true,
      webPreferences: {
        preload: target.preload,
        contextIsolation: true,
        sandbox: true,
        offscreen: true,
        // Its own session: Electron shares zoom per origin within a session, so without this the
        // zoom used for scaled screenshots would also zoom the editor window.
        partition: 'opendraw-render',
        backgroundThrottling: false
      }
    })
    win.webContents.setFrameRate(60)
    if (target.devServer) await win.loadURL(`${target.devServer}#render`)
    else await win.loadFile(target.indexFile, { hash: 'render' })
    win.on('closed', () => {
      renderWindow = null
      loading = null
    })
    renderWindow = win
    return win
  })().catch((err) => {
    loading = null
    throw err
  })
  return loading
}

/** Runs `use` with the artboard drawn at `scale` in the render window. */
function withArtboard<T>(target: RenderTarget, artboard: DesignNode, scale: number, use: (win: BrowserWindow) => Promise<T>) {
  const run = queue.then(async () => {
    const win = await load(target)
    const width = Number.parseFloat(String(artboard.style.width)) || 1
    const height = Number.parseFloat(String(artboard.style.height)) || 1
    win.webContents.setZoomFactor(scale)
    win.setContentSize(Math.ceil(width * scale), Math.ceil(height * scale))
    await requestRenderer(win.webContents, 'render:show', artboard)
    return use(win)
  })
  queue = run.catch(() => undefined)
  return run
}

export async function screenshot(target: RenderTarget, artboard: DesignNode, nodeId: string, scale: number): Promise<Buffer> {
  return withArtboard(target, artboard, scale, async (win) => {
    const box = await win.webContents.executeJavaScript(`(() => {
      const r = document.querySelector('[data-node-id="${escapeSelectorId(nodeId)}"]').getBoundingClientRect()
      return { x: r.left, y: r.top, width: r.width, height: r.height }
    })()`)
    // Rects are in CSS pixels; the page is zoomed by `scale`.
    const rect = {
      x: Math.round(box.x * scale),
      y: Math.round(box.y * scale),
      width: Math.max(1, Math.round(box.width * scale)),
      height: Math.max(1, Math.round(box.height * scale))
    }
    let image = await win.webContents.capturePage(rect)
    const size = image.getSize()
    if (size.width !== rect.width || size.height !== rect.height) {
      image = nativeImage.createFromBuffer(image.resize({ width: rect.width, height: rect.height, quality: 'best' }).toPNG())
    }
    return image.toPNG()
  })
}

/** Computed styles worth reporting: layout, box model, typography, color and effects. */
const COMPUTED_PROPERTIES = [
  'display', 'position', 'top', 'left', 'right', 'bottom', 'width', 'height', 'minWidth', 'minHeight', 'maxWidth',
  'maxHeight', 'boxSizing', 'flexDirection', 'flexWrap', 'justifyContent', 'alignItems', 'alignSelf', 'flexGrow',
  'flexShrink', 'flexBasis', 'rowGap', 'columnGap', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'overflow', 'zIndex', 'backgroundColor', 'backgroundImage', 'color', 'opacity', 'fontFamily', 'fontSize',
  'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'textAlign', 'textDecorationLine', 'textTransform',
  'whiteSpace', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderTopStyle',
  'borderTopColor', 'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius',
  'boxShadow', 'filter', 'backdropFilter', 'transform', 'rotate', 'mixBlendMode', 'objectFit'
]

export async function computedStyles(
  target: RenderTarget,
  artboard: DesignNode,
  nodeIds: string[]
): Promise<Record<string, Record<string, string>>> {
  return withArtboard(target, artboard, 1, (win) =>
    win.webContents.executeJavaScript(`(() => {
      const properties = ${JSON.stringify(COMPUTED_PROPERTIES)}
      const result = {}
      for (const id of ${JSON.stringify(nodeIds)}) {
        const el = document.querySelector('[data-node-id="' + CSS.escape(id) + '"]')
        if (!el) continue
        const computed = getComputedStyle(el)
        const styles = {}
        for (const p of properties) {
          const value = computed[p]
          if (value !== '' && value !== undefined) styles[p] = value
        }
        result[id] = styles
      }
      return result
    })()`)
  )
}

/** Escapes a node ID for a double-quoted CSS attribute selector inside generated script. */
function escapeSelectorId(id: string): string {
  return id.replace(/["\\]/g, '\\$&').replace(/[\n\r]/g, '')
}

export function closeRenderWindow() {
  if (renderWindow && !renderWindow.isDestroyed()) renderWindow.destroy()
  renderWindow = null
  loading = null
}

export const renderTargetFor = (here: string): RenderTarget => ({
  preload: path.join(here, 'preload.cjs'),
  devServer: process.env.VITE_DEV_SERVER_URL,
  indexFile: path.join(here, '../dist/index.html')
})
