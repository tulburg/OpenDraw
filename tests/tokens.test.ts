// End-to-end acceptance checks for S-14 (design tokens): Paper's token tools, var() references on
// the canvas, and the Tokens panel. Run with `bun run test:tokens`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { App, cleanProfile } from './cdp'
import { check, expect, finish } from './checks'
import { BridgeClient } from './mcp-client'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const CMD = process.platform === 'darwin' ? 4 : 2

const profile = cleanProfile()
mkdirSync(profile.workspace, { recursive: true })
const FILE = path.join(profile.workspace, 'Tokens.opendraw')
const fileId = 'tokens-file'
writeFileSync(
  FILE,
  JSON.stringify({
    format: 'opendraw',
    version: 1,
    id: fileId,
    name: 'Tokens',
    pages: [
      {
        id: 'page-1',
        name: 'Page 1',
        nodes: [
          {
            id: 'desktop',
            type: 'artboard',
            name: 'Desktop',
            style: { left: '0px', top: '0px', width: '800px', height: '600px', backgroundColor: '#ffffff', display: 'flex', gap: '20px', padding: '20px' },
            children: []
          }
        ]
      }
    ]
  })
)

const app = await App.launch(profile)
const client = await BridgeClient.start(path.join(profile.userData, 'mcp.json'))
const call = (name: string, args: object = {}) => client.call(name, { fileId, ...args })
const bg = (id: string) => app.eval<string>(`getComputedStyle(document.querySelector('[data-node-id="${id}"]')).backgroundColor`)
const center = async (selector: string) => {
  const r = await app.rect(selector)
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
}
const clickOn = async (selector: string) => {
  const { x, y } = await center(selector)
  await app.click(x, y)
  await sleep(40)
}

