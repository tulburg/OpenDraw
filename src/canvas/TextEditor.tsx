// Editing a text layer in place (S-8): the layer becomes contentEditable, cmd+B/I/U format the
// selected text, and leaving the editor writes the runs back in one undo step.
import { type CSSProperties, createContext, useLayoutEffect, useRef } from 'react'

import type { CSSStyle, DesignNode, TextSpan } from '../../shared/document'
import { normalizeSpans, plainText, spanStyle } from '../document/richtext'
import type { DocumentStore } from '../document/store'
import { camelProperty, parsePastedText } from '../mcp/html'

export interface Editing {
  id: string | null
  /** The layer was just drawn with the text tool: its first edit joins that undo step. */
  fresh: boolean
  store: DocumentStore | null
  done: () => void
}

export const EditingContext = createContext<Editing>({ id: null, fresh: false, store: null, done: () => {} })

/** What formatting tags mean when the browser writes them instead of inline styles. */
const TAG_STYLES: Record<string, CSSStyle> = {
  b: { fontWeight: 'bold' },
  strong: { fontWeight: 'bold' },
  i: { fontStyle: 'italic' },
  em: { fontStyle: 'italic' },
  u: { textDecoration: 'underline' },
  s: { textDecoration: 'line-through' },
  strike: { textDecoration: 'line-through' }
}

const BLOCK_TAGS = new Set(['div', 'p'])

function spanElements(spans: TextSpan[]): Node[] {
  const out: Node[] = []
  for (const span of spans) {
    const parts = span.text.split('\n')
    const nodes: Node[] = []
    parts.forEach((part, i) => {
      if (i > 0) nodes.push(document.createElement('br'))
      if (part) nodes.push(document.createTextNode(part))
    })
    if (span.style && Object.keys(span.style).length > 0) {
      const el = document.createElement('span')
      Object.assign(el.style, span.style)
      el.append(...nodes)
      out.push(el)
    } else out.push(...nodes)
  }
  return out
}

/** Reads the editor's DOM back into runs. */
function readSpans(root: HTMLElement): TextSpan[] {
  const spans: TextSpan[] = []
  const visit = (node: Node, style: CSSStyle) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? '').replace(/ /g, ' ')
      if (text) spans.push({ text, style })
      return
    }
    if (!(node instanceof HTMLElement)) return
    const tag = node.localName
    if (tag === 'br') return void spans.push({ text: '\n', style })
    // The browser can wrap new lines in blocks (pasting, or Enter in some cases).
    if (BLOCK_TAGS.has(tag) && plainText(spans) && !plainText(spans).endsWith('\n')) spans.push({ text: '\n', style })
    const inline: CSSStyle = { ...(TAG_STYLES[tag] ?? {}) }
    for (const property of Array.from(node.style)) {
      inline[camelProperty(property)] = node.style.getPropertyValue(property)
    }
    if (tag === 'font' && node.getAttribute('color')) inline.color = node.getAttribute('color') as string
    const next = { ...style, ...spanStyle(inline).style }
    for (const child of node.childNodes) visit(child, next)
  }
  for (const child of root.childNodes) visit(child, {})
  // A trailing <br> only gives the last line its height; it is not part of the text.
  const last = spans[spans.length - 1]
  if (last?.text.endsWith('\n')) last.text = last.text.slice(0, -1)
  return spans
}

/** Writes the edited runs to the document as one undo step; no step when nothing changed. */
export function commitText(store: DocumentStore, node: DesignNode, spans: TextSpan[], merge = false) {
  const normalized = normalizeSpans(spans)
  const text = plainText(spans)
  if (text === (node.text ?? '') && JSON.stringify(normalized) === JSON.stringify(node.spans)) return
  store.transact(
    'Edit text',
    (tx) => {
      tx.setRichText(node.id, spans)
      if (/\n| {2}/.test(text) && !tx.node(node.id).style.whiteSpace) tx.updateStyles([node.id], { whiteSpace: 'pre-wrap' })
      if (merge) tx.rename(node.id, text.split('\n')[0].slice(0, 50) || node.name)
    },
    merge
  )
}

export function TextEditor({ node, style, editing }: { node: DesignNode; style: CSSProperties; editing: Editing }) {
  const ref = useRef<HTMLDivElement>(null)
  const finished = useRef(false)

  useLayoutEffect(() => {
    const el = ref.current!
    el.replaceChildren(...spanElements(node.spans ?? [{ text: node.text ?? '' }]))
    if ((node.text ?? '').endsWith('\n')) el.append(document.createElement('br'))
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.execCommand('styleWithCSS', false, 'true')
    // The DOM belongs to the browser while editing; it is read once, when editing ends.
    return () => {
      // A caret left on the canvas after editing makes the browser track it through every frame,
      // which is slow on large files (S-21).
      const after = window.getSelection()
      if (after?.anchorNode && el.contains(after.anchorNode)) after.removeAllRanges()
    }
  }, [])

  const finish = () => {
    if (finished.current) return
    finished.current = true
    const spans = readSpans(ref.current!)
    // A drawn text layer left empty is taken back, with no undo step.
    if (editing.fresh && !plainText(spans).trim()) editing.store?.dropLastStep()
    else if (editing.store) commitText(editing.store, node, spans, editing.fresh)
    editing.done()
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    const mod = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      finish()
    } else if (event.key === 'Enter' && !mod) {
      event.preventDefault()
      document.execCommand('insertLineBreak')
    } else if (mod && (key === 'b' || key === 'i' || key === 'u')) {
      event.preventDefault()
      document.execCommand('styleWithCSS', false, 'true')
      document.execCommand(key === 'b' ? 'bold' : key === 'i' ? 'italic' : 'underline')
    }
  }

  // Pasted HTML keeps its text formatting; everything else on it is left out.
  const onPaste = (event: React.ClipboardEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const html = event.clipboardData.getData('text/html')
    if (html) {
      const holder = document.createElement('div')
      holder.append(...spanElements(parsePastedText(html)))
      document.execCommand('insertHTML', false, holder.innerHTML)
    } else document.execCommand('insertText', false, event.clipboardData.getData('text/plain'))
  }

  return (
    <div
      ref={ref}
      data-node-id={node.id}
      data-node-type={node.type}
      data-editing=""
      className="text-editing"
      style={style}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onBlur={finish}
    />
  )
}
