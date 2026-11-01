// Style overrides drawn while a gesture is in progress (a drag, a resize, a burst of nudges). They
// change only what is rendered; the document changes once, in one undo step, when the gesture ends.
import { createContext } from 'react'

import type { CSSStyle } from '../../shared/document'

export type Preview = Record<string, CSSStyle>

export const PreviewContext = createContext<Preview>({})
