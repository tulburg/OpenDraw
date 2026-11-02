// End-to-end acceptance checks for S-13 (files, folders and resources): the file browser, tabs and
// Paper's resource tools. Run with `bun run test:resources`.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { App, cleanProfile } from './cdp'
import { check, expect, finish } from './checks'
import { BridgeClient } from './mcp-client'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const profile = cleanProfile()
mkdirSync(profile.workspace, { recursive: true })
const MAIN = 'file-main'
writeFileSync(
  path.join(profile.workspace, 'Main.opendraw'),
  JSON.stringify({
    format: 'opendraw',
    version: 1,
    id: MAIN,
    name: 'Main',
    pages: [
      {
        id: 'page-1',
        name: 'Page 1',
        nodes: [
          {
            id: 'desktop',
            type: 'artboard',
            name: 'Desktop',
            style: { left: '0px', top: '0px', width: '1440px', height: '900px', backgroundColor: '#ffffff', display: 'flex' },
            children: [{ id: 'title', type: 'text', name: 'Title', style: { fontSize: '32px' }, text: 'Hello', children: [] }]
          }
        ]
      }
    ]
  })
)

let app = await App.launch(profile)
let client = await BridgeClient.start(path.join(profile.userData, 'mcp.json'))
const list = async (args: object = {}) => (await client.call('list_resources', args)) as { items: any[]; truncated?: boolean }
const activeTab = () => app.eval<string | null>(`document.querySelector('[data-testid="tab"].active')?.dataset.fileId ?? null`)
const tabIds = () => app.eval<string[]>(`[...document.querySelectorAll('[data-testid="tab"]')].map((t) => t.dataset.fileId)`)
const center = async (selector: string) => {
  const r = await app.rect(selector)
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
}
const walkIds = (doc: any) => {
  const ids: string[] = []
  const visit = (nodes: any[]) => nodes.forEach((n) => (ids.push(n.id), visit(n.children)))
  doc.pages.forEach((p: any) => (ids.push(p.id), visit(p.nodes)))
  return ids
}

