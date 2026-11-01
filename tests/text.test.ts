// End-to-end acceptance checks for S-8 (rich text and in-place text editing). Run with `bun run test:text`.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { App, cleanProfile } from './cdp'
import { check, expect, finish, RESULTS_DIR } from './checks'
import { BridgeClient } from './mcp-client'

const CMD = process.platform === 'darwin' ? 4 : 2
const SHIFT = 8
const WIDTH = 600
const HEIGHT = 160

const profile = cleanProfile()
mkdirSync(profile.workspace, { recursive: true })
const filePath = path.join(profile.workspace, 'Text test.opendraw')
writeFileSync(
  filePath,
  JSON.stringify({
    format: 'opendraw',
    version: 1,
    id: 'file-1',
    name: 'Text test',
    pages: [
      {
        id: 'page-1',
        name: 'Page 1',
        nodes: [
          {
            id: 'Board',
            type: 'artboard',
            name: 'Board',
            style: { left: '0px', top: '0px', width: '600px', height: '400px', backgroundColor: '#ffffff', padding: '40px' },
            children: [
              // A text layer written before rich text existed: no spans.
              { id: 'Old', type: 'text', name: 'Old', text: 'Plain words', style: { fontSize: '32px' }, children: [] }
            ]
          }
        ]
      }
    ]
  })
)

const app = await App.launch(profile)
const client = await BridgeClient.start(path.join(profile.userData, 'mcp.json'))
const fileId = 'file-1'
const call = (name: string, args: object = {}) => client.call(name, { fileId, ...args })
await app.key('!', 'Digit1', SHIFT, 49)

const node = (id: string) =>
  app.eval<any>(`(() => {
    const find = (nodes) => { for (const n of nodes) { if (n.id === ${JSON.stringify(id)}) return n; const f = find(n.children); if (f) return f } return null }
    for (const page of window.opendrawStore.getState().document.pages) { const f = find(page.nodes); if (f) return f }
    return null
  })()`)
const undo = () => app.key('z', 'KeyZ', CMD, 90)
const savedNode = async (id: string) => {
  await Bun.sleep(1200)
  const find = (nodes: any[]): any => {
    for (const n of nodes) {
      if (n.id === id) return n
      const f = find(n.children)
      if (f) return f
    }
    return null
  }
  const saved = JSON.parse(await Bun.file(filePath).text())
  for (const page of saved.pages) {
    const found = find(page.nodes)
    if (found) return found
  }
  return null
}

const PARAGRAPH = '<p style="font-size: 28px; line-height: 36px">Ship <b>fast</b> and <span style="color: red">safe</span></p>'
const ARTBOARD = 'padding: 24px; font-family: Helvetica, Arial, sans-serif; color: #1b1b1b; background-color: #ffffff'

let paragraphId = ''
let artboardId = ''

