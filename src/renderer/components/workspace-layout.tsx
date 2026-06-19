/**
 * Workspace Layout - primary UI.
 * Left: folder sidebar (saved paths). Right: the active terminal, full size.
 * Every terminal stays mounted (and its shell alive) while it exists; only the
 * active one is visible. Clicking + under a folder spawns a shell with cwd = that folder.
 */
import { useState, useCallback, useEffect, useRef } from 'react'
import { TerminalInstance } from './terminal-instance'
import { WorkspaceSidebar, Workspace, Term, TermKind } from './workspace-sidebar'
import { ClaudeIcon, CodexIcon, TerminalIcon, PiIcon } from './icons'
import type { UsageSnapshot, UpdateInfo } from '../../preload/index.d'
import { KeybindingsModal } from './keybindings-modal'
import { Binding, loadBindings, saveBindings, eventToCombo } from '../lib/keybindings'

let termCounter = 0
const nextTermId = () => `term-${++termCounter}`

// Claude/Codex TUIs enable mouse reporting and don't always disable it on exit,
// leaving the shell spewing escape codes (e.g. "35;13;13M") on mouse movement.
// Appending this resets mouse-tracking modes once the AI process exits.
const MOUSE_RESET = "; printf '\\033[?1000l\\033[?1002l\\033[?1003l\\033[?1006l\\033[?1015l\\033[?1005l\\033[?1004l'"

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
  const [sidebarHidden, setSidebarHidden] = useState(false)
  const [bindings, setBindings] = useState<Binding[]>(() => loadBindings())
  const [showKeybindings, setShowKeybindings] = useState(false)
  const loadedRef = useRef(false)
  const resizingRef = useRef(false)
  const busyTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  // Derived
  const allTerminals = workspaces.flatMap(w => w.terminals)
  const activeWorkspace = workspaces.find(w => w.terminals.some(t => t.id === activeId)) || null
  const activeTerm = allTerminals.find(t => t.id === activeId) || null

  // First 9 terminals get a ⌘1–⌘9 jump shortcut
  const hotkeyIndex: Record<string, number> = {}
  allTerminals.slice(0, 9).forEach((t, i) => { hotkeyIndex[t.id] = i + 1 })

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
        initialCommand: `claude --session-id ${sessionId} --dangerously-skip-permissions${MOUSE_RESET}`
      }
    } else if (kind === 'codex') {
      // Codex can't be given a session id up front, so restore uses `resume --last`.
      term = {
        id, cwd: path, kind: 'codex',
        name: `Codex ${termCounter}`,
        initialCommand: `codex --dangerously-bypass-approvals-and-sandbox${MOUSE_RESET}`
      }
    } else if (kind === 'pi') {
      // pi supports --session <uuid> to use/resume a specific session
      const sessionId = crypto.randomUUID()
      term = {
        id, cwd: path, kind: 'pi', sessionId,
        name: `PI ${termCounter}`,
        initialCommand: `pi --session ${sessionId}${MOUSE_RESET}`
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
              // Resume the saved conversation by id. No `|| --session-id`
              // fallback: that reused the id and errored "already in use" once
              // the transcript persisted, and also re-fired when the user simply
              // quit the resumed session.
              const sid = t.claudeSessionId
              return {
                id, name: t.name, cwd, kind: 'claude' as const,
                sessionId: sid,
                initialCommand: `claude --resume ${sid} --dangerously-skip-permissions${MOUSE_RESET}`
              }
            }
            if (t.kind === 'codex') {
              // Codex has no fixed id; resume the most recent session
              return {
                id, name: t.name, cwd, kind: 'codex' as const,
                initialCommand: `codex resume --last${MOUSE_RESET}`
              }
            }
            if (t.kind === 'pi' && t.claudeSessionId) {
              // Resume the same pi session by id
              const sid = t.claudeSessionId
              return {
                id, name: t.name, cwd, kind: 'pi' as const,
                sessionId: sid,
                initialCommand: `pi --session ${sid}${MOUSE_RESET}`
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

  // --- version + update check (on launch, then every 30 min) ---
  useEffect(() => {
    window.app.getVersion().then(setVersion).catch(() => {})
    const check = () => window.app.checkUpdate().then(setUpdate).catch(() => {})
    check()
    const iv = setInterval(check, 30 * 60 * 1000)
    return () => clearInterval(iv)
  }, [])

  const [updating, setUpdating] = useState(false)
  const openReleases = useCallback(() => {
    window.app.releasesUrl().then(u => window.app.openExternal(u)).catch(() => {})
  }, [])

  // Self-update via the curl installer, then the app relaunches itself
  const doUpdate = useCallback(() => {
    setUpdating(true)
    window.app.runUpdate().catch(() => setUpdating(false))
  }, [])

  // --- keyboard shortcuts ---
  useEffect(() => {
    const comboMap: Record<string, string> = {}
    bindings.forEach(b => { comboMap[b.combo] = b.id })

    const run = (actionId: string) => {
      const ws = activeWorkspace || workspaces[0]
      switch (actionId) {
        case 'newTerminal': if (ws) spawnTerminal(ws.id, ws.path, 'shell'); break
        case 'newClaude': if (ws) spawnTerminal(ws.id, ws.path, 'claude'); break
        case 'newCodex': if (ws) spawnTerminal(ws.id, ws.path, 'codex'); break
        case 'newPi': if (ws) spawnTerminal(ws.id, ws.path, 'pi'); break
        case 'closeTerminal': if (activeId) removeTerminal(activeId); break
        case 'toggleSidebar': setSidebarHidden(h => !h); break
      }
    }

    const handler = (e: KeyboardEvent) => {
      const isMeta = e.metaKey || e.ctrlKey
      // ⌘1–⌘9: jump to the Nth terminal (fixed)
      if (isMeta && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault()
        const all = workspaces.flatMap(w => w.terminals)
        const t = all[parseInt(e.key, 10) - 1]
        if (t) setActiveId(t.id)
        return
      }
      // ⌘N: fixed alias for new terminal
      if (isMeta && !e.shiftKey && !e.altKey && e.key === 'n') {
        e.preventDefault(); run('newTerminal'); return
      }
      // configurable bindings
      const action = comboMap[eventToCombo(e)]
      if (action) { e.preventDefault(); run(action) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [bindings, activeWorkspace, workspaces, activeId, spawnTerminal, removeTerminal])

  const rebind = useCallback((id: string, combo: string) => {
    setBindings(prev => {
      const next = prev.map(b => (b.id === id ? { ...b, combo } : b))
      saveBindings(next)
      return next
    })
  }, [])

  const resetBindings = useCallback(() => {
    localStorage.removeItem('taw.keybindings')
    setBindings(loadBindings())
  }, [])

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
      {/* Activity rail */}
      <div className="ws-rail">
        <div className="rail-ic logo">{'>_'}</div>
        <button
          className={`rail-toggle ${sidebarHidden ? '' : 'active'}`}
          title={sidebarHidden ? 'Show sidebar (⌘B)' : 'Hide sidebar (⌘B)'}
          onClick={() => setSidebarHidden(h => !h)}
        >
          <span className="rt-ic">◧</span>
          <span className="rt-kbd">⌘B</span>
        </button>
        <div className="rail-spacer" />
        <button className="rail-ic" title="Keyboard shortcuts" onClick={() => setShowKeybindings(true)}>⚙</button>
      </div>

      {showKeybindings && (
        <KeybindingsModal
          bindings={bindings}
          onChange={rebind}
          onReset={resetBindings}
          onClose={() => setShowKeybindings(false)}
        />
      )}

      {/* Floating restore pill when the sidebar is hidden */}
      {sidebarHidden && (
        <button className="sidebar-restore" onClick={() => setSidebarHidden(false)} title="Show sidebar (⌘B)">
          ◧ Show sidebar <kbd>⌘B</kbd>
        </button>
      )}

      {!sidebarHidden && <WorkspaceSidebar
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
        onAddPi={(wsId) => {
          const ws = workspaces.find(w => w.id === wsId)
          if (ws) spawnTerminal(ws.id, ws.path, 'pi')
        }}
        onSelectTerminal={setActiveId}
        onCloseTerminal={removeTerminal}
        onRenameTerminal={renameTerminal}
        usage={usage}
        version={version}
        update={update}
        onOpenReleases={openReleases}
        onUpdate={doUpdate}
        updating={updating}
        hotkeyIndex={hotkeyIndex}
      />}

      {/* Drag to resize the sidebar */}
      {!sidebarHidden && <div className="ws-resizer" onMouseDown={startResize} />}

      <div className="ws-main">
        {update?.hasUpdate && (
          <button className="update-banner" onClick={doUpdate} disabled={updating}>
            <span className="ub-dot" />
            {updating
              ? <>Updating to <b>v{update.latest}</b>… app will relaunch</>
              : <>New version <b>v{update.latest}</b> available — click to update</>}
            <span className="ub-cta">{updating ? 'Updating…' : 'Update →'}</span>
          </button>
        )}

        {/* Top tab bar: terminals of the active workspace */}
        <div className="ws-maintabs">
          {activeWorkspace?.terminals.map(t => (
            <div
              key={t.id}
              className={`ws-tab ${t.id === activeId ? 'active' : ''}`}
              title={hotkeyIndex[t.id] ? `${t.name}  ·  jump with ⌘${hotkeyIndex[t.id]}` : t.name}
              onClick={() => setActiveId(t.id)}
            >
              <span className={`ws-tab-ic ${t.kind}`}>
                {t.kind === 'claude' ? <ClaudeIcon size={13} /> : t.kind === 'codex' ? <CodexIcon size={13} /> : t.kind === 'pi' ? <PiIcon size={13} /> : <TerminalIcon size={13} />}
              </span>
              <span>{t.name}</span>
              <button className="ws-tab-x" title="Close terminal (⌘W)" onClick={(e) => { e.stopPropagation(); removeTerminal(t.id) }}>×</button>
            </div>
          ))}
          {activeWorkspace && (
            <>
              <button
                className="ws-tab-add"
                title="New terminal in this folder (⌘T / ⌘N)"
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
              <button
                className="ws-tab-add pi"
                title="New PI session"
                onClick={() => spawnTerminal(activeWorkspace.id, activeWorkspace.path, 'pi')}
              ><PiIcon size={14} /></button>
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
              <button className="tb-ic" title="New terminal in this folder (⌘T / ⌘N)" onClick={() => spawnTerminal(activeWorkspace.id, activeWorkspace.path)}>+</button>
              <button className="tb-ic" title="Close this terminal (⌘W)" onClick={() => removeTerminal(activeTerm.id)}>🗑</button>
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
