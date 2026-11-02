// End-to-end acceptance checks for S-26 (image layer controls): fit, position, replace, and the same
// controls for frames with a background image. Run with `bun run test:images`.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { App, cleanProfile } from './cdp'
import { check, expect, finish } from './checks'
import { BridgeClient } from './mcp-client'
import { readPNG, solidPNG, stripedPNG } from './png'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const CMD = process.platform === 'darwin' ? 4 : 2

const RED = [255, 0, 0, 255]
const GREEN = [0, 255, 0, 255]
const BLUE = [0, 0, 255, 255]
const YELLOW = [255, 255, 0, 255]
// 100 x 50, four 25 px stripes. In a 200 x 200 box, Stretch shows all four across the width; Fill
// (cover) scales to 400 x 200 and crops to the middle two stripes, so its left edge is green.
const stripes = `data:image/png;base64,${stripedPNG(100, 50, [RED, GREEN, BLUE, YELLOW]).toString('base64')}`

const profile = cleanProfile()
mkdirSync(profile.workspace, { recursive: true })
const fileId = 'images-file'
writeFileSync(
  path.join(profile.workspace, 'Images.opendraw'),
  JSON.stringify({
    format: 'opendraw',
    version: 1,
    id: fileId,
    name: 'Images',
    pages: [
      {
        id: 'page-1',
        name: 'Page 1',
        nodes: [
          {
            id: 'desktop',
            type: 'artboard',
            name: 'Desktop',
            style: { left: '0px', top: '0px', width: '800px', height: '600px', backgroundColor: '#ffffff', display: 'flex', flexDirection: 'row', gap: '20px', padding: '20px' },
            children: [
              { id: 'photo', type: 'image', name: 'Photo', src: stripes, style: { width: '200px', height: '200px', flexShrink: '0' }, children: [] },
              { id: 'hero', type: 'frame', name: 'Hero', style: { width: '200px', height: '200px', backgroundImage: `url("${stripes}")` }, children: [] }
            ]
          }
        ]
      }
    ]
  })
)

