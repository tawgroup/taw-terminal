/**
 * TawTerminal - Main Process
 * Electron app entry point
 */
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { join } from 'path'
import os from 'os'
import fs from 'fs'
import { spawn } from 'child_process'
import { PtyManager } from './pty-manager'
import { getLimits } from './limits'
import { terminalRegistry } from './terminal-registry'
import { RemoteServer, type RpcTable } from './remote-server'

const ptyManager = new PtyManager()
let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 600,
    minHeight: 400,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: '#1a1b26',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  })

  // Open maximized (fills the screen) once the renderer is ready
  mainWindow.once('ready-to-show', () => {
    mainWindow?.maximize()
    mainWindow?.show()
  })

  // Load renderer
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// --- IPC Handlers ---

interface TermMeta { name?: string; kind?: 'shell' | 'claude' | 'codex' | 'pi' | 'tawx'; workspacePath?: string }

ipcMain.handle('terminal:create', (_, id: string, cwd?: string, meta?: TermMeta) => {
  terminalRegistry.register({ id, cwd: cwd || '', name: meta?.name, kind: meta?.kind, workspacePath: meta?.workspacePath })
  ptyManager.create(id, (data) => {
    // Fan out to the desktop window AND any remote clients (via the registry).
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:data', { id, data })
    }
    terminalRegistry.pushData(id, data)
  }, cwd, 0, () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:exit', { id })
    }
    terminalRegistry.markExit(id)
  })
})

ipcMain.on('terminal:rename', (_, id: string, name: string) => {
  terminalRegistry.rename(id, name)
})

ipcMain.on('terminal:write', (_, id: string, data: string) => {
  ptyManager.write(id, data)
})

ipcMain.on('terminal:resize', (_, id: string, cols: number, rows: number) => {
  ptyManager.resize(id, cols, rows)
})

ipcMain.handle('terminal:kill', (_, id: string) => {
  ptyManager.kill(id)
  terminalRegistry.remove(id)
})

ipcMain.handle('terminal:getCwd', async (_, id: string) => {
  return ptyManager.getCwd(id)
})

ipcMain.handle('terminal:getShellName', () => {
  return ptyManager.getShellName()
})

ipcMain.handle('app:openExternal', (_, url: string) => {
  shell.openExternal(url)
})

ipcMain.handle('app:getTheme', () => {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
})

ipcMain.handle('app:getHome', () => os.homedir())

ipcMain.handle('app:getVersion', () => app.getVersion())

const REPO = 'tawgroup/taw-terminal'

function cmpSemver(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n) || 0)
  const pb = b.split('.').map(n => parseInt(n) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  }
  return 0
}

// Compare the running version against the latest GitHub release tag
async function checkUpdate() {
  const current = app.getVersion()
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'TawTerminal' }
    })
    if (!res.ok) return { current, latest: null, hasUpdate: false }
    const data = (await res.json()) as { tag_name?: string }
    const latest = (data.tag_name || '').replace(/^v/, '')
    return { current, latest: latest || null, hasUpdate: !!latest && cmpSemver(latest, current) > 0 }
  } catch {
    return { current, latest: null, hasUpdate: false }
  }
}
ipcMain.handle('app:checkUpdate', () => checkUpdate())

ipcMain.handle('app:releasesUrl', () => `https://github.com/${REPO}/releases`)

// Self-update via the curl installer: spawn a detached updater that waits for
// this app to quit, then downloads + installs the latest release and relaunches.
ipcMain.handle('app:runUpdate', async () => {
  const pid = process.pid
  const script =
    `for i in $(seq 1 40); do kill -0 ${pid} 2>/dev/null || break; sleep 0.5; done; ` +
    `curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash`
  try {
    const child = spawn('/bin/bash', ['-lc', script], { detached: true, stdio: 'ignore' })
    child.unref()
  } catch {
    return false
  }
  // Tell the user it will close + reopen on its own, so they don't relaunch
  // it manually mid-download and see the old version.
  if (mainWindow && !mainWindow.isDestroyed()) {
    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      message: 'Updating TawTerminal…',
      detail:
        'TawTerminal will close now and reopen automatically once the new version finishes downloading (about 10–20 seconds).\n\nPlease don\'t reopen it yourself — it will come back on its own.',
      buttons: ['OK'],
      defaultId: 0,
      noLink: true
    })
  }
  // Quit (gracefully) so the running bundle can be replaced and relaunched
  app.quit()
  return true
})

