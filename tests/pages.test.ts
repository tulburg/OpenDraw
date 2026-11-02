// End-to-end acceptance checks for S-12 (pages): the page list and Paper's page tools.
// Run with `bun run test:pages`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { App, cleanProfile } from './cdp'
import { check, expect, finish } from './checks'
import { BridgeClient } from './mcp-client'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const CMD = process.platform === 'darwin' ? 4 : 2

const profile = cleanProfile()
mkdirSync(profile.workspace, { recursive: true })
const FILE = path.join(profile.workspace, 'Pages.opendraw')
const fileId = 'pages-file'
writeFileSync(
  FILE,
  JSON.stringify({
    format: 'opendraw',
    version: 1,
    id: fileId,
    name: 'Pages',
    pages: [
      {
        id: 'page-1',
        name: 'Page 1',
        nodes: [{ id: 'desktop', type: 'artboard', name: 'Desktop', style: { left: '0px', top: '0px', width: '1440px', height: '900px', backgroundColor: '#ffffff' }, children: [] }]
      }
    ]
  })
)

let app = await App.launch(profile)
let client = await BridgeClient.start(path.join(profile.userData, 'mcp.json'))
const call = (name: string, args: object = {}) => client.call(name, { fileId, ...args })
const state = () => app.eval<{ pageId: string; pages: string[] }>(`(() => { const s = window.opendrawStore.getState(); return { pageId: s.pageId, pages: s.document.pages.map((p) => p.name) } })()`)
const rows = () => app.eval<string[]>(`[...document.querySelectorAll('[data-testid="page-row"], [data-testid="page-divider"]')].map((r) => r.dataset.pageId ? r.textContent : '---')`)
const viewport = () => app.eval<string>(`(() => { const w = document.querySelector('.canvas-world'); return [w.dataset.x, w.dataset.y, w.dataset.zoom].join(',') })()`)
const center = async (selector: string) => {
  const r = await app.rect(selector)
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
}
const rightClick = async (selector: string) => {
  const { x, y } = await center(selector)
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', clickCount: 1 })
  await sleep(50)
}
const clickOn = async (selector: string, clicks = 1) => {
  const { x, y } = await center(selector)
  await app.clickWith(x, y, 0, clicks)
  await sleep(30)
}
const undo = () => app.key('z', 'KeyZ', CMD, 90)
/** Drags one page row onto the top half of another with HTML5 drag events. */
const dragRow = (from: string, to: string, after = false) =>
  app.eval(`(() => {
    const src = document.querySelector(${JSON.stringify(from)}), dst = document.querySelector(${JSON.stringify(to)}).closest('li')
    const dt = new DataTransfer()
    const box = dst.getBoundingClientRect()
    const y = ${after} ? box.bottom - 2 : box.top + 2
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
    return new Promise((resolve) => setTimeout(() => {
      dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }))
      setTimeout(() => {
        dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }))
        src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
        resolve(true)
      }, 30)
    }, 30))
  })()`)

