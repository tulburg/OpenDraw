// End-to-end acceptance checks for S-17 (agent helpers): get_font_family_info and Google Fonts on
// demand, get_guide, <x-paper-clone> in write_html, and local image URLs (paper-asset:// input, stored as opendraw-asset://). Run with `bun run test:helpers`.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { App, cleanProfile } from './cdp'
import { check, expect, finish } from './checks'
import { BridgeClient } from './mcp-client'
import { readPNG, solidPNG } from './png'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const INSTALLED = process.platform === 'darwin' ? 'Menlo' : 'DejaVu Sans'

const profile = cleanProfile()
mkdirSync(profile.workspace, { recursive: true })
const FILE = path.join(profile.workspace, 'Helpers.opendraw')
const fileId = 'helpers-file'
writeFileSync(
  FILE,
  JSON.stringify({
    format: 'opendraw',
    version: 1,
    id: fileId,
    name: 'Helpers',
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
              { id: 'label', type: 'text', name: 'Label', text: 'Hamburgefonstiv', style: { fontSize: '48px', fontFamily: 'Arial', alignSelf: 'flex-start' }, children: [] },
              {
                id: 'card',
                type: 'frame',
                name: 'Card',
                style: { width: '200px', height: '120px', backgroundColor: '#eeeeee', display: 'flex', padding: '10px' },
                children: [{ id: 'card-title', type: 'text', name: 'Title', text: 'Card', style: { fontSize: '16px' }, children: [] }]
              }
            ]
          }
        ]
      }
    ]
  })
)

mkdirSync(path.join(profile.workspace, 'images'), { recursive: true })
writeFileSync(path.join(profile.workspace, 'images', 'logo.png'), solidPNG(8, 8, [255, 0, 0, 255]))
writeFileSync(path.join(profile.workspace, '..', 'secret.png'), solidPNG(8, 8, [0, 0, 255, 255]))

const app = await App.launch(profile)
const client = await BridgeClient.start(path.join(profile.userData, 'mcp.json'))
const call = (name: string, args: object = {}) => client.call(name, { fileId, ...args })