try {
  await check('write_html keeps <b> and a colored <span> as spans and matches a plain browser', async () => {
    const artboard = await call('create_artboard', {
      name: 'Rich',
      styles: { width: `${WIDTH}px`, height: `${HEIGHT}px`, padding: '24px', fontFamily: 'Helvetica, Arial, sans-serif', color: '#1b1b1b', backgroundColor: '#ffffff' }
    })
    artboardId = artboard.id
    const result = await call('write_html', { targetNodeId: artboard.id, mode: 'insert-children', html: PARAGRAPH })
    expect(result.dropped.length === 0, `dropped: ${result.dropped}`)
    paragraphId = result.created[0].id
    const stored = await node(paragraphId)
    // The spec counts three spans, but "Ship ", "fast", " and ", "safe" are four runs: two plain, two formatted.
    const spans = stored.spans ?? []
    expect(spans.length === 4, `spans: ${JSON.stringify(spans)}`)
    expect(spans[1].text === 'fast' && spans[1].style.fontWeight === 'bold', `bold run: ${JSON.stringify(spans[1])}`)
    expect(spans[3].text === 'safe' && spans[3].style.color === 'red', `red run: ${JSON.stringify(spans[3])}`)
    expect(stored.text === 'Ship fast and safe', `text: ${stored.text}`)

    await Bun.sleep(300)
    const shot = await client.callRaw('get_screenshot', { fileId, nodeId: artboard.id })
    const ours = shot.content[0].data
    const reference = `<!doctype html><html><head><style>* { box-sizing: border-box; margin: 0 } body { margin: 0 }</style></head>
      <body><div style="width: ${WIDTH}px; height: ${HEIGHT}px; ${ARTBOARD}">${PARAGRAPH}</div></body></html>`
    await app.eval(`new Promise((resolve) => {
      const frame = document.createElement('iframe')
      frame.id = 'reference'
      frame.style.cssText = 'position: fixed; left: 0; top: 0; width: ${WIDTH}px; height: ${HEIGHT}px; border: 0; z-index: 100000'
      frame.onload = () => frame.contentDocument.fonts.ready.then(() => setTimeout(resolve, 100))
      frame.srcdoc = ${JSON.stringify(reference)}
      document.body.appendChild(frame)
    })`)
    const { data: theirs } = await app.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 }
    })
    await app.eval(`document.getElementById('reference').remove()`)
    await Bun.write(path.join(RESULTS_DIR, 'text-rich.png'), Buffer.from(ours, 'base64'))
    await Bun.write(path.join(RESULTS_DIR, 'text-reference.png'), Buffer.from(theirs, 'base64'))
    const diff = await app.eval<number>(`(async () => {
      const load = (b64) => new Promise((resolve, reject) => {
        const image = new Image(); image.onload = () => resolve(image); image.onerror = reject
        image.src = 'data:image/png;base64,' + b64 })
      const pixels = async (b64) => {
        const c = document.createElement('canvas'); c.width = ${WIDTH}; c.height = ${HEIGHT}
        const ctx = c.getContext('2d'); ctx.drawImage(await load(b64), 0, 0, ${WIDTH}, ${HEIGHT})
        return ctx.getImageData(0, 0, ${WIDTH}, ${HEIGHT}).data }
      const a = await pixels(${JSON.stringify(ours)}), b = await pixels(${JSON.stringify(theirs)})
      let total = 0
      for (let i = 0; i < a.length; i += 4) total += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
      return total / (${WIDTH} * ${HEIGHT} * 3)
    })()`)
    expect(diff < 2, `mean channel difference ${diff.toFixed(2)} (see tests/results/text-*.png)`)
    return `4 runs (2 formatted); mean channel difference vs plain browser ${diff.toFixed(2)} of 255`
  })

  await check('A span with padding is dropped from the run and reported', async () => {
    const result = await call('write_html', {
      targetNodeId: artboardId,
      mode: 'insert-children',
      html: '<p>Tag <span style="padding: 4px; color: blue">new</span></p>'
    })
    const line = result.dropped.find((l: string) => /^padding on <span>/.test(l))
    expect(!!line, `dropped: ${JSON.stringify(result.dropped)}`)
    const stored = await node(result.created[0].id)
    expect(stored.spans?.[1]?.style?.color === 'blue' && !stored.spans[1].style.padding, JSON.stringify(stored.spans))
    await call('delete_nodes', { nodeIds: [result.created[0].id] })
    return `reported "${line}"`
  })

  await check('get_jsx writes the runs as spans; find_nodes finds text across runs', async () => {
    const jsx: string = await client.call('get_jsx', { fileId, nodeId: paragraphId })
    expect(/<span style=\{\{\s*fontWeight: "bold"\s*\}\}>fast<\/span>/.test(jsx), jsx)
    expect(/<span style=\{\{\s*color: "red"\s*\}\}>safe<\/span>/.test(jsx), jsx)
    const found = await client.call('find_nodes', { fileId, textValue: '*fast and*' })
    expect(found.some((n: any) => n.id === paragraphId), `find_nodes: ${JSON.stringify(found)}`)
    return 'JSX has both spans; "fast and" finds the layer'
  })

  await check('set_text_content keeps formatting; update_styles color reaches every run', async () => {
    await call('set_text_content', { updates: [{ nodeId: paragraphId, html: 'Go <i>now</i> or <span style="color: green">later</span>' }] })
    let stored = await node(paragraphId)
    expect(stored.text === 'Go now or later' && stored.spans?.[1]?.style?.fontStyle === 'italic', JSON.stringify(stored))
    await call('update_styles', { updates: [{ nodeIds: [paragraphId], styles: { color: '#123456' } }] })
    stored = await node(paragraphId)
    expect(stored.style.color === '#123456', `layer color ${stored.style.color}`)
    expect(!JSON.stringify(stored.spans).includes('green'), `runs still override: ${JSON.stringify(stored.spans)}`)
    const colors = await app.eval<string[]>(`[...document.querySelectorAll('.canvas-world [data-node-id="${paragraphId}"] span')]
      .map((s) => getComputedStyle(s).color)`)
    expect(colors.every((c) => c === 'rgb(18, 52, 86)'), `rendered ${colors}`)
    return `italic run kept; after update_styles every run renders ${colors[0] ?? 'the layer color'}`
  })

  await check('A text layer saved before rich text loads and saves unchanged', async () => {
    const stored = await node('Old')
    expect(stored.text === 'Plain words' && !('spans' in stored), JSON.stringify(stored))
    const html = await app.eval<string>(`document.querySelector('.canvas-world [data-node-id="Old"]').innerHTML`)
    expect(html === 'Plain words', `rendered ${html}`)
    return 'no spans key, renders as plain text'
  })

  await check('Double-click, select a word, cmd+B, Escape: the word is bold in the file; one undo removes it', async () => {
    await app.eval(`window.opendrawStore.select(['Old']), true`)
    await Bun.sleep(80)
    const r = await app.rect('.canvas-world [data-node-id="Old"]')
    await app.clickWith(r.x + 20, r.y + r.height / 2, 0, 2)
    await Bun.sleep(100)
    const editing = await app.eval<boolean>(`document.activeElement?.dataset.nodeId === 'Old' && document.activeElement.isContentEditable`)
    expect(editing, 'the layer did not become editable')
    // Select "words".
    await app.eval(`(() => {
      const el = document.querySelector('[data-editing]'); const text = el.firstChild
      const range = document.createRange(); range.setStart(text, 6); range.setEnd(text, 11)
      const s = getSelection(); s.removeAllRanges(); s.addRange(range); return true })()`)
    await app.key('b', 'KeyB', CMD, 66)
    await app.key('Escape', 'Escape', 0, 27)
    await Bun.sleep(80)
    const stored = await node('Old')
    const bold = stored.spans?.find((s: any) => s.text === 'words')
    expect(stored.text === 'Plain words' && /bold|700/.test(String(bold?.style?.fontWeight)), JSON.stringify(stored))
    const selection = await app.eval<string[]>('window.opendrawStore.getState().selection')
    expect(selection.join() === 'Old', `selection after Escape: ${selection}`)
    const saved = await savedNode('Old')
    expect(JSON.stringify(saved.spans) === JSON.stringify(stored.spans), `saved: ${JSON.stringify(saved)}`)
    await undo()
    const undone = await node('Old')
    expect(undone.text === 'Plain words' && !undone.spans, `after undo ${JSON.stringify(undone)}`)
    return `"words" saved as ${JSON.stringify(bold.style)}; one undo back to plain`
  })

  await check('Typing a line break in place and pasting HTML keep their formatting', async () => {
    await app.eval(`window.opendrawStore.select(['Old']), true`)
    await Bun.sleep(80)
    const r = await app.rect('.canvas-world [data-node-id="Old"]')
    await app.clickWith(r.x + 20, r.y + r.height / 2, 0, 2)
    await Bun.sleep(100)
    // Caret at the end, then a line break and pasted HTML.
    await app.eval(`(() => { const s = getSelection(); s.selectAllChildren(document.querySelector('[data-editing]')); s.collapseToEnd(); return true })()`)
    await app.key('Enter', 'Enter', 0, 13)
    await app.eval(`(() => {
      const data = new DataTransfer()
      data.setData('text/html', '<meta charset="utf-8"><span>more </span><strong style="color: rgb(255, 0, 0); margin: 8px">text</strong>')
      data.setData('text/plain', 'more text')
      document.querySelector('[data-editing]').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
      return true })()`)
    await app.key('Escape', 'Escape', 0, 27)
    await Bun.sleep(80)
    const stored = await node('Old')
    expect(stored.text === 'Plain words\nmore text', `text ${JSON.stringify(stored.text)}`)
    const pasted = stored.spans?.find((s: any) => s.text === 'text')
    expect(/bold|700/.test(String(pasted?.style?.fontWeight)) && pasted?.style?.color === 'rgb(255, 0, 0)' && !pasted.style.margin, JSON.stringify(stored.spans))
    expect(stored.style.whiteSpace === 'pre-wrap', `white-space ${stored.style.whiteSpace}`)
    await app.screenshot(path.join(RESULTS_DIR, 'text-edited.png'))
    await undo()
    return `"${stored.text.replace('\n', '\\n')}", pasted run ${JSON.stringify(pasted.style)}`
  })
} finally {
  await app.kill()
}

await finish('text')
