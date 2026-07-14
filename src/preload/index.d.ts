export interface TerminalAPI {
  create: (id: string, cwd?: string, meta?: { name?: string; kind?: string; workspacePath?: string }) => Promise<void>
  rename: (id: string, name: string) => void
  write: (id: string, data: string) => void
  resize: (id: string, cols: number, rows: number) => void
  kill: (id: string) => Promise<void>
  getCwd: (id: string) => Promise<string>
  getShellName: () => Promise<string>
  onData: (callback: (payload: { id: string; data: string }) => void) => () => void
  onExit: (callback: (payload: { id: string }) => void) => () => void
}

export interface UpdateInfo {
  current: string
  latest: string | null
  hasUpdate: boolean
}

export interface AppAPI {
  getTheme: () => Promise<'dark' | 'light'>
  getHome: () => Promise<string>
  getVersion: () => Promise<string>
  checkUpdate: () => Promise<UpdateInfo>
  releasesUrl: () => Promise<string>
  runUpdate: () => Promise<boolean>
  openExternal: (url: string) => Promise<void>
}

export interface PersistedTerm {
  name: string
  cwd: string
  kind?: 'shell' | 'claude' | 'codex' | 'pi' | 'tawx'
  claudeSessionId?: string
  /** Free-form sticky note pinned to this terminal */
  note?: string
  /** Whether the sticky note panel is shown */
  noteOpen?: boolean
}

export interface PersistedWorkspace {
  path: string
  collapsed?: boolean
  terminals: PersistedTerm[]
}

export interface PersistedState {
  version: number
  active?: { path: string; name: string }
  workspaces: PersistedWorkspace[]
}

export interface WorkspaceAPI {
  openFolder: () => Promise<string | null>
  // Returns the persisted session (new format), a legacy string[] of paths, or null
  load: () => Promise<PersistedState | string[] | null>
  save: (state: PersistedState) => Promise<void>
  gitBranch: (cwd: string) => Promise<string | null>
}

export interface UsageStat {
  tokens: number
  cost: number
  input: number
  output: number
}

export interface UsageSnapshot {
  claude: UsageStat
  codex: UsageStat
  pi: UsageStat
  tawx: UsageStat
}

export interface UsageAPI {
  /** Aggregate today's token usage/cost from ~/.claude, ~/.codex, ~/.pi and ~/.tawx */
  get: () => Promise<UsageSnapshot>
}

export interface LimitWindow {
  label: string
  usedPercent: number
  resetAt: number
  resetMinutes: number
  status: string
}

export interface ProviderLimits {
  ok: boolean
  session5h: LimitWindow | null
  weekly7d: LimitWindow | null
  plan?: string | null
  error?: string | null
  updatedAt?: string
}

export interface LimitsSnapshot {
  claude: ProviderLimits
  codex: ProviderLimits
}

export interface LimitsAPI {
  /** Live rolling rate-limit usage (5h / weekly %) for Claude Code and Codex */
  get: () => Promise<LimitsSnapshot>
}

export interface RemoteStatus {
  running: boolean
  port: number | null
  token: string | null
  lanUrl: string | null
  tunnelUrl: string | null
  url: string | null
  qrDataUrl: string | null
  tunnelError?: string | null
}

export interface RemoteAPI {
  status: () => Promise<RemoteStatus>
  start: (opts?: { tunnel?: boolean }) => Promise<RemoteStatus>
  stop: () => Promise<RemoteStatus>
  checkTunnel: () => Promise<{ installed: boolean }>
  /** Fires when a remote (phone) client attaches/detaches, with the live count. */
  onClients: (callback: (count: number) => void) => () => void
  /** Desktop-owned session request forwarded from the phone remote. */
  onNewSessionRequest: (callback: (request: {
    requestId: string
    workspacePath: string
    kind: 'shell' | 'claude' | 'codex' | 'pi' | 'tawx'
  }) => void) => () => void
  /** Resolves the matching phone RPC after WorkspaceLayout has added the tab. */
  resolveNewSession: (result: { requestId: string; id?: string; error?: string }) => void
}

/** Codex/tawx mint their own session id, so a terminal learns it from the transcript on disk. */
export interface AgentSessionAPI {
  /** Terminal just spawned an agent; bind it to the next transcript that appears. */
  watch: (id: string, kind: 'codex' | 'tawx', cwd: string) => void
  /** Restored terminal already owns this session; reserve it so no one else claims it. */
  claim: (id: string, kind: 'codex' | 'tawx', cwd: string, sessionId: string) => void
  unwatch: (id: string) => void
  /** The focused terminal claims a new transcript first (it is what `/new` writes to). */
  setActive: (id: string | null) => void
  /** Give terminals saved before session tracking one distinct session each. */
  adopt: (reqs: { termId: string; kind: 'codex' | 'tawx'; cwd: string }[]) => Promise<Record<string, string>>
  onSession: (callback: (payload: { id: string; sessionId: string }) => void) => () => void
}

declare global {
  interface Window {
    terminal: TerminalAPI
    app: AppAPI
    workspace: WorkspaceAPI
    usage: UsageAPI
    limits: LimitsAPI
    remote: RemoteAPI
    agentSession: AgentSessionAPI
  }
}