// --- Workspace IPC ---

// Open native folder picker, return the chosen directory (or null if cancelled)
ipcMain.handle('dialog:openFolder', async () => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Add a workspace folder'
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

const workspacesFile = () => join(app.getPath('userData'), 'workspaces.json')

// Persisted session: folders + the terminals (name + cwd) that existed in each,
// so the layout can be re-spawned on next launch. Running processes cannot be
// restored — only the structure and working directories.
function loadWorkspaces(): unknown {
  try {
    return JSON.parse(fs.readFileSync(workspacesFile(), 'utf8'))
  } catch {
    return null
  }
}

function saveWorkspaces(state: unknown): void {
  try {
    fs.writeFileSync(workspacesFile(), JSON.stringify(state, null, 2))
  } catch {
    // best-effort persistence
  }
}

// Resolve the current git branch for a folder (null if not a repo)
async function gitBranchOf(cwd: string): Promise<string | null> {
  try {
    const { execFile } = await import('child_process')
    return await new Promise<string | null>((resolve) => {
      execFile('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 1500 }, (err, stdout) => {
        resolve(err ? null : stdout.trim() || null)
      })
    })
  } catch {
    return null
  }
}

ipcMain.handle('workspaces:load', () => loadWorkspaces())
ipcMain.handle('workspaces:save', (_, state: unknown) => saveWorkspaces(state))
ipcMain.handle('git:branch', (_, cwd: string) => gitBranchOf(cwd))

// --- Usage tracking (today's tokens/cost from Claude Code & Codex) ---

// Per-1M-token pricing [input, output, cacheWrite, cacheRead].
// We mirror ccusage exactly: source live prices from LiteLLM's published table
// (the same dataset ccusage uses) instead of hardcoding values that drift as new
// models ship. The table is fetched once, cached to disk (24h TTL), and falls
// back to a sourced snapshot offline. Hardcoded prices were why the panel read
// ~4x high: legacy Opus-4.1 rates ($15/$75/$1.5) were applied to Opus-4.8, which
// is actually $5/$25/$0.5 (verified against LiteLLM + ccusage, 2026-06-21).
type Price4 = [number, number, number, number]
const PRICING_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const PRICING_CACHE = join(os.homedir(), '.taw-terminal', 'pricing-cache.json')

// Offline fallback snapshot (LiteLLM, verified 2026-06-21). Keyed by exact model id.
const CLAUDE_PRICING_FALLBACK: Record<string, Price4> = {
  'claude-opus-4-8': [5, 25, 6.25, 0.5],
  'claude-opus-4-5': [5, 25, 6.25, 0.5],
  'claude-opus-4-1': [15, 75, 18.75, 1.5],
  'claude-opus-4-0': [15, 75, 18.75, 1.5],
  'claude-sonnet-4-6': [3, 15, 3.75, 0.3],
  'claude-sonnet-4-5': [3, 15, 3.75, 0.3],
  'claude-haiku-4-5': [1, 5, 1.25, 0.1]
}
// Codex/GPT rough pricing [input, output, cachedInput]
const CODEX_PRICING: [number, number, number] = [1.25, 10, 0.125]

// model id (lowercased) -> Price4, populated from LiteLLM (live, then disk cache).
let livePricing: Record<string, Price4> = {}

function pricingFromLiteLLM(j: any): Record<string, Price4> {
  const out: Record<string, Price4> = {}
  for (const [k, v] of Object.entries<any>(j || {})) {
    if (!v || typeof v !== 'object' || v.input_cost_per_token == null) continue
    out[k.toLowerCase()] = [
      (v.input_cost_per_token || 0) * 1e6,
      (v.output_cost_per_token || 0) * 1e6,
      (v.cache_creation_input_token_cost || 0) * 1e6,
      (v.cache_read_input_token_cost || 0) * 1e6
    ]
  }
  return out
}

// Seed from disk cache synchronously so the very first usage:get is already correct.
try {
  const c = JSON.parse(fs.readFileSync(PRICING_CACHE, 'utf8'))
  if (c?.map && typeof c.map === 'object') livePricing = c.map
} catch { /* no cache yet */ }

