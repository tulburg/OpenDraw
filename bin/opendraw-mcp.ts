// `opendraw-mcp`: a stdio MCP server for clients like Claude Code that forwards each JSON-RPC message
// to the MCP server running inside the OpenDraw app (S-4 Req 2). It reads the app's discovery file
// on every message, so it follows the app across restarts. With the app closed it still answers
// initialize and tools/list, and every tool call returns a clear "not running" error.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'

import { z } from 'zod'

import { exportTools, NOT_RUNNING_MESSAGE, readTools, resourceTools, SERVER_INSTRUCTIONS, writeTools } from '../shared/mcp/definitions'

interface Discovery {
  url: string
  token: string
}

/** Set from package.json when the bridge is built (scripts/build-electron.ts). */
declare const OPENDRAW_VERSION: string

if (process.argv.includes('--version')) {
  process.stdout.write(`opendraw-mcp ${OPENDRAW_VERSION}\n`)
  process.exit(0)
}

/** How often the bridge tells the app it is attached (S-20), so the app can show an agent as connected. */
const CHECK_IN_MS = 5000

type Message = { jsonrpc: '2.0'; id?: string | number | null; method?: string; params?: any; result?: unknown; error?: unknown }

function appDataDir(): string {
  if (process.platform === 'darwin') return path.join(homedir(), 'Library', 'Application Support')
  if (process.platform === 'win32') return process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming')
  return process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config')
}

function discoveryPath(): string {
  return process.env.OPENDRAW_MCP_DISCOVERY ?? path.join(appDataDir(), 'OpenDraw', 'mcp.json')
}

function readDiscovery(): Discovery | null {
  try {
    const info = JSON.parse(readFileSync(discoveryPath(), 'utf8')) as Discovery
    return info.url && info.token ? info : null
  } catch {
    return null
  }
}

const write = (message: Message) => process.stdout.write(`${JSON.stringify(message)}\n`)

let protocolVersion: string | undefined

/** Answers a request locally when the app is not running. */
function answerOffline(message: Message): Message | null {
  if (message.id === undefined || message.id === null) return null
  switch (message.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'opendraw', version: '0.1.0' },
          instructions: SERVER_INSTRUCTIONS
        }
      }
    case 'ping':
      return { jsonrpc: '2.0', id: message.id, result: {} }
    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [
            ...Object.entries(readTools).map(([name, def]) => ({
              name,
              description: def.description,
              inputSchema: z.toJSONSchema(def.inputSchema),
              annotations: { readOnlyHint: true }
            })),
            ...Object.entries({ ...writeTools, ...resourceTools, ...exportTools }).map(([name, def]) => ({
              name,
              description: def.description,
              inputSchema: z.toJSONSchema(def.inputSchema),
              annotations: def.annotations
            }))
          ]
        }
      }
    case 'tools/call':
      return { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: NOT_RUNNING_MESSAGE }], isError: true } }
    default:
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: NOT_RUNNING_MESSAGE } }
  }
}

/** Parses a JSON or SSE response body into the JSON-RPC messages it carries. */
async function messagesFrom(response: Response): Promise<Message[]> {
  const body = await response.text()
  if (!body.trim()) return []
  if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    return body
      .split(/\r?\n\r?\n/)
      .map((event) =>
        event
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
      )
      .filter((data) => data.length > 0)
      .map((data) => JSON.parse(data) as Message)
  }
  const parsed = JSON.parse(body) as Message | Message[]
  return Array.isArray(parsed) ? parsed : [parsed]
}

async function forward(message: Message) {
  const discovery = readDiscovery()
  const offline = () => {
    const answer = answerOffline(message)
    if (answer) write(answer)
  }
  if (!discovery) return offline()

  let response: Response
  try {
    response = await fetch(discovery.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${discovery.token}`,
        ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {})
      },
      body: JSON.stringify(message)
    })
  } catch {
    // The discovery file is left over from an app that is no longer running.
    return offline()
  }

  if (!response.ok && response.status !== 202) {
    if (message.id !== undefined && message.id !== null) {
      write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32603, message: `OpenDraw answered HTTP ${response.status}: ${(await response.text()).slice(0, 200)}` }
      })
    }
    return
  }
  for (const reply of await messagesFrom(response)) {
    if (message.method === 'initialize' && reply.result) {
      protocolVersion = (reply.result as { protocolVersion?: string }).protocolVersion
    }
    write(reply)
  }
}

const checkIn = () => {
  const discovery = readDiscovery()
  if (!discovery) return
  fetch(new URL('/agent', discovery.url), { method: 'POST', headers: { authorization: `Bearer ${discovery.token}` } }).catch(() => undefined)
}
checkIn()
setInterval(checkIn, CHECK_IN_MS).unref()

// Messages are handled in order, so responses come back in the order requests arrived.
let chain = Promise.resolve()
const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  if (!line.trim()) return
  let message: Message
  try {
    message = JSON.parse(line) as Message
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }
  chain = chain.then(() => forward(message)).catch((err) => console.error('[opendraw-mcp]', err))
})
lines.on('close', () => {
  void chain.then(() => process.exit(0))
})
