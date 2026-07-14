/**
 * Phone-first remote control for TawTerminal. The default surface is a calm,
 * scannable activity view; xterm stays available as an explicit technical
 * layer for interactive terminal work.
 */
import { createRoot } from 'react-dom/client'
import { KeyboardEvent, ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import './styles/mobile.css'
import { RemoteClient, type ConnState } from './lib/remote-client'
import {
  buildSessionSnapshot,
  compactPath,
  formatRelativeTime,
  repositoryName,
  statusLabel,
  type SessionSnapshot,
  type SessionStatus
} from './lib/mobile-session'

type TerminalKind = 'shell' | 'claude' | 'codex' | 'pi' | 'tawx'
type SessionFilter = 'running' | 'attention' | 'all'

interface TerminalMeta {
  id: string
  name: string
  kind: TerminalKind
  cwd: string
  workspacePath: string
}

interface PersistedWorkspace {
  path: string
}

interface PersistedState {
  workspaces?: PersistedWorkspace[]
}

interface IconProps {
  name: 'menu' | 'plus' | 'chevron' | 'arrow' | 'more' | 'terminal' | 'send' | 'stop' | 'copy' | 'close' | 'repo' | 'activity'
  size?: number
}

const token = new URLSearchParams(location.search).get('token') || location.hash.replace(/^#token=/, '')
const client = new RemoteClient(token)
const BUFFER_CAP = 256 * 1024
const ANALYSIS_CAP = 48 * 1024

const KIND_LABEL: Record<TerminalKind, string> = {
  shell: 'Shell',
  claude: 'Claude',
  codex: 'Codex',
  pi: 'PI',
  tawx: 'tawx'
}

const FILTERS: { id: SessionFilter; label: string }[] = [
  { id: 'running', label: 'Running' },
  { id: 'attention', label: 'Need attention' },
  { id: 'all', label: 'All' }
]

function Icon({ name, size = 20 }: IconProps) {
  const paths: Record<IconProps['name'], ReactNode> = {
    menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    chevron: <><path d="m9 18 6-6-6-6" /></>,
    arrow: <><path d="m15 18-6-6 6-6" /></>,
    more: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></>,
    terminal: <><path d="m5 7 4 4-4 4M11 17h8" /></>,
    send: <><path d="m4 4 17 8-17 8 3-8-3-8Z" /><path d="M7 12h14" /></>,
    stop: <><rect x="7" y="7" width="10" height="10" rx="1" /></>,
    copy: <><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
    repo: <><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H10l2 2h5.5A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5v-10Z" /></>,
    activity: <><path d="M4 12h3l2-6 4 12 2-6h5" /></>
  }
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  )
}

function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(value).catch(() => {})
    return
  }
  const area = document.createElement('textarea')
  area.value = value
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  document.execCommand('copy')
  area.remove()
}

function StatusBadge({ status, compact = false }: { status: SessionStatus; compact?: boolean }) {
  return (
    <span className={`m-status status-${status} ${compact ? 'compact' : ''}`}>
      <span className="m-status-mark" />
      {statusLabel(status)}
    </span>
  )
}

function AgentMark({ kind }: { kind: TerminalKind }) {
  const glyph: Record<TerminalKind, string> = { shell: '>_', claude: 'C', codex: 'X', pi: 'π', tawx: 'T' }
  return <span className={`m-agent-mark kind-${kind}`} aria-hidden="true">{glyph[kind]}</span>
}