// Refresh from LiteLLM in the background (skip if the disk cache is < 24h old).
async function refreshPricing(): Promise<void> {
  try {
    const c = JSON.parse(fs.readFileSync(PRICING_CACHE, 'utf8'))
    if (c?.fetchedAt && Date.now() - c.fetchedAt < 24 * 3600e3 && c.map) { livePricing = c.map; return }
  } catch { /* fall through to fetch */ }
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 4000)
    const res = await fetch(PRICING_URL, { signal: ctl.signal })
    clearTimeout(t)
    if (!res.ok) return
    const map = pricingFromLiteLLM(await res.json())
    if (Object.keys(map).length) {
      livePricing = map
      try {
        fs.mkdirSync(join(os.homedir(), '.taw-terminal'), { recursive: true })
        fs.writeFileSync(PRICING_CACHE, JSON.stringify({ fetchedAt: Date.now(), map }))
      } catch { /* cache write best-effort */ }
    }
  } catch { /* offline — keep fallback */ }
}
refreshPricing()

function claudePrice(model: string): Price4 {
  const m = (model || '').toLowerCase()
  // Live LiteLLM price first (exact id, then anthropic/-prefixed), then sourced
  // fallback snapshot, then a version-aware guess so unknown ids never misprice.
  if (livePricing[m]) return livePricing[m]
  if (livePricing['anthropic/' + m]) return livePricing['anthropic/' + m]
  if (CLAUDE_PRICING_FALLBACK[m]) return CLAUDE_PRICING_FALLBACK[m]
  if (m.includes('opus')) return /opus-4-[01]|3-opus/.test(m) ? [15, 75, 18.75, 1.5] : [5, 25, 6.25, 0.5]
  if (m.includes('haiku')) return /haiku-3|3-5-haiku/.test(m) ? [0.8, 4, 1, 0.08] : [1, 5, 1.25, 0.1]
  return [3, 15, 3.75, 0.3]
}

type UsageStat = { tokens: number; cost: number; input: number; output: number }
type ClaudeUsageEntry = {
  timestamp: string
  messageId?: string
  requestId?: string
  model?: string
  input: number
  output: number
  cacheCreation: number
  cacheRead: number
}

// Cache parsed per-file results so big unchanged transcripts aren't re-read.
// Claude uses a parsed-entry cache instead of a pre-summed stat because the
// same API response can be duplicated across JSONL files. We must dedupe across
// all files by message.id + requestId (same strategy as ccusage).
const claudeUsageFileCache = new Map<string, { mtime: number; size: number; entries: ClaudeUsageEntry[] }>()
const codexUsageFileCache = new Map<string, { mtime: number; size: number; stat: UsageStat }>()

function walkJsonl(dir: string, out: string[]): void {
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) walkJsonl(full, out)
    else if (e.name.endsWith('.jsonl')) out.push(full)
  }
}

function emptyStat(): UsageStat { return { tokens: 0, cost: 0, input: 0, output: 0 } }

