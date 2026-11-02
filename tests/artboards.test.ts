// End-to-end acceptance checks for S-40 (artboards behave like Figma frames). Run with `bun run test:artboards`.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { App, cleanProfile } from './cdp'
import { check, expect, finish } from './checks'

const CMD = process.platform === 'darwin' ? 4 : 2
const SHIFT = 8

const profile = cleanProfile()
mkdirSync(profile.workspace, { recursive: true })
const layer = (id: string, left: number, top: number) => ({
  id,
  type: 'frame',
  name: id,
  style: { position: 'absolute', left: `${left}px`, top: `${top}px`, width: '60px', height: '40px', backgroundColor: '#5b4848' },
  children: []
})
writeFileSync(
  path.join(profile.workspace, 'Boards.opendraw'),
  JSON.stringify({
    format: 'opendraw',
    version: 1,
    id: 'boards',
    name: 'Boards',
    pages: [
      {
        id: 'page-1',
        name: 'Page 1',
        nodes: [
          {
            id: 'Board',
            type: 'artboard',
            name: 'Board',
            style: { left: '0px', top: '0px', width: '600px', height: '400px', backgroundColor: '#ffffff' },
            children: [layer('one', 40, 40), layer('two', 160, 40), layer('three', 400, 280)]
          }
        ]
      }
    ]
  })
)

const app = await App.launch(profile, 9421)
await app.waitFor(`!!document.querySelector('[data-node-id="one"]')`)
await app.key('!', 'Digit1', SHIFT, 49)
await Bun.sleep(200)

const style = () => app.eval<any>(`window.opendrawStore.getState().document.pages[0].nodes[0].style`)
const selected = () => app.eval<string[]>('window.opendrawStore.getState().selection')
const zoom = () => app.eval<number>(`Number(document.querySelector('.canvas-world').dataset.zoom)`)
const undo = () => app.key('z', 'KeyZ', CMD, 90)
const at = async (x: number, y: number) => {
  const r = await app.rect('.canvas-world [data-node-id="Board"]')
  const z = await zoom()
  return { x: r.x + x * z, y: r.y + y * z }
}
const center = (selector: string) =>
  app.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector('${selector}').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
/** Snapping off (cmd), so a drag lands exactly where the pointer went. */
const drag = async (from: { x: number; y: number }, to: { x: number; y: number }, modifiers = CMD) => {
  await app.mouseDown(from.x, from.y, modifiers)
  for (let i = 1; i <= 5; i++) await app.mouseMove(from.x + ((to.x - from.x) * i) / 5, from.y + ((to.y - from.y) * i) / 5, 1, modifiers)
  await app.mouseUp(to.x, to.y, modifiers)
  await Bun.sleep(100)
}

try {
  await check('A selected artboard shows resize handles on e, s and se only, no radius dots and no rotate zones', async () => {
    await app.eval(`window.opendrawStore.select(['Board']), true`)
    await Bun.sleep(100)
    const handles = await app.eval<string[]>(`[...document.querySelectorAll('.resize-handle')].map((h) => h.dataset.handle).sort()`)
    const radius = await app.eval<number>(`document.querySelectorAll('.radius-dot').length`)
    const rotate = await app.eval<number>(`document.querySelectorAll('.rotate-zone').length`)
    expect(handles.join() === 'e,s,se', `handles ${handles}`)
    expect(radius === 0 && rotate === 0, `radius ${radius}, rotate ${rotate}`)
    return `handles ${handles.join(', ')}; 0 radius dots; 0 rotate zones`
  })

  await check('Dragging the right handle 100 px widens the artboard by 100 with left unchanged; the bottom handle adds height', async () => {
    const z = await zoom()
    const e = await center('.resize-handle[data-handle="e"]')
    await drag(e, { x: e.x + 100 * z, y: e.y })
    const wide = await style()
    const s = await center('.resize-handle[data-handle="s"]')
    await drag(s, { x: s.x, y: s.y + 50 * z })
    const tall = await style()
    expect(wide.width === '700px' && wide.left === '0px', JSON.stringify(wide))
    expect(tall.height === '450px' && tall.top === '0px', JSON.stringify(tall))
    await undo()
    await undo()
    return `width ${wide.width}, left ${wide.left}; height ${tall.height}, top ${tall.top}`
  })

  await check('A drag across two of three layers from the artboard empty area selects exactly those two; the artboard does not move', async () => {
    await app.eval(`window.opendrawStore.select([]), true`)
    const before = await style()
    // Plain drag: cmd would pick the deepest layer.
    await drag(await at(20, 20), await at(200, 120), 0)
    const picked = (await selected()).sort()
    const after = await style()
    expect(picked.join() === 'one,two', `selected ${picked}`)
    expect(after.left === before.left && after.top === before.top, `artboard moved to ${after.left}, ${after.top}`)
    const empty = await at(300, 200)
    await app.click(empty.x, empty.y)
    await Bun.sleep(80)
    const clicked = await selected()
    expect(clicked.join() === 'Board', `click on empty area selected ${clicked}`)
    return `selected ${picked.join(', ')}; artboard stayed at ${after.left}, ${after.top}; a click selected Board`
  })

  await check('Dragging the artboard name label 100 px right moves it 100 px; one undo moves it back', async () => {
    const z = await zoom()
    const label = await center('.artboard-label')
    await drag(label, { x: label.x + 100 * z, y: label.y })
    const moved = await style()
    expect(moved.left === '100px' && moved.top === '0px', JSON.stringify(moved))
    await undo()
    const back = await style()
    expect(back.left === '0px', `after undo ${back.left}`)
    return `label drag moved Board to ${moved.left}; undo back to ${back.left}`
  })
} finally {
  await app.kill()
}

await finish('artboards')
