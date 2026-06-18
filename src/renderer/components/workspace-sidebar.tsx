/**
 * Workspace Sidebar - folder tree grouping terminals by working directory.
 * Each folder is a saved path; clicking + spawns a terminal rooted in that path.
 */
import { useState } from 'react'
import { ClaudeIcon, CodexIcon, TerminalIcon } from './icons'
import type { UsageSnapshot, UpdateInfo } from '../../preload/index.d'

export type TermKind = 'shell' | 'claude' | 'codex'

export interface Term {
  id: string
  name: string
  cwd: string
  kind: TermKind
  sessionId?: string
  /** Command auto-run on spawn (e.g. `claude --session-id <id>`) */
  initialCommand?: string
}

export interface Workspace {
  id: string
  path: string
  branch?: string | null
  collapsed?: boolean
  terminals: Term[]
}

interface Props {
  workspaces: Workspace[]
  activeId: string | null
  busy: Set<string>
  home: string
  query: string
  onQuery: (q: string) => void
  onAddFolder: () => void
  onRemoveFolder: (id: string) => void
  onToggle: (id: string) => void
  onAddTerminal: (workspaceId: string) => void
  onAddClaude: (workspaceId: string) => void
  onAddCodex: (workspaceId: string) => void
  onSelectTerminal: (id: string) => void
  onCloseTerminal: (id: string) => void
  onRenameTerminal: (id: string, name: string) => void
  usage: UsageSnapshot | null
  version: string
  update: UpdateInfo | null
  onOpenReleases: () => void
  onUpdate: () => void
  updating: boolean
  hotkeyIndex: Record<string, number>
}

function fmtTok(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(n)
}

/** Split a path into a dim parent + a bright basename for display. */
function splitPath(p: string, home: string): { parent: string; base: string } {
  let display = p
  if (home && p.startsWith(home)) display = '~' + p.slice(home.length)
  const idx = display.lastIndexOf('/')
  if (idx <= 0) return { parent: '', base: display }
  return { parent: display.slice(0, idx + 1), base: display.slice(idx + 1) }
}

