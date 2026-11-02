// OpenDraw's MCP server (S-4, D-5): runs inside the app, serves Streamable HTTP on 127.0.0.1 only,
// and publishes its address and an access token in a discovery file for the stdio bridge.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  McpServer,
  originValidationResponse
} from '@modelcontextprotocol/server'
import { app, type BrowserWindow } from 'electron'

import { exportTools, readTools, resourceTools, SERVER_INSTRUCTIONS, writeTools } from '../../shared/mcp/definitions'
import * as read from '../../shared/mcp/read-tools'
import { layoutOf, requireFile, requireNode, requirePage, type Snapshot, ToolError, walk } from '../../shared/mcp/snapshot'
import { withTokens as withFileTokens } from '../../shared/tokens'
import { type ExportItem, runCombinedPDF, runExports } from '../export'
import * as resources from '../resource-tools'
import { fillImage } from './fill-image'
import { requestRenderer } from '../rpc'
import { computedStyles, type RenderTarget, screenshot } from './render'

export const MCP_PATH = '/mcp'

/** The artboard with the file's tokens set on it, as the canvas draws it (S-14). */
const withTokens = (snap: Snapshot, artboard: Snapshot['document']['pages'][number]['nodes'][number]) =>
  withFileTokens(artboard, snap.document.tokens)
const VERSION = '0.1.0'

export interface DiscoveryInfo {
  url: string
  token: string
  pid: number
}

export function discoveryFile(): string {
  return path.join(app.getPath('userData'), 'mcp.json')
}

type ToolResult = { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean }

const text = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
})

const failure = (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true })

interface ServerDeps {
  getWindow: () => BrowserWindow | null
  renderTarget: RenderTarget
}

