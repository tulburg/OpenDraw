// End-to-end acceptance checks for S-16 (comment threads): the Comment tool, pins and popover,
// the Comments panel, and Paper's comment tools. Run with `bun run test:comments`.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { App, cleanProfile } from './cdp'
import { check, expect, finish } from './checks'
import { BridgeClient } from './mcp-client'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const profile = cleanProfile()
mkdirSync(profile.workspace, { recursive: true })
const FILE = path.join(profile.workspace, 'Comments.opendraw')
const fileId = 'comments-file'
writeFileSync(
  FILE,
  JSON.stringify({
    format: 'opendraw',
    version: 1,
    id: fileId,
    name: 'Comments',
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
              { id: 'card', type: 'frame', name: 'Card', style: { position: 'absolute', left: '100px', top: '100px', width: '200px', height: '100px', backgroundColor: '#dddddd' }, children: [] },
              { id: 'other', type: 'frame', name: 'Other', style: { position: 'absolute', left: '400px', top: '300px', width: '100px', height: '100px', backgroundColor: '#bbbbbb' }, children: [] }
            ]
          }
        ]
      },
      { id: 'page-2', name: 'Page 2', nodes: [] }
    ]
  })
)

let app = await App.launch(profile)
let client = await BridgeClient.start(path.join(profile.userData, 'mcp.json'))
const call = (name: string, args: object = {}) => client.call(name, { fileId, ...args })
const center = async (selector: string) => {
  const r = await app.rect(selector)
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
}
const clickOn = async (selector: string) => {
  const { x, y } = await center(selector)
  await app.click(x, y)
  await sleep(60)
}
const exists = (selector: string) => app.eval<boolean>(`document.querySelector(${JSON.stringify(selector)}) !== null`)
const pinRect = (id: string) => app.rect(`[data-comment-pin="${id}"]`)

/** Adds a thread straight through the store, as another author might have. */
const addThread = (args: object) =>
  app.eval<string>(`window.opendrawStore.transact('x', (tx) => tx.addThread(${JSON.stringify(args)}))`)

