// The page list (S-12): pages and dividers in order. Pages stay in `document.pages`; dividers sit
// between them by index, so code that walks pages never meets a divider.
import { type DesignDocument, newId, type Page, type PageIcon } from './document'

export type PageListItem =
  | { type: 'page'; id: string; name: string; icon?: PageIcon }
  | { type: 'divider'; id: string }

export class PageError extends Error {}

/** Pages and dividers in list order. */
export function pageList(doc: DesignDocument): PageListItem[] {
  const dividers = [...(doc.dividers ?? [])]
  const out: PageListItem[] = []
  const flush = (index: number) => {
    while (dividers.length > 0 && dividers[0].index <= index) out.push({ type: 'divider', id: dividers.shift()!.id })
  }
  doc.pages.forEach((page, i) => {
    flush(i)
    out.push({ type: 'page', id: page.id, name: page.name, ...(page.icon ? { icon: page.icon } : {}) })
  })
  flush(Infinity)
  return out
}

/**
 * Puts pages and dividers in `order`: every page and divider ID once, except removed dividers, and
 * `{type: 'divider'}` for a new one. Throws without changing anything if the order is incomplete,
 * unknown or repeats an ID. Returns the document and the IDs given to new dividers.
 */
export function arrangePages(
  doc: DesignDocument,
  order: (string | { type: 'divider' })[],
  removeDividerIds: string[] = []
): { document: DesignDocument; newDividerIds: string[] } {
  const pages = new Map(doc.pages.map((p) => [p.id, p]))
  const dividers = new Set((doc.dividers ?? []).map((d) => d.id))
  for (const id of removeDividerIds) if (!dividers.has(id)) throw new PageError(`No divider with ID ${id}`)
  const seen = new Set<string>()
  const newDividerIds: string[] = []
  const nextPages: Page[] = []
  const nextDividers: { id: string; index: number }[] = []
  for (const item of order) {
    if (typeof item === 'object' && item?.type === 'divider') {
      const id = newId()
      newDividerIds.push(id)
      nextDividers.push({ id, index: nextPages.length })
      continue
    }
    if (typeof item !== 'string') throw new PageError(`Not a page ID or {type: "divider"}: ${JSON.stringify(item)}`)
    if (seen.has(item)) throw new PageError(`${item} is listed more than once`)
    seen.add(item)
    if (pages.has(item)) nextPages.push(pages.get(item)!)
    else if (dividers.has(item)) {
      if (removeDividerIds.includes(item)) throw new PageError(`Divider ${item} is both listed and removed`)
      nextDividers.push({ id: item, index: nextPages.length })
    } else throw new PageError(`No page or divider with ID ${item}`)
  }
  const missing = [...pages.keys(), ...[...dividers].filter((id) => !removeDividerIds.includes(id))].filter((id) => !seen.has(id))
  if (missing.length > 0) throw new PageError(`The order leaves out ${missing.join(', ')}; pass every page and divider`)
  return { document: { ...doc, pages: nextPages, dividers: nextDividers }, newDividerIds }
}

/** "Page N" for the first N not taken. */
export function nextPageName(doc: DesignDocument): string {
  const names = new Set(doc.pages.map((p) => p.name))
  let n = doc.pages.length + 1
  while (names.has(`Page ${n}`)) n++
  return `Page ${n}`
}