try {
  let page2 = ''
  await check('Clicking + adds "Page 2" after the current page and shows it; Page 1 comes back with its viewport', async () => {
    // Move Page 1's viewport so it is not just the fitted one.
    await app.key('=', 'Equal', CMD, 187)
    await sleep(100)
    const before = await viewport()
    await clickOn('[data-testid="add-page"]')
    const s = await state()
    expect(JSON.stringify(s.pages) === JSON.stringify(['Page 1', 'Page 2']), `pages ${s.pages}`)
    page2 = s.pageId
    expect(page2 !== 'page-1', 'did not switch to the new page')
    expect((await app.eval<string>(`document.querySelector('[data-testid="page-row"][data-active]').textContent`)) === 'Page 2', 'Page 2 not highlighted')
    await clickOn('[data-testid="page-row"][data-page-id="page-1"]')
    await sleep(100)
    const after = await viewport()
    expect((await state()).pageId === 'page-1' && after === before, `viewport ${after} vs ${before}`)
    return `Page 1 viewport ${before} kept`
  })

  await check('Renaming by double-click, reordering by drag and adding a divider are each one undo step', async () => {
    await clickOn(`[data-testid="page-row"][data-page-id="${page2}"]`, 2)
    await app.waitFor(`document.querySelector('[data-testid="page-rename"]') !== null`)
    await app.type('Mobile')
    await app.key('Enter', 'Enter', 0, 13)
    await sleep(50)
    expect(JSON.stringify((await state()).pages) === JSON.stringify(['Page 1', 'Mobile']), `after rename ${(await state()).pages}`)

    await dragRow(`[data-page-id="${page2}"]`, '[data-page-id="page-1"]')
    await sleep(50)
    expect(JSON.stringify((await state()).pages) === JSON.stringify(['Mobile', 'Page 1']), `after drag ${(await state()).pages}`)

    await rightClick(`[data-page-id="${page2}"]`)
    await clickOn('[data-testid="menu-add-divider"]')
    expect(JSON.stringify(await rows()) === JSON.stringify(['Mobile', '---', 'Page 1']), `rows ${await rows()}`)

    await undo()
    await sleep(50)
    const afterDivider = await rows()
    await undo()
    await sleep(50)
    const afterReorder = (await state()).pages
    await undo()
    await sleep(50)
    const afterRename = (await state()).pages
    expect(JSON.stringify(afterDivider) === JSON.stringify(['Mobile', 'Page 1']), `undo divider: ${afterDivider}`)
    expect(JSON.stringify(afterReorder) === JSON.stringify(['Page 1', 'Mobile']), `undo reorder: ${afterReorder}`)
    expect(JSON.stringify(afterRename) === JSON.stringify(['Page 1', 'Page 2']), `undo rename: ${afterRename}`)
    // Redo all three, so they are in the file for the restart check.
    for (let i = 0; i < 3; i++) await app.key('z', 'KeyZ', CMD | 8, 90)
    await sleep(50)
    expect(JSON.stringify(await rows()) === JSON.stringify(['Mobile', '---', 'Page 1']), `after redo ${await rows()}`)
    return 'three undo steps, each taking back one change'
  })

  await check('Change icon and Duplicate from the menu; Delete asks first and is not offered for the last page', async () => {
    await rightClick(`[data-page-id="${page2}"]`)
    await clickOn('[data-testid="menu-icon"]')
    await clickOn('[data-testid="icon-grid"] [data-icon="arrow"]')
    const icon = await app.eval<string>(`document.querySelector('[data-page-id="${page2}"] .page-icon').dataset.icon`)
    expect(icon === 'arrow', `icon ${icon}`)
    await rightClick('[data-page-id="page-1"]')
    await clickOn('[data-testid="menu-duplicate"]')
    const s = await state()
    expect(s.pages.includes('Page 1 copy') && s.pageId !== 'page-1', `pages ${s.pages}`)
    const copyId = s.pageId
    await rightClick(`[data-page-id="${copyId}"]`)
    await clickOn('[data-testid="menu-delete"]')
    expect(await app.eval<boolean>(`document.querySelector('[data-testid="confirm-delete"]') !== null`), 'no confirmation')
    expect((await state()).pages.includes('Page 1 copy'), 'deleted before confirming')
    await clickOn('[data-testid="confirm-delete-button"]')
    expect(!(await state()).pages.includes('Page 1 copy'), 'not deleted')
    return `icon arrow, duplicated and deleted "Page 1 copy" after confirming`
  })

  await check('create_page adds a page without switching the user; update_pages sets a name and icon', async () => {
    const viewing = (await state()).pageId
    const created = await call('create_page', { name: 'Agent page', icon: 'blueprint' })
    expect((await state()).pageId === viewing, 'user page switched')
    expect(created.pageId && created.name === 'Agent page', JSON.stringify(created))
    const updated = await call('update_pages', { updates: [{ pageId: created.pageId, name: 'Specs', icon: 'table' }, { pageId: page2, icon: null }] })
    expect(updated.pages[0].name === 'Specs' && updated.pages[0].icon === 'table' && updated.pages[1].icon === null, JSON.stringify(updated))
    expect((await state()).pageId === viewing, 'user page switched')
    return `created ${created.pageId}; renamed to Specs with table icon; Mobile icon reset`
  })

  await check('arrange_pages rejects a missing ID with no change; a full order plus a divider reorders and returns its ID', async () => {
    const info = await call('get_basic_info')
    const ids = info.pages.map((p: any) => p.id)
    const before = JSON.stringify((await call('get_basic_info')).pages)
    const missing = await client.callRaw('arrange_pages', { fileId, order: ids.slice(1) })
    const repeated = await client.callRaw('arrange_pages', { fileId, order: [...ids, ids[0]] })
    const unknown = await client.callRaw('arrange_pages', { fileId, order: [...ids, 'nope'] })
    expect(missing.isError && repeated.isError && unknown.isError, 'a bad order was accepted')
    expect(JSON.stringify((await call('get_basic_info')).pages) === before, 'a rejected call changed the list')
    const order = [...ids].reverse()
    const result = await call('arrange_pages', { order: [order[0], { type: 'divider' }, ...order.slice(1)] })
    expect(result.newDividerIds?.length === 1, JSON.stringify(result))
    const after = (await call('get_basic_info')).pages
    expect(after[1].type === 'divider' && after[1].id === result.newDividerIds[0], `list ${JSON.stringify(after)}`)
    const pagesAfter = after.filter((p: any) => p.type === 'page').map((p: any) => p.id)
    expect(JSON.stringify(pagesAfter) === JSON.stringify(order.filter((id: string) => info.pages.find((p: any) => p.id === id).type === 'page')), 'pages not reordered')
    expect(JSON.stringify(await rows()) === JSON.stringify(after.map((p: any) => (p.type === 'page' ? p.name : '---'))), `panel ${await rows()}`)
    return `rejected: ${missing.content[0].text}; new divider ${result.newDividerIds[0]}`
  })

  await check('get_basic_info reflects order, names, icons and dividers, and survives a restart', async () => {
    const before = (await call('get_basic_info')).pages
    expect(before.some((p: any) => p.name === 'Specs' && p.icon === 'table'), JSON.stringify(before))
    await sleep(800)
    client.close()
    await app.close()
    const saved = JSON.parse(readFileSync(FILE, 'utf8'))
    app = await App.launch(profile)
    client = await BridgeClient.start(path.join(profile.userData, 'mcp.json'))
    const after = (await call('get_basic_info')).pages.map((p: any) => ({ ...p, isActive: undefined }))
    const expected = before.map((p: any) => ({ ...p, isActive: undefined }))
    expect(JSON.stringify(after) === JSON.stringify(expected), `${JSON.stringify(after)} vs ${JSON.stringify(expected)}`)
    expect(saved.dividers?.length >= 2, `saved dividers ${JSON.stringify(saved.dividers)}`)
    return `${after.length} entries (${after.filter((p: any) => p.type === 'divider').length} dividers) after restart`
  })

  await check('The last page cannot be deleted', async () => {
    const result = await app.eval<string>(`(() => {
      const s = window.opendrawStore
      const doc = s.getState().document
      for (const p of doc.pages.slice(1)) s.transact('x', (tx) => tx.deletePage(p.id))
      try { s.transact('x', (tx) => tx.deletePage(s.getState().document.pages[0].id)); return 'deleted' } catch (e) { return e.message }
    })()`)
    await sleep(50)
    const only = await app.eval<string>(`document.querySelector('[data-testid="page-row"]').dataset.pageId`)
    await rightClick(`[data-page-id="${only}"]`)
    const offered = await app.eval<boolean>(`document.querySelector('[data-testid="menu-delete"]') !== null`)
    expect(result !== 'deleted' && !offered, `${result}, delete offered: ${offered}`)
    return result
  })
} finally {
  client.close()
  await app.kill()
}

await finish('pages')