function localDateKey(d: Date): string {
  // YYYY-MM-DD in the user's local timezone.
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${da}`
}

function claudeLogDateKey(timestamp: string): string {
  // Match ccusage's default: group by LOCAL calendar date, not UTC. The old UTC
  // slice put usage on the wrong day for non-UTC users (e.g. UTC+7), so the panel
  // disagreed with `ccusage daily`.
  return localDateKey(new Date(timestamp))
}

function claudeUniqueHash(entry: ClaudeUsageEntry): string | null {
  // Match ccusage: only entries with both IDs are deduped. If either ID is
  // missing, count the row because we cannot prove it is a duplicate.
  if (!entry.messageId || !entry.requestId) return null
  return `${entry.messageId}:${entry.requestId}`
}

function parseClaudeUsageFile(file: string, st: fs.Stats): ClaudeUsageEntry[] {
  const cached = claudeUsageFileCache.get(file)
  if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) return cached.entries

  const entries: ClaudeUsageEntry[] = []
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    for (const line of lines) {
      if (!line || line.indexOf('"usage"') === -1) continue
      let obj: any
      try { obj = JSON.parse(line) } catch { continue }
      if (typeof obj.timestamp !== 'string') continue
      const u = obj.message?.usage
      if (!u) continue
      entries.push({
        timestamp: obj.timestamp,
        messageId: obj.message?.id,
        requestId: obj.requestId,
        model: obj.message?.model,
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheCreation: u.cache_creation_input_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0
      })
    }
  } catch { /* skip unreadable */ }

  claudeUsageFileCache.set(file, { mtime: st.mtimeMs, size: st.size, entries })
  return entries
}

function claudeUsageToday(today: string) {
  const total = emptyStat()
  const root = join(os.homedir(), '.claude', 'projects')
  const files: string[] = []
  walkJsonl(root, files)

  const startOfToday = new Date(today + 'T00:00:00').getTime()
  const seen = new Set<string>()

  for (const file of files) {
    let st: fs.Stats
    try { st = fs.statSync(file) } catch { continue }
    if (st.mtimeMs < startOfToday) continue // no activity today

    for (const entry of parseClaudeUsageFile(file, st)) {
      if (claudeLogDateKey(entry.timestamp) !== today) continue
      const uniqueHash = claudeUniqueHash(entry)
      if (uniqueHash) {
        if (seen.has(uniqueHash)) continue
        seen.add(uniqueHash)
      }

      const [pi, po, pcw, pcr] = claudePrice(entry.model || '')
      total.input += entry.input + entry.cacheCreation + entry.cacheRead
      total.output += entry.output
      total.tokens += entry.input + entry.output + entry.cacheCreation + entry.cacheRead
      total.cost += (entry.input * pi + entry.output * po + entry.cacheCreation * pcw + entry.cacheRead * pcr) / 1e6
    }
  }
  return total
}

function addStat(a: UsageStat, b: UsageStat) {
  a.tokens += b.tokens; a.cost += b.cost; a.input += b.input; a.output += b.output
}

function codexUsageToday(d: Date) {
  const total = emptyStat()
  const yyyy = String(d.getFullYear())
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const dir = join(os.homedir(), '.codex', 'sessions', yyyy, mm, dd)
  const files: string[] = []
  walkJsonl(dir, files)
  for (const file of files) {
    let st: fs.Stats
    try { st = fs.statSync(file) } catch { continue }
    const cached = codexUsageFileCache.get(file)
    if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) {
      addStat(total, cached.stat); continue
    }
    const stat = emptyStat()
    try {
      // Each session logs a cumulative total_token_usage; take the last one
      const lines = fs.readFileSync(file, 'utf8').split('\n')
      let last: any = null
      for (const line of lines) {
        if (!line || line.indexOf('total_token_usage') === -1) continue
        try {
          const obj = JSON.parse(line)
          const tu = findTotalUsage(obj)
          if (tu) last = tu
        } catch { /* skip */ }
      }
      if (last) {
        const inp = last.input_tokens || 0
        const cached2 = last.cached_input_tokens || 0
        const out = last.output_tokens || 0
        const [pi, po, pc] = CODEX_PRICING
        stat.input += inp
        stat.output += out
        stat.tokens += last.total_tokens || inp + out
        stat.cost += ((inp - cached2) * pi + cached2 * pc + out * po) / 1e6
      }
    } catch { /* skip */ }
    codexUsageFileCache.set(file, { mtime: st.mtimeMs, size: st.size, stat })
    addStat(total, stat)
  }
  return total
}

function findTotalUsage(obj: any): any {
  if (!obj || typeof obj !== 'object') return null
  if (obj.total_token_usage) return obj.total_token_usage
  for (const k of Object.keys(obj)) {
    const v = obj[k]
    if (v && typeof v === 'object') {
      const found = findTotalUsage(v)
      if (found) return found
    }
  }
  return null
}

// --- PI usage -------------------------------------------------------------
// PI writes one JSONL line per message with usage ALREADY priced
// (message.usage.cost.total in USD), so we just sum it — no pricing table.
// Sessions live in ~/.pi/agent/sessions/** and, when launched from this app via
// `--session-dir`, in ~/.taw-terminal/pi/**.
type DatedUsage = { date: string; tokens: number; cost: number; input: number; output: number }
const piUsageFileCache = new Map<string, { mtime: number; size: number; entries: DatedUsage[] }>()

function parsePiUsageFile(file: string, st: fs.Stats): DatedUsage[] {
  const cached = piUsageFileCache.get(file)
  if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) return cached.entries
  const entries: DatedUsage[] = []
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line || line.indexOf('"usage"') === -1) continue
      let o: any
      try { o = JSON.parse(line) } catch { continue }
      const u = o.message?.usage
      const ts = o.timestamp || o.message?.timestamp
      if (!u || typeof ts !== 'string') continue
      entries.push({
        date: localDateKey(new Date(ts)),
        tokens: u.totalTokens || 0,
        cost: u.cost?.total || 0,
        input: u.input || 0,
        output: u.output || 0
      })
    }
  } catch { /* skip unreadable */ }
  piUsageFileCache.set(file, { mtime: st.mtimeMs, size: st.size, entries })
  return entries
}

function piUsageToday(today: string): UsageStat {
  const total = emptyStat()
  const roots = [join(os.homedir(), '.pi', 'agent', 'sessions'), join(os.homedir(), '.taw-terminal', 'pi')]
  const files: string[] = []
  for (const r of roots) walkJsonl(r, files)
  const startOfToday = new Date(today + 'T00:00:00').getTime()
  for (const file of files) {
    let st: fs.Stats
    try { st = fs.statSync(file) } catch { continue }
    if (st.mtimeMs < startOfToday) continue
    for (const e of parsePiUsageFile(file, st)) {
      if (e.date !== today) continue
      total.tokens += e.tokens; total.cost += e.cost; total.input += e.input; total.output += e.output
    }
  }
  return total
}

// --- tawx usage -----------------------------------------------------------
// tawx persists a `usage` array per session JSON (~/.tawx/sessions/*.json), each
// entry { ts, input, output, tokens, cost, model } — cost in USD, pre-computed by
// the provider. Sessions written by older tawx (no `usage`) simply contribute 0.
const tawxUsageFileCache = new Map<string, { mtime: number; size: number; entries: DatedUsage[] }>()

function tawxUsageToday(today: string): UsageStat {
  const total = emptyStat()
  const dir = join(os.homedir(), '.tawx', 'sessions')
  let names: string[] = []
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')) } catch { return total }
  const startOfToday = new Date(today + 'T00:00:00').getTime()
  for (const name of names) {
    const file = join(dir, name)
    let st: fs.Stats
    try { st = fs.statSync(file) } catch { continue }
    if (st.mtimeMs < startOfToday) continue
    const cached = tawxUsageFileCache.get(file)
    let entries: DatedUsage[]
    if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) {
      entries = cached.entries
    } else {
      entries = []
      try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'))
        for (const u of (Array.isArray(j.usage) ? j.usage : [])) {
          if (!u || typeof u.ts !== 'string') continue
          entries.push({
            date: localDateKey(new Date(u.ts)),
            tokens: u.tokens || 0,
            cost: u.cost || 0,
            input: u.input || 0,
            output: u.output || 0
          })
        }
      } catch { /* skip unreadable */ }
      tawxUsageFileCache.set(file, { mtime: st.mtimeMs, size: st.size, entries })
    }
    for (const e of entries) {
      if (e.date !== today) continue
      total.tokens += e.tokens; total.cost += e.cost; total.input += e.input; total.output += e.output
    }
  }
  return total
}

function usageSnapshot() {
  const now = new Date()
  // Group by LOCAL calendar date, matching `ccusage daily`'s default.
  const claudeToday = localDateKey(now)
  try {
    return {
      claude: claudeUsageToday(claudeToday),
      codex: codexUsageToday(now),
      pi: piUsageToday(claudeToday),
      tawx: tawxUsageToday(claudeToday)
    }
  } catch {
    return { claude: emptyStat(), codex: emptyStat(), pi: emptyStat(), tawx: emptyStat() }
  }
}
ipcMain.handle('usage:get', () => usageSnapshot())

// Live rolling rate-limit usage (5h / weekly) for Claude + Codex. Unlike
// usage:get (which sums local transcripts), this asks each provider's API.
let limitsCache: { at: number; data: unknown } | null = null
async function limitsSnapshot() {
  // De-dupe bursts: each call hits the network, so reuse a result < 15s old.
  if (limitsCache && Date.now() - limitsCache.at < 15000) return limitsCache.data
  try {
    const data = await getLimits()
    limitsCache = { at: Date.now(), data }
    return data
  } catch {
    return {
      claude: { ok: false, session5h: null, weekly7d: null, error: 'Failed to read Claude limits.' },
      codex: { ok: false, session5h: null, weekly7d: null, error: 'Failed to read Codex limits.' }
    }
  }
}
ipcMain.handle('limits:get', () => limitsSnapshot())

// --- Remote (phone) access ---
// Reuse the built renderer over HTTP + a WS bridge mirroring the IPC surface.
const rpc: RpcTable = {
  'terminal:create': (id: string, cwd?: string, meta?: TermMeta) => {
    // A remote client attaching to an ALREADY-live session must not respawn it
    // (that would kill the desktop's running Claude/Codex). Replay the buffer
    // to the caller instead and leave the live PTY untouched.
    if (terminalRegistry.has(id)) return { attached: true }
    terminalRegistry.register({ id, cwd: cwd || '', name: meta?.name, kind: meta?.kind, workspacePath: meta?.workspacePath })
    ptyManager.create(id, (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('terminal:data', { id, data })
      terminalRegistry.pushData(id, data)
    }, cwd, 0, () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('terminal:exit', { id })
      terminalRegistry.markExit(id)
    })
    return { attached: false }
  },
  'terminal:write': (id: string, data: string) => { ptyManager.write(id, data) },
  'terminal:resize': (id: string, cols: number, rows: number) => { ptyManager.resize(id, cols, rows) },
  'terminal:kill': (id: string) => { ptyManager.kill(id); terminalRegistry.remove(id) },
  'terminal:rename': (id: string, name: string) => { terminalRegistry.rename(id, name) },
  'terminal:getCwd': (id: string) => ptyManager.getCwd(id),
  'terminal:getShellName': () => ptyManager.getShellName(),
  'session:list': () => terminalRegistry.list(),
  'session:buffer': (id: string) => terminalRegistry.buffer(id),
  'app:getTheme': () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'),
  'app:getHome': () => os.homedir(),
  'app:getVersion': () => app.getVersion(),
  'app:checkUpdate': () => checkUpdate(),
  'app:releasesUrl': () => `https://github.com/${REPO}/releases`,
  'app:openExternal': (url: string) => { shell.openExternal(url) },
  'app:runUpdate': () => false, // never let a remote client trigger a self-update
  'workspace:openFolder': () => null, // no native folder picker on a phone
  'workspaces:load': () => loadWorkspaces(),
  'workspaces:save': (state: unknown) => saveWorkspaces(state),
  'git:branch': (cwd: string) => gitBranchOf(cwd),
  'usage:get': () => usageSnapshot(),
  'limits:get': () => limitsSnapshot()
}