try {
  await app.waitFor(`document.querySelector('[data-testid="tab"]') !== null`)

  await check('The workspace gets an index with stable IDs; the existing file keeps its ID', async () => {
    const { items } = await list()
    const main = items.find((i) => i.id === MAIN)
    expect(main?.type === 'file' && main.name === 'Main' && main.open && main.active, `main: ${JSON.stringify(main)}`)
    expect(existsSync(path.join(profile.workspace, '.opendraw-index.json')), 'no index file')
    return `list_resources: ${JSON.stringify(main)}`
  })

  let browserFolder = ''
  await check('Browser: a folder and a file in it show up in list_resources with the right parentId and on disk', async () => {
    let p = await center('[data-testid="home-button"]')
    await app.click(p.x, p.y)
    await app.waitFor(`document.querySelector('[data-testid="file-browser"]') !== null`)
    p = await center('[data-testid="new-folder"]')
    await app.click(p.x, p.y)
    await app.waitFor(`document.querySelector('[data-resource-type="folder"]') !== null`)
    browserFolder = await app.eval<string>(`document.querySelector('[data-resource-type="folder"]').dataset.resourceId`)
    p = await center(`[data-resource-id="${browserFolder}"] .thumb`)
    await app.clickWith(p.x, p.y, 0, 2)
    await app.waitFor(`document.querySelector('[data-testid="breadcrumbs"]').textContent.includes('Untitled project')`)
    p = await center('[data-testid="new-file"]')
    await app.click(p.x, p.y)
    // A new file opens in a tab in front.
    await app.waitFor(`document.querySelectorAll('[data-testid="tab"]').length === 2 && !document.querySelector('[data-testid="file-browser"]')`)
    const newId = await activeTab()
    const { items } = await list({ parentId: browserFolder })
    const file = items.find((i) => i.id === newId)
    expect(file?.parentId === browserFolder && file.name === 'Untitled', `file: ${JSON.stringify(file)}`)
    expect(existsSync(path.join(profile.workspace, 'Untitled project', 'Untitled.opendraw')), 'not on disk')
    return `folder ${browserFolder} with ${file.name} (open in tab ${newId})`
  })

  await check('Browser: renaming and archiving work, and the Archive view restores', async () => {
    let p = await center('[data-testid="home-button"]')
    await app.click(p.x, p.y)
    await app.waitFor(`document.querySelector('[data-resource-id="${browserFolder}"]') !== null`)
    p = await center(`[data-resource-id="${browserFolder}"] [data-testid="resource-name"]`)
    await app.clickWith(p.x, p.y, 0, 2)
    await app.waitFor(`document.querySelector('[data-testid="rename-input"]') !== null`)
    await app.type('Client work')
    await app.key('Enter', 'Enter', 0, 13)
    await app.waitFor(`document.querySelector('[data-resource-id="${browserFolder}"] [data-testid="resource-name"]')?.textContent === 'Client work'`)
    expect(existsSync(path.join(profile.workspace, 'Client work', 'Untitled.opendraw')), 'folder not renamed on disk')
    await app.eval(`(() => { document.querySelector('[data-resource-id="${browserFolder}"] [data-testid="archive"]').style.visibility = 'visible'; return true })()`)
    p = await center(`[data-resource-id="${browserFolder}"] [data-testid="archive"]`)
    await app.click(p.x, p.y)
    await app.waitFor(`!document.querySelector('[data-resource-id="${browserFolder}"]')`)
    p = await center('[data-testid="browser-archive"]')
    await app.click(p.x, p.y)
    await app.waitFor(`document.querySelector('[data-resource-id="${browserFolder}"]') !== null`)
    await app.eval(`(() => { document.querySelector('[data-resource-id="${browserFolder}"] [data-testid="restore"]').style.visibility = 'visible'; return true })()`)
    p = await center(`[data-resource-id="${browserFolder}"] [data-testid="restore"]`)
    await app.click(p.x, p.y)
    await app.waitFor(`!document.querySelector('[data-resource-id="${browserFolder}"]')`)
    const { items } = await list()
    expect(items.some((i) => i.id === browserFolder && !i.archived), 'folder not restored')
    p = await center('[data-testid="browser-all"]')
    await app.click(p.x, p.y)
    return 'renamed to "Client work" on disk, archived, restored from the Archive view'
  })

  let folderA = ''
  let folderB = ''
  let fileA = ''
  await check('create_folder and create_file land in list_resources with the right parentId, and on disk', async () => {
    const a = await client.call('create_folder', { name: '  Agents  ' })
    const b = await client.call('create_folder', { parentId: a.id })
    const f = await client.call('create_file', { name: 'Landing', parentId: a.id })
    folderA = a.id
    folderB = b.id
    fileA = f.id
    expect(a.name === 'Agents' && b.name === 'Untitled project' && b.parentId === a.id, `${JSON.stringify(a)} ${JSON.stringify(b)}`)
    expect(f.name === 'Landing' && f.parentId === a.id, JSON.stringify(f))
    const inA = (await list({ parentId: a.id })).items.map((i) => i.name).sort()
    expect(JSON.stringify(inA) === JSON.stringify(['Landing', 'Untitled project']), `in Agents: ${inA}`)
    expect(existsSync(path.join(profile.workspace, 'Agents', 'Landing.opendraw')), 'Landing not on disk')
    expect(existsSync(path.join(profile.workspace, 'Agents', 'Untitled project')), 'subfolder not on disk')
    const long = await client.call('create_folder', { name: 'x'.repeat(600) })
    expect(long.name.length === 500, `long name kept ${long.name.length} chars`)
    expect((await list()).items.find((i) => i.id === long.id)?.name.length === 500, 'long name lost on rescan')
    await client.call('archive_resources', { resourceIds: [long.id] })
    return `Agents/{Landing, Untitled project}; a 600-char name stored as ${long.name.length}`
  })

  await check('create_file with cloneFileId copies pages and nodes with new IDs', async () => {
    const copy = await client.call('create_file', { name: 'Main copy', cloneFileId: MAIN })
    const source = JSON.parse(readFileSync(path.join(profile.workspace, 'Main.opendraw'), 'utf8'))
    const cloned = JSON.parse(readFileSync(path.join(profile.workspace, 'Main copy.opendraw'), 'utf8'))
    const a = walkIds(source)
    const b = walkIds(cloned)
    expect(cloned.id === copy.id && copy.id !== MAIN, `ids ${copy.id}`)
    expect(a.length === b.length && b.every((id) => !a.includes(id)), `ids overlap or differ in count: ${a.length} vs ${b.length}`)
    expect(cloned.pages[0].nodes[0].children[0].text === 'Hello', 'content not copied')
    return `${b.length} pages and nodes copied, none sharing an ID`
  })

  await check('move_resources with one invalid ID moves nothing; valid IDs move, folder contents included', async () => {
    const target = await client.call('create_folder', { name: 'Archive me' })
    const bad = await client.callRaw('move_resources', { resourceIds: [folderA, 'nope'], parentId: target.id })
    expect(bad.isError, 'invalid move succeeded')
    expect(existsSync(path.join(profile.workspace, 'Agents', 'Landing.opendraw')), 'something moved')
    const moved = await client.call('move_resources', { resourceIds: [folderA], parentId: target.id })
    expect(moved.moved.length === 1 && moved.moved[0].parentId === target.id, JSON.stringify(moved))
    expect(existsSync(path.join(profile.workspace, 'Archive me', 'Agents', 'Landing.opendraw')), 'contents did not move')
    const inside = (await list({ parentId: folderA })).items.map((i) => i.id)
    expect(inside.includes(fileA) && inside.includes(folderB), 'IDs changed after the move')
    const again = await client.call('move_resources', { resourceIds: [folderA], parentId: target.id })
    expect(again.moved.length === 0 && again.alreadyInFolder?.length === 1, JSON.stringify(again))

    const renamed = await client.call('rename_resource', { resourceId: fileA, name: 'Landing v2' })
    const unchanged = await client.call('rename_resource', { resourceId: fileA, name: '   ' })
    expect(renamed.name === 'Landing v2' && renamed.type === 'file' && unchanged.name === 'Landing v2', JSON.stringify([renamed, unchanged]))
    expect(existsSync(path.join(profile.workspace, 'Archive me', 'Agents', 'Landing v2.opendraw')), 'rename not on disk')
    folderA = target.id
    return `bad move refused (${bad.content[0].text}); Agents moved with its contents; rename on disk`
  })

  await check('Archiving a folder hides it and its contents unless includeArchived; unarchiving restores them', async () => {
    await client.call('archive_resources', { resourceIds: [folderA] })
    const visible = (await list()).items.map((i) => i.id)
    expect(![folderA, folderB, fileA].some((id) => visible.includes(id)), 'archived items still listed')
    const all = (await list({ includeArchived: true })).items
    expect([folderA, folderB, fileA].every((id) => all.find((i) => i.id === id)?.archived), 'archived items missing with includeArchived')
    const bad = await client.callRaw('unarchive_resources', { resourceIds: [folderA, 'nope'] })
    expect(bad.isError && !(await list()).items.some((i) => i.id === folderA), 'partial unarchive')
    await client.call('unarchive_resources', { resourceIds: [folderA] })
    const back = (await list()).items.map((i) => i.id)
    expect([folderA, folderB, fileA].every((id) => back.includes(id)), 'not restored')
    return 'hidden while archived, listed with includeArchived, all back after unarchive'
  })

  await check('list_resources lists open files first and marks truncated when the limit cuts it', async () => {
    const { items } = await list()
    const open = items.filter((i) => i.open).map((i) => i.id)
    const tabs = await tabIds()
    expect(JSON.stringify(open) === JSON.stringify(tabs), `open ${open} vs tabs ${tabs}`)
    expect(items.slice(0, open.length).every((i) => i.open), 'open files not first')
    const short = await list({ limit: 2 })
    expect(short.items.length === 2 && short.truncated === true, JSON.stringify(short))
    return `${open.length} open files first; limit 2 truncated`
  })

  await check('open_file opens a second tab; write_html with its fileId edits it while the first tab stays in front', async () => {
    // Bring Main to the front first.
    let p = await center(`[data-testid="tab"][data-file-id="${MAIN}"]`)
    await app.click(p.x, p.y)
    await app.waitFor(`document.querySelector('[data-testid="tab"].active')?.dataset.fileId === '${MAIN}'`)
    const info = await client.call('open_file', { fileId: `opendraw://file/${fileA}` })
    expect(info.fileId === fileA && info.fileName === 'Landing v2', JSON.stringify(info).slice(0, 200))
    const artboard = info.artboards[0].id
    await client.call('write_html', { fileId: fileA, targetNodeId: artboard, mode: 'insert-children', html: '<div style="width: 50px; height: 50px; background: red" layer-name="Agent box"></div>' })
    expect((await activeTab()) === MAIN, `front tab ${await activeTab()}`)
    expect((await tabIds()).includes(fileA), 'no tab for the opened file')
    const found = await client.call('find_nodes', { fileId: fileA, filters: [{ styleName: 'width', styleValue: '50px' }] })
    const inMain = await client.call('find_nodes', { fileId: MAIN, filters: [{ styleName: 'width', styleValue: '50px' }] })
    expect(found.length === 1 && inMain.length === 0, `found ${found.length} in Landing, ${inMain.length} in Main`)
    const closed = await client.callRaw('get_basic_info', { fileId: 'file-not-open' })
    expect(closed.isError && /open_file/.test(closed.content[0].text), closed.content[0].text)
    await sleep(800)
    const onDisk = readFileSync(path.join(profile.workspace, 'Archive me', 'Agents', 'Landing v2.opendraw'), 'utf8')
    expect(onDisk.includes('Agent box'), 'background edit not saved')
    return `edited ${fileA} in the background; Main stayed in front; saved to disk`
  })

  await check('Tabs close and reorder', async () => {
    const before = await tabIds()
    await app.eval(`(() => {
      const tabs = [...document.querySelectorAll('[data-testid="tab"]')]
      const dt = new DataTransfer()
      tabs[0].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
      return true })()`)
    await sleep(50)
    await app.eval(`(() => {
      const tabs = [...document.querySelectorAll('[data-testid="tab"]')]
      const dt = new DataTransfer()
      const dst = tabs[tabs.length - 1]
      dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
      dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
      tabs[0].dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
      return true })()`)
    await sleep(100)
    const after = await tabIds()
    expect(after[after.length - 1] === before[0] && after.length === before.length, `${before} -> ${after}`)
    return `${before.join(', ')} -> ${after.join(', ')}`
  })

  let expectedTabs: string[] = []
  await check('Open tabs and the active tab are restored after a restart', async () => {
    expectedTabs = await tabIds()
    const active = await activeTab()
    client.close()
    await app.close()
    app = await App.launch(profile)
    client = await BridgeClient.start(path.join(profile.userData, 'mcp.json'))
    await app.waitFor(`document.querySelectorAll('[data-testid="tab"]').length === ${expectedTabs.length}`)
    const restored = await tabIds()
    expect(JSON.stringify(restored) === JSON.stringify(expectedTabs), `${restored} vs ${expectedTabs}`)
    expect((await activeTab()) === active, `active ${await activeTab()} vs ${active}`)
    return `${restored.length} tabs, ${active} in front`
  })

  await check('Files added on disk by hand are picked up', async () => {
    writeFileSync(
      path.join(profile.workspace, 'Dropped in.opendraw'),
      JSON.stringify({ format: 'opendraw', version: 1, id: 'dropped', name: 'Dropped in', pages: [{ id: 'p', name: 'Page 1', nodes: [] }] })
    )
    const { items } = await list()
    expect(items.some((i) => i.id === 'dropped' && i.name === 'Dropped in'), 'not picked up')
    const hidden = readdirSync(profile.workspace).filter((f) => f.startsWith('.'))
    return `picked up "Dropped in"; hidden files: ${hidden}`
  })
} finally {
  client.close()
  await app.kill()
}

await finish('resources')
