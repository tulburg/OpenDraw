// End-to-end acceptance checks for S-18 (layers panel editing): rename, drag to reorder and nest,
// hide and show, lock, range selection and the context menu. Run with `bun run test:layers`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { App, cleanProfile } from './cdp'
import { check, expect, finish } from './checks'
import { BridgeClient } from './mcp-client'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const CMD = process.platform === 'darwin' ? 4 : 2

const profile = cleanProfile()
mkdirSync(profile.workspace, { recursive: true })
const FILE = path.join(profile.workspace, 'Layers.opendraw')
const fileId = 'layers-file'
const frame = (id: string, name: string, style: object, children: object[] = []) => ({ id, type: 'frame', name, style, children })
writeFileSync(
  FILE,
  JSON.stringify({
    format: 'opendraw',
    version: 1,
    id: fileId,
    name: 'Layers',
    pages: [
      {
        id: 'page-1',
        name: 'Page 1',
        nodes: [
          {
            id: 'desktop',
            type: 'artboard',
            name: 'Desktop',
            style: { left: '0px', top: '0px', width: '800px', height: '600px', backgroundColor: '#ffffff', display: 'flex', flexDirection: 'column', gap: '16px', padding: '20px' },
            children: [
              frame('header', 'Header', { display: 'flex', flexDirection: 'row', justifyContent: 'space-between', height: '40px', backgroundColor: '#eeeeee' }, [
                { id: 'title', type: 'text', name: 'Title', text: 'Title', style: { fontSize: '16px' }, children: [] }
              ]),
              frame('box', 'Box', { width: '100px', height: '60px', backgroundColor: '#cccccc' }),
              frame('card', 'Card', { width: '300px', height: '150px', backgroundColor: '#dddddd', display: 'flex', padding: '10px' }, [
                frame('inner', 'Inner', { width: '80px', height: '80px', backgroundColor: '#aaaaaa' })
              ]),
              frame('footer', 'Footer', { width: '200px', height: '30px', backgroundColor: '#bbbbbb' })
            ]
          }
        ]
      }
    ]
  })
)

let app = await App.launch(profile)
let client = await BridgeClient.start(path.join(profile.userData, 'mcp.json'))
const call = (name: string, args: object = {}) => client.call(name, { fileId, ...args })
const center = async (selector: string) => {
  const r = await app.rect(selector)
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
}
const clickOn = async (selector: string, modifiers = 0, clicks = 1) => {
  const { x, y } = await center(selector)
  await app.clickWith(x, y, modifiers, clicks)
  await sleep(50)
}
const rightClick = async (selector: string) => {
  const { x, y } = await center(selector)
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', clickCount: 1 })
  await sleep(80)
}
const row = (id: string) => `.layer-row[data-layer-id="${id}"]`
const selection = () => app.eval<string[]>(`window.opendrawStore.getState().selection`)
const node = (id: string) =>
  app.eval<any>(`(() => { const find = (ns) => { for (const n of ns) { if (n.id === '${id}') return n; const f = find(n.children); if (f) return f } return null }; return find(window.opendrawStore.getState().document.pages[0].nodes) })()`)
const childIds = async (id: string) => ((await call('get_children', { nodeId: id })) as any[]).map((c) => c.id)
/** Drags a layer row onto another row's top edge, bottom edge or middle with HTML5 drag events. */
const dragRow = (from: string, to: string, where: 'before' | 'after' | 'inside') =>
  app.eval(`(() => {
    const src = document.querySelector('${row(from)}'), dst = document.querySelector('${row(to)}')
    const dt = new DataTransfer()
    const box = dst.getBoundingClientRect()
    const y = ${JSON.stringify(where)} === 'before' ? box.top + 2 : ${JSON.stringify(where)} === 'after' ? box.bottom - 2 : box.top + box.height / 2
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
    return new Promise((resolve) => setTimeout(() => {
      dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }))
      setTimeout(() => {
        dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }))
        src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
        resolve(true)
      }, 50)
    }, 50))
  })()`)

