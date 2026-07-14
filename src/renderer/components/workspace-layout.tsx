/**
 * Workspace Layout - primary UI.
 * Left: folder sidebar (saved paths). Right: the active terminal, full size.
 * Every terminal stays mounted (and its shell alive) while it exists; only the
 * active one is visible. Clicking + under a folder spawns a shell with cwd = that folder.
 */
import { useState, useCallback, useEffect, useRef } from 'react'
import { TerminalInstance } from './terminal-instance'
import { WorkspaceSidebar, Workspace, Term, TermKind } from './workspace-sidebar'
import { ClaudeIcon, CodexIcon, TerminalIcon, PiIcon, TawxIcon, GearIcon } from './icons'
import type { UsageSnapshot, LimitsSnapshot, UpdateInfo } from '../../preload/index.d'
import { KeybindingsModal } from './keybindings-modal'
import { UpdateModal } from './update-modal'
import { RemoteModal } from './remote-modal'
import { Binding, loadBindings, saveBindings, eventToCombo } from '../lib/keybindings'
import { AgentKind, AgentState, loadEnabledAgents, saveEnabledAgents, resetEnabledAgents } from '../lib/agents'

let termCounter = 0
const nextTermId = () => `term-${++termCounter}`

// Claude/Codex TUIs enable mouse reporting and don't always disable it on exit,
// leaving the shell spewing escape codes (e.g. "35;13;13M") on mouse movement.
// Appending this resets mouse-tracking modes once the AI process exits.
const MOUSE_RESET = "; printf '\\033[?1000l\\033[?1002l\\033[?1003l\\033[?1006l\\033[?1015l\\033[?1005l\\033[?1004l'"

/** Agents that mint their own session id; the terminal learns it from disk after start. */
type SessionKind = 'codex' | 'tawx'

const freshCmd = (kind: SessionKind) =>
  kind === 'codex'
    ? `codex --dangerously-bypass-approvals-and-sandbox${MOUSE_RESET}`
    : `tawx${MOUSE_RESET}`

