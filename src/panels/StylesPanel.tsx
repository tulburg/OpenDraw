// The styles panel (S-7): edits the selected layers' CSS, grouped like Paper's design panel, with a
// raw CSS view for everything else. Every change goes through the document engine as one undo step.
import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react'

import { type CSSStyle, type DesignNode, holdsLayers, type Token } from '../../shared/document'
import { type DocumentStore, useStore } from '../document/store'
import type { StyleUpdate } from '../document/styles'
import { findNode } from '../document/tree'
import { setFlexLayout } from '../canvas/arrange'
import { isPlaceableImage, replaceImage } from '../canvas/tools'
import { documentColors, documentFonts, kebab, MIXED, parseRawCSS, rawCSS, sharedValue } from './css-values'
import { ExportSection } from './ExportSection'
import { ColorField, FontField, NumberField, PositionField, SelectField, ShadowField, type StyleEditor, TextField } from './fields'

interface StylesPanelProps {
  store: DocumentStore
  /** The artboards on the page the user is viewing. */
  nodes: DesignNode[]
  selection: string[]
  /** Rendered size of a layer in world units. */
  measure: (id: string) => { width: number; height: number } | null
  /** Live style overrides while scrubbing, keyed by layer ID; null clears them. */
  onPreview: (preview: Record<string, CSSStyle> | null) => void
}

const FALLBACK_FONTS = ['Inter', 'Helvetica', 'Arial', 'Georgia', 'Times New Roman', 'Courier New', 'system-ui', 'monospace']

declare global {
  interface Window {
    queryLocalFonts?: () => Promise<{ family: string }[]>
  }
}

function parentOf(nodes: DesignNode[], id: string): DesignNode | null {
  for (const node of nodes) {
    if (node.children.some((child) => child.id === id)) return node
    const found = parentOf(node.children, id)
    if (found) return found
  }
  return null
}

type SizeMode = 'fixed' | 'hug' | 'fill'

/** Fill grows along the parent's main axis with flex: 1, and stretches across it with 100%. */
function fillsWithFlex(parent: DesignNode | null, axis: 'width' | 'height'): boolean {
  if (!parent || parent.style.display !== 'flex') return false
  const row = !String(parent.style.flexDirection ?? 'row').startsWith('column')
  return axis === 'width' ? row : !row
}

function sizeMode(node: DesignNode, parent: DesignNode | null, axis: 'width' | 'height'): SizeMode {
  const value = String(node.style[axis] ?? '')
  if (value === 'fit-content') return 'hug'
  if (value === '100%') return 'fill'
  const flex = String(node.style.flex ?? node.style.flexGrow ?? '')
  if (fillsWithFlex(parent, axis) && (flex === '1' || flex.startsWith('1 '))) return 'fill'
  return 'fixed'
}

