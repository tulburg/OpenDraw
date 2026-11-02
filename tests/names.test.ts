// End-to-end acceptance checks for S-27 (OpenDraw names for the clone tag and the instructions guide,
// with Paper's names kept as aliases, D-10). Run with `bun run test:names`.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { App, cleanProfile } from './cdp'
import { check, expect, finish } from './checks'
import { BridgeClient } from './mcp-client'

const profile = cleanProfile()
mkdirSync(profile.workspace, { recursive: true })
const fileId = 'names-file'
writeFileSync(
  path.join(profile.workspace, 'Names.opendraw'),
  JSON.stringify({
    format: 'opendraw',
    version: 1,
    id: fileId,
    name: 'Names',
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
              {
                id: 'card',
                type: 'frame',
                name: 'Card',
                style: { width: '200px', padding: '12px', backgroundColor: '#ddeeff' },
                children: [{ id: 'title', type: 'text', name: 'Title', text: 'Card title', style: { fontSize: '18px' }, children: [] }]
              }
            ]
          }
        ]
      }
    ]
  })
)

const app = await App.launch(profile, 9371)
const client = await BridgeClient.start(path.join(profile.userData, 'mcp.json'))
const ids = (nodes: any[]): string[] => nodes.flatMap((n) => [n.id, ...ids(n.children ?? [])])
const desktopChildren = () => app.eval<any[]>(`window.opendrawStore.getState().document.pages[0].nodes[0].children`)

try {
  await check('write_html with <x-opendraw-clone> and with <x-paper-clone> both insert a copy with new IDs', async () => {
    const results: string[] = []
    for (const tag of ['x-opendraw-clone', 'x-paper-clone']) {
      const before = await desktopChildren()
      const made = await client.call('write_html', { fileId, targetNodeId: 'desktop', mode: 'insert-children', html: `<${tag} node-id="card" layer-name="${tag}"></${tag}>` })
      const after = await desktopChildren()
      const copy = after.find((n) => n.id === made.created?.[0]?.id)
      expect(after.length === before.length + 1 && !!copy, `${tag}: ${before.length} -> ${after.length} layers`)
      expect(copy.name === tag && copy.children[0]?.text === 'Card title', `${tag}: ${JSON.stringify(copy).slice(0, 160)}`)
      expect(!ids([copy]).some((id) => ['card', 'title'].includes(id)), `${tag}: the copy reuses IDs`)
      results.push(tag)
    }
    const bad = await client.callRaw('write_html', { fileId, targetNodeId: 'desktop', mode: 'insert-children', html: '<x-opendraw-clone node-id="missing"></x-opendraw-clone>' })
    const message = bad.content?.[0]?.text ?? ''
    expect(bad.isError && message.includes('x-opendraw-clone') && !message.includes('x-paper-clone'), message)
    return `${results.join(' and ')} each inserted a copy with new IDs; a missing ID fails naming <x-opendraw-clone>`
  })

  await check('get_guide returns the same text for opendraw-mcp-instructions and paper-mcp-instructions', async () => {
    const ours = await client.callRaw('get_guide', { topic: 'opendraw-mcp-instructions' })
    const alias = await client.callRaw('get_guide', { topic: 'paper-mcp-instructions' })
    const text = ours.content[0].text as string
    expect(!ours.isError && text.includes('get_basic_info'), text.slice(0, 200))
    expect(!alias.isError && alias.content[0].text === text, 'the alias returned different text')
    expect(text.includes('x-opendraw-clone') && !text.includes('x-paper-clone') && !text.includes('paper-mcp-instructions'), 'the guide still uses the Paper names')
    const unknown = (await client.callRaw('get_guide', { topic: 'figma-import' })).content[0].text as string
    expect(unknown.includes('opendraw-mcp-instructions') && !unknown.includes('paper-mcp-instructions'), unknown)
    return `same ${text.length} chars for both topics; unknown-topic error lists only OpenDraw topics`
  })

  await check('tools/list descriptions and the server instructions contain no Paper clone tag or guide name', async () => {
    const init = client.initialized
    const tools = (await client.request('tools/list')).tools as unknown[]
    const text = `${init.instructions ?? ''}\n${JSON.stringify(tools)}`
    expect(!!init.instructions, 'no server instructions')
    const found = ['x-paper-clone', 'paper-mcp-instructions'].filter((name) => text.includes(name))
    expect(found.length === 0, `still mentions ${found.join(', ')}`)
    expect(text.includes('opendraw-mcp-instructions') && text.includes('x-opendraw-clone'), 'the OpenDraw names are missing')
    return `${tools.length} tool descriptions and the instructions use only the OpenDraw names`
  })
} finally {
  client.close()
  await app.kill()
}

await finish('names')
