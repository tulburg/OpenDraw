// Long panel lists render only the rows in view (S-21 Req 4). Rows have one fixed height; the list
// sits somewhere inside a scrolling panel, so the window is worked out from the panel's scroll position.
import { type RefObject, useCallback, useLayoutEffect, useState } from 'react'

/** Rows drawn above and below the visible ones, so a fast scroll does not show blank space. */
const OVERSCAN = 12

export interface RowWindow {
  start: number
  end: number
  /** Space for the rows not drawn above and below the window, in px. */
  before: number
  after: number
  /** Scrolls the panel just enough to show row `index`. */
  reveal: (index: number) => void
}

export function useRowWindow(scroller: RefObject<HTMLElement | null>, list: RefObject<HTMLElement | null>, count: number, rowHeight: number): RowWindow {
  const [view, setView] = useState({ top: 0, height: 800 })
  const measure = useCallback(() => {
    const panel = scroller.current
    const el = list.current
    if (!panel || !el) return
    // The list's top within the panel's scrolled content.
    const offset = el.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop
    const next = { top: panel.scrollTop - offset, height: panel.clientHeight }
    setView((prev) => (prev.top === next.top && prev.height === next.height ? prev : next))
  }, [scroller, list])

  useLayoutEffect(() => {
    const panel = scroller.current
    if (!panel) return
    measure()
    panel.addEventListener('scroll', measure, { passive: true })
    const observer = new ResizeObserver(measure)
    observer.observe(panel)
    return () => {
      panel.removeEventListener('scroll', measure)
      observer.disconnect()
    }
  }, [scroller, measure])

  const start = Math.max(0, Math.min(count, Math.floor(view.top / rowHeight) - OVERSCAN))
  const end = Math.max(start, Math.min(count, Math.ceil((view.top + view.height) / rowHeight) + OVERSCAN))

  const reveal = useCallback(
    (index: number) => {
      const panel = scroller.current
      const el = list.current
      if (!panel || !el) return
      const offset = el.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop
      const top = offset + index * rowHeight
      if (top < panel.scrollTop) panel.scrollTop = top
      else if (top + rowHeight > panel.scrollTop + panel.clientHeight) panel.scrollTop = top + rowHeight - panel.clientHeight
    },
    [scroller, list, rowHeight]
  )

  return { start, end, before: start * rowHeight, after: (count - end) * rowHeight, reveal }
}
