/**
 * Workspace Sidebar - folder tree grouping terminals by working directory.
 * Each folder is a saved path; clicking + spawns a terminal rooted in that path.
 */
import { useState, type ReactNode } from 'react'
import { ClaudeIcon, CodexIcon, TerminalIcon, PiIcon, TawxIcon } from './icons'
import type { AgentState } from '../lib/agents'
import type { UsageSnapshot, LimitsSnapshot, ProviderLimits, LimitWindow, UpdateInfo } from '../../preload/index.d'

export type TermKind = 'shell' | 'claude' | 'codex' | 'pi' | 'tawx'

export interface Term {
  id: string
  name: string
  cwd: string
  kind: TermKind
  sessionId?: string
  /** Command auto-run on spawn (e.g. `claude --session-id <id>`) */
  initialCommand?: string
  /** Free-form sticky note pinned to this terminal */
  note?: string
  /** Whether the sticky note panel is shown */
  noteOpen?: boolean
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
  /** Live per-agent status ('running' | 'waiting' | 'idle') keyed by terminal id. */
  status: Record<string, string>
  home: string
  query: string
  onQuery: (q: string) => void
  onAddFolder: () => void
  onRemoveFolder: (id: string) => void
  onToggle: (id: string) => void
  onAddTerminal: (workspaceId: string) => void
  onAddClaude: (workspaceId: string) => void
  onAddCodex: (workspaceId: string) => void
  onAddPi: (workspaceId: string) => void
  onAddTawx: (workspaceId: string) => void
  agents: AgentState
  onSelectTerminal: (id: string) => void
  onCloseTerminal: (id: string) => void
  onRenameTerminal: (id: string, name: string) => void
  usage: UsageSnapshot | null
  limits: LimitsSnapshot | null
  version: string
  update: UpdateInfo | null
  onOpenReleases: () => void
  onUpdate: () => void
  hotkeyIndex: Record<string, number>
}

function fmtTok(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(n)
}

