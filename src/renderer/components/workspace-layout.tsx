/**
 * Workspace Layout - primary UI.
 * Left: folder sidebar (saved paths). Right: the active terminal, full size.
 * Every terminal stays mounted (and its shell alive) while it exists; only the
 * active one is visible. Clicking + under a folder spawns a shell with cwd = that folder.
 */
import { useState, useCallback, useEffect, useRef } from 'react'
import { TerminalInstance } from './terminal-instance'
import { WorkspaceSidebar, Workspace, Term, TermKind } from './workspace-sidebar'
import { ClaudeIcon, CodexIcon, TerminalIcon } from './icons'
import type { UsageSnapshot, UpdateInfo } from '../../preload/index.d'

let termCounter = 0
const nextTermId = () => `term-${++termCounter}`

interface Props {
  onImagePaste?: (dataUrl: string) => void
}

export function WorkspaceLayout({ onImagePaste }: Props) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [shellName, setShellName] = useState('zsh')
  const [home, setHome] = useState('')
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem('taw.sidebarWidth'))
    return saved >= 220 && saved <= 640 ? saved : 340
  })
  const [usage, setUsage] = useState<UsageSnapshot | null>(null)
  const [version, setVersion] = useState('')
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const loadedRef = useRef(false)
  const resizingRef = useRef(false)
  const busyTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  // Derived
  const allTerminals = workspaces.flatMap(w => w.terminals)
  const activeWorkspace = workspaces.find(w => w.terminals.some(t => t.id === activeId)) || null
  const activeTerm = allTerminals.find(t => t.id === activeId) || null

  // --- helpers ---
  const fetchBranch = useCallback((wsId: string, path: string) => {
    window.workspace.gitBranch(path).then(branch => {
      if (!branch) return
      setWorkspaces(prev => prev.map(w => (w.id === wsId ? { ...w, branch } : w)))
    })
  }, [])

  const spawnTerminal = useCallback((wsId: string, path: string, kind: TermKind = 'shell') => {
    const id = nextTermId()
    let term: Term
    if (kind === 'claude') {
      // A fresh Claude Code session with a known ID, so it can be resumed later.
      // --dangerously-skip-permissions skips the trust/approval prompts.
      const sessionId = crypto.randomUUID()
      term = {
        id, cwd: path, kind: 'claude', sessionId,
        name: `Claude ${termCounter}`,
        initialCommand: `claude --session-id ${sessionId} --dangerously-skip-permissions`
      }
    } else if (kind === 'codex') {
      // Codex can't be given a session id up front, so restore uses `resume --last`.
      term = {
        id, cwd: path, kind: 'codex',
        name: `Codex ${termCounter}`,
        initialCommand: `codex --dangerously-bypass-approvals-and-sandbox`
      }
    } else {
      term = { id, cwd: path, kind: 'shell', name: `Terminal ${termCounter}` }
    }
    setWorkspaces(prev => prev.map(w =>
      w.id === wsId ? { ...w, collapsed: false, terminals: [...w.terminals, term] } : w
    ))
    setActiveId(id)
  }, [])

  // --- init: restore saved session (folders + terminals), or seed with home ---
  useEffect(() => {
    (async () => {
      const [homeDir, name, saved] = await Promise.all([
        window.app.getHome(),
        window.terminal.getShellName?.() ?? Promise.resolve('zsh'),
        window.workspace.load()
      ])
      setHome(homeDir)
      setShellName(name || 'zsh')

      let ws: Workspace[]
      let activeTermId: string | null = null

      if (saved && !Array.isArray(saved) && Array.isArray(saved.workspaces) && saved.workspaces.length) {
        // New format: rebuild folders + terminals. Shells are fresh but rooted
        // at the same cwd; the previously active terminal is re-selected.
        ws = saved.workspaces.map(w => ({
          id: w.path,
          path: w.path,
          collapsed: !!w.collapsed,
          branch: null,
          terminals: (w.terminals || []).map(t => {
            const id = nextTermId()
            const cwd = t.cwd || w.path
            if (t.kind === 'claude' && t.claudeSessionId) {
              // Resume the conversation; if it was never flushed to disk, fall
              // back to a fresh session reusing the same id (no error dead-end).
              const sid = t.claudeSessionId
              return {
                id, name: t.name, cwd, kind: 'claude' as const,
                sessionId: sid,
                initialCommand: `claude --resume ${sid} --dangerously-skip-permissions || claude --session-id ${sid} --dangerously-skip-permissions`
              }
            }
            if (t.kind === 'codex') {
              // Codex has no fixed id; resume most recent, else start fresh
              return {
                id, name: t.name, cwd, kind: 'codex' as const,
                initialCommand: `codex resume --last || codex --dangerously-bypass-approvals-and-sandbox`
              }
            }
            return { id, name: t.name, cwd, kind: 'shell' as const }
          })
        }))
        const all = ws.flatMap(w => w.terminals.map(t => ({ t, path: w.path })))
        const match = saved.active && all.find(x => x.path === saved.active!.path && x.t.name === saved.active!.name)
        activeTermId = (match || all[0])?.t.id ?? null
      } else {
        // Legacy (string[] of paths) or first run: seed home with one terminal
        const paths = Array.isArray(saved) && saved.length ? saved : [homeDir]
        const seedTermId = nextTermId()
        ws = paths.map((p, i) => ({
          id: p,
          path: p,
          collapsed: false,
          branch: null,
          terminals: i === 0 ? [{ id: seedTermId, name: 'Terminal 1', cwd: p, kind: 'shell' as const }] : []
        }))
        activeTermId = seedTermId
      }

      setWorkspaces(ws)
      setActiveId(activeTermId)
      ws.forEach(w => fetchBranch(w.id, w.path))
      loadedRef.current = true
    })()
  }, [fetchBranch])

  // --- persist full session (folders + terminals + active) after initial load ---
  useEffect(() => {
    if (!loadedRef.current) return
    const w = workspaces.find(ws => ws.terminals.some(t => t.id === activeId))
    const t = w?.terminals.find(t => t.id === activeId)
    window.workspace.save({
      version: 1,
      active: w && t ? { path: w.path, name: t.name } : undefined,
      workspaces: workspaces.map(ws => ({
        path: ws.path,
        collapsed: ws.collapsed,
        terminals: ws.terminals.map(t => ({ name: t.name, cwd: t.cwd, kind: t.kind, claudeSessionId: t.sessionId }))
      }))
    })
  }, [workspaces, activeId])

  // --- busy indicator: a terminal is "running" if it emitted output recently ---
  useEffect(() => {
    const off = window.terminal.onData(({ id }) => {
      setBusy(prev => (prev.has(id) ? prev : new Set(prev).add(id)))
      clearTimeout(busyTimers.current[id])
      busyTimers.current[id] = setTimeout(() => {
        setBusy(prev => {
          if (!prev.has(id)) return prev
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }, 700)
    })
    return off
  }, [])

  // --- remove a terminal (used by close button and on shell exit) ---
  const removeTerminal = useCallback((termId: string) => {
    setWorkspaces(prev => prev.map(w => ({ ...w, terminals: w.terminals.filter(t => t.id !== termId) })))
    setActiveId(prev => {
      if (prev !== termId) return prev
      const remaining = workspaces.flatMap(w => w.terminals).filter(t => t.id !== termId)
      return remaining.length ? remaining[remaining.length - 1].id : null
    })
  }, [workspaces])

  // Shell exited on its own (e.g. user typed `exit`) -> drop the card
  useEffect(() => {
    const off = window.terminal.onExit(({ id }) => removeTerminal(id))
    return off
  }, [removeTerminal])

  // --- folder actions ---
  const addFolder = useCallback(async () => {
    const path = await window.workspace.openFolder()
    if (!path) return
    let existed = false
    setWorkspaces(prev => {
      if (prev.some(w => w.path === path)) { existed = true; return prev }
      return [...prev, { id: path, path, collapsed: false, branch: null, terminals: [] }]
    })
    if (!existed) {
      fetchBranch(path, path)
      spawnTerminal(path, path)
    }
  }, [fetchBranch, spawnTerminal])

  const removeFolder = useCallback((wsId: string) => {
    setWorkspaces(prev => prev.filter(w => w.id !== wsId))
  }, [])

  const toggleFolder = useCallback((wsId: string) => {
    setWorkspaces(prev => prev.map(w => (w.id === wsId ? { ...w, collapsed: !w.collapsed } : w)))
  }, [])

  const renameTerminal = useCallback((termId: string, name: string) => {
    setWorkspaces(prev => prev.map(w => ({
      ...w,
      terminals: w.terminals.map(t => (t.id === termId ? { ...t, name } : t))
    })))
  }, [])

  // --- poll today's Claude/Codex usage for the sidebar footer ---
  useEffect(() => {
    let alive = true
    const tick = () => window.usage.get().then(u => { if (alive) setUsage(u) }).catch(() => {})
    tick()
    const iv = setInterval(tick, 20000)
    return () => { alive = false; clearInterval(iv) }
  }, [])

  // --- version + update check (once on launch) ---
  useEffect(() => {
    window.app.getVersion().then(setVersion).catch(() => {})
    window.app.checkUpdate().then(setUpdate).catch(() => {})
  }, [])

  const openReleases = useCallback(() => {
    window.app.releasesUrl().then(u => window.app.openExternal(u)).catch(() => {})
  }, [])

  // --- keyboard shortcuts ---
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMeta = e.metaKey || e.ctrlKey
      if (isMeta && e.key === 't') {
        e.preventDefault()
        const ws = activeWorkspace || workspaces[0]
        if (ws) spawnTerminal(ws.id, ws.path)
      }
      if (isMeta && e.key === 'w') {
        e.preventDefault()
        if (activeId) removeTerminal(activeId)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [activeWorkspace, workspaces, activeId, spawnTerminal, removeTerminal])

  // --- sidebar resize (drag handle) ---
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    resizingRef.current = true
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizingRef.current) return
      // sidebar starts after the 48px activity rail
      setSidebarWidth(Math.min(640, Math.max(220, e.clientX - 48)))
    }
    const onUp = () => { resizingRef.current = false }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  useEffect(() => {
    localStorage.setItem('taw.sidebarWidth', String(sidebarWidth))
  }, [sidebarWidth])

  const shortHome = (p: string) => (home && p.startsWith(home) ? '~' + p.slice(home.length) : p)

  return (
    <div className="workspace-root" style={{ ['--sidebar-w' as string]: `${sidebarWidth}px` }}>
      {/* Decorative activity rail */}
      <div className="ws-rail">
        <div className="rail-ic active">{'>_'}</div>
        <div className="rail-ic">▦</div>
        <div className="rail-ic">⎇</div>
        <div className="rail-spacer" />
        <div className="rail-ic">⚙</div>
      </div>

      <WorkspaceSidebar
        workspaces={workspaces}
        activeId={activeId}
        busy={busy}
        home={home}
        query={query}
        onQuery={setQuery}
        onAddFolder={addFolder}
        onRemoveFolder={removeFolder}
        onToggle={toggleFolder}
        onAddTerminal={(wsId) => {
          const ws = workspaces.find(w => w.id === wsId)
          if (ws) spawnTerminal(ws.id, ws.path)
        }}
        onAddClaude={(wsId) => {
          const ws = workspaces.find(w => w.id === wsId)
          if (ws) spawnTerminal(ws.id, ws.path, 'claude')
        }}
        onAddCodex={(wsId) => {
          const ws = workspaces.find(w => w.id === wsId)
          if (ws) spawnTerminal(ws.id, ws.path, 'codex')
        }}
        onSelectTerminal={setActiveId}
        onCloseTerminal={removeTerminal}
        onRenameTerminal={renameTerminal}
        usage={usage}
        version={version}
        update={update}
        onOpenReleases={openReleases}
      />

      {/* Drag to resize the sidebar */}
      <div className="ws-resizer" onMouseDown={startResize} />

      <div className="ws-main">
        {/* Top tab bar: terminals of the active workspace */}
        <div className="ws-maintabs">
          {activeWorkspace?.terminals.map(t => (
            <div
              key={t.id}
              className={`ws-tab ${t.id === activeId ? 'active' : ''}`}
              onClick={() => setActiveId(t.id)}
            >
              <span className={`ws-tab-ic ${t.kind}`}>
                {t.kind === 'claude' ? <ClaudeIcon size={13} /> : t.kind === 'codex' ? <CodexIcon size={13} /> : <TerminalIcon size={13} />}
              </span>
              <span>{t.name}</span>
              <button className="ws-tab-x" onClick={(e) => { e.stopPropagation(); removeTerminal(t.id) }}>×</button>
            </div>
          ))}
          {activeWorkspace && (
            <>
              <button
                className="ws-tab-add"
                title="New terminal (⌘T)"
                onClick={() => spawnTerminal(activeWorkspace.id, activeWorkspace.path)}
              >+</button>
              <button
                className="ws-tab-add claude"
                title="New Claude Code session"
                onClick={() => spawnTerminal(activeWorkspace.id, activeWorkspace.path, 'claude')}
              ><ClaudeIcon size={14} /></button>
              <button
                className="ws-tab-add codex"
                title="New Codex session"
                onClick={() => spawnTerminal(activeWorkspace.id, activeWorkspace.path, 'codex')}
              ><CodexIcon size={14} /></button>
            </>
          )}
        </div>

        {/* Toolbar: path + branch + shell */}
        {activeTerm && activeWorkspace && (
          <div className="ws-toolbar">
            <span className="tb-folder">📁</span>
            <span className="tb-path">{shortHome(activeWorkspace.path)}</span>
            {activeWorkspace.branch && <span className="tb-branch">⎇ {activeWorkspace.branch}</span>}
            <div className="tb-right">
              <span className="tb-shell">● {shellName}</span>
              <button className="tb-ic" title="New terminal" onClick={() => spawnTerminal(activeWorkspace.id, activeWorkspace.path)}>+</button>
              <button className="tb-ic" title="Close terminal" onClick={() => removeTerminal(activeTerm.id)}>🗑</button>
            </div>
          </div>
        )}

        {/* Terminal host: every terminal stays mounted; only active is visible */}
        <div className="ws-termhost">
          {allTerminals.map(t => (
            <TerminalInstance
              key={t.id}
              id={t.id}
              isActive={t.id === activeId}
              cwd={t.cwd}
              initialCommand={t.initialCommand}
              onImagePaste={onImagePaste}
            />
          ))}
          {allTerminals.length === 0 && (
            <div className="ws-empty">
              <div className="ws-empty-card">
                <div className="ws-empty-icon">{'>_'}</div>
                <p>No terminals yet.</p>
                <p className="ws-empty-sub">Click <b>+</b> next to a folder, or add a workspace folder to spawn one.</p>
                <button className="ws-empty-btn" onClick={addFolder}>+ Add workspace folder</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