export function WorkspaceSidebar({
  workspaces, activeId, busy, home, query, onQuery,
  onAddFolder, onRemoveFolder, onToggle, onAddTerminal, onAddClaude, onAddCodex,
  onSelectTerminal, onCloseTerminal, onRenameTerminal, usage, version, update, onOpenReleases,
  onUpdate, updating, hotkeyIndex
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const startRename = (t: Term) => { setEditingId(t.id); setEditValue(t.name) }
  const commitRename = () => {
    if (editingId && editValue.trim()) onRenameTerminal(editingId, editValue.trim())
    setEditingId(null)
  }

  const q = query.trim().toLowerCase()
  const filtered = q
    ? workspaces
        .map(w => ({
          ...w,
          terminals: w.terminals.filter(
            t => t.name.toLowerCase().includes(q) || w.path.toLowerCase().includes(q)
          )
        }))
        .filter(w => w.path.toLowerCase().includes(q) || w.terminals.length > 0)
    : workspaces

  return (
    <div className="ws-sidebar">
      <div className="ws-head">
        <h2>Workspace Paths</h2>
        <span className="ws-pill">{workspaces.length} {workspaces.length === 1 ? 'folder' : 'folders'}</span>
        <button className="ws-icbtn" title="Add folder" onClick={onAddFolder}>+</button>
      </div>

      <div className="ws-search">
        <span>🔍</span>
        <input
          placeholder="Search paths or terminals…"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
      </div>

      <div className="ws-scroll">
        {filtered.map(ws => {
          const { parent, base } = splitPath(ws.path, home)
          const count = ws.terminals.length
          return (
            <div key={ws.id} className={`ws-folder ${ws.collapsed ? 'collapsed' : ''}`}>
              <div className="folder-head">
                <button className="chev" onClick={() => onToggle(ws.id)}>▾</button>
                <span className="folder-ic">📁</span>
                <span className="folder-path" title={ws.path}>
                  <span className="root">{parent}</span>{base}
                </span>
                {ws.branch && <span className="folder-branch">⎇ {ws.branch}</span>}
                {count > 0 && <span className="folder-badge">{count} {count === 1 ? 'terminal' : 'terminals'}</span>}
                <button className="folder-claude" title="New Claude Code session here" onClick={() => onAddClaude(ws.id)}><ClaudeIcon size={13} /></button>
                <button className="folder-codex" title="New Codex session here" onClick={() => onAddCodex(ws.id)}><CodexIcon size={13} /></button>
                <button className="folder-add" title="New terminal here" onClick={() => onAddTerminal(ws.id)}>+</button>
                <button className="folder-rm" title="Remove folder" onClick={() => onRemoveFolder(ws.id)}>🗑</button>
              </div>

              {!ws.collapsed && (
                <div className="terms">
                  {ws.terminals.map(t => {
                    const isActive = t.id === activeId
                    const isBusy = busy.has(t.id)
                    return (
                      <div
                        key={t.id}
                        className={`term-card ${isActive ? 'active' : ''}`}
                        onClick={() => onSelectTerminal(t.id)}
                      >
                        <span className={`status-dot ${isBusy ? 'busy' : 'idle'}`} />
                        {t.kind === 'claude' && <span className="term-kind-ic claude" title="Claude Code"><ClaudeIcon size={12} /></span>}
                        {t.kind === 'codex' && <span className="term-kind-ic codex" title="Codex"><CodexIcon size={12} /></span>}
                        {t.kind === 'shell' && <span className="term-kind-ic shell" title="Terminal"><TerminalIcon size={12} /></span>}
                        {editingId === t.id ? (
                          <input
                            className="term-rename"
                            autoFocus
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={commitRename}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitRename()
                              if (e.key === 'Escape') setEditingId(null)
                              e.stopPropagation()
                            }}
                            onClick={(e) => e.stopPropagation()}
                          />
                        ) : (
                          <span
                            className="term-name"
                            title="Double-click to rename"
                            onDoubleClick={(e) => { e.stopPropagation(); startRename(t) }}
                          >{t.name}</span>
                        )}
                        {isActive && <span className="term-state">active</span>}
                        {!isActive && isBusy && <span className="term-running">running</span>}
                        {hotkeyIndex[t.id] && <span className="term-num" title={`Jump: ⌘${hotkeyIndex[t.id]}`}>⌘{hotkeyIndex[t.id]}</span>}
                        <button
                          className="term-close"
                          title="Close terminal"
                          onClick={(e) => { e.stopPropagation(); onCloseTerminal(t.id) }}
                        >×</button>
                      </div>
                    )
                  })}
                  {count === 0 && (
                    <div className="terms-empty-row">
                      <button className="terms-empty" onClick={() => onAddTerminal(ws.id)}>
                        ⊕ Terminal
                      </button>
                      <button className="terms-empty claude" onClick={() => onAddClaude(ws.id)}>
                        <ClaudeIcon size={12} /> Claude
                      </button>
                      <button className="terms-empty codex" onClick={() => onAddCodex(ws.id)}>
                        <CodexIcon size={12} /> Codex
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}

        <button className="ws-addrow" onClick={onAddFolder}>
          ⊕&nbsp; Add workspace folder
        </button>
      </div>

      {usage && (
        <div className="ws-usage" title="Token usage today (from ~/.claude and ~/.codex)">
          <div className="ws-usage-head">Today's usage</div>
          <div className="ws-usage-row">
            <span className="u-ic claude"><ClaudeIcon size={12} /></span>
            <span className="u-name">Claude</span>
            <span className="u-tok">{fmtTok(usage.claude.tokens)}</span>
            <span className="u-cost">~${usage.claude.cost.toFixed(2)}</span>
          </div>
          <div className="ws-usage-row">
            <span className="u-ic codex"><CodexIcon size={12} /></span>
            <span className="u-name">Codex</span>
            <span className="u-tok">{fmtTok(usage.codex.tokens)}</span>
            <span className="u-cost">~${usage.codex.cost.toFixed(2)}</span>
          </div>
        </div>
      )}

      <div className="ws-version">
        <span className="v-tag" onClick={onOpenReleases} title="Open releases" style={{ cursor: 'pointer' }}>
          TawTerminal v{version || '—'}
        </span>
        {update?.hasUpdate ? (
          <button className="v-update" onClick={onUpdate} disabled={updating} title="Download & install the latest version">
            {updating ? 'updating…' : `↑ v${update.latest} — update`}
          </button>
        ) : (
          <span className="v-ok">up to date</span>
        )}
      </div>
    </div>
  )
}