const app = await App.launch(profile, 9351)
const client = await BridgeClient.start(path.join(profile.userData, 'mcp.json'))
const doc = () => app.eval<any>(`window.opendrawStore.getState().document`)
const node = async (id: string) => {
  const find = (nodes: any[]): any => nodes.map((n) => (n.id === id ? n : find(n.children))).find(Boolean)
  return find((await doc()).pages[0].nodes)
}
const select = async (id: string) => {
  await app.eval(`window.opendrawStore.select([${JSON.stringify(id)}]), true`)
  await app.waitFor(`!!document.querySelector('[data-group="Image"]')`)
}
/** Picks an option in a styles panel select, the way a user's choice reaches React. */
const choose = (field: string, value: string) =>
  app.eval(`(() => {
    const el = document.querySelector('[data-field="${field}"] select')
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
const shotPixel = async (nodeId: string, x: number, y: number) => readPNG(Buffer.from((await client.callRaw('get_screenshot', { fileId, nodeId })).content[0].data, 'base64')).pixel(x, y)
const near = (a: number[], b: number[]) => a.slice(0, 3).every((v, i) => Math.abs(v - b[i]) < 40)

try {
  await check('Fit set to Fill on an image in a 200 x 200 box writes object-fit: cover and is not distorted', async () => {
    const stretched = await shotPixel('photo', 5, 100)
    await select('photo')
    await choose('objectFit', 'cover')
    await app.waitFor(`window.opendrawStore.getState().document.pages[0].nodes[0].children[0].style.objectFit === 'cover'`)
    await sleep(200)
    const filled = await shotPixel('photo', 5, 100)
    const contained = await (async () => {
      await choose('objectFit', 'contain')
      await sleep(200)
      return shotPixel('photo', 100, 10)
    })()
    await choose('objectFit', 'cover')
    expect(near(stretched, RED), `before: left edge ${stretched}`)
    expect(near(filled, GREEN), `Fill: left edge ${filled}, expected the cropped green stripe`)
    expect(contained[3] === 0 || near(contained, [255, 255, 255]), `Fit: top band ${contained}, expected empty`)
    return `left edge red when stretched, green (cropped, not squashed) with Fill; Fit leaves the top band empty`
  })

  await check('Picking the top-left anchor writes object-position: left top', async () => {
    await app.eval(`document.querySelector('[data-field="objectPosition-anchor"] [data-anchor="left top"]').click(), true`)
    await app.waitFor(`window.opendrawStore.getState().document.pages[0].nodes[0].children[0].style.objectPosition === 'left top'`)
    const checked = await app.eval<string>(`document.querySelector('[data-field="objectPosition-anchor"] [aria-checked="true"]').dataset.anchor`)
    const shown = await app.eval<string>(`document.querySelector('[data-field="objectPosition"] input').value`)
    expect(checked === 'left top' && shown === 'left top', `checked ${checked}, field ${shown}`)
    // With cover and left top, the crop starts at the image's left edge: red shows again.
    const pixel = await shotPixel('photo', 5, 100)
    expect(near(pixel, RED), `left edge ${pixel}`)
    return 'object-position: left top; the crop moves to the left edge'
  })

  await check('Replace keeps the layer ID and styles and changes only the image; one undo restores it', async () => {
    const before = await node('photo')
    const file = path.join(profile.workspace, 'blue.png')
    writeFileSync(file, solidPNG(40, 40, BLUE))
    const { root } = await app.send('DOM.getDocument', { depth: 0 })
    const { nodeId } = await app.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-field="replace-image"] input[type=file]' })
    await app.send('DOM.setFileInputFiles', { nodeId, files: [file] })
    await app.waitFor(`window.opendrawStore.getState().document.pages[0].nodes[0].children[0].src !== ${JSON.stringify(before.src)}`)
    const after = await node('photo')
    expect(after.id === 'photo' && after.name === before.name, `${after.id} ${after.name}`)
    expect(JSON.stringify(after.style) === JSON.stringify(before.style), `styles changed: ${JSON.stringify(after.style)}`)
    expect(after.src.startsWith('data:image/png'), after.src.slice(0, 30))
    await app.key('z', 'KeyZ', CMD, 90)
    await app.waitFor(`window.opendrawStore.getState().document.pages[0].nodes[0].children[0].src === ${JSON.stringify(before.src)}`)
    return 'same ID, name and styles; new picture; undo restores the old one'
  })

  await check('A frame with a background image offers background-size fits that write the expected CSS', async () => {
    await select('hero')
    const options = await app.eval<string[]>(`[...document.querySelectorAll('[data-field="backgroundSize"] option')].map((o) => o.value).filter(Boolean)`)
    expect(options.join() === 'cover,contain,100% 100%,auto', `options ${options}`)
    const written: string[] = []
    for (const value of ['cover', 'contain', '100% 100%']) {
      await choose('backgroundSize', value)
      await app.waitFor(`window.opendrawStore.getState().document.pages[0].nodes[0].children[1].style.backgroundSize === ${JSON.stringify(value)}`)
      written.push(value)
    }
    await choose('backgroundRepeat', 'no-repeat')
    await app.eval(`document.querySelector('[data-field="backgroundPosition-anchor"] [data-anchor="right bottom"]').click(), true`)
    await app.waitFor(`window.opendrawStore.getState().document.pages[0].nodes[0].children[1].style.backgroundPosition === 'right bottom'`)
    const computed = await client.call('get_computed_styles', { fileId, nodeIds: ['hero'] })
    const jsx = (await client.callRaw('get_jsx', { fileId, nodeId: 'hero' })).content[0].text as string
    expect(/backgroundSize: ['"]100% 100%['"]/.test(jsx), 'get_jsx is missing backgroundSize')
    const hero = computed.hero ?? computed
    expect(hero.backgroundSize === '100% 100%' && hero.backgroundRepeat === 'no-repeat' && hero.backgroundPosition === '100% 100%', JSON.stringify(hero))
    const photo = (await client.call('get_computed_styles', { fileId, nodeIds: ['photo'] })).photo
    expect(photo.objectFit === 'cover' && photo.objectPosition === '0% 0%', `photo ${photo.objectFit} ${photo.objectPosition}`)
    return `${written.join(', ')} written; get_jsx and get_computed_styles report size, repeat and position`
  })

  await check('Alt + dropping an image file on an image layer replaces it instead of adding a layer', async () => {
    const before = await node('photo')
    const count = (await node('desktop')).children.length
    const r = await app.rect('[data-node-id="photo"]')
    // A synthetic drop: the DataTransfer holds a real File, as a drag from Finder does.
    await app.eval(`(() => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(solidPNG(30, 30, GREEN).toString('base64'))}), (c) => c.charCodeAt(0))
      const data = new DataTransfer()
      data.items.add(new File([bytes], 'green.png', { type: 'image/png' }))
      const target = document.elementFromPoint(${r.x + r.width / 2}, ${r.y + r.height / 2})
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, altKey: true, clientX: ${r.x + r.width / 2}, clientY: ${r.y + r.height / 2}, dataTransfer: data }))
      return true
    })()`)
    await app.waitFor(`window.opendrawStore.getState().document.pages[0].nodes[0].children[0].src !== ${JSON.stringify(before.src)}`)
    const after = (await node('desktop')).children.length
    expect(after === count, `${count} layers before, ${after} after`)
    return 'picture replaced; no layer added'
  })
} finally {
  client.close()
  await app.kill()
}

await finish('images')
