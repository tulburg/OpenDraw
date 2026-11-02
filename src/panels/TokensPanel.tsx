// The Tokens panel (S-14 Req 7): the file's design tokens by type, with swatches and values. Tokens
// are added, edited, renamed and deleted here; each change is one undo step.
import { useState } from 'react'

import { type Token, TOKEN_TYPES, type TokenType } from '../../shared/document'
import type { TokenResult } from '../../shared/tokens'
import { type DocumentStore, useStore } from '../document/store'
import { resolveToken } from './fields'

const TYPE_LABELS: Record<TokenType, string> = {
  color: 'Colors',
  spacing: 'Spacing',
  radius: 'Radius',
  fontFamily: 'Font families',
  fontSize: 'Font sizes',
  fontWeight: 'Font weights',
  lineHeight: 'Line heights',
  letterSpacing: 'Letter spacing',
  opacity: 'Opacity',
  container: 'Containers',
  breakpoint: 'Breakpoints'
}

const DEFAULT_VALUES: Record<TokenType, string> = {
  color: '#000000',
  spacing: '8px',
  radius: '4px',
  fontFamily: 'Inter',
  fontSize: '16px',
  fontWeight: '400',
  lineHeight: '1.5',
  letterSpacing: '0px',
  opacity: '1',
  container: '1200px',
  breakpoint: '768px'
}

const NO_TOKENS: Token[] = []

interface Draft {
  /** The token being edited, or null for a new one. */
  name: string | null
  type: TokenType
  newName: string
  value: string
  description: string
}

export function TokensPanel({ store }: { store: DocumentStore }) {
  const tokens = useStore(store, (s) => s.document.tokens) ?? NO_TOKENS
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)

  const firstError = (results: TokenResult[]) => results.find((r) => r.result === 'error')?.message ?? null

  const save = () => {
    if (!draft) return
    let results: TokenResult[]
    if (draft.name === null) {
      results = store.transact('Add token', (tx) =>
        tx.createTokens([{ type: draft.type, name: draft.newName.trim(), value: draft.value, description: draft.description }])
      )
    } else {
      const current = tokens.find((t) => t.name === draft.name)!
      const name = draft.name
      const unchanged = draft.value === current.value && draft.description === (current.description ?? '') && draft.newName.trim() === name
      if (unchanged) return setDraft(null)
      results = store.transact('Edit token', (tx) =>
        tx.setTokens([
          {
            name,
            ...(draft.value !== current.value ? { value: draft.value } : {}),
            ...(draft.description !== (current.description ?? '') ? { description: draft.description } : {}),
            ...(draft.newName.trim() !== name ? { newName: draft.newName.trim() } : {})
          }
        ])
      )
    }
    const message = firstError(results)
    setError(message)
    if (!message) setDraft(null)
  }

  const remove = (name: string) => {
    store.transact('Delete token', (tx) => tx.setTokens([{ name, delete: true }]))
    setDraft(null)
  }

  const groups = TOKEN_TYPES.map((type) => [type, tokens.filter((t) => t.type === type)] as const).filter(([, list]) => list.length > 0)

  return (
    <div className="tokens-panel" data-testid="tokens-panel">
      <div className="tokens-actions">
        <select
          aria-label="New token type"
          data-testid="new-token-type"
          value=""
          onChange={(event) => {
            const type = event.target.value as TokenType
            if (!type) return
            setError(null)
            setDraft({ name: null, type, newName: `--${type === 'color' ? 'color' : type.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}-`, value: DEFAULT_VALUES[type], description: '' })
          }}
        >
          <option value="">Add token...</option>
          {TOKEN_TYPES.map((type) => (
            <option key={type} value={type}>
              {TYPE_LABELS[type]}
            </option>
          ))}
        </select>
      </div>
      {draft?.name === null && <TokenForm draft={draft} error={error} onChange={setDraft} onSave={save} onCancel={() => setDraft(null)} />}
      {groups.length === 0 && !draft && <div className="panel-empty">No tokens yet</div>}
      {groups.map(([type, list]) => (
        <section key={type} className="token-group">
          <div className="token-group-title">{TYPE_LABELS[type]}</div>
          {list.map((token) =>
            draft?.name === token.name ? (
              <TokenForm
                key={token.name}
                draft={draft}
                error={error}
                onChange={setDraft}
                onSave={save}
                onCancel={() => setDraft(null)}
                onDelete={() => remove(token.name)}
              />
            ) : (
              <button
                key={token.name}
                type="button"
                className="token-row"
                data-testid="token-row"
                data-token={token.name}
                title={token.description}
                onClick={() => {
                  setError(null)
                  setDraft({ name: token.name, type: token.type, newName: token.name, value: token.value, description: token.description ?? '' })
                }}
              >
                {token.type === 'color' && <span className="color-swatch small" style={{ background: resolveToken(tokens, token.name) ?? 'transparent' }} />}
                <span className="token-name">{token.name}</span>
                <span className="token-value">{token.value}</span>
              </button>
            )
          )}
        </section>
      ))}
    </div>
  )
}

function TokenForm({
  draft,
  error,
  onChange,
  onSave,
  onCancel,
  onDelete
}: {
  draft: Draft
  error: string | null
  onChange: (draft: Draft) => void
  onSave: () => void
  onCancel: () => void
  onDelete?: () => void
}) {
  const onKeyDown = (event: React.KeyboardEvent) => {
    event.stopPropagation()
    if (event.key === 'Enter') onSave()
    if (event.key === 'Escape') onCancel()
  }
  return (
    <div className="token-form" data-testid="token-form">
      <input aria-label="Name" data-testid="token-name" value={draft.newName} spellCheck={false} autoFocus={draft.name === null} onChange={(e) => onChange({ ...draft, newName: e.target.value })} onKeyDown={onKeyDown} />
      <div className="token-form-value">
        {draft.type === 'color' && <span className="color-swatch small" style={{ background: draft.value }} />}
        <input aria-label="Value" data-testid="token-value" value={draft.value} spellCheck={false} autoFocus={draft.name !== null} onChange={(e) => onChange({ ...draft, value: e.target.value })} onKeyDown={onKeyDown} />
      </div>
      <input aria-label="Description" placeholder="Description" value={draft.description} onChange={(e) => onChange({ ...draft, description: e.target.value })} onKeyDown={onKeyDown} />
      {error && (
        <div className="token-error" data-testid="token-error">
          {error}
        </div>
      )}
      <div className="token-form-actions">
        {onDelete && (
          <button type="button" className="danger" data-testid="token-delete" onClick={onDelete}>
            Delete
          </button>
        )}
        <span className="spacer" />
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="primary" data-testid="token-save" onClick={onSave}>
          Save
        </button>
      </div>
    </div>
  )
}
