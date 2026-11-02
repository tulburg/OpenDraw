// Export settings and scales (S-15), shared by the styles panel, the MCP server and the renderer.
import type { ExportFormat, ExportSetting } from './document'

export class ExportError extends Error {}

/** Formats with a quality setting. */
export const LOSSY: ExportFormat[] = ['jpg', 'webp', 'avif']
export const DEFAULT_QUALITY = 90
export const DEFAULT_EXPORT: ExportSetting = { format: 'png', scale: '1x' }

const SCALE = /^(\d+(\.\d+)?)(x|p|w|h)$/

/** Checks a scale like 2x, 0.5x, 720p, 512w or 512h. Returns an error message, or null. */
export function scaleError(scale: string): string | null {
  const match = scale.trim().match(SCALE)
  if (!match || Number(match[1]) <= 0) return `${scale} is not a scale like 1x, 2x, 0.5x, 720p, 512w or 512h`
  if (match[3] === 'x' && Number(match[1]) > 8) return 'Scales go up to 8x'
  if (match[3] !== 'x' && Number(match[1]) > 8192) return 'Sizes go up to 8192 px'
  return null
}

/** The zoom factor that gives `scale` for a layer of this size. */
export function scaleFactor(scale: string, width: number, height: number): number {
  const match = scale.trim().match(SCALE)
  if (!match) throw new ExportError(scaleError(scale) ?? 'Bad scale')
  const n = Number(match[1])
  switch (match[3]) {
    case 'x':
      return n
    case 'w':
      return n / Math.max(width, 1)
    default:
      return n / Math.max(height, 1)
  }
}

/** The file name for an export: the layer name, a suffix for any scale but 1x, and the extension. */
export function exportFileName(layerName: string, setting: ExportSetting): string {
  const base = layerName.replace(/[/\\:*?"<>|\n\r\t]/g, '-').trim().slice(0, 120) || 'Export'
  const scale = setting.scale.trim()
  const suffix = scale === '1x' || setting.format === 'svg' || setting.format === 'pdf' ? '' : `@${scale}`
  return `${base}${suffix}.${setting.format}`
}

/** Checks one setting; returns an error message, or null. */
export function settingError(setting: ExportSetting, formats: readonly string[]): string | null {
  if (!formats.includes(setting.format)) return `Format must be one of ${formats.join(', ')}`
  const bad = scaleError(setting.scale)
  if (bad) return bad
  if (setting.quality !== undefined && (setting.quality < 1 || setting.quality > 100)) return 'Quality goes from 1 to 100'
  return null
}
