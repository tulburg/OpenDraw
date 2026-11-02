// Fonts on this machine and Google Fonts loaded on demand (S-17 Req 1): a family used in a style that is
// not installed but is on Google Fonts gets its stylesheet added, so canvas, screenshots and exports match.
import { type FontFace, faceOf, sortFaces } from '../../shared/fonts'

export interface Family {
  family: string
  faces: FontFace[]
}

interface LocalFontData {
  family: string
  style: string
}

let local: Promise<Map<string, Family>> | null = null

/** Installed font families by lowercase name, from the Local Font Access API. */
export function localFamilies(): Promise<Map<string, Family>> {
  local ??= (async () => {
    const query = (window as unknown as { queryLocalFonts?: () => Promise<LocalFontData[]> }).queryLocalFonts
    const fonts = query ? await query() : []
    const families = new Map<string, Family>()
    for (const font of fonts) {
      const key = font.family.toLowerCase()
      const entry = families.get(key) ?? { family: font.family, faces: [] }
      entry.faces.push(faceOf(font.style))
      families.set(key, entry)
    }
    for (const entry of families.values()) entry.faces = sortFaces(entry.faces)
    return families
  })().catch((err) => {
    local = null
    throw err
  })
  return local
}

let google: Promise<Map<string, Family> | null> | null = null
const googleFamilies = () => {
  google ??= window.opendraw.googleFonts().then((list) => (list ? new Map(list.map((f) => [f.family.toLowerCase(), f])) : null))
  return google
}

const loaded = new Map<string, Promise<void>>()

function stylesheetURL({ family, faces }: Family): string {
  const name = encodeURIComponent(family).replace(/%20/g, '+')
  const italic = faces.some((f) => f.style === 'italic')
  const axes = italic
    ? sortFaces(faces).map((f) => `${f.style === 'italic' ? 1 : 0},${f.weight}`).sort().join(';')
    : sortFaces(faces).map((f) => f.weight).join(';')
  return `https://fonts.googleapis.com/css2?family=${name}:${italic ? 'ital,wght' : 'wght'}@${axes}&display=block`
}

function addStylesheet(family: Family): Promise<void> {
  return new Promise((resolve) => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = stylesheetURL(family)
    link.dataset.googleFont = family.family
    link.onload = () => resolve()
    link.onerror = () => resolve()
    document.head.appendChild(link)
  })
}

/** Adds Google Fonts stylesheets for families that are not installed; resolves once they are in. */
export async function ensureFonts(families: Iterable<string>): Promise<void> {
  const wanted = [...families].filter((f) => !loaded.has(f.toLowerCase()))
  if (wanted.length === 0) {
    await Promise.all([...families].map((f) => loaded.get(f.toLowerCase())))
    return
  }
  const [installed, catalog] = await Promise.all([localFamilies().catch(() => new Map<string, Family>()), googleFamilies().catch(() => null)])
  for (const name of wanted) {
    const key = name.toLowerCase()
    const entry = catalog?.get(key)
    if (installed.has(key) || !entry) continue
    loaded.set(key, addStylesheet(entry))
  }
  await Promise.all([...families].map((f) => loaded.get(f.toLowerCase())))
}
