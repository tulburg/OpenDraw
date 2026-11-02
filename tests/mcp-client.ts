// A minimal MCP client that talks to the opendraw-mcp stdio bridge, the way Claude Code does.
import path from 'node:path'

import type { Subprocess } from 'bun'

const ROOT = path.resolve(import.meta.dir, '..')

export class BridgeClient {
  private nextId = 1
  private buffer = ''
  private waiting = new Map<number, (message: any) => void>()
  /** The server's initialize result: its info and instructions. */
  initialized: any = null

  private constructor(private proc: Subprocess<'pipe', 'pipe', 'inherit'>) {
    void this.readLoop()
  }

  static start(discoveryFile: string): Promise<BridgeClient> {
    return BridgeClient.spawn(['node', path.join(ROOT, 'dist-electron/opendraw-mcp.mjs')], { OPENDRAW_MCP_DISCOVERY: discoveryFile })
  }

  /** Runs the bridge the way an MCP client config does: a command, its arguments and extra env (S-20). */
  static async spawn(command: string[], env: Record<string, string>): Promise<BridgeClient> {
    const proc = Bun.spawn(command, {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
      env: { ...process.env, ...env }
    })
    const client = new BridgeClient(proc)
    client.initialized = await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'opendraw-tests', version: '0' }
    })
    client.notify('notifications/initialized')
    return client
  }

  private async readLoop() {
    const decoder = new TextDecoder()
    for await (const chunk of this.proc.stdout) {
      this.buffer += decoder.decode(chunk)
      const lines = this.buffer.split('\n')
      this.buffer = lines.pop()!
      for (const line of lines) {
        if (!line.trim()) continue
        const message = JSON.parse(line)
        this.waiting.get(message.id)?.(message)
        this.waiting.delete(message.id)
      }
    }
  }

  notify(method: string, params?: object) {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    this.proc.stdin.flush()
  }

  request(method: string, params?: object, timeoutMs = 20_000): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs)
      this.waiting.set(id, (message) => {
        clearTimeout(timer)
        if (message.error) reject(new Error(message.error.message))
        else resolve(message.result)
      })
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      this.proc.stdin.flush()
    })
  }

  /** Calls a tool; returns parsed JSON for text results, or the raw result for images and errors. */
  async call(name: string, args: object = {}): Promise<any> {
    const result = await this.request('tools/call', { name, arguments: args })
    if (result.isError) throw new Error(`${name} failed: ${result.content?.[0]?.text}`)
    const first = result.content[0]
    if (first.type !== 'text') return result
    try {
      return JSON.parse(first.text)
    } catch {
      return first.text
    }
  }

  async callRaw(name: string, args: object = {}): Promise<any> {
    return this.request('tools/call', { name, arguments: args })
  }

  close() {
    this.proc.kill()
  }
}