function App() {
  const [conn, setConn] = useState<ConnState>('connecting')
  const [sessions, setSessions] = useState<TerminalMeta[]>([])
  const [buffers, setBuffers] = useState<Record<string, string>>({})
  const [updatedAt, setUpdatedAt] = useState<Record<string, number>>({})
  const [branches, setBranches] = useState<Record<string, string | null>>({})
  const [workspacePaths, setWorkspacePaths] = useState<string[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [openTerminalId, setOpenTerminalId] = useState<string | null>(null)
  const [filter, setFilter] = useState<SessionFilter>('running')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [menuId, setMenuId] = useState<string | null>(null)
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const requestedBuffers = useRef(new Set<string>())
  const requestedBranches = useRef(new Set<string>())
  const bufferStore = useRef<Record<string, string>>({})
  const updatedStore = useRef<Record<string, number>>({})
  const flushTimer = useRef<number | null>(null)

  useEffect(() => {
    const flushLiveData = () => {
      flushTimer.current = null
      setBuffers({ ...bufferStore.current })
      setUpdatedAt({ ...updatedStore.current })
    }
    const scheduleFlush = () => {
      if (flushTimer.current !== null) return
      flushTimer.current = window.setTimeout(flushLiveData, 120)
    }
    const offState = client.onState(setConn)
    const offMeta = client.on('session:meta', (list: TerminalMeta[]) => setSessions(list || []))
    const offData = client.on('terminal:data', (payload: { id: string; data: string }) => {
      bufferStore.current[payload.id] = `${bufferStore.current[payload.id] || ''}${payload.data}`.slice(-BUFFER_CAP)
      updatedStore.current[payload.id] = Date.now()
      scheduleFlush()
    })
    const offExit = client.on('terminal:exit', (payload: { id: string }) => {
      updatedStore.current[payload.id] = Date.now()
      scheduleFlush()
    })
    client.connect()
    return () => {
      offState()
      offMeta()
      offData()
      offExit()
      if (flushTimer.current !== null) window.clearTimeout(flushTimer.current)
      client.close()
    }
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (conn !== 'open') return
    let cancelled = false

    const refreshSessions = () => {
      client.call<TerminalMeta[]>('session:list').then((list) => {
        if (!cancelled) setSessions(list || [])
      }).catch(() => {})
    }

    refreshSessions()
    client.call<PersistedState | string[] | null>('workspaces:load').then((saved) => {
      if (cancelled) return
      const paths = Array.isArray(saved)
        ? saved
        : saved?.workspaces?.map((workspace) => workspace.path) || []
      setWorkspacePaths(Array.from(new Set(paths.filter(Boolean))))
    }).catch(() => {})

    const interval = window.setInterval(refreshSessions, 5000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [conn])

  useEffect(() => {
    if (conn !== 'open') {
      requestedBuffers.current.clear()
      requestedBranches.current.clear()
    }
  }, [conn])

  useEffect(() => {
    if (conn !== 'open' || sessions.length === 0) return
    const unrequested = sessions.filter((session) => !requestedBuffers.current.has(session.id))
    unrequested.forEach((session) => {
      requestedBuffers.current.add(session.id)
      const beforeReplay = bufferStore.current[session.id] || ''
      client.call<string>('session:buffer', session.id).then((buffer) => {
        const replay = (buffer || '').slice(-BUFFER_CAP)
        const current = bufferStore.current[session.id] || ''
        const liveDelta = current.startsWith(beforeReplay) ? current.slice(beforeReplay.length) : ''
        // The server replay often already includes the newest event. Append
        // only a delta it did not capture, avoiding both gaps and duplicates.
        const hydrated = liveDelta && !replay.endsWith(liveDelta)
          ? `${replay}${liveDelta}`.slice(-BUFFER_CAP)
          : replay
        bufferStore.current[session.id] = hydrated
        updatedStore.current[session.id] = Date.now()
        setBuffers((previous) => ({ ...previous, [session.id]: hydrated }))
        setUpdatedAt((previous) => ({ ...previous, [session.id]: updatedStore.current[session.id] }))
      }).catch(() => requestedBuffers.current.delete(session.id))
    })

    const paths = Array.from(new Set(sessions.map((session) => session.workspacePath || session.cwd).filter(Boolean)))
    setWorkspacePaths((previous) => Array.from(new Set([...previous, ...paths])))
    paths.filter((path) => !requestedBranches.current.has(path)).forEach((path) => {
      requestedBranches.current.add(path)
      client.call<string | null>('git:branch', path).then((branch) => {
        setBranches((previous) => ({ ...previous, [path]: branch }))
      }).catch(() => setBranches((previous) => ({ ...previous, [path]: null })))
    })
  }, [sessions, conn])

  useEffect(() => {
    if (!pendingSessionId) return
    const created = sessions.find((session) => session.id === pendingSessionId)
    if (!created) return
    setActiveId(created.id)
    setPendingSessionId(null)
    setNewSessionOpen(false)
    setToast(`${created.name} is ready`)
  }, [sessions, pendingSessionId])

  useEffect(() => {
    if (!pendingSessionId) return
    const timer = window.setTimeout(() => {
      setPendingSessionId(null)
      setNewSessionOpen(false)
      setToast('Session started on desktop. The live list will refresh automatically.')
    }, 6000)
    return () => window.clearTimeout(timer)
  }, [pendingSessionId])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 2600)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (activeId && !sessions.some((session) => session.id === activeId)) setActiveId(null)
  }, [sessions, activeId])

  const snapshots = useMemo(() => {
    const next: Record<string, SessionSnapshot> = {}
    sessions.forEach((session) => {
      next[session.id] = buildSessionSnapshot((buffers[session.id] || '').slice(-ANALYSIS_CAP), session.kind, updatedAt[session.id] || Date.now())
    })
    return next
  }, [sessions, buffers, updatedAt])

  const active = activeId ? sessions.find((session) => session.id === activeId) || null : null

  const createSession = async (workspacePath: string, kind: TerminalKind) => {
    const result = await client.call<{ id: string }>('session:create', workspacePath, kind)
    if (!result?.id) throw new Error('Desktop did not return a session id.')
    setPendingSessionId(result.id)
    return result.id
  }

  const openSession = (id: string, terminal = false) => {
    setMenuId(null)
    setOpenTerminalId(terminal ? id : null)
    setActiveId(id)
  }

  if (active) {
    const path = active.workspacePath || active.cwd
    return (
      <TerminalView
        meta={active}
        conn={conn}
        buffer={buffers[active.id] || ''}
        snapshot={snapshots[active.id]}
        branch={branches[path]}
        now={now}
        initiallyOpenTerminal={openTerminalId === active.id}
        onBack={() => { setActiveId(null); setOpenTerminalId(null) }}
      />
    )
  }

  return (
    <div className="m-app">
      <header className="m-topbar">
        <button className="m-icon-button" aria-label="Open navigation" onClick={() => setDrawerOpen(true)}>
          <Icon name="menu" />
        </button>
        <div className="m-brand">
          <span className="m-brand-mark">T_</span>
          <span><strong>TawTerminal</strong><small>Remote workspace</small></span>
        </div>
        <span className={`m-connection connection-${conn}`}>
          <span />{conn === 'open' ? 'Live' : conn === 'connecting' ? 'Linking' : 'Offline'}
        </span>
        <button className="m-new-button" disabled={conn !== 'open' || workspacePaths.length === 0} onClick={() => setNewSessionOpen(true)}>
          <Icon name="plus" size={17} /><span>New</span>
        </button>
      </header>

      <main className="m-dashboard">
        <section className="m-dashboard-intro">
          <div>
            <p className="m-eyebrow">Live workspaces</p>
            <h1>Sessions</h1>
          </div>
          <span className="m-session-count">{sessions.length} active</span>
        </section>

        <nav className="m-filters" aria-label="Filter sessions">
          {FILTERS.map((item) => {
            const count = sessions.filter((session) => {
              const status = snapshots[session.id]?.status
              if (item.id === 'running') return status === 'running'
              if (item.id === 'attention') return status === 'waiting' || status === 'failed'
              return true
            }).length
            return (
              <button key={item.id} className={filter === item.id ? 'active' : ''} onClick={() => setFilter(item.id)}>
                {item.label}<span>{count}</span>
              </button>
            )
          })}
        </nav>

        <SessionGroups
          sessions={sessions}
          snapshots={snapshots}
          branches={branches}
          filter={filter}
          collapsed={collapsed}
          menuId={menuId}
          now={now}
          conn={conn}
          onToggleGroup={(path) => setCollapsed((previous) => {
            const next = new Set(previous)
            next.has(path) ? next.delete(path) : next.add(path)
            return next
          })}
          onToggleMenu={(id) => setMenuId((current) => current === id ? null : id)}
          onOpen={openSession}
          onNew={() => setNewSessionOpen(true)}
        />
      </main>

      {drawerOpen && (
        <NavigationDrawer
          conn={conn}
          sessions={sessions}
          snapshots={snapshots}
          paths={workspacePaths}
          filter={filter}
          onFilter={(next) => { setFilter(next); setDrawerOpen(false) }}
          onNew={() => { setDrawerOpen(false); setNewSessionOpen(true) }}
          onClose={() => setDrawerOpen(false)}
        />
      )}

      {newSessionOpen && (
        <NewSessionSheet
          paths={workspacePaths}
          branches={branches}
          onCreate={createSession}
          onClose={() => setNewSessionOpen(false)}
        />
      )}

      {toast && <div className="m-toast" role="status">{toast}</div>}
    </div>
  )
}

