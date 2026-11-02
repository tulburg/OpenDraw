// get_fill_image (S-15 Req 7): an image layer's picture as JPEG, sized for a model to read.
import { readAsset } from '../assets'
import { nativeImage } from 'electron'

import { ASSET_SCHEME, type DesignNode, LEGACY_ASSET_SCHEME } from '../../shared/document'

const MAX_SIDE = 1568
const JPEG_QUALITY = 85

type Result = { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean }

const message = (text: string): Result => ({ content: [{ type: 'text', text }] })

/** The image URL a layer shows: an image node's src, or the first url() in its background image. */
export function fillSource(node: DesignNode): string | null {
  if (node.type === 'image' && node.src) return node.src
  const bg = node.style.backgroundImage ?? node.style.background
  const match = typeof bg === 'string' ? bg.match(/url\(\s*(['"]?)(.*?)\1\s*\)/) : null
  return match ? match[2] : null
}

async function load(url: string): Promise<Buffer> {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',')
    const meta = url.slice(5, comma)
    const data = url.slice(comma + 1)
    return meta.endsWith(';base64') ? Buffer.from(data, 'base64') : Buffer.from(decodeURIComponent(data))
  }
  if (url.startsWith(`${ASSET_SCHEME}://`) || url.startsWith(`${LEGACY_ASSET_SCHEME}://`)) return readAsset(url)
  if (/^https?:\/\//.test(url)) {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Could not load ${url}: HTTP ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  }
  throw new Error(`Cannot load ${url.slice(0, 80)}`)
}

export async function fillImage(node: DesignNode): Promise<Result> {
  if (node.type === 'svg') return message('This layer is an SVG and has no fill image. Read its markup with get_jsx.')
  const src = fillSource(node)
  if (!src) return message('This layer has no image fill.')
  let image = nativeImage.createFromBuffer(await load(src))
  if (image.isEmpty()) return message(`The image at ${src.slice(0, 80)} could not be decoded.`)
  const { width, height } = image.getSize()
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height))
  if (scale < 1) image = image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' })
  const size = image.getSize()
  return {
    content: [
      { type: 'image', data: image.toJPEG(JPEG_QUALITY).toString('base64'), mimeType: 'image/jpeg' },
      {
        type: 'text',
        text: JSON.stringify({ sourceUrl: src.startsWith('data:') ? `${src.slice(0, 40)}...` : src, width: size.width, height: size.height, originalWidth: width, originalHeight: height })
      }
    ]
  }
}