try {
  await check('Double-click renames a layer; Escape leaves it unchanged; undo restores it', async () => {
    await clickOn(row('box'), 0, 2)
    await app.waitFor(`document.querySelector('[data-testid="layer-rename"]') !== null`)
    await app.key('a', 'KeyA', CMD)
    await app.type('Ignored')
    await app.key('Escape', 'Escape', 0, 27)
    await sleep(50)
    const kept = (await node('box')).name
    await clickOn(row('box'), 0, 2)
    await app.waitFor(`document.querySelector('[data-testid="layer-rename"]') !== null`)
    await app.key('a', 'KeyA', CMD)
    await app.type('Gallery')
    await app.key('Enter', 'Enter', 0, 13)
    await sleep(80)
    const info = await call('get_node_info', { nodeId: 'box' })
    const panel = await app.eval<string>(`document.querySelector('${row('box')} .layer-name').textContent`)
    expect(kept === 'Box' && info.name === 'Gallery' && panel === 'Gallery', `kept ${kept}, info ${info.name}, panel ${panel}`)
    await app.key('z', 'KeyZ', CMD, 90)
    await sleep(80)
    const undone = (await node('box')).name
    expect(undone === 'Box', `after undo ${undone}`)
    return 'Box -> Gallery -> Box'
  })

  await check('Dragging a layer into another frame changes its parent; dragging a frame into its own child does nothing', async () => {
    await dragRow('box', 'card', 'inside')
    await sleep(100)
    const cardKids = await childIds('card')
    expect(cardKids.includes('box'), `card children ${cardKids}`)
    await dragRow('footer', 'header', 'before')
    await sleep(100)
    const top = await childIds('desktop')
    expect(top[0] === 'footer' && top[1] === 'header', `desktop children ${top}`)
    const before = JSON.stringify(await app.eval(`window.opendrawStore.getState().document.pages[0].nodes`))
    await dragRow('card', 'inner', 'inside')
    await sleep(100)
    const after = JSON.stringify(await app.eval(`window.opendrawStore.getState().document.pages[0].nodes`))
    expect(before === after, 'dragging card into its child changed the document')
    await app.key('z', 'KeyZ', CMD, 90)
    await app.key('z', 'KeyZ', CMD, 90)
    await sleep(80)
    const restored = await childIds('desktop')
    expect(restored.join() === 'header,box,card,footer', `after undo ${restored}`)
    return `card holds ${cardKids}; footer moved first; undo restored ${restored}`
  })

  await check('Hiding a display:flex frame and showing it leaves its style as before; hidden it is not drawn and not visible', async () => {
    const original = JSON.stringify((await node('header')).style)
    await app.eval(`document.querySelector('${row('header')}').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`)
    await app.eval(`document.querySelector('${row('header')} [data-testid="layer-visibility"]').click()`)
    await sleep(80)
    const drawn = await app.eval<boolean>(`document.querySelector('[data-node-id="header"]').getBoundingClientRect().height > 0`)
    const info = await call('get_node_info', { nodeId: 'header' })
    const dimmed = await app.eval<boolean>(`document.querySelector('${row('header')}').hasAttribute('data-hidden')`)
    expect(!drawn && info.visible === false && dimmed, `drawn ${drawn}, visible ${info.visible}, dimmed ${dimmed}`)
    await app.eval(`document.querySelector('${row('header')} [data-testid="layer-visibility"]').click()`)
    await sleep(80)
    const restored = await node('header')
    expect(JSON.stringify(restored.style) === original && restored.hiddenDisplay === undefined, `${JSON.stringify(restored)} vs ${original}`)
    const shown = await call('get_node_info', { nodeId: 'header' })
    expect(shown.visible === true, 'not visible after show')
    return `display ${restored.style.display} restored`
  })

  await check('A locked layer cannot be selected on the canvas but can be in the panel; the lock survives a restart', async () => {
    await app.eval(`document.querySelector('${row('card')} [data-testid="layer-lock"]').click()`)
    await sleep(80)
    await app.key('Escape', 'Escape', 0, 27)
    await clickOn('[data-node-id="inner"]')
    const onCanvas = await selection()
    await clickOn('[data-node-id="card"]')
    const onCanvas2 = await selection()
    expect(!onCanvas.includes('inner') && !onCanvas.includes('card') && !onCanvas2.includes('card'), `canvas selected ${onCanvas} / ${onCanvas2}`)
    await clickOn(row('card'))
    const inPanel = await selection()
    expect(inPanel.join() === 'card', `panel selected ${inPanel}`)
    await sleep(800)
    client.close()
    await app.close()
    const saved = JSON.parse(readFileSync(FILE, 'utf8'))
    const savedCard = saved.pages[0].nodes[0].children.find((c: any) => c.id === 'card')
    expect(savedCard.locked === true && !('locked' in savedCard.style), JSON.stringify(savedCard))
    app = await App.launch(profile)
    client = await BridgeClient.start(path.join(profile.userData, 'mcp.json'))
    await clickOn('[data-node-id="inner"]')
    const afterRestart = await selection()
    const lockShown = await app.eval<boolean>(`document.querySelector('${row('card')}').hasAttribute('data-locked')`)
    expect(!afterRestart.includes('inner') && !afterRestart.includes('card') && lockShown, `after restart ${afterRestart}, lock shown ${lockShown}`)
    await app.eval(`document.querySelector('${row('card')} [data-testid="layer-lock"]').click()`)
    await sleep(80)
    return `canvas clicks picked ${onCanvas.join() || 'nothing'}; panel picked card`
  })

  await check('Shift+click selects a range; Cmd+click toggles one; collapse hides children and canvas selection expands them', async () => {
    await clickOn(row('header'))
    await clickOn(row('card'), 8)
    const range = await selection()
    expect(range.join() === 'header,title,box,card', `range ${range}`)
    await clickOn(row('box'), CMD)
    const toggled = await selection()
    expect(toggled.join() === 'header,title,card', `cmd toggle ${toggled}`)
    await app.eval(`document.querySelector('${row('card')} [data-testid="layer-chevron"]').click()`)
    await sleep(50)
    const collapsedRows = await app.eval<boolean>(`document.querySelector('${row('inner')}') === null`)
    await app.eval(`window.opendrawStore.select(['inner'])`)
    await sleep(80)
    const expanded = await app.eval<boolean>(`document.querySelector('${row('inner')}') !== null`)
    expect(collapsedRows && expanded, `collapsed hid inner ${collapsedRows}, selection expanded ${expanded}`)
    return `range ${range.length}, toggle left ${toggled.length}`
  })

  await check('The context menu duplicates, wraps in a frame, copies as HTML and deletes', async () => {
    await clickOn(row('footer'))
    await rightClick(row('footer'))
    await app.screenshot(path.join(import.meta.dir, 'results', 'layers-menu.png'))
    await clickOn('[data-testid="layer-menu-duplicate"]')
    const afterDuplicate = await childIds('desktop')
    expect(afterDuplicate.length === 5 && afterDuplicate[3] === 'footer', `after duplicate ${afterDuplicate}`)
    const copy = afterDuplicate[4]
    await clickOn(row('box'))
    await clickOn(row(copy), CMD)
    await rightClick(row('box'))
    await clickOn('[data-testid="layer-menu-wrap"]')
    const wrapped = await childIds('desktop')
    const frameId = (await selection())[0]
    const frameKids = await childIds(frameId)
    const frameNode = await node(frameId)
    expect(wrapped.includes(frameId) && !wrapped.includes('box') && frameKids.join() === `box,${copy}` && frameNode.style.display === 'flex' && frameNode.style.flexDirection === 'column', `wrapped ${wrapped}, frame ${frameKids}, ${JSON.stringify(frameNode.style)}`)
    await rightClick(row('header'))
    await clickOn('[data-testid="layer-menu-copy-html"]')
    await sleep(100)
    const html = await app.eval<string>(`navigator.clipboard.readText()`)
    expect(html.includes('layer-name="Header"') && html.includes('display: flex') && html.includes('Title'), html)
    const roundTrip = await call('write_html', { targetNodeId: 'desktop', mode: 'insert-children', html })
    expect(roundTrip.created?.[0]?.name === 'Header', JSON.stringify(roundTrip).slice(0, 200))
    await clickOn(row('footer'))
    await rightClick(row('footer'))
    await clickOn('[data-testid="layer-menu-delete"]')
    const afterDelete = await childIds('desktop')
    expect(!afterDelete.includes('footer'), `after delete ${afterDelete}`)
    return `duplicate ${copy.slice(0, 8)}, wrapped into ${frameKids.length}, HTML ${html.length} chars, deleted footer`
  })
} finally {
  client.close()
  await app.kill()
}

await finish('layers')
