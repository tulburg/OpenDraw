// Images copied into a design file (S-22, D-8, D-11). An image an agent names by absolute path is read
// once, stored in the document's `assets` table under a content hash, and referenced as
// opendraw-asset://<hash>.<ext>. While the app runs, every embedded image of every file read is kept
// here, so the canvas, the render window and get_fill_image can load it by key alone.
import { createHash } from 'node:crypto'

import { ASSET_SCHEME, type DesignDocument } from '../shared/document'

export interface EmbeddedAsset {
  type: string
  data: Buffer
}

const registry = new Map<string, EmbeddedAsset>()

const KEY = /^[0-9a-f]{16}\.[a-z0-9]+$/
const KEY_URL = new RegExp(`${ASSET_SCHEME}://([0-9a-f]{16}\\.[a-z0-9]+)`, 'g')

/** Whether an asset URL's path is an embedded image's key rather than a workspace path. */
export function isEmbeddedKey(key: string): boolean {
  return KEY.test(key)
}

export function embeddedAsset(key: string): EmbeddedAsset | undefined {
  return registry.get(key)
}

/** Stores an image's bytes; the same bytes always get the same key. */
export function embed(data: Buffer, type: string, extension: string): string {
  const key = `${createHash('sha256').update(data).digest('hex').slice(0, 16)}.${extension.replace(/^\./, '').toLowerCase()}`
  if (!registry.has(key)) registry.set(key, { type, data })
  return key
}

/** Makes a document's embedded images loadable. */
export function registerAssets(document: DesignDocument) {
  for (const [key, asset] of Object.entries(document.assets ?? {})) {
    if (isEmbeddedKey(key) && !registry.has(key)) registry.set(key, { type: asset.type, data: Buffer.from(asset.data, 'base64') })
  }
}

/**
 * The document as saved: its `assets` table holds exactly the embedded images its layers use, so a
 * deleted image does not linger and a layer pasted from another file brings its image along.
 */
export function withEmbeddedAssets(document: DesignDocument): DesignDocument {
  const { assets: _old, ...rest } = document
  const keys = new Set([...JSON.stringify(rest.pages).matchAll(KEY_URL)].map((m) => m[1]))
  const assets: NonNullable<DesignDocument['assets']> = {}
  for (const key of [...keys].sort()) {
    const known = registry.get(key)
    if (known) assets[key] = { type: known.type, data: known.data.toString('base64') }
    else if (document.assets?.[key]) assets[key] = document.assets[key]
  }
  return Object.keys(assets).length > 0 ? { ...rest, assets } : rest
}