try {
  await check('get_font_family_info: Inter, an installed family and "Not A Font"', async () => {
    const { families } = await call('get_font_family_info', { familyNames: ['Inter', INSTALLED, 'Not A Font'] })
    const [inter, installed, none] = families
    expect(inter.available && inter.sources.includes('google-fonts') && inter.weights.includes(700), JSON.stringify(inter))
    expect(installed.available && installed.sources.includes('installed') && installed.weights.length > 0, JSON.stringify(installed))
    expect(!none.available && none.weights.length === 0, JSON.stringify(none))
    return `Inter ${inter.weights.length} weights (${inter.sources}), ${INSTALLED} ${installed.weights} (${installed.sources}), Not A Font unavailable`
  })

  await check('A Google Fonts family used in update_styles renders on the canvas and in get_screenshot', async () => {
    const family = 'Lobster'
    const { families } = await call('get_font_family_info', { familyNames: [family] })
    expect(families[0].sources.join() === 'google-fonts', `${family} is ${JSON.stringify(families[0])}; pick a family not installed here`)
    const arial = await app.eval<number>(`document.querySelector('[data-node-id="label"]').getBoundingClientRect().width`)
    const arialRendered = Number.parseFloat((await call('get_computed_styles', { nodeIds: ['label'] })).label.width)
    await call('update_styles', { updates: [{ nodeIds: ['label'], styles: { fontFamily: family } }] })
    await app.waitFor(`document.fonts.check('48px ${family}') && [...document.fonts].some((f) => f.family.replace(/"/g, '') === '${family}' && f.status === 'loaded')`, 15000)
    await sleep(200)
    const lobster = await app.eval<number>(`document.querySelector('[data-node-id="label"]').getBoundingClientRect().width`)
    const rendered = Number.parseFloat((await call('get_computed_styles', { nodeIds: ['label'] })).label.width)
    const zoom = await app.eval<number>(`Number(document.querySelector('.canvas-world').dataset.zoom) || 1`)
    expect(Math.abs(lobster - arial) > 10, `canvas width ${arial} -> ${lobster}`)
    expect(Math.abs(rendered - arialRendered) > 10 && Math.abs(rendered - lobster / zoom) < 2, `render width ${arialRendered} -> ${rendered}, canvas ${lobster / zoom}`)
    const shot = await client.callRaw('get_screenshot', { fileId, nodeId: 'label' })
    expect(!shot.isError && shot.content[0].type === 'image', 'no screenshot')
    return `${family}: canvas ${Math.round(arial / zoom)} -> ${Math.round(lobster / zoom)} px, screenshot render ${Math.round(arialRendered)} -> ${Math.round(rendered)} px`
  })

  await check('get_guide returns the instructions; an unknown topic lists the topics', async () => {
    const guide = await client.callRaw('get_guide', { topic: 'opendraw-mcp-instructions' })
    const body = guide.content[0].text as string
    expect(!guide.isError && body.includes('get_basic_info') && body.includes('finish_working_on_nodes') && body.includes('x-opendraw-clone'), body.slice(0, 200))
    const bar = await client.callRaw('get_guide', { topic: 'mobile-status-bar' })
    expect(!bar.isError && bar.content[0].text.includes('9:41'), 'status bar guide')
    const unknown = await client.callRaw('get_guide', { topic: 'figma-import' })
    const message = unknown.content[0].text as string
    expect(unknown.isError && message.includes('opendraw-mcp-instructions') && message.includes('mobile-status-bar'), message)
    return message
  })

  await check('write_html with x-paper-clone inserts a copy with new IDs and the overridden width; a bad node ID changes nothing', async () => {
    const before = await call('get_children', { nodeId: 'desktop' })
    const count = (before.children ?? before).length
    const result = await call('write_html', {
      targetNodeId: 'desktop',
      mode: 'insert-children',
      html: '<x-paper-clone node-id="card" layer-name="Wide card" style="width: 320px"></x-paper-clone><x-paper-clone node-id="card" />'
    })
    const after = await call('get_children', { nodeId: 'desktop' })
    const kids = after.children ?? after
    const copies = kids.slice(count)
    const wide = copies[0]
    expect(kids.length === count + 2 && wide.id !== 'card' && wide.name === 'Wide card', JSON.stringify(copies))
    const jsx = await call('get_jsx', { nodeId: wide.id })
    const info = await call('get_node_info', { nodeId: wide.id })
    expect(info.width === 320 && String(jsx).includes('Card') && !String(jsx).includes('"card-title"'), `width ${info.width}; ${String(jsx).slice(0, 300)}`)
    expect(copies[1].name === 'Card' && copies[1].id !== 'card', JSON.stringify(copies[1]))
    const bad = await client.callRaw('write_html', { fileId, targetNodeId: 'desktop', mode: 'insert-children', html: '<div style="width: 10px; height: 10px"></div><x-paper-clone node-id="missing"></x-paper-clone>' })
    const unchanged = await call('get_children', { nodeId: 'desktop' })
    expect(bad.isError && (unchanged.children ?? unchanged).length === kids.length, `${JSON.stringify(bad)}; ${(unchanged.children ?? unchanged).length}`)
    return `${JSON.stringify(result).slice(0, 120)}; bad: ${bad.content[0].text}`
  })

  await check('paper-asset://images/logo.png renders on the canvas and in a screenshot; paper-asset://../secret.png fails the write and does not load', async () => {
    const written = await call('write_html', {
      targetNodeId: 'desktop',
      mode: 'insert-children',
      html: '<div layer-name="Assets" style="display: flex; gap: 10px"><img layer-name="Logo" src="paper-asset://images/logo.png" style="width: 40px; height: 40px" /></div>'
    })
    const logo = written.created[0].children.find((n: any) => n.name === 'Logo')
    const secret = await client.callRaw('write_html', { fileId, targetNodeId: 'desktop', mode: 'insert-children', html: '<img layer-name="Secret" src="paper-asset://../secret.png" />' })
    const secretError = secret.content?.[0]?.text ?? ''
    expect(secret.isError && secretError.includes('../secret.png'), secretError)
    await sleep(300)
    const size = (id: string) => app.eval<number>(`document.querySelector('[data-node-id="${id}"] img, img[data-node-id="${id}"]')?.naturalWidth ?? -1`)
    const logoWidth = await size(logo.id)
    expect(logoWidth === 8, `logo ${logoWidth}`)
    const shot = await client.callRaw('get_screenshot', { fileId, nodeId: logo.id })
    const img = readPNG(Buffer.from(shot.content[0].data, 'base64'))
    const [r, g, b] = img.pixel(Math.floor(img.width / 2), Math.floor(img.height / 2))
    expect(r > 240 && g < 15 && b < 15, `screenshot center ${r},${g},${b}`)
    const jsx = String(await call('get_jsx', { nodeId: logo.id }))
    expect(jsx.includes('opendraw-asset://images/logo.png') && !jsx.includes('paper-asset'), jsx)
    const fill = await client.callRaw('get_fill_image', { fileId, nodeId: logo.id })
    expect(!fill.isError, JSON.stringify(fill).slice(0, 200))
    const refused = await app.eval<number>(`fetch('opendraw-asset://../secret.png').then((r) => r.status, () => -1)`)
    expect(refused === 403 || refused === -1, `fetch status ${refused}`)
    return `logo ${logoWidth}px wide, screenshot ${r},${g},${b}; secret write failed (${secretError}); fetch refused (${refused})`
  })
} finally {
  client.close()
  await app.kill()
}

await finish('helpers')
