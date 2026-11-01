// End-to-end acceptance checks for S-10 (on-canvas handles). Run with `bun run test:handles`.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { App, cleanProfile } from './cdp'
import { check, expect, finish, RESULTS_DIR } from './checks'
import { BridgeClient } from './mcp-client'

const CMD = process.platform === 'darwin' ? 4 : 2
const SHIFT = 8
const ALT = 1
const DOT_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='

const profile = cleanProfile()
mkdirSync(profile.workspace, { recursive: true })
writeFileSync(
  path.join(profile.workspace, 'Handles test.opendraw'),
  JSON.stringify({
    format: 'opendraw',
    version: 1,
    id: 'file-1',
    name: 'Handles test',
    pages: [
      {
        id: 'page-1',
        name: 'Page 1',
        nodes: [
          {
            id: 'Board',
            type: 'artboard',
            name: 'Board',
            style: { left: '0px', top: '0px', width: '800px', height: '600px', backgroundColor: '#ffffff' },
            children: [
              { id: 'Box', type: 'frame', name: 'Box', style: { position: 'absolute', left: '300px', top: '250px', width: '200px', height: '100px', backgroundColor: '#ff5a36' }, children: [] },
              { id: 'Pic', type: 'image', name: 'Pic', src: DOT_PNG, style: { position: 'absolute', left: '600px', top: '50px', width: '80px', height: '80px' }, children: [] },
              { id: 'Label', type: 'text', name: 'Label', text: 'Label text', style: { position: 'absolute', left: '50px', top: '50px', fontSize: '32px' }, children: [] },
              {
                id: 'Row',
                type: 'frame',
                name: 'Row',
                style: { position: 'absolute', left: '50px', top: '420px', width: '300px', height: '120px', display: 'flex', padding: '10px', gap: '10px', backgroundColor: '#eeeeee' },
                children: [
                  { id: 'R1', type: 'frame', name: 'R1', style: { width: '50px', height: '50px', backgroundColor: '#3366ff' }, children: [] },
                  { id: 'R2', type: 'frame', name: 'R2', style: { width: '50px', height: '50px', backgroundColor: '#3366ff' }, children: [] }
                ]
              }
            ]
          }
        ]
      }
    ]
  })
)

const app = await App.launch(profile)
const client = await BridgeClient.start(path.join(profile.userData, 'mcp.json'))

const style = (id: string) =>
  app.eval<Record<string, string>>(`(() => {
    const find = (nodes) => { for (const n of nodes) { if (n.id === ${JSON.stringify(id)}) return n; const f = find(n.children); if (f) return f } return null }
    return find(window.opendrawStore.getState().document.pages[0].nodes).style
  })()`)
const select = async (id: string) => {
  await app.eval(`window.opendrawStore.select([${JSON.stringify(id)}])`)
  await Bun.sleep(80)
}
const setStyle = async (id: string, update: object) => {
  await app.eval(`window.opendrawStore.transact('test', (tx) => tx.updateStyles([${JSON.stringify(id)}], ${JSON.stringify(update)})), true`)
  await Bun.sleep(80)
}
const undo = async () => {
  await app.key('z', 'KeyZ', CMD, 90)
  await Bun.sleep(50)
}
const zoom = () => app.eval<number>(`Number(document.querySelector('.canvas-world').dataset.zoom)`)
const setZoom = async (level: 0.5 | 1 | 2) => {
  await app.key('!', 'Digit1', SHIFT, 49)
  await app.key('0', 'Digit0', CMD, 48)
  if (level === 0.5) await app.key('-', 'Minus', CMD, 189)
  if (level === 2) await app.key('=', 'Equal', CMD, 187)
  await Bun.sleep(100)
}
const centerOf = async (selector: string) => {
  const r = await app.rect(selector)
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
}
const drag = async (from: { x: number; y: number }, points: { x: number; y: number }[], modifiers = 0) => {
  await app.mouseDown(from.x, from.y, modifiers)
  for (const p of points) await app.mouseMove(p.x, p.y, 1, modifiers)
  const last = points[points.length - 1]
  await app.mouseUp(last.x, last.y, modifiers)
  await Bun.sleep(80)
}
const line = (from: { x: number; y: number }, dx: number, dy: number, steps = 6) =>
  Array.from({ length: steps }, (_, i) => ({ x: from.x + (dx * (i + 1)) / steps, y: from.y + (dy * (i + 1)) / steps }))
