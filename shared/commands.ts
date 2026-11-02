// File and View commands (S-24): one list for the menu bar, the zoom menu in the top bar and the keys.
// Menu shortcuts are shown but not registered, so the keys reach the renderer, which skips them while
// the user types in a field.

export type FileCommand = 'new-file' | 'open' | 'duplicate-file' | 'rename-file' | 'close-tab' | 'close-window'
export type ViewCommand = 'zoom-in' | 'zoom-out' | 'zoom-100' | 'zoom-fit' | 'zoom-selection'

export interface CommandItem<T extends string> {
  command: T
  label: string
  /** An Electron accelerator. */
  accelerator?: string
}

export const FILE_ITEMS: (CommandItem<FileCommand> | null)[] = [
  { command: 'new-file', label: 'New File', accelerator: 'CmdOrCtrl+N' },
  { command: 'open', label: 'Open...', accelerator: 'CmdOrCtrl+O' },
  null,
  { command: 'duplicate-file', label: 'Duplicate File' },
  { command: 'rename-file', label: 'Rename File...' },
  null,
  { command: 'close-tab', label: 'Close Tab', accelerator: 'CmdOrCtrl+W' },
  { command: 'close-window', label: 'Close Window', accelerator: 'Shift+CmdOrCtrl+W' }
]

export const VIEW_ITEMS: CommandItem<ViewCommand>[] = [
  { command: 'zoom-in', label: 'Zoom In', accelerator: 'CmdOrCtrl+=' },
  { command: 'zoom-out', label: 'Zoom Out', accelerator: 'CmdOrCtrl+-' },
  { command: 'zoom-100', label: 'Zoom to 100%', accelerator: 'CmdOrCtrl+0' },
  { command: 'zoom-fit', label: 'Zoom to Fit', accelerator: 'Shift+1' },
  { command: 'zoom-selection', label: 'Zoom to Selection', accelerator: 'Shift+2' }
]

/** The command a key press stands for, if any. */
export function fileShortcut(event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): FileCommand | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null
  const key = event.key.toLowerCase()
  if (key === 'w') return event.shiftKey ? 'close-window' : 'close-tab'
  if (event.shiftKey) return null
  return key === 'n' ? 'new-file' : key === 'o' ? 'open' : null
}

/** An accelerator as the platform writes it in menus, for the zoom menu. */
export function shortcutLabel(accelerator: string, mac: boolean): string {
  const keys = accelerator.split('+')
  if (!mac) return keys.map((k) => (k === 'CmdOrCtrl' ? 'Ctrl' : k)).join('+')
  const symbols: Record<string, string> = { CmdOrCtrl: '⌘', Shift: '⇧', Alt: '⌥' }
  return keys.map((k) => symbols[k] ?? k).join('')
}
