// Writing exports to disk (S-15), for the styles panel's Export button and the MCP export tools.
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { type DesignNode, EXPORT_FORMATS, type ExportSetting } from '../shared/document'
import { DEFAULT_EXPORT, exportFileName, settingError } from '../shared/export'
import { exportNode, printPDF, type RenderTarget } from './mcp/render'
import { readState, workspaceDir } from './workspace'

/** The user's export folder, else an Exports folder next to the workspace. */
export async function exportDir(): Promise<string> {
  return (await readState()).exportDir ?? path.join(path.dirname(workspaceDir()), 'Exports')
}

export interface ExportItem {
  /** The layer's artboard, with the file's tokens set on it. */
  artboard: DesignNode
  nodeId: string
  name: string
  /** The layer's settings; none means one 1x PNG. */
  settings?: ExportSetting[]
}

export interface ExportedFile {
  nodeId: string
  format: string
  scale: string
  path: string
}

/** Exports every item with each of its settings, one file each. Names repeated within a call get " 2", " 3". */
export async function runExports(target: RenderTarget, items: ExportItem[], dir?: string): Promise<ExportedFile[]> {
  const folder = dir ?? (await exportDir())
  await mkdir(folder, { recursive: true })
  const used = new Set<string>()
  const out: ExportedFile[] = []
  for (const item of items) {
    const settings = item.settings && item.settings.length > 0 ? item.settings : [DEFAULT_EXPORT]
    for (const setting of settings) {
      const bad = settingError(setting, EXPORT_FORMATS)
      if (bad) throw new Error(`${item.name}: ${bad}`)
      const data = await exportNode(target, item.artboard, item.nodeId, setting)
      let name = exportFileName(item.name, setting)
      const ext = path.extname(name)
      for (let n = 2; used.has(name); n++) name = `${exportFileName(item.name, setting).slice(0, -ext.length)} ${n}${ext}`
      used.add(name)
      const file = path.join(folder, name)
      await writeFile(file, data)
      out.push({ nodeId: item.nodeId, format: setting.format, scale: setting.scale, path: file })
    }
  }
  return out
}

/** One PDF, one page per item, in the given order. */
export async function runCombinedPDF(target: RenderTarget, items: ExportItem[], fileName: string, dir?: string): Promise<string> {
  const folder = dir ?? (await exportDir())
  await mkdir(folder, { recursive: true })
  const file = path.join(folder, exportFileName(fileName, { format: 'pdf', scale: '1x' }))
  await writeFile(file, await printPDF(target, items))
  return file
}
