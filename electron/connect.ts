// Connecting an agent and the About window (S-20): the exact command for Claude Code, the JSON for
// other MCP clients, and the app's status, all from the paths of the running app.
import { homedir } from 'node:os'
import path from 'node:path'

import { app } from 'electron'

import type { AppInfo } from '../shared/app-info'
import { agentConnected, discoveryFile, type DiscoveryInfo } from './mcp/server'
import { workspaceDir } from './workspace'

/** Where the bridge looks for the discovery file when OPENDRAW_MCP_DISCOVERY is not set (bin/opendraw-mcp.ts). */
function bridgeDefaultDiscovery(): string {
  if (process.platform === 'darwin') return path.join(homedir(), 'Library', 'Application Support', 'OpenDraw', 'mcp.json')
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'), 'OpenDraw', 'mcp.json')
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'OpenDraw', 'mcp.json')
}

/** The bridge script. Packaged, it sits outside the asar archive so Electron-as-Node can run it. */
export function bridgePath(here: string): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', 'dist-electron', 'opendraw-mcp.mjs') : path.join(here, 'opendraw-mcp.mjs')
}

const shellQuote = (value: string) => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`)

export function appInfo(here: string, mcp: DiscoveryInfo | null): AppInfo {
  // The app's own binary runs the bridge as plain Node, so users need no Node install.
  const runtime = process.execPath
  const bridge = bridgePath(here)
  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1' }
  if (discoveryFile() !== bridgeDefaultDiscovery()) env.OPENDRAW_MCP_DISCOVERY = discoveryFile()
  const command = [
    'claude mcp add opendraw',
    ...Object.entries(env).map(([k, v]) => `-e ${k}=${shellQuote(v)}`),
    '--',
    shellQuote(runtime),
    shellQuote(bridge)
  ].join(' ')
  const json = JSON.stringify({ mcpServers: { opendraw: { command: runtime, args: [bridge], env } } }, null, 2)
  return {
    version: app.getVersion(),
    packaged: app.isPackaged,
    mcp: mcp ? { running: true, port: Number(new URL(mcp.url).port), url: mcp.url } : { running: false, port: null, url: null },
    agentConnected: agentConnected(),
    workspace: workspaceDir(),
    runtime,
    bridge,
    command,
    json
  }
}
