// End-to-end acceptance checks for S-24 (File and View menus): new file, close tab, duplicate and
// rename, and the zoom commands from the keys, the View menu and the zoom readout. Run with
// `bun run test:menus`.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { App, cleanProfile } from './cdp'
import { check, expect, finish } from './checks'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const CMD = process.platform === 'darwin' ? 4 : 2
const SHIFT = 8
const FIT_PADDING = 64

const profile = cleanProfile()
mkdirSync(path.join(profile.workspace, 'Projects'), { recursive: true })
writeFileSync(
  path.join(profile.workspace, 'Alpha.opendraw'),
  JSON.stringify({
    format: 'opendraw',
    version: 1,
    id: 'alpha',
    name: 'Alpha',
    pages: [
      {
        id: 'page-1',
        name: 'Page 1',
        nodes: [
          {
            id: 'desktop',
            type: 'artboard',
            name: 'Desktop',
            style: { left: '0px', top: '0px', width: '1200px', height: '800px', backgroundColor: '#ffffff' },
            children: [{ id: 'small', type: 'frame', name: 'Small', style: { position: 'absolute', left: '900px', top: '600px', width: '40px', height: '30px', backgroundColor: '#ff0000' }, children: [] }]
          }
        ]
      }
    ]
  })
)

const app = await App.launch(profile, 9391)
const tabNames = () => app.eval<string[]>(`[...document.querySelectorAll('[data-testid=tab] .tab-name, [data-testid=tab] .tab-rename')].map((el) => el.textContent || el.value)`)
const activeName = () => app.eval<string | null>(`document.querySelector('[data-testid=tab].active .tab-name')?.textContent ?? null`)
const zoom = () => app.eval<number>(`Number(document.querySelector('.canvas-world').dataset.zoom)`)
const menu = (...labels: string[]) => app.eval(`window.opendrawTest.menu(${JSON.stringify(labels)})`)

