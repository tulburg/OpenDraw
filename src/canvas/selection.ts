// Which layer a click picks (S-6 Req 1). Layers are found through the rendered DOM: each node is an
// element with data-node-id, nested the same way as the document.

export function nodeElement(root: ParentNode, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`)
}

/** The parent layer's ID, or null for an artboard. */
export function parentIdOf(root: ParentNode, id: string): string | null {
  return nodeElement(root, id)?.parentElement?.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId ?? null
}

/**
 * The layers under an event target, from its artboard down to the deepest one. A locked layer and
 * everything inside it are passed through (S-18 Req 4): the path stops above it.
 */
export function pathAt(target: EventTarget | null): string[] {
  const path: HTMLElement[] = []
  let el = target instanceof Element ? target.closest<HTMLElement>('[data-node-id]') : null
  while (el) {
    path.unshift(el)
    el = el.parentElement?.closest<HTMLElement>('[data-node-id]') ?? null
  }
  const locked = path.findIndex((e) => e.hasAttribute('data-locked'))
  return (locked === -1 ? path : path.slice(0, locked)).map((e) => e.dataset.nodeId!)
}

/**
 * A click picks the layer at the depth the user is working at: a sibling of a selected layer when
 * the click lands inside that layer's parent, otherwise the artboard's direct child (or the artboard
 * itself when nothing else is under the cursor).
 */
export function pickAtDepth(path: string[], selection: string[], parentOf: (id: string) => string | null): string {
  if (path.length === 1) return path[0]
  for (const id of selection) {
    const parent = parentOf(id)
    const at = parent ? path.indexOf(parent) : -1
    if (at !== -1 && at + 1 < path.length) return path[at + 1]
  }
  return path[1]
}

/** Double-click goes one level below the selected layer, along the path under the cursor. */
export function deeper(path: string[], selection: string[]): string | null {
  for (const id of selection) {
    const at = path.indexOf(id)
    if (at !== -1 && at + 1 < path.length) return path[at + 1]
  }
  return null
}
