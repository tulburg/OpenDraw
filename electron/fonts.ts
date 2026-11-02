// Google Fonts metadata (S-17 Req 1), fetched once and kept for the session.
import { net } from 'electron'

import type { FontFace } from '../shared/fonts'

const METADATA_URL = process.env.OPENDRAW_GOOGLE_FONTS_URL ?? 'https://fonts.google.com/metadata/fonts'

let catalog: Promise<Map<string, { family: string; faces: FontFace[] }>> | null = null

export class GoogleFontsUnreachable extends Error {}

/** Google Fonts families by lowercase name, with their faces. Rejects when Google Fonts cannot be reached. */
export function googleFonts(): Promise<Map<string, { family: string; faces: FontFace[] }>> {
  catalog ??= (async () => {
    const response = await net.fetch(METADATA_URL)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const text = (await response.text()).replace(/^\)\]\}'\s*/, '')
    const data = JSON.parse(text) as { familyMetadataList: { family: string; fonts: Record<string, unknown> }[] }
    return new Map(
      data.familyMetadataList.map((f) => [
        f.family.toLowerCase(),
        {
          family: f.family,
          faces: Object.keys(f.fonts).map((key) => ({ weight: Number.parseInt(key, 10) || 400, style: key.endsWith('i') ? ('italic' as const) : ('normal' as const) }))
        }
      ])
    )
  })().catch((err) => {
    catalog = null
    throw new GoogleFontsUnreachable(`Google Fonts could not be reached (${err instanceof Error ? err.message : err})`)
  })
  return catalog
}
