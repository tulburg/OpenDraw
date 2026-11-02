// The Connect an agent dialog and the About window (S-20), opened from the menu bar or the home view.
import { useEffect, useState } from 'react'

import type { AppInfo } from '../shared/app-info'

export type AppDialog = 'connect' | 'about'

/** While a dialog is open, the status refreshes so "connected" follows the agent. */
const REFRESH_MS = 2000

function useAppInfo(): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => {
    let live = true
    const load = () => void window.opendraw.appInfo().then((next) => live && setInfo(next))
    load()
    const timer = setInterval(load, REFRESH_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [])
  return info
}

function CopyBlock({ label, text, testId }: { label: string; text: string; testId: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="copy-block">
      <div className="copy-block-head">
        <span>{label}</span>
        <button
          type="button"
          data-testid={`${testId}-copy`}
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre data-testid={testId}>{text}</pre>
    </div>
  )
}

function AgentStatus({ info }: { info: AppInfo }) {
  const state = !info.mcp.running ? 'stopped' : info.agentConnected ? 'connected' : 'waiting'
  const label = state === 'stopped' ? 'MCP server is not running' : state === 'connected' ? 'Agent connected' : 'No agent connected'
  return (
    <div className="agent-status" data-testid="agent-status" data-state={state}>
      <span className="agent-status-dot" />
      {label}
    </div>
  )
}

export function AppDialogs({ open, onClose }: { open: AppDialog | null; onClose: () => void }) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="confirm-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      {open === 'connect' ? <ConnectDialog onClose={onClose} /> : <AboutDialog onClose={onClose} />}
    </div>
  )
}

function ConnectDialog({ onClose }: { onClose: () => void }) {
  const info = useAppInfo()
  return (
    <div className="confirm-dialog app-dialog" data-testid="connect-dialog" role="dialog" aria-label="Connect an agent">
      <h2>Connect an agent</h2>
      {info && (
        <>
          <AgentStatus info={info} />
          <p>Run this in a terminal to add OpenDraw to Claude Code:</p>
          <CopyBlock label="Claude Code" text={info.command} testId="connect-command" />
          <p>Other MCP clients take this server entry:</p>
          <CopyBlock label="MCP client JSON" text={info.json} testId="connect-json" />
        </>
      )}
      <div className="confirm-actions">
        <button type="button" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  )
}

function AboutDialog({ onClose }: { onClose: () => void }) {
  const info = useAppInfo()
  return (
    <div className="confirm-dialog app-dialog" data-testid="about-dialog" role="dialog" aria-label="About OpenDraw">
      <h2>OpenDraw</h2>
      {info && (
        <dl className="about-list">
          <dt>Version</dt>
          <dd data-testid="about-version">
            {info.version}
            {info.packaged ? '' : ' (development)'}
          </dd>
          <dt>MCP server</dt>
          <dd data-testid="about-mcp">{info.mcp.running ? `Running on port ${info.mcp.port}` : 'Not running'}</dd>
          <dt>Agent</dt>
          <dd>
            <AgentStatus info={info} />
          </dd>
          <dt>Workspace</dt>
          <dd data-testid="about-workspace">{info.workspace}</dd>
        </dl>
      )}
      <div className="confirm-actions">
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  )
}
