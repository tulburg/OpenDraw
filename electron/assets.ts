// opendraw-asset:// local images (S-17 Req 4, S-22), served to the canvas, the render window and
// get_fill_image. A relative path names a file in the workspace folder; paths that leave it, by .. or
// by symlink, are refused. An absolute path is copied into the design file when it is written (D-8)
// and the URL then names the copy (see embedded.ts). paper-asset:// is read the same way.
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

import { protocol, session } from 'electron'

import { ASSET_SCHEME, LEGACY_ASSET_SCHEME } from '../shared/document'
import { embed, embeddedAsset, isEmbeddedKey } from './embedded'
import { workspaceDir } from './workspace'

const SCHEMES = [ASSET_SCHEME, LEGACY_ASSET_SCHEME]

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml'
}

export class AssetError extends Error {}

/** The path an asset URL names: an embedded image's key, an absolute path, or a workspace path. */
function pathOf(url: string): string {
  return decodeURIComponent(url.replace(/^[a-z-]+:\/\//, '').split(/[?#]/)[0])
}

/** The file a relative asset URL names, if it is inside the workspace. */
export async function assetPath(url: string): Promise<string> {
  const relative = pathOf(url)
  const root = await realpath(workspaceDir())
  const file = path.resolve(root, relative)
  const inside = (p: string) => p !== root && !path.relative(root, p).startsWith('..') && !path.isAbsolute(path.relative(root, p))
  if (path.isAbsolute(relative) || !inside(file)) throw new AssetError(`${url} is outside the workspace`)
  const real = await realpath(file).catch(() => {
    throw new AssetError(`${url} does not exist`)
  })
  if (!inside(real)) throw new AssetError(`${url} is outside the workspace`)
  return real
}

function imageType(url: string, file: string): string {
  const type = TYPES[path.extname(file).toLowerCase()]
  if (!type) throw new AssetError(`${url} is not an image (PNG, JPEG, GIF, WebP, AVIF or SVG)`)
  return type
}

/** An asset URL's bytes and type. */
async function load(url: string): Promise<{ data: Buffer; type: string }> {
  const key = pathOf(url)
  const embedded = isEmbeddedKey(key) ? embeddedAsset(key) : undefined
  if (embedded) return embedded
  const file = await assetPath(url)
  return { data: await readFile(file), type: TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' }
}

export async function readAsset(url: string): Promise<Buffer> {
  return (await load(url)).data
}

const ASSET_URL = /\b(?:opendraw|paper)-asset:\/\/[^\s"'()<>\\]+/g

/** Applies `change` to every string in a tool's arguments. */
async function mapStrings(value: unknown, change: (text: string) => Promise<string>): Promise<unknown> {
  if (typeof value === 'string') return change(value)
  if (Array.isArray(value)) return Promise.all(value.map((v) => mapStrings(v, change)))
  if (value && typeof value === 'object') {
    const entries = await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await mapStrings(v, change)] as const))
    return Object.fromEntries(entries)
  }
  return value
}

/**
 * Prepares the asset URLs in a write's arguments before it runs (S-22 Req 1, 3). An absolute path is
 * read and copied into the file; its URL becomes the copy's. A workspace path must exist and be an
 * image. Any failure fails the whole write, naming the path.
 */
export async function importAssets<T>(args: T): Promise<T> {
  const imported = new Map<string, string>()
  return (await mapStrings(args, async (text) => {
    for (const url of new Set(text.match(ASSET_URL) ?? [])) {
      if (!imported.has(url)) imported.set(url, await importAsset(url))
    }
    return text.replace(ASSET_URL, (url) => imported.get(url)!)
  })) as T
}

async function importAsset(url: string): Promise<string> {
  const target = pathOf(url)
  if (isEmbeddedKey(target) && embeddedAsset(target)) return `${ASSET_SCHEME}://${target}`
  if (path.isAbsolute(target)) {
    const type = imageType(url, target)
    const data = await readFile(target).catch((err: NodeJS.ErrnoException) => {
      throw new AssetError(err.code === 'ENOENT' ? `${url} does not exist` : `${url} could not be read (${err.code ?? err.message})`)
    })
    return `${ASSET_SCHEME}://${embed(data, type, path.extname(target))}`
  }
  imageType(url, await assetPath(url))
  return url.replace(/^paper-asset:/, `${ASSET_SCHEME}:`)
}

/** Must run before the app is ready. */
export function registerAssetScheme() {
  protocol.registerSchemesAsPrivileged(SCHEMES.map((scheme) => ({ scheme, privileges: { secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } })))
}

/** Serves asset URLs in the default session and in the given partitions (the render window's). */
export function handleAssets(partitions: string[] = []) {
  for (const handler of [protocol, ...partitions.map((p) => session.fromPartition(p).protocol)]) for (const scheme of SCHEMES) handler.handle(scheme, serve)
}

async function serve(request: Request): Promise<Response> {
  try {
    const { data, type } = await load(request.url)
    return new Response(new Uint8Array(data), { headers: { 'content-type': type } })
  } catch (err) {
    const status = err instanceof AssetError && err.message.endsWith('does not exist') ? 404 : 403
    return new Response(err instanceof Error ? err.message : 'Refused', { status })
  }
}
