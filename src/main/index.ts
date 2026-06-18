/**
 * TawTerminal - Main Process
 * Electron app entry point
 */
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { join } from 'path'
import os from 'os'
import fs from 'fs'
import { PtyManager } from './pty-manager'

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

ipcMain.handle('terminal:create', (_, id: string, cwd?: string) => {
  ptyManager.create(id, (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:data', { id, data })
    }
  }, cwd, 0, () => {
    // Notify renderer that PTY exited so it stops writing to dead process
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:exit', { id })
    }
  })
})

ipcMain.on('terminal:write', (_, id: string, data: string) => {
  ptyManager.write(id, data)
})

ipcMain.on('terminal:resize', (_, id: string, cols: number, rows: number) => {
  ptyManager.resize(id, cols, rows)
})

ipcMain.handle('terminal:kill', (_, id: string) => {
  ptyManager.kill(id)
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
ipcMain.handle('app:checkUpdate', async () => {
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
})

ipcMain.handle('app:releasesUrl', () => `https://github.com/${REPO}/releases`)

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
ipcMain.handle('workspaces:load', () => {
  try {
    return JSON.parse(fs.readFileSync(workspacesFile(), 'utf8'))
  } catch {
    return null
  }
})

ipcMain.handle('workspaces:save', (_, state: unknown) => {
  try {
    fs.writeFileSync(workspacesFile(), JSON.stringify(state, null, 2))
  } catch {
    // best-effort persistence
  }
})

// Resolve the current git branch for a folder (null if not a repo)
ipcMain.handle('git:branch', async (_, cwd: string) => {
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
})

// --- Usage tracking (today's tokens/cost from Claude Code & Codex) ---

// Price per 1M tokens [input, output, cacheWrite, cacheRead]
const CLAUDE_PRICING: Record<string, [number, number, number, number]> = {
  opus: [15, 75, 18.75, 1.5],
  sonnet: [3, 15, 3.75, 0.3],
  haiku: [0.8, 4, 1, 0.08]
}
// Codex/GPT rough pricing [input, output, cachedInput]
const CODEX_PRICING: [number, number, number] = [1.25, 10, 0.125]

function claudePrice(model: string): [number, number, number, number] {
  const m = (model || '').toLowerCase()
  if (m.includes('opus')) return CLAUDE_PRICING.opus
  if (m.includes('haiku')) return CLAUDE_PRICING.haiku
  return CLAUDE_PRICING.sonnet
}

// Cache parsed per-file results so big unchanged transcripts aren't re-read
const usageFileCache = new Map<string, { mtime: number; size: number; stat: { tokens: number; cost: number; input: number; output: number } }>()

function walkJsonl(dir: string, out: string[]): void {
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) walkJsonl(full, out)
    else if (e.name.endsWith('.jsonl')) out.push(full)
  }
}

function emptyStat() { return { tokens: 0, cost: 0, input: 0, output: 0 } }

function claudeUsageToday(today: string) {
  const total = emptyStat()
  const root = join(os.homedir(), '.claude', 'projects')
  const files: string[] = []
  walkJsonl(root, files)
  const startOfToday = new Date(today + 'T00:00:00').getTime()
  for (const file of files) {
    let st: fs.Stats
    try { st = fs.statSync(file) } catch { continue }
    if (st.mtimeMs < startOfToday) continue // no activity today
    const cached = usageFileCache.get(file)
    if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) {
      addStat(total, cached.stat); continue
    }
    const stat = emptyStat()
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n')
      for (const line of lines) {
        if (!line || line.indexOf('"usage"') === -1) continue
        let obj: any
        try { obj = JSON.parse(line) } catch { continue }
        if (typeof obj.timestamp !== 'string' || obj.timestamp.slice(0, 10) !== today) continue
        const u = obj.message?.usage
        if (!u) continue
        const inp = (u.input_tokens || 0)
        const out = (u.output_tokens || 0)
        const cw = (u.cache_creation_input_tokens || 0)
        const cr = (u.cache_read_input_tokens || 0)
        const [pi, po, pcw, pcr] = claudePrice(obj.message?.model)
        stat.input += inp + cw + cr
        stat.output += out
        stat.tokens += inp + out + cw + cr
        stat.cost += (inp * pi + out * po + cw * pcw + cr * pcr) / 1e6
      }
    } catch { /* skip unreadable */ }
    usageFileCache.set(file, { mtime: st.mtimeMs, size: st.size, stat })
    addStat(total, stat)
  }
  return total
}

function addStat(a: { tokens: number; cost: number; input: number; output: number }, b: typeof a) {
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
    const cached = usageFileCache.get(file)
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
    usageFileCache.set(file, { mtime: st.mtimeMs, size: st.size, stat })
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

ipcMain.handle('usage:get', () => {
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  try {
    return { claude: claudeUsageToday(today), codex: codexUsageToday(now) }
  } catch {
    return { claude: emptyStat(), codex: emptyStat() }
  }
})

// --- App Lifecycle ---

app.whenReady().then(() => {
  createWindow()

  // Kill all PTYs before window closes to prevent "Object has been destroyed" errors
  mainWindow?.on('close', () => {
    ptyManager.killAll()
  })
})

app.on('before-quit', () => {
  ptyManager.killAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
