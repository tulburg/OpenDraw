// End-to-end acceptance checks for S-9 (toolbar and drawing tools). Run with `bun run test:tools`.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { App, cleanProfile } from './cdp'
import { check, expect, finish, RESULTS_DIR } from './checks'
import { BridgeClient } from './mcp-client'

const CMD = process.platform === 'darwin' ? 4 : 2
const SHIFT = 8

const profile = cleanProfile()
mkdirSync(profile.workspace, { recursive: true })
const filePath = path.join(profile.workspace, 'Tools test.opendraw')
writeFileSync(
  filePath,
  JSON.stringify({
    format: 'opendraw',
    version: 1,
    id: 'file-1',
    name: 'Tools test',
    pages: [
      {
        id: 'page-1',
        name: 'Page 1',
        nodes: [
          { id: 'Free', type: 'artboard', name: 'Free', style: { left: '0px', top: '0px', width: '600px', height: '400px', backgroundColor: '#ffffff' }, children: [] },
          {
            id: 'Column',
            type: 'artboard',
            name: 'Column',
            style: { left: '700px', top: '0px', width: '400px', height: '400px', backgroundColor: '#ffffff', display: 'flex', flexDirection: 'column', padding: '20px', gap: '10px' },
            children: [{ id: 'First', type: 'frame', name: 'First', style: { height: '60px', backgroundColor: '#cccccc' }, children: [] }]
          }
        ]
      }
    ]
  })
)

// Images to place: a 40 x 30 PNG and a 24 x 24 SVG.
const pngPath = path.join(profile.workspace, 'dot.png')
const svgPath = path.join(profile.workspace, 'mark.svg')
writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#ff5a36"/></svg>')

const app = await App.launch(profile)
const client = await BridgeClient.start(path.join(profile.userData, 'mcp.json'))
const png = await app.eval<string>(`(() => { const c = document.createElement('canvas'); c.width = 40; c.height = 30
  const ctx = c.getContext('2d'); ctx.fillStyle = '#3366ff'; ctx.fillRect(0, 0, 40, 30); return c.toDataURL('image/png').split(',')[1] })()`)
writeFileSync(pngPath, Buffer.from(png, 'base64'))

await app.key('!', 'Digit1', SHIFT, 49)
await Bun.sleep(200)

const documentJSON = () => app.eval<string>('JSON.stringify(window.opendrawStore.getState().document)')
const node = (id: string) =>
  app.eval<any>(`(() => {
    const find = (nodes) => { for (const n of nodes) { if (n.id === ${JSON.stringify(id)}) return n; const f = find(n.children); if (f) return f } return null }
    return find(window.opendrawStore.getState().document.pages[0].nodes)
  })()`)
const children = async (id: string) => ((await node(id)).children as any[])
const selected = () => app.eval<string[]>('window.opendrawStore.getState().selection')
const activeTool = () => app.eval<string>(`document.querySelector('.tool-button[data-active]')?.dataset.tool ?? ''`)
const zoom = () => app.eval<number>(`Number(document.querySelector('.canvas-world').dataset.zoom)`)
const undo = () => app.key('z', 'KeyZ', CMD, 90)
const pressKey = (letter: string) => app.key(letter, `Key${letter.toUpperCase()}`, 0, letter.toUpperCase().charCodeAt(0))
/** A world point inside an artboard (in its own units) as a screen point. */
const screenAt = async (artboard: string, x: number, y: number) => {
  const r = await app.rect(`.canvas-world [data-node-id="${artboard}"]`)
  const z = await zoom()
  return { x: r.x + x * z, y: r.y + y * z }
}
const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
  await app.mouseDown(from.x, from.y)
  for (let i = 1; i <= 5; i++) await app.mouseMove(from.x + ((to.x - from.x) * i) / 5, from.y + ((to.y - from.y) * i) / 5, 1)
  await app.mouseUp(to.x, to.y)
  await Bun.sleep(50)
}
/** Gives the hidden file input a file, as choosing it in the picker would. */
const chooseFile = async (file: string) => {
  const { root } = await app.send('DOM.getDocument', { depth: 0 })
  const { nodeId } = await app.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-image-input]' })
  await app.send('DOM.setFileInputFiles', { nodeId, files: [file] })
  await app.waitFor(`window.opendrawStore.getState().selection.length > 0`)
  await Bun.sleep(100)
}

