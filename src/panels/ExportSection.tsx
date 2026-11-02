// The Export section of the styles panel (S-15 Req 2): a layer's export settings, a preview of the
// layer alone, and an Export button that writes one file per setting.
import { useEffect, useState } from 'react'

import { type DesignNode, EXPORT_FORMATS, type ExportSetting } from '../../shared/document'
import { DEFAULT_QUALITY, LOSSY, scaleError } from '../../shared/export'
import { withTokens } from '../../shared/tokens'
import type { DocumentStore } from '../document/store'
import { findNode } from '../document/tree'

const NEXT_SCALES = ['1x', '2x', '3x', '4x']
const PREVIEW_DELAY_MS = 300

function ScaleInput({ value, onCommit }: { value: string; onCommit: (scale: string) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const invalid = scaleError(draft) !== null
  return (
    <input
      className="export-scale"
      aria-label="Scale"
      data-testid="export-scale"
      data-invalid={invalid || undefined}
      title={invalid ? (scaleError(draft) ?? '') : '1x, 2x, 0.5x, 720p, 512w or 512h'}
      value={draft}
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
      onBlur={() => (scaleError(draft) ? setDraft(value) : draft.trim() !== value && onCommit(draft.trim()))}
    />
  )
}

export function ExportSection({ store, node }: { store: DocumentStore; node: DesignNode }) {
  const settings = node.exports ?? []
  const [preview, setPreview] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [folder, setFolder] = useState<string | null>(null)

  useEffect(() => {
    void window.opendraw.exportDir().then(setFolder)
  }, [])

  const write = (label: string, next: ExportSetting[]) => store.transact(label, (tx) => tx.setExports(node.id, next))
  const change = (index: number, patch: Partial<ExportSetting>) =>
    write(
      'Edit export',
      settings.map((s, i) => {
        if (i !== index) return s
        const merged = { ...s, ...patch }
        if (!LOSSY.includes(merged.format)) delete merged.quality
        return merged
      })
    )

  const item = () => {
    const { document } = store.getState()
    const page = document.pages.find((p) => p.nodes.some((a) => a.id === node.id || findNode(a.children, node.id)))
    const artboard = page?.nodes.find((a) => a.id === node.id || findNode(a.children, node.id))
    if (!artboard) return null
    return { artboard: withTokens(artboard, document.tokens), nodeId: node.id, name: node.name, settings }
  }

  // The preview follows the layer as it changes, a moment after the last edit.
  useEffect(() => {
    if (settings.length === 0) {
      setPreview(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      const it = item()
      if (!it) return
      window.opendraw
        .exportPreview(it)
        .then((png) => !cancelled && setPreview(`data:image/png;base64,${png}`))
        .catch(() => !cancelled && setPreview(null))
    }, PREVIEW_DELAY_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [node, settings.length > 0])

  const runExport = async () => {
    const it = item()
    if (!it) return
    setBusy(true)
    setStatus(null)
    try {
      const result = await window.opendraw.runExport([it])
      if (result.files) {
        setStatus(`Exported ${result.files.length} file${result.files.length === 1 ? '' : 's'}`)
        setFolder(await window.opendraw.exportDir())
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="export-section" data-testid="export-section">
      {settings.map((setting, index) => (
        <div className="export-row" data-testid="export-row" key={index}>
          <ScaleInput value={setting.scale} onCommit={(scale) => change(index, { scale })} />
          <select
            aria-label="Format"
            data-testid="export-format"
            value={setting.format}
            onChange={(event) => change(index, { format: event.target.value as ExportSetting['format'] })}
          >
            {EXPORT_FORMATS.map((format) => (
              <option key={format} value={format}>
                {format.toUpperCase()}
              </option>
            ))}
          </select>
          {LOSSY.includes(setting.format) && (
            <input
              className="export-quality"
              aria-label="Quality"
              data-testid="export-quality"
              type="number"
              min={1}
              max={100}
              value={setting.quality ?? DEFAULT_QUALITY}
              onChange={(event) => {
                const quality = Math.min(100, Math.max(1, Number(event.target.value) || DEFAULT_QUALITY))
                change(index, { quality })
              }}
            />
          )}
          <button type="button" className="icon-button" aria-label="Remove export" data-testid="export-remove" onClick={() => write('Remove export', settings.filter((_, i) => i !== index))}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 8h8" />
            </svg>
          </button>
        </div>
      ))}
      <button
        type="button"
        className="text-button"
        data-testid="export-add"
        onClick={() => {
          const used = new Set(settings.filter((s) => s.format === 'png').map((s) => s.scale))
          const scale = NEXT_SCALES.find((s) => !used.has(s)) ?? '1x'
          write('Add export', [...settings, { format: 'png', scale }])
        }}
      >
        Add export
      </button>
      {settings.length > 0 && (
        <>
          {preview && (
            <div className="export-preview">
              <img src={preview} alt="" data-testid="export-preview" />
            </div>
          )}
          <button type="button" className="export-button" data-testid="export-run" disabled={busy} onClick={() => void runExport()}>
            {busy ? 'Exporting...' : `Export ${node.name}`}
          </button>
          <div className="export-folder">
            <span title={folder ?? undefined}>{folder ? `To ${folder.split(/[\\/]/).pop()}` : 'Asks for a folder'}</span>
            <button type="button" className="text-button" onClick={() => void window.opendraw.chooseExportDir().then((d) => d && setFolder(d))}>
              Change
            </button>
          </div>
          {status && (
            <div className="field-note" data-testid="export-status">
              {status}
            </div>
          )}
        </>
      )}
    </div>
  )
}
