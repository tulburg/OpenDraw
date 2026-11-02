// End-to-end acceptance checks for S-15 (export): export settings in the styles panel, the export
// and export_combined_pdf tools, and get_fill_image. Run with `bun run test:export`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { inflateSync } from 'node:zlib'

import { App, cleanProfile } from './cdp'
import { check, expect, finish } from './checks'
import { BridgeClient } from './mcp-client'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const CMD = process.platform === 'darwin' ? 4 : 2
const DOT_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='

const profile = cleanProfile()
mkdirSync(profile.workspace, { recursive: true })
const OUT = path.join(path.dirname(profile.workspace), 'out')
const fileId = 'export-file'
const artboard = (id: string, name: string, left: number, top: number, width: number, height: number, children: object[] = []) => ({
  id,
  type: 'artboard',
  name,
  style: { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`, backgroundColor: '#ffffff', display: 'flex', padding: '40px' },
  children
})
writeFileSync(
  path.join(profile.workspace, 'Export.opendraw'),
  JSON.stringify({
    format: 'opendraw',
    version: 1,
    id: fileId,
    name: 'Export',
    pages: [
      {
        id: 'page-1',
        name: 'Page 1',
        nodes: [
          artboard('desktop', 'Desktop', 0, 0, 800, 600, [
            {
              id: 'card',
              type: 'frame',
              name: 'Card',
              style: { width: '200px', height: '120px', backgroundColor: '#ff0000', borderRadius: '24px', display: 'flex', padding: '16px' },
              children: [{ id: 'hello', type: 'text', name: 'Hello', style: { fontSize: '24px', color: '#ffffff' }, text: 'Hello export', children: [] }]
            },
            { id: 'photo', type: 'image', name: 'Photo', src: DOT_PNG, style: { width: '40px', height: '40px' }, children: [] },
            { id: 'logo', type: 'svg', name: 'Logo', svg: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></svg>', style: { width: '40px', height: '40px' }, children: [] }
          ]),
          // Canvas order for the combined PDF: Top (y 0, x 900), then Middle (y 700, x 0), then Bottom (y 1400).
          artboard('bottom', 'Bottom', 0, 1400, 300, 300),
          artboard('top', 'Top', 900, 0, 400, 200),
          artboard('middle', 'Middle', 0, 700, 500, 250)
        ]
      }
    ]
  })
)

/** Width, height and the first pixel's alpha of a PNG. */
function pngInfo(file: string) {
  const data = readFileSync(file)
  const width = data.readUInt32BE(16)
  const height = data.readUInt32BE(20)
  const colorType = data[25]
  const idat: Buffer[] = []
  for (let at = 8; at < data.length; ) {
    const length = data.readUInt32BE(at)
    const type = data.toString('latin1', at + 4, at + 8)
    if (type === 'IDAT') idat.push(data.subarray(at + 8, at + 8 + length))
    at += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  // On the first row every PNG filter leaves the first pixel as stored: byte 0 is the filter type.
  const alpha = colorType === 6 ? raw[4] : 255
  return { width, height, alpha }
}

/** Width and height of a JPEG, from its SOF marker. */
function jpegSize(file: string) {
  const data = readFileSync(file)
  for (let at = 2; at < data.length; ) {
    const marker = data[at + 1]
    const length = data.readUInt16BE(at + 2)
    if (marker >= 0xc0 && marker <= 0xc3) return { width: data.readUInt16BE(at + 7), height: data.readUInt16BE(at + 5) }
    at += 2 + length
  }
  return null
}

/** Page sizes (in px, from points) of a Chromium PDF, in page order. */
function pdfPages(file: string) {
  const text = readFileSync(file, 'latin1')
  const boxes = [...text.matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)].map((m) => ({
    width: Math.round(Number(m[1]) / 0.75),
    height: Math.round(Number(m[2]) / 0.75)
  }))
  return { boxes, hasFont: /\/Font\b/.test(text) }
}

let app = await App.launch(profile)
let client = await BridgeClient.start(path.join(profile.userData, 'mcp.json'))
const call = (name: string, args: object = {}) => client.call(name, { fileId, ...args })
const center = async (selector: string) => {
  const r = await app.rect(selector)
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
}
const clickOn = async (selector: string) => {
  await app.eval(`(document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center' }), true)`)
  const { x, y } = await center(selector)
  await app.click(x, y)
  await sleep(60)
}
const exportsOf = (id: string) =>
  app.eval<any>(`JSON.stringify((function find(nodes) { for (const n of nodes) { if (n.id === '${id}') return n.exports ?? null; const f = find(n.children); if (f !== undefined) return f } })(window.opendrawStore.getState().document.pages[0].nodes))`).then((s) => JSON.parse(s ?? 'null'))

try {
  await app.eval(`opendrawTest.setExportDir(${JSON.stringify(OUT)}).then(() => true)`)

  await check('Panel: a 2x PNG and a JPG 512w entry export Card@2x.png at twice the size and Card@512w.jpg 512 px wide', async () => {
    await app.eval(`(window.opendrawStore.select(['card']), true)`)
    await app.waitFor(`document.querySelector('[data-testid="export-add"]') !== null`)
    await clickOn('[data-testid="export-add"]')
    await clickOn('[data-testid="export-add"]')
    let settings = await exportsOf('card')
    expect(JSON.stringify(settings) === JSON.stringify([{ format: 'png', scale: '1x' }, { format: 'png', scale: '2x' }]), JSON.stringify(settings))
    // First row: JPG at 512w.
    await app.eval(`(() => {
      const select = document.querySelectorAll('[data-testid="export-format"]')[0]
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
      set.call(select, 'jpg'); select.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
    await sleep(60)
    const scale = '[data-testid="export-row"]:first-child [data-testid="export-scale"]'
    await clickOn(scale)
    await app.eval(`(document.querySelector('${scale}').select(), true)`)
    await app.type('512w')
    await app.key('Enter', 'Enter', 0, 13)
    await sleep(60)
    settings = await exportsOf('card')
    expect(settings[0].format === 'jpg' && settings[0].scale === '512w' && settings[1].scale === '2x', JSON.stringify(settings))
    await app.waitFor(`document.querySelector('[data-testid="export-preview"]') !== null`, 15_000)
    await clickOn('[data-testid="export-run"]')
    await app.waitFor(`document.querySelector('[data-testid="export-status"]')?.textContent.startsWith('Exported') ?? false`, 20_000)
    const png = pngInfo(path.join(OUT, 'Card@2x.png'))
    const jpg = jpegSize(path.join(OUT, 'Card@512w.jpg'))
    expect(png.width === 400 && png.height === 240, `png ${png.width}x${png.height}`)
    expect(jpg?.width === 512 && jpg.height === 307, `jpg ${JSON.stringify(jpg)}`)
    // The rounded corner shows through: only the layer is exported, not the white artboard behind it.
    expect(png.alpha === 0, `corner alpha ${png.alpha}`)
    return `Card@2x.png ${png.width}x${png.height} (corner alpha ${png.alpha}), Card@512w.jpg ${jpg?.width}x${jpg?.height}`
  })

  await check('Undo removes an added entry', async () => {
    await clickOn('[data-testid="export-add"]')
    const before = (await exportsOf('card')).length
    await app.eval(`(document.activeElement?.blur(), true)`)
    await app.key('z', 'KeyZ', CMD, 90)
    await sleep(60)
    const after = (await exportsOf('card')).length
    expect(before === 3 && after === 2, `${before} -> ${after}`)
    return `${before} entries, ${after} after undo`
  })

  await check('A PDF export of an artboard has its page size and text as text', async () => {
    await app.eval(`(window.opendrawStore.transact('x', (tx) => tx.setExports('desktop', [{ format: 'pdf', scale: '1x' }, { format: 'svg', scale: '1x' }])), true)`)
    const result = await call('export', { nodes: ['desktop'] })
    const pdf = result.exports.find((e: any) => e.format === 'pdf').path
    const svg = result.exports.find((e: any) => e.format === 'svg').path
    const { boxes, hasFont } = pdfPages(pdf)
    expect(boxes.length === 1 && boxes[0].width === 800 && boxes[0].height === 600, `pages ${JSON.stringify(boxes)}`)
    expect(hasFont, 'no fonts in the PDF: text was not kept as text')
    const svgText = readFileSync(svg, 'utf8')
    expect(svgText.startsWith('<svg') && svgText.includes('foreignObject') && svgText.includes('Hello export'), svgText.slice(0, 200))
    return `${path.basename(pdf)} 800x600 with fonts; ${path.basename(svg)} keeps text`
  })

  await check('export with "nodes-with-exports-only" exports exactly the layers with settings; IDs without settings give a 1x PNG', async () => {
    const all = await call('export', { nodes: 'nodes-with-exports-only' })
    const nodes = [...new Set(all.exports.map((e: any) => e.nodeId))].sort()
    expect(JSON.stringify(nodes) === JSON.stringify(['card', 'desktop']), `nodes ${nodes}`)
    const plain = await call('export', { nodes: ['top'] })
    const file = plain.exports[0]
    const info = pngInfo(file.path)
    expect(plain.exports.length === 1 && file.format === 'png' && path.basename(file.path) === 'Top.png' && info.width === 400, JSON.stringify(plain))
    const video = await client.callRaw('export', { fileId, nodes: ['top'], type: 'video' })
    expect(video.isError, 'video export did not fail')
    return `${all.exports.length} files for ${nodes.join(', ')}; Top.png ${info.width}x${info.height}`
  })

  await check('export_combined_pdf with three artboards writes a 3-page PDF in canvas order', async () => {
    const result = await call('export_combined_pdf', { nodeIds: ['bottom', 'middle', 'top'] })
    const { boxes } = pdfPages(result.path)
    const sizes = boxes.map((b) => `${b.width}x${b.height}`).join(',')
    // PDF pages are in points; a 250 px side is 187.5 pt and may round up a pixel.
    const want = [[400, 200], [500, 250], [300, 300]]
    const close = boxes.length === 3 && boxes.every((b, i) => Math.abs(b.width - want[i][0]) <= 1 && Math.abs(b.height - want[i][1]) <= 1)
    expect(close, `pages ${sizes}`)
    expect(JSON.stringify(result.pages) === JSON.stringify(['top', 'middle', 'bottom']), JSON.stringify(result.pages))
    return `${path.basename(result.path)}: ${sizes}`
  })

  await check('get_fill_image returns JPEG data for an image layer and a message for an SVG layer', async () => {
    const image = await client.callRaw('get_fill_image', { fileId, nodeId: 'photo' })
    const svg = await client.callRaw('get_fill_image', { fileId, nodeId: 'logo' })
    const none = await client.callRaw('get_fill_image', { fileId, nodeId: 'card' })
    const picture = image.content.find((c: any) => c.type === 'image')
    expect(picture?.mimeType === 'image/jpeg' && Buffer.from(picture.data, 'base64')[0] === 0xff, JSON.stringify(image).slice(0, 200))
    expect(!svg.isError && /get_jsx/.test(svg.content[0].text), svg.content[0].text)
    expect(/no image fill/.test(none.content[0].text), none.content[0].text)
    return `${svg.content[0].text} | ${none.content[0].text}`
  })

  await check('Export settings survive a restart', async () => {
    await sleep(800)
    client.close()
    await app.close()
    app = await App.launch(profile)
    client = await BridgeClient.start(path.join(profile.userData, 'mcp.json'))
    const card = await exportsOf('card')
    const desktop = await exportsOf('desktop')
    expect(card?.length === 2 && desktop?.length === 2, `card ${JSON.stringify(card)}, desktop ${JSON.stringify(desktop)}`)
    expect(existsSync(OUT), 'export folder missing')
    return `card ${card.map((s: any) => `${s.format} ${s.scale}`).join(', ')}`
  })
} finally {
  client.close()
  await app.kill()
}

await finish('export')