function buildServer({ getWindow, renderTarget }: ServerDeps): McpServer {
  const server = new McpServer({ name: 'opendraw', version: VERSION }, { instructions: SERVER_INSTRUCTIONS })

  /** The document of an open tab: the one with `fileId`, else the one in front (S-13 Req 5). */
  const snapshot = async (fileId?: string): Promise<Snapshot> => {
    const win = getWindow()
    if (!win) throw new ToolError('OpenDraw has no document window open. Ask the user to open a file.')
    return requestRenderer<Snapshot>(win.webContents, 'mcp:snapshot', { fileId })
  }

  /** Wraps a tool so expected errors come back as tool errors the agent can read. */
  const tool = <A>(run: (args: A) => Promise<ToolResult>) => async (args: A) => {
    try {
      return await run(args)
    } catch (err) {
      return failure(err instanceof Error ? err.message : String(err))
    }
  }

  const pure = {
    get_basic_info: read.getBasicInfo,
    get_selection: read.getSelection,
    get_tree_summary: read.getTreeSummary,
    get_node_info: read.getNodeInfo,
    get_children: read.getChildren,
    find_nodes: read.findNodes,
    get_jsx: read.getJSX,
    get_tokens: read.getTokens
  } as const

  for (const [name, run] of Object.entries(pure)) {
    const def = readTools[name as keyof typeof pure]
    server.registerTool(
      name,
      { description: def.description, inputSchema: def.inputSchema, annotations: { readOnlyHint: true } },
      tool(async (args: any) => text((run as (s: Snapshot, a: unknown) => unknown)(await snapshot(args?.fileId), args)))
    )
  }

  server.registerTool(
    'get_computed_styles',
    {
      description: readTools.get_computed_styles.description,
      inputSchema: readTools.get_computed_styles.inputSchema,
      annotations: { readOnlyHint: true }
    },
    tool(async ({ fileId, nodeIds }: { fileId: string; nodeIds: string[] }) => {
      const snap = await snapshot(fileId)
      requireFile(snap, fileId)
      // Group by artboard so each artboard renders once.
      const byArtboard = new Map<string, { artboard: Snapshot['document']['pages'][number]['nodes'][number]; ids: string[] }>()
      for (const id of nodeIds) {
        const { artboard } = requireNode(snap, id)
        const entry = byArtboard.get(artboard.id) ?? { artboard, ids: [] }
        entry.ids.push(id)
        byArtboard.set(artboard.id, entry)
      }
      const result: Record<string, Record<string, string>> = {}
      for (const { artboard, ids } of byArtboard.values()) {
        Object.assign(result, await computedStyles(renderTarget, withTokens(snap, artboard), ids))
      }
      return text(result)
    })
  )

  server.registerTool(
    'get_screenshot',
    {
      description: readTools.get_screenshot.description,
      inputSchema: readTools.get_screenshot.inputSchema,
      annotations: { readOnlyHint: true }
    },
    tool(async ({ fileId, nodeId, scale }: { fileId: string; nodeId: string; scale?: number }) => {
      const snap = await snapshot(fileId)
      requireFile(snap, fileId)
      const { artboard } = requireNode(snap, nodeId)
      const png = await screenshot(renderTarget, withTokens(snap, artboard), nodeId, scale ?? 1)
      return { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] }
    })
  )

  // Writes run in the editor window against its document store (S-5), so the user sees them land.
  for (const [name, def] of Object.entries(writeTools)) {
    server.registerTool(
      name,
      { description: def.description, inputSchema: def.inputSchema, annotations: def.annotations },
      tool(async (args: unknown) => {
        const win = getWindow()
        if (!win) throw new ToolError('OpenDraw has no document window open. Ask the user to open a file.')
        return text(await requestRenderer(win.webContents, 'mcp:write', { tool: name, args }))
      })
    )
  }

  /** A layer as an export item: its artboard with tokens, its name and settings. */
  const exportItem = (snap: Snapshot, id: string): ExportItem => {
    const { node, artboard } = requireNode(snap, id)
    return { artboard: withTokens(snap, artboard), nodeId: node.id, name: node.name, settings: node.exports }
  }

  server.registerTool(
    'export',
    { description: exportTools.export.description, inputSchema: exportTools.export.inputSchema, annotations: exportTools.export.annotations },
    tool(async (args: { fileId: string; nodes: string[] | 'nodes-with-exports-only'; pageId?: string; type?: string }) => {
      if (args.type === 'video') throw new ToolError('Video export is not supported. Use type "image".')
      const snap = await snapshot(args.fileId)
      requireFile(snap, args.fileId)
      let ids: string[]
      if (args.nodes === 'nodes-with-exports-only') {
        ids = []
        walk(requirePage(snap, args.pageId).nodes, (n) => n.exports?.length && ids.push(n.id))
        if (ids.length === 0) throw new ToolError('No layer on this page has export settings.')
      } else ids = args.nodes
      const items = ids.map((id) => exportItem(snap, id))
      const files = await runExports(renderTarget, items)
      return text({ exports: files })
    })
  )

  server.registerTool(
    'export_combined_pdf',
    {
      description: exportTools.export_combined_pdf.description,
      inputSchema: exportTools.export_combined_pdf.inputSchema,
      annotations: exportTools.export_combined_pdf.annotations
    },
    tool(async ({ fileId, nodeIds }: { fileId: string; nodeIds: string[] }) => {
      const snap = await snapshot(fileId)
      requireFile(snap, fileId)
      // Canvas order: top to bottom, then left to right. Unmeasured layers fall back to their artboard's position.
      const position = (id: string) => {
        const l = layoutOf(snap, id)
        if (l.worldX !== null && l.worldY !== null) return { x: l.worldX, y: l.worldY }
        const { artboard } = requireNode(snap, id)
        return { x: parseFloat(String(artboard.style.left)) || 0, y: parseFloat(String(artboard.style.top)) || 0 }
      }
      const ordered = [...nodeIds].sort((a, b) => {
        const pa = position(a)
        const pb = position(b)
        return pa.y - pb.y || pa.x - pb.x
      })
      const path = await runCombinedPDF(renderTarget, ordered.map((id) => exportItem(snap, id)), snap.document.name)
      return text({ path, pages: ordered })
    })
  )

  server.registerTool(
    'get_fill_image',
    {
      description: exportTools.get_fill_image.description,
      inputSchema: exportTools.get_fill_image.inputSchema,
      annotations: { readOnlyHint: true }
    },
    tool(async ({ fileId, nodeId }: { fileId: string; nodeId: string }) => {
      const snap = await snapshot(fileId)
      requireFile(snap, fileId)
      const { node } = requireNode(snap, nodeId)
      return fillImage(node)
    })
  )

  const resourceRuns: Record<keyof typeof resourceTools, (args: any) => Promise<unknown>> = {
    list_resources: resources.listResources,
    create_file: (args) => resources.createFile(args, getWindow),
    create_folder: resources.createFolder,
    move_resources: resources.moveResources,
    rename_resource: resources.renameResource,
    archive_resources: (args) => resources.setArchived(args, true),
    unarchive_resources: (args) => resources.setArchived(args, false),
    open_file: async (args) => {
      const id = await resources.openFile(args, getWindow)
      return read.getBasicInfo(await snapshot(id), { fileId: id })
    }
  }
  for (const [name, def] of Object.entries(resourceTools)) {
    server.registerTool(
      name,
      { description: def.description, inputSchema: def.inputSchema, annotations: def.annotations },
      tool(async (args: unknown) => text(await resourceRuns[name as keyof typeof resourceTools](args)))
    )
  }

  return server
}