const rotated = (v: { x: number; y: number }, degrees: number) => {
  const a = (degrees * Math.PI) / 180
  return { x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) }
}
/** Screen points at fractions (0-1) of an element's own box, measured by placing probes inside it. */
const probe = (selector: string, points: [number, number][]) =>
  app.eval<{ x: number; y: number }[]>(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    return ${JSON.stringify(points)}.map(([fx, fy]) => {
      const p = document.createElement('div')
      p.style.cssText = 'position:absolute;width:0;height:0;left:' + fx * 100 + '%;top:' + fy * 100 + '%'
      el.appendChild(p)
      const r = p.getBoundingClientRect()
      p.remove()
      return { x: r.left, y: r.top }
    })
  })()`)

try {
  await check('Each layer type shows exactly its handle sets', async () => {
    await setZoom(1)
    const expected: Record<string, string> = {
      Box: 'resize 8, rotate 4, radius 4, padding 0, gap 0',
      Pic: 'resize 8, rotate 4, radius 4, padding 0, gap 0',
      Label: 'resize 8, rotate 4, radius 0, padding 0, gap 0',
      Row: 'resize 8, rotate 4, radius 4, padding 4, gap 1',
      Board: 'resize 8, rotate 0, radius 4, padding 0, gap 0'
    }
    const seen: string[] = []
    for (const [id, want] of Object.entries(expected)) {
      await select(id)
      const got = await app.eval<string>(`['resize-handle', 'rotate-zone', 'radius-dot', 'padding-handle', 'gap-handle']
        .map((c, i) => ['resize', 'rotate', 'radius', 'padding', 'gap'][i] + ' ' + document.querySelectorAll('.' + c).length).join(', ')`)
      expect(got === want, `${id}: ${got}`)
      seen.push(`${id}: ${got}`)
    }
    await select('Row')
    await app.screenshot(path.join(RESULTS_DIR, 'handles-flex.png'))
    return seen.join('; ')
  })

  await check('Dragging a rotate zone 90 degrees writes rotate: 90deg; shift snaps to 15; one undo each, at zoom 0.5 and 2', async () => {
    const results: string[] = []
    for (const level of [0.5, 2] as const) {
      await setZoom(level)
      await select('Box')
      const center = await centerOf('.canvas-world [data-node-id="Box"]')
      const start = await centerOf('.rotate-zone[data-rotate="ne"]')
      const v = { x: start.x - center.x, y: start.y - center.y }
      const arc = (degrees: number) => Array.from({ length: 9 }, (_, i) => {
        const p = rotated(v, (degrees * (i + 1)) / 9)
        return { x: center.x + p.x, y: center.y + p.y }
      })
      await drag(start, arc(90))
      const free = (await style('Box')).rotate
      expect(Math.abs(Number.parseFloat(free) - 90) <= 1 && free.endsWith('deg'), `zoom ${level}: rotate ${free}`)
      await undo()
      expect((await style('Box')).rotate === undefined, `zoom ${level}: undo left rotate ${(await style('Box')).rotate}`)
      await drag(start, arc(52), SHIFT)
      const snapped = (await style('Box')).rotate
      expect(Number.parseFloat(snapped) % 15 === 0 && snapped === '45deg', `zoom ${level}: shift gave ${snapped}`)
      await undo()
      results.push(`zoom ${level}: ${free}, shift ${snapped}`)
    }
    return results.join('; ')
  })

  await check('A rotated outline matches the layer; resizing at 30 degrees keeps the west edge in place', async () => {
    await setZoom(1)
    await setStyle('Box', { rotate: '45deg' })
    await select('Box')
    const corners: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]]
    const layer = await probe('.canvas-world [data-node-id="Box"]', corners)
    const outline = await probe('.selection-outline[data-outline-id="Box"]', corners)
    const worst = Math.max(...layer.map((p, i) => Math.hypot(p.x - outline[i].x, p.y - outline[i].y)))
    expect(worst <= 1, `outline corners off by ${worst.toFixed(2)} px`)
    await undo()

    await setStyle('Box', { rotate: '30deg' })
    await select('Box')
    const [west] = await probe('.canvas-world [data-node-id="Box"]', [[0, 0.5]])
    const handle = await centerOf('.resize-handle[data-handle="e"]')
    const along = rotated({ x: 60, y: 0 }, 30)
    await drag(handle, line(handle, along.x, along.y))
    const after = await style('Box')
    const [westAfter] = await probe('.canvas-world [data-node-id="Box"]', [[0, 0.5]])
    const moved = Math.hypot(west.x - westAfter.x, west.y - westAfter.y)
    expect(after.width === '260px', `width ${after.width}`)
    expect(moved <= 1, `west edge moved ${moved.toFixed(2)} px`)
    await undo()
    await undo()
    return `outline corners within ${worst.toFixed(2)} px at 45 degrees; at 30 degrees width 200 -> ${after.width}, west edge moved ${moved.toFixed(2)} px`
  })

  await check('Dragging a corner dot 12 px inward writes border-radius: 12px; alt writes one corner (zoom 0.5 and 2)', async () => {
    const results: string[] = []
    for (const level of [0.5, 2] as const) {
      await setZoom(level)
      await select('Box')
      const z = await zoom()
      const nw = await centerOf('.radius-dot[data-radius="nw"]')
      await drag(nw, line(nw, 12 * z, 12 * z))
      const all = await style('Box')
      expect(all.borderRadius === '12px', `zoom ${level}: ${JSON.stringify(all)}`)
      await undo()
      const ne = await centerOf('.radius-dot[data-radius="ne"]')
      await drag(ne, line(ne, -12 * z, 12 * z), ALT)
      const one = await style('Box')
      expect(one.borderTopRightRadius === '12px' && one.borderTopLeftRadius === '0px' && !one.borderRadius, `zoom ${level} alt: ${JSON.stringify(one)}`)
      await undo()
      expect(!(await style('Box')).borderTopRightRadius, `zoom ${level}: undo left a corner radius`)
      results.push(`zoom ${level}: all ${all.borderRadius}, alt top-right ${one.borderTopRightRadius}`)
    }
    return results.join('; ')
  })

  await check('The left padding handle adds 10 px to padding-left; the gap handle adds 8 px to gap', async () => {
    await setZoom(1)
    await select('Row')
    const left = await centerOf('.padding-handle[data-padding="left"]')
    await drag(left, line(left, 10, 0))
    const padded = await style('Row')
    expect(padded.paddingLeft === '20px' && padded.paddingRight === '10px' && !padded.padding, JSON.stringify(padded))
    await undo()
    expect((await style('Row')).padding === '10px', 'undo did not restore padding')
    const gap = await centerOf('.gap-handle')
    await drag(gap, line(gap, 8, 0))
    const gapped = await style('Row')
    expect(gapped.gap === '18px', `gap ${gapped.gap}`)
    await undo()
    expect((await style('Row')).gap === '10px', 'undo did not restore gap')
    return `padding-left 10 -> ${padded.paddingLeft}, gap 10 -> ${gapped.gap}; one undo each`
  })

  await check('Typing 30 in the rotation field writes rotate: 30deg; agents read and write rotate', async () => {
    await select('Box')
    await app.eval(`(() => { const el = document.querySelector('[data-field="rotate"] input'); el.focus(); el.select(); return true })()`)
    await app.type('30')
    await app.key('Enter', 'Enter', 0, 13)
    await Bun.sleep(80)
    const typed = (await style('Box')).rotate
    expect(typed === '30deg', `rotate ${typed}`)
    await undo()
    expect((await style('Box')).rotate === undefined, 'undo did not clear rotate')

    const result = await client.call('update_styles', { fileId: 'file-1', updates: [{ nodeIds: ['Box'], styles: { rotate: '12deg' } }] })
    expect(!result.ignoredStyles, JSON.stringify(result))
    const computed = await client.call('get_computed_styles', { fileId: 'file-1', nodeIds: ['Box'] })
    expect(computed.Box.rotate === '12deg', `computed ${computed.Box.rotate}`)
    const jsx: string = await client.call('get_jsx', { fileId: 'file-1', nodeId: 'Box' })
    expect(/rotate: "12deg"/.test(jsx), jsx)
    await select('Box')
    await app.screenshot(path.join(RESULTS_DIR, 'handles-rotated.png'))
    return `field wrote ${typed}; update_styles rotate 12deg, computed ${computed.Box.rotate}, in get_jsx`
  })
} finally {
  await app.kill()
}

await finish('handles')
