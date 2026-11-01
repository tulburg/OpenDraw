// Controls for the styles panel. Each one reads the selection's shared value for one CSS property
// and writes through the editor: `commit` for a finished change (one undo step), `preview` for live
// feedback while scrubbing or dragging a slider.
import { useEffect, useId, useRef, useState } from 'react'

import type { DesignNode } from '../../shared/document'
import type { StyleUpdate } from '../document/styles'
import {
  type ColorFormat,
  formatColor,
  MIXED,
  parseColor,
  parseNumberInput,
  type Shared,
  sharedValue,
  splitList,
  stepValue
} from './css-values'

export interface StyleEditor {
  nodes: DesignNode[]
  commit: (update: StyleUpdate) => void
  /** Commits a different update per layer, as one undo step. */
  commitEach: (update: (node: DesignNode) => StyleUpdate) => void
  preview: (update: StyleUpdate | null) => void
  /** Colors used in the file, for swatches. */
  colors: string[]
  /** Font families: the file's first, then installed ones. */
  fonts: string[]
  loadInstalledFonts: () => void
}

const shown = (value: Shared) => (value === MIXED ? '' : value)

/** A text input that edits a draft and commits on Enter or blur, resetting when the value changes. */
function useDraft(value: Shared) {
  const [draft, setDraft] = useState(shown(value))
  useEffect(() => setDraft(shown(value)), [value])
  return [draft, setDraft] as const
}

function Row({ label, field, children }: { label: React.ReactNode; field: string; children: React.ReactNode }) {
  return (
    <div className="field" data-field={field}>
      {label}
      <div className="field-control">{children}</div>
    </div>
  )
}

export function NumberField({ editor, property, label, placeholder }: { editor: StyleEditor; property: string; label: string; placeholder?: string }) {
  const value = sharedValue(editor.nodes, property)
  const [draft, setDraft] = useDraft(value)
  const input = useRef<HTMLInputElement>(null)
  const scrub = useRef<{ startX: number; base: string; last: string | number | null; moved: boolean } | null>(null)

  const commitText = (text: string) => {
    if (text === shown(value)) return
    editor.commit({ [property]: parseNumberInput(property, text) })
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      // Blurring commits.
      input.current?.blur()
    } else if (event.key === 'Escape') {
      setDraft(shown(value))
      input.current?.blur()
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const next = stepValue(property, draft, (event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 10 : 1))
      if (next === null) return
      event.preventDefault()
      setDraft(String(next))
      editor.commit({ [property]: next })
    }
  }

  // Dragging the label left or right scrubs the value: the canvas follows live, and the change is
  // recorded once, when the drag ends.
  const onLabelDown = (event: React.PointerEvent<HTMLLabelElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    scrub.current = { startX: event.clientX, base: shown(value) || '0', last: null, moved: false }
  }
  const onLabelMove = (event: React.PointerEvent<HTMLLabelElement>) => {
    const state = scrub.current
    if (!state) return
    const delta = Math.round(event.clientX - state.startX) * (event.shiftKey ? 10 : 1)
    if (delta === 0 && !state.moved) return
    const next = stepValue(property, state.base, delta)
    if (next === null) return
    state.moved = true
    state.last = next
    setDraft(String(next))
    editor.preview({ [property]: next })
  }
  const onLabelUp = () => {
    const state = scrub.current
    scrub.current = null
    if (!state) return
    if (!state.moved) {
      input.current?.focus()
      return
    }
    editor.preview(null)
    if (state.last !== null) editor.commit({ [property]: state.last })
  }

  return (
    <Row
      field={property}
      label={
        <label className="field-label scrub" onPointerDown={onLabelDown} onPointerMove={onLabelMove} onPointerUp={onLabelUp}>
          {label}
        </label>
      }
    >
      <input
        ref={input}
        value={draft}
        placeholder={value === MIXED ? 'Mixed' : placeholder}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => commitText(draft)}
      />
    </Row>
  )
}

