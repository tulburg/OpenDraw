// End-to-end acceptance checks for S-7 (styles panel editing). Run with `bun run test:styles`.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { App, cleanProfile } from './cdp'
import { check, expect, finish, RESULTS_DIR } from './checks'

const CMD = process.platform === 'darwin' ? 4 : 2
const SHIFT = 8

const profile = cleanProfile()
mkdirSync(profile.workspace, { recursive: true })
writeFileSync(
  path.join(profile.workspace, 'Styles test.opendraw'),
  JSON.stringify({
    format: 'opendraw',
    version: 1,
    id: 'file-1',
    name: 'Styles test',
    pages: [
      {
        id: 'page-1',
        name: 'Page 1',
        nodes: [
          {
            id: 'Board',
            type: 'artboard',
            name: 'Board',
            style: { left: '0px', top: '0px', width: '800px', height: '500px', backgroundColor: '#ffffff', display: 'flex', flexDirection: 'column', padding: '40px', gap: '20px' },
            children: [
              {
                id: 'Row',
                type: 'frame',
                name: 'Row',
                style: { display: 'flex', flexDirection: 'row', gap: '10px', width: '600px', height: '120px' },
                children: [
                  { id: 'Left', type: 'frame', name: 'Left', style: { width: '100px', height: '100px', backgroundColor: '#ff0000' }, children: [] },
                  { id: 'Right', type: 'frame', name: 'Right', style: { width: '100px', height: '100px', backgroundColor: '#0000ff' }, children: [] }
                ]
              },
              { id: 'Title', type: 'text', name: 'Title', text: 'Hello', style: { fontSize: '16px' }, children: [] }
            ]
          }
        ]
      }
    ]
  })
)

const app = await App.launch(profile)
await app.key('!', 'Digit1', SHIFT, 49)

const style = async (id: string) =>
  app.eval<Record<string, string>>(`(() => {
    const find = (nodes) => { for (const n of nodes) { if (n.id === ${JSON.stringify(id)}) return n; const f = find(n.children); if (f) return f } return null }
    return find(window.opendrawStore.getState().document.pages[0].nodes).style
  })()`)
