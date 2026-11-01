import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'src',
  base: './',
  plugins: [react()],
  server: { port: 5199, strictPort: true },
  build: { outDir: '../dist', emptyOutDir: true }
})
