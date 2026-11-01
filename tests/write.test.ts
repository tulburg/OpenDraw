// End-to-end acceptance checks for S-5 (MCP write tools), through the opendraw-mcp bridge.
// Run with `bun run test:write`.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { App, cleanProfile } from './cdp'
import { check, expect, finish, RESULTS_DIR } from './checks'
import { BridgeClient } from './mcp-client'

const CMD = process.platform === 'darwin' ? 4 : 2
const WIDTH = 800
const HEIGHT = 600

// A file with two pages: the user views Page 1 (one Desktop artboard); Page 2 is empty.
const profile = cleanProfile()
mkdirSync(profile.workspace, { recursive: true })
const PAGE_1 = 'page-1'
const PAGE_2 = 'page-2'
writeFileSync(
  path.join(profile.workspace, 'Agent test.opendraw'),
  JSON.stringify({
    format: 'opendraw',
    version: 1,
    id: 'file-1',
    name: 'Agent test',
    pages: [
      {
        id: PAGE_1,
        name: 'Page 1',
        nodes: [
          {
            id: 'desktop',
            type: 'artboard',
            name: 'Desktop',
            style: { left: '0px', top: '0px', width: '1440px', height: '900px', backgroundColor: '#ffffff' },
            children: []
          }
        ]
      },
      { id: PAGE_2, name: 'Page 2', nodes: [] }
    ]
  })
)

const app = await App.launch(profile)
const client = await BridgeClient.start(path.join(profile.userData, 'mcp.json'))
const fileId = 'file-1'
const call = (name: string, args: object = {}) => client.call(name, { fileId, ...args })
const documentJSON = () => app.eval<string>('JSON.stringify(window.opendrawStore.getState().document)')

// The landing page, as one HTML document. The agent writes it in pieces; the reference renders it whole.
const ARTBOARD_STYLE =
  'width: 800px; height: 600px; display: flex; flex-direction: column; background-color: #f6f5f1; padding: 32px; gap: 28px; font-family: Helvetica, Arial, sans-serif; color: #1b1b1b'
const LOGO_SVG =
  '<svg width="28" height="28" viewBox="0 0 28 28" layer-name="Logo mark"><circle cx="14" cy="14" r="12" fill="#ff5a36"/><rect x="9" y="9" width="10" height="10" fill="#ffffff"/></svg>'
const DOT_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='
const HEADER = `<div layer-name="Header" style="display: flex; align-items: center; justify-content: space-between">
  <div style="display: flex; align-items: center; gap: 10px">${LOGO_SVG}<span style="font-size: 20px; font-weight: 700">Northwind</span></div>
  <div style="display: flex; gap: 24px; font-size: 14px"><a style="color: #1b1b1b; text-decoration: none">Product</a><a style="color: #1b1b1b; text-decoration: none">Pricing</a><a style="color: #1b1b1b; text-decoration: none">Docs</a></div>
</div>`
const HERO = `<div layer-name="Hero" style="display: flex; flex-direction: column; gap: 12px">
  <h1 style="font-size: 44px; line-height: 50px; letter-spacing: -0.02em">Ship designs, not handoffs</h1>
  <p style="font-size: 17px; line-height: 26px; color: #55524b; width: 520px">Agents write HTML straight onto the canvas while you watch.</p>
</div>`
const card = (title: string, body: string, background: string) =>
  `<div layer-name="Card" style="display: flex; flex-direction: column; gap: 10px; flex: 1; padding: 20px; border-radius: 14px; background-color: ${background}">
  <img src="${DOT_PNG}" width="36" height="36" style="border-radius: 8px">
  <div style="font-size: 18px; font-weight: 700">${title}</div>
  <div style="font-size: 14px; line-height: 20px; color: #55524b">${body}</div>
</div>`
const CARDS = [
  card('Live', 'Every write lands on the canvas as it happens.', '#ffffff'),
  card('Undoable', 'Each tool call is one step in the history.', '#ffffff'),
  card('CSS native', 'What you write is what gets saved.', '#ffe9df')
]
const REFERENCE = `<!doctype html><html><head><style>* { box-sizing: border-box; margin: 0 } body { margin: 0 }</style></head>
<body><div style="${ARTBOARD_STYLE}">${HEADER}${HERO}<div layer-name="Cards" style="display: flex; gap: 16px">${CARDS.join('')}</div></div></body></html>`

