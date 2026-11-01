// Bundles the Electron main process (ESM), the preload script (CommonJS, required by sandboxed
// preloads) and the opendraw-mcp stdio bridge (a plain Node command).
const common = { target: 'node' as const, external: ['electron'], outdir: 'dist-electron' }

const results = await Promise.all([
  Bun.build({ ...common, entrypoints: ['./electron/main.ts'], format: 'esm', naming: 'main.js' }),
  Bun.build({ ...common, entrypoints: ['./electron/preload.ts'], format: 'cjs', naming: 'preload.cjs' }),
  Bun.build({
    ...common,
    entrypoints: ['./bin/opendraw-mcp.ts'],
    format: 'esm',
    naming: 'opendraw-mcp.mjs',
    banner: '#!/usr/bin/env node'
  })
])

for (const result of results) {
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
}

export {}
