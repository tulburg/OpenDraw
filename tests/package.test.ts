// Packaging and connecting agents (S-20). Builds the app with electron-builder (`bun run dist`), then
// checks the dev build's Connect and About dialogs and the packaged app: launch on a clean profile,
// the bundled bridge run with the app's own binary as Node, and the Connect command's paths.
// Run with `bun run test:package`; set OPENDRAW_SKIP_DIST=1 to reuse an existing release/ build.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { App, cleanProfile } from './cdp'
import { check, expect, finish } from './checks'
import { BridgeClient } from './mcp-client'

const ROOT = path.resolve(import.meta.dir, '..')
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const { version } = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string }

if (!process.env.OPENDRAW_SKIP_DIST) {
  const built = Bun.spawnSync(['bun', 'run', 'dist'], { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' })
  if (built.exitCode !== 0) throw new Error('bun run dist failed')
}

interface ClientConfig {
  mcpServers: { opendraw: { command: string; args: string[]; env: Record<string, string> } }
}

const openConnect = async (app: App) => {
  await app.eval(`window.opendrawTest.showDialog('connect'), true`)
  await app.waitFor(`!!document.querySelector('[data-testid=connect-json]')`)
  return {
    command: await app.eval<string>(`document.querySelector('[data-testid=connect-command]').textContent`),
    config: JSON.parse(await app.eval<string>(`document.querySelector('[data-testid=connect-json]').textContent`)) as ClientConfig
  }
}

const clickOn = async (app: App, selector: string) => {
  const r = await app.rect(selector)
  await app.click(r.x + r.width / 2, r.y + r.height / 2)
}

const runBridge = (config: ClientConfig) => {
  const { command, args, env } = config.mcpServers.opendraw
  return BridgeClient.spawn([command, ...args], env)
}

// The dev build: dialogs and the bridge run the way the Connect dialog says.
const dev = await App.launch(cleanProfile(), 9341)
try {
  await check('The home view opens Connect an agent; it shows the command and JSON for this app', async () => {
    await clickOn(dev, '[data-testid=home-button]')
    await dev.waitFor(`!!document.querySelector('[data-testid=browser-connect]')`)
    await clickOn(dev, '[data-testid=browser-connect]')
    await dev.waitFor(`!!document.querySelector('[data-testid=connect-dialog]')`)
    await dev.key('Escape', 'Escape', 0, 27)
    await dev.waitFor(`!document.querySelector('[data-testid=connect-dialog]')`)
    const { command, config } = await openConnect(dev)
    const server = config.mcpServers.opendraw
    expect(command.startsWith('claude mcp add opendraw '), command)
    expect(command.includes(server.args[0]) && command.includes(server.command), `command ${command} does not use ${server.command} ${server.args[0]}`)
    expect(server.env.ELECTRON_RUN_AS_NODE === '1', JSON.stringify(server.env))
    expect(existsSync(server.args[0]), `no bridge at ${server.args[0]}`)
    return `opened from the home view; ${command}`
  })

  await check('The Connect dialog shows "connected" while a bridge started from its JSON is attached', async () => {
    const before = await dev.eval<string>(`document.querySelector('[data-testid=agent-status]').dataset.state`)
    const { config } = await openConnect(dev)
    const client = await runBridge(config)
    try {
      const tools = (await client.request('tools/list')).tools as { name: string }[]
      expect(tools.some((t) => t.name === 'get_basic_info'), 'tools/list has no get_basic_info')
      await dev.waitFor(`document.querySelector('[data-testid=agent-status]').dataset.state === 'connected'`)
      return `${before} before; connected with the bridge attached; ${tools.length} tools`
    } finally {
      client.close()
    }
  })

  await check('The About window shows the version from package.json and the MCP port', async () => {
    await dev.key('Escape', 'Escape', 0, 27)
    await dev.eval(`window.opendrawTest.showDialog('about'), true`)
    await dev.waitFor(`!!document.querySelector('[data-testid=about-mcp]') && /port/.test(document.querySelector('[data-testid=about-mcp]').textContent)`)
    const shown = await dev.eval<{ version: string; mcp: string }>(
      `({ version: document.querySelector('[data-testid=about-version]').textContent, mcp: document.querySelector('[data-testid=about-mcp]').textContent })`
    )
    const info = await dev.eval<{ mcp: { port: number } }>(`window.opendraw.appInfo()`)
    expect(shown.version.startsWith(version), `version shown ${shown.version}, package.json ${version}`)
    expect(shown.mcp.includes(String(info.mcp.port)), `${shown.mcp} vs port ${info.mcp.port}`)
    return `${shown.version}; ${shown.mcp}`
  })
} finally {
  await dev.kill()
}

// The packaged app.
const release = path.join(ROOT, 'release')
const dmg = existsSync(release) ? readdirSync(release).find((f) => f.endsWith('.dmg')) : undefined
const appDir = existsSync(release) ? readdirSync(release).find((f) => f.startsWith('mac') && existsSync(path.join(release, f, 'OpenDraw.app'))) : undefined
const bundle = appDir ? path.join(release, appDir, 'OpenDraw.app') : ''

await check('The build produces a DMG; its app launches on a clean profile and opens a new file', async () => {
  expect(!!dmg, `no .dmg in ${release}`)
  expect(!!appDir, `no OpenDraw.app in ${release}`)
  const plist = readFileSync(path.join(bundle, 'Contents', 'Info.plist'), 'utf8')
  expect(plist.includes(`<string>${version}</string>`), 'Info.plist does not carry the package.json version')
  const packaged = await App.launch(cleanProfile(), 9342, path.join(bundle, 'Contents', 'MacOS', 'OpenDraw'))
  try {
    const artboards = await packaged.eval<number>(`document.querySelectorAll('[data-node-type=artboard]').length`)
    expect(artboards === 1, `${artboards} artboards`)
  } finally {
    await packaged.kill()
  }
  return `${dmg}; ${path.relative(ROOT, bundle)} opened a new file`
})

await check("The packaged app's Connect command runs its bundled bridge with the app as Node and lists OpenDraw's tools", async () => {
  const packaged = await App.launch(cleanProfile(), 9343, path.join(bundle, 'Contents', 'MacOS', 'OpenDraw'))
  try {
    const { command, config } = await openConnect(packaged)
    const server = config.mcpServers.opendraw
    expect(server.command.startsWith(bundle), `runtime ${server.command} is not inside ${bundle}`)
    expect(server.args[0].startsWith(path.join(bundle, 'Contents', 'Resources', 'app.asar.unpacked')), `bridge ${server.args[0]}`)
    const versionRun = Bun.spawnSync([server.command, server.args[0], '--version'], { env: { ...process.env, ...server.env } })
    const printed = versionRun.stdout.toString().trim()
    expect(printed === `opendraw-mcp ${version}`, `--version printed "${printed}"`)
    const client = await runBridge(config)
    try {
      const tools = (await client.request('tools/list')).tools as { name: string }[]
      expect(tools.length > 20, `${tools.length} tools`)
      await packaged.waitFor(`document.querySelector('[data-testid=agent-status]').dataset.state === 'connected'`)
      await sleep(100)
      return `${printed}; ${tools.length} tools; dialog shows connected; ${command}`
    } finally {
      client.close()
    }
  } finally {
    await packaged.kill()
  }
})

await finish('package')