const documentJSON = () => app.eval<string>('JSON.stringify(window.opendrawStore.getState().document)')
const select = async (...ids: string[]) => {
  await app.eval(`window.opendrawStore.select(${JSON.stringify(ids)})`)
  await Bun.sleep(80)
}
const undo = () => app.key('z', 'KeyZ', CMD, 90)
/** Focuses a field's input, replaces its text and presses Enter. */
const enter = async (selector: string, text: string) => {
  await app.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.select(); return true })()`)
  await app.type(text)
  await app.key('Enter', 'Enter', 0, 13)
  await Bun.sleep(80)
}

try {
  await check('Changing padding to 24 writes padding: 24px; one undo restores it', async () => {
    await select('Left')
    await enter('[data-field="padding"] input', '24')
    const after = (await style('Left')).padding
    expect(after === '24px', `padding ${after}`)
    await enter('[data-field="gap"] input', '4 * 3')
    const gap = (await style('Left')).gap
    expect(gap === '12px', `math gave gap ${gap}`)
    await undo()
    await undo()
    const restored = await style('Left')
    expect(restored.padding === undefined && restored.gap === undefined, `after two undos: ${JSON.stringify(restored)}`)
    return `padding 24px, gap "4 * 3" = ${gap}; two undos restore both`
  })

  await check('Hug writes width: fit-content; Fill writes flex: 1 in a row parent', async () => {
    await select('Left')
    await app.eval(`document.querySelector('[data-size-mode="width"] button[data-mode="hug"]').click(), true`)
    await Bun.sleep(50)
    const hug = await style('Left')
    expect(hug.width === 'fit-content', `Hug gave width ${hug.width}`)
    await app.eval(`document.querySelector('[data-size-mode="width"] button[data-mode="fill"]').click(), true`)
    await Bun.sleep(50)
    const fill = await style('Left')
    expect(String(fill.flex) === '1' && fill.width === undefined, `Fill gave ${JSON.stringify(fill)}`)
    const active = await app.eval(`document.querySelector('[data-size-mode="width"] button[data-active]')?.dataset.mode`)
    expect(active === 'fill', `active mode shows ${active}`)
    const laidOut = await app.eval<number>(`document.querySelector('.canvas-world [data-node-id="Left"]').getBoundingClientRect().width /
      Number(document.querySelector('.canvas-world').dataset.zoom)`)
    expect(Math.round(laidOut) === 490, `Left fills ${laidOut} px of the 600 px row`)
    await undo()
    await undo()
    expect((await style('Left')).width === '100px', 'two undos did not restore 100px')
    return `fit-content, then flex: 1 (lays out at ${Math.round(laidOut)} px)`
  })

  await check('margin typed in the raw CSS view shows the note and leaves the document unchanged', async () => {
    await select('Left')
    const before = await documentJSON()
    await app.eval(`(() => { const el = document.querySelector('.raw-css'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); return true })()`)
    await app.type('\nmargin: 10px;')
    await app.eval(`document.querySelector('.raw-css').blur(), true`)
    await Bun.sleep(80)
    const note = await app.eval<string>(`document.querySelector('.style-note')?.textContent ?? ''`)
    expect(/margin.*not supported/.test(note), `note: "${note}"`)
    expect((await documentJSON()) === before, 'the document changed')
    // A valid edit in the same view applies.
    await app.eval(`(() => { const el = document.querySelector('.raw-css'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); return true })()`)
    await app.type('\nborder-radius: 8px;')
    await app.eval(`document.querySelector('.raw-css').blur(), true`)
    await Bun.sleep(80)
    expect((await style('Left')).borderRadius === '8px', 'border-radius from the raw view did not apply')
    await undo()
    return `note: "${note}"`
  })

  await check('Two layers with different fills show Mixed; one color applies to both in one undo step', async () => {
    await select('Left', 'Right')
    const field = await app.eval<{ value: string; placeholder: string }>(`(() => {
      const el = document.querySelector('[data-field="backgroundColor"] input'); return { value: el.value, placeholder: el.placeholder } })()`)
    expect(field.value === '' && field.placeholder === 'Mixed', `field shows ${JSON.stringify(field)}`)
    const title = await app.eval(`document.querySelector('.styles-panel .panel-title').textContent`)
    expect(title === '2 layers', `title ${title}`)
    await enter('[data-field="backgroundColor"] input', '#00ff00')
    const [left, right] = [await style('Left'), await style('Right')]
    expect(left.backgroundColor === '#00ff00' && right.backgroundColor === '#00ff00', `${left.backgroundColor}, ${right.backgroundColor}`)
    await app.eval(`document.querySelector('[data-field="backgroundColor"] .color-swatch').click(), true`)
    await Bun.sleep(80)
    await app.screenshot(path.join(RESULTS_DIR, 'styles-panel.png'))
    const swatches = await app.eval<number>(`document.querySelectorAll('.color-popover .color-swatch').length`)
    expect(swatches >= 2, `only ${swatches} file colors offered`)
    await app.eval(`document.querySelector('[data-field="backgroundColor"] .color-swatch').click(), true`)
    await undo()
    const [l, r] = [await style('Left'), await style('Right')]
    expect(l.backgroundColor === '#ff0000' && r.backgroundColor === '#0000ff', `after undo ${l.backgroundColor}, ${r.backgroundColor}`)
    return `Mixed, then both #00ff00; ${swatches} file colors in the picker; one undo restores both`
  })

  await check('Scrubbing font size from 16 to 40 updates the canvas live and records one undo step', async () => {
    await select('Title')
    const label = await app.rect('[data-field="fontSize"] .field-label')
    const from = { x: label.x + label.width / 2, y: label.y + label.height / 2 }
    await app.mouseDown(from.x, from.y)
    for (let i = 1; i <= 6; i++) await app.mouseMove(from.x + 4 * i, from.y, 1)
    await Bun.sleep(50)
    const live = await app.eval(`getComputedStyle(document.querySelector('.canvas-world [data-node-id="Title"]')).fontSize`)
    const stored = (await style('Title')).fontSize
    await app.mouseUp(from.x + 24, from.y)
    const after = (await style('Title')).fontSize
    expect(live === '40px', `canvas showed ${live} mid-scrub`)
    expect(stored === '16px', `the document changed mid-scrub: ${stored}`)
    expect(after === '40px', `after scrub ${after}`)
    await undo()
    const undone = (await style('Title')).fontSize
    expect(undone === '16px', `one undo gave ${undone}`)
    return `live ${live}, stored ${stored} until release, then ${after}; one undo back to ${undone}`
  })
} finally {
  await app.kill()
}

await finish('styles')
