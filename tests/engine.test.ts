// End-to-end acceptance checks for S-3 (document engine). Run with `bun run test:engine`.
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { App, cleanProfile } from './cdp'
import { check, expect, finish } from './checks'

const CMD = process.platform === 'darwin' ? 4 : 2
const SHIFT = 8

const profile = cleanProfile()
const file = path.join(profile.workspace, 'Untitled.opendraw')
const onDisk = () => JSON.parse(readFileSync(file, 'utf8'))
let app = await App.launch(profile)

/** Runs `body` in the page with `store` and the artboard's ID in scope. */
const inStore = <T = any>(body: string) =>
  app.eval<T>(`(() => { const store = window.opendrawStore; const s = store.getState();
    const page = s.document.pages.find((p) => p.id === s.pageId); const artboard = page.nodes[0].id; ${body} })()`)

const documentJSON = () => inStore<string>('return JSON.stringify(s.document)')
const waitForSave = () => Bun.sleep(900)

try {
  await check('Each edit changes the rendered DOM and the saved file', async () => {
    // insert: a Card frame with a Title text, a Body frame and a Spare frame
    await inStore(`store.transact('insert', (tx) => tx.insertNodes(artboard, undefined, [
      { id: 'card', type: 'frame', name: 'Card', style: { display: 'flex', flexDirection: 'column', padding: '16px', gap: '8px' },
        children: [
          { id: 'title', type: 'text', name: 'Title', text: 'Hello', style: { fontSize: '24px' }, children: [] },
          { id: 'body', type: 'frame', name: 'Body', style: { height: '40px' }, children: [] },
          { id: 'spare', type: 'frame', name: 'Spare', style: { height: '10px' }, children: [] }
        ] }]))`)
    await app.waitFor(`document.querySelector('[data-node-id=title]')?.textContent === 'Hello'`)
    const rows = await app.eval<string[]>(`[...document.querySelectorAll('.layer-name')].map((e) => e.textContent)`)
    expect(rows.join() === 'Desktop,Card,Title,Body,Spare', `layers panel shows ${rows}`)

    // update styles
    await inStore(`store.transact('style', (tx) => tx.updateStyles(['card'], { backgroundColor: '#ff0000', gap: null }))`)
    const style = await app.eval(`(() => { const s = getComputedStyle(document.querySelector('[data-node-id=card]'));
      return { bg: s.backgroundColor, gap: s.rowGap } })()`)
    expect(style.bg === 'rgb(255, 0, 0)', `background ${style.bg}`)
    expect(style.gap === 'normal', `gap not removed: ${style.gap}`)

    // set text, rename
    await inStore(`store.transact('text', (tx) => tx.setText('title', 'Welcome'))`)
    await inStore(`store.transact('rename', (tx) => tx.rename('body', 'Content'))`)
    await app.waitFor(`document.querySelector('[data-node-id=title]').textContent === 'Welcome'`)
    await app.waitFor(`[...document.querySelectorAll('.layer-name')].some((e) => e.textContent === 'Content')`)

    // move: Spare to the front of Card
    await inStore(`store.transact('move', (tx) => tx.moveNodes(['spare'], 'card', 0))`)
    const order = await app.eval<string[]>(`[...document.querySelector('[data-node-id=card]').children].map((e) => e.dataset.nodeId)`)
    expect(order.join() === 'spare,title,body', `order after move: ${order}`)

    // duplicate: Body gets a copy right after it, with a new ID
    const copies = await inStore<string[]>(`return store.transact('duplicate', (tx) => tx.duplicateNodes(['body']))`)
    const afterDup = await app.eval<string[]>(`[...document.querySelector('[data-node-id=card]').children].map((e) => e.dataset.nodeId)`)
    expect(copies.length === 1 && copies[0] !== 'body', `duplicate IDs ${copies}`)
    expect(afterDup.join() === `spare,title,body,${copies[0]}`, `order after duplicate: ${afterDup}`)

    // delete
    await inStore(`store.transact('delete', (tx) => tx.deleteNodes(['spare']))`)
    expect(!(await app.eval(`!!document.querySelector('[data-node-id=spare]')`)), 'spare still rendered')

    await waitForSave()
    expect(JSON.stringify(onDisk()) === (await documentJSON()), 'saved file differs from the document')
    return 'insert, update styles, set text, rename, move, duplicate, delete'
  })

  await check('A grouped transaction with one invalid edit changes nothing', async () => {
    const before = await documentJSON()
    const savedBefore = JSON.stringify(onDisk())
    const error = await inStore<string>(`try {
        store.transact('group', (tx) => { tx.rename('card', 'Renamed'); tx.setText('card', 'not a text node') })
        return 'no error'
      } catch (e) { return e.message }`)
    expect(error !== 'no error', 'invalid edit did not throw')
    expect((await documentJSON()) === before, 'document changed')
    await waitForSave()
    expect(JSON.stringify(onDisk()) === savedBefore, 'file changed')
    return `rejected with: ${error}`
  })

  await check('update styles applies padding and reports margin in ignoredStyles', async () => {
    const ignored = await inStore(`return store.transact('style', (tx) =>
      tx.updateStyles(['card'], { padding: '24px', margin: '10px', display: 'grid', left: '5px' }))`)
    const card = await inStore(`return store.getState().document.pages[0].nodes[0].children.find((n) => n.id === 'card').style`)
    expect(card.padding === '24px', `padding ${card.padding}`)
    expect(!('margin' in card) && card.display === 'flex' && !('left' in card), `style ${JSON.stringify(card)}`)
    const keys = Object.keys(ignored.card ?? {}).sort().join()
    expect(keys === 'display,left,margin', `ignoredStyles ${JSON.stringify(ignored)}`)
    const computed = await app.eval(`getComputedStyle(document.querySelector('[data-node-id=card]')).paddingTop`)
    expect(computed === '24px', `rendered padding ${computed}`)
    return `ignored: ${keys}`
  })

  await check('10 edits, 10 undos, 10 redos; shortcuts and selection follow', async () => {
    const start = await documentJSON()
    await inStore(`store.select(['title'])`)
    for (let i = 0; i < 10; i++) {
      await inStore(`store.transact('edit ${i}', (tx) => { tx.setText('title', 'Step ${i}'); tx.select(['${i % 2 ? 'title' : 'card'}']) })`)
    }
    const end = await documentJSON()
    const selectionAt = () => inStore<string[]>('return s.selection')

    // Undo by keyboard: cmd/ctrl + Z
    for (let i = 0; i < 10; i++) await app.key('z', 'KeyZ', CMD, 90)
    expect((await documentJSON()) === start, 'undo did not restore the starting document')
    expect((await selectionAt()).join() === 'title', `selection after undos: ${await selectionAt()}`)
    const outline = await app.eval(`!!document.querySelector('.selection-outline') &&
      document.querySelector('.layer-row[data-selected]')?.dataset.layerId`)
    expect(outline === 'title', `canvas and layers show selection ${outline}`)

    // Redo by keyboard: shift + cmd/ctrl + Z
    for (let i = 0; i < 10; i++) await app.key('z', 'KeyZ', CMD | SHIFT, 90)
    expect((await documentJSON()) === end, 'redo did not restore the final document')
    expect((await selectionAt()).join() === 'title', `selection after redos: ${await selectionAt()}`)
    expect((await app.eval(`document.querySelector('[data-node-id=title]').textContent`)) === 'Step 9', 'rendered text')

    await inStore('store.undo()')
    expect((await selectionAt()).join() === 'card', `selection after one undo: ${await selectionAt()}`)
    await inStore('store.redo()')
    return 'document identical after undo and redo; selection restored at each step'
  })

  await check('Edit, wait 1 s, crash: the file has the edit', async () => {
    await inStore(`store.transact('before crash', (tx) => tx.rename('card', 'Saved before crash'))`)
    await Bun.sleep(1000)
    await app.crash()
    const card = onDisk().pages[0].nodes[0].children.find((n: any) => n.id === 'card')
    expect(card?.name === 'Saved before crash', `name on disk: ${card?.name}`)
    app = await App.launch(profile)
  })

  await check('Edit then quit immediately: the file has the edit', async () => {
    await inStore(`store.transact('before quit', (tx) => tx.rename('card', 'Saved on quit'))`)
    await app.quit()
    const card = onDisk().pages[0].nodes[0].children.find((n: any) => n.id === 'card')
    expect(card?.name === 'Saved on quit', `name on disk: ${card?.name}`)
    app = await App.launch(profile)
  })

  await check('Reload: the same node IDs come back', async () => {
    const ids = (nodes: any[]): string[] => nodes.flatMap((n) => [n.id, ...ids(n.children)])
    const before = ids(onDisk().pages[0].nodes)
    const loaded = await inStore<string[]>(`const ids = (nodes) => nodes.flatMap((n) => [n.id, ...ids(n.children)]);
      return ids(page.nodes)`)
    expect(before.join() === loaded.join(), `ids differ: ${loaded} vs ${before}`)
    const rendered = await app.eval<string[]>(`[...document.querySelectorAll('[data-node-id]')].map((e) => e.dataset.nodeId)`)
    expect(rendered.join() === before.join(), `rendered ids ${rendered}`)
    await app.screenshot(path.join(import.meta.dir, 'results', 'engine.png'))
    return `${before.length} nodes`
  })
} finally {
  await app.close()
}

await finish('engine')
