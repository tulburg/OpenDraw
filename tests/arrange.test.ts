// End-to-end acceptance checks for S-19 (arrange commands): wrap, unwrap, align, distribute and
// stacking order, from shortcuts and the canvas menu. Run with `bun run test:arrange`.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { App, cleanProfile } from './cdp'
import { check, expect, finish } from './checks'
import { BridgeClient } from './mcp-client'
import { readPNG } from './png'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const CMD = process.platform === 'darwin' ? 4 : 2
const ALT = 1
const SHIFT = 8

const profile = cleanProfile()
mkdirSync(profile.workspace, { recursive: true })
const FILE = path.join(profile.workspace, 'Arrange.opendraw')
const fileId = 'arrange-file'
const frame = (id: string, style: object, children: object[] = []) => ({ id, type: 'frame', name: id, style, children })
const abs = (id: string, left: number, top: number, width: number, height: number, color: string) =>
  frame(id, { position: 'absolute', left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`, backgroundColor: color })
writeFileSync(
  FILE,
  JSON.stringify({
    format: 'opendraw',
    version: 1,
    id: fileId,
    name: 'Arrange',
    pages: [
      {
        id: 'page-1',
        name: 'Page 1',
        nodes: [
          {
            id: 'desktop',
            type: 'artboard',
            name: 'Desktop',
            style: { left: '0px', top: '0px', width: '800px', height: '640px', backgroundColor: '#ffffff', display: 'flex', flexDirection: 'column', gap: '16px', padding: '20px' },
            children: [
              frame('a', { height: '40px', backgroundColor: '#ff8888' }),
              frame('b', { height: '40px', backgroundColor: '#88ff88' }),
              frame('stage', { position: 'relative', width: '600px', height: '300px', backgroundColor: '#eeeeee' }, [
                abs('p1', 10, 10, 50, 50, '#ff0000'),
                abs('p2', 100, 60, 80, 40, '#00aa00'),
                abs('p3', 300, 20, 40, 40, '#0000ff')
              ]),
              frame('row', { display: 'flex', flexDirection: 'row', height: '80px', backgroundColor: '#dddddd' }, [frame('chip', { width: '60px', height: '30px', backgroundColor: '#888888' })])
            ]
          }
        ]
      }
    ]
  })
)

const app = await App.launch(profile)
const client = await BridgeClient.start(path.join(profile.userData, 'mcp.json'))
const call = (name: string, args: object = {}) => client.call(name, { fileId, ...args })
const childIds = async (id: string) => ((await call('get_children', { nodeId: id })) as any[]).map((c) => c.id)
const select = (ids: string[]) => app.eval(`window.opendrawStore.select(${JSON.stringify(ids)})`)
const selection = () => app.eval<string[]>(`window.opendrawStore.getState().selection`)
const node = (id: string) =>
  app.eval<any>(`(() => { const find = (ns) => { for (const n of ns) { if (n.id === '${id}') return n; const f = find(n.children); if (f) return f } return null }; return find(window.opendrawStore.getState().document.pages[0].nodes) })()`)
const rectOf = (id: string) => app.rect(`[data-node-id="${id}"]`)
const press = async (code: string, modifiers: number) => {
  const key = code === 'KeyG' ? 'g' : code === 'BracketRight' ? ']' : '['
  await app.key(key, code, modifiers)
  await sleep(100)
}
const undo = () => app.key('z', 'KeyZ', CMD, 90).then(() => sleep(80))
const center = async (selector: string) => {
  const r = await app.rect(selector)
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
}
const clickOn = async (selector: string) => {
  const { x, y } = await center(selector)
  await app.click(x, y)
  await sleep(60)
}
const rightClick = async (selector: string) => {
  const { x, y } = await center(selector)
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', clickCount: 1 })
  await sleep(80)
}
const screenshot = async (id: string) => readPNG(Buffer.from((await client.callRaw('get_screenshot', { fileId, nodeId: id })).content[0].data, 'base64'))
const near = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) < 1.5 && Math.abs(a.y - b.y) < 1.5

try {
  await check('Cmd+Opt+G wraps two flex children in a frame in their place; the artboard looks the same', async () => {
    const before = await screenshot('desktop')
    await select(['a', 'b'])
    await press('KeyG', CMD | ALT)
    const kids = await childIds('desktop')
    const frameId = (await selection())[0]
    const inner = await childIds(frameId)
    const style = (await node(frameId)).style
    expect(kids[0] === frameId && !kids.includes('a') && inner.join() === 'a,b', `desktop ${kids}, frame ${inner}`)
    expect(style.display === 'flex' && style.flexDirection === 'column' && style.gap === '16px', JSON.stringify(style))
    const after = await screenshot('desktop')
    let differing = 0
    for (let y = 0; y < before.height; y += 2) for (let x = 0; x < before.width; x += 2) if (before.pixel(x, y).join() !== after.pixel(x, y).join()) differing++
    expect(after.width === before.width && differing === 0, `${differing} sampled pixels differ`)
    await undo()
    const restored = await childIds('desktop')
    expect(restored.join() === 'a,b,stage,row', `after undo ${restored}`)
    return `frame ${JSON.stringify(style)}; screenshot unchanged`
  })

  let wrapId = ''
  const positions: Record<string, { x: number; y: number }> = {}
  await check('Wrapping two absolutely positioned layers gives a frame at their combined bounds; each keeps its canvas position', async () => {
    for (const id of ['p1', 'p2', 'p3']) positions[id] = await rectOf(id)
    await select(['p1', 'p2'])
    await press('KeyG', CMD | ALT)
    wrapId = (await selection())[0]
    const style = (await node(wrapId)).style
    expect(style.position === 'absolute' && style.left === '10px' && style.top === '10px' && style.width === '170px' && style.height === '90px', JSON.stringify(style))
    expect(near(await rectOf('p1'), positions.p1) && near(await rectOf('p2'), positions.p2), 'layers moved on the canvas')
    expect((await childIds('stage')).join() === `${wrapId},p3`, `stage ${await childIds('stage')}`)
    return JSON.stringify(style)
  })

  await check('Unwrapping that frame restores the structure and positions', async () => {
    await select([wrapId])
    await press('KeyG', CMD | SHIFT)
    const kids = await childIds('stage')
    expect(kids.join() === 'p1,p2,p3', `stage ${kids}`)
    expect(near(await rectOf('p1'), positions.p1) && near(await rectOf('p2'), positions.p2), 'positions changed')
    const p2 = (await node('p2')).style
    expect(p2.left === '100px' && p2.top === '60px', JSON.stringify(p2))
    return `stage ${kids}`
  })

  await check('Aligning three positioned layers left gives the same left; distributing gives equal gaps (from the canvas menu)', async () => {
    await select(['p1', 'p2', 'p3'])
    await rightClick('[data-node-id="p2"]')
    const kept = await selection()
    await clickOn('[data-testid="menu-align-left"]')
    const lefts = await Promise.all(['p1', 'p2', 'p3'].map(async (id) => (await node(id)).style.left))
    expect(kept.length === 3 && lefts.every((l) => l === '10px'), `selection ${kept}, lefts ${lefts}`)
    await undo()
    await rightClick('[data-node-id="p2"]')
    await clickOn('[data-testid="menu-distribute-horizontal"]')
    const boxes = await Promise.all(['p1', 'p2', 'p3'].map(async (id) => (await node(id)).style))
    const x = boxes.map((s) => Number.parseFloat(s.left))
    const w = [50, 80, 40]
    const gaps = [x[1] - (x[0] + w[0]), x[2] - (x[1] + w[1])]
    expect(Math.abs(gaps[0] - gaps[1]) <= 1 && x[0] === 10 && x[2] === 300, `lefts ${x}, gaps ${gaps}`)
    return `aligned to 10px; gaps ${gaps}`
  })

  await check('One flex child aligns with align-self; the other axis explains why it cannot', async () => {
    await select(['chip'])
    await rightClick('[data-node-id="chip"]')
    await clickOn('[data-testid="menu-align-bottom"]')
    const style = (await node('chip')).style
    await rightClick('[data-node-id="chip"]')
    await clickOn('[data-testid="menu-align-right"]')
    const notice = await app.eval<string>(`document.querySelector('[data-testid="notice"]')?.textContent ?? ''`)
    expect(style.alignSelf === 'flex-end' && notice.includes('justify-content'), `alignSelf ${style.alignSelf}, notice "${notice}"`)
    return notice
  })

  await check('Bring to front and send to back change sibling order; every command undoes in one step', async () => {
    await select(['p1'])
    await press('BracketRight', CMD | SHIFT)
    const front = await childIds('stage')
    await press('BracketLeft', CMD)
    const back1 = await childIds('stage')
    await select(['p3'])
    await press('BracketLeft', CMD | SHIFT)
    const back = await childIds('stage')
    expect(front.join() === 'p2,p3,p1' && back1.join() === 'p2,p1,p3' && back.join() === 'p3,p2,p1', `front ${front}, backward ${back1}, back ${back}`)
    await undo()
    const one = await childIds('stage')
    await undo()
    const two = await childIds('stage')
    await undo()
    const three = await childIds('stage')
    expect(one.join() === 'p2,p1,p3' && two.join() === 'p2,p3,p1' && three.join() === 'p1,p2,p3', `undo ${one} / ${two} / ${three}`)
    return `front ${front}, back ${back}`
  })
} finally {
  client.close()
  await app.kill()
}

await finish('arrange')
