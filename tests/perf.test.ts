// Performance checks for S-21 on a generated 300-artboard, ~30,000-layer file: first paint, pan and
// zoom frame rates, dragging, typing latency, agent edits and the layers panel. Run with `bun run test:perf`.
import { mkdirSync } from 'node:fs'
import path from 'node:path'

import { App, cleanProfile } from './cdp'
import { check, expect, finish } from './checks'
import { BridgeClient } from './mcp-client'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const CMD = process.platform === 'darwin' ? 4 : 2
const FRAME_MS = 1000 / 60

const profile = cleanProfile()
mkdirSync(profile.workspace, { recursive: true })
const FILE = path.join(profile.workspace, 'Stress.opendraw')
const generated = Bun.spawnSync(['bun', path.join(import.meta.dir, '..', 'scripts', 'stress-file.ts'), FILE])
if (generated.exitCode !== 0) throw new Error(generated.stderr.toString())
const fileId = 'stress-file'

const started = performance.now()
const app = await App.launch(profile)
// App.launch returns once an artboard is in the DOM; wait for it to be painted.
await app.eval(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`)
const firstPaint = performance.now() - started
const client = await BridgeClient.start(path.join(profile.userData, 'mcp.json'))
const call = (name: string, args: object = {}) => client.call(name, { fileId, ...args })

const results: Record<string, number> = {}

/** Records frame intervals in the page while `drive` runs. */
async function frames(drive: () => Promise<void>): Promise<{ fps: number; worst: number; dropped: number; p95: number }> {
  await app.eval(`(() => { window.__frames = []; window.__sampling = true; const loop = (t) => { window.__frames.push(t); if (window.__sampling) requestAnimationFrame(loop) }; requestAnimationFrame(loop); return true })()`)
  await drive()
  const times = await app.eval<number[]>(`(() => { window.__sampling = false; return window.__frames })()`)
  const gaps = times.slice(1).map((t, i) => t - times[i])
  const span = times[times.length - 1] - times[0]
  const sorted = [...gaps].sort((a, b) => a - b)
  return {
    fps: (gaps.length / span) * 1000,
    worst: sorted[sorted.length - 1] ?? 0,
    p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    // Frames lost: each interval longer than one frame by half a frame or more counts the frames it skipped.
    dropped: gaps.reduce((sum, g) => sum + Math.max(0, Math.round(g / FRAME_MS) - 1), 0)
  }
}

const canvas = await app.rect('.canvas')
const mid = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 }
const wheel = async (count: number, dx: number, dy: number, modifiers = 0) => {
  for (let i = 0; i < count; i++) {
    await app.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: mid.x, y: mid.y, deltaX: dx, deltaY: dy, modifiers })
    await sleep(FRAME_MS)
  }
}
const zoomTo100 = async () => {
  await app.key('0', 'Digit0', CMD, 48)
  await sleep(300)
}
/** At 100%, pans so the nearest artboard's top left sits 40 px inside the canvas: zooming to 100% can land between artboards. */
const toArtboard = async () => {
  await zoomTo100()
  const delta = await app.eval<{ dx: number; dy: number }>(`(() => {
    const world = document.querySelector('.canvas-world').dataset
    const vx = Number(world.x), vy = Number(world.y)
    let best = null
    for (const el of document.querySelectorAll('[data-node-type="artboard"]')) {
      const dx = parseFloat(el.style.left) + vx - 40, dy = parseFloat(el.style.top) + vy - 40
      if (!best || Math.hypot(dx, dy) < Math.hypot(best.dx, best.dy)) best = { dx, dy }
    }
    return best
  })()`)
  await app.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: mid.x, y: mid.y, deltaX: delta.dx, deltaY: delta.dy })
  await sleep(400)
}

try {
  await check('The stress file opens with first paint under 3 s', async () => {
    const layers = await app.eval<number>(`document.querySelectorAll('[data-node-id]').length`)
    results.firstPaintMs = Math.round(firstPaint)
    expect(firstPaint < 3000, `first paint ${Math.round(firstPaint)} ms`)
    return `${Math.round(firstPaint)} ms (app start included); ${layers} layer elements in the DOM`
  })

  await check('Pan and zoom measure 50 fps or better', async () => {
    await zoomTo100()
    const pan = await frames(() => wheel(120, 12, 6))
    const zoom = await frames(async () => {
      await wheel(40, 0, 8, 2)
      await wheel(40, 0, -8, 2)
    })
    await app.key('!', 'Digit1', 8, 49)
    await sleep(500)
    const overview = await frames(() => wheel(90, 20, 10))
    Object.assign(results, { panFps: Math.round(pan.fps), zoomFps: Math.round(zoom.fps), overviewPanFps: Math.round(overview.fps) })
    expect(pan.fps >= 50 && zoom.fps >= 50, `pan ${pan.fps.toFixed(1)} fps (worst ${pan.worst.toFixed(0)} ms), zoom ${zoom.fps.toFixed(1)} fps (worst ${zoom.worst.toFixed(0)} ms)`)
    return `pan ${pan.fps.toFixed(1)} fps, zoom ${zoom.fps.toFixed(1)} fps at 100%; whole-file overview pan ${overview.fps.toFixed(1)} fps`
  })

  await check('Dragging a layer drops at most 2 frames over 2 s', async () => {
    await toArtboard()
    const target = await app.eval<{ x: number; y: number }>(`(() => { const c = document.querySelector('.canvas').getBoundingClientRect(); const els = [...document.querySelectorAll('[data-node-type="artboard"]')]; const el = els.find((e) => { const r = e.getBoundingClientRect(); return r.left > c.left && r.top > c.top && r.left < c.right - 200 && r.top < c.bottom - 200 }) ?? els[0]; const r = el.getBoundingClientRect(); return { x: r.left + 20, y: r.top + 20 } })()`)
    await app.mouseDown(target.x, target.y)
    const drag = await frames(async () => {
      for (let i = 1; i <= 120; i++) {
        await app.mouseMove(target.x + i, target.y + i / 2, 1)
        await sleep(FRAME_MS)
      }
    })
    await app.mouseUp(target.x + 120, target.y + 60)
    expect(await app.eval<boolean>(`window.opendrawStore.getState().canUndo`), 'the drag moved nothing')
    await app.eval(`(window.__moved = window.opendrawStore.getState().document), true`)
    await app.key('z', 'KeyZ', CMD, 90)
    await app.waitFor(`window.opendrawStore.getState().document !== window.__moved`)
    results.dragDropped = drag.dropped
    expect(drag.dropped <= 2, `${drag.dropped} frames dropped, worst ${drag.worst.toFixed(0)} ms`)
    return `${drag.dropped} dropped, worst frame ${drag.worst.toFixed(1)} ms, ${drag.fps.toFixed(1)} fps`
  })

  await check('Typing in a text layer paints within 32 ms', async () => {
    await toArtboard()
    const title = await app.eval<{ x: number; y: number; id: string }>(`(() => { const c = document.querySelector('.canvas').getBoundingClientRect(); const el = [...document.querySelectorAll('[data-node-type="text"]')].find((e) => { const r = e.getBoundingClientRect(); return r.width > 40 && r.left > c.left + 20 && r.top > c.top + 20 && r.right < c.right - 20 && r.bottom < c.bottom - 20 && e.contains(document.elementFromPoint(r.left + 10, r.top + r.height / 2)) }); const r = el.getBoundingClientRect(); return { x: r.left + 10, y: r.top + r.height / 2, id: el.dataset.nodeId } })()`)
    await app.eval(`window.opendrawStore.select([${JSON.stringify(title.id)}]), true`)
    await app.clickWith(title.x, title.y, 0, 2)
    await app.waitFor(`document.querySelector('[data-editing]') !== null`)
    await app.eval(`(() => { window.__events = []; new PerformanceObserver((list) => window.__events.push(...list.getEntries().filter((e) => e.name === 'keydown').map((e) => e.duration))).observe({ type: 'event', durationThreshold: 16, buffered: false }); return true })()`)
    for (const ch of 'quick brown fox') {
      await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch })
      await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
      await sleep(60)
    }
    await sleep(200)
    const durations = await app.eval<number[]>(`window.__events`)
    const worst = Math.max(0, ...durations)
    await app.key('Escape', 'Escape', 0, 27)
    results.typingWorstMs = worst
    expect(worst <= 32, `worst keydown to paint ${worst} ms (${durations.length} keys over 16 ms)`)
    return `worst keydown to paint ${worst} ms; ${durations.length} of 15 keys took 16 ms or more`
  })

  await check('An agent update_styles paints within 100 ms; sizes in view are unchanged by off-screen skipping', async () => {
    await toArtboard()
    const id = await app.eval<string>(`(() => { const c = document.querySelector('.canvas').getBoundingClientRect(); const el = [...document.querySelectorAll('[data-node-type="frame"]')].find((e) => { const r = e.getBoundingClientRect(); return r.width > 100 && r.left > c.left && r.top > c.top && r.right < c.right && r.bottom < c.bottom && e.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) }); return el.dataset.nodeId })()`)
    const times: number[] = []
    for (const color of ['#ff0000', '#00ff00', '#0000ff']) {
      const t0 = performance.now()
      await call('update_styles', { updates: [{ nodeIds: [id], styles: { backgroundColor: color } }] })
      await app.eval(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(getComputedStyle(document.querySelector('[data-node-id="${id}"]')).backgroundColor))))`)
      times.push(performance.now() - t0)
    }
    const worst = Math.max(...times)
    results.agentEditMs = Math.round(worst)
    const info = await call('get_node_info', { nodeId: id })
    const measured = await app.eval<{ w: number; h: number }>(`(() => { const z = Number(document.querySelector('.canvas-world').dataset.zoom); const r = document.querySelector('[data-node-id="${id}"]').getBoundingClientRect(); return { w: r.width / z, h: r.height / z } })()`)
    expect(worst < 100, `agent edits took ${times.map((t) => Math.round(t))} ms`)
    expect(Math.abs(info.width - measured.w) < 1 && Math.abs(info.height - measured.h) < 1, `get_node_info ${info.width}x${info.height}, DOM ${measured.w}x${measured.h}`)
    return `worst ${Math.round(worst)} ms (MCP round trip included)`
  })

  await check('The layers panel with every layer expanded scrolls with frames under 20 ms', async () => {
    const list = await app.rect('[data-testid="layer-list"]')
    const rows = await app.eval<number>(`document.querySelectorAll('.layer-row').length`)
    const scroll = await frames(async () => {
      for (let i = 0; i < 90; i++) {
        await app.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: list.x + 60, y: list.y + 200, deltaX: 0, deltaY: 300 })
        await sleep(FRAME_MS)
      }
    })
    results.layersScrollP95Ms = Math.round(scroll.p95)
    expect(scroll.p95 < 20, `p95 frame ${scroll.p95.toFixed(1)} ms, worst ${scroll.worst.toFixed(1)} ms`)
    return `p95 frame ${scroll.p95.toFixed(1)} ms, worst ${scroll.worst.toFixed(1)} ms; ${rows} row elements rendered`
  })
} finally {
  console.log(JSON.stringify(results))
  client.close()
  await app.kill()
}

await finish('perf')
