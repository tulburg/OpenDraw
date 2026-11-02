// End-to-end acceptance checks for S-35 (positioned layers and shape tools). Run with `bun run test:shapes`.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { App, cleanProfile } from './cdp'
import { check, expect, finish } from './checks'
import { BridgeClient } from './mcp-client'

const CMD = process.platform === 'darwin' ? 4 : 2
const SHIFT = 8

const profile = cleanProfile()
mkdirSync(profile.workspace, { recursive: true })
const fileId = 'shapes-file'
const positioned = (left: number, top: number, color: string) => ({ position: 'absolute', left: `${left}px`, top: `${top}px`, width: '40px', height: '30px', backgroundColor: color })
writeFileSync(
  path.join(profile.workspace, 'Shapes.opendraw'),
  JSON.stringify({
    format: 'opendraw',
    version: 1,
    id: fileId,
    name: 'Shapes',
    pages: [
      {
        id: 'page-1',
        name: 'Page 1',
        nodes: [
          { id: 'Free', type: 'artboard', name: 'Free', style: { left: '0px', top: '0px', width: '600px', height: '400px', backgroundColor: '#ffffff' }, children: [] },
          {
            id: 'Holder',
            type: 'artboard',
            name: 'Holder',
            style: { left: '700px', top: '0px', width: '400px', height: '400px', backgroundColor: '#ffffff' },
            children: [
              {
                id: 'Box',
                type: 'frame',
                name: 'Box',
                style: { position: 'absolute', left: '20px', top: '20px', width: '300px', height: '200px', backgroundColor: '#eeeeee' },
                children: [
                  { id: 'c', type: 'frame', name: 'C', style: positioned(200, 120, '#0000ff'), children: [] },
                  { id: 'a', type: 'frame', name: 'A', style: positioned(10, 100, '#ff0000'), children: [] },
                  { id: 'b', type: 'frame', name: 'B', style: positioned(100, 10, '#00ff00'), children: [] }
                ]
              }
            ]
          }
        ]
      }
    ]
  })
)

const app = await App.launch(profile, 9401)
const client = await BridgeClient.start(path.join(profile.userData, 'mcp.json'))
await app.waitFor(`!!document.querySelector('[data-node-id="Box"]')`)
await app.key('!', 'Digit1', SHIFT, 49)
await Bun.sleep(200)

const node = (id: string) =>
  app.eval<any>(`(() => {
    const find = (nodes) => { for (const n of nodes) { if (n.id === ${JSON.stringify(id)}) return n; const f = find(n.children); if (f) return f } return null }
    return find(window.opendrawStore.getState().document.pages[0].nodes)
  })()`)
const pageNodes = () => app.eval<any[]>(`window.opendrawStore.getState().document.pages[0].nodes`)
const selected = () => app.eval<string[]>('window.opendrawStore.getState().selection')
const zoom = () => app.eval<number>(`Number(document.querySelector('.canvas-world').dataset.zoom)`)
const undo = () => app.key('z', 'KeyZ', CMD, 90)
const pressKey = (letter: string) => app.key(letter, `Key${letter.toUpperCase()}`, 0, letter.toUpperCase().charCodeAt(0))
const screenAt = async (artboard: string, x: number, y: number) => {
  const r = await app.rect(`.canvas-world [data-node-id="${artboard}"]`)
  const z = await zoom()
  return { x: r.x + x * z, y: r.y + y * z }
}
/** Draws with snapping off (cmd held), so the box is exactly where the pointer went. */
const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
  await app.mouseDown(from.x, from.y, CMD)
  for (let i = 1; i <= 5; i++) await app.mouseMove(from.x + ((to.x - from.x) * i) / 5, from.y + ((to.y - from.y) * i) / 5, 1, CMD)
  await app.mouseUp(to.x, to.y, CMD)
  await Bun.sleep(80)
}
/** A layer's rendered box in its parent's padding-box units. */
const offsets = (id: string) =>
  app.eval<{ x: number; y: number; w: number; h: number }>(`(() => {
    const el = document.querySelector('.canvas-world [data-node-id="${id}"]'); const parent = el.parentElement.closest('[data-node-id]')
    const z = Number(document.querySelector('.canvas-world').dataset.zoom); const r = el.getBoundingClientRect(); const p = parent.getBoundingClientRect()
    return { x: Math.round((r.left - p.left) / z - parent.clientLeft), y: Math.round((r.top - p.top) / z - parent.clientTop), w: Math.round(r.width / z), h: Math.round(r.height / z) }
  })()`)