function SizeField({ editor, axis, nodes, measure }: { editor: StyleEditor; axis: 'width' | 'height'; nodes: DesignNode[]; measure: StylesPanelProps['measure'] }) {
  const modes = new Set(editor.nodes.map((node) => sizeMode(node, parentOf(nodes, node.id), axis)))
  const mode = modes.size === 1 ? [...modes][0] : null
  const isArtboard = editor.nodes.some((node) => node.type === 'artboard')

  const setMode = (next: SizeMode) => {
    // Each layer gets the CSS that means this mode where it sits.
    editor.commitEach((node) => {
      const parent = parentOf(nodes, node.id)
      const flexFill = fillsWithFlex(parent, axis)
      const flexIsFill = flexFill && sizeMode(node, parent, axis) === 'fill'
      if (next === 'hug') return { [axis]: 'fit-content', ...(flexIsFill ? { flex: null, flexGrow: null } : {}) }
      if (next === 'fill') return flexFill ? { flex: 1, [axis]: null } : { [axis]: '100%' }
      const size = measure(node.id)
      return { [axis]: `${Math.round(size ? size[axis] : 0)}px`, ...(flexIsFill ? { flex: null, flexGrow: null } : {}) }
    })
  }

  return (
    <div className="size-field" data-size-mode={axis}>
      <NumberField editor={editor} property={axis} label={axis === 'width' ? 'W' : 'H'} placeholder="Auto" />
      {!isArtboard && (
        <div className="segmented" role="group" aria-label={`${axis} mode`}>
          {(['fixed', 'hug', 'fill'] as const).map((option) => (
            <button
              key={option}
              type="button"
              data-mode={option}
              data-active={mode === option || undefined}
              onClick={() => setMode(option)}
            >
              {option === 'fixed' ? 'Fixed' : option === 'hug' ? 'Hug' : 'Fill'}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Fit choices for image layers (`object-fit`) and background images (`background-size`), S-26. */
const IMAGE_FITS: [string, string][] = [['cover', 'Fill'], ['contain', 'Fit'], ['fill', 'Stretch'], ['none', 'Original']]
const BACKGROUND_FITS: [string, string][] = [['cover', 'Fill'], ['contain', 'Fit'], ['100% 100%', 'Stretch'], ['auto', 'Original']]

function ReplaceImage({ store, id }: { store: DocumentStore; id: string }) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <div className="field" data-field="replace-image">
      <span className="field-label" />
      <div className="field-control">
        <button type="button" data-testid="replace-image" onClick={() => input.current?.click()}>
          Replace image
        </button>
        <input
          ref={input}
          type="file"
          hidden
          accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file && isPlaceableImage(file)) void replaceImage(store, id, file)
          }}
        />
      </div>
    </div>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="style-group" data-group={title}>
      <h3>{title}</h3>
      {children}
    </section>
  )
}

/** Every property the selected layers share, as editable `prop: value;` text. */
function RawCSS({ editor }: { editor: StyleEditor }) {
  const shared = useMemo(() => {
    const keys = new Set(editor.nodes.flatMap((node) => Object.keys(node.style)))
    const style: CSSStyle = {}
    for (const key of keys) {
      const value = sharedValue(editor.nodes, key)
      if (value !== MIXED && value !== '') style[key] = value
    }
    return style
  }, [editor.nodes])
  const text = rawCSS(shared)
  const [draft, setDraft] = useState(text)
  useEffect(() => setDraft(text), [text])

  const apply = () => {
    if (draft === text) return
    const next = parseRawCSS(draft)
    const update: StyleUpdate = {}
    for (const key of Object.keys(shared)) if (!(key in next)) update[key] = null
    for (const [key, value] of Object.entries(next)) if (String(shared[key] ?? '') !== String(value)) update[key] = value
    if (Object.keys(update).length > 0) editor.commit(update)
    else setDraft(text)
  }

  return (
    <textarea
      className="raw-css"
      aria-label="CSS"
      value={draft}
      spellCheck={false}
      rows={Math.max(4, draft.split('\n').length + 1)}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) (event.target as HTMLTextAreaElement).blur()
        if (event.key === 'Escape') {
          setDraft(text)
          ;(event.target as HTMLTextAreaElement).blur()
        }
      }}
      onBlur={apply}
    />
  )
}

const NO_TOKENS: Token[] = []