try {
  let threadId = ''
  await check('The Comment tool pins a thread to a layer; replying and resolving work, and it survives a restart', async () => {
    await app.key('c', 'KeyC')
    expect(await exists('.tool-button[data-tool="comment"][data-active]'), 'comment tool not active')
    const card = await app.rect('[data-node-id="card"]')
    await app.click(card.x + 30, card.y + 20)
    await app.waitFor(`document.querySelector('[data-testid="comment-name"]') !== null`)
    await clickOn('[data-testid="comment-name"]')
    await app.type('Dana')
    await clickOn('[data-testid="comment-input"]')
    await app.type('Make the title bigger')
    await clickOn('[data-testid="comment-submit"]')
    await app.waitFor(`document.querySelector('.comment-pin[data-comment-pin]') !== null`)
    threadId = await app.eval<string>(`document.querySelector('.comment-pin[data-comment-pin]').dataset.commentPin`)
    const stored = await app.eval<any>(`window.opendrawStore.getState().document.comments[0]`)
    expect(stored.nodeId === 'card' && Math.abs(stored.x - 30) <= 2 && Math.abs(stored.y - 20) <= 2, JSON.stringify(stored))
    await clickOn('[data-testid="comment-input"]')
    await app.type('And darker')
    await app.key('Enter', 'Enter', 0, 13)
    await app.waitFor(`document.querySelectorAll('[data-testid="comment-message"]').length === 2`)
    await clickOn('[data-testid="comment-resolve"]')
    await sleep(100)
    const status = await app.eval<string>(`window.opendrawStore.getState().document.comments[0].status`)
    await app.key('Escape', 'Escape', 0, 27)
    await sleep(100)
    const pinGone = !(await exists(`[data-comment-pin="${threadId}"]`))
    expect(status === 'resolved' && pinGone, `status ${status}, pin gone ${pinGone}`)
    await sleep(800)
    client.close()
    await app.close()
    app = await App.launch(profile)
    client = await BridgeClient.start(path.join(profile.userData, 'mcp.json'))
    const thread = await call('get_comment_thread', { commentThreadId: threadId })
    expect(
      thread.status === 'resolved' && thread.messages.length === 2 && thread.messages.every((m: any) => m.authorName === 'Dana' && m.authorUserId === 'local-user' && m.createdAt),
      JSON.stringify(thread)
    )
    expect(thread.node?.id === 'card' && thread.page?.id === 'page-1', JSON.stringify(thread))
    return `${thread.messages.length} messages, ${thread.status}, pinned to ${thread.node.name}`
  })

  const ids: Record<string, string> = {}
  await check('list_comment_threads: open by default; status, nodeId, search, currentPageOnly, limit and offset filter', async () => {
    await call('set_comment_thread_status', { commentThreadId: threadId, status: 'open' })
    const agent = { id: 'reviewer-1', name: 'Riley' }
    const local = { id: 'local-user', name: 'Dana' }
    ids.other = await addThread({ pageId: 'page-1', nodeId: 'other', x: 5, y: 5, text: 'Spacing looks off here', author: agent })
    ids.point = await addThread({ pageId: 'page-1', x: 600, y: 50, text: 'Needs a footer', author: agent })
    ids.page2 = await addThread({ pageId: 'page-2', x: 0, y: 0, text: 'Second page note', author: agent })
    ids.resolved = await addThread({ pageId: 'page-1', x: 10, y: 500, text: 'Old feedback', author: local })
    await app.eval(`window.opendrawStore.transact('x', (tx) => tx.setThreadStatus(${JSON.stringify(ids.resolved)}, 'resolved'))`)
    await app.eval(`window.opendrawStore.transact('x', (tx) => tx.reply(${JSON.stringify(ids.other)}, 'Agreed', ${JSON.stringify(local)}))`)
    const deleted = await addThread({ pageId: 'page-1', x: 1, y: 1, text: 'Deleted one', author: local })
    await app.eval(`window.opendrawStore.transact('x', (tx) => tx.deleteThread(${JSON.stringify(deleted)}))`)

    const open = await call('list_comment_threads')
    expect(open.total === 4 && open.threads.every((t: any) => t.status === 'open'), `open ${JSON.stringify(open)}`)
    const all = await call('list_comment_threads', { status: 'all' })
    expect(all.total === 5 && !all.threads.some((t: any) => t.commentThreadId === deleted), `all ${all.total}`)
    const byNode = await call('list_comment_threads', { nodeId: 'other' })
    expect(byNode.total === 1 && byNode.threads[0].commentThreadId === ids.other && byNode.threads[0].replyCount === 1, JSON.stringify(byNode))
    const search = await call('list_comment_threads', { search: 'agreed' })
    const searchFirst = await call('list_comment_threads', { search: 'agreed', searchScope: 'first-message' })
    expect(search.total === 1 && searchFirst.total === 0, `search ${search.total}, first-message ${searchFirst.total}`)
    const current = await call('list_comment_threads', { currentPageOnly: true })
    expect(current.total === 3 && current.threads.every((t: any) => t.pageId === 'page-1'), `current ${current.total}`)
    const first = await call('list_comment_threads', { limit: 2 })
    const second = await call('list_comment_threads', { limit: 2, offset: 2 })
    const seen = [...first.threads, ...second.threads].map((t: any) => t.commentThreadId)
    expect(first.threads.length === 2 && first.nextOffset === 2 && second.threads.length === 2 && new Set(seen).size === 4, `pages ${JSON.stringify(seen)}`)
    const byPage = open.threads.map((t: any) => t.pageId)
    expect(byPage[byPage.length - 1] === 'page-2', `page order ${byPage}`)
    const preview = await call('list_comment_threads', { previewLength: 20, search: 'spacing' })
    expect(preview.threads[0].preview === 'Spacing looks off he...', preview.threads[0].preview)
    return `open ${open.total}, all ${all.total}, current page ${current.total}`
  })

  await check('get_comment_thread returns every message; set_comment_thread_status resolving removes the pin, and undo brings it back', async () => {
    const thread = await call('get_comment_thread', { commentThreadId: ids.other })
    expect(thread.messages.length === 2 && thread.messages[0].authorName === 'Riley' && thread.messages[1].authorName === 'Dana', JSON.stringify(thread.messages))
    expect(await exists(`[data-comment-pin="${ids.other}"]`), 'pin missing before resolve')
    const result = await call('set_comment_thread_status', { commentThreadId: ids.other, status: 'resolved' })
    await sleep(100)
    const gone = !(await exists(`[data-comment-pin="${ids.other}"]`))
    expect(result.status === 'resolved' && gone, `${JSON.stringify(result)}, gone ${gone}`)
    await app.key('z', 'KeyZ', process.platform === 'darwin' ? 4 : 2)
    await sleep(100)
    const back = await exists(`[data-comment-pin="${ids.other}"]`)
    const status = (await call('get_comment_thread', { commentThreadId: ids.other })).status
    expect(back && status === 'open', `pin back ${back}, status ${status}`)
    const missing = await client.callRaw('set_comment_thread_status', { fileId, commentThreadId: 'nope', status: 'resolved' })
    expect(missing.isError, 'missing thread did not error')
    return `${thread.messages.length} messages; undo reopened it`
  })

  await check('participantUserId current-user matches threads the local user wrote in; list_comment_thread_authors counts them', async () => {
    const mine = await call('list_comment_threads', { participantUserId: 'current-user', status: 'all' })
    const started = await call('list_comment_threads', { threadAuthorUserId: 'current-user', status: 'all' })
    const mineIds = mine.threads.map((t: any) => t.commentThreadId).sort()
    expect(JSON.stringify(mineIds) === JSON.stringify([threadId, ids.other, ids.resolved].sort()), `participant ${mineIds}`)
    expect(started.total === 2, `started ${started.total}`)
    const { authors, currentUserId } = await call('list_comment_thread_authors')
    const dana = authors.find((a: any) => a.userId === 'local-user')
    const riley = authors.find((a: any) => a.userId === 'reviewer-1')
    expect(currentUserId === 'local-user', currentUserId)
    expect(dana?.threadCount === 2 && dana.messageCount === 4 && dana.displayName === 'Dana' && dana.lastActivityAt, JSON.stringify(dana))
    expect(riley?.threadCount === 3 && riley.messageCount === 3, JSON.stringify(riley))
    const page2 = await call('list_comment_thread_authors', { pageId: 'page-2' })
    expect(page2.authors.length === 1 && page2.authors[0].userId === 'reviewer-1', JSON.stringify(page2))
    return `Dana ${dana.threadCount} threads / ${dana.messageCount} messages, Riley ${riley.threadCount} / ${riley.messageCount}`
  })

  await check('The Comments panel lists threads by page, filters and searches; clicking one selects its layer and opens it', async () => {
    await clickOn('[data-testid="tab-comments"]')
    const rows = () => app.eval<number>(`document.querySelectorAll('[data-comment-thread-row]').length`)
    const openRows = await rows()
    await clickOn('[data-testid="comments-filter-all"]')
    const allRows = await rows()
    await clickOn('[data-testid="comments-filter-resolved"]')
    const resolvedRows = await rows()
    await clickOn('[data-testid="comments-filter-open"]')
    await clickOn('[data-testid="comments-search"]')
    await app.type('spacing')
    await sleep(50)
    const searched = await rows()
    expect(openRows === 4 && allRows === 5 && resolvedRows === 1 && searched === 1, `open ${openRows}, all ${allRows}, resolved ${resolvedRows}, searched ${searched}`)
    await clickOn(`[data-comment-thread-row="${ids.other}"]`)
    await sleep(100)
    const selection = await app.eval<string[]>(`window.opendrawStore.getState().selection`)
    const popover = await app.eval<string>(`document.querySelector('.comment-popover .comment-thread')?.dataset.threadId ?? ''`)
    expect(selection.join() === 'other' && popover === ids.other, `selection ${selection}, popover ${popover}`)
    await app.key('Escape', 'Escape', 0, 27)
    // A thread on another page switches to it.
    await clickOn('[data-testid="comments-search"]')
    await app.eval(`(() => { const i = document.querySelector('[data-testid="comments-search"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await sleep(50)
    await clickOn(`[data-comment-thread-row="${ids.page2}"]`)
    await sleep(100)
    const page = await app.eval<string>(`window.opendrawStore.getState().pageId`)
    expect(page === 'page-2', `page ${page}`)
    await app.key('Escape', 'Escape', 0, 27)
    await app.eval(`window.opendrawStore.setPage('page-1')`)
    await sleep(200)
    return `${openRows} open, ${allRows} all, ${resolvedRows} resolved`
  })

  await check('The name is asked once and changes in the top bar popover; new replies use it', async () => {
    expect((await app.eval<string>(`document.querySelector('[data-testid="user-button"]').textContent`)) === 'D', 'avatar not D')
    await clickOn('[data-testid="user-button"]')
    await app.waitFor(`document.querySelector('[data-testid="user-name"]') !== null`)
    await app.eval(`document.querySelector('[data-testid="user-name"]').select()`)
    await app.type('Dana Q')
    await clickOn('[data-testid="user-save"]')
    await clickOn(`[data-comment-pin="${threadId}"]`)
    const asksName = await exists('[data-testid="comment-name"]')
    await clickOn('[data-testid="comment-input"]')
    await app.type('Renamed reply')
    await app.key('Enter', 'Enter', 0, 13)
    await sleep(100)
    await app.screenshot(path.join(import.meta.dir, 'results', 'comments-popover.png'))
    await app.key('Escape', 'Escape', 0, 27)
    const thread = await call('get_comment_thread', { commentThreadId: threadId })
    const last = thread.messages[thread.messages.length - 1]
    expect(!asksName && last.authorName === 'Dana Q' && last.text === 'Renamed reply', `asks ${asksName}, ${JSON.stringify(last)}`)
    return `last reply by ${last.authorName}`
  })

  await check('Moving a layer moves its pins; deleting it keeps the thread at the old position', async () => {
    await app.key('Escape', 'Escape', 0, 27)
    const before = await pinRect(threadId)
    const zoom = await app.eval<number>(`Number(document.querySelector('.canvas-world').dataset.zoom) || 1`)
    await call('update_styles', { updates: [{ nodeIds: ['card'], styles: { left: '160px', top: '140px' } }] })
    await sleep(150)
    const moved = await pinRect(threadId)
    const dx = (moved.x - before.x) / zoom
    const dy = (moved.y - before.y) / zoom
    expect(Math.abs(dx - 60) < 1.5 && Math.abs(dy - 40) < 1.5, `moved by ${dx}, ${dy}`)
    await call('delete_nodes', { nodeIds: ['card'] })
    await sleep(150)
    const after = await pinRect(threadId)
    const thread = await app.eval<any>(`window.opendrawStore.getState().document.comments.find((t) => t.id === ${JSON.stringify(threadId)})`)
    expect(Math.abs(after.x - moved.x) < 1.5 && Math.abs(after.y - moved.y) < 1.5, `pin jumped from ${moved.x},${moved.y} to ${after.x},${after.y}`)
    expect(!thread.nodeId && Math.abs(thread.x - 190) <= 2 && Math.abs(thread.y - 160) <= 2 && Number.isInteger(thread.x), JSON.stringify(thread))
    const listed = await call('list_comment_threads', { search: 'title bigger' })
    expect(listed.total === 1 && !listed.threads[0].nodeId, JSON.stringify(listed))
    return `pin followed by ${dx.toFixed(1)}, ${dy.toFixed(1)}; kept at ${thread.x}, ${thread.y} after delete`
  })
} finally {
  client.close()
  await app.kill()
}

await finish('comments')