/** Mean per-channel difference (0-255) between two PNGs, compared at WIDTH x HEIGHT in the page. */
async function pixelDifference(a: string, b: string): Promise<number> {
  return app.eval<number>(`(async () => {
    const load = (b64) => new Promise((resolve, reject) => {
      const image = new Image(); image.onload = () => resolve(image); image.onerror = reject
      image.src = 'data:image/png;base64,' + b64 })
    const pixels = async (b64) => {
      const c = document.createElement('canvas'); c.width = ${WIDTH}; c.height = ${HEIGHT}
      const ctx = c.getContext('2d'); ctx.drawImage(await load(b64), 0, 0, ${WIDTH}, ${HEIGHT})
      return ctx.getImageData(0, 0, ${WIDTH}, ${HEIGHT}).data }
    const a = await pixels(${JSON.stringify(a)}), b = await pixels(${JSON.stringify(b)})
    let total = 0
    for (let i = 0; i < a.length; i += 4) total += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
    return total / (${WIDTH} * ${HEIGHT} * 3)
  })()`)
}

/** Renders the reference HTML in a plain iframe over the window and captures it. */
async function referenceShot(): Promise<string> {
  await app.eval(`new Promise((resolve) => {
    const frame = document.createElement('iframe')
    frame.id = 'reference'
    frame.style.cssText = 'position: fixed; left: 0; top: 0; width: ${WIDTH}px; height: ${HEIGHT}px; border: 0; z-index: 100000'
    frame.onload = () => frame.contentDocument.fonts.ready.then(() => setTimeout(resolve, 100))
    frame.srcdoc = ${JSON.stringify(REFERENCE)}
    document.body.appendChild(frame)
  })`)
  const { data } = await app.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 }
  })
  await app.eval(`document.getElementById('reference').remove()`)
  return data
}

let landingId = ''

