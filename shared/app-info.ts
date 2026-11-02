/** The app's status for the Connect an agent dialog and the About window (S-20). */
export interface AppInfo {
  version: string
  packaged: boolean
  mcp: { running: boolean; port: number | null; url: string | null }
  /** A bridge checked in within the last few seconds. */
  agentConnected: boolean
  workspace: string
  /** The executable that runs the bridge (this app, as Node) and the bridge script. */
  runtime: string
  bridge: string
  /** `claude mcp add ...` for Claude Code, and the JSON for other MCP clients. */
  command: string
  json: string
}