function SessionGroups({
  sessions,
  snapshots,
  branches,
  filter,
  collapsed,
  menuId,
  now,
  conn,
  onToggleGroup,
  onToggleMenu,
  onOpen,
  onNew
}: {
  sessions: TerminalMeta[]
  snapshots: Record<string, SessionSnapshot>
  branches: Record<string, string | null>
  filter: SessionFilter
  collapsed: Set<string>
  menuId: string | null
  now: number
  conn: ConnState
  onToggleGroup: (path: string) => void
  onToggleMenu: (id: string) => void
  onOpen: (id: string, terminal?: boolean) => void
  onNew: () => void
}) {
  const visible = sessions.filter((session) => {
    const status = snapshots[session.id]?.status
    if (filter === 'running') return status === 'running'
    if (filter === 'attention') return status === 'waiting' || status === 'failed'
    return true
  })

  const groups = useMemo(() => {
    const map = new Map<string, TerminalMeta[]>()
    visible.forEach((session) => {
      const path = session.workspacePath || session.cwd || '~'
      map.set(path, [...(map.get(path) || []), session])
    })
    return Array.from(map.entries())
  }, [visible])

  if (sessions.length === 0) {
    return (
      <div className="m-empty-state">
        <span className="m-empty-glyph"><Icon name={conn === 'open' ? 'terminal' : 'activity'} size={26} /></span>
        <p className="m-eyebrow">{conn === 'open' ? 'Workspace is quiet' : 'Connecting securely'}</p>
        <h2>{conn === 'open' ? 'No live sessions yet' : 'Finding your desktop'}</h2>
        <p>{conn === 'open' ? 'Start a shell or coding agent without leaving your phone.' : 'Keep TawTerminal open on your Mac while the remote link reconnects.'}</p>
        {conn === 'open' && <button className="m-primary-action" onClick={onNew}><Icon name="plus" size={17} />New session</button>}
      </div>
    )
  }

  if (visible.length === 0) {
    return (
      <div className="m-filter-empty">
        <span>No sessions match this filter.</span>
        <small>Try All to see every live terminal.</small>
      </div>
    )
  }

  return (
    <div className="m-repositories">
      {groups.map(([path, terms]) => {
        const isCollapsed = collapsed.has(path)
        return (
          <section key={path} className="m-repository">
            <button className="m-repo-head" aria-expanded={!isCollapsed} onClick={() => onToggleGroup(path)}>
              <span className="m-repo-icon"><Icon name="repo" size={18} /></span>
              <span className="m-repo-copy">
                <strong>{repositoryName(path)}</strong>
                <small>{branches[path] || 'No branch'} · {terms.length} {terms.length === 1 ? 'session' : 'sessions'}</small>
              </span>
              <span className={`m-repo-chevron ${isCollapsed ? '' : 'open'}`}><Icon name="chevron" size={18} /></span>
            </button>
            {!isCollapsed && (
              <div className="m-session-stack">
                {terms.map((session) => {
                  const snapshot = snapshots[session.id]
                  if (!snapshot) return null
                  return (
                    <SessionCard
                      key={session.id}
                      session={session}
                      snapshot={snapshot}
                      branch={branches[path]}
                      menuOpen={menuId === session.id}
                      now={now}
                      onMenu={() => onToggleMenu(session.id)}
                      onOpen={(terminal) => onOpen(session.id, terminal)}
                    />
                  )
                })}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}

function SessionCard({
  session,
  snapshot,
  branch,
  menuOpen,
  now,
  onMenu,
  onOpen
}: {
  session: TerminalMeta
  snapshot: SessionSnapshot
  branch: string | null | undefined
  menuOpen: boolean
  now: number
  onMenu: () => void
  onOpen: (terminal?: boolean) => void
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onOpen()
    }
  }

  return (
    <div className={`m-session-card status-${snapshot.status}`} role="button" tabIndex={0} onClick={() => onOpen()} onKeyDown={onKeyDown}>
      <span className="m-status-rail" />
      <div className="m-session-topline">
        <AgentMark kind={session.kind} />
        <div className="m-session-heading">
          <strong>{session.name}</strong>
          <span>{KIND_LABEL[session.kind]}</span>
        </div>
        <StatusBadge status={snapshot.status} compact />
        <button className="m-card-more" aria-label={`Actions for ${session.name}`} onClick={(event) => { event.stopPropagation(); onMenu() }}>
          <Icon name="more" size={19} />
        </button>
        {menuOpen && (
          <div className="m-card-menu" onClick={(event) => event.stopPropagation()}>
            <button onClick={() => onOpen()}><Icon name="activity" size={16} />Open activity</button>
            <button onClick={() => onOpen(true)}><Icon name="terminal" size={16} />Open terminal</button>
            <button onClick={() => copyText(session.cwd)}><Icon name="copy" size={16} />Copy path</button>
          </div>
        )}
      </div>
      <p className="m-session-context">{repositoryName(session.workspacePath || session.cwd)} <span>·</span> {branch || 'no branch'}</p>
      <p className="m-session-summary">{snapshot.summary}</p>
      {snapshot.progress && (
        <div className="m-card-progress" aria-label={`${snapshot.progress.percent}% complete`}>
          <span><i style={{ width: `${snapshot.progress.percent}%` }} /></span>
          <small>{snapshot.progress.label}</small>
        </div>
      )}
      <div className="m-session-foot">
        <span>{snapshot.status === 'running' && <i className="m-live-pulse" />}Updated {formatRelativeTime(snapshot.updatedAt, now)} ago</span>
        <span>{compactPath(session.cwd)} <Icon name="chevron" size={14} /></span>
      </div>
    </div>
  )
}

function NavigationDrawer({ conn, sessions, snapshots, paths, filter, onFilter, onNew, onClose }: {
  conn: ConnState
  sessions: TerminalMeta[]
  snapshots: Record<string, SessionSnapshot>
  paths: string[]
  filter: SessionFilter
  onFilter: (filter: SessionFilter) => void
  onNew: () => void
  onClose: () => void
}) {
  const counts = {
    running: sessions.filter((session) => snapshots[session.id]?.status === 'running').length,
    attention: sessions.filter((session) => ['waiting', 'failed'].includes(snapshots[session.id]?.status)).length,
    all: sessions.length
  }
  return (
    <div className="m-overlay" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
      <aside className="m-drawer" aria-label="Remote navigation">
        <div className="m-drawer-head">
          <div className="m-brand"><span className="m-brand-mark">T_</span><span><strong>TawTerminal</strong><small>Remote workspace</small></span></div>
          <button className="m-icon-button" aria-label="Close navigation" onClick={onClose}><Icon name="close" /></button>
        </div>
        <div className={`m-drawer-connection connection-${conn}`}>
          <span className="m-connection-orb" />
          <div><strong>{conn === 'open' ? 'Desktop connected' : 'Reconnecting'}</strong><small>{conn === 'open' ? 'Encrypted token link is active' : 'Keep the desktop app open'}</small></div>
        </div>
        <button className="m-drawer-new" disabled={conn !== 'open' || paths.length === 0} onClick={onNew}><Icon name="plus" size={18} />New session</button>
        <nav className="m-drawer-nav">
          <p className="m-eyebrow">Sessions</p>
          {FILTERS.map((item) => (
            <button key={item.id} className={filter === item.id ? 'active' : ''} onClick={() => onFilter(item.id)}>
              <span><Icon name={item.id === 'all' ? 'terminal' : 'activity'} size={18} />{item.label}</span><b>{counts[item.id]}</b>
            </button>
          ))}
        </nav>
        <div className="m-drawer-repos">
          <p className="m-eyebrow">Repositories</p>
          {paths.map((path) => <div key={path}><Icon name="repo" size={16} /><span><strong>{repositoryName(path)}</strong><small>{compactPath(path)}</small></span></div>)}
        </div>
        <p className="m-drawer-note">Remote access can control live terminals. Stop the remote server when you are finished.</p>
      </aside>
    </div>
  )
}

function NewSessionSheet({ paths, branches, onCreate, onClose }: {
  paths: string[]
  branches: Record<string, string | null>
  onCreate: (path: string, kind: TerminalKind) => Promise<string>
  onClose: () => void
}) {
  const [path, setPath] = useState(paths[0] || '')
  const [kind, setKind] = useState<TerminalKind>('codex')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const agents: { kind: TerminalKind; title: string; detail: string }[] = [
    { kind: 'codex', title: 'Codex', detail: 'Coding agent' },
    { kind: 'claude', title: 'Claude', detail: 'Claude Code' },
    { kind: 'shell', title: 'Shell', detail: 'Plain terminal' },
    { kind: 'pi', title: 'PI', detail: 'PI agent' },
    { kind: 'tawx', title: 'tawx', detail: 'taw agent' }
  ]

  const submit = async () => {
    if (!path || busy) return
    setBusy(true)
    setError('')
    try {
      await onCreate(path, kind)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not create the session.')
      setBusy(false)
    }
  }

  return (
    <div className="m-overlay m-sheet-overlay" role="presentation" onMouseDown={(event) => { if (!busy && event.currentTarget === event.target) onClose() }}>
      <section className="m-sheet" role="dialog" aria-modal="true" aria-labelledby="new-session-title">
        <span className="m-sheet-handle" />
        <div className="m-sheet-head">
          <div><p className="m-eyebrow">Desktop-backed</p><h2 id="new-session-title">New session</h2></div>
          <button className="m-icon-button" aria-label="Close" disabled={busy} onClick={onClose}><Icon name="close" /></button>
        </div>
        <label className="m-field-label">Repository</label>
        <div className="m-path-options">
          {paths.map((item) => (
            <button key={item} className={path === item ? 'active' : ''} onClick={() => setPath(item)}>
              <span className="m-repo-icon"><Icon name="repo" size={17} /></span>
              <span><strong>{repositoryName(item)}</strong><small>{branches[item] || compactPath(item)}</small></span>
              <i />
            </button>
          ))}
        </div>
        <label className="m-field-label">Session type</label>
        <div className="m-agent-options">
          {agents.map((agent) => (
            <button key={agent.kind} className={kind === agent.kind ? 'active' : ''} onClick={() => setKind(agent.kind)}>
              <AgentMark kind={agent.kind} /><span><strong>{agent.title}</strong><small>{agent.detail}</small></span>
            </button>
          ))}
        </div>
        {error && <p className="m-sheet-error">{error}</p>}
        <button className="m-sheet-submit" disabled={!path || busy} onClick={submit}>
          {busy ? <><i className="m-spinner" />Starting on desktop…</> : <><Icon name="plus" size={18} />Create session</>}
        </button>
      </section>
    </div>
  )
}

function TerminalView({ meta, conn, buffer, snapshot, branch, now, initiallyOpenTerminal, onBack }: {
  meta: TerminalMeta
  conn: ConnState
  buffer: string
  snapshot: SessionSnapshot
  branch: string | null | undefined
  now: number
  initiallyOpenTerminal: boolean
  onBack: () => void
}) {
  const [terminalOpen, setTerminalOpen] = useState(initiallyOpenTerminal)
  const [detailMenu, setDetailMenu] = useState(false)
  const [prompt, setPrompt] = useState('')
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)

  useEffect(() => {
    if (!terminalOpen || !hostRef.current) return
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: 14,
      lineHeight: 1.42,
      letterSpacing: 0,
      fontFamily: '"SFMono-Regular", "JetBrains Mono", Menlo, Consolas, monospace',
      scrollback: 5000,
      theme: {
        background: '#090c12',
        foreground: '#d8e0e9',
        cursor: '#79ead4',
        selectionBackground: '#2c5d59'
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current)
    termRef.current = term

    const resize = () => {
      try { fit.fit() } catch { return }
      client.call('terminal:resize', meta.id, term.cols, term.rows).catch(() => {})
    }
    // Fit before replaying scrollback so long desktop-width lines wrap at the
    // phone width instead of being painted at xterm's 80-column default.
    resize()
    const input = term.onData((data) => client.call('terminal:write', meta.id, data).catch(() => {}))
    const offData = client.on('terminal:data', (payload: { id: string; data: string }) => {
      if (payload.id === meta.id) term.write(payload.data)
    })
    const offExit = client.on('terminal:exit', (payload: { id: string }) => {
      if (payload.id === meta.id) term.write('\r\n\x1b[31m[session ended]\x1b[0m\r\n')
    })

    if (buffer) term.write(buffer)
    const onResize = () => window.setTimeout(resize, 60)
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)

    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
      input.dispose()
      offData()
      offExit()
      term.dispose()
      termRef.current = null
      client.call('terminal:releaseResize').catch(() => {})
    }
  }, [terminalOpen, meta.id])

  const sendRaw = (value: string) => {
    client.call('terminal:write', meta.id, value).catch(() => {})
    termRef.current?.focus()
  }

  const submitPrompt = () => {
    const value = prompt.trim()
    if (!value || conn !== 'open') return
    sendRaw(`${value}\r`)
    setPrompt('')
  }

  const onPromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submitPrompt()
    }
  }

  const stop = () => sendRaw('\x03')
  const path = meta.workspacePath || meta.cwd

  return (
    <div className="m-term-view">
      <header className="m-detail-head">
        <button className="m-icon-button" aria-label="Back to sessions" onClick={onBack}><Icon name="arrow" /></button>
        <AgentMark kind={meta.kind} />
        <div className="m-detail-title">
          <strong>{meta.name}</strong>
          <span>{repositoryName(path)} · {branch || 'no branch'}</span>
        </div>
        <StatusBadge status={snapshot.status} compact />
        <button className="m-icon-button" aria-label="Session actions" onClick={() => setDetailMenu((open) => !open)}><Icon name="more" /></button>
        {detailMenu && (
          <div className="m-detail-menu">
            <button onClick={() => { setTerminalOpen(true); setDetailMenu(false) }}><Icon name="terminal" size={16} />Open terminal</button>
            <button onClick={() => { copyText(snapshot.clean); setDetailMenu(false) }}><Icon name="copy" size={16} />Copy latest output</button>
            <button onClick={() => { copyText(meta.cwd); setDetailMenu(false) }}><Icon name="copy" size={16} />Copy path</button>
          </div>
        )}
      </header>

      <main className="m-activity-scroll">
        <section className={`m-progress-card status-${snapshot.status}`}>
          <div className="m-progress-head">
            <span><i className="m-live-pulse" />{statusLabel(snapshot.status)}</span>
            <small>Updated {formatRelativeTime(snapshot.updatedAt, now)} ago</small>
          </div>
          <h1>{snapshot.summary}</h1>
          {snapshot.progress ? (
            <div className="m-detail-progress">
              <span><i style={{ width: `${snapshot.progress.percent}%` }} /></span>
              <div><strong>{snapshot.progress.percent}%</strong><small>{snapshot.progress.label}</small></div>
            </div>
          ) : snapshot.status === 'running' ? (
            <div className="m-indeterminate"><i /><span>Live terminal activity</span></div>
          ) : null}
        </section>

        <section className="m-feed-section">
          <div className="m-section-heading">
            <div><p className="m-eyebrow">Session timeline</p><h2>Latest activity</h2></div>
            <span>{snapshot.activities.length} updates</span>
          </div>
          {snapshot.activities.length === 0 ? (
            <div className="m-activity-empty"><Icon name="activity" size={24} /><strong>Waiting for output</strong><span>New agent updates will appear here.</span></div>
          ) : (
            <div className="m-activity-feed">
              {snapshot.activities.map((activity) => {
                if (activity.kind === 'tool') {
                  return (
                    <details key={activity.id} className="m-activity-card kind-tool">
                      <summary><span className="m-activity-icon"><Icon name="terminal" size={17} /></span><span><small>Tool call</small><strong>{activity.title}</strong></span><Icon name="chevron" size={17} /></summary>
                      <pre>{activity.text}</pre>
                    </details>
                  )
                }
                return (
                  <article key={activity.id} className={`m-activity-card kind-${activity.kind}`}>
                    <div className="m-activity-card-head">
                      <span className="m-activity-icon"><Icon name={activity.kind === 'agent' ? 'activity' : 'terminal'} size={17} /></span>
                      <span><small>{activity.kind === 'error' ? 'Error' : activity.kind === 'progress' ? 'Progress' : activity.kind === 'system' ? 'System' : 'Agent'}</small><strong>{activity.title}</strong></span>
                    </div>
                    <p>{activity.text}</p>
                    {activity.kind === 'error' && <button onClick={() => setTerminalOpen(true)}>View details <Icon name="chevron" size={14} /></button>}
                  </article>
                )
              })}
            </div>
          )}
        </section>

        <section className={`m-terminal-panel ${terminalOpen ? 'open' : ''}`}>
          <button className="m-terminal-toggle" onClick={() => setTerminalOpen((open) => !open)}>
            <span className="m-terminal-glyph"><Icon name="terminal" size={19} /></span>
            <span><small>Raw output</small><strong>{terminalOpen ? 'Close terminal mode' : 'Open interactive terminal'}</strong></span>
            <Icon name={terminalOpen ? 'close' : 'chevron'} size={18} />
          </button>
          {terminalOpen && (
            <>
              <div className="m-terminal-toolbar">
                <span><i />Live · {compactPath(meta.cwd)}</span>
                <button onClick={() => copyText(snapshot.clean)}><Icon name="copy" size={15} />Copy</button>
              </div>
              <div ref={hostRef} className="m-term" />
              <div className="m-keys" aria-label="Terminal shortcut keys">
                <button onClick={() => sendRaw('\x1b')}>Esc</button>
                <button onClick={() => sendRaw('\t')}>Tab</button>
                <button onClick={() => sendRaw('\x03')}>^C</button>
                <button onClick={() => sendRaw('\x1b[A')}>↑</button>
                <button onClick={() => sendRaw('\x1b[B')}>↓</button>
                <button onClick={() => sendRaw('\x1b[D')}>←</button>
                <button onClick={() => sendRaw('\x1b[C')}>→</button>
                <button onClick={() => sendRaw('\r')}>⏎</button>
              </div>
            </>
          )}
        </section>
      </main>

      <footer className="m-composer-wrap">
        <div className="m-composer">
          <button className={`m-composer-tool ${terminalOpen ? 'active' : ''}`} aria-label="Toggle terminal mode" onClick={() => setTerminalOpen((open) => !open)}><Icon name="terminal" size={19} /></button>
          <textarea
            rows={1}
            value={prompt}
            placeholder={snapshot.status === 'running' ? 'Add guidance or wait…' : 'Message this session…'}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={onPromptKeyDown}
          />
          {snapshot.status === 'running' ? (
            <button className="m-composer-primary stop" aria-label="Stop agent" disabled={conn !== 'open'} onClick={stop}><Icon name="stop" size={18} /><span>Stop</span></button>
          ) : (
            <button className="m-composer-primary" aria-label="Send message" disabled={conn !== 'open' || !prompt.trim()} onClick={submitPrompt}><Icon name="send" size={18} /><span>Send</span></button>
          )}
        </div>
        <p>Enter to send · Shift + Enter for a new line</p>
      </footer>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
