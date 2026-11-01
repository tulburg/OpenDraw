// Object interactions end to end (S-11): select, move, nudge, resize, rotate, reorder, reparent,
// alt-duplicate, multi-select drag and snapping, each with undo and redo, at zoom 0.5, 1 and 2.
// Run with `bun run test:interactions`.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { App, cleanProfile } from './cdp'
import { check, expect, finish, RESULTS_DIR } from './checks'

const CMD = process.platform === 'darwin' ? 4 : 2
const SHIFT = 8
const ALT = 1
const ZOOMS = [0.5, 1, 2] as const

const frame = (id: string, left: number, top: number, width = 80, height = 60, extra: object = {}, children: object[] = []) => ({
  id,
  type: 'frame',
  name: id,
  style: { position: 'absolute', left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`, backgroundColor: '#7a9cff', ...extra },
  children
})
const item = (id: string) => ({ id, type: 'frame', name: id, style: { width: '40px', height: '40px', backgroundColor: '#ff5a36' }, children: [] })
const DOCUMENT = {
  format: 'opendraw',
  version: 1,
  id: 'file-1',
  name: 'Interactions test',
  pages: [
    {
      id: 'page-1',
      name: 'Page 1',
      nodes: [
        {
          id: 'A',
          type: 'artboard',
          name: 'A',
          style: { left: '0px', top: '0px', width: '400px', height: '300px', backgroundColor: '#ffffff' },
          children: [
            frame('P1', 40, 40),
            frame('P2', 200, 40),
            frame('P3', 40, 160),
            frame('Flex1', 200, 160, 180, 100, { display: 'flex', gap: '10px', padding: '10px', backgroundColor: '#eeeeee' }, [item('F1'), item('F2')])
          ]
        },
        {
          id: 'B',
          type: 'artboard',
          name: 'B',
          style: { left: '440px', top: '0px', width: '300px', height: '300px', backgroundColor: '#ffffff' },
          children: [frame('Flex2', 20, 20, 200, 100, { display: 'flex', gap: '10px', padding: '10px', backgroundColor: '#eeeeee' }, [item('F3')])]
        }
      ]
    }
  ]
}

const profile = cleanProfile()
mkdirSync(profile.workspace, { recursive: true })
const filePath = path.join(profile.workspace, 'Interactions test.opendraw')
writeFileSync(filePath, JSON.stringify(DOCUMENT))

const app = await App.launch(profile)

const find = (id: string) =>
  app.eval<any>(`(() => {
    const find = (nodes) => { for (const n of nodes) { if (n.id === ${JSON.stringify(id)}) return n; const f = find(n.children); if (f) return f } return null }
    return find(window.opendrawStore.getState().document.pages[0].nodes)
  })()`)
const style = async (id: string) => (await find(id)).style as Record<string, string>
const childIds = async (id: string) => ((await find(id)).children as any[]).map((c) => c.id).join()
const selection = () => app.eval<string[]>('window.opendrawStore.getState().selection')
const select = async (...ids: string[]) => {
  await app.eval(`window.opendrawStore.select(${JSON.stringify(ids)})`)
  await Bun.sleep(60)
}
const undo = async () => {
  await app.key('z', 'KeyZ', CMD, 90)
  await Bun.sleep(50)
}
const redo = async () => {
  await app.key('z', 'KeyZ', CMD | SHIFT, 90)
  await Bun.sleep(50)
}
const zoom = () => app.eval<number>(`Number(document.querySelector('.canvas-world').dataset.zoom)`)
const setZoom = async (level: number) => {
  await app.key('!', 'Digit1', SHIFT, 49)
  await app.key('0', 'Digit0', CMD, 48)
  if (level === 0.5) await app.key('-', 'Minus', CMD, 189)
  if (level === 2) await app.key('=', 'Equal', CMD, 187)
  await Bun.sleep(100)
}
const rect = (id: string) => app.rect(`.canvas-world [data-node-id="${id}"]`)
const centerOf = async (selector: string) => {
  const r = await app.rect(selector)
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
}
/** Pans so a layer's center sits in the middle of the canvas. */
const focus = async (id: string) => {
  const canvas = await app.rect('.canvas')
  const c = await centerOf(`.canvas-world [data-node-id="${id}"]`)
  await app.wheel(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2, c.x - (canvas.x + canvas.width / 2), c.y - (canvas.y + canvas.height / 2))
  await Bun.sleep(60)
}
/** Pans so a point of artboard A (A sits at the page origin) is in the middle of the canvas. */
const focusWorld = async (x: number, y: number) => {
  const canvas = await app.rect('.canvas')
  const a = await rect('A')
  const z = await zoom()
  const cx = canvas.x + canvas.width / 2
  const cy = canvas.y + canvas.height / 2
  await app.wheel(cx, cy, a.x + x * z - cx, a.y + y * z - cy)
  await Bun.sleep(60)
}
/**
 * Presses at `from`, moves by (dx, dy) screen px in steps, and releases. `held` modifiers apply to the
 * moves and the release (pressing with shift would toggle the selection instead of dragging).
 */
const drag = async (from: { x: number; y: number }, dx: number, dy: number, held = 0, pressed = 0, beforeRelease?: () => Promise<void>) => {
  await app.mouseDown(from.x, from.y, pressed)
  for (let i = 1; i <= 8; i++) await app.mouseMove(from.x + (dx * i) / 8, from.y + (dy * i) / 8, 1, held)
  await beforeRelease?.()
  await app.mouseUp(from.x + dx, from.y + dy, held)
  await Bun.sleep(80)
}
const reset = async () => {
  await app.eval(`(() => { const s = window.opendrawStore; while (s.getState().canUndo) s.undo(); return true })()`)
  await select()
}

try {
  await check('Select, move with snapping on and off, and nudge; undo and redo each (zoom 0.5, 1, 2)', async () => {
    const results: string[] = []
    for (const level of ZOOMS) {
      await setZoom(level)
      await focus('P1')
      const z = await zoom()
      const p1 = await centerOf('.canvas-world [data-node-id="P1"]')
      await app.clickWith(p1.x, p1.y, 0)
      expect((await selection()).join() === 'P1', `zoom ${z}: click picked ${await selection()}`)

      // To 3 screen px short of P2's left edge: it snaps onto it, with a guide.
      let guides = 0
      await drag(p1, 160 * z - 3, 0, 0, 0, async () => {
        guides = await app.eval<number>(`document.querySelectorAll('.snap-guide').length`)
      })
      expect((await style('P1')).left === '200px' && guides > 0, `zoom ${z}: snapped to ${(await style('P1')).left}, ${guides} guides`)
      await undo()
      expect((await style('P1')).left === '40px', `zoom ${z}: undo gave ${(await style('P1')).left}`)
      await redo()
      expect((await style('P1')).left === '200px', `zoom ${z}: redo gave ${(await style('P1')).left}`)
      await undo()

      // The same drag with cmd held lands where dropped.
      await drag(p1, 160 * z - 3, 0, CMD, CMD)
      const free = (await style('P1')).left
      expect(free === `${Math.round(200 - 3 / z)}px`, `zoom ${z}: cmd drag landed at ${free}`)
      await undo()

      // Nudge: three arrow presses are one step.
      await select('P1')
      for (let i = 0; i < 3; i++) await app.key('ArrowRight', 'ArrowRight', 0, 39)
      await Bun.sleep(650)
      expect((await style('P1')).left === '43px', `zoom ${z}: nudge gave ${(await style('P1')).left}`)
      await undo()
      expect((await style('P1')).left === '40px', `zoom ${z}: nudge undo gave ${(await style('P1')).left}`)
      results.push(`zoom ${z}: snap 200px with guide, cmd ${free}, nudge 43px`)
    }
    await reset()
    return results.join('; ')
  })

  await check('Shift-dragging 100 px right and 20 px down moves only horizontally (zoom 0.5, 1, 2)', async () => {
    const results: string[] = []
    for (const level of ZOOMS) {
      await setZoom(level)
      await focus('P1')
      const z = await zoom()
      await select('P1')
      await drag(await centerOf('.canvas-world [data-node-id="P1"]'), 100 * z, 20 * z, SHIFT)
      const s = await style('P1')
      expect(s.left === '140px' && s.top === '40px', `zoom ${z}: ${s.left}, ${s.top}`)
      await undo()
      results.push(`zoom ${z}: ${s.left}, ${s.top}`)
    }
    return results.join('; ')
  })

  await check('Resizing from each of the eight handles changes the expected edges; one undo each (zoom 0.5, 1, 2)', async () => {
    const expected: Record<string, Partial<Record<'left' | 'top' | 'width' | 'height', number>>> = {
      e: { width: 100 },
      w: { left: 60, width: 60 },
      s: { height: 80 },
      n: { top: 60, height: 40 },
      se: { width: 100, height: 80 },
      nw: { left: 60, top: 60, width: 60, height: 40 },
      ne: { top: 60, width: 100, height: 40 },
      sw: { left: 60, width: 60, height: 80 }
    }
    const base = { left: 40, top: 40, width: 80, height: 60 }
    const results: string[] = []
    for (const level of ZOOMS) {
      await setZoom(level)
      await focus('P1')
      const z = await zoom()
      for (const [handle, change] of Object.entries(expected)) {
        await select('P1')
        // Snapping off (cmd), so only the handle math is checked here.
        await drag(await centerOf(`.resize-handle[data-handle="${handle}"]`), 20 * z, 20 * z, CMD, CMD)
        const s = await style('P1')
        const want = { ...base, ...change }
        const got = { left: Number.parseFloat(s.left), top: Number.parseFloat(s.top), width: Number.parseFloat(s.width), height: Number.parseFloat(s.height) }
        expect(JSON.stringify(got) === JSON.stringify(want), `zoom ${z} ${handle}: ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`)
        await undo()
        expect((await style('P1')).width === '80px' && (await style('P1')).left === '40px', `zoom ${z} ${handle}: undo did not restore`)
      }
      results.push(`zoom ${z}: 8 handles`)
    }
    return results.join('; ')
  })

  await check('Resizing and drawing snap their moving edges', async () => {
    await setZoom(1)
    await focus('P1')
    await select('P1')
    // East edge to 3 px short of P2's left edge (200): it snaps to 200.
    await drag(await centerOf('.resize-handle[data-handle="e"]'), 77, 0)
    const resized = (await style('P1')).width
    expect(resized === '160px', `resize snapped width to ${resized}`)
    await undo()
    // Draw a frame starting 3 px right of P3's left edge: its left snaps to 40.
    await app.key('f', 'KeyF', 0, 70)
    const a = await rect('A')
    const z = await zoom()
    await drag({ x: a.x + 43 * z, y: a.y + 240 * z }, 60 * z, 30 * z)
    const drawn = (await find('A')).children.at(-1)
    expect(drawn.style.left === '40px', `drawn frame left ${drawn.style.left}`)
    await undo()
    return `resize width 157 -> ${resized}; drawn frame left ${drawn.style.left}`
  })

  await check('Rotating, reordering, and moving a flex child into another container; undo and redo each (zoom 0.5, 1, 2)', async () => {
    const results: string[] = []
    for (const level of ZOOMS) {
      await setZoom(level)
      await focus('P2')
      const z = await zoom()
      await select('P2')
      const center = await centerOf('.canvas-world [data-node-id="P2"]')
      const start = await centerOf('.rotate-zone[data-rotate="ne"]')
      const v = { x: start.x - center.x, y: start.y - center.y }
      await app.mouseDown(start.x, start.y)
      for (let i = 1; i <= 9; i++) {
        const a = (Math.PI / 2) * (i / 9)
        await app.mouseMove(center.x + v.x * Math.cos(a) - v.y * Math.sin(a), center.y + v.x * Math.sin(a) + v.y * Math.cos(a), 1)
      }
      await app.mouseUp(center.x - v.y, center.y + v.x)
      await Bun.sleep(80)
      const angle = Number.parseFloat((await style('P2')).rotate)
      expect(Math.abs(angle - 90) <= 1, `zoom ${z}: rotate ${angle}`)
      await undo()
      expect(!(await style('P2')).rotate, `zoom ${z}: undo left rotate`)
      await redo()
      expect(!!(await style('P2')).rotate, `zoom ${z}: redo lost rotate`)
      await undo()

      await focus('Flex1')
      await select('F1')
      const f1 = await centerOf('.canvas-world [data-node-id="F1"]')
      await drag(f1, 70 * z, 0)
      expect((await childIds('Flex1')) === 'F2,F1', `zoom ${z}: reorder gave ${await childIds('Flex1')}`)
      await undo()
      expect((await childIds('Flex1')) === 'F1,F2', `zoom ${z}: undo gave ${await childIds('Flex1')}`)
      await redo()
      expect((await childIds('Flex1')) === 'F2,F1', `zoom ${z}: redo gave ${await childIds('Flex1')}`)
      await undo()

      // F1 into Flex2 on the other artboard: aim at Flex2's empty end.
      await focusWorld(430, 150)
      await select('F1')
      const from = await centerOf('.canvas-world [data-node-id="F1"]')
      const flex2 = await rect('Flex2')
      await drag(from, flex2.x + flex2.width - 30 * z - from.x, flex2.y + flex2.height / 2 - from.y)
      expect((await childIds('Flex2')) === 'F3,F1' && (await childIds('Flex1')) === 'F2', `zoom ${z}: Flex2 ${await childIds('Flex2')}, Flex1 ${await childIds('Flex1')}`)
      await undo()
      expect((await childIds('Flex1')) === 'F1,F2' && (await childIds('Flex2')) === 'F3', `zoom ${z}: undo did not move F1 back`)
      results.push(`zoom ${z}: rotate ${angle}, reorder F2,F1, F1 into Flex2`)
    }
    await reset()
    return results.join('; ')
  })

  await check('Dragging a positioned frame onto another artboard reparents it with no visible jump; undo restores (zoom 0.5, 1, 2)', async () => {
    const results: string[] = []
    for (const level of ZOOMS) {
      await setZoom(level)
      const z = await zoom()
      await focusWorld(290, 190)
      await select('P3')
      const from = await centerOf('.canvas-world [data-node-id="P3"]')
      const b = await rect('B')
      let before = { x: 0, y: 0, width: 0, height: 0 }
      await drag(from, b.x + 60 * z - from.x, b.y + 220 * z - from.y, CMD, 0, async () => {
        before = await rect('P3')
      })
      const after = await rect('P3')
      const jump = Math.hypot(after.x - before.x, after.y - before.y)
      const inB = (await childIds('B')).split(',').includes('P3')
      expect(inB, `zoom ${z}: B has ${await childIds('B')}`)
      expect(jump <= 1, `zoom ${z}: jumped ${jump.toFixed(2)} px`)
      await undo()
      const s = await style('P3')
      expect((await childIds('A')).includes('P3') && s.left === '40px' && s.top === '160px', `zoom ${z}: undo gave ${await childIds('A')} ${s.left},${s.top}`)
      results.push(`zoom ${z}: into B, moved ${jump.toFixed(2)} px on drop`)
    }
    return results.join('; ')
  })

  await check('Alt-drag leaves the original and adds a copy at the drop point; dragging two layers moves both (zoom 0.5, 1, 2)', async () => {
    const results: string[] = []
    for (const level of ZOOMS) {
      await setZoom(level)
      await focus('P1')
      const z = await zoom()
      await select('P1')
      await drag(await centerOf('.canvas-world [data-node-id="P1"]'), 0, 110 * z, ALT, ALT)
      const kids = (await find('A')).children as any[]
      const copy = kids.find((k) => !['P1', 'P2', 'P3', 'Flex1'].includes(k.id))
      const original = await style('P1')
      expect(kids.length === 5 && copy && copy.style.top === '150px' && copy.style.left === '40px', `zoom ${z}: ${JSON.stringify(copy?.style)}`)
      expect(original.top === '40px' && original.left === '40px', `zoom ${z}: original moved to ${original.left},${original.top}`)
      expect((await selection()).join() === copy.id, `zoom ${z}: selection ${await selection()}`)
      await undo()
      expect(((await find('A')).children as any[]).length === 4, `zoom ${z}: one undo did not remove the copy`)
      await redo()
      expect(((await find('A')).children as any[]).length === 5, `zoom ${z}: redo did not restore the copy`)
      await undo()

      await select('P1', 'P2')
      await drag(await centerOf('.canvas-world [data-node-id="P1"]'), 60 * z, 0)
      const [p1, p2] = [await style('P1'), await style('P2')]
      expect(p1.left === '100px' && p2.left === '260px', `zoom ${z}: P1 ${p1.left}, P2 ${p2.left}`)
      await undo()
      expect((await style('P1')).left === '40px' && (await style('P2')).left === '200px', `zoom ${z}: undo did not restore both`)
      results.push(`zoom ${z}: copy at ${copy.style.left},${copy.style.top}; both moved 60`)
    }
    return results.join('; ')
  })

  await check('Moving a layer snaps to equal spacing with its siblings and shows spacing markers', async () => {
    await setZoom(1)
    await app.eval(`window.opendrawStore.transact('test', (tx) => tx.updateStyles(['P3'], { left: '300px', top: '40px' })), true`)
    await focus('P2')
    await select('P3')
    // P1 (40-120) and P2 (200-280) are 80 apart; P3 dropped 2 px past 360 snaps to 360.
    let markers = 0
    await drag(await centerOf('.canvas-world [data-node-id="P3"]'), 62, 0, 0, 0, async () => {
      markers = await app.eval<number>(`document.querySelectorAll('.spacing-marker').length`)
      await app.screenshot(path.join(RESULTS_DIR, 'interactions-spacing.png'))
    })
    const left = (await style('P3')).left
    expect(left === '360px' && markers >= 2, `P3 at ${left}, ${markers} markers`)
    await reset()
    return `P3 snapped to ${left} with ${markers} spacing markers`
  })
} finally {
  await app.kill()
}

await finish('interactions')
