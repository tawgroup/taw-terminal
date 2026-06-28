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
}

declare global {
  interface Window {
    terminal: TerminalAPI
    app: AppAPI
    workspace: WorkspaceAPI
    usage: UsageAPI
    limits: LimitsAPI
    remote: RemoteAPI
  }
}
