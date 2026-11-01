// `bun run dev`: starts the Vite dev server, bundles the Electron main and preload, then opens the window.
import { createServer } from 'vite'

const server = await createServer({ configFile: 'vite.config.ts' })
await server.listen()
const url = server.resolvedUrls?.local[0]
if (!url) throw new Error('Vite dev server did not report a URL')

const build = Bun.spawnSync(['bun', 'scripts/build-electron.ts'], { stdout: 'inherit', stderr: 'inherit' })
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1)

const electronPath = (await import('electron')).default as unknown as string
const electron = Bun.spawn([electronPath, '.'], {
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
  stdout: 'inherit',
  stderr: 'inherit'
})

// Stopping the dev command (ctrl+C) closes the window too.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => electron.kill(signal))

const exitCode = await electron.exited
await server.close()
process.exit(exitCode)