try {
  await check('Cmd+N opens a new untitled tab saved on disk; Cmd+W closes it and the window stays, showing the previous tab, then the home view', async () => {
    await app.waitFor(`document.querySelector('[data-testid=tab].active .tab-name')?.textContent === 'Alpha'`)
    await app.key('n', 'KeyN', CMD, 78)
    await app.waitFor(`document.querySelectorAll('[data-testid=tab]').length === 2 && document.querySelector('[data-testid=tab].active .tab-name')?.textContent === 'Untitled'`)
    const file = path.join(profile.workspace, 'Untitled.opendraw')
    expect(existsSync(file), `no ${file}`)
    await app.key('w', 'KeyW', CMD, 87)
    await app.waitFor(`document.querySelectorAll('[data-testid=tab]').length === 1`)
    const back = await activeName()
    expect(back === 'Alpha', `front tab after Cmd+W: ${back}`)
    await app.key('w', 'KeyW', CMD, 87)
    await app.waitFor(`!!document.querySelector('[data-testid=file-browser]') && document.querySelectorAll('[data-testid=tab]').length === 0`)
    // The window is still there: the page answers.
    expect((await app.eval<number>(`1 + 1`)) === 2, 'the window closed')
    return `Untitled tab and ${path.basename(file)} on disk; Cmd+W showed Alpha, then the home view`
  })

  await check('New File from a folder in the file browser puts the file in that folder', async () => {
    await app.eval(`document.querySelector('[data-resource-type=folder]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })), true`)
    await app.waitFor(`![...document.querySelectorAll('[data-resource-type=folder]')].some((el) => el.textContent.includes('Projects'))`)
    await menu('File', 'New File')
    await app.waitFor(`document.querySelector('[data-testid=tab].active .tab-name')?.textContent === 'Untitled'`)
    const file = path.join(profile.workspace, 'Projects', 'Untitled.opendraw')
    expect(existsSync(file), `no ${file}`)
    await menu('File', 'Close Tab')
    await app.waitFor(`!!document.querySelector('[data-testid=file-browser]')`)
    return `File > New File made Projects/Untitled.opendraw; File > Close Tab closed it`
  })

  await check('Shift+2 with a small frame selected centers it and zooms so it fills the view with padding', async () => {
    await app.eval(`document.querySelector('[data-testid=browser-all]').click(), true`)
    await app.waitFor(`!!document.querySelector('[data-resource-id=alpha]')`)
    await app.eval(`document.querySelector('[data-resource-id=alpha]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })), true`)
    await app.waitFor(`!!document.querySelector('[data-node-id=small]')`)
    await sleep(200)
    const before = await zoom()
    await app.eval(`window.opendrawStore.select([]), true`)
    await app.key('@', 'Digit2', SHIFT, 50)
    await sleep(100)
    expect((await zoom()) === before, 'Shift+2 with nothing selected changed the zoom')
    await app.eval(`window.opendrawStore.select(['small']), true`)
    // Typing @ in a field does not zoom.
    await app.eval(`(() => { const input = document.querySelector('[data-field="opacity"] input'); input.focus(); return true })()`)
    await app.key('@', 'Digit2', SHIFT, 50)
    await sleep(100)
    expect((await zoom()) === before, 'Shift+2 in a field changed the zoom')
    await app.eval(`document.activeElement.blur(), true`)
    await app.key('@', 'Digit2', SHIFT, 50)
    await app.waitFor(`Number(document.querySelector('.canvas-world').dataset.zoom) !== ${before}`)
    await sleep(100)
    const canvas = await app.rect('.canvas')
    const frame = await app.rect('[data-node-id=small]')
    const z = await zoom()
    const expected = Math.min((canvas.width - FIT_PADDING * 2) / 40, (canvas.height - FIT_PADDING * 2) / 30)
    const dx = frame.x + frame.width / 2 - (canvas.x + canvas.width / 2)
    const dy = frame.y + frame.height / 2 - (canvas.y + canvas.height / 2)
    expect(Math.abs(dx) < 2 && Math.abs(dy) < 2, `off center by ${dx.toFixed(1)}, ${dy.toFixed(1)}`)
    expect(Math.abs(z - expected) < 0.01, `zoom ${z}, expected ${expected}`)
    return `zoom ${before.toFixed(2)} -> ${z.toFixed(2)}; frame ${frame.width.toFixed(0)} x ${frame.height.toFixed(0)} px, centered within ${Math.max(Math.abs(dx), Math.abs(dy)).toFixed(1)} px`
  })

  await check('Each View menu zoom item matches its shortcut; the zoom readout lists the same commands', async () => {
    const results: string[] = []
    const viaKey: Record<string, () => Promise<void>> = {
      'Zoom to 100%': () => app.key('0', 'Digit0', CMD, 48),
      'Zoom In': () => app.key('=', 'Equal', CMD, 187),
      'Zoom Out': () => app.key('-', 'Minus', CMD, 189),
      'Zoom to Fit': () => app.key('!', 'Digit1', SHIFT, 49),
      'Zoom to Selection': () => app.key('@', 'Digit2', SHIFT, 50)
    }
    for (const label of Object.keys(viaKey)) {
      await menu('View', 'Zoom to 100%')
      await sleep(80)
      await menu('View', label)
      await sleep(120)
      const fromMenu = await zoom()
      await menu('View', 'Zoom to 100%')
      await sleep(80)
      await viaKey[label]()
      await sleep(120)
      const fromKey = await zoom()
      expect(Math.abs(fromMenu - fromKey) < 1e-6, `${label}: menu ${fromMenu}, key ${fromKey}`)
      results.push(`${label} ${Math.round(fromMenu * 100)}%`)
    }
    await app.eval(`document.querySelector('[data-testid=zoom-readout]').click(), true`)
    await app.waitFor(`!!document.querySelector('[data-testid=zoom-popover]')`)
    const listed = await app.eval<string[]>(`[...document.querySelectorAll('[data-testid=zoom-popover] button span')].map((s) => s.textContent)`)
    expect(listed.join() === Object.keys(viaKey).sort((a, b) => ['Zoom In', 'Zoom Out', 'Zoom to 100%', 'Zoom to Fit', 'Zoom to Selection'].indexOf(a) - ['Zoom In', 'Zoom Out', 'Zoom to 100%', 'Zoom to Fit', 'Zoom to Selection'].indexOf(b)).join(), `listed ${listed}`)
    await app.eval(`document.querySelector('[data-testid=zoom-popover] [data-command=zoom-in]').click(), true`)
    await app.waitFor(`!document.querySelector('[data-testid=zoom-popover]')`)
    const shown = await app.eval<string>(`document.querySelector('[data-testid=zoom-readout]').textContent`)
    expect(shown === `${Math.round((await zoom()) * 100)}%`, `readout ${shown}`)
    return `${results.join(', ')}; readout menu lists ${listed.length} commands; its Zoom In gave ${shown}`
  })

  await check('Duplicate File opens a copy next to the original; Rename File renames the active file on disk', async () => {
    await menu('File', 'Duplicate File')
    await app.waitFor(`document.querySelector('[data-testid=tab].active .tab-name')?.textContent === 'Alpha copy'`)
    expect(existsSync(path.join(profile.workspace, 'Alpha copy.opendraw')), 'no Alpha copy.opendraw beside Alpha')
    const copied = await app.eval<boolean>(`!!window.opendrawStore.getState().document.pages[0].nodes[0].children.find((n) => n.name === 'Small')`)
    expect(copied, 'the copy lacks the original layers')
    await menu('File', 'Rename File...')
    await app.waitFor(`document.activeElement?.dataset?.testid === 'tab-rename'`)
    await app.eval(`(() => { const input = document.activeElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Beta'); input.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await app.key('Enter', 'Enter', 0, 13)
    await app.waitFor(`document.querySelector('[data-testid=tab].active .tab-name')?.textContent === 'Beta'`)
    const renamed = existsSync(path.join(profile.workspace, 'Beta.opendraw')) && !existsSync(path.join(profile.workspace, 'Alpha copy.opendraw'))
    expect(renamed, 'Beta.opendraw is not on disk in place of Alpha copy.opendraw')
    const names = await tabNames()
    return `tabs ${names.join(', ')}; Beta.opendraw on disk`
  })
} finally {
  await app.kill()
}

await finish('menus')
