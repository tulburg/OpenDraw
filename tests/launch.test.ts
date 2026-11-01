// End-to-end acceptance checks for S-2 (first launch). Run with `bun run test:launch`.
// Prints one line per check and writes the results to tests/results/launch.json.
import { readdirSync, rmSync } from 'node:fs'
import path from 'node:path'

import { App, cleanProfile } from './cdp'
import { check, expect, finish, near, RESULTS_DIR } from './checks'

const CMD = process.platform === 'darwin' ? 4 : 2
const SHIFT = 8

const profile = cleanProfile()
let app = await App.launch(profile)

try {
  await check('Clean profile: window, layout and one fitted Desktop artboard; file on disk', async () => {
    const win = await app.eval(`opendrawTest.window()`)
    expect(win.title === 'OpenDraw', `title is ${win.title}`)
    expect(win.bounds.width === 1440 && win.bounds.height === 900, `size ${win.bounds.width}x${win.bounds.height}`)
    const regions = await app.eval(`['.top-bar', '.layers-panel', '.canvas', '.styles-panel']
      .map((s) => document.querySelector(s) !== null)`)
    expect(regions.every(Boolean), `regions present: ${regions}`)
    expect((await app.eval(`document.querySelector('[data-testid=file-name]').textContent`)) === 'Untitled', 'file name')
    const layers = await app.eval(`[...document.querySelectorAll('.layer-name')].map((e) => e.textContent)`)
    expect(layers.length === 1 && layers[0] === 'Desktop', `layers: ${layers}`)
    const stylesEmpty = await app.eval(`document.querySelector('.styles-panel .panel-empty')?.textContent ?? ''`)
    expect(stylesEmpty.length > 0, 'styles panel has no empty state')
    const files = readdirSync(profile.workspace)
    expect(files.length === 1 && files[0] === 'Untitled.opendraw', `workspace files: ${files}`)
    const canvas = await app.rect('.canvas')
    const board = await app.rect('[data-node-type=artboard]')
    expect(board.x >= canvas.x && board.x + board.width <= canvas.x + canvas.width, 'artboard wider than canvas')
    expect(board.y >= canvas.y && board.y + board.height <= canvas.y + canvas.height, 'artboard taller than canvas')
    const centered =
      near(board.x + board.width / 2, canvas.x + canvas.width / 2, 2) &&
      near(board.y + board.height / 2, canvas.y + canvas.height / 2, 2)
    expect(centered, 'artboard not centered')
    await app.screenshot(path.join(RESULTS_DIR, 'first-launch.png'))
    return `artboard ${Math.round(board.width)}x${Math.round(board.height)} on screen, zoom ${(await app.viewport()).zoom.toFixed(3)}`
  })

  await check('Artboard is a DOM element whose computed size and background match its CSS', async () => {
    const computed = await app.eval(`(() => { const s = getComputedStyle(document.querySelector('[data-node-type=artboard]'));
      return { width: s.width, height: s.height, background: s.backgroundColor, display: s.display } })()`)
    expect(computed.width === '1440px' && computed.height === '900px', `size ${computed.width} x ${computed.height}`)
    expect(computed.background === 'rgb(255, 255, 255)', `background ${computed.background}`)
    expect(computed.display === 'flex', `display ${computed.display}`)
    return `${computed.width} x ${computed.height}, ${computed.background}`
  })

  const canvas = await app.rect('.canvas')
  const center = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 }
  const empty = { x: canvas.x + 20, y: canvas.y + canvas.height - 20 }

  await check('Pan and zoom with every input; readout matches; limits 10% and 6400%', async () => {
    let v = await app.viewport()
    await app.wheel(center.x, center.y, 30, 40)
    let after = await app.viewport()
    expect(near(after.x, v.x - 30) && near(after.y, v.y - 40), 'trackpad scroll did not pan')

    v = after
    await app.keyDown(' ', 'Space', 32)
    await app.drag(center, { x: center.x + 100, y: center.y + 50 })
    await app.keyUp(' ', 'Space', 32)
    after = await app.viewport()
    expect(near(after.x, v.x + 100) && near(after.y, v.y + 50), 'space + drag did not pan')

    v = after
    await app.drag(center, { x: center.x - 60, y: center.y - 30 }, 'middle')
    after = await app.viewport()
    expect(near(after.x, v.x - 60) && near(after.y, v.y - 30), 'middle drag did not pan')

    v = after
    await app.wheel(center.x, center.y, 0, -20, 2)
    after = await app.viewport()
    expect(after.zoom > v.zoom, 'pinch (ctrl + wheel) did not zoom in')
    v = after
    await app.wheel(center.x, center.y, 0, 20, CMD)
    after = await app.viewport()
    expect(after.zoom < v.zoom, 'cmd/ctrl + scroll did not zoom out')

    await app.key('0', 'Digit0', CMD, 48)
    expect((await app.viewport()).zoom === 1, 'cmd/ctrl + 0 did not set 100%')
    await app.key('=', 'Equal', CMD, 187)
    expect((await app.viewport()).zoom === 2, 'cmd/ctrl + plus did not step to 200%')
    await app.key('-', 'Minus', CMD, 189)
    expect((await app.viewport()).zoom === 1, 'cmd/ctrl + minus did not step back to 100%')

    const readout = await app.eval(`document.querySelector('[data-testid=zoom-readout]').textContent`)
    expect(readout === '100%', `readout ${readout}`)

    for (let i = 0; i < 12; i++) await app.key('-', 'Minus', CMD, 189)
    expect((await app.viewport()).zoom === 0.1, 'zoom out did not stop at 10%')
    for (let i = 0; i < 20; i++) await app.wheel(center.x, center.y, 0, 50, CMD)
    expect((await app.viewport()).zoom === 0.1, 'wheel zoom went below 10%')
    expect((await app.eval(`document.querySelector('[data-testid=zoom-readout]').textContent`)) === '10%', 'readout at min')
    for (let i = 0; i < 12; i++) await app.key('=', 'Equal', CMD, 187)
    expect((await app.viewport()).zoom === 64, 'zoom in did not stop at 6400%')
    expect((await app.eval(`document.querySelector('[data-testid=zoom-readout]').textContent`)) === '6400%', 'readout at max')

    await app.key('!', 'Digit1', SHIFT, 49)
    const board = await app.rect('[data-node-type=artboard]')
    expect(near(board.x + board.width / 2, center.x, 2) && near(board.y + board.height / 2, center.y, 2), 'shift + 1 did not fit')
    return 'scroll, space + drag, middle drag, pinch, cmd/ctrl + scroll, cmd/ctrl + plus/minus/0, shift + 1'
  })

  await check('Select and deselect by click and Escape; the layers panel follows', async () => {
    const selected = () => app.eval(`!!document.querySelector('.selection-outline') && !!document.querySelector('.layer-row[data-selected]')`)
    await app.click(center.x, center.y)
    expect(await selected(), 'click on artboard did not select')
    await app.key('Escape', 'Escape', 0, 27)
    expect(!(await selected()), 'Escape did not deselect')
    const label = await app.rect('.artboard-label')
    await app.click(label.x + 5, label.y + label.height / 2)
    expect(await selected(), 'click on artboard name did not select')
    await app.click(empty.x, empty.y)
    expect(!(await selected()), 'click on empty canvas did not deselect')
    await app.eval(`document.querySelector('.layer-row').click(), true`)
    expect(await selected(), 'click in layers panel did not select')
    const stylesTitle = await app.eval(`document.querySelector('.styles-panel .panel-title')?.textContent`)
    expect(stylesTitle === 'Desktop', `styles panel shows ${stylesTitle}`)
    await app.key('Escape', 'Escape', 0, 27)
  })

  await check('UI follows the OS light and dark theme', async () => {
    const background = () => app.eval(`getComputedStyle(document.querySelector('.top-bar')).backgroundColor`)
    await app.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
    const dark = await background()
    await app.screenshot(path.join(RESULTS_DIR, 'dark.png'))
    await app.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
    const light = await background()
    expect(dark === 'rgb(44, 44, 44)' && light === 'rgb(255, 255, 255)', `dark ${dark}, light ${light}`)
    await app.send('Emulation.setEmulatedMedia', { features: [] })
    return `light ${light}, dark ${dark} (prefers-color-scheme emulated)`
  })

  await check('Window stops at the 960x600 minimum', async () => {
    const bounds = await app.eval(`opendrawTest.setSize(500, 400)`)
    expect(bounds.width === 960 && bounds.height === 600, `resized to ${bounds.width}x${bounds.height}`)
    return `asked 500x400, got ${bounds.width}x${bounds.height}`
  })

  // Leave a known state behind for the relaunch check.
  await app.eval(`opendrawTest.setSize(1200, 800)`)
  await app.eval(`opendrawTest.setPosition(120, 90)`)
  await Bun.sleep(300)
  const canvasNow = await app.rect('.canvas')
  await app.wheel(canvasNow.x + 100, canvasNow.y + 100, 0, -30, CMD)
  await app.wheel(canvasNow.x + 100, canvasNow.y + 100, 45, 25)
  const before = await app.viewport()
  const boundsBefore = (await app.eval(`opendrawTest.window()`)).bounds
  await Bun.sleep(600)
  await app.close()

  app = await App.launch(profile)
  await check('Relaunch: same file at the same pan and zoom; window keeps size and position', async () => {
    const files = readdirSync(profile.workspace)
    expect(files.length === 1, `workspace files: ${files}`)
    expect((await app.eval(`document.querySelector('[data-testid=file-name]').textContent`)) === 'Untitled', 'different file')
    const after = await app.viewport()
    expect(near(after.x, before.x, 0.01) && near(after.y, before.y, 0.01) && near(after.zoom, before.zoom, 1e-6),
      `viewport ${JSON.stringify(after)} vs ${JSON.stringify(before)}`)
    const bounds = (await app.eval(`opendrawTest.window()`)).bounds
    expect(bounds.width === boundsBefore.width && bounds.height === boundsBefore.height, `size ${bounds.width}x${bounds.height}`)
    expect(bounds.x === boundsBefore.x && bounds.y === boundsBefore.y, `position ${bounds.x},${bounds.y} vs ${boundsBefore.x},${boundsBefore.y}`)
    return `zoom ${after.zoom.toFixed(3)}, window ${bounds.width}x${bounds.height} at ${bounds.x},${bounds.y}`
  })
  await app.close()

  // Its own profile: this replaces the file behind the open window.
  const raceProfile = cleanProfile()
  app = await App.launch(raceProfile)
  await check('Overlapping first-run opens create one file (reload, React StrictMode)', async () => {
    for (const file of readdirSync(raceProfile.workspace)) rmSync(path.join(raceProfile.workspace, file))
    const paths = await app.eval<string[]>(
      `Promise.all([opendraw.openInitialDocument(), opendraw.openInitialDocument()]).then((r) => r.map((d) => d.path))`
    )
    const files = readdirSync(raceProfile.workspace)
    expect(paths[0] === paths[1], `different files: ${paths}`)
    expect(files.length === 1 && files[0] === 'Untitled.opendraw', `workspace files: ${files}`)
    return 'two concurrent opens returned the same Untitled.opendraw'
  })
} finally {
  await app.close()
}

await finish('launch')
