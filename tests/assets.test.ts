// End-to-end acceptance checks for S-22 (local images as opendraw-asset://, and lock state in
// get_node_info). Run with `bun run test:assets`.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { App, cleanProfile } from './cdp'
import { check, expect, finish } from './checks'
import { BridgeClient } from './mcp-client'
import { readPNG, solidPNG } from './png'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const profile = cleanProfile()
mkdirSync(path.join(profile.workspace, 'images'), { recursive: true })
writeFileSync(path.join(profile.workspace, 'images', 'logo.png'), solidPNG(8, 8, [255, 0, 0, 255]))
writeFileSync(path.join(profile.workspace, 'images', 'notes.txt'), 'not an image')
const fileId = 'assets-file'
const FILE = path.join(profile.workspace, 'Assets.opendraw')
// Saved by S-17, before the rename: the image and the background still use paper-asset://.
writeFileSync(
  FILE,
  JSON.stringify({
    format: 'opendraw',
    version: 1,
    id: fileId,
    name: 'Assets',
    pages: [
      {
        id: 'page-1',
        name: 'Page 1',
        nodes: [
          {
            id: 'desktop',
            type: 'artboard',
            name: 'Desktop',
            style: { left: '0px', top: '0px', width: '800px', height: '600px', backgroundColor: '#ffffff', display: 'flex', flexDirection: 'column', gap: '20px', padding: '20px' },
            children: [
              { id: 'old-logo', type: 'image', name: 'Old logo', src: 'paper-asset://images/logo.png', style: { width: '40px', height: '40px' }, children: [] },
              {
                id: 'card',
                type: 'frame',
                name: 'Card',
                style: { width: '200px', height: '80px', backgroundImage: 'url("paper-asset://images/logo.png")' },
                children: [{ id: 'title', type: 'text', name: 'Title', text: 'Card title', style: { fontSize: '18px' }, children: [] }]
              }
            ]
          }
        ]
      }
    ]
  })
)

// Outside the workspace: an absolute path is copied into the design file (D-8, D-11).
const outside = path.join(tmpdir(), `opendraw-assets-${process.pid}`)
mkdirSync(outside, { recursive: true })
const BLUE_PNG = path.join(outside, 'blue logo.png')
writeFileSync(BLUE_PNG, solidPNG(12, 12, [0, 0, 255, 255]))

let app = await App.launch(profile, 9381)
let client = await BridgeClient.start(path.join(profile.userData, 'mcp.json'))
const call = (name: string, args: object) => client.call(name, { fileId, ...args })
const doc = () => app.eval<any>(`window.opendrawStore.getState().document`)
const find = (nodes: any[], id: string): any => nodes.map((n) => (n.id === id ? n : find(n.children ?? [], id))).find(Boolean)
const node = async (id: string) => find((await doc()).pages[0].nodes, id)
const saved = () => JSON.parse(readFileSync(FILE, 'utf8'))
const waitForSave = async (test: (file: any) => boolean) => {
  for (let i = 0; i < 50; i++) {
    if (test(saved())) return
    await sleep(100)
  }
  throw new Error('the file was not saved')
}
const imageWidth = (id: string) => app.eval<number>(`document.querySelector('img[data-node-id="${id}"], [data-node-id="${id}"] img')?.naturalWidth ?? -1`)

