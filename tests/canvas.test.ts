// End-to-end acceptance checks for S-6 (canvas selection and direct manipulation).
// Run with `bun run test:canvas`.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { App, cleanProfile } from './cdp'
import { check, expect, finish, RESULTS_DIR } from './checks'

const CMD = process.platform === 'darwin' ? 4 : 2
const SHIFT = 8

const frame = (id: string, style: Record<string, string>, children: object[] = []) => ({
  id,
  type: 'frame',
  name: id,
  style,
  children
})
const artboard = (id: string, left: number, width: number, height: number, children: object[] = []) => ({
  id,
  type: 'artboard',
  name: id,
  style: {
    left: `${left}px`,
    top: '0px',
    width: `${width}px`,
    height: `${height}px`,
    backgroundColor: '#ffffff',
    display: 'flex',
    flexDirection: 'column',
    padding: '40px',
    gap: '20px'
  },
  children
})

// Three levels: artboard Test > Card > A, B, C (a flex row), plus an absolutely positioned Badge.
const profile = cleanProfile()
mkdirSync(profile.workspace, { recursive: true })
writeFileSync(
  path.join(profile.workspace, 'Canvas test.opendraw'),
  JSON.stringify({
    format: 'opendraw',
    version: 1,
    id: 'file-1',
    name: 'Canvas test',
    pages: [
      {
        id: 'page-1',
        name: 'Page 1',
        nodes: [
          artboard('Test', 0, 800, 500, [
            frame(
              'Card',
              { display: 'flex', flexDirection: 'row', gap: '10px', padding: '10px', width: '400px', height: '120px', backgroundColor: '#eeeeee' },
              [
                frame('A', { width: '80px', height: '80px', backgroundColor: '#ff6b6b' }),
                frame('B', { width: '80px', height: '80px', backgroundColor: '#4dabf7' }),
                frame('C', { width: '80px', height: '80px', backgroundColor: '#51cf66' })
              ]
            ),
            frame('Badge', { position: 'absolute', left: '600px', top: '300px', width: '50px', height: '50px', backgroundColor: '#fab005' })
          ]),
          artboard('Two', 900, 400, 300),
          artboard('Three', 1380, 400, 300)
        ]
      }
    ]
  })
)

const app = await App.launch(profile)
const selection = () => app.eval<string[]>('window.opendrawStore.getState().selection')
const node = (id: string) =>
  app.eval(`(() => {
    const find = (nodes) => { for (const n of nodes) { if (n.id === ${JSON.stringify(id)}) return n; const f = find(n.children); if (f) return f } return null }
    return find(window.opendrawStore.getState().document.pages[0].nodes)
  })()`)
const childIds = async (id: string) => ((await node(id)) as any).children.map((c: any) => c.id).join(',')
const center = async (id: string) => {
  const r = await app.rect(`[data-node-id="${id}"]`)
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
}
const zoom = () => app.eval<number>(`Number(document.querySelector('.canvas-world').dataset.zoom)`)
const undo = () => app.key('z', 'KeyZ', CMD, 90)
const escape = () => app.key('Escape', 'Escape', 0, 27)

// Fit everything, so all three artboards are on screen.
await app.key('!', 'Digit1', SHIFT, 49)
await Bun.sleep(200)