let remoteServer: RemoteServer | null = null
function getRemoteServer(): RemoteServer {
  if (!remoteServer) {
    // __dirname is out/main in the built app, so ../renderer is the bundled SPA.
    remoteServer = new RemoteServer(join(__dirname, '../renderer'), rpc)
  }
  return remoteServer
}

// Is cloudflared on PATH? Used to guide the user before enabling the tunnel.
ipcMain.handle('remote:checkTunnel', async () => {
  const { execFile } = await import('child_process')
  const [cmd, cmdArgs]: [string, string[]] =
    process.platform === 'win32' ? ['where', ['cloudflared']] : ['sh', ['-lc', 'command -v cloudflared']]
  return await new Promise<{ installed: boolean }>((resolve) => {
    execFile(cmd, cmdArgs, (err, stdout) => {
      resolve({ installed: !err && !!String(stdout).trim() })
    })
  })
})

ipcMain.handle('remote:status', () => getRemoteServer().status())
ipcMain.handle('remote:start', (_, opts?: { tunnel?: boolean }) => getRemoteServer().start(opts || {}))
ipcMain.handle('remote:stop', async () => { await getRemoteServer().stop(); return getRemoteServer().status() })

// --- App Lifecycle ---

let isQuitting = false

app.whenReady().then(() => {
  createWindow()
})

// On quit: give Claude/Codex sessions a moment to exit cleanly and flush their
// transcripts to disk before the processes are killed, so they can be resumed.
app.on('before-quit', (e) => {
  if (isQuitting) return
  e.preventDefault()
  isQuitting = true
  remoteServer?.stop().catch(() => {})
  ptyManager.gracefulShutdownAll().finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