/** Memoized, so panning and zooming do not re-render it (S-21). */
export const StylesPanel = memo(function StylesPanel({ store, nodes, selection, measure, onPreview }: StylesPanelProps) {
  const selected = useMemo(
    () => selection.map((id) => findNode(nodes, id)).filter((node): node is DesignNode => node !== null),
    [nodes, selection]
  )
  const [notes, setNotes] = useState<string[]>([])
  useEffect(() => setNotes([]), [selection])
  const [installedFonts, setInstalledFonts] = useState<string[]>([])
  const tokens = useStore(store, (s) => s.document.tokens) ?? NO_TOKENS

  const report = useCallback((ignored: Record<string, Record<string, string>>) => {
    const lines = new Set<string>()
    for (const byProperty of Object.values(ignored)) {
      for (const [property, reason] of Object.entries(byProperty)) lines.add(`${kebab(property)}: ${reason}`)
    }
    setNotes([...lines])
  }, [])

  const editor = useMemo(() => {
    const ids = selected.map((node) => node.id)
    const value: StyleEditor = {
      nodes: selected,
      commit: (update) => report(store.transact('Edit styles', (tx) => tx.updateStyles(ids, update))),
      commitEach: (update) =>
        report(
          store.transact('Edit styles', (tx) => {
            const ignored: Record<string, Record<string, string>> = {}
            for (const node of selected) Object.assign(ignored, tx.updateStyles([node.id], update(node)))
            return ignored
          })
        ),
      preview: (update) => onPreview(update ? Object.fromEntries(ids.map((id) => [id, update as CSSStyle])) : null),
      colors: documentColors(nodes),
      tokens,
      fonts: [...new Set([...documentFonts(nodes), ...installedFonts, ...FALLBACK_FONTS])],
      loadInstalledFonts: () => {
        if (installedFonts.length > 0 || !window.queryLocalFonts) return
        window
          .queryLocalFonts()
          .then((fonts) => setInstalledFonts([...new Set(fonts.map((font) => font.family))].sort()))
          .catch(() => undefined)
      }
    }
    return value
  }, [selected, store, nodes, installedFonts, onPreview, report, tokens])

  if (selected.length === 0) {
    return (
      <aside className="panel styles-panel" data-testid="styles-panel">
        <div className="panel-empty">Select a layer to edit its styles</div>
      </aside>
    )
  }

  const allText = selected.every((node) => node.type === 'text')
  const allImages = selected.every((node) => node.type === 'image')
  const hasBackgroundImage = !allImages && selected.every((node) => !!node.style.backgroundImage && /url\(/.test(String(node.style.backgroundImage)))
  const anyArtboard = selected.some((node) => node.type === 'artboard')
  const absolute = sharedValue(selected, 'position') === 'absolute'
  const containers = selected.every(holdsLayers)
  const flex = sharedValue(selected, 'display') === 'flex'

  return (
    <aside className="panel styles-panel" data-testid="styles-panel">
      <div className="panel-title">{selected.length === 1 ? selected[0].name : `${selected.length} layers`}</div>
      {notes.length > 0 && (
        <div className="style-notes" role="status">
          {notes.map((note) => (
            <div key={note} className="style-note">
              {note}
            </div>
          ))}
        </div>
      )}

      <Group title="Layout">
        {containers ? (
          // Frames have no layout until flex is turned on, like auto layout (S-35 Req 4).
          <label className="field toggle" data-field="flex-layout">
            <input
              type="checkbox"
              checked={flex}
              onChange={(event) => setFlexLayout(store, selected.map((node) => node.id), event.target.checked)}
            />
            <span className="field-label">Flex layout</span>
          </label>
        ) : (
          <SelectField editor={editor} property="display" label="Display" options={['flex', 'block', 'none']} />
        )}
        {(flex || !containers) && (
          <>
            <SelectField
              editor={editor}
              property="flexDirection"
              label="Direction"
              options={[['row', 'Row'], ['column', 'Column'], ['row-reverse', 'Row reverse'], ['column-reverse', 'Column reverse']]}
            />
            <SelectField editor={editor} property="flexWrap" label="Wrap" options={['nowrap', 'wrap', 'wrap-reverse']} />
            <SelectField
              editor={editor}
              property="alignItems"
              label="Align"
              options={['flex-start', 'center', 'flex-end', 'stretch', 'baseline']}
            />
            <SelectField
              editor={editor}
              property="justifyContent"
              label="Justify"
              options={['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly']}
            />
            <NumberField editor={editor} property="gap" label="Gap" placeholder="0" />
          </>
        )}
        <NumberField editor={editor} property="padding" label="Padding" placeholder="0" />
      </Group>

      <Group title="Size">
        <SizeField editor={editor} axis="width" nodes={nodes} measure={measure} />
        <SizeField editor={editor} axis="height" nodes={nodes} measure={measure} />
        <NumberField editor={editor} property="minWidth" label="Min W" />
        <NumberField editor={editor} property="maxWidth" label="Max W" />
        <NumberField editor={editor} property="minHeight" label="Min H" />
        <NumberField editor={editor} property="maxHeight" label="Max H" />
      </Group>

      <Group title="Position">
        {!anyArtboard && (
          <label className="field toggle" data-field="position">
            <input
              type="checkbox"
              checked={absolute}
              onChange={(event) =>
                editor.commitEach((node): StyleUpdate => {
                  if (!event.target.checked) return { position: null, left: null, top: null, right: null, bottom: null }
                  // Keep the layer where it is when it leaves the layout.
                  const el = document.querySelector<HTMLElement>(`.canvas-world [data-node-id="${CSS.escape(node.id)}"]`)
                  return { position: 'absolute', left: `${el?.offsetLeft ?? 0}px`, top: `${el?.offsetTop ?? 0}px` }
                })
              }
            />
            <span className="field-label">Absolute</span>
          </label>
        )}
        {(absolute || anyArtboard) && (
          <>
            <NumberField editor={editor} property="left" label="X" />
            <NumberField editor={editor} property="top" label="Y" />
            {!anyArtboard && (
              <>
                <NumberField editor={editor} property="right" label="Right" />
                <NumberField editor={editor} property="bottom" label="Bottom" />
              </>
            )}
          </>
        )}
        {!anyArtboard && <NumberField editor={editor} property="rotate" label="Rotation" />}
        <NumberField editor={editor} property="zIndex" label="Z index" />
      </Group>

      <Group title="Fill">
        <ColorField editor={editor} property="backgroundColor" label="Color" />
        <TextField
          editor={editor}
          property="backgroundImage"
          label="Image"
          placeholder="URL"
          toCSS={(text) => (/^(url|linear-gradient|radial-gradient|conic-gradient)\(/.test(text) ? text : `url("${text}")`)}
          fromCSS={(css) => css.match(/^url\(["']?(.*?)["']?\)$/)?.[1] ?? css}
        />
        <NumberField editor={editor} property="opacity" label="Opacity" placeholder="1" />
      </Group>

      {allImages && (
        <Group title="Image">
          <SelectField editor={editor} property="objectFit" label="Fit" options={IMAGE_FITS} />
          <PositionField editor={editor} property="objectPosition" label="Position" />
          {selected.length === 1 && <ReplaceImage store={store} id={selected[0].id} />}
        </Group>
      )}
      {hasBackgroundImage && (
        <Group title="Image">
          <SelectField editor={editor} property="backgroundSize" label="Fit" options={BACKGROUND_FITS} />
          <PositionField editor={editor} property="backgroundPosition" label="Position" />
          <SelectField editor={editor} property="backgroundRepeat" label="Repeat" options={['no-repeat', 'repeat', 'repeat-x', 'repeat-y']} />
        </Group>
      )}

      <Group title="Border">
        <NumberField editor={editor} property="borderWidth" label="Width" placeholder="0" />
        <SelectField editor={editor} property="borderStyle" label="Style" options={['solid', 'dashed', 'dotted', 'none']} />
        <ColorField editor={editor} property="borderColor" label="Color" />
        <NumberField editor={editor} property="borderRadius" label="Radius" placeholder="0" />
        <NumberField editor={editor} property="borderTopLeftRadius" label="Top left" />
        <NumberField editor={editor} property="borderTopRightRadius" label="Top right" />
        <NumberField editor={editor} property="borderBottomRightRadius" label="Bottom right" />
        <NumberField editor={editor} property="borderBottomLeftRadius" label="Bottom left" />
      </Group>

      <Group title="Shadow">
        <ShadowField editor={editor} />
      </Group>

      {allText && (
        <Group title="Text">
          <FontField editor={editor} />
          <NumberField editor={editor} property="fontSize" label="Size" placeholder="16" />
          <SelectField
            editor={editor}
            property="fontWeight"
            label="Weight"
            options={['100', '200', '300', '400', '500', '600', '700', '800', '900']}
          />
          <NumberField editor={editor} property="lineHeight" label="Line height" placeholder="Auto" />
          <NumberField editor={editor} property="letterSpacing" label="Letter spacing" placeholder="0" />
          <ColorField editor={editor} property="color" label="Color" />
          <SelectField editor={editor} property="textAlign" label="Align" options={['left', 'center', 'right', 'justify']} />
          <SelectField
            editor={editor}
            property="textDecoration"
            label="Decoration"
            options={['none', 'underline', 'line-through']}
          />
          <SelectField
            editor={editor}
            property="textTransform"
            label="Case"
            options={['none', 'uppercase', 'lowercase', 'capitalize']}
          />
        </Group>
      )}

      <Group title="CSS">
        <RawCSS editor={editor} />
      </Group>

      <Group title="Export">
        {selected.length === 1 ? (
          <ExportSection store={store} node={selected[0]} />
        ) : (
          <div className="field-note">Select one layer to export it</div>
        )}
      </Group>
    </aside>
  )
})