try {
  await check('V, H, A, F, T, I switch the highlighted tool; Escape returns to Select', async () => {
    const seen: string[] = []
    for (const letter of ['h', 'a', 'f', 't', 'i', 'v']) {
      await pressKey(letter)
      seen.push(await activeTool())
    }
    expect(seen.join() === 'hand,artboard,frame,text,image,select', `tools: ${seen.join()}`)
    await pressKey('f')
    await app.key('Escape', 'Escape', 0, 27)
    expect((await activeTool()) === 'select', `after Escape: ${await activeTool()}`)
    const title = await app.eval<string>(`document.querySelector('.tool-button[data-tool="frame"]').title`)
    expect(title === 'Frame (F)', `title ${title}`)
    await app.screenshot(path.join(RESULTS_DIR, 'tools-toolbar.png'))
    return `${seen.join(', ')}; Escape back to select; hover shows "${title}"`
  })

  await check('A 300 x 200 frame drawn in a non-flex artboard is positioned where drawn, at zoom 0.5 and 2; one undo removes it', async () => {
    const results: string[] = []
    for (const [keys, at] of [
      [[['0', 'Digit0', 48], ['-', 'Minus', 189]], { x: 50, y: 50 }],
      [[['0', 'Digit0', 48], ['=', 'Equal', 187]], { x: 360, y: 60 }]
    ] as const) {
      await app.key('!', 'Digit1', SHIFT, 49)
      for (const [key, code, keyCode] of keys) await app.key(key, code, CMD, keyCode)
      await Bun.sleep(100)
      const z = await zoom()
      await pressKey('f')
      const from = await screenAt('Free', at.x, at.y)
      const canvas = await app.rect('.canvas')
      expect(from.x > canvas.x && from.x < canvas.x + canvas.width && from.y > canvas.y && from.y < canvas.y + canvas.height,
        `zoom ${z}: start ${JSON.stringify(from)} is off the canvas ${JSON.stringify(canvas)}`)
      await drag(from, { x: from.x + 300 * z, y: from.y + 200 * z })
      const added = (await children('Free')).at(-1)
      const style = added?.style ?? {}
      expect(
        style.position === 'absolute' && style.left === `${at.x}px` && style.top === `${at.y}px` && style.width === '300px' && style.height === '200px',
        `zoom ${z}: ${JSON.stringify(style)}`
      )
      expect((await selected()).join() === added.id, 'the new frame is not selected')
      expect((await activeTool()) === 'select', 'the tool did not return to Select')
      await undo()
      expect((await children('Free')).length === 0, `zoom ${z}: undo left ${(await children('Free')).length} layers`)
      results.push(`zoom ${z}: left ${style.left}, top ${style.top}, 300 x 200`)
    }
    return results.join('; ')
  })

  await check('A frame drawn in a flex column is appended as the last child with the drawn size and no position', async () => {
    await app.key('!', 'Digit1', SHIFT, 49)
    await Bun.sleep(100)
    const z = await zoom()
    await pressKey('f')
    const from = await screenAt('Column', 40, 200)
    await drag(from, { x: from.x + 120 * z, y: from.y + 80 * z })
    const kids = await children('Column')
    const added = kids.at(-1)
    expect(kids.length === 2 && kids[0].id === 'First', `children ${kids.map((k) => k.name).join()}`)
    expect(added.style.width === '120px' && added.style.height === '80px' && !added.style.position && !added.style.left, JSON.stringify(added.style))
    await undo()
    return `appended after First: ${JSON.stringify(added.style)}`
  })

  await check('Text tool: click, type "Hello", Escape saves the text; click and Escape with nothing typed changes nothing', async () => {
    await pressKey('t')
    const at = await screenAt('Free', 100, 300)
    await app.clickWith(at.x, at.y, 0)
    await Bun.sleep(100)
    const editing = await app.eval<boolean>('!!document.activeElement?.isContentEditable')
    expect(editing, 'no text editor after the click')
    await app.type('Hello')
    await app.key('Escape', 'Escape', 0, 27)
    await Bun.sleep(1200)
    const added = (await children('Free')).at(-1)
    expect(added?.type === 'text' && added.text === 'Hello' && added.name === 'Hello', JSON.stringify(added))
    const saved = JSON.parse(await Bun.file(filePath).text())
    const savedText = saved.pages[0].nodes[0].children.at(-1)
    expect(savedText?.text === 'Hello', `saved: ${JSON.stringify(savedText)}`)
    await undo()
    expect((await children('Free')).length === 0, 'one undo did not remove the text layer and its text')

    const before = await documentJSON()
    const canUndo = await app.eval<boolean>('window.opendrawStore.getState().canUndo')
    await pressKey('t')
    await app.clickWith(at.x, at.y, 0)
    await Bun.sleep(100)
    await app.key('Escape', 'Escape', 0, 27)
    await Bun.sleep(80)
    expect((await documentJSON()) === before, 'an empty text layer was left behind')
    const canRedo = await app.eval<boolean>('window.opendrawStore.getState().canRedo')
    expect((await app.eval<boolean>('window.opendrawStore.getState().canUndo')) === canUndo && !canRedo, 'the empty text left an undo or redo step')
    return '"Hello" saved; one undo removes it; an empty click-and-Escape leaves the document and history unchanged'
  })

  await check('The image tool places a PNG at its natural size and an SVG as an SVG layer', async () => {
    await app.send('Page.setInterceptFileChooserDialog', { enabled: true })
    await app.eval('window.opendrawStore.select([]), true')
    await pressKey('i')
    let at = await screenAt('Free', 20, 20)
    await app.clickWith(at.x, at.y, 0)
    await chooseFile(pngPath)
    const image = (await children('Free')).at(-1)
    expect(image?.type === 'image' && image.style.width === '40px' && image.style.height === '30px', JSON.stringify(image?.style))
    expect(image.style.left === '20px' && image.style.top === '20px' && String(image.src).startsWith('data:image/png'), 'image placement or src')
    await app.eval('window.opendrawStore.select([]), true')
    await pressKey('i')
    at = await screenAt('Free', 200, 20)
    await app.clickWith(at.x, at.y, 0)
    await chooseFile(svgPath)
    const svg = (await children('Free')).at(-1)
    expect(svg?.type === 'svg' && svg.style.width === '24px' && /<circle/.test(svg.svg), JSON.stringify(svg))
    return `PNG ${image.style.width} x ${image.style.height} at 20, 20; SVG layer "${svg.name}" ${svg.style.width} x ${svg.style.height}`
  })

  await check("An agent's get_jsx on the artboard shows each drawn layer", async () => {
    await pressKey('f')
    const from = await screenAt('Free', 300, 200)
    const z = await zoom()
    await drag(from, { x: from.x + 100 * z, y: from.y + 60 * z })
    await app.key('!', 'Digit1', SHIFT, 49)
    await pressKey('a')
    const bounds = await app.rect('.canvas')
    const start = { x: bounds.x + bounds.width - 120, y: bounds.y + bounds.height - 140 }
    await drag(start, { x: start.x + 60, y: start.y + 40 })
    const artboard = (await selected())[0]
    const drawnArtboard = await node(artboard)
    expect(drawnArtboard?.type === 'artboard' && drawnArtboard.style.backgroundColor === '#ffffff', JSON.stringify(drawnArtboard))
    const jsx: string = await client.call('get_jsx', { fileId: 'file-1', nodeId: 'Free' })
    expect(/data-name="dot"/.test(jsx) && /data-name="mark"/.test(jsx) && /data-name="Frame"/.test(jsx) && /<svg/.test(jsx), jsx)
    const tree: string = await client.call('get_tree_summary', { fileId: 'file-1', nodeId: artboard })
    expect(tree.includes('Artboard'), tree)
    await app.screenshot(path.join(RESULTS_DIR, 'tools-drawn.png'))
    return `get_jsx lists the image, SVG and frame; a drawn artboard ${drawnArtboard.style.width} x ${drawnArtboard.style.height} shows in get_tree_summary`
  })
} finally {
  await app.kill()
}

await finish('tools')