try {
  let boxA = ''
  let boxB = ''
  await check('create_tokens makes a color and an alias; a frame styled var(--color-primary) renders the token color', async () => {
    const results = await call('create_tokens', {
      tokens: [
        { type: 'color', name: '--color-primary', value: '#ff0000' },
        { type: 'color', name: '--color-accent', value: 'var(--color-primary)', description: 'Links and highlights' },
        { type: 'spacing', name: '--space-4', value: '16px' }
      ]
    })
    expect(results.every((r: any) => r.result === 'created'), JSON.stringify(results))
    await call('write_html', {
      targetNodeId: 'desktop',
      mode: 'insert-children',
      html: '<div layer-name="A" style="width: 100px; height: 100px; background-color: var(--color-primary)"></div><div layer-name="B" style="width: 100px; height: 100px; background-color: var(--color-accent); padding: var(--space-4)"></div>'
    })
    const found = await call('get_tree_summary', { nodeId: 'desktop' })
    const ids = [...String(found).matchAll(/\(([^)]+)\)/g)].map((m) => m[1])
    const info = await call('get_children', { nodeId: 'desktop' })
    boxA = info.children?.[0]?.id ?? info[0]?.id ?? ids[1]
    boxB = info.children?.[1]?.id ?? info[1]?.id ?? ids[2]
    const a = await bg(boxA)
    const b = await bg(boxB)
    expect(a === 'rgb(255, 0, 0)' && b === 'rgb(255, 0, 0)', `A ${a}, B ${b}`)
    return `A ${a}; alias B ${b}`
  })

  await check('set_tokens changing the color re-renders every layer using it, in one undo step', async () => {
    const results = await call('set_tokens', { tokens: [{ name: '--color-primary', value: '#0000ff' }] })
    expect(results[0].result === 'updated', JSON.stringify(results))
    await sleep(50)
    const after = [await bg(boxA), await bg(boxB)]
    expect(after.every((c) => c === 'rgb(0, 0, 255)'), `after ${after}`)
    await app.key('z', 'KeyZ', CMD, 90)
    await sleep(50)
    const undone = [await bg(boxA), await bg(boxB)]
    expect(undone.every((c) => c === 'rgb(255, 0, 0)'), `undone ${undone}`)
    await app.key('z', 'KeyZ', CMD | 8, 90)
    await sleep(50)
    return `blue on both, one undo back to red`
  })

  await check('Renaming --color-primary to --color-brand rewrites references in styles and aliases', async () => {
    const results = await call('set_tokens', { tokens: [{ name: '--color-primary', newName: '--color-brand' }] })
    expect(results[0].result === 'updated' && results[0].newName === '--color-brand', JSON.stringify(results))
    const { tokens } = await call('get_tokens')
    const accent = tokens.find((t: any) => t.name === '--color-accent')
    // get_node_info carries no styles (as in Paper); get_jsx and the stored style show the reference.
    const style = JSON.stringify([await call('get_jsx', { nodeId: boxA }), await app.eval(`JSON.stringify(window.opendrawStore.getState().document)`)])
    expect(accent.value === 'var(--color-brand)', `alias ${accent.value}`)
    expect(style.includes('var(--color-brand)') && !style.includes('--color-primary'), style.slice(0, 300))
    expect((await bg(boxA)) === 'rgb(0, 0, 255)', 'render broke after rename')
    return `alias -> ${accent.value}; A uses var(--color-brand)`
  })

  await check('get_tokens returns JSON, a :root block and a Tailwind @theme block; namePattern filters', async () => {
    const json = await call('get_tokens')
    const css = await call('get_tokens', { format: 'css' })
    const tw = await call('get_tokens', { format: 'tailwind' })
    const colors = await call('get_tokens', { namePattern: '--color-*' })
    const spacing = await call('get_tokens', { types: ['spacing'] })
    expect(json.tokens.length === 3, `json ${JSON.stringify(json)}`)
    expect(css.startsWith(':root {') && css.includes('--color-brand: #0000ff;') && css.includes('--color-accent: var(--color-brand);'), css)
    expect(tw.startsWith('@theme {') && tw.includes('--color-brand: #0000ff;') && tw.includes('--spacing-space-4: 16px;'), tw)
    expect(colors.tokens.map((t: any) => t.name).join() === '--color-brand,--color-accent', JSON.stringify(colors))
    expect(spacing.tokens.length === 1, JSON.stringify(spacing))
    return `${css.split('\n').length} css lines; tailwind ${tw.replace(/\n/g, ' ')}`
  })

  await check('get_jsx shows var(--color-brand); get_computed_styles shows the resolved color', async () => {
    const jsx = await call('get_jsx', { nodeId: boxA })
    const computed = await call('get_computed_styles', { nodeIds: [boxA, boxB] })
    expect(String(jsx).includes('var(--color-brand)'), String(jsx))
    const a = computed[boxA].backgroundColor
    const b = computed[boxB].backgroundColor
    expect(a === 'rgb(0, 0, 255)' && b === 'rgb(0, 0, 255)', `computed ${a} ${b}`)
    expect(computed[boxB].paddingTop === '16px', `padding ${computed[boxB].paddingTop}`)
    return `jsx keeps var(); computed ${a}, padding ${computed[boxB].paddingTop}`
  })

  await check('Invalid entries are rejected in-band while the others are created', async () => {
    const results = await call('create_tokens', {
      tokens: [
        { type: 'color', name: '--color-bad', value: 'not-a-color' },
        { type: 'radius', name: '--radius-2', value: '4' },
        { type: 'fontWeight', name: '--weight-bold', value: 700 },
        { type: 'opacity', name: '--fade', value: 1.5 },
        { type: 'color', name: 'no-dashes', value: '#fff' },
        { type: 'radius', name: '--radius-1', value: '4px' }
      ]
    })
    const outcome = results.map((r: any) => r.result).join(',')
    expect(outcome === 'error,error,created,error,error,created', `${outcome}: ${JSON.stringify(results)}`)
    return results.filter((r: any) => r.result === 'error').map((r: any) => r.message).join(' | ')
  })

  await check('Deleting a token still in use is allowed and lists its users', async () => {
    const results = await call('set_tokens', { tokens: [{ name: '--space-4', delete: true }] })
    expect(results[0].result === 'deleted' && results[0].stillReferencedBy?.nodes.includes(boxB), JSON.stringify(results))
    await app.key('z', 'KeyZ', CMD, 90)
    await sleep(50)
    return JSON.stringify(results[0].stillReferencedBy)
  })

  await check('Tokens panel: editing a value updates the canvas; picking a token in a color field writes var(--name)', async () => {
    await clickOn('[data-testid="tab-tokens"]')
    await app.waitFor(`document.querySelector('[data-token="--color-brand"]') !== null`)
    await clickOn('[data-token="--color-brand"]')
    await app.waitFor(`document.querySelector('[data-testid="token-value"]') !== null`)
    await app.eval(`(() => { const i = document.querySelector('[data-testid="token-value"]'); i.focus(); i.select(); return true })()`)
    await app.type('#00ff00')
    await app.key('Enter', 'Enter', 0, 13)
    await sleep(80)
    const a = await bg(boxA)
    expect(a === 'rgb(0, 255, 0)', `canvas ${a}`)

    // Select the artboard and give it the accent token through the styles panel.
    await app.eval(`(window.opendrawStore.select(['desktop']), true)`)
    await app.waitFor(`document.querySelector('[data-field="backgroundColor"] [data-testid="token-button"]') !== null`)
    await clickOn('[data-field="backgroundColor"] [data-testid="token-button"]')
    await clickOn('[data-testid="token-menu"] [data-token="--color-accent"]')
    await sleep(80)
    const stored = await app.eval<string>(`window.opendrawStore.getState().document.pages[0].nodes[0].style.backgroundColor`)
    const chip = await app.eval<string>(`document.querySelector('[data-field="backgroundColor"] [data-testid="token-chip"]')?.textContent ?? ''`)
    const desktop = await bg('desktop')
    expect(stored === 'var(--color-accent)' && chip.startsWith('color-accent') && desktop === 'rgb(0, 255, 0)', `stored ${stored}, chip ${chip}, bg ${desktop}`)
    return `edited to #00ff00 on canvas; artboard backgroundColor ${stored}, field shows ${chip.replace('×', '')}`
  })

  await check('Tokens are saved with the file', async () => {
    await sleep(800)
    const saved = JSON.parse(readFileSync(FILE, 'utf8'))
    const names = (saved.tokens ?? []).map((t: any) => t.name)
    expect(names.includes('--color-brand') && names.includes('--color-accent'), `saved ${names}`)
    return `saved ${names.join(', ')}`
  })
} finally {
  client.close()
  await app.kill()
}

await finish('tokens')