try {
  await check('A file saved with paper-asset:// URLs opens with the image showing and is rewritten to opendraw-asset://', async () => {
    await app.waitFor(`!!document.querySelector('[data-node-id="old-logo"]')`)
    await sleep(300)
    const width = await imageWidth('old-logo')
    expect(width === 8, `image naturalWidth ${width}`)
    const logo = await node('old-logo')
    const card = await node('card')
    expect(logo.src === 'opendraw-asset://images/logo.png' && card.style.backgroundImage === 'url("opendraw-asset://images/logo.png")', `${logo.src}; ${card.style.backgroundImage}`)
    const saved = readFileSync(FILE, 'utf8')
    expect(!saved.includes('paper-asset') && saved.includes('opendraw-asset://images/logo.png'), 'the file on disk still has paper-asset://')
    return `image loaded (${width}px); the document and the file on disk use opendraw-asset://`
  })

  await check('paper-asset:// written by an agent is stored as opendraw-asset://, and nothing reads back paper-asset://', async () => {
    const written = await call('write_html', {
      targetNodeId: 'desktop',
      mode: 'insert-children',
      html: '<img layer-name="Logo" src="paper-asset://images/logo.png" style="width: 40px; height: 40px" />'
    })
    const id = written.created[0].id
    await call('update_styles', { updates: [{ nodeIds: ['title'], styles: { backgroundImage: 'url("paper-asset://images/logo.png")' } }] })
    await sleep(300)
    const width = await imageWidth(id)
    const jsx = String(await call('get_jsx', { nodeId: 'desktop' }))
    const html = await app.eval<string>(`window.opendrawStore.getState().document.pages[0].nodes[0].children.map((n) => n.src ?? '').join(' ')`)
    expect(width === 8, `naturalWidth ${width}`)
    expect(!jsx.includes('paper-asset') && (jsx.match(/opendraw-asset:\/\/images\/logo\.png/g) ?? []).length >= 3, jsx.slice(0, 400))
    expect(!html.includes('paper-asset'), html)
    const shot = await client.callRaw('get_screenshot', { fileId, nodeId: id })
    const img = readPNG(Buffer.from(shot.content[0].data, 'base64'))
    const [r, g, b] = img.pixel(Math.floor(img.width / 2), Math.floor(img.height / 2))
    expect(r > 240 && g < 15 && b < 15, `screenshot center ${r},${g},${b}`)
    return `img and background stored as opendraw-asset://; get_jsx has no paper-asset; screenshot ${r},${g},${b}`
  })

  let blueId = ''
  await check('An absolute path outside the workspace is copied into the file and renders on the canvas and in get_screenshot', async () => {
    const url = `opendraw-asset://${encodeURI(BLUE_PNG)}`
    const written = await call('write_html', { targetNodeId: 'desktop', mode: 'insert-children', html: `<img layer-name="Blue" src="${url}" style="width: 40px; height: 40px" />` })
    blueId = written.created[0].id
    const legacy = await call('write_html', { targetNodeId: 'desktop', mode: 'insert-children', html: `<img layer-name="Blue again" src="paper-asset://${encodeURI(BLUE_PNG)}" style="width: 40px; height: 40px" />` })
    await sleep(300)
    const width = await imageWidth(blueId)
    const blue = await node(blueId)
    const again = await node(legacy.created[0].id)
    expect(width === 12, `naturalWidth ${width}`)
    expect(/^opendraw-asset:\/\/[0-9a-f]{16}\.png$/.test(blue.src) && again.src === blue.src, `${blue.src} / ${again.src}`)
    const shot = await client.callRaw('get_screenshot', { fileId, nodeId: blueId })
    const img = readPNG(Buffer.from(shot.content[0].data, 'base64'))
    const [r, g, b] = img.pixel(Math.floor(img.width / 2), Math.floor(img.height / 2))
    expect(b > 240 && r < 15 && g < 15, `screenshot center ${r},${g},${b}`)
    const key = blue.src.slice('opendraw-asset://'.length)
    await waitForSave((file) => !!file.assets?.[key])
    const asset = saved().assets[key]
    expect(asset.type === 'image/png' && Buffer.from(asset.data, 'base64').equals(readFileSync(BLUE_PNG)), 'the saved copy differs from the source')
    expect(Object.keys(saved().assets).length === 1, `assets ${Object.keys(saved().assets)}`)
    return `stored as ${blue.src} (paper-asset:// gives the same copy); screenshot ${r},${g},${b}; the file holds one copy`
  })

  await check('With the source file deleted, the design still shows the copied image after the app restarts', async () => {
    rmSync(BLUE_PNG)
    client.close()
    await app.kill()
    app = await App.launch(profile, 9381)
    client = await BridgeClient.start(path.join(profile.userData, 'mcp.json'))
    await app.waitFor(`!!document.querySelector('[data-node-id="${blueId}"]')`)
    await sleep(300)
    const width = await imageWidth(blueId)
    expect(width === 12, `naturalWidth ${width}`)
    const fill = await client.callRaw('get_fill_image', { fileId, nodeId: blueId })
    expect(!fill.isError && fill.content.some((c: any) => c.type === 'image'), JSON.stringify(fill).slice(0, 200))
    const snapshot = await app.eval<boolean>(`'assets' in window.opendrawStore.getState().document`)
    expect(!snapshot, 'the editor holds the image data')
    return `image ${width}px wide from the file's own copy; get_fill_image works`
  })

  await check('A missing path or a file that is not an image fails the write, naming the path, and changes nothing', async () => {
    const before = JSON.stringify(await doc())
    const missing = await client.callRaw('write_html', {
      fileId,
      targetNodeId: 'desktop',
      mode: 'insert-children',
      html: '<div style="width: 10px; height: 10px"></div><img src="opendraw-asset://images/nope.png" />'
    })
    const absent = await client.callRaw('write_html', { fileId, targetNodeId: 'desktop', mode: 'insert-children', html: `<img src="opendraw-asset://${path.join(outside, 'gone.png')}" />` })
    const c = absent.content?.[0]?.text ?? ''
    expect(absent.isError && c.includes(path.join(outside, 'gone.png')), c)
    const notImage = await client.callRaw('update_styles', { fileId, updates: [{ nodeIds: ['card'], styles: { backgroundImage: 'url(opendraw-asset://images/notes.txt)' } }] })
    const a = missing.content?.[0]?.text ?? ''
    const b = notImage.content?.[0]?.text ?? ''
    expect(missing.isError && a.includes('images/nope.png'), a)
    expect(notImage.isError && b.includes('images/notes.txt') && /not an image/.test(b), b)
    await sleep(200)
    expect(JSON.stringify(await doc()) === before, 'the document changed')
    return `${a}; ${c}; ${b}`
  })

  await check('get_node_info reports locked for a layer locked in the panel and for its child; unlocking reports false', async () => {
    const info = async () => [(await call('get_node_info', { nodeId: 'card' })).locked, (await call('get_node_info', { nodeId: 'title' })).locked]
    const before = await info()
    await app.eval(`document.querySelector('.layer-row[data-layer-id="card"] [data-testid="layer-lock"]').click(), true`)
    await app.waitFor(`!!document.querySelector('.layer-row[data-layer-id="card"][data-locked]')`)
    const locked = await info()
    await app.eval(`document.querySelector('.layer-row[data-layer-id="card"] [data-testid="layer-lock"]').click(), true`)
    await app.waitFor(`!document.querySelector('.layer-row[data-layer-id="card"][data-locked]')`)
    const unlocked = await info()
    expect(before.join() === 'false,false', `before ${before}`)
    expect(locked.join() === 'true,true', `locked ${locked}`)
    expect(unlocked.join() === 'false,false', `unlocked ${unlocked}`)
    return `card, title: ${before} -> ${locked} -> ${unlocked}`
  })
} finally {
  client.close()
  await app.kill()
  rmSync(outside, { recursive: true, force: true })
}

await finish('assets')