export function TextField({
  editor,
  property,
  label,
  placeholder,
  toCSS = (text) => text,
  fromCSS = (css) => css
}: {
  editor: StyleEditor
  property: string
  label: string
  placeholder?: string
  toCSS?: (text: string) => string
  fromCSS?: (css: string) => string
}) {
  const value = sharedValue(editor.nodes, property)
  const [draft, setDraft] = useDraft(value === MIXED ? MIXED : fromCSS(value))
  const commit = () => {
    const current = value === MIXED ? '' : fromCSS(value)
    if (draft === current) return
    editor.commit({ [property]: draft.trim() ? toCSS(draft.trim()) : null })
  }
  return (
    <Row field={property} label={<span className="field-label">{label}</span>}>
      <input
        value={draft}
        placeholder={value === MIXED ? 'Mixed' : placeholder}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
        onBlur={commit}
      />
    </Row>
  )
}

export function SelectField({
  editor,
  property,
  label,
  options
}: {
  editor: StyleEditor
  property: string
  label: string
  options: (string | [string, string])[]
}) {
  const value = sharedValue(editor.nodes, property)
  return (
    <Row field={property} label={<span className="field-label">{label}</span>}>
      <select
        value={value === MIXED ? '__mixed' : value}
        onChange={(event) => editor.commit({ [property]: event.target.value || null })}
      >
        {value === MIXED && (
          <option value="__mixed" disabled>
            Mixed
          </option>
        )}
        <option value="">-</option>
        {options.map((option) => {
          const [optionValue, optionLabel] = Array.isArray(option) ? option : [option, option]
          return (
            <option key={optionValue} value={optionValue}>
              {optionLabel}
            </option>
          )
        })}
      </select>
    </Row>
  )
}

export function FontField({ editor }: { editor: StyleEditor }) {
  const listId = useId()
  const value = sharedValue(editor.nodes, 'fontFamily')
  const [draft, setDraft] = useDraft(value)
  const commit = () => {
    if (draft === shown(value)) return
    editor.commit({ fontFamily: draft.trim() || null })
  }
  return (
    <Row field="fontFamily" label={<span className="field-label">Font</span>}>
      <input
        value={draft}
        list={listId}
        placeholder={value === MIXED ? 'Mixed' : 'Default'}
        spellCheck={false}
        onFocus={editor.loadInstalledFonts}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
        onBlur={commit}
      />
      <datalist id={listId}>
        {editor.fonts.map((font) => (
          <option key={font} value={font} />
        ))}
      </datalist>
    </Row>
  )
}

declare global {
  interface Window {
    EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> }
  }
}

