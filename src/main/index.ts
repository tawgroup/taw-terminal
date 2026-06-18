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

// Persisted workspace folder paths (terminals themselves are session-only)
ipcMain.handle('workspaces:load', () => {
  try {
    const raw = fs.readFileSync(workspacesFile(), 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as string[]) : null
  } catch {
    return null
  }
})

ipcMain.handle('workspaces:save', (_, paths: string[]) => {
  try {
    fs.writeFileSync(workspacesFile(), JSON.stringify(paths, null, 2))
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
