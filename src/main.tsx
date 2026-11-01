import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import type { OpenDrawAPI } from '../electron/preload'
import { App } from './App'
import { RenderView } from './render/RenderView'
import './styles.css'

declare global {
  interface Window {
    opendraw: OpenDrawAPI
  }
}

const isRenderWindow = location.hash === '#render'
if (isRenderWindow) document.documentElement.dataset.render = ''

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isRenderWindow ? <RenderView /> : <App />}</StrictMode>
)
