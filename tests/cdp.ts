// Launches the built OpenDraw app and drives its window over the Chrome DevTools Protocol.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { Subprocess } from 'bun'

const ROOT = path.resolve(import.meta.dir, '..')

export interface Profile {
  userData: string
  workspace: string
}

export function cleanProfile(): Profile {
  const base = mkdtempSync(path.join(tmpdir(), 'opendraw-test-'))
  return { userData: path.join(base, 'user-data'), workspace: path.join(base, 'workspace') }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class App {
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()

  private constructor(
    private proc: Subprocess,
    private ws: WebSocket
  ) {
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data))
      const waiter = msg.id ? this.pending.get(msg.id) : undefined
      if (!waiter) return
      this.pending.delete(msg.id)
      if (msg.error) waiter.reject(new Error(msg.error.message))
      else waiter.resolve(msg.result)
    }
  }

  static async launch(profile: Profile, port = 9333): Promise<App> {
    const electronPath = (await import(path.join(ROOT, 'node_modules/electron/index.js'))).default as string
    const proc = Bun.spawn([electronPath, ROOT, `--remote-debugging-port=${port}`], {
      env: {
        ...process.env,
        OPENDRAW_TEST: '1',
        OPENDRAW_USER_DATA: profile.userData,
        OPENDRAW_WORKSPACE: profile.workspace
      },
      stdout: process.env.OPENDRAW_TEST_LOGS ? 'inherit' : 'ignore',
      stderr: process.env.OPENDRAW_TEST_LOGS ? 'inherit' : 'ignore'
    })
    let target: { webSocketDebuggerUrl: string } | undefined
    for (let i = 0; i < 100 && !target; i++) {
      await sleep(100)
      try {
        const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[]
        target = targets.find((t) => t.type === 'page')
      } catch {
        // Not listening yet.
      }
    }
    if (!target) throw new Error('OpenDraw window did not appear')
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.onopen = resolve
      ws.onerror = reject
    })
    const app = new App(proc, ws)
    await app.waitFor("document.querySelector('[data-node-type=artboard]') !== null")
    return app
  }

  send(method: string, params: object = {}): Promise<any> {
    const id = this.nextId++
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  async eval<T = any>(expression: string): Promise<T> {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? expression)
    return result.result.value as T
  }

  async waitFor(expression: string, timeoutMs = 10_000): Promise<void> {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      try {
        if (await this.eval<boolean>(expression)) return
      } catch {
        // The page may still be loading.
      }
      await sleep(50)
    }
    throw new Error(`Timed out waiting for ${expression}`)
  }

  /** Viewport as rendered: the canvas world's translate and scale. */
  viewport(): Promise<{ x: number; y: number; zoom: number }> {
    return this.eval(`(() => { const d = document.querySelector('.canvas-world').dataset;
      return { x: +d.x, y: +d.y, zoom: +d.zoom } })()`)
  }

  async rect(selector: string): Promise<{ x: number; y: number; width: number; height: number }> {
    return this.eval(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
  }

  async wheel(x: number, y: number, deltaX: number, deltaY: number, modifiers = 0) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY, modifiers })
    await sleep(30)
  }

  async click(x: number, y: number, button: 'left' | 'middle' = 'left') {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: 1, clickCount: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 })
    await sleep(30)
  }

  async drag(from: { x: number; y: number }, to: { x: number; y: number }, button: 'left' | 'middle' = 'left') {
    const buttons = button === 'left' ? 1 : 4
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button, buttons, clickCount: 1 })
    for (let i = 1; i <= 5; i++) {
      const point = { x: from.x + ((to.x - from.x) * i) / 5, y: from.y + ((to.y - from.y) * i) / 5 }
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button, buttons })
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...to, button, clickCount: 1 })
    await sleep(30)
  }

  /** A left click with modifiers (1 alt, 2 ctrl, 4 meta/cmd, 8 shift); clickCount 2 is a double-click. */
  async clickWith(x: number, y: number, modifiers: number, clickCount = 1) {
    for (let count = 1; count <= clickCount; count++) {
      const base = { x, y, button: 'left', modifiers, clickCount: count }
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: 1 })
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 })
    }
    await sleep(30)
  }

  async mouseMove(x: number, y: number, buttons = 0, modifiers = 0) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: buttons ? 'left' : 'none', buttons, modifiers })
  }

  async mouseDown(x: number, y: number, modifiers = 0) {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, modifiers })
  }

  async mouseUp(x: number, y: number, modifiers = 0) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, modifiers })
    await sleep(30)
  }

  /** Runs an editing command (copy, cut, paste) the way the keyboard shortcut does. */
  async command(name: 'copy' | 'cut' | 'paste', key: string) {
    const base = { key, code: `Key${key.toUpperCase()}`, modifiers: process.platform === 'darwin' ? 4 : 2, commands: [name] }
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base, commands: undefined })
    await sleep(50)
  }

  /** Presses a key. Modifiers: 1 alt, 2 ctrl, 4 meta/cmd, 8 shift. */
  async key(key: string, code: string, modifiers = 0, keyCode = 0) {
    const base = { key, code, modifiers, windowsVirtualKeyCode: keyCode }
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    await sleep(30)
  }

  async keyDown(key: string, code: string, keyCode = 0) {
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode })
  }

  async keyUp(key: string, code: string, keyCode = 0) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode })
  }

  async screenshot(file: string) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    await Bun.write(file, Buffer.from(data, 'base64'))
  }

  /** Closes the window the way a user would, so the app saves its state, and waits for exit. */
  async close() {
    await this.eval('window.close(), true').catch(() => undefined)
    const exited = await Promise.race([this.proc.exited.then(() => true), sleep(5000).then(() => false)])
    if (!exited) this.proc.kill()
    this.ws.close()
  }

  /** Stops the app and waits for it to exit, so the next launch can use the debugging port. */
  async kill() {
    this.proc.kill()
    const exited = await Promise.race([this.proc.exited.then(() => true), sleep(5000).then(() => false)])
    if (!exited) {
      this.proc.kill('SIGKILL')
      await this.proc.exited
    }
    this.ws.close()
  }

  /** Simulates a crash: no close events, no flush. */
  async crash() {
    this.proc.kill('SIGKILL')
    await this.proc.exited
    this.ws.close()
  }

  /** Quits through the app (like cmd+Q) and waits for exit. */
  async quit() {
    await this.eval('opendrawTest.quit(), true').catch(() => undefined)
    const exited = await Promise.race([this.proc.exited.then(() => true), sleep(5000).then(() => false)])
    if (!exited) throw new Error('App did not quit within 5 s')
    this.ws.close()
  }
}