try {
  await check('Click, double-click, cmd + click and Escape pick the layer at each depth', async () => {
    const a = await center('A')
    await app.clickWith(a.x, a.y, 0)
    expect((await selection()).join() === 'Card', `click picked ${await selection()}`)
    await app.clickWith(a.x, a.y, 0, 2)
    expect((await selection()).join() === 'A', `double-click picked ${await selection()}`)
    const b = await center('B')
    await app.clickWith(b.x, b.y, 0)
    expect((await selection()).join() === 'B', `click on a sibling picked ${await selection()}`)
    await escape()
    expect((await selection()).join() === 'Card', `Escape went to ${await selection()}`)
    await escape()
    expect((await selection()).join() === 'Test', `second Escape went to ${await selection()}`)
    await escape()
    expect((await selection()).length === 0, 'third Escape kept a selection')
    await app.clickWith(a.x, a.y, CMD)
    expect((await selection()).join() === 'A', `cmd + click picked ${await selection()}`)
    const empty = await app.rect('[data-node-id="Test"]')
    await app.clickWith(empty.x + empty.width / 2, empty.y + empty.height - 10, 0)
    expect((await selection()).join() === 'Test', `click on empty artboard area picked ${await selection()}`)
    // Hover outlines what a click would pick.
    await escape()
    await app.mouseMove(b.x, b.y)
    await Bun.sleep(50)
    const hover = await app.eval(`!!document.querySelector('.hover-outline')`)
    expect(hover, 'no hover outline')
    const handles = await app.eval<number>(`(window.opendrawStore.select(['Card']), new Promise((r) => setTimeout(() =>
      r(document.querySelectorAll('.resize-handle').length + ':' + document.querySelector('.size-label')?.textContent), 50)))`)
    expect(String(handles) === '8:400 x 120', `handles and size label: ${handles}`)
    await app.screenshot(path.join(RESULTS_DIR, 'canvas-selection.png'))
    return 'Card, A, B, then Escape to Card, Test, nothing; cmd + click A; empty area Test; hover outline; 8 handles and "400 x 120"'
  })

  await check('Dragging an artboard 100 px moves it by 100 at another zoom; nothing is written mid-drag; one undo restores it', async () => {
    await app.key('0', 'Digit0', CMD, 48)
    await app.key('-', 'Minus', CMD, 189)
    await Bun.sleep(100)
    const z = await zoom()
    expect(z === 0.5, `zoom ${z}`)
    const label = await app.rect('.artboard-label[data-select-id="Two"]')
    const from = { x: label.x + 5, y: label.y + label.height / 2 }
    await app.mouseDown(from.x, from.y)
    for (let i = 1; i <= 5; i++) await app.mouseMove(from.x + (100 * z * i) / 5, from.y, 1)
    const midDrag = ((await node('Two')) as any).style.left
    await app.mouseUp(from.x + 100 * z, from.y)
    const after = ((await node('Two')) as any).style.left
    expect(midDrag === '900px', `the document changed during the drag: ${midDrag}`)
    expect(after === '1000px', `left after drag: ${after}`)
    await undo()
    const undone = ((await node('Two')) as any).style.left
    expect(undone === '900px', `left after undo: ${undone}`)
    await app.key('!', 'Digit1', SHIFT, 49)
    await Bun.sleep(100)
    return `zoom ${z}: 900px -> 1000px -> undo 900px`
  })

  await check('Dragging the first of three flex children to the end gives 2, 3, 1; undo restores 1, 2, 3', async () => {
    const a = await center('A')
    await app.clickWith(a.x, a.y, CMD)
    const c = await app.rect('[data-node-id="C"]')
    await app.drag(a, { x: c.x + c.width + 10, y: a.y })
    const order = await childIds('Card')
    expect(order === 'B,C,A', `order after drag: ${order}`)
    await undo()
    const restored = await childIds('Card')
    expect(restored === 'A,B,C', `order after undo: ${restored}`)
    return `${order}, then ${restored}`
  })

  await check('A resize handle sets 300 x 200 in px; shift keeps the ratio', async () => {
    await app.eval(`window.opendrawStore.select(['Card'])`)
    await Bun.sleep(50)
    const z = await zoom()
    const se = await app.rect('.resize-handle[data-handle="se"]')
    const from = { x: se.x + se.width / 2, y: se.y + se.height / 2 }
    // Snapping (S-11) is held off with cmd, so the drag lands exactly where it ends.
    await app.mouseDown(from.x, from.y, CMD)
    for (let i = 1; i <= 5; i++) await app.mouseMove(from.x - (100 * z * i) / 5, from.y + (80 * z * i) / 5, 1, CMD)
    await app.mouseUp(from.x - 100 * z, from.y + 80 * z, CMD)
    const style = ((await node('Card')) as any).style
    expect(style.width === '300px' && style.height === '200px', `size ${style.width} x ${style.height}`)
    const e = await app.rect('.resize-handle[data-handle="e"]')
    const eFrom = { x: e.x + e.width / 2, y: e.y + e.height / 2 }
    await app.mouseDown(eFrom.x, eFrom.y, SHIFT)
    for (let i = 1; i <= 5; i++) await app.mouseMove(eFrom.x + (60 * z * i) / 5, eFrom.y, 1, SHIFT)
    await app.mouseUp(eFrom.x + 60 * z, eFrom.y, SHIFT)
    const ratio = ((await node('Card')) as any).style
    const w = Number.parseFloat(ratio.width)
    const h = Number.parseFloat(ratio.height)
    expect(Math.abs(w / 1.5 - h) <= 1, `shift-resize gave ${w} x ${h}, not 3:2`)
    await undo()
    await undo()
    const restored = ((await node('Card')) as any).style
    expect(restored.width === '400px' && restored.height === '120px', `after two undos ${restored.width} x ${restored.height}`)
    return `300px x 200px, then shift to ${w} x ${h}; two undos back to 400 x 120`
  })

  await check('Delete, duplicate, copy and paste each work and are one undo step', async () => {
    const badge = await center('Badge')
    await app.clickWith(badge.x, badge.y, 0)
    expect((await selection()).join() === 'Badge', `picked ${await selection()}`)

    await app.key('Backspace', 'Backspace', 0, 8)
    expect(!(await node('Badge')), 'Backspace did not delete')
    await undo()
    expect(!!(await node('Badge')), 'undo did not bring the layer back')

    await app.eval(`window.opendrawStore.select(['Badge'])`)
    await app.key('d', 'KeyD', CMD, 68)
    const afterDuplicate = await childIds('Test')
    const [copy] = await selection()
    expect(afterDuplicate.split(',').length === 3 && copy !== 'Badge', `children after duplicate: ${afterDuplicate}`)
    await undo()
    expect((await childIds('Test')) === 'Card,Badge', 'undo did not remove the duplicate')

    await app.eval(`window.opendrawStore.select(['A'])`)
    await app.command('copy', 'c')
    await app.eval(`window.opendrawStore.select(['Card'])`)
    await app.command('paste', 'v')
    const pasted = await childIds('Card')
    expect(pasted.split(',').length === 4 && pasted.startsWith('A,B,C,'), `Card after paste: ${pasted}`)
    const pastedNode = (await node(pasted.split(',')[3])) as any
    expect(pastedNode.name === 'A' && pastedNode.style.backgroundColor === '#ff6b6b', 'the pasted layer is not a copy of A')
    await undo()
    expect((await childIds('Card')) === 'A,B,C', 'undo did not remove the pasted layer')
    return 'delete, duplicate, copy + paste into Card; each undone in one step'
  })

  await check('Arrow keys nudge 1 px, shift 10 px, as one undo step', async () => {
    await app.eval(`window.opendrawStore.select(['Badge'])`)
    for (let i = 0; i < 3; i++) await app.key('ArrowRight', 'ArrowRight', 0, 39)
    await app.key('ArrowDown', 'ArrowDown', SHIFT, 40)
    await Bun.sleep(700)
    const style = ((await node('Badge')) as any).style
    expect(style.left === '603px' && style.top === '310px', `after nudges ${style.left}, ${style.top}`)
    await undo()
    const restored = ((await node('Badge')) as any).style
    expect(restored.left === '600px' && restored.top === '300px', `after undo ${restored.left}, ${restored.top}`)
  })

  await check('A marquee over two of three artboards selects exactly those; the layers panel shows both', async () => {
    await escape()
    await escape()
    const two = await app.rect('[data-node-id="Two"]')
    const three = await app.rect('[data-node-id="Three"]')
    await app.drag({ x: two.x + 20, y: two.y + two.height + 30 }, { x: three.x + 20, y: three.y + three.height - 20 })
    const selected = (await selection()).sort().join()
    expect(selected === 'Three,Two', `marquee selected ${selected}`)
    const rows = await app.eval<string[]>(`[...document.querySelectorAll('.layer-row[data-selected]')].map((r) => r.dataset.layerId).sort()`)
    expect(rows.join() === 'Three,Two', `layers panel selected ${rows}`)
    await app.key('a', 'KeyA', CMD, 65)
    const all = (await selection()).sort().join()
    expect(all === 'Test,Three,Two', `cmd + A selected ${all}`)
    return `marquee: ${selected}; cmd + A: ${all}`
  })
} finally {
  await app.kill()
}

await finish('canvas')
