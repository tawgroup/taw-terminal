export interface TerminalAPI {
  create: (id: string, cwd?: string) => Promise<void>
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
  openExternal: (url: string) => Promise<void>
}

export interface PersistedTerm {
  name: string
  cwd: string
  kind?: 'shell' | 'claude' | 'codex'
  claudeSessionId?: string
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
}

export interface UsageAPI {
  /** Aggregate today's token usage/cost from ~/.claude and ~/.codex */
  get: () => Promise<UsageSnapshot>
}

declare global {
  interface Window {
    terminal: TerminalAPI
    app: AppAPI
    workspace: WorkspaceAPI
    usage: UsageAPI
  }
}