const resumeCmd = (kind: SessionKind, sid: string) =>
  kind === 'codex'
    ? `codex resume ${sid} --dangerously-bypass-approvals-and-sandbox${MOUSE_RESET}`
    : `tawx resume ${sid}${MOUSE_RESET}`

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
  const [limits, setLimits] = useState<LimitsSnapshot | null>(null)
  const [version, setVersion] = useState('')
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [sidebarHidden, setSidebarHidden] = useState(false)
  const [bindings, setBindings] = useState<Binding[]>(() => loadBindings())
  const [agents, setAgents] = useState<AgentState>(() => loadEnabledAgents())
  const [showKeybindings, setShowKeybindings] = useState(false)
  const [showRemote, setShowRemote] = useState(false)
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
      // Codex mints its own id, so main watches the transcript dir and reports back
      // which session this terminal started (see `agent:session` below).
      term = {
        id, cwd: path, kind: 'codex',
        name: `Codex ${termCounter}`,
        initialCommand: freshCmd('codex')
      }
      window.agentSession.watch(id, 'codex', path)
    } else if (kind === 'pi') {
      // pi's --session only RESUMES an existing session. Give each PI terminal
      // its own session dir so a fresh `pi` saves there and restore can
      // `--continue` exactly that terminal's session.
      const sessionId = crypto.randomUUID()
      const dir = `~/.taw-terminal/pi/${sessionId}`
      term = {
        id, cwd: path, kind: 'pi', sessionId,
        name: `PI ${termCounter}`,
        initialCommand: `mkdir -p ${dir} && pi --session-dir ${dir}${MOUSE_RESET}`
      }
    } else if (kind === 'tawx') {
      // Same as Codex: the id only exists once tawx writes its session file.
      // tawx auto-approves by default.
      term = {
        id, cwd: path, kind: 'tawx',
        name: `tawx ${termCounter}`,
        initialCommand: freshCmd('tawx')
      }
      window.agentSession.watch(id, 'tawx', path)
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
      // Codex/tawx terminals saved without a session id (pre-0.2.6 sessions)
      const pending: { termId: string; kind: SessionKind; cwd: string }[] = []

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
            const note = { note: t.note, noteOpen: t.noteOpen }
            if (t.kind === 'claude' && t.claudeSessionId) {
              // Resume the saved conversation by id. No `|| --session-id`
              // fallback: that reused the id and errored "already in use" once
              // the transcript persisted, and also re-fired when the user simply
              // quit the resumed session.
              const sid = t.claudeSessionId
              return {
                id, name: t.name, cwd, kind: 'claude' as const,
                sessionId: sid, ...note,
                initialCommand: `claude --resume ${sid} --dangerously-skip-permissions${MOUSE_RESET}`
              }
            }
            if (t.kind === 'codex' || t.kind === 'tawx') {
              // Resume this terminal's OWN session by id. `codex resume --last` used
              // to be the fallback here, which pointed every Codex terminal at the
              // newest session and collapsed them all into one conversation.
              // Terminals saved before ids were tracked have none yet; `pending`
              // collects them and adopt() below gives each a distinct session.
              const kind = t.kind
              const sid = t.claudeSessionId
              if (!sid) {
                pending.push({ termId: id, kind, cwd })
                return { id, name: t.name, cwd, kind, ...note }
              }
              window.agentSession.claim(id, kind, cwd, sid)
              return {
                id, name: t.name, cwd, kind,
                sessionId: sid, ...note,
                initialCommand: resumeCmd(kind, sid)
              }
            }
            if (t.kind === 'pi' && t.claudeSessionId) {
              // Continue the session stored in this terminal's own pi session dir
              const sid = t.claudeSessionId
              const dir = `~/.taw-terminal/pi/${sid}`
              return {
                id, name: t.name, cwd, kind: 'pi' as const,
                sessionId: sid, ...note,
                initialCommand: `mkdir -p ${dir} && pi --session-dir ${dir} --continue${MOUSE_RESET}`
              }
            }
            return { id, name: t.name, cwd, kind: 'shell' as const, ...note }
          })
        }))

        if (pending.length) {
          // Newest transcript to the first terminal, next-newest to the second, and
          // so on, so two Codex tabs never land on the same conversation.
          const adopted = await window.agentSession.adopt(pending)
          const byId = new Map(pending.map(p => [p.termId, p]))
          ws = ws.map(w => ({
            ...w,
            terminals: w.terminals.map(t => {
              const p = byId.get(t.id)
              if (!p) return t
              const sid = adopted[t.id]
              if (sid) return { ...t, sessionId: sid, initialCommand: resumeCmd(p.kind, sid) }
              // Nothing left to adopt (e.g. a tab whose agent never ran): start fresh
              // and let the watcher bind whatever session it creates.
              window.agentSession.watch(t.id, p.kind, t.cwd)
              return { ...t, initialCommand: freshCmd(p.kind) }
            })
          }))
        }

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
        terminals: ws.terminals.map(t => ({ name: t.name, cwd: t.cwd, kind: t.kind, claudeSessionId: t.sessionId, note: t.note, noteOpen: t.noteOpen }))
      }))
    })
  }, [workspaces, activeId])

  // --- Codex/tawx: adopt the session id main read off the transcript the agent wrote ---
  useEffect(() => {
    const off = window.agentSession.onSession(({ id, sessionId }) => {
      setWorkspaces(prev => prev.map(w => ({
        ...w,
        terminals: w.terminals.map(t => (t.id === id ? { ...t, sessionId } : t))
      })))
    })
    return off
  }, [])

  // The focused terminal is the one whose agent is being started (or /new'd), so it
  // gets first claim on a transcript that appears.
  useEffect(() => {
    window.agentSession.setActive(activeId)
  }, [activeId])

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
    // Keep the remote (phone) session list label in sync.
    window.terminal.rename?.(termId, name)
  }, [])

  // --- sticky note: edit content / toggle the note panel for a terminal ---
  const updateNote = useCallback((termId: string, note: string) => {
    setWorkspaces(prev => prev.map(w => ({
      ...w,
      terminals: w.terminals.map(t => (t.id === termId ? { ...t, note } : t))
    })))
  }, [])

  const toggleNote = useCallback((termId: string) => {
    setWorkspaces(prev => prev.map(w => ({
      ...w,
      terminals: w.terminals.map(t => (t.id === termId ? { ...t, noteOpen: !t.noteOpen } : t))
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

  // --- poll live 5h / weekly rate-limit usage (network call, so slower cadence) ---
  useEffect(() => {
    let alive = true
    const tick = () => window.limits.get().then(l => { if (alive) setLimits(l) }).catch(() => {})
    tick()
    const iv = setInterval(tick, 60000)
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

  const [showUpdateGuide, setShowUpdateGuide] = useState(false)
  // The update notice is a small dismissible pill in the tab row (not a
  // full-width banner) — dismissing remembers the version so only a NEWER
  // release brings it back. The sidebar footer keeps its own update button.
  const [dismissedUpdate, setDismissedUpdate] = useState(() => localStorage.getItem('taw.updateDismissed') || '')
  const dismissUpdate = useCallback((ver: string) => {
    localStorage.setItem('taw.updateDismissed', ver)
    setDismissedUpdate(ver)
  }, [])
  const openReleases = useCallback(() => {
    window.app.releasesUrl().then(u => window.app.openExternal(u)).catch(() => {})
  }, [])

  // Show a guide: copy the install command, run it in a terminal, then quit +
  // reopen TawTerminal. We don't self-update silently anymore.
  const doUpdate = useCallback(() => setShowUpdateGuide(true), [])

  // --- keyboard shortcuts ---
  useEffect(() => {
    const comboMap: Record<string, string> = {}
    bindings.forEach(b => { comboMap[b.combo] = b.id })

    const run = (actionId: string) => {
      const ws = activeWorkspace || workspaces[0]
      switch (actionId) {
        case 'newTerminal': if (ws) spawnTerminal(ws.id, ws.path, 'shell'); break
        case 'newClaude': if (ws && agents.claude) spawnTerminal(ws.id, ws.path, 'claude'); break
        case 'newCodex': if (ws && agents.codex) spawnTerminal(ws.id, ws.path, 'codex'); break
        case 'newPi': if (ws && agents.pi) spawnTerminal(ws.id, ws.path, 'pi'); break
        case 'newTawx': if (ws && agents.tawx) spawnTerminal(ws.id, ws.path, 'tawx'); break
        case 'addFolder': addFolder(); break
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
  }, [bindings, agents, activeWorkspace, workspaces, activeId, spawnTerminal, removeTerminal, addFolder])

  const rebind = useCallback((id: string, combo: string) => {
    setBindings(prev => {
      const next = prev.map(b => (b.id === id ? { ...b, combo } : b))
      saveBindings(next)
      return next
    })
  }, [])

  const toggleAgent = useCallback((id: AgentKind) => {
    setAgents(prev => {
      const next = { ...prev, [id]: !prev[id] }
      saveEnabledAgents(next)
      return next
    })
  }, [])

  const resetAgents = useCallback(() => {
    resetEnabledAgents()
    setAgents(loadEnabledAgents())
  }, [])

  // "Reset to defaults" wipes the whole Settings panel: keyboard shortcuts AND
  // agent toggles (re-enable all). Keeps the single footer button truthful.
  const resetAll = useCallback(() => {
    localStorage.removeItem('taw.keybindings')
    setBindings(loadBindings())
    resetEnabledAgents()
    setAgents(loadEnabledAgents())
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
        <button className="rail-settings" title="Remote access (control from your phone)" onClick={() => setShowRemote(true)}>
          <span className="rs-ic">📱</span>
          <span className="rs-label">Remote</span>
        </button>
        <button className="rail-settings" title="Settings (agents & shortcuts)" onClick={() => setShowKeybindings(true)}>
          <span className="rs-ic"><GearIcon size={22} /></span>
          <span className="rs-label">Settings</span>
        </button>
      </div>

      {showKeybindings && (
        <KeybindingsModal
          bindings={bindings}
          onChange={rebind}
          onReset={resetAll}
          agents={agents}
          onToggleAgent={toggleAgent}
          onResetAgents={resetAgents}
          onClose={() => setShowKeybindings(false)}
        />
      )}

      {showUpdateGuide && (
        <UpdateModal
          latest={update?.latest ?? null}
          onClose={() => setShowUpdateGuide(false)}
        />
      )}

      {showRemote && <RemoteModal onClose={() => setShowRemote(false)} />}

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
        onAddTawx={(wsId) => {
          const ws = workspaces.find(w => w.id === wsId)
          if (ws) spawnTerminal(ws.id, ws.path, 'tawx')
        }}
        agents={agents}
        onSelectTerminal={setActiveId}
        onCloseTerminal={removeTerminal}
        onRenameTerminal={renameTerminal}
        usage={usage}
        limits={limits}
        version={version}
        update={update}
        onOpenReleases={openReleases}
        onUpdate={doUpdate}
        hotkeyIndex={hotkeyIndex}
      />}

      {/* Drag to resize the sidebar */}
      {!sidebarHidden && <div className="ws-resizer" onMouseDown={startResize} />}

      <div className="ws-main">
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
                {t.kind === 'claude' ? <ClaudeIcon size={13} /> : t.kind === 'codex' ? <CodexIcon size={13} /> : t.kind === 'pi' ? <PiIcon size={13} /> : t.kind === 'tawx' ? <TawxIcon size={13} /> : <TerminalIcon size={13} />}
              </span>
              <span>{t.name}</span>
              <button className="ws-tab-x" title="Close terminal (⌘W)" onClick={(e) => { e.stopPropagation(); removeTerminal(t.id) }}>×</button>
            </div>
          ))}
          {activeWorkspace && (
            <>
              <button
                className="ws-tab-add"
                title="New terminal in this folder (⌘⇧T / ⌘N)"
                onClick={() => spawnTerminal(activeWorkspace.id, activeWorkspace.path)}
              >+</button>
              {agents.claude && <button
                className="ws-tab-add agent claude"
                title="New Claude Code session"
                onClick={() => spawnTerminal(activeWorkspace.id, activeWorkspace.path, 'claude')}
              ><ClaudeIcon size={13} /><span className="wsa-name">Claude</span></button>}
              {agents.codex && <button
                className="ws-tab-add agent codex"
                title="New Codex session"
                onClick={() => spawnTerminal(activeWorkspace.id, activeWorkspace.path, 'codex')}
              ><CodexIcon size={13} /><span className="wsa-name">Codex</span></button>}
              {agents.pi && <button
                className="ws-tab-add agent pi"
                title="New PI session"
                onClick={() => spawnTerminal(activeWorkspace.id, activeWorkspace.path, 'pi')}
              ><PiIcon size={13} /><span className="wsa-name">PI</span></button>}
              {agents.tawx && <button
                className="ws-tab-add agent tawx"
                title="New tawx session"
                onClick={() => spawnTerminal(activeWorkspace.id, activeWorkspace.path, 'tawx')}
              ><TawxIcon size={13} /><span className="wsa-name">tawx</span></button>}
            </>
          )}
          {update?.hasUpdate && update.latest && update.latest !== dismissedUpdate && (
            <div className="update-pill">
              <button className="up-go" title="How to update" onClick={doUpdate}>
                <span className="ub-dot" />
                v{update.latest} available
              </button>
              <button className="up-x" title="Dismiss until the next release" onClick={() => dismissUpdate(update.latest!)}>×</button>
            </div>
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
              <button
                className={`tb-ic ${activeTerm.noteOpen ? 'active' : ''}`}
                title={activeTerm.noteOpen ? 'Hide sticky note' : 'Sticky note for this terminal'}
                onClick={() => toggleNote(activeTerm.id)}
              >📝</button>
              <button className="tb-ic" title="New terminal in this folder (⌘⇧T / ⌘N)" onClick={() => spawnTerminal(activeWorkspace.id, activeWorkspace.path)}>+</button>
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
              name={t.name}
              kind={t.kind}
              workspacePath={t.cwd}
              initialCommand={t.initialCommand}
              onImagePaste={onImagePaste}
            />
          ))}
          {activeTerm?.noteOpen && (
            <div className="sticky-note">
              <div className="sticky-note-head">
                <span className="sn-title">📝 Note · {activeTerm.name}</span>
                <button className="sn-close" title="Hide note" onClick={() => toggleNote(activeTerm.id)}>×</button>
              </div>
              <textarea
                className="sticky-note-body"
                placeholder="Jot something for this terminal…"
                value={activeTerm.note ?? ''}
                onChange={(e) => updateNote(activeTerm.id, e.target.value)}
              />
            </div>
          )}
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
