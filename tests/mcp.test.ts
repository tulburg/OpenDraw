// End-to-end acceptance checks for S-4 (MCP server and read tools), through the opendraw-mcp bridge.
// Run with `bun run test:mcp`.
import { existsSync, readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import path from 'node:path'

import { App, cleanProfile } from './cdp'
import { check, expect, finish } from './checks'
import { BridgeClient } from './mcp-client'

const CMD = process.platform === 'darwin' ? 4 : 2
const SHIFT = 8
const READ_TOOLS = [
  'find_nodes', 'get_basic_info', 'get_children', 'get_computed_styles', 'get_jsx', 'get_node_info',
  'get_screenshot', 'get_selection', 'get_tree_summary'
]

const profile = cleanProfile()
const discovery = path.join(profile.userData, 'mcp.json')
let app = await App.launch(profile)
const client = await BridgeClient.start(discovery)

/** PNG width and height from the IHDR chunk. */
function pngSize(base64: string) {
  const bytes = Buffer.from(base64, 'base64')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

// A known test document: one 400x300 artboard with a row (fixed + growing child) and a text node.
await app.eval(`(() => {
  const store = window.opendrawStore
  const page = store.getState().document.pages[0]
  store.transact('setup', (tx) => {
    tx.deleteNodes(page.nodes.map((n) => n.id))
    tx.insertNodes(page.id, 0, [{
      id: 'ab', type: 'artboard', name: 'Card test',
      style: { left: '0px', top: '0px', width: '400px', height: '300px', backgroundColor: '#ffffff',
        display: 'flex', flexDirection: 'column', padding: '20px', gap: '12px' },
      children: [
        { id: 'row', type: 'frame', name: 'Row', style: { display: 'flex', flexDirection: 'row', width: '360px', height: '80px' },
          children: [
            { id: 'fixed', type: 'frame', name: 'Fixed', style: { width: '100px', backgroundColor: '#ff0000' }, children: [] },
            { id: 'grow', type: 'frame', name: 'Grow', style: { flexGrow: 1, backgroundColor: 'rgb(0, 0, 255)' }, children: [] }
          ] },
        { id: 'title', type: 'text', name: 'Title', text: 'Hello world',
          style: { fontFamily: 'Helvetica, sans-serif', fontSize: '24px', color: '#111111' }, children: [] }
      ]
    }])
    tx.select(['title'])
  })
  return true
})()`)
await app.key('!', 'Digit1', SHIFT, 49)
await app.key('0', 'Digit0', CMD, 48)
await Bun.sleep(200)
const fileId = await app.eval<string>('window.opendrawStore.getState().document.id')

try {
  let liveToolCount = 0
  await check('The bridge lists the 9 read tools, marked read-only', async () => {
    const { tools } = await client.request('tools/list')
    liveToolCount = tools.length
    const names = tools.map((t: any) => t.name)
    const missing = READ_TOOLS.filter((name) => !names.includes(name))
    expect(missing.length === 0, `missing: ${missing}`)
    const notReadOnly = tools.filter((t: any) => READ_TOOLS.includes(t.name) && !t.annotations?.readOnlyHint)
    expect(notReadOnly.length === 0, `not read-only: ${notReadOnly.map((t: any) => t.name)}`)
    const branded = tools.filter((t: any) => /paper/i.test(t.description))
    expect(branded.length === 0, `Paper named in: ${branded.map((t: any) => t.name)}`)
    return READ_TOOLS.join(', ')
  })

  await check('get_basic_info: file, page, artboards, fonts', async () => {
    const info = await client.call('get_basic_info')
    expect(info.fileId === fileId && info.fileName === 'Untitled', `file ${info.fileId} ${info.fileName}`)
    expect(info.page.isActive && info.pages.length === 1, 'page')
    expect(info.nodeCount === 5, `nodeCount ${info.nodeCount}`)
    const [ab] = info.artboards
    expect(ab.id === 'ab' && ab.width === 400 && ab.height === 300 && ab.worldX === 0 && ab.worldY === 0, `artboard ${JSON.stringify(ab)}`)
    expect(info.fontFamilies.join() === 'Helvetica', `fonts ${info.fontFamilies}`)
    const wrongFile = await client.callRaw('get_basic_info', { fileId: 'nope' })
    expect(wrongFile.isError, 'a wrong fileId did not error')
  })

  await check('get_tree_summary: outline with sizes and depth limit', async () => {
    const full = await client.call('get_tree_summary', { fileId, nodeId: 'ab' })
    const lines = full.split('\n')
    expect(lines.length === 5, `lines:\n${full}`)
    expect(lines[0].startsWith('Artboard "Card test" (ab) 400x300'), lines[0])
    expect(lines[1] === '  Frame "Row" (row) 360x80', lines[1])
    expect(lines[3].startsWith('    Frame "Grow" (grow) 260x80'), lines[3])
    expect(lines[4].includes('Text "Title" (title)') && lines[4].includes('"Hello world"'), lines[4])
    const shallow = await client.call('get_tree_summary', { fileId, nodeId: 'ab', depth: 1 })
    expect(shallow.split('\n')[1].includes('2 children'), `depth 1:\n${shallow}`)
  })

  await check('get_node_info and get_children: parent, text, positions and sizes', async () => {
    const title = await client.call('get_node_info', { fileId, nodeId: 'title' })
    expect(title.textContent === 'Hello world' && title.parentId === 'ab' && title.component === 'Text', JSON.stringify(title))
    expect(title.x === 20 && title.y === 112 && title.worldX === 20 && title.worldY === 112, `position ${title.x},${title.y}`)
    expect(title.width === 360 && title.height > 20, `size ${title.width}x${title.height}`)
    const children = await client.call('get_children', { fileId, nodeId: 'row' })
    expect(children.map((c: any) => c.id).join() === 'fixed,grow', `children ${children.map((c: any) => c.id)}`)
    const grow = children[1]
    expect(grow.width === 260 && grow.x === 100 && grow.worldX === 120, `grow ${JSON.stringify(grow)}`)
  })

  await check('get_selection: selected node and its artboard', async () => {
    const selection = await client.call('get_selection')
    const [node] = selection.nodes
    expect(selection.nodes.length === 1 && node.id === 'title' && node.artboard.id === 'ab', JSON.stringify(selection))
  })

  await check('find_nodes: text and color matches across notations', async () => {
    const byText = await client.call('find_nodes', { fileId, textValue: 'hello*' })
    expect(byText.map((n: any) => n.id).join() === 'title', `text: ${JSON.stringify(byText)}`)
    const red = await client.call('find_nodes', { fileId, filters: [{ styleName: 'background-color', styleValue: 'rgb(255, 0, 0)' }] })
    expect(red.map((n: any) => n.id).join() === 'fixed', `red: ${JSON.stringify(red)}`)
    const blue = await client.call('find_nodes', { fileId, filters: [{ styleValue: '#00f' }] })
    expect(blue.map((n: any) => n.id).join() === 'grow', `blue: ${JSON.stringify(blue)}`)
  })

  await check('get_jsx round-trips the tree, styles and text', async () => {
    const jsx: string = await client.call('get_jsx', { fileId, nodeId: 'ab' })
    const doc = await app.eval('window.opendrawStore.getState().document.pages[0].nodes[0]')
    const missing: string[] = []
    const visit = (node: any, isRoot: boolean) => {
      if (!jsx.includes(`id="${node.id}"`)) missing.push(`id ${node.id}`)
      if (!jsx.includes(`data-name="${node.name}"`)) missing.push(`name ${node.name}`)
      for (const [key, value] of Object.entries(node.style)) {
        if (isRoot && ['left', 'top'].includes(key)) continue
        const literal = typeof value === 'number' ? `${key}: ${value}` : `${key}: ${JSON.stringify(value)}`
        if (!jsx.includes(literal)) missing.push(literal)
      }
      if (node.text && !jsx.includes(node.text)) missing.push(`text ${node.text}`)
      node.children.forEach((c: any) => visit(c, false))
    }
    visit(doc, true)
    expect(missing.length === 0, `missing from JSX: ${missing.join('; ')}`)
    expect(!jsx.includes('left: "0px"'), 'root positioning was not stripped')
    const tailwind: string = await client.call('get_jsx', { fileId, nodeId: 'row', format: 'tailwind', includeNodeIds: false })
    expect(tailwind.includes('flex-row') && tailwind.includes('bg-[color:#ff0000]') && !tailwind.includes(' id='), tailwind)
  })

  await check('get_computed_styles reports laid-out sizes, not just stored CSS', async () => {
    const styles = await client.call('get_computed_styles', { fileId, nodeIds: ['grow', 'title'] })
    expect(styles.grow.width === '260px', `grow width ${styles.grow.width}`)
    expect(styles.title.color === 'rgb(17, 17, 17)' && styles.title.fontSize === '24px', JSON.stringify(styles.title))
    return `grow ${styles.grow.width} (stored CSS has no width)`
  })

  await check('get_screenshot matches the canvas pixels at scale 1', async () => {
    const editorWidth = await app.eval<number>('window.innerWidth')
    const one = await client.callRaw('get_screenshot', { fileId, nodeId: 'ab' })
    const two = await client.callRaw('get_screenshot', { fileId, nodeId: 'ab', scale: 2 })
    const img = one.content[0]
    expect(img.type === 'image' && img.mimeType === 'image/png', `content ${img.type}`)
    const s1 = pngSize(img.data)
    const s2 = pngSize(two.content[0].data)
    expect(s1.width === 400 && s1.height === 300, `scale 1 size ${s1.width}x${s1.height}`)
    expect(s2.width === 800 && s2.height === 600, `scale 2 size ${s2.width}x${s2.height}`)
    const widthAfter = await app.eval<number>('window.innerWidth')
    expect(widthAfter === editorWidth, `editor zoomed by the render window: innerWidth ${editorWidth} -> ${widthAfter}`)

    // Capture the same artboard from the canvas at 100% zoom and compare pixel by pixel in the page.
    await app.key('Escape', 'Escape', 0, 27)
    await Bun.sleep(100)
    const rect = await app.rect('[data-node-id=ab]')
    const { data: canvasShot } = await app.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 }
    })
    const diff = await app.eval<number>(`(async () => {
      const load = (b64) => new Promise((resolve, reject) => {
        const image = new Image(); image.onload = () => resolve(image); image.onerror = reject
        image.src = 'data:image/png;base64,' + b64 })
      const pixels = async (b64) => {
        const c = document.createElement('canvas'); c.width = 400; c.height = 300
        const ctx = c.getContext('2d'); ctx.drawImage(await load(b64), 0, 0, 400, 300)
        return ctx.getImageData(0, 0, 400, 300).data }
      const a = await pixels(${JSON.stringify(img.data)}), b = await pixels(${JSON.stringify(canvasShot)})
      let total = 0
      for (let i = 0; i < a.length; i += 4) total += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
      return total / (400 * 300 * 3)
    })()`)
    await Bun.write(path.join(import.meta.dir, 'results', 'mcp-screenshot.png'), Buffer.from(img.data, 'base64'))
    await Bun.write(path.join(import.meta.dir, 'results', 'mcp-canvas.png'), Buffer.from(canvasShot, 'base64'))
    expect(diff < 2, `mean channel difference ${diff.toFixed(2)}`)
    return `400x300 and 800x600; mean channel difference vs canvas ${diff.toFixed(2)} of 255`
  })

  await check('The HTTP listener only serves this machine, with the token', async () => {
    const info = JSON.parse(readFileSync(discovery, 'utf8'))
    const url = new URL(info.url)
    expect(url.hostname === '127.0.0.1', `listens on ${url.hostname}`)
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((a) => a && a.family === 'IPv4' && !a.internal)?.address
    if (lan) {
      const reached = await fetch(`http://${lan}:${url.port}/mcp`, { method: 'POST' }).then(() => true, () => false)
      expect(!reached, `reachable on ${lan}`)
    }
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
    const noToken = await fetch(info.url, { method: 'POST', headers, body })
    expect(noToken.status === 401, `no token: HTTP ${noToken.status}`)
    const evilOrigin = await fetch(info.url, {
      method: 'POST',
      headers: { ...headers, authorization: `Bearer ${info.token}`, origin: 'https://evil.example' },
      body
    })
    expect(evilOrigin.status === 403, `foreign origin: HTTP ${evilOrigin.status}`)
    return `127.0.0.1 only${lan ? `; ${lan} refused` : ''}; no token 401; foreign origin 403`
  })

  await check('With the app closed, tools return the not-running error quickly', async () => {
    await app.quit()
    expect(!existsSync(discovery), 'discovery file left behind')
    const started = Date.now()
    const result = await client.callRaw('get_basic_info')
    const elapsed = Date.now() - started
    expect(result.isError && /not running/.test(result.content[0].text), JSON.stringify(result))
    expect(elapsed < 2000, `took ${elapsed} ms`)
    const { tools } = await client.request('tools/list')
    expect(tools.length === liveToolCount, `offline tools/list has ${tools.length} tools, the app ${liveToolCount}`)
    // A fresh client with the app closed still initializes.
    const fresh = await BridgeClient.start(discovery)
    const freshResult = await fresh.callRaw('get_screenshot', { fileId, nodeId: 'ab' })
    fresh.close()
    expect(freshResult.isError, 'fresh client call did not error')
    return `answered in ${elapsed} ms`
  })
} finally {
  client.close()
  app.kill()
}

await finish('mcp')
