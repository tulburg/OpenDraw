// Writes a large OpenDraw file for performance work (S-21): 300 artboards of realistic content, about
// 30,000 layers. Usage: bun scripts/stress-file.ts <out.opendraw> [artboards]
import { writeFileSync } from 'node:fs'

const out = process.argv[2]
if (!out) throw new Error('Usage: bun scripts/stress-file.ts <out.opendraw> [artboards]')
const ARTBOARDS = Number(process.argv[3] ?? 300)
const COLUMNS = 20
const WIDTH = 1440
const HEIGHT = 900
const SPACING = 80

let next = 0
const id = (prefix: string) => `${prefix}-${(next++).toString(36)}`
type Node = { id: string; type: string; name: string; style: Record<string, string>; children: Node[]; text?: string; src?: string; svg?: string }
const frame = (name: string, style: Record<string, string>, children: Node[] = []): Node => ({ id: id('f'), type: 'frame', name, style, children })
const text = (value: string, style: Record<string, string> = {}): Node => ({ id: id('t'), type: 'text', name: value.slice(0, 40), text: value, style: { fontSize: '16px', lineHeight: '24px', color: '#1f2933', ...style }, children: [] })
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEUlEQVR4nGO4c+fOf3yYYWQoAACMvtFBUxp5PwAAAABJRU5ErkJggg=='
const image = (name: string): Node => ({ id: id('i'), type: 'image', name, src: PIXEL, style: { width: '100%', height: '160px', objectFit: 'cover', borderRadius: '8px' }, children: [] })
const icon = (): Node => ({
  id: id('s'),
  type: 'svg',
  name: 'Icon',
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%" style="display: block"><path d="M4 12h16M12 4v16" stroke="currentColor" stroke-width="2"/></svg>',
  style: { width: '20px', height: '20px', flexShrink: '0', color: '#3b82f6' },
  children: []
})

const LOREM = 'Plan, review and ship designs with your team. Every change stays in sync with the code your agents write.'

function card(n: number): Node {
  return frame('Card', { display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px', width: '300px', backgroundColor: '#ffffff', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.12)' }, [
    image(`Cover ${n}`),
    frame('Meta', { display: 'flex', alignItems: 'center', gap: '8px' }, [icon(), text(`Category ${n % 7}`, { fontSize: '13px', color: '#64748b' })]),
    text(`Card title ${n}`, { fontSize: '20px', fontWeight: '600' }),
    text(LOREM, { fontSize: '14px', color: '#475569' }),
    frame('Actions', { display: 'flex', gap: '8px' }, [
      frame('Button', { display: 'flex', padding: '8px 14px', borderRadius: '6px', backgroundColor: '#1d4ed8' }, [text('Open', { color: '#ffffff', fontSize: '14px' })]),
      frame('Button', { display: 'flex', padding: '8px 14px', borderRadius: '6px', border: '1px solid #cbd5e1' }, [text('Share', { fontSize: '14px' })])
    ])
  ])
}

function artboard(index: number): Node {
  const col = index % COLUMNS
  const row = Math.floor(index / COLUMNS)
  const nav = ['Overview', 'Projects', 'Team', 'Reports', 'Settings'].map((label) => text(label, { fontSize: '14px' }))
  return {
    id: id('a'),
    type: 'artboard',
    name: `Screen ${index + 1}`,
    style: {
      left: `${col * (WIDTH + SPACING)}px`,
      top: `${row * (HEIGHT + SPACING)}px`,
      width: `${WIDTH}px`,
      height: `${HEIGHT}px`,
      backgroundColor: '#f8fafc',
      display: 'flex',
      flexDirection: 'column',
      gap: '24px',
      padding: '32px',
      fontFamily: 'system-ui'
    },
    children: [
      frame('Header', { display: 'flex', alignItems: 'center', justifyContent: 'space-between' }, [
        frame('Brand', { display: 'flex', alignItems: 'center', gap: '8px' }, [icon(), text('OpenDraw', { fontWeight: '700', fontSize: '18px' })]),
        frame('Nav', { display: 'flex', gap: '20px' }, nav)
      ]),
      frame('Hero', { display: 'flex', flexDirection: 'column', gap: '8px' }, [
        text(`Screen ${index + 1}: dashboard`, { fontSize: '36px', lineHeight: '44px', fontWeight: '700' }),
        text(LOREM, { fontSize: '18px', color: '#475569' })
      ]),
      frame('Grid', { display: 'flex', flexWrap: 'wrap', gap: '20px' }, Array.from({ length: 6 }, (_, i) => card(index * 6 + i))),
      frame('Footer', { display: 'flex', gap: '48px', paddingTop: '16px', borderTop: '1px solid #e2e8f0' }, ['Product', 'Company', 'Help'].map((title) =>
        frame(title, { display: 'flex', flexDirection: 'column', gap: '6px' }, [text(title, { fontWeight: '600', fontSize: '13px' }), ...['One', 'Two', 'Three'].map((l) => text(`${title} ${l}`, { fontSize: '13px', color: '#64748b' }))])
      ))
    ]
  }
}

const nodes = Array.from({ length: ARTBOARDS }, (_, i) => artboard(i))
let count = 0
const walk = (ns: Node[]) => ns.forEach((n) => (count++, walk(n.children)))
walk(nodes)
writeFileSync(out, JSON.stringify({ format: 'opendraw', version: 1, id: 'stress-file', name: 'Stress', pages: [{ id: 'page-1', name: 'Page 1', nodes }] }))
console.log(`${ARTBOARDS} artboards, ${count} layers -> ${out}`)
