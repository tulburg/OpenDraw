// End-to-end acceptance checks for S-23 (clipboard with other apps): pasting images, SVG, HTML and
// text from the system clipboard, and copying layers as HTML. Run with `bun run test:clipboard`.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { App, cleanProfile } from './cdp'
import { check, expect, finish } from './checks'
import { solidPNG } from './png'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const CMD = process.platform === 'darwin' ? 4 : 2

const profile = cleanProfile()
mkdirSync(profile.workspace, { recursive: true })
writeFileSync(
  path.join(profile.workspace, 'Clipboard.opendraw'),
  JSON.stringify({
    format: 'opendraw',
    version: 1,
    id: 'clipboard-file',
    name: 'Clipboard',
    pages: [
      {
        id: 'page-1',
        name: 'Page 1',
        nodes: [
          {
            id: 'desktop',
            type: 'artboard',
            name: 'Desktop',
            style: { left: '0px', top: '0px', width: '800px', height: '600px', backgroundColor: '#ffffff' },
            children: [
              { id: 'box', type: 'frame', name: 'Box', style: { position: 'absolute', left: '20px', top: '20px', width: '400px', height: '300px', backgroundColor: '#eeeeee' }, children: [] },
              {
                id: 'card',
                type: 'frame',
                name: 'Card',
                style: { position: 'absolute', left: '440px', top: '20px', width: '200px', display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px', backgroundColor: '#ddeeff' },
                children: [{ id: 'title', type: 'text', name: 'Title', text: 'Card title', style: { fontSize: '18px' }, children: [] }]
              }
            ]
          }
        ]
      }
    ]
  })
)

const app = await App.launch(profile, 9361)
const doc = () => app.eval<any>(`window.opendrawStore.getState().document`)
const find = (nodes: any[], id: string): any => nodes.map((n) => (n.id === id ? n : find(n.children ?? [], id))).find(Boolean)
const node = async (id: string) => find((await doc()).pages[0].nodes, id)
const children = async (id: string) => ((await node(id))?.children ?? []) as any[]
const selection = () => app.eval<string[]>(`window.opendrawStore.getState().selection`)
const select = (id: string) => app.eval(`window.opendrawStore.select([${JSON.stringify(id)}]), true`)
/** Puts items on the system clipboard, as another app would: a map of MIME type to text or base64 (for images). */
const putOnClipboard = (items: Record<string, string>) =>
  app.eval(`(async () => {
    const items = ${JSON.stringify(items)}
    const blobs = Object.fromEntries(Object.entries(items).map(([type, value]) => [type, type.startsWith('image/png')
      ? new Blob([Uint8Array.from(atob(value), (c) => c.charCodeAt(0))], { type })
      : new Blob([value], { type })]))
    await navigator.clipboard.write([new ClipboardItem(blobs)])
    return true
  })()`)
const pasteInto = async (id: string, items: Record<string, string>) => {
  await select(id)
  await putOnClipboard(items)
  const before = (await children(id)).length
  await app.command('paste', 'v')
  await app.waitFor(`(() => { const f = (ns) => ns.map((n) => n.id === ${JSON.stringify(id)} ? n : f(n.children ?? [])).find(Boolean); return f(window.opendrawStore.getState().document.pages[0].nodes).children.length > ${before} })()`)
  return (await children(id)).slice(before)
}
const undoTo = async (id: string, count: number) => {
  await app.key('z', 'KeyZ', CMD, 90)
  await app.waitFor(`(() => { const f = (ns) => ns.map((n) => n.id === ${JSON.stringify(id)} ? n : f(n.children ?? [])).find(Boolean); return f(window.opendrawStore.getState().document.pages[0].nodes).children.length === ${count} })()`)
}

try {
  await check('Pasting a PNG adds an image layer in the selected frame at its natural size; one undo removes it', async () => {
    const added = await pasteInto('box', { 'image/png': solidPNG(120, 80, [0, 128, 255, 255]).toString('base64') })
    expect(added.length === 1 && added[0].type === 'image', JSON.stringify(added.map((n) => n.type)))
    const image = added[0]
    expect(image.style.width === '120px' && image.style.height === '80px', `size ${image.style.width} x ${image.style.height}`)
    expect(image.src.startsWith('data:image/png'), image.src.slice(0, 30))
    const selected = await selection()
    expect(selected.join() === image.id, `selection ${selected}`)
    await undoTo('box', 0)
    return `image ${image.style.width} x ${image.style.height} in Box, selected; undo removed it`
  })

  await check('Pasting an SVG string adds an SVG layer with its <script> removed', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><script>alert(1)</script><circle cx="12" cy="12" r="10" fill="red"/></svg>'
    const added = await pasteInto('box', { 'text/plain': svg })
    expect(added.length === 1 && added[0].type === 'svg', JSON.stringify(added.map((n) => n.type)))
    expect(!/script/i.test(added[0].svg) && /circle/.test(added[0].svg), added[0].svg)
    expect(added[0].style.width === '24px', `width ${added[0].style.width}`)
    await undoTo('box', 0)
    return 'SVG layer 24 x 24 with the circle and no script'
  })

  await check('Pasting HTML adds a flex frame with rich text, and a notice reports margin dropped', async () => {
    const html = '<div style="display:flex;gap:8px;margin:4px"><p>Hi <b>there</b></p></div>'
    const added = await pasteInto('box', { 'text/html': `<meta charset="utf-8"><!--StartFragment-->${html}<!--EndFragment-->`, 'text/plain': 'Hi there' })
    const frame = added[0]
    expect(added.length === 1 && frame.type === 'frame' && frame.style.display === 'flex' && frame.style.gap === '8px', JSON.stringify(frame?.style))
    expect(!frame.style.margin, `margin kept: ${frame.style.margin}`)
    const text = frame.children[0]
    expect(text?.type === 'text' && text.text === 'Hi there', JSON.stringify(text))
    expect((text.spans ?? []).some((s: any) => s.text === 'there' && /bold|700/.test(String(s.style?.fontWeight))), JSON.stringify(text.spans))
    await app.waitFor(`!!document.querySelector('[data-testid=notice]')`)
    const notice = await app.eval<string>(`document.querySelector('[data-testid=notice]').textContent`)
    expect(/margin/.test(notice), notice)
    await undoTo('box', 0)
    return `flex frame, gap 8px, rich text "Hi there" with bold "there"; notice: ${notice}`
  })

  await check('HTML copied as text from a code editor converts the markup, not its highlighting', async () => {
    const markup = '<div layer-name="Pill" style="display:flex;padding:4px 8px;background-color:#222"><span style="color:#fff">New</span></div>'
    const added = await pasteInto('box', { 'text/plain': markup, 'text/html': `<div style="color:#d4d4d4"><span style="color:#808080">&lt;div</span> ...</div>` })
    expect(added.length === 1 && added[0].name === 'Pill' && added[0].style.backgroundColor === '#222', JSON.stringify(added[0]).slice(0, 200))
    await undoTo('box', 0)
    return 'the frame named Pill from the text, not the highlighted copy'
  })

  await check('Pasting plain text adds a text layer with that text', async () => {
    const added = await pasteInto('box', { 'text/plain': 'Hello from another app' })
    expect(added.length === 1 && added[0].type === 'text' && added[0].text === 'Hello from another app', JSON.stringify(added[0]))
    // A layer in a frame that is not a flex box is placed, not left to flow.
    expect(added[0].style.position === 'absolute', JSON.stringify(added[0].style))
    await undoTo('box', 0)
    return 'text layer "Hello from another app", positioned in Box'
  })

  await check('Copying a frame puts its HTML on the system clipboard; pasting it back gives an identical copy', async () => {
    await select('card')
    await app.command('copy', 'c')
    await sleep(100)
    const html = await app.eval<string>(`(async () => {
      const [item] = await navigator.clipboard.read()
      return item.types.includes('text/html') ? await (await item.getType('text/html')).text() : 'no text/html in ' + item.types
    })()`)
    expect(html.includes('layer-name="Card"') && html.includes('display: flex') && html.includes('Card title'), html)
    await select('desktop')
    const before = (await children('desktop')).length
    await app.command('paste', 'v')
    await app.waitFor(`window.opendrawStore.getState().document.pages[0].nodes[0].children.length === ${before + 1}`)
    const copy = (await children('desktop')).at(-1)
    const original = await node('card')
    const strip = (n: any): any => ({ ...n, id: undefined, children: n.children.map(strip) })
    expect(JSON.stringify(strip(copy)) === JSON.stringify(strip(original)), `copy ${JSON.stringify(strip(copy)).slice(0, 200)}`)
    return `text/html holds the Card's HTML (${html.length} chars); pasted back as an identical copy`
  })

  await check('Pasting while typing in a field keeps the normal text paste', async () => {
    await putOnClipboard({ 'text/plain': '42' })
    const before = (await doc()).pages[0].nodes[0].children.length
    await app.eval(`(() => { const input = document.querySelector('[data-field="opacity"] input'); input.focus(); input.select(); return true })()`)
    await app.command('paste', 'v')
    await sleep(150)
    const value = await app.eval<string>(`document.activeElement.value`)
    const after = (await doc()).pages[0].nodes[0].children.length
    expect(value === '42' && after === before, `field ${value}, layers ${before} -> ${after}`)
    await app.key('Escape', 'Escape', 0, 27)
    return 'the field got "42"; no layer added'
  })
} finally {
  await app.kill()
}

await finish('clipboard')