const clickFlexToggle = () => app.eval(`document.querySelector('[data-field="flex-layout"] input').click(), true`)

try {
  await check('R and O switch to Rectangle and Circle, with their names and keys on the toolbar', async () => {
    await pressKey('r')
    const rect = await app.eval<string>(`document.querySelector('.tool-button[data-active]')?.dataset.tool`)
    await pressKey('o')
    const circle = await app.eval<string>(`document.querySelector('.tool-button[data-active]')?.dataset.tool`)
    await app.key('Escape', 'Escape', 0, 27)
    const titles = await app.eval<string[]>(`['rectangle', 'circle'].map((t) => document.querySelector('.tool-button[data-tool="' + t + '"]').title)`)
    expect(rect === 'rectangle' && circle === 'circle', `tools ${rect}, ${circle}`)
    expect(titles.join() === 'Rectangle (R),Circle (O)', `titles ${titles}`)
    return `${titles.join(', ')}`
  })

  await check('A rectangle drawn inside an artboard is position: absolute where it was drawn; the artboard gets no flex', async () => {
    await pressKey('r')
    await drag(await screenAt('Free', 40, 50), await screenAt('Free', 140, 110))
    const [id] = await selected()
    const rect = await node(id)
    const free = await node('Free')
    const s = rect.style
    expect(rect.type === 'frame' && rect.name === 'Rectangle', `${rect.type} ${rect.name}`)
    expect(s.position === 'absolute' && s.left === '40px' && s.top === '50px' && s.width === '100px' && s.height === '60px', JSON.stringify(s))
    expect(s.backgroundColor === '#d9d9d9', `fill ${s.backgroundColor}`)
    expect(!free.style.display, `artboard display ${free.style.display}`)
    return `Rectangle at ${s.left}, ${s.top}, ${s.width} x ${s.height}, ${s.backgroundColor}; artboard has no display`
  })

  await check('A circle stays round while drawn, and a click draws a 120 px circle', async () => {
    await pressKey('o')
    await drag(await screenAt('Free', 200, 50), await screenAt('Free', 280, 90))
    const dragged = (await node((await selected())[0])).style
    await pressKey('o')
    const at = await screenAt('Free', 300, 200)
    await app.click(at.x, at.y)
    await Bun.sleep(80)
    const clicked = (await node((await selected())[0])).style
    expect(dragged.width === '80px' && dragged.height === '80px' && dragged.borderRadius === '50%' && dragged.position === 'absolute', JSON.stringify(dragged))
    expect(clicked.width === '120px' && clicked.height === '120px' && clicked.borderRadius === '50%', JSON.stringify(clicked))
    return `dragged ${dragged.width} x ${dragged.height}; clicked ${clicked.width} x ${clicked.height}; border-radius 50%`
  })

  await check('Dragging a corner dot on a circle starts from its real radius, not 50 px, and the radius stays after the drop', async () => {
    const id = (await selected())[0]
    const dot = await app.eval<{ x: number; y: number; title: string }>(`(() => { const d = document.querySelector('.radius-dot[data-radius="nw"]'); const r = d.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, title: d.title } })()`)
    const z = await zoom()
    // Outward: from a full circle (60 px on a 120 px circle) down to 50 px.
    await drag(dot, { x: dot.x - 14 * z, y: dot.y - 14 * z })
    await Bun.sleep(100)
    const after = (await node(id)).style
    expect(dot.title === 'Radius 60', `dot ${dot.title}`)
    expect(after.borderRadius === '46px', `after ${JSON.stringify(after)}`)
    await undo()
    return `dot showed ${dot.title}; dragged 14 px out: ${after.borderRadius}`
  })

  await check('After a corner drag the canvas shows the new radius, also after an alt drag set one corner', async () => {
    await pressKey('r')
    await drag(await screenAt('Free', 300, 250), await screenAt('Free', 420, 340))
    const id = (await selected())[0]
    const z = await zoom()
    const shown = () => app.eval<string>(`(() => { const s = getComputedStyle(document.querySelector('.canvas-world [data-node-id="${id}"]')); return [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius].join(' ') })()`)
    const dot = (corner: string) => app.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector('.radius-dot[data-radius="${corner}"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    const ne = await dot('ne')
    await app.mouseDown(ne.x, ne.y, 1)
    for (let i = 1; i <= 5; i++) await app.mouseMove(ne.x - (8 * z * i) / 5, ne.y + (8 * z * i) / 5, 1, 1)
    await app.mouseUp(ne.x - 8 * z, ne.y + 8 * z, 1)
    await Bun.sleep(150)
    const one = await shown()
    const nw = await dot('nw')
    await drag(nw, { x: nw.x + 20 * z, y: nw.y + 20 * z })
    await Bun.sleep(150)
    const all = await shown()
    const stored = (await node(id)).style
    expect(one === '0px 8px 0px 0px', `after alt drag the canvas shows ${one}`)
    expect(stored.borderRadius === '20px' && all === '20px 20px 20px 20px', `stored ${JSON.stringify(stored)}, canvas shows ${all}`)
    return `alt drag shows ${one}; then a corner drag stores ${stored.borderRadius} and shows ${all}`
  })

  await check('A drag inside the selection over a layer on top moves the selection, not that layer; a click there selects it', async () => {
    // Two sibling layers, the second on top of the first.
    const [under, top] = ['under', 'top']
    await app.eval(`window.opendrawStore.transact('add', (tx) => tx.insertNodes('Free', undefined, [
      { id: 'under', type: 'frame', name: 'Under', style: { position: 'absolute', left: '20px', top: '250px', width: '200px', height: '130px', backgroundColor: '#e5e5e5' }, children: [] },
      { id: 'top', type: 'frame', name: 'Top', style: { position: 'absolute', left: '120px', top: '280px', width: '80px', height: '40px', backgroundColor: '#5b4848' }, children: [] }
    ])), true`)
    await app.eval(`window.opendrawStore.select(['${under}']), true`)
    await Bun.sleep(80)
    const z = await zoom()
    const from = await screenAt('Free', 160, 300)
    // Without cmd, which would pick the deepest layer instead.
    await app.mouseDown(from.x, from.y)
    for (let i = 1; i <= 5; i++) await app.mouseMove(from.x + 6 * z * i, from.y + 2 * z * i, 1)
    await app.mouseUp(from.x + 30 * z, from.y + 10 * z)
    await Bun.sleep(80)
    const moved = (await node(under)).style
    const still = (await node(top)).style
    const after = await selected()
    expect(moved.left === '50px' && moved.top === '260px', `selected layer at ${moved.left}, ${moved.top}`)
    expect(still.left === '120px' && still.top === '280px', `top layer moved to ${still.left}, ${still.top}`)
    expect(after.join() === under, `selection ${after}`)
    const at = await screenAt('Free', 180, 310)
    await app.click(at.x, at.y)
    await Bun.sleep(80)
    const clicked = await selected()
    expect(clicked.join() === top, `click selected ${clicked}`)
    return `dragged over the top layer: selection moved to ${moved.left}, ${moved.top}, top layer stayed; a click selected the top layer`
  })

  await check('A rectangle drawn on empty canvas is an artboard of its own', async () => {
    const before = (await pageNodes()).length
    await pressKey('r')
    const from = await screenAt('Free', 0, 500)
    await drag(from, { x: from.x + 60, y: from.y + 40 })
    const nodes = await pageNodes()
    const made = nodes[nodes.length - 1]
    expect(nodes.length === before + 1 && made.type === 'artboard' && made.name === 'Rectangle', `${nodes.length} nodes; ${made.type} ${made.name}`)
    await undo()
    return `artboard "${made.name}" ${made.style.width} x ${made.style.height}`
  })

  await check('Flex layout on: the three positioned children flow in row order with the gap; off: each stays where it was, positioned; one undo each', async () => {
    await app.eval(`window.opendrawStore.select(['Box']), true`)
    await app.waitFor(`!!document.querySelector('[data-field="flex-layout"] input')`)
    const shown = await app.eval<boolean>(`!!document.querySelector('[data-field="flexDirection"]')`)
    expect(!shown, 'flex fields show while flex is off')
    await clickFlexToggle()
    await Bun.sleep(100)
    const box = await node('Box')
    const order = box.children.map((c: any) => c.id).join()
    expect(box.style.display === 'flex', `display ${box.style.display}`)
    expect(order === 'a,b,c', `order ${order}`)
    expect(box.children.every((c: any) => !c.style.position && !c.style.left && !c.style.top), JSON.stringify(box.children.map((c: any) => c.style)))
    await app.eval(`window.opendrawStore.transact('gap', (tx) => tx.updateStyles(['Box'], { gap: '12px' })), true`)
    await Bun.sleep(80)
    const flowed = await Promise.all(['a', 'b', 'c'].map(offsets))
    expect(flowed[1].x - (flowed[0].x + flowed[0].w) === 12 && flowed[2].x - (flowed[1].x + flowed[1].w) === 12, JSON.stringify(flowed))
    await undo()
    await undo()
    const restored = await node('Box')
    expect(!restored.style.display && restored.children.map((c: any) => c.id).join() === 'c,a,b' && restored.children.every((c: any) => c.style.position === 'absolute'), JSON.stringify(restored))

    // On again, with a gap, then off: the children keep their flowed places.
    await clickFlexToggle()
    await app.eval(`window.opendrawStore.transact('gap', (tx) => tx.updateStyles(['Box'], { gap: '12px' })), true`)
    await Bun.sleep(80)
    const before = await Promise.all(['a', 'b', 'c'].map(offsets))
    await clickFlexToggle()
    await Bun.sleep(100)
    const off = await node('Box')
    const after = await Promise.all(['a', 'b', 'c'].map(offsets))
    expect(!off.style.display && !off.style.gap, `box ${JSON.stringify(off.style)}`)
    expect(off.children.every((c: any) => c.style.position === 'absolute'), JSON.stringify(off.children.map((c: any) => c.style)))
    expect(JSON.stringify(before) === JSON.stringify(after), `before ${JSON.stringify(before)} after ${JSON.stringify(after)}`)
    await undo()
    const again = await node('Box')
    expect(again.style.display === 'flex', `after undo ${again.style.display}`)
    return `on: order ${order}, 12 px gaps; off: ${after.map((b) => `${b.x},${b.y}`).join(' / ')} unchanged`
  })

  await check('write_html with a flex container keeps display: flex and its children unpositioned', async () => {
    const written = await client.call('write_html', {
      fileId,
      targetNodeId: 'Free',
      mode: 'insert-children',
      html: '<div layer-name="Row" style="display: flex; gap: 8px"><div style="width: 20px; height: 20px; background: red"></div><div style="width: 20px; height: 20px; background: blue"></div></div>'
    })
    const row = await node(written.created[0].id)
    expect(row.style.display === 'flex', JSON.stringify(row.style))
    expect(row.children.length === 2 && row.children.every((c: any) => !c.style.position), JSON.stringify(row.children.map((c: any) => c.style)))
    return `Row display ${row.style.display}; children ${row.children.map((c: any) => c.style.position ?? 'static').join(', ')}`
  })

  await check('A new file starts with an artboard that has no layout', async () => {
    await app.key('n', 'KeyN', CMD, 78)
    await app.waitFor(`document.querySelector('[data-testid=tab].active .tab-name')?.textContent === 'Untitled'`)
    await Bun.sleep(200)
    const artboard = (await pageNodes())[0]
    expect(artboard.type === 'artboard' && !artboard.style.display && !artboard.style.flexDirection, JSON.stringify(artboard.style))
    return `${artboard.name}: ${Object.keys(artboard.style).join(', ')}`
  })
} finally {
  client.close()
  await app.kill()
}

await finish('shapes')