/** A color swatch and text field, with a popover for format, alpha, the system picker, an eyedropper and the file's colors. */
export function ColorField({ editor, property, label }: { editor: StyleEditor; property: string; label: string }) {
  const value = sharedValue(editor.nodes, property)
  const [draft, setDraft] = useDraft(value)
  const [open, setOpen] = useState(false)
  const [format, setFormat] = useState<ColorFormat>('hex')
  const rgba = value === MIXED ? null : parseColor(value)

  const commitColor = (css: string | null) => {
    editor.preview(null)
    editor.commit({ [property]: css })
  }
  const commitText = () => {
    if (draft === shown(value)) return
    const text = draft.trim()
    commitColor(text ? text : null)
  }
  const withAlpha = (alpha: number) => (rgba ? formatColor({ ...rgba, a: alpha }, format) : null)

  return (
    <Row field={property} label={<span className="field-label">{label}</span>}>
      <button
        type="button"
        className="color-swatch"
        aria-label={`Pick ${label.toLowerCase()}`}
        style={{ background: value === MIXED ? 'repeating-linear-gradient(45deg, #ccc 0 4px, #fff 4px 8px)' : value || 'transparent' }}
        onClick={() => setOpen(!open)}
      />
      <input
        value={draft}
        placeholder={value === MIXED ? 'Mixed' : 'None'}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
        onBlur={commitText}
      />
      {open && (
        <div className="color-popover" data-color-popover={property}>
          <div className="color-popover-row">
            <select
              aria-label="Color format"
              value={format}
              onChange={(event) => {
                const next = event.target.value as ColorFormat
                setFormat(next)
                if (rgba) commitColor(formatColor(rgba, next))
              }}
            >
              <option value="hex">Hex</option>
              <option value="rgb">RGB</option>
              <option value="hsl">HSL</option>
            </select>
            <input
              type="color"
              aria-label="System color picker"
              value={rgba ? formatColor({ ...rgba, a: 1 }, 'hex') : '#000000'}
              onInput={(event) => {
                const picked = parseColor((event.target as HTMLInputElement).value)
                if (picked) editor.preview({ [property]: formatColor({ ...picked, a: rgba?.a ?? 1 }, format) })
              }}
              onChange={(event) => {
                const picked = parseColor(event.target.value)
                if (picked) commitColor(formatColor({ ...picked, a: rgba?.a ?? 1 }, format))
              }}
            />
            {window.EyeDropper && (
              <button
                type="button"
                className="eyedropper"
                aria-label="Pick a color from the screen"
                onClick={async () => {
                  try {
                    const { sRGBHex } = await new window.EyeDropper!().open()
                    const picked = parseColor(sRGBHex)
                    if (picked) commitColor(formatColor(picked, format))
                  } catch {
                    // Cancelled.
                  }
                }}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M11 2l3 3-2 2-3-3zM9 4L3 10v3h3l6-6" />
                </svg>
              </button>
            )}
          </div>
          <label className="color-alpha">
            <span>Alpha</span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round((rgba?.a ?? 1) * 100)}
              disabled={!rgba}
              onInput={(event) => {
                const css = withAlpha(Number((event.target as HTMLInputElement).value) / 100)
                if (css) editor.preview({ [property]: css })
              }}
              onChange={(event) => commitColor(withAlpha(Number(event.target.value) / 100))}
            />
          </label>
          {editor.colors.length > 0 && (
            <div className="color-swatches">
              {editor.colors.map((color) => (
                <button
                  key={color}
                  type="button"
                  className="color-swatch small"
                  aria-label={color}
                  title={color}
                  style={{ background: color }}
                  onClick={() => commitColor(color)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </Row>
  )
}

/** box-shadow as a list: one editable row per shadow, with add and remove. */
export function ShadowField({ editor }: { editor: StyleEditor }) {
  const value = sharedValue(editor.nodes, 'boxShadow')
  const shadows = value === MIXED || !value || value === 'none' ? [] : splitList(value)
  const write = (next: string[]) => editor.commit({ boxShadow: next.length > 0 ? next.join(', ') : null })
  return (
    <div className="shadow-list" data-field="boxShadow">
      {value === MIXED && <div className="field-note">Mixed</div>}
      {shadows.map((shadow, index) => (
        <ShadowRow
          // Shadows have no identity beyond their position in the list.
          key={index}
          shadow={shadow}
          onChange={(text) => write(shadows.map((s, i) => (i === index ? text : s)).filter(Boolean))}
          onRemove={() => write(shadows.filter((_, i) => i !== index))}
        />
      ))}
      <button type="button" className="text-button" onClick={() => write([...shadows, '0px 4px 12px rgba(0, 0, 0, 0.15)'])}>
        Add shadow
      </button>
    </div>
  )
}

function ShadowRow({ shadow, onChange, onRemove }: { shadow: string; onChange: (text: string) => void; onRemove: () => void }) {
  const [draft, setDraft] = useState(shadow)
  useEffect(() => setDraft(shadow), [shadow])
  return (
    <div className="shadow-row">
      <input
        value={draft}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
        onBlur={() => draft !== shadow && onChange(draft.trim())}
      />
      <button type="button" className="icon-button" aria-label="Remove shadow" onClick={onRemove}>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 8h8" />
        </svg>
      </button>
    </div>
  )
}
