// Images and SVG come from agents and from files on disk, so both are checked before they reach the DOM.

const IMAGE_SRC = /^(https?:\/\/|paper-asset:\/\/|data:image\/(png|jpe?g|gif|webp|avif|svg\+xml)[;,])/i

/** The URL if it is one the canvas will load (http, https, paper-asset or a data: image), otherwise null. */
export function safeImageSrc(src: string | undefined): string | null {
  return src && IMAGE_SRC.test(src.trim()) ? src.trim() : null
}

const REMOVED_ELEMENTS = 'script, style, foreignObject, iframe, object, embed, audio, video, animate, set'

/**
 * Returns the <svg> markup without scripts, event handlers, styles (which would leak into the
 * editor's page) or outside references, drawn to fill its node. Returns '' if it is not an SVG.
 */
export function sanitizeSvg(markup: string): string {
  // SVG written in HTML often leaves out the namespaces that XML parsing needs.
  let source = markup.trim()
  if (!/^<svg[^>]*\sxmlns=/i.test(source)) source = source.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"')
  if (source.includes('xlink:') && !/^<svg[^>]*\sxmlns:xlink=/i.test(source)) {
    source = source.replace(/^<svg/i, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"')
  }
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml')
  const svg = parsed.documentElement
  if (svg.nodeName !== 'svg' || parsed.querySelector('parsererror')) return ''
  for (const el of svg.querySelectorAll(REMOVED_ELEMENTS)) el.remove()
  for (const el of [svg, ...svg.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase()
      const external = (name === 'href' || name === 'xlink:href') && !attr.value.trim().startsWith('#')
      if (name.startsWith('on') || external) el.removeAttribute(attr.name)
    }
  }
  svg.setAttribute('width', '100%')
  svg.setAttribute('height', '100%')
  svg.setAttribute('style', 'display: block')
  return new XMLSerializer().serializeToString(svg)
}