function fmtReset(minutes: number): string {
  if (!minutes || minutes <= 0) return ''
  if (minutes < 60) return `resets in ${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h < 24) return `resets in ${h}h${m ? ` ${m}m` : ''}`
  const d = Math.floor(h / 24)
  return `resets in ${d}d ${h % 24}h`
}

/** Color the bar by how close to the limit we are. */
function limitTone(pct: number): string {
  if (pct >= 90) return 'crit'
  if (pct >= 70) return 'warn'
  return 'ok'
}

function LimitBar({ kind, win }: { kind: string; win: LimitWindow }) {
  const pct = Math.round(win.usedPercent)
  const reset = fmtReset(win.resetMinutes)
  return (
    <div className="lim-bar-row" title={`${kind} · ${win.label}: ${pct}% used${reset ? ` · ${reset}` : ''}`}>
      <span className="lim-win">{win.label}</span>
      <div className="lim-track">
        <div className={`lim-fill ${limitTone(win.usedPercent)}`} style={{ width: `${Math.min(100, Math.max(2, pct))}%` }} />
      </div>
      <span className="lim-pct">{pct}%</span>
    </div>
  )
}

// Providers don't always report every window (e.g. Codex omits the 5h window
// when it's inactive). Show a 0% placeholder for the missing slot instead of
// hiding the row, so the 5h / 7d bars are always both visible.
function orZero(win: LimitWindow | null, label: string): LimitWindow {
  return win || { label, usedPercent: 0, resetAt: 0, resetMinutes: 0, status: 'inactive' }
}

function ProviderLimitRows({ kind, icon, data }: { kind: string; icon: ReactNode; data: ProviderLimits | undefined }) {
  if (!data) return null
  const wins = data.ok ? [orZero(data.session5h, '5h'), orZero(data.weekly7d, '7d')] : []
  return (
    <div className="lim-provider">
      <div className="lim-head-row">
        <span className={`u-ic ${kind.toLowerCase()}`}>{icon}</span>
        <span className="lim-name">{kind}</span>
        {!data.ok && <span className="lim-err" title={data.error || ''}>—</span>}
      </div>
      {data.ok && wins.map((w) => <LimitBar key={w.label} kind={kind} win={w} />)}
    </div>
  )
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
  workspaces, activeId, busy, status, home, query, onQuery,
  onAddFolder, onRemoveFolder, onToggle, onAddTerminal, onAddClaude, onAddCodex, onAddPi, onAddTawx,
  agents, onSelectTerminal, onCloseTerminal, onRenameTerminal, usage, limits, version, update, onOpenReleases,
  onUpdate, hotkeyIndex
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  // Usage + rate-limit footer is collapsed by default; expand on demand. Persisted.
  const [statsOpen, setStatsOpen] = useState(() => {
    try { return localStorage.getItem('ws-stats-open') === '1' } catch { return false }
  })
  const toggleStats = () => setStatsOpen(v => {
    const next = !v
    try { localStorage.setItem('ws-stats-open', next ? '1' : '0') } catch { /* ignore */ }
    return next
  })
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
                  <span className="fp-parent">{parent}</span>
                  <span className="fp-base">{base}</span>
                </span>
                {ws.branch && <span className="folder-branch">⎇ {ws.branch}</span>}
                {count > 0 && <span className="folder-badge">{count} {count === 1 ? 'terminal' : 'terminals'}</span>}
                {agents.claude && <button className="folder-claude" title="New Claude Code session here" onClick={() => onAddClaude(ws.id)}><ClaudeIcon size={13} /></button>}
                {agents.codex && <button className="folder-codex" title="New Codex session here" onClick={() => onAddCodex(ws.id)}><CodexIcon size={13} /></button>}
                {agents.pi && <button className="folder-pi" title="New PI session here" onClick={() => onAddPi(ws.id)}><PiIcon size={13} /></button>}
                {agents.tawx && <button className="folder-tawx" title="New tawx session here" onClick={() => onAddTawx(ws.id)}><TawxIcon size={13} /></button>}
                <button className="folder-add" title="New terminal here" onClick={() => onAddTerminal(ws.id)}>+</button>
                <button className="folder-rm" title="Remove folder" onClick={() => onRemoveFolder(ws.id)}>🗑</button>
              </div>

              {!ws.collapsed && (
                <div className="terms">
                  {ws.terminals.map(t => {
                    const isActive = t.id === activeId
                    const isShell = t.kind === 'shell'
                    // Shell terminals use the output-based busy flag; agent terminals
                    // report a content-based status (running / waiting / idle=done).
                    const st = isShell
                      ? (busy.has(t.id) ? 'running' : 'idle')
                      : (status[t.id] ?? 'idle')
                    const dotClass = st === 'running' ? 'working'
                      : st === 'waiting' ? 'attention'
                      : isShell ? 'idle'
                      : 'done'
                    return (
                      <div
                        key={t.id}
                        className={`term-card ${isActive ? 'active' : ''}`}
                        title={hotkeyIndex[t.id] ? `${t.name}  ·  jump ⌘${hotkeyIndex[t.id]}  ·  double-click to rename` : `${t.name}  ·  double-click to rename`}
                        onClick={() => onSelectTerminal(t.id)}
                      >
                        <span className={`status-dot ${dotClass}`} />
                        {t.kind === 'claude' && <span className="term-kind-ic claude" title="Claude Code"><ClaudeIcon size={12} /></span>}
                        {t.kind === 'codex' && <span className="term-kind-ic codex" title="Codex"><CodexIcon size={12} /></span>}
                        {t.kind === 'pi' && <span className="term-kind-ic pi" title="PI"><PiIcon size={12} /></span>}
                        {t.kind === 'tawx' && <span className="term-kind-ic tawx" title="tawx"><TawxIcon size={12} /></span>}
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
                        {t.note?.trim() && <span className="term-note-dot" title={t.note}>📝</span>}
                        {isActive && <span className="term-state">active</span>}
                        {!isActive && st === 'running' && <span className="term-running">running</span>}
                        {!isActive && st === 'waiting' && <span className="term-waiting">waiting</span>}
                        {!isActive && !isShell && st === 'idle' && <span className="term-done">done</span>}
                        {hotkeyIndex[t.id] && <span className="term-num" title={`Jump: ⌘${hotkeyIndex[t.id]}`}>⌘{hotkeyIndex[t.id]}</span>}
                        <button
                          className="term-close"
                          title="Close terminal (⌘W when active)"
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
                      {agents.claude && <button className="terms-empty claude" onClick={() => onAddClaude(ws.id)}>
                        <ClaudeIcon size={12} /> Claude
                      </button>}
                      {agents.codex && <button className="terms-empty codex" onClick={() => onAddCodex(ws.id)}>
                        <CodexIcon size={12} /> Codex
                      </button>}
                      {agents.pi && <button className="terms-empty pi" onClick={() => onAddPi(ws.id)}>
                        <PiIcon size={12} /> PI
                      </button>}
                      {agents.tawx && <button className="terms-empty tawx" onClick={() => onAddTawx(ws.id)}>
                        <TawxIcon size={12} /> tawx
                      </button>}
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

      {(usage || (limits && ((agents.claude && limits.claude) || (agents.codex && limits.codex)))) && (
        <div className="ws-stats">
          <button
            className="ws-stats-toggle"
            onClick={toggleStats}
            title={statsOpen ? 'Hide usage & rate limits' : 'Show usage & rate limits'}
          >
            <span className={`ws-stats-caret ${statsOpen ? 'open' : ''}`}>▸</span>
            <span className="ws-stats-label">Usage &amp; limits</span>
            {!statsOpen && usage && (
              <span className="ws-stats-peek">
                ~${(usage.claude.cost + usage.codex.cost + usage.pi.cost + usage.tawx.cost).toFixed(2)} today
              </span>
            )}
          </button>

          {statsOpen && usage && (
            <div className="ws-usage" title="Token usage today (from ~/.claude, ~/.codex, ~/.pi and ~/.tawx)">
              <div className="ws-usage-head">Today's usage</div>
              {agents.claude && (
                <div className="ws-usage-row">
                  <span className="u-ic claude"><ClaudeIcon size={12} /></span>
                  <span className="u-name">Claude</span>
                  <span className="u-tok">{fmtTok(usage.claude.tokens)}</span>
                  <span className="u-cost">~${usage.claude.cost.toFixed(2)}</span>
                </div>
              )}
              {agents.codex && (
                <div className="ws-usage-row">
                  <span className="u-ic codex"><CodexIcon size={12} /></span>
                  <span className="u-name">Codex</span>
                  <span className="u-tok">{fmtTok(usage.codex.tokens)}</span>
                  <span className="u-cost">~${usage.codex.cost.toFixed(2)}</span>
                </div>
              )}
              {agents.pi && (
                <div className="ws-usage-row">
                  <span className="u-ic pi"><PiIcon size={12} /></span>
                  <span className="u-name">PI</span>
                  <span className="u-tok">{fmtTok(usage.pi.tokens)}</span>
                  <span className="u-cost">~${usage.pi.cost.toFixed(2)}</span>
                </div>
              )}
              {agents.tawx && (
                <div className="ws-usage-row">
                  <span className="u-ic tawx"><TawxIcon size={12} /></span>
                  <span className="u-name">tawx</span>
                  <span className="u-tok">{fmtTok(usage.tawx.tokens)}</span>
                  <span className="u-cost">~${usage.tawx.cost.toFixed(2)}</span>
                </div>
              )}
            </div>
          )}

          {statsOpen && limits && ((agents.claude && limits.claude) || (agents.codex && limits.codex)) && (
            <div className="ws-limits" title="Rolling rate-limit usage (5h / weekly) — live from Claude & Codex APIs">
              <div className="ws-usage-head">Rate limits</div>
              {agents.claude && <ProviderLimitRows kind="Claude" icon={<ClaudeIcon size={12} />} data={limits.claude} />}
              {agents.codex && <ProviderLimitRows kind="Codex" icon={<CodexIcon size={12} />} data={limits.codex} />}
            </div>
          )}
        </div>
      )}

      <div className="ws-version">
        <span className="v-tag" onClick={onOpenReleases} title="Open releases" style={{ cursor: 'pointer' }}>
          TawTerminal v{version || '—'}
        </span>
        {update?.hasUpdate ? (
          <button className="v-update" onClick={onUpdate} title="Show how to update to the latest version">
            {`↑ v${update.latest} — update`}
          </button>
        ) : (
          <span className="v-ok">up to date</span>
        )}
      </div>
    </div>
  )
}
