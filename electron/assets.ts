// paper-asset://<path> (S-17 Req 4): files in the workspace folder, served to the canvas, the render
// window and get_fill_image. Paths that leave the workspace, by .. or by symlink, are refused.
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

import { protocol, session } from 'electron'

import { workspaceDir } from './workspace'

export const ASSET_SCHEME = 'paper-asset'

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

/** The file a paper-asset URL names, if it is inside the workspace. */
export async function assetPath(url: string): Promise<string> {
  const relative = decodeURIComponent(url.slice(`${ASSET_SCHEME}://`.length).split(/[?#]/)[0])
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

export async function readAsset(url: string): Promise<Buffer> {
  return readFile(await assetPath(url))
}

/** Must run before the app is ready. */
export function registerAssetScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: ASSET_SCHEME, privileges: { secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }])
}

/** Serves paper-asset URLs in the default session and in the given partitions (the render window's). */
export function handleAssets(partitions: string[] = []) {
  for (const handler of [protocol, ...partitions.map((p) => session.fromPartition(p).protocol)]) handler.handle(ASSET_SCHEME, serve)
}

async function serve(request: Request): Promise<Response> {
  try {
    const file = await assetPath(request.url)
    const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
    return new Response(await readFile(file), { headers: { 'content-type': type } })
  } catch (err) {
    const status = err instanceof AssetError && err.message.endsWith('does not exist') ? 404 : 403
    return new Response(err instanceof Error ? err.message : 'Refused', { status })
  }
}
