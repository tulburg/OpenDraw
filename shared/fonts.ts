// Font families (S-17): which families a document uses, and how font style names map to weights.

const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong', 'inherit', 'initial', 'unset'])

/** The named families in a CSS font-family list, without quotes or generic families. */
export function parseFamilies(value: string): string[] {
  return value
    .split(',')
    .map((f) => f.trim().replace(/^["']|["']$/g, '').trim())
    .filter((f) => f && !GENERIC.has(f.toLowerCase()) && !f.startsWith('var(') && !f.startsWith('-apple-system'))
}

/** Every family named in a `fontFamily` anywhere in a value: nodes, text spans, tokens. */
export function familiesIn(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) familiesIn(v, into)
  else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (key === 'fontFamily' && typeof v === 'string') for (const f of parseFamilies(v)) into.add(f)
      else if (typeof v === 'object') familiesIn(v, into)
    }
  }
  return into
}

const WEIGHT_NAMES: [RegExp, number][] = [
  [/hairline|thin/i, 100],
  [/extra\s*light|ultra\s*light/i, 200],
  [/semi\s*light|demi\s*light/i, 350],
  [/light/i, 300],
  [/medium/i, 500],
  [/semi\s*bold|demi\s*bold/i, 600],
  [/extra\s*bold|ultra\s*bold/i, 800],
  [/black|heavy/i, 900],
  [/bold/i, 700]
]

/** A face's weight and style from its style name ("Bold Italic" is 700 italic). */
export function faceOf(styleName: string): { weight: number; style: 'normal' | 'italic' } {
  const weight = WEIGHT_NAMES.find(([pattern]) => pattern.test(styleName))?.[1] ?? 400
  return { weight, style: /italic|oblique/i.test(styleName) ? 'italic' : 'normal' }
}

export interface FontFace {
  weight: number
  style: 'normal' | 'italic'
}

export const sortFaces = (faces: FontFace[]) => {
  const seen = new Set<string>()
  return faces
    .filter((f) => {
      const key = `${f.weight}${f.style}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => a.weight - b.weight || a.style.localeCompare(b.style))
}