function bearerMatches(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.startsWith('Bearer ') ? header.slice(7) : '')
  const expected = Buffer.from(token)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

async function toRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(key, v)
    else if (value !== undefined) headers.set(key, value)
  }
  const body = chunks.length > 0 && req.method !== 'GET' && req.method !== 'HEAD' ? Buffer.concat(chunks) : undefined
  return new Request(new URL(req.url ?? '/', origin), { method: req.method, headers, body })
}

async function sendResponse(res: ServerResponse, response: Response) {
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
  if (!response.body) {
    res.end()
    return
  }
  const reader = response.body.getReader()
  res.on('close', () => void reader.cancel().catch(() => undefined))
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    res.write(value)
  }
  res.end()
}

export async function startMcpServer(deps: ServerDeps): Promise<{ info: DiscoveryInfo; stop: () => void }> {
  const handler = createMcpHandler(() => buildServer(deps), {
    legacy: 'stateless',
    onerror: (err) => console.error('[mcp]', err.message)
  })
  const token = randomBytes(32).toString('hex')

  const http = createServer(async (req, res) => {
    try {
      const origin = `http://${req.headers.host ?? '127.0.0.1'}`
      if (new URL(req.url ?? '/', origin).pathname !== MCP_PATH) {
        res.writeHead(404).end()
        return
      }
      const request = await toRequest(req, origin)
      // Block DNS rebinding and browser pages, then require the token from the discovery file.
      const rejected =
        hostHeaderValidationResponse(request, localhostAllowedHostnames()) ??
        originValidationResponse(request, localhostAllowedOrigins())
      if (rejected) return void (await sendResponse(res, rejected))
      if (!bearerMatches(req.headers.authorization, token)) {
        res.writeHead(401, { 'content-type': 'text/plain' }).end('Missing or wrong OpenDraw MCP token')
        return
      }
      await sendResponse(res, await handler.fetch(request))
    } catch (err) {
      console.error('[mcp] request failed', err)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    }
  })

  const port = Number(process.env.OPENDRAW_MCP_PORT ?? 0)
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(port, '127.0.0.1', () => resolve())
  })
  const { port: actualPort } = http.address() as AddressInfo
  const info: DiscoveryInfo = { url: `http://127.0.0.1:${actualPort}${MCP_PATH}`, token, pid: process.pid }
  // Readable only by this user: the token grants control of the open document.
  writeFileSync(discoveryFile(), JSON.stringify(info, null, 2), { mode: 0o600 })

  return {
    info,
    stop: () => {
      http.close()
      try {
        rmSync(discoveryFile())
      } catch {
        // Already gone.
      }
    }
  }
}