try {
  await check('An agent builds a landing page with only the write tools; it matches the HTML in a plain browser', async () => {
    const artboard = await call('create_artboard', {
      name: 'Landing',
      styles: {
        width: `${WIDTH}px`,
        height: `${HEIGHT}px`,
        backgroundColor: '#f6f5f1',
        padding: '32px',
        gap: '28px',
        fontFamily: 'Helvetica, Arial, sans-serif',
        color: '#1b1b1b'
      }
    })
    landingId = artboard.id
    const header = await call('write_html', { targetNodeId: landingId, mode: 'insert-children', html: HEADER })
    expect(header.dropped.length === 0, `header dropped: ${header.dropped}`)
    await call('write_html', { targetNodeId: landingId, mode: 'insert-children', html: HERO })
    const row = await call('write_html', {
      targetNodeId: landingId,
      mode: 'insert-children',
      html: '<div layer-name="Cards" style="display: flex; gap: 16px"></div>'
    })
    const rowId = row.created[0].id
    // One card from HTML, two by duplicating it and editing the copies.
    const first = await call('write_html', { targetNodeId: rowId, mode: 'insert-children', html: CARDS[0] })
    const cardId = first.created[0].id
    const [, titleId, bodyId] = first.created[0].children.map((c: any) => c.id)
    const copies = await call('duplicate_nodes', { nodes: [{ id: cardId }, { id: cardId }] })
    // Copies land right after the original, so the second call's copy comes first.
    const [third, second] = copies.duplicates
    await call('set_text_content', {
      updates: [
        { nodeId: second.descendantIdMap[titleId], html: 'Undoable' },
        { nodeId: second.descendantIdMap[bodyId], html: 'Each tool call is one step in the history.' },
        { nodeId: third.descendantIdMap[titleId], html: 'CSS native' },
        { nodeId: third.descendantIdMap[bodyId], html: 'What you write is what gets saved.' }
      ]
    })
    const styled = await call('update_styles', { updates: [{ nodeIds: [third.newId], styles: { backgroundColor: '#ffe9df' } }] })
    expect(!styled.ignoredStyles, `ignored: ${JSON.stringify(styled.ignoredStyles)}`)
    await call('rename_nodes', {
      updates: [
        { nodeId: second.newId, name: 'Card' },
        { nodeId: third.newId, name: 'Card' }
      ]
    })

    const tree = await client.call('get_tree_summary', { fileId, nodeId: landingId, depth: 4 })
    expect(/SVG "Logo mark"/.test(tree) && /Image/.test(tree) && /Text "Ship designs, not handoffs"/.test(tree), tree)
    await Bun.sleep(300)
    const shot = await client.callRaw('get_screenshot', { fileId, nodeId: landingId })
    const ours = shot.content[0].data
    const theirs = await referenceShot()
    await Bun.write(path.join(RESULTS_DIR, 'write-landing.png'), Buffer.from(ours, 'base64'))
    await Bun.write(path.join(RESULTS_DIR, 'write-reference.png'), Buffer.from(theirs, 'base64'))
    const diff = await pixelDifference(ours, theirs)
    expect(diff < 2, `mean channel difference ${diff.toFixed(2)} (see tests/results/write-*.png)`)
    return `mean channel difference vs plain browser ${diff.toFixed(2)} of 255; header, hero, 3 cards with SVG and images`
  })

  await check('write_html reports margin, grid and tables as dropped and renders the rest', async () => {
    const result = await call('write_html', {
      targetNodeId: landingId,
      mode: 'insert-children',
      html: `<div layer-name="Grid" style="display: grid; grid-template-columns: 1fr 1fr; padding: 12px; background-color: #eeeeee">
        <div layer-name="Box" style="margin: 20px; width: 40px; height: 40px; background-color: red"></div>
        <table><tr><td>cell</td></tr></table>
        <span style="display: inline">inline</span>
      </div>`
    })
    const dropped: string[] = result.dropped
    const has = (pattern: RegExp) => dropped.some((line) => pattern.test(line))
    expect(has(/^display on <div "Grid">: display: grid/), `grid display not reported: ${dropped.join(' | ')}`)
    expect(has(/^gridTemplateColumns on <div "Grid">/), 'grid-template-columns not reported')
    expect(has(/^margin on <div "Box">/), 'margin not reported')
    expect(has(/^<table>: tables are not supported/), 'table not reported')
    expect(has(/^display on <span>: display: inline/), 'inline display not reported')
    const grid = result.created[0]
    expect(grid.children.map((c: any) => c.name).join() === 'Box,inline', `children: ${JSON.stringify(grid.children)}`)
    const styles = await client.call('get_computed_styles', { fileId, nodeIds: [grid.id, grid.children[0].id] })
    expect(styles[grid.id].paddingTop === '12px' && styles[grid.id].display === 'block', JSON.stringify(styles[grid.id]))
    expect(styles[grid.children[0].id].width === '40px', 'box lost its size')
    await call('delete_nodes', { nodeIds: [grid.id] })
    return `${dropped.length} drops reported; padding, size and the other children kept`
  })

  await check('Two create_artboard calls never overlap and keep 80 px apart', async () => {
    const a = await call('create_artboard', { name: 'A', styles: { width: '390px', height: '844px' } })
    const b = await call('create_artboard', { name: 'B', styles: { width: '390px', height: '844px' } })
    const info = await client.call('get_basic_info', { fileId, pageId: PAGE_1 })
    const boxes = info.artboards.map((ab: any) => ({ ...ab, x: ab.worldX, y: ab.worldY }))
    let closest = Number.POSITIVE_INFINITY
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const p = boxes[i]
        const q = boxes[j]
        const gapX = Math.max(q.x - (p.x + p.width), p.x - (q.x + q.width))
        const gapY = Math.max(q.y - (p.y + p.height), p.y - (q.y + q.height))
        const gap = Math.max(gapX, gapY)
        expect(gap >= 80, `${p.name} and ${q.name} are ${gap} px apart`)
        closest = Math.min(closest, gap)
      }
    }
    expect(closest === 80, `closest pair is ${closest} px apart`)
    const placed = boxes.filter((ab: any) => ab.id === a.id || ab.id === b.id).map((ab: any) => `${ab.name} at ${ab.x},${ab.y}`)
    return `${boxes.length} artboards, closest 80 px; ${placed.join(', ')}`
  })

  await check('Undo after write_html removes exactly what it added', async () => {
    const before = await documentJSON()
    await call('write_html', {
      targetNodeId: landingId,
      mode: 'insert-children',
      html: '<div layer-name="Footer" style="display: flex; gap: 8px"><span>One</span><span>Two</span></div>'
    })
    const written = await documentJSON()
    expect(written !== before, 'write_html changed nothing')
    await app.key('z', 'KeyZ', CMD, 90)
    await Bun.sleep(100)
    expect((await documentJSON()) === before, 'undo did not restore the document exactly')
    await app.key('z', 'KeyZ', CMD | 8, 90)
    await Bun.sleep(100)
    expect((await documentJSON()) === written, 'redo did not bring the write back')
    await app.key('z', 'KeyZ', CMD, 90)
    return 'one cmd+Z restores the document byte for byte; redo brings it back'
  })

  await check('The working indicator shows during writes and clears on finish_working_on_nodes', async () => {
    await call('finish_working_on_nodes')
    const count = () => app.eval<number>(`document.querySelectorAll('.working-indicator').length`)
    expect((await count()) === 0, 'indicators left after releasing all')
    await call('update_styles', { updates: [{ nodeIds: [landingId], styles: { backgroundColor: '#f6f5f1' } }] })
    await Bun.sleep(100)
    const shown = await app.eval<string[]>(
      `[...document.querySelectorAll('.working-indicator')].map((el) => el.dataset.artboardId)`
    )
    expect(shown.join() === landingId, `indicators on: ${shown}`)
    const label = await app.eval<string>(`document.querySelector('.working-indicator').textContent`)
    expect(label === 'Agent working', `label "${label}"`)
    const released = await call('finish_working_on_nodes', { nodeIds: [landingId] })
    expect(released.released.join() === landingId, JSON.stringify(released))
    await Bun.sleep(100)
    expect((await count()) === 0, 'indicator still shown after finish_working_on_nodes')
  })

  await check('A write to another page does not change the user\'s page or viewport', async () => {
    const viewBefore = await app.eval(`({ page: window.opendrawStore.getState().pageId,
      transform: document.querySelector('.canvas-world').style.transform })`)
    const ab = await call('create_artboard', { name: 'Elsewhere', pageId: PAGE_2, styles: { width: '400px', height: '300px' } })
    await call('write_html', { targetNodeId: ab.id, mode: 'insert-children', html: '<div style="padding: 20px">Off-screen</div>' })
    await Bun.sleep(200)
    const viewAfter = await app.eval(`({ page: window.opendrawStore.getState().pageId,
      transform: document.querySelector('.canvas-world').style.transform })`)
    expect(JSON.stringify(viewAfter) === JSON.stringify(viewBefore), `${JSON.stringify(viewBefore)} -> ${JSON.stringify(viewAfter)}`)
    const page2 = await app.eval(`window.opendrawStore.getState().document.pages[1].nodes.map((n) => n.name + ':' + n.children.length)`)
    expect(page2.join() === 'Elsewhere:1', `page 2: ${page2}`)
    const onCanvas = await app.eval<number>(`document.querySelectorAll('[data-node-id="${ab.id}"]').length`)
    expect(onCanvas === 0, 'the other page was drawn on the user\'s canvas')
    await call('finish_working_on_nodes')
    return `page 2 got the artboard and its content; page 1 view unchanged`
  })

  await check('move_nodes keeps IDs, reorders siblings and crosses pages', async () => {
    const row = await call('write_html', {
      targetNodeId: landingId,
      mode: 'insert-children',
      html: '<div layer-name="Row" style="display: flex"><div layer-name="A"></div><div layer-name="B"></div><div layer-name="C"></div></div>'
    })
    const [a, b, c] = row.created[0].children.map((n: any) => n.id)
    const moved = await call('move_nodes', { moves: [{ nodeId: c, before: a }, { nodeId: a, parentId: row.created[0].id, index: 1 }] })
    expect(moved.affectedParents[row.created[0].id].join() === [c, a, b].join(), JSON.stringify(moved))
    const elsewhere = (await client.call('get_basic_info', { fileId, pageId: PAGE_2 })).artboards[0].id
    await call('move_nodes', { moves: [{ nodeId: b, parentId: elsewhere }] })
    const info = await client.call('get_node_info', { fileId, nodeId: b })
    expect(info.parentId === elsewhere, `b is under ${info.parentId}`)
    await call('delete_nodes', { nodeIds: [row.created[0].id] })
    await call('finish_working_on_nodes')
  })

  await check('Write tools reject bad input without changing the document', async () => {
    const before = await documentJSON()
    const wrongFile = await client.callRaw('delete_nodes', { fileId: 'nope', nodeIds: [landingId] })
    const textParent = await client.callRaw('write_html', {
      fileId,
      targetNodeId: (await call('find_nodes', { textValue: 'Northwind' }))[0].id,
      mode: 'insert-children',
      html: '<div></div>'
    })
    const missing = await client.callRaw('update_styles', { fileId, updates: [{ nodeIds: ['missing'], styles: { color: 'red' } }] })
    expect(wrongFile.isError && textParent.isError && missing.isError, 'an invalid call succeeded')
    expect((await documentJSON()) === before, 'a failed call changed the document')
    return [wrongFile, textParent, missing].map((r) => r.content[0].text).join(' | ')
  })
} finally {
  client.close()
  app.kill()
}

await finish('write')
